"use strict";
/**
 * AgentDiskGuard — 磁盘监控。
 * 检查 C 盘剩余空间，分级告警（warn/critical），并给出可迁移的清理建议。
 * 单次检查 = 一次 PowerShell CIM 查询（约 200-500ms），供 CLI / 计划任务 / SessionStart 复用。
 */
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
exports.classifyFree = classifyFree;
exports.checkDisk = checkDisk;
exports.statusLine = statusLine;
exports.measureDir = measureDir;
exports.suggestCleanup = suggestCleanup;
exports.cleanupAdvice = cleanupAdvice;
const fs = __importStar(require("fs"));
const util_1 = require("./util");
const pathguard_1 = require("./pathguard");
function classifyFree(freeBytes, policy) {
    if (freeBytes == null || !Number.isFinite(freeBytes))
        return "unknown";
    const gb = freeBytes / 1024 ** 3;
    if (gb <= policy.monitor.criticalGB)
        return "critical";
    if (gb <= policy.monitor.warnGB)
        return "warn";
    return "ok";
}
function checkDisk(policy, drive = policy.protectedDrive) {
    const letter = drive.replace(/[:\\]/g, "").toUpperCase();
    const free = (0, util_1.getDriveFreeBytes)(`${letter}:`);
    let total = null;
    if (free != null) {
        const r = (0, util_1.execSync)("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${letter}:'").Size`,
        ], { timeoutMs: 15000 });
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
function statusLine(s) {
    if (s.level === "unknown")
        return `${s.drive} 剩余空间未知（查询失败）`;
    const pct = s.totalBytes ? `（已用 ${(((s.totalBytes - s.freeBytes) / s.totalBytes) * 100).toFixed(1)}%）` : "";
    const mark = s.level === "critical" ? "🚨" : s.level === "warn" ? "⚠️" : "✅";
    return `${mark} ${s.drive} 剩余 ${(0, util_1.humanBytes)(s.freeBytes)}${pct}（阈值：warn ${s.warnGB}GB / critical ${s.criticalGB}GB）`;
}
/** 用 robocopy /L（仅列出）统计目录字节量，比 PowerShell 遍历快一个量级；失败返回 null。 */
function measureDir(dir, timeoutMs = 60000) {
    const r = (0, util_1.execSync)("robocopy.exe", [dir, "\\\\localhost\\c$\\__adg_empty__", "/L", "/E", "/NJH", "/BYTES", "/NDL", "/NFL", "/NP", "/R:0", "/W:0"], { timeoutMs });
    // robocopy 退出码 0-7 都算正常（0 = 无文件）
    if (r.status == null || r.status >= 8)
        return null;
    const m = r.stdout.match(/Bytes\s*:\s*([\d.]+)\s/i) || r.stdout.match(/字节\s*:\s*([\d.]+)/);
    if (!m)
        return null;
    const n = parseFloat(m[1].replace(/[.,]/g, ""));
    return Number.isFinite(n) ? n : null;
}
/** 列出 C 盘上仍实际存在（非 junction）的可迁移大目录。 */
function suggestCleanup(policy, withSizes = false) {
    const out = [];
    const seen = new Set();
    for (const pp of policy.protectedPaths) {
        const p = (0, util_1.normalizePath)(pp.path);
        if (seen.has(p.toLowerCase()))
            continue;
        seen.add(p.toLowerCase());
        // 系统保护目录只拦截、不建议迁移
        if (p.toLowerCase().startsWith("c:\\windows") || p.toLowerCase().startsWith("c:\\program"))
            continue;
        let exists = false;
        try {
            exists = fs.statSync(p).isDirectory();
        }
        catch {
            exists = false;
        }
        if (!exists)
            continue;
        const junction = (0, pathguard_1.isReparsePoint)(p);
        if (junction)
            continue; // 已迁移
        out.push({ path: p, exists, isJunction: junction, sizeBytes: withSizes ? measureDir(p) : null });
    }
    return out.sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1));
}
function cleanupAdvice(cands) {
    return cands.map((c) => {
        const size = c.sizeBytes != null ? `，约 ${(0, util_1.humanBytes)(c.sizeBytes)}` : "";
        return `可迁移：${c.path}${size} → 执行 agent-disk-guard migrate "${c.path}"（先 dry-run 预览）`;
    });
}
