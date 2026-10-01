/**
 * 宿主能力降级测试。
 *
 * 不采纳 PreToolUse updatedInput 的宿主（DeepSeek Harness 的 claude-code 桥接）
 * 必须拿到「拒绝 + 理由里带改写后的完整命令」，否则命令被静默丢弃改写后照原样执行，
 * 缓存仍旧落 C 盘——插件看起来生效了，实际什么都没拦住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { defaultPolicy } from "../dist/policy.js";
import { evaluateToolCall } from "../dist/guard.js";
import { detectHost } from "../dist/host.js";
import { resolveWritableRedirectRoot, withWritableRedirectRoot } from "../dist/pathguard.js";

/**
 * 影响宿主探测的环境变量：DSH 自己的标记，加上 Electron 引导标记。
 * 后者是 hook 进程里唯一可见的 DSH 信号（实测：桥接收缩环境时剥掉了 DSH_*），
 * 所以必须一起清掉，否则「非 DSH 宿主」用例会在 Electron 宿主里误判。
 */
const HOST_KEYS = [
  "DSH_SESSION_ID",
  "DSH_HOME",
  "DSH_PROFILE_DIR",
  "DSH_SHELL",
  "ELECTRON_RUN_AS_NODE",
];

/** 在指定宿主环境下执行 fn，结束后恢复相关环境变量。 */
function withEnv(vars, fn) {
  const saved = HOST_KEYS.map((k) => [k, process.env[k]]);
  for (const k of HOST_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const policyWith = (over) => ({ ...defaultPolicy(), ...over });

/**
 * 绝不会被当成可写目录的路径：把**文件**当目录用（mkfile\x 必报 ENOTDIR/EINVAL）。
 * 比依赖权限判断稳定——换台机器、换种权限都不可能变成可写。
 */
const UNWRITABLE_ROOT = path.join(import.meta.filename, "adg-cache");

test("DSH 环境被识别为不采纳 updatedInput 的宿主", () => {
  withEnv({ DSH_SESSION_ID: "s1" }, () => {
    const host = detectHost();
    assert.equal(host.updatedInput, false);
    assert.equal(host.host, "deepseek-harness");
  });
});

test("无 DSH 标记的宿主按采纳 updatedInput 处理", () => {
  withEnv({}, () => {
    assert.equal(detectHost().updatedInput, true);
  });
});

test("只有 Electron 引导标记时也识别为 DSH（桥接剥掉 DSH_* 之后的实测形态）", () => {
  withEnv({ ELECTRON_RUN_AS_NODE: "1" }, () => {
    const host = detectHost();
    assert.equal(host.updatedInput, false);
    assert.equal(host.host, "deepseek-harness");
  });
});

test("策略可强制覆盖宿主能力探测", () => {
  withEnv({ DSH_SESSION_ID: "s1" }, () => {
    assert.equal(detectHost(policyWith({ hostCapabilities: "updatedInput" })).updatedInput, true);
  });
  withEnv({}, () => {
    assert.equal(detectHost(policyWith({ hostCapabilities: "noUpdatedInput" })).updatedInput, false);
  });
});

test("不采纳改写的宿主：npm install 被拒绝，理由里带可直接重试的改写命令", () => {
  const p = policyWith({ hostCapabilities: "noUpdatedInput", redirectRoot: "D:\\AgentCache" });
  const d = evaluateToolCall("pwsh", { command: "npm install lodash" }, p);
  assert.equal(d.action, "deny");
  assert.equal(d.updatedInput, undefined);
  assert.match(d.reason, /npm install lodash --cache "D:\\AgentCache\\npm-cache"/);
});

test("采纳改写的宿主：npm install 仍走 updatedInput（原有行为不回退）", () => {
  const p = policyWith({ hostCapabilities: "updatedInput", redirectRoot: "D:\\AgentCache" });
  const d = evaluateToolCall("pwsh", { command: "npm install lodash" }, p);
  assert.equal(d.action, "allow");
  assert.equal(d.updatedInput.command, 'npm install lodash --cache "D:\\AgentCache\\npm-cache"');
});

test("不采纳改写的宿主：写受保护目录降级为拒绝并给出目标路径", () => {
  const home = process.env.USERPROFILE || process.env.HOME;
  const target = path.join(home, "AppData", "Local", "npm-cache", "x.txt");
  const p = policyWith({ hostCapabilities: "noUpdatedInput", fileWriteMode: "redirect", redirectRoot: "D:\\AgentCache" });
  const d = evaluateToolCall("write", { file_path: target }, p);
  assert.equal(d.action, "deny");
  assert.equal(d.updatedInput, undefined);
  assert.match(d.reason, /把目标改为 D:\\AgentCache\\mirror\\/);
});

test("重定向根不可写时回退到会话工作区", () => {
  const p = policyWith({ redirectRoot: UNWRITABLE_ROOT });
  const eff = resolveWritableRedirectRoot(p);
  assert.notEqual(eff, UNWRITABLE_ROOT);
  assert.equal(eff, path.join(process.cwd(), ".agent-cache"));
  assert.equal(fs.existsSync(eff), true);
});

test("redirectRootFallback: false 时保持策略原值不做回退", () => {
  const p = policyWith({ redirectRoot: UNWRITABLE_ROOT, redirectRootFallback: false });
  assert.equal(resolveWritableRedirectRoot(p), UNWRITABLE_ROOT);
});

test("withWritableRedirectRoot 只在根不可写时才替换（可写的根原样返回）", () => {
  const broken = policyWith({ redirectRoot: UNWRITABLE_ROOT });
  assert.notEqual(withWritableRedirectRoot(broken).redirectRoot, broken.redirectRoot);
  const okRoot = path.join(process.cwd(), ".agent-cache");
  const ok = policyWith({ redirectRoot: okRoot });
  assert.equal(withWritableRedirectRoot(ok).redirectRoot, ok.redirectRoot);
});
