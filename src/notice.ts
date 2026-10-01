/**
 * AgentDiskGuard — 会话启动提示文本。
 *
 * 同一段文本有两个消费方：SessionStart hook（独立进程，产物是 additionalContext JSON）
 * 和 DSH 组合包（在宿主进程内直接注入成一条 user message）。抽在这里，免得两处各写
 * 一份、改一处漏一处。
 */
import type { Policy } from "./policy";
import { loadPolicy } from "./policy";
import { withWritableRedirectRoot } from "./pathguard";
import type { HostCapabilities } from "./host";
import { detectHost } from "./host";
import { checkDisk, cleanupAdvice, statusLine, suggestCleanup } from "./monitor";
import { logInfo } from "./logger";

export interface SessionNoticeOptions {
  /** 触发来源，仅用于日志：startup / clear / compact / dsh-plugin */
  source?: string;
  /** 已知宿主能力时传入，省掉一次环境探测（DSH 组合包跑在宿主进程内，事实明确） */
  host?: HostCapabilities;
  /** 已加载的策略；缺省时自行 loadPolicy 并选定可写的重定向根 */
  policy?: Policy;
}

/**
 * 生成要注入会话的提示行；无事可报时返回空数组。
 */
export function buildSessionNotice(options: SessionNoticeOptions = {}): string[] {
  const { source = "startup" } = options;
  const policy = options.policy ?? withWritableRedirectRoot(loadPolicy());
  const lines: string[] = [];

  if (policy.monitor.enabled && policy.monitor.sessionStartCheck) {
    const status = checkDisk(policy);
    logInfo("session 空间检查", { level: status.level, free: status.freeBytes, source });
    // 只有低于阈值才报空间告警：ok 不打扰，
    // unknown（查询失败，例如受限令牌下 WMI 被拒）同样保持沉默——否则每个会话都往对话里塞一条无用的失败提示。
    if (status.level === "warn" || status.level === "critical") {
      lines.push(statusLine(status));
      const cands = suggestCleanup(policy, false);
      if (cands.length > 0) {
        lines.push("AgentDiskGuard 建议迁移以下 C 盘目录（命令默认 dry-run）：");
        lines.push(...cleanupAdvice(cands.slice(0, 5)));
      }
    }
  }

  // 宿主不采纳 hook 的入参改写时，命令级重定向只能靠模型自己显式带参数。
  // 会话开头说明一次，省掉每轮一次「被拒 → 重试」的摩擦。
  const host = options.host ?? detectHost(policy);
  if (!host.updatedInput) {
    lines.push(
      `AgentDiskGuard 运行态：当前宿主（${host.host}）不采纳 hook 的入参改写，` +
        `会写 C 盘缓存的命令必须显式带缓存参数（npm --cache "${policy.redirectRoot}\\npm-cache"、` +
        `pip --cache-dir "${policy.redirectRoot}\\pip"），否则会被拒绝。缓存根：${policy.redirectRoot}。`
    );
  }

  return lines;
}
