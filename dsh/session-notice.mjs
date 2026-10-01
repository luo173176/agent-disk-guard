/**
 * AgentDiskGuard — DSH 会话内运行态注入。
 *
 * 为什么不走桥接的 SessionStart：组合包是用 ctx.plugin(bridge) 把桥接挂成*子* ctx 的，
 * 而 Cordis 的 ctx.on 只登记在调用者自己的 _hooks 上（cordis/lib/index.js:258-263 的
 * dispatch 只读 this._hooks），子 ctx 收不到 agent/created / agent/pre-step。
 * 实测四个会话的 hook 记录里 SessionStart 与 UserPromptSubmit 条数均为 0，PreToolUse 正常，
 * 与这个推断一致。所以这里用与 dsh-experimental-agent-team 同一层级的顶层 ctx 自己注册。
 *
 * 注入的消息手搓而不 import @deepseek-ai/dsh-llm：该包只存在于 DSH 自身的 app 目录，
 * 从 profile 里 require 会 MODULE_NOT_FOUND（实测）。构造形状与 dsh-llm/lib/types/message.js
 * 的 createMessage 一致：结构化克隆 + 深冻结 + 新 id。
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'

const MESSAGE_SOURCE = { kind: 'agent-disk-guard' }

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

function userMessage(text) {
  return deepFreeze(
    structuredClone({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: MESSAGE_SOURCE,
    })
  )
}

function warn(ctx, message) {
  try {
    ctx?.logger?.('agent-disk-guard')?.warn?.(message)
  } catch {
    console.warn(`[agent-disk-guard] ${message}`)
  }
}

/**
 * 在顶层 ctx 上注册会话启动注入；每个 Agent 只注入一次。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ pkgRoot: string }} options
 */
export function installSessionNotice(ctx, { pkgRoot }) {
  let buildSessionNotice
  try {
    // dsh/ 是 ESM，dist/ 是 CJS
    const dist = createRequire(import.meta.url)(path.join(pkgRoot, 'dist', 'notice.js'))
    buildSessionNotice = dist.buildSessionNotice
  } catch (e) {
    warn(ctx, `未加载 dist/notice.js，会话启动提示不可用：${e?.message ?? e}`)
    return
  }
  if (typeof buildSessionNotice !== 'function') {
    warn(ctx, 'dist/notice.js 未导出 buildSessionNotice，会话启动提示不可用')
    return
  }

  // 幂等按会话记账，不按 agent：同一会话里先后建出多个 agent（主 agent 与子 agent）时，
  // 按 agent 记账会让同一段提示在对话里出现两遍——实测就是这么冒出来的。
  // 集合挂在 globalThis 上：宿主重载 profile 插件会重新求值本模块，模块级变量会归零，
  // 只有跨重载共享同一份集合才不会再注入一次。
  const state = (globalThis[Symbol.for('agent-disk-guard.session-notice')] ??= { noticed: new Set() })
  const noticed = state.noticed
  const keyOf = (agent) => agent?.session?.id ?? agent?.id
  const take = (agent) => {
    const key = keyOf(agent)
    if (key === undefined || noticed.has(key)) return undefined
    const lines = buildSessionNotice({
      source: 'dsh-plugin',
      // 宿主进程的 cwd 是宿主自己的安装目录，不是会话工作区，只能从 agent 上取
      cwd: agent?.session?.header?.cwd,
      // detectHost 读的是 hook 子进程的环境；这里跑在 DSH 宿主进程内，直接按已知事实给答案
      host: { host: 'deepseek-harness', updatedInput: false },
    })
    noticed.add(key)
    return lines.length === 0 ? undefined : userMessage(lines.join('\n'))
  }

  ctx.on('agent/created', ({ agent }) => {
    const message = take(agent)
    if (message === undefined) return
    try {
      agent.inject(message)
    } catch (e) {
      noticed.delete(keyOf(agent)) // 交给 pre-step 再试一次
      warn(ctx, `会话启动提示注入失败：${e?.message ?? e}`)
    }
  })

  // 兜底通路：万一 agent/created 在更深的 ctx 上派发，pre-step 还能把消息顺进这一轮的输入。
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const downstream = await next()
    if (downstream?.kind !== 'enter') return downstream
    const message = take(agent)
    if (message === undefined) return downstream
    return { ...downstream, messages: [...downstream.messages, message] }
  })
}
