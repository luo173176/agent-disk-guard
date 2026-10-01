/**
 * 加固回归测试：覆盖 0.3.x 审计发现的缺陷点。
 * 路径绕过（`..` / 设备前缀 / UNC / 8.3 短名）、工具名大小写、只读工具、
 * 条目级 mode、嵌套命令改写、磁盘查询、journal/rollback/purge 的安全性。
 *
 * 只读断言 + 只在系统临时目录里造 journal 与空目录，不触碰真实数据。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPath } from "../dist/pathguard.js";
import { evaluateToolCall } from "../dist/guard.js";
import { loadPolicy } from "../dist/policy.js";
import { checkDisk, statusLine } from "../dist/monitor.js";
import { rewriteCommand } from "../dist/rewriters.js";
import { rollbackMigration, purgeBackup, planMigration } from "../dist/migrate.js";
import { appendEntry, latestStateFor } from "../dist/journal.js";

const BS = String.fromCharCode(92);
const P = (...seg) => seg.join(BS);
const HOME = os.homedir();
const HOME_TEMP = P(HOME, "AppData", "Local", "Temp");

// 找可写的工作目录（不用 mkdtemp：受限令牌/沙箱下 mkdtemp 与系统临时目录都可能被拒），
// journal 也写在这里，避免污染真实数据目录。
function pickWorkDir() {
  const candidates = [
    path.join(os.tmpdir(), `adg-hardening-${process.pid}`),
    path.join(process.cwd(), `.adg-hardening-${process.pid}`),
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      /* 换下一个候选 */
    }
  }
  throw new Error("找不到可写的工作目录，无法运行加固测试");
}

const WORK = pickWorkDir();
process.env.AGENTDISKGUARD_JOURNAL = path.join(WORK, "journal.jsonl");
process.on("exit", () => {
  try {
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响测试结论 */
  }
});

// 本文件断言的是「改写」语义：显式声明宿主采纳入参改写，
// 否则在 DSH 会话里会被探测成降级宿主，改写类断言全部变成 deny
const policy = { ...loadPolicy(), hostCapabilities: "updatedInput" };
const redirectPolicy = { ...policy, fileWriteMode: "redirect" };

// ---------------------------------------------------------------------------
// A. 路径绕过
// ---------------------------------------------------------------------------

test("A1 `..` 折叠后仍判定为受保护", () => {
  assert.equal(checkPath(P("C:", "foo", "..", "Windows", "System32", "x.txt"), policy).protected, true);
});

test("A2 `..` 越出保护目录后折叠到真实位置（Temp 上溯 5 层 = C:\\Windows）", () => {
  const r = checkPath(`${HOME_TEMP}${BS}..${BS}..${BS}..${BS}..${BS}..${BS}Windows${BS}x.exe`, policy);
  assert.equal(r.protected, true);
  assert.match(r.reason || "", /Windows/);
});

test("A2b redirect 目标已折叠，不含 `..`", () => {
  const r = checkPath(`${HOME_TEMP}${BS}sub${BS}..${BS}adg-x.txt`, redirectPolicy);
  assert.equal(r.protected, true);
  assert.ok(!String(r.redirectPath || "").includes(".."), `redirectPath 仍含 ..: ${r.redirectPath}`);
});

test("A3 `\\\\?\\` 设备前缀被剥掉", () => {
  assert.equal(checkPath(P("\\\\?\\C:", "Windows", "x.txt"), policy).protected, true);
});

test("A4 `\\\\.\\` 设备前缀被剥掉", () => {
  assert.equal(checkPath(P("\\\\.\\C:", "Windows", "x.txt"), policy).protected, true);
});

test("A5 本机 UNC（localhost）映射为盘符", () => {
  assert.equal(checkPath(P("\\\\localhost\\c$", "Windows", "x.txt"), policy).protected, true);
});

