/**
 * 决策引擎单元测试（纯函数，自定义策略对象）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYamlSubset } from "../dist/policy.js";
import { evaluateToolCall } from "../dist/guard.js";
import { checkPath } from "../dist/pathguard.js";
import { rewriteCommand } from "../dist/rewriters.js";
import { classifyFree } from "../dist/monitor.js";

const BS = String.fromCharCode(92); // 避免 shell/源码转义歧义
const P = (...seg) => seg.join(BS);

/** 构造一个完全受控的测试策略。 */
function makePolicy(overrides = {}) {
  const base = {
    version: 1,
    protectedDrive: "C:",
    redirectRoot: P("D:", "AgentCache"),
    fileWriteMode: "redirect",
    commandMode: "rewrite",
    protectedPaths: [
      { raw: "temp", path: P("C:", "Users", "test", "AppData", "Local", "Temp"), redirect: "temp" },
      { raw: "npm-cache", path: P("C:", "Users", "test", "AppData", "Roaming", "npm-cache"), redirect: "npm-cache" },
      { raw: "windows", path: P("C:", "Windows"), mode: "deny" },
    ],
    whitelist: [P("C:", "Users", "test", "keep")],
    commandRules: [{ pattern: "\\bformat\\s+[cC]:", action: "deny", reason: "禁止格式化系统盘" }],
    monitor: { enabled: true, warnGB: 20, criticalGB: 10, sessionStartCheck: true },
    failOpen: true,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// 路径守卫
// ---------------------------------------------------------------------------

test("场景2：写入 C 盘 Temp 被重定向到 D 盘", () => {
  const policy = makePolicy();
  const target = P("C:", "Users", "test", "AppData", "Local", "Temp", "abc");
  const r = checkPath(target, policy);
  assert.equal(r.protected, true);
  assert.equal(r.redirectPath, P("D:", "AgentCache", "temp", "abc"));
});

test("非受保护盘放行", () => {
  const policy = makePolicy();
  assert.equal(checkPath(P("E:", "proj", "src", "a.ts"), policy).protected, false);
});

test("受保护盘上的项目目录默认放行", () => {
  const policy = makePolicy();
  assert.equal(checkPath(P("C:", "Users", "test", "proj", "src", "a.ts"), policy).protected, false);
});

test("白名单放行", () => {
  const policy = makePolicy();
  assert.equal(checkPath(P("C:", "Users", "test", "keep", "log.txt"), policy).protected, false);
});

test("C 盘根散文件拦截", () => {
  const policy = makePolicy();
  assert.equal(checkPath(P("C:", "junk.txt"), policy).protected, true);
});

test("正斜杠路径同样识别", () => {
  const policy = makePolicy();
  const r = checkPath("C:/Users/test/AppData/Local/Temp/abc", policy);
  assert.equal(r.protected, true);
});

// ---------------------------------------------------------------------------
// 决策引擎
// ---------------------------------------------------------------------------

test("fileWriteMode=redirect 时输出 updatedInput", () => {
  const policy = makePolicy();
  const d = evaluateToolCall("Write", { file_path: P("C:", "Users", "test", "AppData", "Local", "Temp", "abc"), content: "x" }, policy);
  assert.equal(d.action, "allow");
  assert.equal(d.updatedInput.file_path, P("D:", "AgentCache", "temp", "abc"));
  assert.equal(d.updatedInput.content, "x");
});

test("fileWriteMode=deny 时拒绝", () => {
  const policy = makePolicy({ fileWriteMode: "deny" });
  const d = evaluateToolCall("Write", { file_path: P("C:", "Users", "test", "AppData", "Local", "Temp", "abc") }, policy);
  assert.equal(d.action, "deny");
});

test("系统目录单条 mode=deny 覆盖全局 redirect", () => {
  const policy = makePolicy();
  const d = evaluateToolCall("Edit", { file_path: P("C:", "Windows", "system32", "hosts") }, policy);
  assert.equal(d.action, "deny");
});

test("fileWriteMode=ask 时询问", () => {
  const policy = makePolicy({ fileWriteMode: "ask" });
  const d = evaluateToolCall("Write", { file_path: P("C:", "Users", "test", "AppData", "Local", "Temp", "abc") }, policy);
  assert.equal(d.action, "ask");
});

test("fileWriteMode=off 时放行", () => {
  const policy = makePolicy({ fileWriteMode: "off" });
  const d = evaluateToolCall("Write", { file_path: P("C:", "Users", "test", "AppData", "Local", "Temp", "abc") }, policy);
  assert.equal(d.action, "allow");
});

test("NotebookEdit 检查 notebook_path", () => {
  const policy = makePolicy();
  const d = evaluateToolCall("NotebookEdit", { notebook_path: P("C:", "Users", "test", "AppData", "Local", "Temp", "n.ipynb") }, policy);
  assert.equal(d.action, "allow");
  assert.equal(d.updatedInput.notebook_path, P("D:", "AgentCache", "temp", "n.ipynb"));
});

// ---------------------------------------------------------------------------
// 命令改写
// ---------------------------------------------------------------------------

test("场景1：npm install 被注入 --cache 指向 D 盘", () => {
  // 用户已运行 install.ps1 时 npm test 会注入 npm_config_cache，需清掉才能测注入路径
  const saved = process.env.npm_config_cache;
  delete process.env.npm_config_cache;
  try {
    const policy = makePolicy();
    const d = evaluateToolCall("Bash", { command: "npm install lodash" }, policy);
    assert.equal(d.action, "allow");
    assert.equal(d.updatedInput.command, `npm install lodash --cache "${P("D:", "AgentCache", "npm-cache")}"`);
  } finally {
    if (saved !== undefined) process.env.npm_config_cache = saved;
  }
});

test("pip install 注入 --cache-dir（含多段命令）", () => {
  const policy = makePolicy();
  const d = evaluateToolCall("Bash", { command: "pip install requests && pip install flask" }, policy);
  assert.equal(d.updatedInput.command.includes(`--cache-dir "${P("D:", "AgentCache", "pip")}"`), true);
  assert.equal(d.updatedInput.command.match(/--cache-dir/g).length, 2);
});

test("环境变量已指向 D 盘时跳过注入", () => {
  process.env.npm_config_cache = P("D:", "AgentCache", "npm-cache");
  try {
    const policy = makePolicy();
    const rw = rewriteCommand("npm install lodash", policy);
    assert.equal(rw.changed, false);
  } finally {
    delete process.env.npm_config_cache;
  }
});

test("已有 --cache 参数时不重复注入", () => {
  const policy = makePolicy();
  const rw = rewriteCommand('npm install --cache "X:\\c" lodash', policy);
  assert.equal(rw.changed, false);
});

test("git clone 到受保护目录被改写", () => {
  const policy = makePolicy();
  const d = evaluateToolCall("Bash", { command: `git clone https://github.com/x/y ${P("C:", "Users", "test", "AppData", "Local", "Temp", "repos", "y")}` }, policy);
  assert.equal(d.action, "allow");
  assert.equal(d.updatedInput.command.includes(P("D:", "AgentCache", "temp", "repos", "y")), true);
});

test("git clone 到普通项目目录不改写", () => {
  const policy = makePolicy();
  const d = evaluateToolCall("Bash", { command: `git clone https://github.com/x/y ${P("C:", "Users", "test", "code", "y")}` }, policy);
  assert.equal(d.updatedInput, undefined);
});

test("commandRules：format C: 被拒绝", () => {
  const policy = makePolicy();
  const d = evaluateToolCall("Bash", { command: "format C: /q" }, policy);
  assert.equal(d.action, "deny");
  assert.equal(d.reason.includes("禁止格式化系统盘"), true);
});

test("commandMode=deny 时改写候选变为拒绝", () => {
  const policy = makePolicy({ commandMode: "deny" });
  const d = evaluateToolCall("Bash", { command: "npm install lodash" }, policy);
  assert.equal(d.action, "deny");
});

test("commandMode=off 时放行", () => {
  const policy = makePolicy({ commandMode: "off" });
  const d = evaluateToolCall("Bash", { command: "npm install lodash" }, policy);
  assert.equal(d.action, "allow");
  assert.equal(d.updatedInput, undefined);
});

test("未知工具不表态", () => {
  const policy = makePolicy();
  const d = evaluateToolCall("WebFetch", { url: "https://example.com" }, policy);
  assert.equal(d.action, "allow");
});

// ---------------------------------------------------------------------------
// 磁盘分级
// ---------------------------------------------------------------------------

test("场景3：剩余空间低于 10GB 判为 critical", () => {
  const policy = makePolicy();
  assert.equal(classifyFree(5 * 1024 ** 3, policy), "critical");
});

test("20GB 以下判为 warn，20GB 以上 ok", () => {
  const policy = makePolicy();
  assert.equal(classifyFree(15 * 1024 ** 3, policy), "warn");
  assert.equal(classifyFree(25 * 1024 ** 3, policy), "ok");
  assert.equal(classifyFree(null, policy), "unknown");
});
