"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * AgentDiskGuard — SessionStart Hook。
 *
 * 只做 I/O：读宿主载荷、把提示文本包成 additionalContext JSON 写到 stdout。
 * 文本本身由 ./notice 生成，与 DSH 组合包的会话内注入共用一份实现。
 * 单次 PowerShell 查询约 200-500ms，仅在会话启动时发生一次。
 */
const adapters_1 = require("./adapters");
const logger_1 = require("./logger");
const notice_1 = require("./notice");
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
    const lines = (0, notice_1.buildSessionNotice)({ source });
    if (lines.length === 0)
        process.exit(0);
    // stdout 接的是宿主管道，process.exit 可能截断异步写 —— 必须同步写
    require("fs").writeSync(1, JSON.stringify((0, adapters_1.additionalContextOutput)(lines.join("\n"))));
    process.exit(0);
}
try {
    main();
}
catch {
    process.exit(0); // fail-open
}
