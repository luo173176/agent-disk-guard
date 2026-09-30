/**
 * AgentDiskGuard — 决策引擎（纯函数核心）。
 * 输入：工具名 + 工具入参；输出：allow / deny / ask（可携带 updatedInput 改写入参）。
 * 不做任何 IO（除路径 junction 探测），保证 Hook 开销最低。
 */

import type { Policy } from "./policy";
import { checkPath } from "./pathguard";
import { rewriteCommand } from "./rewriters";

export type DecisionAction = "allow" | "deny" | "ask";

export interface Decision {
  action: DecisionAction;
  reason?: string;
  /** 完整替换后的工具入参（原入参 + 覆盖字段） */
  updatedInput?: Record<string, unknown>;
}

/** 写文件类工具与其路径字段 */
const FILE_TOOLS: Record<string, string[]> = {
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  NotebookEditCell: ["notebook_path"],
};

/** 命令类工具与其命令字段 */
const COMMAND_TOOLS: Record<string, string[]> = {
  Bash: ["command"],
  PowerShell: ["command", "script"],
  Shell: ["command"],
};

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
function decideFileWrite(tool: string, input: Record<string, unknown>, policy: Policy): Decision {
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
            : `${base}（fileWriteMode=deny）。已拒绝写入。请把目标改到 D 盘，例如 ${check.redirectPath}`
        );
      case "ask":
        return ask(`${base}（fileWriteMode=ask）。请与用户确认写入位置（建议 ${check.redirectPath}）`);
      case "redirect":
      default:
        if (check.redirectPath) {
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
function decideCommand(tool: string, input: Record<string, unknown>, policy: Policy): Decision {
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
          return allowWith(
            input,
            `AgentDiskGuard 改写命令，缓存/依赖已指向 D 盘：${rw.notes.join("；")}`,
            { [field]: rw.command }
          );
      }
    } else if (rw.notes.length > 0 && policy.commandMode === "ask") {
      return ask(`AgentDiskGuard 需确认：${rw.notes.join("；")}。`);
    }
    return { action: "allow" };
  }
  return { action: "allow" };
}

/** 决策入口：未知工具一律放行（本插件只对明确分类的工具表态）。 */
export function evaluateToolCall(toolName: string, toolInput: Record<string, unknown>, policy: Policy): Decision {
  const tool = (toolName || "").trim();
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};

  if (FILE_TOOLS[tool]) return decideFileWrite(tool, input, policy);
  if (COMMAND_TOOLS[tool]) return decideCommand(tool, input, policy);

  // 通用兜底：任何工具入参里出现 file_path/path/notebook_path 且命中受保护路径，同样处理
  for (const field of ["file_path", "notebook_path", "path"]) {
    const v = input[field];
    if (typeof v === "string" && v.trim()) {
      const check = checkPath(v, policy);
      if (check.protected && policy.fileWriteMode !== "off") {
        if (policy.fileWriteMode === "redirect" && check.redirectPath) {
          return allowWith(input, `AgentDiskGuard 重定向：${v} → ${check.redirectPath}`, { [field]: check.redirectPath });
        }
        if (policy.fileWriteMode === "deny") return deny(`AgentDiskGuard 拦截：${check.reason ?? v}`);
        if (policy.fileWriteMode === "ask") return ask(`AgentDiskGuard 需确认：${check.reason ?? v}`);
      }
    }
  }
  return { action: "allow" };
}
