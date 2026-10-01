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
 * 判定 DSH 的客观依据：DSH 自己注入的环境变量。
 * 注意 DSH 的钩子是通过 Claude Code 兼容桥接跑的，所以 CLAUDE_PROJECT_DIR 之类
 * 在两种宿主下都存在，只有 DSH_* 能区分它们。
 */
const DSH_MARKERS = ["DSH_SESSION_ID", "DSH_HOME", "DSH_PROFILE_DIR", "DSH_SHELL"];

export function detectHost(policy?: Pick<Policy, "hostCapabilities">): HostCapabilities {
  const override = policy?.hostCapabilities ?? "auto";
  if (override === "updatedInput") return { host: "forced-updated-input", updatedInput: true };
  if (override === "noUpdatedInput") return { host: "forced-no-updated-input", updatedInput: false };
  if (DSH_MARKERS.some((k) => !!process.env[k])) {
    // DSH 的 claude-code 桥接声明支持 updatedInput，却在运行时丢弃它。
    return { host: "deepseek-harness", updatedInput: false };
  }
  return { host: "claude-compatible", updatedInput: true };
}
