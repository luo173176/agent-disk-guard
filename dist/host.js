"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectHost = detectHost;
/**
 * 判定 DSH 的客观依据：DSH 自己注入的环境变量。
 * 注意 DSH 的钩子是通过 Claude Code 兼容桥接跑的，所以 CLAUDE_PROJECT_DIR 之类
 * 在两种宿主下都存在，只有 DSH_* 能区分它们。
 */
const DSH_MARKERS = ["DSH_SESSION_ID", "DSH_HOME", "DSH_PROFILE_DIR", "DSH_SHELL"];
function detectHost(policy) {
    const override = policy?.hostCapabilities ?? "auto";
    if (override === "updatedInput")
        return { host: "forced-updated-input", updatedInput: true };
    if (override === "noUpdatedInput")
        return { host: "forced-no-updated-input", updatedInput: false };
    if (DSH_MARKERS.some((k) => !!process.env[k])) {
        // DSH 的 claude-code 桥接声明支持 updatedInput，却在运行时丢弃它。
        return { host: "deepseek-harness", updatedInput: false };
    }
    return { host: "claude-compatible", updatedInput: true };
}
