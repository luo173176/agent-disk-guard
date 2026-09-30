/**
 * AgentDiskGuard — 路径守卫。
 * 判断一个写入路径是否落在受保护盘/受保护目录下，并计算重定向目标。
 * 关键细节：若受保护目录已被迁移为 Junction（指向 D 盘），实际写入已经落在 D 盘，
 * 必须放行，否则会把用户锁死在已迁移的目录上。
 */
import * as fs from "fs";
import * as path from "path";
import { driveLetter, driveOf, expandEnv, isPathUnder, localizeUnc, normalizePath, realResolve, reparseTarget } from "./util";
import type { Policy, ProtectedPath } from "./policy";

export interface PathCheckResult {
  /** 是否需要拦截（路径受保护且未被白名单/junction 豁免） */
  protected: boolean;
  /** 命中的受保护条目 */
  matched?: ProtectedPath;
  /** redirect 模式下的新路径（替换原路径后写入） */
  redirectPath?: string;
  /** 命中原因（用于 reason 展示） */
  reason?: string;
}

/** 是否为 reparse point（junction / symlink）。读取失败视为否。 */
export function isReparsePoint(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return (st as unknown as { isSymbolicLink(): boolean }).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 计算 redirect 目标：
 *  - 条目声明了 redirect 子目录 → redirectRoot\<redirect>\<相对子路径>
 *  - 未声明 → 镜像模式：redirectRoot\mirror\<相对用户目录或盘根的子路径>
 */
export function computeRedirectPath(target: string, matched: ProtectedPath, redirectRoot: string): string {
  const base = normalizePath(target);
  const root = normalizePath(matched.path);
  let rel = "";
  if (isPathUnder(base, root)) {
    rel = base.slice(root.length).replace(/^\\+/, "");
  }
  if (matched.redirect) {
    return rel ? `${normalizePath(redirectRoot)}\\${matched.redirect}\\${rel}` : `${normalizePath(redirectRoot)}\\${matched.redirect}`;
  }
  // 镜像模式：相对用户主目录（C:\Users\<u>\...）或盘根
  const home = process.env.USERPROFILE || "";
  const homeN = normalizePath(home).toLowerCase();
  const baseN = base.toLowerCase();
  let anchor: string;
  if (homeN && baseN.startsWith(homeN + "\\")) {
    anchor = "home";
    rel = base.slice(normalizePath(home).length).replace(/^\\+/, "");
  } else {
    anchor = "drive" + (driveOf(base) || "x").toLowerCase();
    rel = base.slice(3); // 去掉 "c:\"
  }
  return `${normalizePath(redirectRoot)}\\mirror\\${anchor}\\${rel}`;
}

/**
 * 检查一个写入路径。
 *  - 命中白名单前缀 → 放行
 *  - 命中受保护目录，但该目录已是 junction 且目标不在受保护盘（数据实际在别处）→ 放行
 *  - 命中受保护目录 → protected=true 并给出 redirectPath
 *  - 落在受保护盘根（C:\foo.txt）→ 同样拦截，防止 Agent 往 C:\ 塞垃圾
 *
 * 判定前会先展开环境变量、把相对路径按 cwd 解析、折叠 `..`、剥掉 `\\?\`/`\\.\` 前缀、
 * 把本机 UNC（\\localhost\c$\x）映射回盘符路径；直判不保护时再用 realpath 复核一次，
 * 以覆盖 8.3 短名（C:\PROGRA~1\...）与指向受保护目录的软链接。
 */
export function checkPath(target: string, policy: Policy): PathCheckResult {
  const raw = expandEnv(String(target ?? "")).trim();
  if (!raw) return { protected: false };

  const abs = path.isAbsolute(raw) ? raw : path.resolve(raw);
  const direct = judgePath(abs, policy);
  if (direct.protected) return direct;

  const real = realResolve(abs);
  if (real && normalizePath(real).toLowerCase() !== normalizePath(abs).toLowerCase()) {
    const viaReal = judgePath(real, policy);
    if (viaReal.protected) {
      return { ...viaReal, reason: `${viaReal.reason}（经短名/链接解析自 "${abs}"）` };
    }
  }
  return { protected: false };
}

/** 单次纯字符串判定（不做 realpath 复核），供 checkPath 与其二次复核共用。 */
function judgePath(target: string, policy: Policy): PathCheckResult {
  const p = localizeUnc(target);
  if (!p) return { protected: false };
  const protectDrive = driveLetter(policy.protectedDrive);

  // 白名单优先
  for (const w of policy.whitelist) {
    if (isPathUnder(p, w)) return { protected: false };
  }

  // 命中受保护目录（条目自带盘符，因此策略把保护盘改成别的盘时旧条目依然有效）
  for (const pp of policy.protectedPaths) {
    if (!isPathUnder(p, pp.path)) continue;
    // 已迁移成 junction 且目标不在受保护盘 → 实际写入不在该盘 → 放行
    const link = reparseTarget(pp.path);
    const linkDrive = link ? driveOf(link) : null;
    if (linkDrive && linkDrive !== protectDrive) return { protected: false };
    return {
      protected: true,
      matched: pp,
      redirectPath: computeRedirectPath(p, pp, policy.redirectRoot),
      reason: `"${p}" 位于受保护目录 ${pp.path}（${policy.protectedDrive}: 盘）`,
    };
  }

  // 盘根散文件（C:\xxx）也拦，避免 Agent 直接往 C 盘根写东西
  const rootOfDrive = `${protectDrive.toLowerCase()}:\\`;
  if (isPathUnder(p, rootOfDrive) && !p.slice(3).includes("\\")) {
    return {
      protected: true,
      redirectPath: computeRedirectPath(p, { raw: rootOfDrive, path: rootOfDrive, redirect: undefined }, policy.redirectRoot),
      reason: `"${p}" 直接写入 ${policy.protectedDrive}: 盘根`,
    };
  }

  return { protected: false };
}
