"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.expandEnv = expandEnv;
exports.homeDir = homeDir;
exports.dataDir = dataDir;
exports.normalizePath = normalizePath;
exports.isPathUnder = isPathUnder;
exports.driveOf = driveOf;
exports.driveLetter = driveLetter;
exports.readJson = readJson;
exports.ensureDir = ensureDir;
exports.appendJsonl = appendJsonl;
exports.shortId = shortId;
exports.execSync = execSync;
exports.powershell = powershell;
exports.getDriveFreeBytes = getDriveFreeBytes;
exports.humanBytes = humanBytes;
/**
 * AgentDiskGuard — 通用工具函数。
 * 运行时零依赖：只使用 Node 内置模块。
 */
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
/** 展开字符串中的 %VAR% 与 ${VAR} 环境变量引用；未定义的变量原样保留。 */
function expandEnv(input, extra = {}) {
    if (!input)
        return input;
    let out = input;
    // ${VAR}
    out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => name in extra ? extra[name] : process.env[name] !== undefined ? String(process.env[name]) : m);
    // %VAR%
    out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => name in extra ? extra[name] : process.env[name] !== undefined ? String(process.env[name]) : m);
    return out;
}
/** 用户主目录（优先 USERPROFILE，兼容非 Windows）。 */
function homeDir() {
    return process.env.USERPROFILE || process.env.HOME || os.homedir();
}
/** AgentDiskGuard 数据目录（日志/journal/用户策略，体量为 KB 级文本，刻意放在 C 盘以保证回滚可用）。 */
function dataDir() {
    return process.env.AGENTDISKGUARD_DATA_DIR || path.join(homeDir(), ".agent-disk-guard");
}
/** Windows 路径规范化：统一反斜杠、压缩重复分隔符、去掉末尾分隔符。不访问文件系统、不改大小写（比较用 isPathUnder）。 */
function normalizePath(p) {
    if (!p)
        return p;
    let out = p.replace(/\//g, "\\").replace(/\\+/g, "\\").trim();
    // 去掉末尾的 \（保留盘根 "C:\"）
    if (out.length > 3 && out.endsWith("\\"))
        out = out.slice(0, -1);
    return out;
}
/** 简易路径前缀判断（大小写不敏感、分隔符无关），不访问文件系统。 */
function isPathUnder(child, ancestor) {
    const c = normalizePath(child).toLowerCase();
    const a = normalizePath(ancestor).toLowerCase();
    if (a === c)
        return true;
    if (!a.endsWith("\\")) {
        return c.startsWith(a + "\\");
    }
    return c.startsWith(a);
}
/** 提取盘符（大写）；非 Windows 盘符格式返回 null。 */
function driveOf(p) {
    const m = normalizePath(p).match(/^([A-Za-z]):\\/);
    return m ? m[1].toUpperCase() : null;
}
/** 从 "C:" / "c:\" / "C" 等写法中提取大写盘符字母（策略字段可能带或不带冒号）。 */
function driveLetter(s) {
    return (s || "").replace(/[:\\]/g, "").toUpperCase();
}
/** 读取 JSON 文件（不存在或损坏返回 null）。 */
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        return null;
    }
}
/** 幂等创建目录。 */
function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}
/** 跨进程安全地追加一行 JSONL。 */
function appendJsonl(file, obj) {
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
}
/** 生成短 ID：时间戳 + 随机，用于 journal 条目。 */
function shortId() {
    return (Date.now().toString(36) +
        "-" +
        Math.random().toString(36).slice(2, 8));
}
/** 同步执行命令（spawnSync 封装），带超时保护，防止拖慢 Agent。 */
function execSync(cmd, args, opts = {}) {
    try {
        const r = (0, child_process_1.spawnSync)(cmd, args, {
            timeout: opts.timeoutMs ?? 30000,
            cwd: opts.cwd,
            windowsHide: true,
            encoding: "utf8",
        });
        return {
            status: r.status,
            stdout: r.stdout || "",
            stderr: r.stderr || "",
        };
    }
    catch (e) {
        return { status: null, stdout: "", stderr: String(e) };
    }
}
/**
 * 执行 PowerShell 片段（-NoProfile 关闭用户配置以提速）。
 */
function powershell(script, timeoutMs = 20000) {
    return execSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { timeoutMs });
}
/** 读取 Windows 指定盘剩余字节；失败返回 null。 */
function getDriveFreeBytes(drive = "C:", timeoutMs = 15000) {
    const letter = drive.replace(/[:\\]/g, "").toUpperCase();
    const r = powershell(`(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'" | Select-Object -Property FreeSpace,Size | ConvertTo-Json -Compress)`, timeoutMs);
    if (r.status !== 0 || !r.stdout.trim())
        return null;
    try {
        const parsed = JSON.parse(r.stdout.trim());
        if (typeof parsed.FreeSpace === "number")
            return parsed.FreeSpace;
        return null;
    }
    catch {
        return null;
    }
}
/** 字节数人性化显示。 */
function humanBytes(n) {
    if (!Number.isFinite(n))
        return String(n);
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
