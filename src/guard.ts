/**
 * AgentDiskGuard — 决策引擎（纯函数核心）。
 * 输入：工具名 + 工具入参；输出：allow / deny / ask（可携带 updatedInput 改写入参）。
 * 不做任何 IO（除路径 junction 探测），保证 Hook 开销最低。
 */

import type { Policy } from "./policy";
import { checkPath } from "./pathguard";
import { rewriteCommand } from "./rewriters";
import { detectHost, type HostCapabilities } from "./host";

export type DecisionAction = "allow" | "deny" | "ask";

export interface Decision {
  action: DecisionAction;
  reason?: string;
  /** 完整替换后的工具入参（原入参 + 覆盖字段） */
  updatedInput?: Record<string, unknown>;
}

/** 写文件类工具与其路径字段（键一律小写，匹配时对工具名做 toLowerCase） */
const FILE_TOOLS: Record<string, string[]> = {
  write: ["file_path"],
  edit: ["file_path"],
  multiedit: ["file_path"],
  multi_edit: ["file_path"],
  apply_patch: ["file_path", "path"],
  str_replace_editor: ["path"],
  notebookedit: ["notebook_path"],
  notebook_edit: ["notebook_path"],
  notebookeditcell: ["notebook_path"],
};

/** 命令类工具与其命令字段（含 DSH 的 pwsh / shell 等小写工具名） */
const COMMAND_TOOLS: Record<string, string[]> = {
  bash: ["command"],
  powershell: ["command", "script"],
  pwsh: ["command", "script"],
  shell: ["command"],
  cmd: ["command"],
};

/**
 * 只读工具：入参里虽然也有 file_path/path，但读操作不会被写盘，
 * 出现在这里是为了让通用兜底绝不改写它们的路径（改写只读路径毫无意义，且会让模型读到不存在的文件）。
 */
const READ_TOOLS = new Set([
  "read",
  "view",
  "notebookread",
  "notebook_read",
  "glob",
  "grep",
  "search",
  "find",
  "ls",
  "list",
  "cat",
  "head",
  "tail",
  "fetch",
  "web_fetch",
]);

function deny(reason: string): Decision {
  return { action: "deny", reason };
}

function ask(reason: string): Decision {
  return { action: "ask", reason };
}

function allowWith(input: Record<string, unknown>, reason: string, overrides?: Record<string, unknown>): Decision {
  return overrides ? { action: "allow", reason, updatedInput: { ...input, ...overrides } } : { action: "allow", reason };
}

/** 命中策略命令规则：按顺序取第一条匹配。 */
function matchCommandRule(command: string, policy: Policy): { action: "deny" | "ask" | "allow"; reason: string } | null {
  for (const rule of policy.commandRules) {
    try {
      if (new RegExp(rule.pattern, "i").test(command)) {
        return { action: rule.action, reason: rule.reason || `命中策略规则 pattern=${rule.pattern}` };
      }
    } catch {
      /* 非法正则跳过，避免拖垮 hook */
    }
  }
  return null;
}

/** 处理写文件类工具。 */
function decideFileWrite(tool: string, input: Record<string, unknown>, policy: Policy, host: HostCapabilities): Decision {
  const fields = FILE_TOOLS[tool] || ["file_path", "notebook_path", "path"];
  for (const field of fields) {
    const v = input[field];
    if (typeof v !== "string" || !v.trim()) continue;
    const check = checkPath(v, policy);
    if (!check.protected) continue;

    // 单条目 mode 优先于全局 fileWriteMode（系统目录固定 deny，绝不"重定向"变相放行）
    const mode = check.matched?.mode ?? policy.fileWriteMode;
    const base = `${check.reason ?? v}；AgentDiskGuard 已保护`;
    switch (mode) {
      case "off":
        return { action: "allow" };
      case "deny":
        return deny(
          check.matched?.mode
            ? `${base}（系统目录，禁止写入）。`
            : `${base}（fileWriteMode=deny）。已拒绝写入。请把目标改为 ${check.redirectPath} 后重试。`
        );
      case "ask":
        return ask(`${base}（fileWriteMode=ask）。请与用户确认写入位置（建议 ${check.redirectPath}）`);
      case "redirect":
      default:
        if (check.redirectPath) {
          // 宿主不采纳入参改写 → 「改写」唯一可用的形态是拒绝 + 把目标路径写进理由
          if (!host.updatedInput) {
            return deny(`${base}。当前宿主（${host.host}）不采纳 hook 的入参改写，请把目标改为 ${check.redirectPath} 后重试。`);
          }
          return allowWith(
            input,
            `AgentDiskGuard 重定向：${v} → ${check.redirectPath}（原路径位于 C 盘受保护目录）`,
            { [field]: check.redirectPath }
          );
        }
        return deny(`${base}。已拒绝写入。`);
    }
  }
  return { action: "allow" };
}

