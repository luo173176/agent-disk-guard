/**
 * AgentDiskGuard — SessionStart Hook。
 * 会话开始时检查 C 盘剩余空间，低于阈值时向对话注入一条告警（additionalContext）。
 * 单次 PowerShell 查询约 200-500ms，仅在会话启动时发生一次。
 */
import { loadPolicy } from "./policy";
import { additionalContextOutput } from "./adapters";
import { checkDisk, cleanupAdvice, statusLine, suggestCleanup } from "./monitor";
import { configureLogging, logInfo } from "./logger";

function main(): void {
  configureLogging({ file: "info" });
  let payload: Record<string, unknown> = {};
  try {
    const raw = require("fs").readFileSync(0, "utf8");
    if (raw && raw.trim()) payload = JSON.parse(raw);
  } catch {
    /* 载荷可缺省 */
  }
  // clear/compact 也检查一次，成本低；若 Agent 载荷无 source 字段则照常检查
  const source = typeof payload.source === "string" ? payload.source : "startup";

  const policy = loadPolicy();
  if (!policy.monitor.enabled || !policy.monitor.sessionStartCheck) {
    process.exit(0);
  }

  const status = checkDisk(policy);
  logInfo("session 空间检查", { level: status.level, free: status.freeBytes, source });

  // 只有真的低于阈值才注入告警：ok 不打扰，
  // unknown（查询失败，例如受限令牌下 WMI 被拒）同样保持沉默——否则每个会话都往对话里塞一条无用的失败提示。
  if (status.level !== "warn" && status.level !== "critical") {
    process.exit(0);
  }
  const lines = [statusLine(status)];
  const cands = suggestCleanup(policy, false);
  if (cands.length > 0) {
    lines.push("AgentDiskGuard 建议迁移以下 C 盘目录（命令默认 dry-run）：");
    lines.push(...cleanupAdvice(cands.slice(0, 5)));
  }
  // stdout 接的是宿主管道，process.exit 可能截断异步写 —— 必须同步写
  require("fs").writeSync(1, JSON.stringify(additionalContextOutput(lines.join("\n"))));
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail-open
}
