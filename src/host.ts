/**
 * AgentDiskGuard — 宿主能力探测。
 *
 * Hook 协议在不同宿主之间并不等价：有的宿主会把 PreToolUse 输出里的 updatedInput
 * 真正应用到工具入参上（改写生效），有的只认 permissionDecision，把 updatedInput
 * 记一条警告后丢掉。撞上后者时插件必须把「改写」降级为「拒绝 + 在理由里给出改写后的
 * 完整命令」——否则命令会被静默放行，缓存照旧落 C 盘。
 */
import type { Policy } from "./policy";

export interface HostCapabilities {
  /** 人类可读的宿主标识，会出现在拒绝理由里 */
  host: string;
  /** 宿主是否会把 PreToolUse 的 updatedInput 应用到实际工具入参 */
  updatedInput: boolean;
}

/**
 * 判定 DSH 的客观依据。
 *
 * 实测（DSH desktop，2026-10-01）：DSH 的钩子经 Claude Code 兼容桥接执行，而桥接
 * spawn 出来的 hook 进程只拿到一份收缩过的环境 —— DSH_* 只注入给 shell 工具自身，
 * hook 进程里根本没有（实测 hook 进程 env 中 DSH_/CLAUDE_/ELECTRON_ 前缀只有
 * CLAUDE_PROJECT_DIR 与 ELECTRON_RUN_AS_NODE）。真正能被 hook 进程看到的 DSH
 * 特征是主进程的 ELECTRON_RUN_AS_NODE=1（Electron 以 Node 模式引导），它会被
 * 子进程继承。CLAUDE_PROJECT_DIR 两种宿主都会设，不能用来区分。
 */
const DSH_MARKERS = ["DSH_SESSION_ID", "DSH_HOME", "DSH_PROFILE_DIR", "DSH_SHELL"];
const ELECTRON_NODE_MARKER = "ELECTRON_RUN_AS_NODE";

export function isDeepSeekHarness(): boolean {
  return (
    DSH_MARKERS.some((k) => !!process.env[k]) || process.env[ELECTRON_NODE_MARKER] === "1"
  );
}

export function detectHost(policy?: Pick<Policy, "hostCapabilities">): HostCapabilities {
  const override = policy?.hostCapabilities ?? "auto";
  if (override === "updatedInput") return { host: "forced-updated-input", updatedInput: true };
  if (override === "noUpdatedInput") return { host: "forced-no-updated-input", updatedInput: false };
  if (isDeepSeekHarness()) {
    // DSH 的 claude-code 桥接声明支持 updatedInput，却在运行时丢弃它。
    return { host: "deepseek-harness", updatedInput: false };
  }
  return { host: "claude-compatible", updatedInput: true };
}
