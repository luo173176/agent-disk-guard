/**
 * AgentDiskGuard — 策略（policy.yaml）加载与默认策略。
 * 自带一个 YAML 子集解析器（映射/列表/标量/注释/流程列表），运行时零 npm 依赖。
 *
 * 策略解析顺序（先到先用）：
 *   1. 环境变量 AGENTDISKGUARD_POLICY 指定的文件
 *   2. %USERPROFILE%\.agent-disk-guard\policy.yaml（install.ps1 生成，用户可编辑）
 *   3. 插件自带 config/policy.yaml（只读兜底）
 *   4. 内置默认值
 */
import * as fs from "fs";
import * as path from "path";
import { dataDir, expandEnv, homeDir, normalizePath } from "./util";
import { logWarn } from "./logger";

// ---------------------------------------------------------------------------
// YAML 子集解析器
// ---------------------------------------------------------------------------

interface Line {
  indent: number;
  text: string;
}

/** 去掉注释（引号外的 #）、空行；返回带缩进结构的行。 */
function preprocess(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let inS = false;
    let inD = false;
    let cut = -1;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "'" && !inD) inS = !inS;
      else if (ch === '"' && !inS) inD = !inD;
      else if (ch === "#" && !inS && !inD) {
        if (i === 0 || /\s/.test(raw[i - 1])) {
          cut = i;
          break;
        }
      }
    }
    const body = cut >= 0 ? raw.slice(0, cut) : raw;
    if (!body.trim()) continue;
    const indent = body.length - body.replace(/^ +/, "").length;
    if (body.includes("\t")) throw new Error("policy.yaml 不允许使用 Tab 缩进");
    out.push({ indent, text: body.trim() });
  }
  return out;
}

/** 解析标量：引号串/布尔/数字/流程列表/普通字符串。 */
function parseScalar(s: string): unknown {
  const t = s.trim();
  if (t === "") return "";
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).map((x) => parseScalar(x));
  }
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t
      .slice(1, -1)
      .replace(/\\\\/g, "\u0000")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\u0000/g, "\\");
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

