/**
 * AgentDiskGuard — DeepSeek Harness 组合包（bundle）入口（Cordis 插件，ESM）。
 *
 * 职责：把官方桥接插件 `@deepseek-ai/dsh-hooks-claude-code` 挂载到 DSH，
 * 指向本包自带的 Claude Code 风格 hooks 配置（hooks/hooks.json），让
 * PreToolUse / SessionStart 等拦截在 DSH 上生效。
 *
 * 路径基于 import.meta.url 计算（安装位置无关）；用户可通过 Cordis 配置
 * 覆盖 configPath / pluginRoot / projectDir。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const name = 'agent-disk-guard'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ configPath?: string, pluginRoot?: string, projectDir?: string, defaultTimeoutMs?: number }} [config]
 */
export async function apply(ctx, config = {}) {
  let bridge
  try {
    bridge = await import('@deepseek-ai/dsh-hooks-claude-code')
  } catch (e) {
    const msg =
      '[agent-disk-guard] 未找到 @deepseek-ai/dsh-hooks-claude-code（DSH 桥接插件）。' +
      '组合包已加载但磁盘守卫不会拦截任何工具调用。' +
      `请在 profile 内执行: dsh plugin --profile <name> add github:luo173176/agent-disk-guard（会一并安装桥接依赖）。原因: ${e?.message ?? e}`
    // Cordis logger 服务名未在协议中固定，降级到控制台，保证不阻塞启动
    try {
      ctx?.logger?.('agent-disk-guard')?.warn?.(msg)
    } catch {
      console.warn(msg)
    }
    return
  }

  await ctx.plugin(bridge.default ?? bridge, {
    configPath: config.configPath ?? path.join(pkgRoot, 'hooks', 'hooks.json'),
    pluginRoot: config.pluginRoot ?? pkgRoot,
    ...(config.projectDir ? { projectDir: config.projectDir } : {}),
    ...(config.defaultTimeoutMs ? { defaultTimeoutMs: config.defaultTimeoutMs } : {}),
  })
}
