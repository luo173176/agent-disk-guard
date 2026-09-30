/**
 * AgentDiskGuard — 通用适配层。
 * 不同 Agent 的 Hook 载荷字段名不一致，这里统一归一化：
 *   ZCode / Claude Code: { tool_name, tool_input, hook_event_name, ... }
 *   变体:               { toolName, toolInput } / { tool, input } / { tool, parameters }
 * 输出统一为 ZCode/Claude Code 的 PreToolUse JSON 协议（已从运行时核实）：
 *   { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason, updatedInput? } }
 */

import type { Decision } from "./guard";

export interface NormalizedCall {
  toolName: string;
  toolInput: Record<string, unknown>;
}

/** 归一化各 Agent 的 hook 输入。识别不出工具名时返回 null（调用方应放行）。 */
export function normalizeHookInput(payload: unknown): NormalizedCall | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  const toolName =
    firstString(p.tool_name) ??
    firstString(p.toolName) ??
    firstString(p.tool) ??
    null;
  if (!toolName) return null;

  let toolInput: unknown =
    p.tool_input ?? p.toolInput ?? p.input ?? p.parameters ?? p.args ?? {};
  if (typeof toolInput === "string") {
    // 某些 Agent 会把入参序列化成 JSON 字符串
    try {
      toolInput = JSON.parse(toolInput);
    } catch {
      toolInput = { command: toolInput };
    }
  }
  if (!toolInput || typeof toolInput !== "object") toolInput = {};
  return { toolName, toolInput: toolInput as Record<string, unknown> };
}

function firstString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/** 决策 → PreToolUse 输出 JSON（与 ZCode 运行时 schema 严格一致，多余键会导致校验失败）。 */
export function decisionToPreToolUseOutput(decision: Decision): Record<string, unknown> {
  const out: Record<string, unknown> = {
    hookEventName: "PreToolUse",
    permissionDecision: decision.action,
  };
  if (decision.reason) out.permissionDecisionReason = decision.reason;
  if (decision.updatedInput) out.updatedInput = decision.updatedInput;
  return { hookSpecificOutput: out };
}

/** 决策 → SessionStart 输出 JSON（additionalContext 注入对话）。 */
export function additionalContextOutput(text: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } };
}

/**
 * 其他 Agent 的对接说明（详见 README「接入其他 Agent」）：
 *
 * - Claude Code（settings.json hooks）：协议与 ZCode 完全一致，直接复用 dist/hook.js。
 * - Cursor（Hooks Beta，beforeShellExecution / beforeFileEdit 等）：
 *     载荷为 { command } / { file_path }，可用 CLI:
 *       agent-disk-guard check --tool Bash --input-json "{\"command\":\"...\"}"
 *     输出 decision.action=deny 时返回 {permission:"deny"}。
 * - OpenCode（插件 tool.execute.before）：取 input.tool 与 args 后同样调用 CLI check。
 * - 无 Hook 能力的 Agent：用包装器 `agent-disk-guard exec -- <command>` 替代直接执行。
 */