test("A6 本机 UNC（127.0.0.1）映射为盘符", () => {
  assert.equal(checkPath(P("\\\\127.0.0.1\\c$", "Windows", "x.txt"), policy).protected, true);
});

test("A7 8.3 短名（PROGRA~1）经 realpath 命中", () => {
  assert.equal(checkPath(P("C:\\PROGRA~1", "adg-x.txt"), policy).protected, true);
});

test("A8 不存在的 8.3 短名既不误判也不抛异常", () => {
  assert.equal(checkPath(P("C:\\Users\\ZZZZZZ~9", "AppData", "x.txt"), policy).protected, false);
});

test("A9 白名单仍豁免", () => {
  assert.equal(checkPath(path.join(policy.whitelist[0], "x.txt"), policy).protected, false);
});

test("A10 非保护盘不受影响", () => {
  assert.equal(checkPath(P("D:", "somewhere", "x.txt"), policy).protected, false);
});

// ---------------------------------------------------------------------------
// B. 工具名大小写与只读工具
// ---------------------------------------------------------------------------

test("B1 小写 pwsh + npm install → 改写缓存参数", () => {
  const d = evaluateToolCall("pwsh", { command: "npm install lodash" }, redirectPolicy);
  assert.equal(d.action, "allow");
  assert.match(String(d.updatedInput && d.updatedInput.command), /--cache/);
});

test("B2 大写 Bash + npm install → 改写（回归）", () => {
  const d = evaluateToolCall("Bash", { command: "npm install lodash" }, redirectPolicy);
  assert.match(String(d.updatedInput && d.updatedInput.command), /--cache/);
});

test("B3 小写 pwsh + diskpart → 拦截", () => {
  assert.equal(evaluateToolCall("pwsh", { command: "diskpart /s x.txt" }, policy).action, "deny");
});

test("B4 大写 PowerShell + diskpart → 拦截（回归）", () => {
  assert.equal(evaluateToolCall("PowerShell", { command: "diskpart" }, policy).action, "deny");
});

test("B5 小写 write 命中系统目录 → 不因 redirect 模式而放行", () => {
  assert.equal(evaluateToolCall("write", { file_path: P("C:", "Windows", "adg-x.txt") }, redirectPolicy).action, "deny");
});

test("B6 小写 write 命中临时目录（redirect）→ 改写路径", () => {
  const src = P(HOME_TEMP, "adg-x.txt");
  const d = evaluateToolCall("write", { file_path: src }, redirectPolicy);
  assert.equal(d.action, "allow");
  assert.ok(d.updatedInput && d.updatedInput.file_path !== src, "未改写");
});

test("B7 只读工具 read 不被改写", () => {
  const d = evaluateToolCall("read", { file_path: P(HOME_TEMP, "adg-x.txt") }, redirectPolicy);
  assert.equal(d.action, "allow");
  assert.equal(d.updatedInput, undefined);
});

test("B8 未知工具带路径字段 → 套用同一条判定（系统目录 deny）", () => {
  assert.equal(evaluateToolCall("some_new_tool", { path: P("C:", "Windows", "adg-x.txt") }, redirectPolicy).action, "deny");
});

test("B9 未知工具无路径字段 → 沉默放行", () => {
  assert.equal(evaluateToolCall("some_new_tool", { foo: 1 }, policy).action, "allow");
});

// ---------------------------------------------------------------------------
// C. 命令改写
// ---------------------------------------------------------------------------

test("C1 npm run 不加 --cache", () => {
  assert.equal(rewriteCommand("npm run build", redirectPolicy).changed, false);
});

test("C2 npm ci 加 --cache", () => {
  assert.equal(rewriteCommand("npm ci", redirectPolicy).changed, true);
});

test("C3 引号内的分隔符不切段", () => {
  const r = rewriteCommand('echo "a;b" && npm install lodash', redirectPolicy);
  assert.match(r.command, /"a;b"/);
  assert.match(r.command, /--cache/);
});