/** 处理命令类工具。 */
function decideCommand(tool: string, input: Record<string, unknown>, policy: Policy, host: HostCapabilities): Decision {
  const fields = COMMAND_TOOLS[tool] || ["command", "cmd", "script"];
  for (const field of fields) {
    const v = input[field];
    if (typeof v !== "string" || !v.trim()) continue;

    // 1) 显式规则优先
    const rule = matchCommandRule(v, policy);
    if (rule) {
      if (rule.action === "deny") return deny(`AgentDiskGuard 拦截：${rule.reason}`);
      if (rule.action === "ask") return ask(`AgentDiskGuard 需确认：${rule.reason}`);
      return { action: "allow", reason: rule.reason };
    }

    // 2) 命令模式
    if (policy.commandMode === "off") return { action: "allow" };

    const rw = rewriteCommand(v, policy);
    if (rw.changed) {
      switch (policy.commandMode) {
        case "deny":
          return deny(
            `AgentDiskGuard 拦截：该命令会向 C 盘缓存写入（${rw.notes.join("；")}）。` +
              `已拒绝。请改用 D 盘缓存参数或注入环境变量后重试。`
          );
        case "ask":
          return ask(`AgentDiskGuard 需确认：该命令将向 C 盘缓存写入（${rw.notes.join("；")}）。`);
        case "rewrite":
        default:
          // 宿主不采纳入参改写：改写后的命令只能交给模型重试，不能静默放行原命令
          if (!host.updatedInput) {
            return deny(
              `AgentDiskGuard 拦截：该命令会向 C 盘缓存写入（${rw.notes.join("；")}）。` +
                `当前宿主（${host.host}）不采纳 hook 的入参改写，请改用以下命令重试：\n${rw.command}`
            );
          }
          return allowWith(
            input,
            `AgentDiskGuard 改写命令，缓存/依赖已指向 D 盘：${rw.notes.join("；")}`,
            { [field]: rw.command }
          );
      }
    }
    if (rw.unrewritable) {
      // 命令会写 C 盘缓存，但它藏在包装器里（pwsh -Command "npm install"），无法安全注入参数：
      // 不能默默放行。宿主不采纳改写时 ask 也没用（批准后原命令照跑，缓存照落 C 盘），只能拒绝。
      if (policy.commandMode === "deny" || !host.updatedInput) return deny(`AgentDiskGuard 拦截：${rw.notes.join("；")}`);
      return ask(`AgentDiskGuard 需确认：${rw.notes.join("；")}`);
    }
    if (rw.notes.length > 0 && policy.commandMode === "ask") {
      return ask(`AgentDiskGuard 需确认：${rw.notes.join("；")}。`);
    }
    return { action: "allow" };
  }
  return { action: "allow" };
}

/**
 * 决策入口：未知且不带路径字段的工具一律放行（本插件只对明确分类的工具表态）。
 * 工具名统一按小写匹配，兼容 Claude Code 的 `Write`/`Bash` 与 DSH 的 `write`/`pwsh`。
 */
export function evaluateToolCall(toolName: string, toolInput: Record<string, unknown>, policy: Policy): Decision {
  const tool = (toolName || "").trim().toLowerCase();
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const host = detectHost(policy);

  // 只读工具永不改写
  if (READ_TOOLS.has(tool)) return { action: "allow" };
  if (COMMAND_TOOLS[tool]) return decideCommand(tool, input, policy, host);

  // 写文件工具与"任何入参里带路径字段的工具"共用同一条判定：
  // decideFileWrite 在工具名未知时会回落到 file_path/notebook_path/path，
  // 因此条目级 mode（系统目录固定 deny）在兜底路径上同样生效。
  return decideFileWrite(tool, input, policy, host);
}
