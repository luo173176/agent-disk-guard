/**
 * v0.3.6 回归测试：覆盖本次审计的五个修复点。
 *  P0-1 命令通道的受保护路径字面量写保护（重定向 / 写 cmdlet，正向+反例）
 *  P0-2 路径判定与宿主平台解耦（path.win32 语义，纯字符串）
 *  P1-3 npm 子命令识别（只认第一个非选项 token）
 *  P1-4 策略解析失败可被会话提示感知（lastPolicyError → 会话提示告警行）
 * 全部断言均为纯字符串/纯函数，绝对路径统一用 C: 字面量，因此可在 Windows 与 Linux 上同样通过。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateToolCall } from "../dist/guard.js";
import { rewriteCommand, findProtectedWriteTargets } from "../dist/rewriters.js";
import { checkPath } from "../dist/pathguard.js";
import { isWinAbsolutePath } from "../dist/util.js";
import { buildSessionNotice } from "../dist/notice.js";

const BS = String.fromCharCode(92);
const P = (...seg) => seg.join(BS);

// 清掉宿主注入的缓存变量，保证「注入」路径可被观察到（否则 envAlreadyRedirected 会跳过注入）
for (const k of ["npm_config_cache", "PIP_CACHE_DIR", "YARN_CACHE_FOLDER", "UV_CACHE_DIR"]) delete process.env[k];

const TEMP = P("C:", "Users", "test", "AppData", "Local", "Temp");

function makePolicy(overrides = {}) {
  const base = {
    version: 1,
    protectedDrive: "C:",
    redirectRoot: P("D:", "AgentCache"),
    fileWriteMode: "redirect",
    commandMode: "rewrite",
    protectedPaths: [
      { raw: "temp", path: TEMP, redirect: "temp" },
      { raw: "npm-cache", path: P("C:", "Users", "test", "AppData", "Roaming", "npm-cache"), redirect: "npm-cache" },
      { raw: "windows", path: P("C:", "Windows"), mode: "deny" },
    ],
    whitelist: [P("C:", "Users", "test", "keep")],
    commandRules: [],
    monitor: { enabled: false, warnGB: 20, criticalGB: 10, sessionStartCheck: false },
    hostCapabilities: "updatedInput",
    redirectRootFallback: true,
    failOpen: true,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// P0-1 命令通道写保护
// ---------------------------------------------------------------------------

test("P0-1 重定向写入 C 盘受保护目录 → 拒绝并给建议路径", () => {
  const d = evaluateToolCall("Bash", { command: `echo hi > ${TEMP}${BS}x.txt` }, makePolicy());
  assert.equal(d.action, "deny");
  assert.match(d.reason, /受保护位置/);
  assert.match(d.reason, /D:\\AgentCache\\temp\\x\.txt/);
});

test("P0-1 正斜杠形式的受保护路径同样识别", () => {
  const d = evaluateToolCall("Bash", { command: "echo hi > C:/Users/test/AppData/Local/Temp/x.txt" }, makePolicy());
  assert.equal(d.action, "deny");
  assert.match(d.reason, /D:\\AgentCache\\temp\\x\.txt/);
});

test("P0-1 引号包裹的受保护路径同样识别", () => {
  const d = evaluateToolCall("Bash", { command: `echo hi > "${TEMP}${BS}x.txt"` }, makePolicy());
  assert.equal(d.action, "deny");
  assert.match(d.reason, /受保护位置/);
});

test("P0-1 Out-File 写入受保护目录 → 拒绝", () => {
  const d = evaluateToolCall("pwsh", { command: `Out-File ${TEMP}${BS}x.txt` }, makePolicy());
  assert.equal(d.action, "deny");
  assert.match(d.reason, /受保护位置/);
});

test("P0-1 Copy-Item 目标落在受保护目录 → 拒绝（源在别处不算）", () => {
  const d = evaluateToolCall("Bash", { command: `Copy-Item ${P("C:", "src", "a.txt")} ${TEMP}${BS}b.txt` }, makePolicy());
  assert.equal(d.action, "deny");
  assert.match(d.reason, /D:\\AgentCache\\temp\\b\.txt/);
});

test("P0-1 Set-Content 写系统目录（deny）→ 拒绝", () => {
  const d = evaluateToolCall("pwsh", { command: `Set-Content -Path ${P("C:", "Windows", "x.txt")} -Value hi` }, makePolicy());
  assert.equal(d.action, "deny");
  assert.match(d.reason, /受保护位置/);
});

test("P0-1 tee 写入受保护目录 → 拒绝", () => {
  const d = evaluateToolCall("Bash", { command: `Write-Output hi | tee ${TEMP}${BS}x.log` }, makePolicy());
  assert.equal(d.action, "deny");
});

test("P0-1 读命令 Get-Content 受保护路径不误判（必须放行）", () => {
  const d = evaluateToolCall("pwsh", { command: `Get-Content ${TEMP}${BS}x.txt` }, makePolicy());
  assert.equal(d.action, "allow");
  assert.equal(d.updatedInput, undefined);
});

test("P0-1 commandMode=deny → 拒绝；commandMode=ask → 询问", () => {
  assert.equal(evaluateToolCall("Bash", { command: `echo hi > ${TEMP}${BS}x.txt` }, makePolicy({ commandMode: "deny" })).action, "deny");
  assert.equal(evaluateToolCall("Bash", { command: `echo hi > ${TEMP}${BS}x.txt` }, makePolicy({ commandMode: "ask" })).action, "ask");
});

test("P0-1 findProtectedWriteTargets 只返回受保护的写目标", () => {
  const hits = findProtectedWriteTargets(`Copy-Item ${P("D:", "safe", "a.txt")} ${TEMP}${BS}b.txt`, makePolicy());
  assert.equal(hits.length, 1);
  assert.equal(hits[0].raw, `${TEMP}${BS}b.txt`);
});

// ---------------------------------------------------------------------------
// P0-2 路径判定平台无关（path.win32）
// ---------------------------------------------------------------------------

test("P0-2 checkPath 对 C: 盘绝对路径做纯字符串判定（与宿主平台无关）", () => {
  const p = makePolicy();
  assert.equal(checkPath(P("C:", "Windows", "x.txt"), p).protected, true);
  assert.equal(checkPath("C:/Users/test/AppData/Local/Temp/a", p).protected, true);
  assert.equal(checkPath(P("D:", "x.txt"), p).protected, false);
});

test("P0-2 isWinAbsolutePath 识别盘符绝对 / UNC / 根相对，拒绝相对路径", () => {
  assert.equal(isWinAbsolutePath(P("C:", "x")), true);
  assert.equal(isWinAbsolutePath("C:/x"), true);
  assert.equal(isWinAbsolutePath("\\\\srv\\share"), true);
  assert.equal(isWinAbsolutePath("/posix/abs"), true);
  assert.equal(isWinAbsolutePath("relative\\x"), false);
  assert.equal(isWinAbsolutePath("C:foo"), false);
});

// ---------------------------------------------------------------------------
// P1-3 npm 子命令识别
// ---------------------------------------------------------------------------

test("P1-3 npm run install 不注入 --cache", () => {
  assert.equal(rewriteCommand("npm run install", makePolicy()).changed, false);
});

test("P1-3 npm run build 不注入 --cache", () => {
  assert.equal(rewriteCommand("npm run build", makePolicy()).changed, false);
});

test("P1-3 npm --prefix ./app install 仍注入 --cache（跳过选项取值）", () => {
  const r = rewriteCommand("npm --prefix ./app install", makePolicy());
  assert.equal(r.changed, true);
  assert.match(r.command, /--cache/);
});

test("P1-3 npm install 仍注入 --cache", () => {
  const r = rewriteCommand("npm install lodash", makePolicy());
  assert.equal(r.changed, true);
  assert.match(r.command, /--cache/);
});

// ---------------------------------------------------------------------------
// P1-4 策略解析失败可见
// ---------------------------------------------------------------------------

function withPolicyEnv(file, fn) {
  const savedFile = process.env.AGENTDISKGUARD_POLICY;
  const savedData = process.env.AGENTDISKGUARD_DATA_DIR;
  process.env.AGENTDISKGUARD_POLICY = file;
  process.env.AGENTDISKGUARD_DATA_DIR = path.dirname(file);
  try {
    return fn();
  } finally {
    if (savedFile === undefined) delete process.env.AGENTDISKGUARD_POLICY;
    else process.env.AGENTDISKGUARD_POLICY = savedFile;
    if (savedData === undefined) delete process.env.AGENTDISKGUARD_DATA_DIR;
    else process.env.AGENTDISKGUARD_DATA_DIR = savedData;
  }
}

test("P1-4 策略解析失败 → 会话提示含「已回退默认策略」+ 文件路径", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adg-v036-"));
  const bad = path.join(dir, "policy.yaml");
  // Tab 缩进会让 YAML 子集解析器抛错（"a: [unclosed" 其实能当普通字符串解析，不触发失败）
  fs.writeFileSync(bad, "a:\n\tb: 1", "utf8");
  try {
    const lines = withPolicyEnv(bad, () => buildSessionNotice({ source: "startup" }));
    const text = lines.join("\n");
    assert.match(text, /已回退默认策略/);
    assert.ok(text.includes(bad), `告警应包含策略文件路径: ${bad}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("P1-4 策略正常 → 会话提示不含回退告警", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adg-v036-"));
  const good = path.join(dir, "policy.yaml");
  fs.writeFileSync(good, "monitor:\n  enabled: false\n  sessionStartCheck: false\n", "utf8");
  try {
    const lines = withPolicyEnv(good, () => buildSessionNotice({ source: "startup" }));
    assert.equal(lines.join("\n").includes("已回退默认策略"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
