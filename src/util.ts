/**
 * AgentDiskGuard — 通用工具函数。
 * 运行时零依赖：只使用 Node 内置模块。
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** 展开字符串中的 %VAR% 与 ${VAR} 环境变量引用；未定义的变量原样保留。 */
export function expandEnv(input: string, extra: Record<string, string> = {}): string {
  if (!input) return input;
  let out = input;
  // ${VAR}
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name: string) =>
    name in extra ? extra[name] : process.env[name] !== undefined ? String(process.env[name]) : m
  );
  // %VAR%
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) =>
    name in extra ? extra[name] : process.env[name] !== undefined ? String(process.env[name]) : m
  );
  return out;
}

/** 用户主目录（优先 USERPROFILE，兼容非 Windows）。 */
export function homeDir(): string {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

/** AgentDiskGuard 数据目录（日志/journal/用户策略，体量为 KB 级文本，刻意放在 C 盘以保证回滚可用）。 */
export function dataDir(): string {
  return process.env.AGENTDISKGUARD_DATA_DIR || path.join(homeDir(), ".agent-disk-guard");
}

/**
 * Windows 路径规范化：统一反斜杠、压缩重复分隔符、剥掉 Win32 设备前缀、折叠 `.` 与 `..`、去掉末尾分隔符。
 * 不访问文件系统、不改大小写（比较用 isPathUnder）。
 *
 * 折叠 `..` 是把 `C:\foo\..\Windows` 归一成 `C:\Windows`——与 Win32 实际解析行为一致，
 * 否则 `C:\foo\..\Windows\system32\cmd.exe` 这类写法会绕过受保护目录判定（字符串前缀比较失配）。
 */
export function normalizePath(p: string): string {
  if (!p) return p;
  let out = p.replace(/\//g, "\\").trim();
  // 压缩重复分隔符；但开头的 UNC/设备前缀 `\\` 必须保留，否则 \\localhost\c$\x 会被压成 \localhost\c$\x 而失配。
  out = out.startsWith("\\\\") ? "\\\\" + out.slice(2).replace(/\\+/g, "\\") : out.replace(/\\+/g, "\\");
  // 剥掉设备前缀：\\?\C:\x → C:\x，\\?\UNC\srv\share → \\srv\share，\\.\C:\x → C:\x
  const dev = out.match(/^\\\\[?.]\\(.*)$/);
  if (dev) {
    const rest = dev[1];
    out = /^UNC\\/i.test(rest) ? "\\\\" + rest.slice(4) : rest;
  }
  // 折叠 "." 与 ".."（UNC 保留 \\server\share 头，盘符路径保留 "C:"）
  const unc = out.match(/^\\\\([^\\]+)\\?([^\\]*)(\\[\s\S]*)?$/);
  if (unc && unc[1]) {
    out = `\\\\${unc[1]}\\${unc[2] ?? ""}` + collapseSegments(unc[3] ?? "");
  } else if (/^[A-Za-z]:/.test(out)) {
    out = out.slice(0, 2) + collapseSegments(out.slice(2));
  }
  // 去掉末尾的 \（保留盘根 "C:\"）
  if (out.length > 3 && out.endsWith("\\")) out = out.slice(0, -1);
  return out;
}

/** 折叠路径剩余段中的 `.` 与 `..`；越界的 `..`（超过盘根）直接丢弃。 */
function collapseSegments(rest: string): string {
  const out: string[] = [];
  for (const seg of rest.split("\\")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length ? "\\" + out.join("\\") : "\\";
}

/**
 * 把指向本机的 UNC 管理共享写法映射为盘符路径：`\\localhost\c$\x` / `\\127.0.0.1\c$\x` → `C:\x`。
 * 其他 UNC（真实远程共享）原样返回。
 */
export function localizeUnc(p: string): string {
  const n = normalizePath(p);
  const m = n.match(/^\\\\(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\\([A-Za-z])\$(\\[\s\S]*)?$/i);
  return m ? `${m[1].toUpperCase()}:${m[2] ?? "\\"}` : n;
}

/** 简易路径前缀判断（大小写不敏感、分隔符无关），不访问文件系统。 */
export function isPathUnder(child: string, ancestor: string): boolean {
  const c = normalizePath(child).toLowerCase();
  const a = normalizePath(ancestor).toLowerCase();
  if (a === c) return true;
  if (!a.endsWith("\\")) {
    return c.startsWith(a + "\\");
  }
  return c.startsWith(a);
}

/** 提取盘符（大写）；非 Windows 盘符格式返回 null。本机 UNC 写法（\\localhost\c$\x）等同于 C:\x。 */
export function driveOf(p: string): string | null {
  const m = localizeUnc(p).match(/^([A-Za-z]):\\/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * 解析链接/短名后的"真实路径"：目标不存在时回落到父目录的 realpath（写新文件时常见）。
 * 无法解析返回 null。
 */
export function realResolve(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    /* 目标不存在，尝试父目录 */
  }
  try {
    const dir = path.dirname(p);
    if (dir && dir !== p) return path.join(fs.realpathSync.native(dir), path.basename(p));
  } catch {
    /* 父目录也不可解析（例如整条路径都不存在） */
  }
  return null;
}

/** 读取目录上已有重解析点（junction/symlink）的目标路径；不是链接返回 null。 */
export function reparseTarget(p: string): string | null {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return null;
    return fs.readlinkSync(p) || null;
  } catch {
    return null;
  }
}

/** 从 "C:" / "c:\" / "C" 等写法中提取大写盘符字母（策略字段可能带或不带冒号）。 */
export function driveLetter(s: string): string {
  return (s || "").replace(/[:\\]/g, "").toUpperCase();
}

/** 读取 JSON 文件（不存在或损坏返回 null）。 */
export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** 幂等创建目录。 */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 目录是否真的可写：建目录 + 写探针文件 + 删除。
 * 沙箱/受限令牌下 mkdir 可能成功而写入被拒，所以探针必须真的落盘一次。
 */
export function isDirWritable(dir: string): boolean {
  if (!dir) return false;
  const probe = path.join(dir, `.adg-write-probe-${process.pid}-${Date.now().toString(36)}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, "1");
    return true;
  } catch {
    return false;
  } finally {
    try {
      fs.unlinkSync(probe);
    } catch {
      /* 未创建或已被清理 */
    }
  }
}

/** 跨进程安全地追加一行 JSONL。 */
export function appendJsonl(file: string, obj: unknown): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
}

/** 生成短 ID：时间戳 + 随机，用于 journal 条目。 */
export function shortId(): string {
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

/** 仅供 execSync 使用的短名临时文件（不依赖子进程管道）。 */
function tmpOutFile(kind: string): string {
  const name = `adg-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${kind}.tmp`;
  return path.join(os.tmpdir(), name);
}

/**
 * 同步执行命令（spawnSync 封装），带超时保护，防止拖慢 Agent。
 *
 * 输出用**文件句柄**承接而不是 stdio 管道：在受限令牌 / 低完整性（沙箱）环境里，
 * 管道捕获会被拦（Node 抛 EPERM，或子进程直接无权运行），文件重定向仍然可用。
 */
export function execSync(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {}
): { status: number | null; stdout: string; stderr: string } {
  const outFile = tmpOutFile("out");
  const errFile = tmpOutFile("err");
  let outFd: number | null = null;
  let errFd: number | null = null;
  try {
    outFd = fs.openSync(outFile, "w+");
    errFd = fs.openSync(errFile, "w+");
    const r = spawnSync(cmd, args, {
      timeout: opts.timeoutMs ?? 30000,
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ["ignore", outFd, errFd],
    });
    return { status: r.status, stdout: readTextFile(outFile), stderr: readTextFile(errFile) };
  } catch (e: unknown) {
    return { status: null, stdout: "", stderr: String(e) };
  } finally {
    for (const fd of [outFd, errFd]) {
      if (fd != null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* 已关闭 */
        }
      }
    }
    for (const f of [outFile, errFile]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* 未创建或已被清理 */
      }
    }
  }
}

function readTextFile(f: string): string {
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return "";
  }
}

/**
 * 执行 PowerShell 片段（-NoProfile 关闭用户配置以提速）。
 */
export function powershell(script: string, timeoutMs = 20000): { status: number | null; stdout: string; stderr: string } {
  return execSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { timeoutMs }
  );
}

/**
 * 读取盘剩余/总字节。优先 fs.statfsSync（纯 libuv 调用，不依赖 WMI / PowerShell 子进程，
 * 在受限令牌与低完整性沙箱里同样可用），失败再回落到 PowerShell CIM 查询。
 */
export function getDriveSpace(drive = "C:", timeoutMs = 15000): { freeBytes: number | null; totalBytes: number | null } {
  const letter = driveLetter(drive);
  const viaStatfs = statfsSpace(letter);
  if (viaStatfs) return viaStatfs;

  // 回落：WMI 需要相应权限，受限环境可能返回"拒绝访问"
  const r = powershell(
    `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'" | Select-Object -Property FreeSpace,Size | ConvertTo-Json -Compress)`,
    timeoutMs
  );
  if (r.status !== 0 || !r.stdout.trim()) return { freeBytes: null, totalBytes: null };
  try {
    const parsed = JSON.parse(r.stdout.trim()) as { FreeSpace?: number; Size?: number };
    return {
      freeBytes: typeof parsed.FreeSpace === "number" ? parsed.FreeSpace : null,
      totalBytes: typeof parsed.Size === "number" ? parsed.Size : null,
    };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}

/** fs.statfsSync 读数（Node >= 18.15 提供）；不可用或失败返回 null。 */
function statfsSpace(letter: string): { freeBytes: number; totalBytes: number } | null {
  const statfs = (fs as unknown as {
    statfsSync?: (p: string) => { bsize: number; blocks: number; bfree: number; bavail: number };
  }).statfsSync;
  if (typeof statfs !== "function") return null;
  try {
    const s = statfs(`${letter}:\\`);
    const bsize = Number(s.bsize);
    const free = Number(s.bavail || s.bfree) * bsize; // bavail：非特权用户实际可用
    const total = Number(s.blocks) * bsize;
    if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return null;
    return { freeBytes: free, totalBytes: total };
  } catch {
    return null;
  }
}

/** 读取 Windows 指定盘剩余字节；失败返回 null。 */
export function getDriveFreeBytes(drive = "C:", timeoutMs = 15000): number | null {
  return getDriveSpace(drive, timeoutMs).freeBytes;
}

/** 字节数人性化显示。 */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
