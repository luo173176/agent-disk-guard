/**
 * AgentDiskGuard — 操作日志（journal）与回滚。
 * 所有迁移/回滚动作先记 journal（JSONL，追加式），保证可审计、可回滚。
 * journal 刻意放在 C 盘数据目录：即使 D 盘损坏，回滚信息仍然可用。
 */
import * as fs from "fs";
import * as path from "path";
import { dataDir } from "./util";

export type JournalOp = "migrate" | "rollback" | "purge-backup";

export interface JournalEntry {
  id: string;
  op: JournalOp;
  time: string;
  source: string;
  dest: string;
  junction: string; // 原路径上的 junction（= source）
  backupPath: string | null; // 迁移时源目录的临时备份（source.adg-bak）
  status: "planned" | "done" | "failed" | "rolled-back" | "purged";
  bytesMoved?: number;
  note?: string;
}

export function journalFile(): string {
  return process.env.AGENTDISKGUARD_JOURNAL || path.join(dataDir(), "journal.jsonl");
}

export function appendEntry(entry: JournalEntry): void {
  fs.mkdirSync(path.dirname(journalFile()), { recursive: true });
  fs.appendFileSync(journalFile(), JSON.stringify(entry) + "\n", "utf8");
}

/** 读取全部 journal 条目（跳过损坏行）。 */
export function readEntries(): JournalEntry[] {
  const out: JournalEntry[] = [];
  let raw = "";
  try {
    raw = fs.readFileSync(journalFile(), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as JournalEntry);
    } catch {
      /* 忽略损坏行 */
    }
  }
  return out;
}

/** 查找某条目之后该路径链上的最新状态（迁移→回滚→清理）。 */
export function latestStateFor(source: string): JournalEntry | undefined {
  const key = source.toLowerCase();
  const hits = readEntries().filter((e) => e.source.toLowerCase() === key);
  return hits[hits.length - 1];
}
