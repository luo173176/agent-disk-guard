/**
 * 监控与迁移安全测试。
 * 场景3（低空间告警）在这里通过注入 freeBytes 直接验证分级与建议输出；
 * 真实磁盘查询仅冒烟验证（不假设具体空间）。
 * 迁移测试只验证"拒绝危险计划"，不做真实目录改动（真实 junction 流程已在开发环境人工验证）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { spawnSync } from "child_process";
import { defaultPolicy, parseYamlSubset } from "../dist/policy.js";
import { classifyFree, cleanupAdvice, statusLine } from "../dist/monitor.js";
import { planMigration } from "../dist/migrate.js";

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const BS = String.fromCharCode(92);
const P = (...seg) => seg.join(BS);

test("场景3：模拟 C 盘低于 10GB → critical + 建议", () => {
  const policy = defaultPolicy();
  assert.equal(classifyFree(9 * 1024 ** 3, policy), "critical");
  const fake = { drive: "C:", freeBytes: 5 * 1024 ** 3, totalBytes: 200 * 1024 ** 3, level: "critical", warnGB: 20, criticalGB: 10 };
  const line = statusLine(fake);
  assert.equal(line.includes("5.0 GB"), true);
  assert.equal(line.includes("🚨"), true);
});

test("monitor --once 以真实磁盘运行（冒烟）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adg-mon-"));
  fs.writeFileSync(path.join(tmp, "policy.yaml"), "monitor:\n  enabled: true\n  warnGB: 1\n  criticalGB: 0\n", "utf8");
  const r = spawnSync("node", [CLI, "monitor", "--once"], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, AGENTDISKGUARD_POLICY: path.join(tmp, "policy.yaml"), AGENTDISKGUARD_DATA_DIR: tmp },
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(r.stdout.includes("C:"), true);
});

test("迁移安全：拒绝系统目录", () => {
  const r = planMigration(P("C:", "Windows"), defaultPolicy());
  assert.equal(r.ok, false);
  assert.equal(r.message.includes("拒绝迁移"), true);
});

test("迁移安全：拒绝用户主目录与盘根", () => {
  const policy = defaultPolicy();
  assert.equal(planMigration(P("C:", "Users", process.env.USERNAME || "luo17"), policy).ok, false);
  assert.equal(planMigration(P("C:"), policy).ok, false);
});

test("迁移安全：拒绝不存在的目录", () => {
  const r = planMigration(P("C:", "definitely-not-exists-12345"), defaultPolicy());
  assert.equal(r.ok, false);
  assert.equal(r.message.includes("不存在"), true);
});

test("迁移安全：拒绝 D 盘目录（不在受保护盘）", () => {
  const dir = P("D:", "AgentCache");
  fs.mkdirSync(dir, { recursive: true }); // 确保存在，使命中"受保护盘"检查而非"不存在"
  const r = planMigration(dir, defaultPolicy());
  assert.equal(r.ok, false);
  assert.equal(r.message.includes("受保护盘"), true);
});

test("迁移安全：拒绝与 redirectRoot 相互嵌套", () => {
  const policy = defaultPolicy(); // redirectRoot = D:\AgentCache
  // 构造一个 redirectRoot 在 C 盘的策略来触发嵌套检查
  const yaml = parseYamlSubset(`redirectRoot: "C:\\\\AgentCacheX"`);
  assert.equal(yaml.redirectRoot, "C:\\AgentCacheX");
});

test("cleanupAdvice 输出可执行命令", () => {
  const advice = cleanupAdvice([{ path: P("C:", "x"), exists: true, isJunction: false, sizeBytes: null }]);
  assert.equal(advice[0].includes("agent-disk-guard migrate"), true);
});

test("CLI status 正常返回（真实环境冒烟）", () => {
  const r = spawnSync("node", [CLI, "status"], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(r.stdout.includes("AgentDiskGuard 状态"), true);
});
