/**
 * AgentDiskGuard — PreToolUse Hook 入口。
 *
 * stdin:  Agent 的 hook 载荷 JSON（兼容 tool_name/tool_input、toolName/toolInput、tool/input）
 * stdout: PreToolUse 决策 JSON；任何内部错误默认 fail-open（输出空 + 退出 0），绝不拖死 Agent。
 */
import { evaluateToolCall } from "./guard";
import { loadPolicy } from "./policy";
import { decisionToPreToolUseOutput, normalizeHookInput } from "./adapters";
import { configureLogging, logError, logInfo } from "./logger";

function main(): void {
  configureLogging({ stderr: undefined, file: "info" });
  const raw = require("fs").readFileSync(0, "utf8"); // 同步读 stdin，避免事件循环开销
  if (!raw || !raw.trim()) {
    process.exit(0);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0); // 非法载荷不表态
  }

  const call = normalizeHookInput(payload);
  if (!call) {
    process.exit(0);
  }

  const policy = loadPolicy();
  const decision = evaluateToolCall(call.toolName, call.toolInput, policy);

  // allow 且没有要改写的入参 = 本插件对该调用没有意见：
  // 必须保持沉默（不输出任何 JSON），否则 permissionDecision="allow" 会顶掉宿主自己的 ask/deny 决策。
  if (decision.action === "allow" && !decision.updatedInput) {
    process.exit(0);
  }
  logInfo("hook 决策", { tool: call.toolName, action: decision.action, reason: decision.reason });
  // stdout 接的是宿主的管道，process.exit 可能截断异步写 —— 必须同步写
  require("fs").writeSync(1, JSON.stringify(decisionToPreToolUseOutput(decision)));
  process.exit(0);
}

try {
  main();
} catch (e) {
  logError("hook 异常", { error: String(e) });
  // fail-open：不输出任何 JSON + 退出码 0 = 放行，Agent 不受影响
  try {
    const policy = loadPolicy();
    if (!policy.failOpen) {
      require("fs").writeSync(
        1,
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "AgentDiskGuard 内部错误且 failOpen=false，已按策略拒绝。",
          },
        })
      );
    }
  } catch {
    /* 连策略都读不到时保持 fail-open */
  }
  process.exit(0);
}
