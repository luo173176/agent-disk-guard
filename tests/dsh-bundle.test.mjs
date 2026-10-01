/**
 * DSH 组合包的会话启动注入。
 *
 * 用一对假 ctx / 假 agent 驱动 apply()，断言：顶层 ctx 上确实注册了监听器、
 * 注入的是一条 user message、每个 agent 只注入一次、非 enter 的 pre-step 不被改动。
 * 这是「会话启动提示」这条通路在仓库内唯一可自动化的验证——真机验证要重启 DSH。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Windows 绝对路径必须转成 file:// URL，否则 ERR_UNSUPPORTED_ESM_URL_SCHEME
const bundle = await import(pathToFileURL(path.join(pkgRoot, 'dsh', 'index.mjs')).href);

function fakeCtx() {
  const listeners = new Map();
  return {
    listeners,
    warnings: [],
    on(name, fn) {
      listeners.set(name, fn);
      return () => listeners.delete(name);
    },
    async plugin() {},
    logger: () => ({ warn: () => {} }),
  };
}

function fakeAgent(id, injected) {
  return {
    id,
    inbox: { processing: true },
    inject: (message) => injected.push(message),
  };
}

async function setup() {
  const ctx = fakeCtx();
  await bundle.apply(ctx, {});
  assert.equal(typeof ctx.listeners.get('agent/created'), 'function', '顶层 ctx 应注册 agent/created');
  assert.equal(typeof ctx.listeners.get('agent/pre-step'), 'function', '顶层 ctx 应注册 agent/pre-step');
  return ctx;
}

test('组合包导出 apply，且注册了会话启动注入的两条通路', async () => {
  assert.equal(typeof bundle.apply, 'function');
  const ctx = await setup();
  assert.equal(ctx.listeners.size >= 2, true);
});

test('agent/created 注入一条 user message，内容含运行态提示', async () => {
  const ctx = await setup();
  const injected = [];
  ctx.listeners.get('agent/created')({ agent: fakeAgent('a1', injected) });

  assert.equal(injected.length, 1);
  const message = injected[0];
  assert.equal(message.role, 'user');
  assert.equal(typeof message.id, 'string');
  assert.equal(message.source.kind, 'agent-disk-guard');
  assert.equal(Array.isArray(message.content), true);
  assert.equal(message.content[0].type, 'text');
  assert.match(message.content[0].text, /AgentDiskGuard 运行态/);
  assert.match(message.content[0].text, /不采纳 hook 的入参改写/);
  assert.equal(Object.isFrozen(message), true, '消息应深冻结，与 dsh-llm 的 createMessage 同形');
});

test('同一个 agent 只注入一次', async () => {
  const ctx = await setup();
  const injected = [];
  const agent = fakeAgent('a1', injected);

  ctx.listeners.get('agent/created')({ agent });
  ctx.listeners.get('agent/created')({ agent });
  await ctx.listeners.get('agent/pre-step')({ agent }, async () => ({ kind: 'enter', messages: [] }));

  assert.equal(injected.length, 1);
});

test('agent/created 注入失败时交给 pre-step 补一次', async () => {
  const ctx = await setup();
  const injected = [];
  const agent = {
    id: 'a2',
    inbox: { processing: true },
    inject() {
      throw new Error('注入太早');
    },
  };

  ctx.listeners.get('agent/created')({ agent });
  assert.equal(injected.length, 0);

  // 换掉 inject 让 pre-step 这条路能成功
  agent.inject = (message) => injected.push(message);
  const downstream = { kind: 'enter', messages: [{ id: 'm0' }] };
  const result = await ctx.listeners.get('agent/pre-step')({ agent }, async () => downstream);

  assert.equal(injected.length, 0, 'pre-step 走的是 messages 追加，不调 inject');
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].id, 'm0', '原有消息必须保留且顺序不变');
  assert.match(result.messages[1].content[0].text, /AgentDiskGuard 运行态/);
  assert.equal(downstream.messages.length, 1, '不得改动下游对象');
});

test('pre-step 非 enter 时原样返回，不追加消息', async () => {
  const ctx = await setup();
  const downstream = { kind: 'deny', reason: 'x' };
  const result = await ctx.listeners.get('agent/pre-step')(
    { agent: fakeAgent('a3', []) },
    async () => downstream
  );
  assert.equal(result, downstream);
});
