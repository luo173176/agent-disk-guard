/**
 * AgentDiskGuard — 磁盘监控。
 * 检查 C 盘剩余空间，分级告警（warn/critical），并给出可迁移的清理建议。
 * 单次检查 = 一次 PowerShell CIM 查询（约 200-500ms），供 CLI / 计划任务 / SessionStart 复用。
 */

import * as fs from "fs";
import { execSync, getDriveFreeBytes, humanBytes, normalizePath } from "./util";
import { isReparsePoint } from "./pathguard";
import type { Policy } from "./policy";

export type SpaceLevel = "ok" | "warn" | "critical" | "unknown";

export interface DiskStatus {
  drive: string;
  freeBytes: number | null;
  totalBytes: number | null;
  level: SpaceLevel;
  warnGB: number;
  criticalGB: number;
}

export function classifyFree(freeBytes: number | null, policy: Policy): SpaceLevel {
  if (freeBytes == null || !Number.isFinite(freeBytes)) return "unknown";
  const gb = freeBytes / 1024 ** 3;
  if (gb <= policy.monitor.criticalGB) return "critical";
  if (gb <= policy.monitor.warnGB) return "warn";
  return "ok";
}

export function checkDisk(policy: Policy, drive = policy.protectedDrive): DiskStatus {
  const letter = drive.replace(/[:\\]/g, "").toUpperCase();
  const free = getDriveFreeBytes(`${letter}:`);
  let total: number | null = null;
  if (free != null) {
    const r = execSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'").Size`,
      ],
      { timeoutMs: 15000 }
    );
    const n = parseInt(r.stdout.trim(), 10);
    total = Number.isFinite(n) ? n : null;
  }
  return {
    drive: `${letter}:`,
    freeBytes: free,
    totalBytes: total,
    level: classifyFree(free, policy),
    warnGB: policy.monitor.warnGB,
    criticalGB: policy.monitor.criticalGB,
  };
}

export function statusLine(s: DiskStatus): string {
  if (s.level === "unknown") return `${s.drive} 剩余空间未知（查询失败）`;
  const pct = s.totalBytes ? `（已用 ${(((s.totalBytes - s.freeBytes!) / s.totalBytes) * 100).toFixed(1)}%）` : "";
  const mark = s.level === "critical" ? "🚨" : s.level === "warn" ? "⚠️" : "✅";
  return `${mark} ${s.drive} 剩余 ${humanBytes(s.freeBytes!)}${pct}（阈值：warn ${s.warnGB}GB / critical ${s.criticalGB}GB）`;
}

export interface CleanupCandidate {
  path: string;
  exists: boolean;
  isJunction: boolean;
  sizeBytes: number | null;
}

/** 用 robocopy /L（仅列出）统计目录字节量，比 PowerShell 遍历快一个量级；失败返回 null。 */
export function measureDir(dir: string, timeoutMs = 60000): number | null {
  const r = execSync(
    "robocopy.exe",
    [dir, "\\\\localhost\\c$\\__adg_empty__", "/L", "/E", "/NJH", "/BYTES", "/NDL", "/NFL", "/NP", "/R:0", "/W:0"],
    { timeoutMs }
  );
  // robocopy 退出码 0-7 都算正常（0 = 无文件）
  if (r.status == null || r.status >= 8) return null;
  const m = r.stdout.match(/Bytes\s*:\s*([\d.]+)\s/i) || r.stdout.match(/字节\s*:\s*([\d.]+)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/[.,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** 列出 C 盘上仍实际存在（非 junction）的可迁移大目录。 */
export function suggestCleanup(policy: Policy, withSizes = false): CleanupCandidate[] {
  const out: CleanupCandidate[] = [];
  const seen = new Set<string>();
  for (const pp of policy.protectedPaths) {
    const p = normalizePath(pp.path);
    if (seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    // 系统保护目录只拦截、不建议迁移
    if (p.toLowerCase().startsWith("c:\\windows") || p.toLowerCase().startsWith("c:\\program")) continue;
    let exists = false;
    try {
      exists = fs.statSync(p).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) continue;
    const junction = isReparsePoint(p);
    if (junction) continue; // 已迁移
    out.push({ path: p, exists, isJunction: junction, sizeBytes: withSizes ? measureDir(p) : null });
  }
  return out.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1));
}

export function cleanupAdvice(cands: CleanupCandidate[]): string[] {
  return cands.map((c) => {
    const size = c.sizeBytes != null ? `，约 ${humanBytes(c.sizeBytes)}` : "";
    return `可迁移：${c.path}${size} → 执行 agent-disk-guard migrate "${c.path}"（先 dry-run 预览）`;
  });
}
