"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * AgentDiskGuard — SessionStart Hook。
 * 会话开始时检查 C 盘剩余空间，低于阈值时向对话注入一条告警（additionalContext）。
 * 单次 PowerShell 查询约 200-500ms，仅在会话启动时发生一次。
 */
const policy_1 = require("./policy");
const adapters_1 = require("./adapters");
const monitor_1 = require("./monitor");
const logger_1 = require("./logger");
function main() {
    (0, logger_1.configureLogging)({ file: "info" });
    let payload = {};
    try {
        const raw = require("fs").readFileSync(0, "utf8");
        if (raw && raw.trim())
            payload = JSON.parse(raw);
    }
    catch {
        /* 载荷可缺省 */
    }
    // clear/compact 也检查一次，成本低；若 Agent 载荷无 source 字段则照常检查
    const source = typeof payload.source === "string" ? payload.source : "startup";
    const policy = (0, policy_1.loadPolicy)();
    if (!policy.monitor.enabled || !policy.monitor.sessionStartCheck) {
        process.exit(0);
    }
    const status = (0, monitor_1.checkDisk)(policy);
    (0, logger_1.logInfo)("session 空间检查", { level: status.level, free: status.freeBytes, source });
    if (status.level === "ok") {
        process.exit(0); // 正常时不打扰对话
    }
    const lines = [(0, monitor_1.statusLine)(status)];
    if (status.level !== "unknown") {
        const cands = (0, monitor_1.suggestCleanup)(policy, false);
        if (cands.length > 0) {
            lines.push("AgentDiskGuard 建议迁移以下 C 盘目录（命令默认 dry-run）：");
            lines.push(...(0, monitor_1.cleanupAdvice)(cands.slice(0, 5)));
        }
    }
    process.stdout.write(JSON.stringify((0, adapters_1.additionalContextOutput)(lines.join("\n"))));
    process.exit(0);
}
try {
    main();
}
catch {
    process.exit(0); // fail-open
}
