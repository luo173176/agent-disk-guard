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
exports.planMigration = planMigration;
exports.executeMigration = executeMigration;
exports.purgeBackup = purgeBackup;
exports.rollbackMigration = rollbackMigration;
/**
 * AgentDiskGuard — 目录迁移（robocopy + junction），带 dry-run / 备份 / 回滚。
 *
 * 迁移步骤（每步都落 journal）：
 *   1. robocopy /E 把源目录完整复制到 D 盘目标
 *   2. 源目录改名 *.adg-bak（同盘改名，原子操作，即备份）
 *   3. mklink /J 在原路径建 Junction 指向 D 盘目标
 *   4. 验证通过后备份保留在原地；只有用户显式 `migrate --purge-backup` 才删除（二次确认）
 *
 * 回滚：
 *   - rmdir 原路径（只拆 Junction，绝不动 D 盘数据）
 *   - 把 *.adg-bak 改回原名；若无备份则 robocopy /MOVE 从 D 盘搬回
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const util_1 = require("./util");
const pathguard_1 = require("./pathguard");
const journal_1 = require("./journal");
const monitor_1 = require("./monitor");
/** 迁移黑名单：系统目录与基础设施一律拒绝迁移。 */
function isForbiddenForMigration(p) {
    const n = (0, util_1.normalizePath)(p).toLowerCase();
    const home = (0, util_1.normalizePath)((0, util_1.homeDir)()).toLowerCase();
    const forbidden = [
        "c:\\windows",
        "c:\\program files",
        "c:\\program files (x86)",
        "c:\\programdata",
        "c:\\users",
        home,
    ];
    for (const f of forbidden) {
        if (n === f)
            return f;
    }
    // 盘根
    if (/^[a-z]:\\?$/.test(n))
        return n;
    return null;
}
/** 根据源目录找策略里的 redirect 子目录名；找不到返回 undefined（走 mirror 模式）。 */
function matchProtectedEntry(source, policy) {
    const s = (0, util_1.normalizePath)(source).toLowerCase();
    let best;
    let bestLen = -1;
    for (const pp of policy.protectedPaths) {
        const p = (0, util_1.normalizePath)(pp.path).toLowerCase();
        if ((s === p || s.startsWith(p + "\\")) && p.length > bestLen) {
            best = pp;
            bestLen = p.length;
        }
    }
    return best;
}
/**
 * 生成迁移计划（不做任何修改）。
 * 失败时返回 { ok:false, message }，message 说明原因。
 */
