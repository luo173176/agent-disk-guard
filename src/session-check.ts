/**
 * AgentDiskGuard — SessionStart Hook。
 * 会话开始时检查 C 盘剩余空间，低于阈值时向对话注入一条告警（additionalContext）。
 * 单次 PowerShell 查询约 200-500ms，仅在会话启动时发生一次。
 */
import { loadPolicy } from "./policy";
import { withWritableRedirectRoot } from "./pathguard";
import { detectHost } from "./host";
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

  const policy = withWritableRedirectRoot(loadPolicy());
  if (!policy.monitor.enabled || !policy.monitor.sessionStartCheck) {
    process.exit(0);
  }

  const status = checkDisk(policy);
  logInfo("session 空间检查", { level: status.level, free: status.freeBytes, source });

  // 只有低于阈值才报空间告警：ok 不打扰，
  // unknown（查询失败，例如受限令牌下 WMI 被拒）同样保持沉默——否则每个会话都往对话里塞一条无用的失败提示。
  const lines: string[] = [];
  if (status.level === "warn" || status.level === "critical") {
    lines.push(statusLine(status));
    const cands = suggestCleanup(policy, false);
    if (cands.length > 0) {
      lines.push("AgentDiskGuard 建议迁移以下 C 盘目录（命令默认 dry-run）：");
      lines.push(...cleanupAdvice(cands.slice(0, 5)));
    }
  }

  // 宿主不采纳 hook 的入参改写时，命令级重定向只能靠模型自己显式带参数。
  // 会话开头说明一次，省掉每轮一次「被拒 → 重试」的摩擦。
  const host = detectHost(policy);
  if (!host.updatedInput) {
    lines.push(
      `AgentDiskGuard 运行态：当前宿主（${host.host}）不采纳 hook 的入参改写，` +
        `会写 C 盘缓存的命令必须显式带缓存参数（npm --cache "${policy.redirectRoot}\\npm-cache"、` +
        `pip --cache-dir "${policy.redirectRoot}\\pip"），否则会被拒绝。缓存根：${policy.redirectRoot}。`
    );
  }

  if (lines.length === 0) process.exit(0);
  // stdout 接的是宿主管道，process.exit 可能截断异步写 —— 必须同步写
  require("fs").writeSync(1, JSON.stringify(additionalContextOutput(lines.join("\n"))));
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // fail-open
}
