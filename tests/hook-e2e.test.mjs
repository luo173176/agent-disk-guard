/**
 * Hook 端到端测试：以子进程运行 dist/hook.js，喂入各 Agent 风格的 stdin 载荷。
 * 用户验收场景 1/2 在此覆盖；场景 3（低空间告警）见 monitor 部分。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { parseYamlSubset } from "../dist/policy.js";

const HOOK = path.join(__dirname, "..", "dist", "hook.js");
const BS = String.fromCharCode(92);
const P = (...seg) => seg.join(BS);

/** 测试专用策略：把用户文档中的 C:\Users\test 视为受保护用户目录。 */
function writeTestPolicy(dir) {
  const yaml = [
    'version: 1',
    'protectedDrive: "C:"',
    'redirectRoot: "D:\\\\AgentCache"',
    "fileWriteMode: redirect",
    "commandMode: rewrite",
    "failOpen: true",
    // 子进程会继承 DSH_* 环境变量：显式声明宿主支持入参改写，并关掉重定向根回退，
    // 否则断言测到的是「宿主降级」而不是「改写」（D:\AgentCache 在沙箱里不可写）
    'hostCapabilities: "updatedInput"',
    "redirectRootFallback: false",
    "protectedPaths:",
    '  - path: "C:\\\\Users\\\\test\\\\AppData\\\\Local\\\\Temp"',
    '    redirect: "temp"',
    '  - path: "C:\\\\Users\\\\test\\\\AppData\\\\Roaming\\\\npm-cache"',
    '    redirect: "npm-cache"',
    "whitelist: []",
    "commandRules: []",
    "monitor:",
    "  enabled: false",
  ].join("\n");
  const file = path.join(dir, "policy.yaml");
  fs.writeFileSync(file, yaml, "utf8");
  return file;
}

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "adg-test-"));
const policyFile = writeTestPolicy(tmpData);
const env = {
  ...process.env,
  AGENTDISKGUARD_POLICY: policyFile,
  AGENTDISKGUARD_DATA_DIR: tmpData,
  AGENTDISKGUARD_JOURNAL: path.join(tmpData, "journal.jsonl"),
};
delete env.npm_config_cache; // 用户初始化后 npm test 会注入该变量，清掉以测注入路径

function runHook(payload, stdin = JSON.stringify(payload)) {
  const r = spawnSync("node", [HOOK], { input: stdin, encoding: "utf8", timeout: 20000, env });
  assert.equal(r.status, 0, `hook 退出码应为 0，stderr: ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

test("场景1：npm install 被重定向到 D:\\AgentCache\\npm-cache", () => {
  const out = runHook({ tool_name: "Bash", tool_input: { command: "npm install lodash" } });
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(out.hookSpecificOutput.updatedInput.command, `npm install lodash --cache "D:${BS}AgentCache${BS}npm-cache"`);
});

test("场景2：写入 C:\\Users\\test\\...\\Temp\\abc 被重写", () => {
  const out = runHook({ tool_name: "Write", tool_input: { file_path: P("C:", "Users", "test", "AppData", "Local", "Temp", "abc"), content: "data" } });
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(out.hookSpecificOutput.updatedInput.file_path, P("D:", "AgentCache", "temp", "abc"));
  assert.equal(out.hookSpecificOutput.updatedInput.content, "data");
});

test("camelCase 载荷（toolName/toolInput）同样支持", () => {
  const out = runHook({ toolName: "Bash", toolInput: { command: "pip install requests" } });
  assert.equal(out.hookSpecificOutput.updatedInput.command.includes("--cache-dir"), true);
});

test("OpenCode 风格 {tool, input} 载荷支持", () => {
  const out = runHook({ tool: "Bash", input: { command: "yarn add left-pad" } });
  assert.equal(out.hookSpecificOutput.updatedInput.command.includes("--cache-folder"), true);
});

test("非法 stdin 不表态、退出码 0（fail-open）", () => {
  const r = spawnSync("node", [HOOK], { input: "not-json", encoding: "utf8", timeout: 20000, env });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("空 stdin 不表态", () => {
  const r = spawnSync("node", [HOOK], { input: "", encoding: "utf8", timeout: 20000, env });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("策略解析失败时回退内置默认（fail-open 不抛错）", () => {
  const badFile = path.join(tmpData, "bad.yaml");
  fs.writeFileSync(badFile, "a: [unclosed", "utf8");
  const e2 = { ...env, AGENTDISKGUARD_POLICY: badFile };
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm install x" } }),
    encoding: "utf8",
    timeout: 20000,
    env: e2,
  });
  assert.equal(r.status, 0);
  // 回退内置默认策略后 npm 仍被拦截：采纳改写的宿主给出 updatedInput，
  // 不采纳改写的宿主（如 DSH）给出带改写命令的 deny —— 两种形态理由里都带 --cache
  assert.match(r.stdout, /--cache/);
});

test("parseYamlSubset 与策略文件一致（冒烟）", () => {
  const parsed = parseYamlSubset(fs.readFileSync(policyFile, "utf8"));
  assert.equal(parsed.protectedDrive, "C:");
});