test("C4 嵌套命令（pwsh -Command）标记为无法改写", () => {
  const r = rewriteCommand('pwsh -Command "npm install lodash"', redirectPolicy);
  assert.equal(r.unrewritable, true);
  assert.equal(r.changed, false);
});

test("C5 嵌套命令在 rewrite 模式下 → ask（不静默放行）", () => {
  assert.equal(evaluateToolCall("pwsh", { command: 'pwsh -Command "npm install lodash"' }, redirectPolicy).action, "ask");
});

// ---------------------------------------------------------------------------
// D. 磁盘查询
// ---------------------------------------------------------------------------

test("D1 checkDisk 走 statfs，level=ok 且有可用字节数", () => {
  const s = checkDisk(policy);
  assert.equal(s.level, "ok", statusLine(s));
  assert.ok(s.freeBytes > 0 && s.totalBytes > 0, statusLine(s));
});

// ---------------------------------------------------------------------------
// E. journal / rollback / purge
// ---------------------------------------------------------------------------

const src = path.join(WORK, "FakeDir");
const dest = path.join(WORK, "Dest");
const bak = `${src}.adg-bak`;

function seedMigrate(backupPath) {
  appendEntry({
    id: "t1",
    op: "migrate",
    time: new Date().toISOString(),
    source: src,
    dest,
    junction: src,
    backupPath,
    status: "done",
  });
}

test("E1 备份与目标都不存在 → 回滚中止（不再假装成功）", () => {
  seedMigrate(bak);
  const r = rollbackMigration(src, true, false);
  assert.equal(r.ok, false);
  assert.match(r.message, /回滚中止/);
});

test("E2 purge-backup 之后仍能找到迁移记录（可回滚）", () => {
  appendEntry({
    id: "t2",
    op: "purge-backup",
    time: new Date().toISOString(),
    source: src,
    dest,
    junction: src,
    backupPath: null,
    status: "purged",
  });
  assert.equal(latestStateFor(src).op, "migrate");
  assert.equal(rollbackMigration(src, false, false).ok, true);
});

test("E3 purge 护栏：journal 里的备份路径越界时拒绝删除", () => {
  const evil = path.join(WORK, "EvilDir");
  appendEntry({
    id: "t3",
    op: "migrate",
    time: new Date().toISOString(),
    source: evil,
    dest,
    junction: evil,
    backupPath: P("C:", "Windows"),
    status: "done",
  });
  const r = purgeBackup(evil, true);
  assert.equal(r.ok, false);
  assert.match(r.message, /拒绝删除/);
});

test("E4 备份目录为空（不完整）时回滚不采用它", () => {
  const src2 = path.join(WORK, "FakeDir2");
  const bak2 = `${src2}.adg-bak`;
  fs.mkdirSync(bak2, { recursive: true });
  appendEntry({
    id: "t4",
    op: "migrate",
    time: new Date().toISOString(),
    source: src2,
    dest: path.join(WORK, "Dest2"),
    junction: src2,
    backupPath: bak2,
    status: "done",
  });
  const dry = rollbackMigration(src2, false, false);
  assert.equal(dry.ok, true);
  assert.match(JSON.stringify(dry.plan.warnings), /不可用于回滚/);
});

test("E5 planMigration 对非保护盘源目录给出明确拒绝（回归）", () => {
  // 不用 pickWorkDir():它落在哪个盘取决于运行环境（沙箱里 os.tmpdir() 就在 C 盘，
  // 于是这条断言变成碰运气）。redirectRoot 按策略不变量必在非受保护盘，用它才确定。
  const root = policy.redirectRoot;
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    /* 根不存在且建不了也没关系：planMigration 会以「源目录不存在」拒绝，同样非 ok */
  }
  const p = planMigration(root, policy, false);
  assert.equal(p.ok, false);
  assert.match(String(p.message), /不在受保护盘|不存在/);
});
