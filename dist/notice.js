"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSessionNotice = buildSessionNotice;
const policy_1 = require("./policy");
const pathguard_1 = require("./pathguard");
const host_1 = require("./host");
const monitor_1 = require("./monitor");
const logger_1 = require("./logger");
/**
 * 生成要注入会话的提示行；无事可报时返回空数组。
 */
function buildSessionNotice(options = {}) {
    const { source = "startup" } = options;
    const policy = options.policy ?? (0, pathguard_1.withWritableRedirectRoot)((0, policy_1.loadPolicy)());
    const lines = [];
    if (policy.monitor.enabled && policy.monitor.sessionStartCheck) {
        const status = (0, monitor_1.checkDisk)(policy);
        (0, logger_1.logInfo)("session 空间检查", { level: status.level, free: status.freeBytes, source });
        // 只有低于阈值才报空间告警：ok 不打扰，
        // unknown（查询失败，例如受限令牌下 WMI 被拒）同样保持沉默——否则每个会话都往对话里塞一条无用的失败提示。
        if (status.level === "warn" || status.level === "critical") {
            lines.push((0, monitor_1.statusLine)(status));
            const cands = (0, monitor_1.suggestCleanup)(policy, false);
            if (cands.length > 0) {
                lines.push("AgentDiskGuard 建议迁移以下 C 盘目录（命令默认 dry-run）：");
                lines.push(...(0, monitor_1.cleanupAdvice)(cands.slice(0, 5)));
            }
        }
    }
    // 宿主不采纳 hook 的入参改写时，命令级重定向只能靠模型自己显式带参数。
    // 会话开头说明一次，省掉每轮一次「被拒 → 重试」的摩擦。
    const host = options.host ?? (0, host_1.detectHost)(policy);
    if (!host.updatedInput) {
        lines.push(`AgentDiskGuard 运行态：当前宿主（${host.host}）不采纳 hook 的入参改写，` +
            `会写 C 盘缓存的命令必须显式带缓存参数（npm --cache "${policy.redirectRoot}\\npm-cache"、` +
            `pip --cache-dir "${policy.redirectRoot}\\pip"），否则会被拒绝。缓存根：${policy.redirectRoot}。`);
    }
    return lines;
}