/** 按顶层逗号切分（忽略引号与括号内的逗号）。 */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inS = false;
  let inD = false;
  let cur = "";
  for (const ch of s) {
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (!inS && !inD) {
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
    }
    if (ch === "," && !inS && !inD && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((x) => x.trim());
}

/** 递归解析从第 i 行开始、缩进为 indent 的块。返回 [value, 下一行索引]。 */
function parseBlock(lines: Line[], i: number, indent: number): [unknown, number] {
  if (i >= lines.length || lines[i].indent < indent) return [null, i];

  // 列表块：以 "- " 开头
  if (lines[i].text.startsWith("- ") || lines[i].text === "-") {
    const arr: unknown[] = [];
    while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith("- ") || lines[i].text === "-")) {
      const rest = lines[i].text === "-" ? "" : lines[i].text.slice(2).trim();
      i++;
      if (rest === "") {
        const [v, ni] = parseBlock(lines, i, indent + 1);
        arr.push(v);
        i = ni;
      } else if (/^[^:#]+:(\s|$)/.test(rest)) {
        // 列表项是映射：首键在这一行，剩余键在更深层
        const itemIndent = indent + 2; // 虚拟缩进
        const virtual: Line[] = [{ indent: itemIndent, text: rest }];
        let j = i;
        while (j < lines.length && lines[j].indent > indent) {
          virtual.push({ indent: itemIndent + (lines[j].indent - (indent + 2)), text: lines[j].text });
          j++;
        }
        const [v] = parseBlock(virtual, 0, itemIndent);
        arr.push(v);
        i = j;
      } else {
        arr.push(parseScalar(rest));
      }
    }
    return [arr, i];
  }

  // 映射块
  const map: Record<string, unknown> = {};
  while (i < lines.length && lines[i].indent === indent) {
    const m = lines[i].text.match(/^([^:]+):(.*)$/);
    if (!m) throw new Error(`policy.yaml 无法解析的行: "${lines[i].text}"`);
    const key = m[1].trim().replace(/^["']|["']$/g, "");
    const rest = m[2].trim();
    i++;
    if (rest === "") {
      // 嵌套块（子缩进更深），否则视为 null
      if (i < lines.length && lines[i].indent > indent) {
        const [v, ni] = parseBlock(lines, i, lines[i].indent);
        map[key] = v;
        i = ni;
      } else {
        map[key] = null;
      }
    } else {
      map[key] = parseScalar(rest);
    }
  }
  return [map, i];
}

/** 解析 YAML 子集文本为 JS 值；失败抛错。 */
export function parseYamlSubset(text: string): unknown {
  const lines = preprocess(text);
  if (lines.length === 0) return {};
  const [value, next] = parseBlock(lines, 0, lines[0].indent);
  if (next < lines.length) throw new Error(`policy.yaml 存在多余或缩进不一致的行: "${lines[next].text}"`);
  return value;
}

// ---------------------------------------------------------------------------
// 策略模型
// ---------------------------------------------------------------------------

export interface ProtectedPath {
  /** 原始（未展开）写法，用于显示 */
  raw: string;
  /** 展开并规范化后的绝对路径 */
  path: string;
  /** 迁移到 redirectRoot 下的子目录名；未指定时用镜像模式 */
  redirect?: string;
  /** 覆盖全局 fileWriteMode 的单条模式（系统目录应为 deny） */
  mode?: "deny" | "ask" | "redirect";
}

export interface CommandRule {
  pattern: string;
  action: "deny" | "ask" | "allow";
  reason?: string;
}

export interface MonitorConfig {
  enabled: boolean;
  warnGB: number;
  criticalGB: number;
  /** SessionStart 时做一次空间检查，低于阈值注入 additionalContext */
  sessionStartCheck: boolean;
}

export interface Policy {
  version: number;
  /** 受保护盘符，如 "C:" */
  protectedDrive: string;
  redirectRoot: string;
  /** 对写文件操作的处理：redirect=改写到 D 盘 | deny=拒绝 | ask=询问 | off=不检查 */
  fileWriteMode: "redirect" | "deny" | "ask" | "off";
  /** 对命令的处理：rewrite=注入缓存参数 | deny=拒绝 | ask=询问 | off=不检查 */
  commandMode: "rewrite" | "deny" | "ask" | "off";
  protectedPaths: ProtectedPath[];
  whitelist: string[];
  commandRules: CommandRule[];
  monitor: MonitorConfig;
  /** hook 出错时是否放行（fail-open）。建议保持 true，避免拖死 Agent */
  failOpen: boolean;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function str(v: unknown, dflt: string): string {
  return typeof v === "string" ? v : dflt;
}

/** 把解析出的原始对象加工为强类型 Policy（展开环境变量、规范化路径）。 */
function materialize(raw: Record<string, unknown>): Policy {
  const drive = str(raw.protectedDrive, "C:").replace(/[:\\]+$/, "").toUpperCase();
  const redirectRoot = normalizePath(expandEnv(str(raw.redirectRoot, "D:\\AgentCache")));
  const protectedPaths: ProtectedPath[] = asArray<Record<string, unknown>>(raw.protectedPaths).map((p) => {
    const rawPath = str(p.path, "");
    const redirect = typeof p.redirect === "string" && p.redirect.trim() ? p.redirect.trim() : undefined;
    const mode = p.mode === "deny" || p.mode === "ask" || p.mode === "redirect" ? p.mode : undefined;
    return { raw: rawPath, path: normalizePath(expandEnv(rawPath)), redirect, mode };
  });
  const whitelist = asArray<unknown>(raw.whitelist)
    .map((w) => (typeof w === "string" ? w : String(w)))
    .filter((w) => w.trim() !== "")
    .map((w) => normalizePath(expandEnv(w)));
  const commandRules: CommandRule[] = asArray<Record<string, unknown>>(raw.commandRules)
    .filter((r) => typeof r.pattern === "string" && r.pattern)
    .map((r) => ({
      pattern: r.pattern as string,
      action: (r.action === "deny" || r.action === "allow" || r.action === "ask" ? r.action : "deny") as CommandRule["action"],
      reason: typeof r.reason === "string" ? r.reason : undefined,
    }));
  const mon = (raw.monitor && typeof raw.monitor === "object" ? raw.monitor : {}) as Record<string, unknown>;
  const monitor: MonitorConfig = {
    enabled: mon.enabled !== false,
    warnGB: typeof mon.warnGB === "number" ? mon.warnGB : 20,
    criticalGB: typeof mon.criticalGB === "number" ? mon.criticalGB : 10,
    sessionStartCheck: mon.sessionStartCheck !== false,
  };
  return {
    version: typeof raw.version === "number" ? raw.version : 1,
    protectedDrive: drive,
    redirectRoot,
    fileWriteMode: (["redirect", "deny", "ask", "off"].includes(str(raw.fileWriteMode, "redirect"))
      ? str(raw.fileWriteMode, "redirect")
      : "redirect") as Policy["fileWriteMode"],
    commandMode: (["rewrite", "deny", "ask", "off"].includes(str(raw.commandMode, "rewrite"))
      ? str(raw.commandMode, "rewrite")
      : "rewrite") as Policy["commandMode"],
    protectedPaths,
    whitelist,
    commandRules,
    monitor,
    failOpen: raw.failOpen !== false,
  };
}

export function defaultPolicyObject(): Record<string, unknown> {
  const home = homeDir();
  const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  return {
    version: 1,
    protectedDrive: "C:",
    redirectRoot: "D:\\AgentCache",
    fileWriteMode: "redirect",
    commandMode: "rewrite",
    protectedPaths: [
      { path: `${local}\\Temp` },
      { path: `${local}\\npm-cache` },
      { path: `${roaming}\\npm-cache` },
      { path: `${home}\\.npm` },
      { path: `${home}\\.cache`, redirect: "xdg-cache" },
      { path: `${local}\\pip\\Cache`, redirect: "pip" },
      { path: `${home}\\.cargo`, redirect: "cargo" },
      { path: `${home}\\.gradle`, redirect: "gradle" },
      { path: `${home}\\.m2`, redirect: "m2" },
      { path: `${home}\\.docker`, redirect: "docker" },
      { path: `${home}\\.codex`, redirect: "codex" },
      { path: `${home}\\.ollama`, redirect: "ollama" },
      { path: `${home}\\.conda`, redirect: "conda" },
      { path: `${home}\\.nuget`, redirect: "nuget" },
      { path: `${home}\\.rustup`, redirect: "rustup" },
      { path: `${home}\\node_modules`, redirect: "node_modules" },
      { path: `${home}\\.huggingface`, redirect: "huggingface" },
      // 系统目录：无论全局模式如何，一律拒绝写入
      { path: "C:\\Windows", mode: "deny" },
      { path: "C:\\Program Files", mode: "deny" },
      { path: "C:\\Program Files (x86)", mode: "deny" },
      { path: "C:\\ProgramData", mode: "deny" },
    ],
    whitelist: [`${home}\\.agent-disk-guard`],
    commandRules: [
      { pattern: "\\bformat\\s+[cC]:", action: "deny", reason: "禁止格式化系统盘" },
      { pattern: "\\b(rd|rmdir|del|erase|Remove-Item)\\b[^&|;]{0,120}\\s+C:\\\\Windows\\b", action: "deny", reason: "禁止删除 C:\\Windows 内容" },
    ],
    monitor: { enabled: true, warnGB: 20, criticalGB: 10, sessionStartCheck: true },
    failOpen: true,
  };
}

export function defaultPolicy(): Policy {
  return materialize(defaultPolicyObject());
}

/** 按解析顺序找到策略文件路径（供 CLI 显示）。 */
export function resolvePolicyFilePath(): string | null {
  const candidates = [
    process.env.AGENTDISKGUARD_POLICY,
    path.join(dataDir(), "policy.yaml"),
    path.join(__dirname, "..", "config", "policy.yaml"),
  ].filter((x): x is string => !!x);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/**
 * 加载策略：用户/环境变量指定的文件 > 插件自带默认。
 * 解析失败时告警并回退内置默认（fail-open，不阻断 Agent）。
 */
export function loadPolicy(): Policy {
  const file = resolvePolicyFilePath();
  if (file) {
    try {
      const parsed = parseYamlSubset(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") {
        return materialize({ ...defaultPolicyObject(), ...(parsed as Record<string, unknown>) });
      }
    } catch (e) {
      logWarn(`policy 解析失败，使用内置默认策略: ${file}`, { error: String(e) });
    }
  }
  return defaultPolicy();
}
