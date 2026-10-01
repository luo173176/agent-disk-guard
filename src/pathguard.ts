/**
 * AgentDiskGuard — 路径守卫。
 * 判断一个写入路径是否落在受保护盘/受保护目录下，并计算重定向目标。
 * 关键细节：若受保护目录已被迁移为 Junction（指向 D 盘），实际写入已经落在 D 盘，
 * 必须放行，否则会把用户锁死在已迁移的目录上。
 */
import * as fs from "fs";
import * as path from "path";
import { driveLetter, driveOf, expandEnv, isDirWritable, isPathUnder, localizeUnc, normalizePath, realResolve, reparseTarget } from "./util";
import type { Policy, ProtectedPath } from "./policy";
import { detectHost } from "./host";

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

/**
 * 解析真正可写的重定向根。
 *
 * 沙箱与 AI 宿主常常只放行会话工作区，策略里写死的 `D:\AgentCache` 可能根本写不进去；
 * 那时「重定向」只是把一次失败挪成另一次失败，模型拿到的建议路径也是走不通的。
 *
 * 关键区别在于「谁去写」：
 *  - 采纳 updatedInput 的宿主由 hook 自己重写路径，所以按 hook 侧的可写性挑根；
 *  - 不采纳的宿主把路径原样交给**模型**，而模型的可写范围由宿主沙箱决定，与 hook 进程
 *    的可写范围根本不是一回事（实测 DSH 下 hook 进程写不了任何地方，模型却能写会话工作区）。
 *    这时按宿主契约取会话工作区内的根 —— 探测只会给出错误答案。
 * 探测不缓存：hook 是一次性进程，缓存反而更贵。
 */
export function resolveWritableRedirectRoot(policy: Policy): string {
  const declared = normalizePath(policy.redirectRoot);
  if (!policy.redirectRootFallback) return declared;
  // 会话工作区：hook 的 cwd 就是它（claude-code 桥接契约），宿主沙箱按定义放行这里
  const workspace = normalizePath(path.join(process.cwd(), ".agent-cache"));
  if (!detectHost(policy).updatedInput) return workspace;
  return isDirWritable(declared) ? declared : workspace;
}

/** 把策略里的重定向根换成真正可写的位置；无变化时原样返回。 */
export function withWritableRedirectRoot(policy: Policy): Policy {
  const root = resolveWritableRedirectRoot(policy);
  return root === policy.redirectRoot ? policy : { ...policy, redirectRoot: root };
}
