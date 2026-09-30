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
exports.isReparsePoint = isReparsePoint;
exports.computeRedirectPath = computeRedirectPath;
exports.checkPath = checkPath;
/**
 * AgentDiskGuard — 路径守卫。
 * 判断一个写入路径是否落在受保护盘/受保护目录下，并计算重定向目标。
 * 关键细节：若受保护目录已被迁移为 Junction（指向 D 盘），实际写入已经落在 D 盘，
 * 必须放行，否则会把用户锁死在已迁移的目录上。
 */
const fs = __importStar(require("fs"));
const util_1 = require("./util");
/** 是否为 reparse point（junction / symlink）。读取失败视为否。 */
function isReparsePoint(p) {
    try {
        const st = fs.lstatSync(p);
        return st.isSymbolicLink();
    }
    catch {
        return false;
    }
}
/**
 * 计算 redirect 目标：
 *  - 条目声明了 redirect 子目录 → redirectRoot\<redirect>\<相对子路径>
 *  - 未声明 → 镜像模式：redirectRoot\mirror\<相对用户目录或盘根的子路径>
 */
function computeRedirectPath(target, matched, redirectRoot) {
    const base = (0, util_1.normalizePath)(target);
    const root = (0, util_1.normalizePath)(matched.path);
    let rel = "";
    if ((0, util_1.isPathUnder)(base, root)) {
        rel = base.slice(root.length).replace(/^\\+/, "");
    }
    if (matched.redirect) {
        return rel ? `${(0, util_1.normalizePath)(redirectRoot)}\\${matched.redirect}\\${rel}` : `${(0, util_1.normalizePath)(redirectRoot)}\\${matched.redirect}`;
    }
    // 镜像模式：相对用户主目录（C:\Users\<u>\...）或盘根
    const home = process.env.USERPROFILE || "";
    const homeN = (0, util_1.normalizePath)(home).toLowerCase();
    const baseN = base.toLowerCase();
    let anchor;
    if (homeN && baseN.startsWith(homeN + "\\")) {
        anchor = "home";
        rel = base.slice((0, util_1.normalizePath)(home).length).replace(/^\\+/, "");
    }
    else {
        anchor = "drive" + ((0, util_1.driveOf)(base) || "x").toLowerCase();
        rel = base.slice(3); // 去掉 "c:\"
    }
    return `${(0, util_1.normalizePath)(redirectRoot)}\\mirror\\${anchor}\\${rel}`;
}
/**
 * 检查一个写入路径。
 *  - 不在受保护盘 → 放行
 *  - 命中白名单前缀 → 放行
 *  - 命中受保护目录，但该目录已是 junction（数据实际在 D 盘）→ 放行
 *  - 命中受保护目录 → protected=true 并给出 redirectPath
 *  - 在受保护盘但不匹配任何目录（如 C:\ 任意位置写文件）：仅当路径在盘根/系统目录之外且
 *    policy.fileWriteMode=off 时不拦；默认策略只拦 protectedPaths 命中项，
 *    对受保护盘上“直接落在盘根的散文件”（如 C:\foo.txt）也拦截，防止 Agent 往 C:\ 塞垃圾。
 */
function checkPath(target, policy) {
    const p = (0, util_1.normalizePath)(target);
    if (!p)
        return { protected: false };
    // 只关心受保护盘上的路径
    const drive = (0, util_1.driveOf)(p);
    if (!drive || drive !== (0, util_1.driveLetter)(policy.protectedDrive)) {
        return { protected: false };
    }
    // 白名单优先
    for (const w of policy.whitelist) {
        if ((0, util_1.isPathUnder)(p, w))
            return { protected: false };
    }
    // 命中受保护目录
    for (const pp of policy.protectedPaths) {
        if ((0, util_1.isPathUnder)(p, pp.path)) {
            // 已迁移成 junction → 实际写入在 D 盘 → 放行
            if (isReparsePoint(pp.path))
                return { protected: false };
            return {
                protected: true,
                matched: pp,
                redirectPath: computeRedirectPath(p, pp, policy.redirectRoot),
                reason: `"${p}" 位于受保护目录 ${pp.path}（${policy.protectedDrive}: 盘）`,
            };
        }
    }
    // 盘根散文件（C:\xxx）也拦，避免 Agent 直接往 C 盘根写东西
    const rootOfDrive = `${(0, util_1.driveLetter)(policy.protectedDrive).toLowerCase()}:\\`;
    if ((0, util_1.isPathUnder)(p, rootOfDrive) && !p.slice(3).includes("\\")) {
        return {
            protected: true,
            redirectPath: computeRedirectPath(p, { raw: rootOfDrive, path: rootOfDrive, redirect: undefined }, policy.redirectRoot),
            reason: `"${p}" 直接写入 ${policy.protectedDrive}: 盘根`,
        };
    }
    return { protected: false };
}
