/**
 * 策略解析测试：YAML 子集解析器 + 策略物化。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYamlSubset } from "../dist/policy.js";

test("解析标量：字符串/数字/布尔/null", () => {
  const y = parseYamlSubset(`
name: "hello world"
num: 42
float: 3.5
flag: true
off: false
nothing: null
plain: bare-string
`);
  assert.equal(y.name, "hello world");
  assert.equal(y.num, 42);
  assert.equal(y.float, 3.5);
  assert.equal(y.flag, true);
  assert.equal(y.off, false);
  assert.equal(y.nothing, null);
  assert.equal(y.plain, "bare-string");
});

test("双引号字符串中的反斜杠转义（Windows 路径）", () => {
  const y = parseYamlSubset(`p: "D:\\\\AgentCache\\\\npm-cache"`);
  assert.equal(y.p, "D:\\AgentCache\\npm-cache");
});

test("注释剥离（含引号内的 #）", () => {
  const y = parseYamlSubset(`
a: 1 # 行内注释
b: "x # y" # 引号内 # 不算注释
# 整行注释
c: 3
`);
  assert.equal(y.a, 1);
  assert.equal(y.b, "x # y");
  assert.equal(y.c, 3);
});

test("嵌套映射与列表", () => {
  const y = parseYamlSubset(`
monitor:
  enabled: true
  warnGB: 20
list:
  - a
  - b
`);
  assert.equal(y.monitor.enabled, true);
  assert.equal(y.monitor.warnGB, 20);
  assert.deepEqual(y.list, ["a", "b"]);
});

test("列表项为映射（protectedPaths 形态）", () => {
  const y = parseYamlSubset(`
protectedPaths:
  - path: "C:\\\\Temp"
    redirect: "temp"
  - path: "C:\\\\Windows"
    mode: deny
`);
  assert.equal(y.protectedPaths.length, 2);
  assert.equal(y.protectedPaths[0].path, "C:\\Temp");
  assert.equal(y.protectedPaths[0].redirect, "temp");
  assert.equal(y.protectedPaths[1].mode, "deny");
});

test("流程列表与空列表", () => {
  const y = parseYamlSubset(`a: []\nb: [x, y]`);
  assert.deepEqual(y.a, []);
  assert.deepEqual(y.b, ["x", "y"]);
});

test("非法缩进报错", () => {
  assert.throws(() => parseYamlSubset("a:\n\tb: 1"));
});