function planMigration(source, policy, withSize = true) {
    const src = (0, util_1.normalizePath)(source);
    if (!/^[A-Za-z]:\\/.test(src)) {
        return { ok: false, message: `仅支持 Windows 绝对路径，收到: ${source}` };
    }
    if (!fs.existsSync(src))
        return { ok: false, message: `源目录不存在: ${src}` };
    if (!fs.statSync(src).isDirectory())
        return { ok: false, message: `源不是目录: ${src}` };
    if ((0, pathguard_1.isReparsePoint)(src))
        return { ok: false, message: `源已是 Junction/链接，无需迁移（数据实际在别处）: ${src}` };
    if (src[0].toUpperCase() !== (0, util_1.driveLetter)(policy.protectedDrive)) {
        return { ok: false, message: `源目录不在受保护盘 ${policy.protectedDrive}: 上: ${src}` };
    }
    const forb = isForbiddenForMigration(src);
    if (forb)
        return { ok: false, message: `拒绝迁移系统/基础目录: ${forb}` };
    const root = (0, util_1.normalizePath)(policy.redirectRoot);
    if (root[0].toUpperCase() === (0, util_1.driveLetter)(policy.protectedDrive)) {
        return { ok: false, message: `redirectRoot 必须在非 ${policy.protectedDrive}: 盘上（当前: ${root}）` };
    }
    const srcL = src.toLowerCase();
    const rootL = root.toLowerCase();
    if (srcL.startsWith(rootL) || rootL.startsWith(srcL)) {
        return { ok: false, message: `源目录与重定向根相互嵌套，拒绝迁移: ${src} / ${root}` };
    }
    if (srcL === (0, util_1.normalizePath)((0, util_1.homeDir)()).toLowerCase()) {
        return { ok: false, message: "拒绝迁移用户主目录本身" };
    }
    const entry = matchProtectedEntry(src, policy);
    let dest;
    if (entry?.redirect) {
        dest = `${root}\\${entry.redirect}`;
    }
    else {
        // mirror 模式：redirectRoot\mirror\home\<相对用户主目录>（与 pathguard.computeRedirectPath 一致）
        const home = (0, util_1.normalizePath)((0, util_1.homeDir)());
        const homeL = home.toLowerCase();
        let rel;
        if (srcL.startsWith(homeL + "\\")) {
            rel = src.slice(home.length).replace(/^\\+/, "");
            dest = `${root}\\mirror\\home\\${rel}`;
        }
        else {
            rel = src.slice(3); // 去掉 "C:\"
            dest = `${root}\\mirror\\drive${policy.protectedDrive.toLowerCase()}\\${rel}`;
        }
    }
    const warnings = [];
    if (fs.existsSync(dest)) {
        const empty = (() => {
            try {
                return fs.readdirSync(dest).length === 0;
            }
            catch {
                return false;
            }
        })();
        if (!empty)
            return { ok: false, message: `目标已存在且非空，拒绝覆盖: ${dest}` };
        warnings.push(`目标已存在但为空，将复用: ${dest}`);
    }
    // 检查是否有正在使用该目录的已知进程 —— 无法完全检测，给人工提示
    warnings.push("迁移前请确认没有程序正在使用该目录（node/IDE/终端）。");
    warnings.push("迁移后原路径变为 Junction；卸载或整理 D 盘时请勿删除该目标目录。");
    const backupPath = `${src}.adg-bak`;
    if (fs.existsSync(backupPath)) {
        return { ok: false, message: `备份目录已存在（上次迁移未清理？）: ${backupPath}。请先处理它再迁移。` };
    }
    const sizeBytes = withSize ? (0, monitor_1.measureDir)(src) : null;
    const steps = [
        `robocopy "${src}" "${dest}" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NP /MT:8`,
        `ren "${src}" → "${path.basename(backupPath)}"（保留为备份）`,
        `mklink /J "${src}" "${dest}"`,
        `验证 Junction 可读写，journal 记录完成`,
        `（可选，需二次确认）--purge-backup 删除 "${backupPath}"`,
    ];
    const sizeNote = sizeBytes != null ? `，约 ${(0, util_1.humanBytes)(sizeBytes)}` : "";
    warnings.unshift(`将迁移${sizeNote}: ${src} → ${dest}`);
    return { ok: true, message: "dry-run 计划已生成（未做任何修改）", plan: { source: src, dest, backupPath, sizeBytes, steps, warnings } };
}
/** 执行迁移。必须显式 confirm（--yes），否则拒绝（二次确认）。 */
function executeMigration(plan, confirm) {
    if (!confirm) {
        return { ok: false, message: "危险操作需二次确认：加 --yes 才会真正执行。请先检查 dry-run 计划。", plan };
    }
    const { source, dest, backupPath } = plan;
    try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // 1) robocopy 复制（0-7 成功）
        const rc = (0, util_1.execSync)("robocopy.exe", [source, dest, "/E", "/COPY:DAT", "/DCOPY:DAT", "/R:1", "/W:1", "/NFL", "/NDL", "/NP", "/MT:8"], { timeoutMs: 30 * 60 * 1000 });
        if (rc.status == null || rc.status >= 8) {
            (0, journal_1.appendEntry)({ id: `${Date.now()}-f`, op: "migrate", time: new Date().toISOString(), source, dest, junction: source, backupPath: null, status: "failed", note: `robocopy 退出码 ${rc.status}` });
            return { ok: false, message: `robocopy 复制失败（退出码 ${rc.status}），未修改源目录。stderr: ${rc.stderr.slice(0, 400)}` };
        }
        // 2) 源目录改名备份（同卷原子）
        fs.renameSync(source, backupPath);
        // 3) 建 Junction
        const ml = (0, util_1.execSync)("cmd.exe", ["/c", "mklink", "/J", source, dest], { timeoutMs: 15000 });
        if (ml.status !== 0) {
            // 回滚改名
            try {
                fs.renameSync(backupPath, source);
            }
            catch {
                /* 记录但不再抛 */
            }
            (0, journal_1.appendEntry)({ id: `${Date.now()}-f`, op: "migrate", time: new Date().toISOString(), source, dest, junction: source, backupPath, status: "failed", note: `mklink 失败: ${ml.stdout} ${ml.stderr}` });
            return { ok: false, message: `mklink 失败，已恢复原目录: ${ml.stdout || ml.stderr}` };
        }
        // 4) 验证 Junction 可读
        try {
            fs.readdirSync(source);
        }
        catch (e) {
            (0, journal_1.appendEntry)({ id: `${Date.now()}-f`, op: "migrate", time: new Date().toISOString(), source, dest, junction: source, backupPath, status: "failed", note: `验证失败 ${String(e)}` });
            return { ok: false, message: `Junction 创建后验证失败，请检查: ${String(e)}` };
        }
        const entry = {
            id: `${Date.now()}-m`,
            op: "migrate",
            time: new Date().toISOString(),
            source,
            dest,
            junction: source,
            backupPath,
            status: "done",
            note: "备份保留在源盘，--purge-backup 需二次确认",
        };
        (0, journal_1.appendEntry)(entry);
        return { ok: true, message: `迁移完成：${source} → ${dest}（Junction 已建，备份 ${backupPath} 已保留）`, plan };
    }
    catch (e) {
        return { ok: false, message: `迁移失败（已尽力保持原状，请人工检查）: ${String(e)}` };
    }
}
/** 删除迁移备份（二次确认）。 */
function purgeBackup(source, confirm) {
    const state = (0, journal_1.latestStateFor)(source);
    const src = (0, util_1.normalizePath)(source);
    const backup = state?.backupPath ?? `${src}.adg-bak`;
    if (!fs.existsSync(backup))
        return { ok: false, message: `备份不存在（已清理？）: ${backup}` };
    if (!confirm)
        return { ok: false, message: `删除备份不可恢复，需二次确认：加 --yes。备份: ${backup}` };
    try {
        fs.rmSync(backup, { recursive: true, force: true });
        (0, journal_1.appendEntry)({ id: `${Date.now()}-p`, op: "purge-backup", time: new Date().toISOString(), source: src, dest: state?.dest ?? "", junction: src, backupPath: null, status: "purged" });
        return { ok: true, message: `备份已删除: ${backup}` };
    }
    catch (e) {
        return { ok: false, message: `删除备份失败: ${String(e)}` };
    }
}
/** 回滚迁移（默认 dry-run）。 */
function rollbackMigration(source, confirm, withSize = true) {
    const src = (0, util_1.normalizePath)(source);
    const state = (0, journal_1.latestStateFor)(src);
    if (!state || state.op !== "migrate" || !state.dest) {
        return { ok: false, message: `journal 中找不到该目录的迁移记录: ${src}` };
    }
    if (state.status === "rolled-back")
        return { ok: false, message: "该迁移已回滚过" };
    const dest = state.dest;
    const backupPath = state.backupPath ?? `${src}.adg-bak`;
    const steps = [];
    const warnings = [];
    const junctionLive = (() => {
        try {
            return (0, pathguard_1.isReparsePoint)(src);
        }
        catch {
            return false;
        }
    })();
    if (junctionLive)
        steps.push(`rmdir "${src}"（仅拆除 Junction，不影响 ${dest} 数据）`);
    else
        warnings.push(`原路径当前不是 Junction（可能已被移动/删除）: ${src}`);
    const backupExists = fs.existsSync(backupPath);
    if (backupExists)
        steps.push(`ren "${backupPath}" → "${src}"（恢复原目录）`);
    else
        steps.push(`robocopy /MOVE "${dest}" → "${src}"（无备份时从 D 盘搬回）`);
    const sizeBytes = withSize && fs.existsSync(dest) ? (0, monitor_1.measureDir)(dest) : null;
    const sizeNote = sizeBytes != null ? `，约 ${(0, util_1.humanBytes)(sizeBytes)}` : "";
    warnings.unshift(`将回滚迁移${sizeNote}: ${dest} → ${src}`);
    const plan = { source: src, dest, backupPath, sizeBytes, steps, warnings };
    if (!confirm)
        return { ok: true, message: "回滚 dry-run 计划已生成（未做任何修改）", plan };
    try {
        if (junctionLive) {
            const rd = (0, util_1.execSync)("cmd.exe", ["/c", "rmdir", src], { timeoutMs: 15000 });
            if (rd.status !== 0)
                return { ok: false, message: `拆除 Junction 失败: ${rd.stdout || rd.stderr}` };
        }
        if (fs.existsSync(backupPath)) {
            fs.renameSync(backupPath, src);
        }
        else if (fs.existsSync(dest)) {
            const rc = (0, util_1.execSync)("robocopy.exe", [dest, src, "/E", "/MOVE", "/COPY:DAT", "/DCOPY:DAT", "/R:1", "/W:1", "/NFL", "/NDL", "/NP"], { timeoutMs: 30 * 60 * 1000 });
            if (rc.status == null || rc.status >= 8) {
                return { ok: false, message: `从 D 盘搬回失败（robocopy 退出码 ${rc.status}）` };
            }
        }
        (0, journal_1.appendEntry)({ id: `${Date.now()}-r`, op: "rollback", time: new Date().toISOString(), source: src, dest, junction: src, backupPath: null, status: "rolled-back" });
        const destLeft = fs.existsSync(dest) ? `D 盘副本保留在 ${dest}（确认无误后可手动删除）` : "D 盘数据已搬回";
        return { ok: true, message: `回滚完成：${src} 已恢复为真实目录。${destLeft}`, plan };
    }
    catch (e) {
        return { ok: false, message: `回滚失败，请人工检查: ${String(e)}` };
    }
}
