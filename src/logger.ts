/**
 * AgentDiskGuard — 轻量日志。
 * 日志写入数据目录（KB 级文本），并按需镜像到 stderr。
 */
import * as fs from "fs";
import * as path from "path";
import { dataDir, ensureDir } from "./util";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minStderrLevel: number = LEVELS.warn; // hook 模式下 stderr 不会干扰 stdout JSON，但保持安静
let minFileLevel: number = LEVELS.info;
let fileLogBroken = false;

export function configureLogging(opts: { stderr?: LogLevel; file?: LogLevel; quiet?: boolean } = {}): void {
  if (opts.stderr) minStderrLevel = opts.quiet ? 99 : LEVELS[opts.stderr];
  if (opts.file) minFileLevel = LEVELS[opts.file];
}

function logFile(): string {
  return path.join(dataDir(), "agent-disk-guard.log");
}

export function log(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  const line =
    new Date().toISOString() +
    ` [${level.toUpperCase()}] ` +
    msg +
    (extra ? " " + JSON.stringify(extra) : "");
  if (LEVELS[level] >= minStderrLevel) {
    process.stderr.write(line + "\n");
  }
  if (LEVELS[level] >= minFileLevel) {
    try {
      ensureDir(dataDir());
      fs.appendFileSync(logFile(), line + "\n", "utf8");
      // 防止日志无限膨胀：超过 2MB 轮转保留一份
      const st = fs.statSync(logFile());
      if (st.size > 2 * 1024 * 1024) {
        const rotated = logFile() + ".1";
        try {
          fs.rmSync(rotated, { force: true }); // Windows 上 rename 不覆盖已有文件，先清旧的
        } catch {
          /* 旧轮转文件删不掉时让下面的 rename 去报错 */
        }
        fs.renameSync(logFile(), rotated);
      }
    } catch {
      // 日志失败不影响主流程（hook 的 stdout 必须保持干净，也不能往 stderr 刷噪音）。
      // 静默降级，并把状态暴露给 `agent-disk-guard doctor` 检查。
      fileLogBroken = true;
    }
  }
}

export const logDebug = (m: string, e?: Record<string, unknown>) => log("debug", m, e);
export const logInfo = (m: string, e?: Record<string, unknown>) => log("info", m, e);
export const logWarn = (m: string, e?: Record<string, unknown>) => log("warn", m, e);
export const logError = (m: string, e?: Record<string, unknown>) => log("error", m, e);

/** 日志文件是否曾经写失败（供 doctor 报告"日志静默失效"）。 */
export function isFileLogBroken(): boolean {
  return fileLogBroken;
}
