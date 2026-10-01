# AgentDiskGuard

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-blue.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](#)

**English**: AgentDiskGuard stops AI coding agents (Claude Code, ZCode, DeepSeek Harness, OpenCode, Cursor, ...) from filling up drive `C:` on Windows — a PreToolUse hook blocks/rewrites writes to protected paths, rewrites package-manager commands to use a redirect drive (`D:\AgentCache`), injects environment variables, migrates existing cache dirs with robocopy + junction, and alerts when free space runs low. Zero runtime dependencies.

防止 AI 编码 Agent（Claude Code / ZCode / DeepSeek Harness / OpenCode / Cursor 等）在跑项目时把 **Windows C 盘塞满**。

一条 PreToolUse Hook 拦下三类问题：

1. **写文件到 C 盘受保护路径**（Temp、npm/pip/cargo 缓存、系统目录……）→ 自动改写到 D 盘或拒绝；
2. **执行会产生 C 盘缓存的命令**（`npm install`、`pip install`、`yarn`、`git clone`、`mvn`……）→ 注入 `--cache`/`--cache-dir`/`-Dmaven.repo.local` 等参数；
3. **C 盘空间不足** → 会话启动时注入告警 + 可执行的迁移建议，另可注册 Windows 计划任务定时巡检。

配套能力：一键把已有大目录迁移到 D 盘（robocopy + `mklink /J`，原路径照常可用）、全量环境变量注入、dry-run/备份/journal/回滚。运行时 **零 npm 依赖**（自带 YAML 子集解析器），Hook 冷启动约 100ms。

---

## 目录

- [安装（按你的 Agent 选择）](#安装按你的-agent-选择)
- [初始化：install.ps1](#初始化installps1)
- [配置 policy.yaml](#配置-policyyaml)
- [命令一览](#命令一览)
- [迁移已有缓存目录](#迁移已有缓存目录)
- [查看日志与回滚](#查看日志与回滚)
- [接入其他 Agent（适配层）](#接入其他-agent适配层)
- [安全设计](#安全设计)
- [测试](#测试)
- [已知边界](#已知边界)

---

## 安装（按你的 Agent 选择）

本仓库同时是 **Claude Code 插件市场**（`.claude-plugin/marketplace.json`，`source: "./"`）和 **ZCode 插件市场**（兼容同一清单），单仓库即插即用。

### Claude Code

```text
/plugin marketplace add luo173176/agent-disk-guard
/plugin install agent-disk-guard@agent-disk-guard
```

安装后 Hook 自动生效，无需其他配置。

### ZCode

方式 A（Git 仓库市场）：**插件市场 → 添加 → 添加插件市场**，粘贴仓库地址或本地 clone 目录（内含 `.claude-plugin/marketplace.json`，ZCode 兼容该格式）→ 个人 → 安装 AgentDiskGuard。

方式 B（本地开发市场）：clone 本仓库后，把 `agent-disk-guard/` 目录放进任意市场根目录并配置 `marketplace.json` 指向它。

### DeepSeek Harness（组合包 / bundle）

本包在 `package.json` 里声明了 `dsh.bundle`（组合包 manifest），安装后经官方桥接插件 `@deepseek-ai/dsh-hooks-claude-code` 把自带的 `hooks/hooks.json` 挂到 DSH：PreToolUse 拦截与 SessionStart 会话启动提示都由桥接驱动，开箱即用：

```sh
# 从 GitHub 安装进 profile（dsh plugin add 转发给 pnpm，支持 git 地址）
dsh plugin --profile <name> add github:luo173176/agent-disk-guard
# 或本地 clone 后安装：
dsh plugin --profile <name> add <clone目录>
# npm 发布后也可以：
dsh plugin add agent-disk-guard
```

DSH 专属注意事项（0.3.2 起基本由插件自动处理，无需手工改策略）：

- **宿主能力自动探测**：命中 `DSH_SESSION_ID` / `DSH_HOME` / `DSH_PROFILE_DIR` / `DSH_SHELL` 任一环境变量，或 `ELECTRON_RUN_AS_NODE=1`，即判定为不采纳 `updatedInput` 的宿主（`doctor` 里显示 `宿主 deepseek-harness`）。**实际生效的是后者**：桥接 spawn 出来的 hook 进程拿不到 `DSH_*`（它们只注入给 shell 工具自身），只继承了 Electron 主进程的引导标记。探测结果决定 `redirect` / `rewrite` 决策的**送达形态**：
  - 采纳改写的宿主（Claude Code / ZCode）→ `allow` + `updatedInput`，命令与路径自动重定向；
  - 不采纳改写的宿主（DSH）→ `deny`，理由里直接给出**改写后的完整命令或目标路径**，模型照抄重试即可。
- 这个降级不是锦上添花：旧版在 DSH 上返回 `allow + updatedInput`，桥接把改写入参记一条 warn 后丢弃，命令照原样执行，缓存还是落 C 盘——看起来拦住了，实际什么都没发生。
- **重定向根自动回退**：不采纳改写的宿主（DSH）下，理由里的路径是交给**模型**去执行的，而模型的可写范围由宿主沙箱决定 —— 所以这时直接采用 `<会话工作区>\.agent-cache`，不采信 hook 侧的可写性探测（hook 进程的可写范围与模型毫无关系，实测 hook 在 DSH 沙箱下连会话工作区都写不进去）。采纳改写的宿主仍按 `redirectRoot` 的可写性回退。设 `redirectRootFallback: false` 可关闭全部回退。
- **会话启动主动告知运行态**：命中不采纳改写的宿主时，会话开头注入一条消息，说明「会写 C 盘缓存的命令必须显式带缓存参数」以及当前实际生效的缓存根。这条提示走的是**桥接的 SessionStart**：桥接在 `agent/created` 时跑 `dist/session-check.js`，把 stdout 里的 `hookSpecificOutput.additionalContext` 提升成 `output.additionalContext`（`dsh-hook-protocol/lib/index.js` 的 parse 阶段），再 `agent.inject` 成一条 user message。**核对方式**：在会话日志里找 `agent/inbox/spliced` 记录，其 `inserted[].source.kind` 为 `hooks-claude-code`。**别用 `hook/invoked` 记录来判断这条通路**——`SessionStart` 不写这类审计记录，四个会话里它都是 0 条，而同一份日志的 `agent/inbox/spliced` 明确显示提示确实注入了；只数 `hook/invoked` 会得出「SessionStart 从未触发」的错误结论（本包 0.3.3 就照这个错误结论多写了一份注入，导致同一段提示出现两遍，0.3.5 撤除）。
- `hooks/hooks.json` 里的 SessionStart 条目保留给其他宿主——Claude Code / ZCode 走原生通路，不受这里影响。
- 命令缓存仍建议配合用户级环境变量：`install.ps1` 或 `agent-disk-guard env --set` 写一次，DSH 及其工具子进程都会继承（这条通道不依赖 hook 改写）。
- 桥接缺失时组合包会降级：加载不报错，只打警告，不影响 DSH 启动。

### 其他 Claude Code 系 Harness

社区 harness 的 hooks 子系统普遍兼容 Claude Code 的 `hooks.json` 模式，按兼容程度三选一（详见[接入其他 Agent](#接入其他-agent适配层)）：

1. **hooks 兼容 Claude Code** → 把 `hooks/hooks.json` 的条目复制进其 hooks 配置（命令统一为 `node "<仓库路径>/dist/hook.js"`）；
2. **有生命周期钩子但格式不同** → 在钩子里调用通用适配器 `agent-disk-guard check --tool <Tool> --input-json '<json>'`，按返回的 `permissionDecision` 处理；
3. **无 Hook 能力** → 用包装器 `agent-disk-guard exec -- <command>` 替代直接执行命令。

### npm CLI（不装插件也能用）

```powershell
npm i -g agent-disk-guard     # 或 clone 后 npm install && npm run build && npm link
agent-disk-guard doctor
```

### 各 Host 能力对照

| Host | PreToolUse | deny | 自动改写入参（redirect/rewrite） | SessionStart 告警 |
|---|---|---|---|---|
| ZCode | ✅ | ✅ | ✅ `updatedInput` | ✅ `additionalContext` |
| Claude Code | ✅ | ✅ | ✅ `updatedInput` | ✅ |
| DeepSeek Harness（dsh.bundle + 官方 CC 桥接） | ✅ | ✅ | ⚠️ 桥接忽略 `updatedInput` → 自动降级为 `deny`，理由里给改写后的命令 | ✅ 桥接 SessionStart → `additionalContext` 注入 |

> 不支持 `updatedInput` 的 Host 上，0.3.2 起不再静默退化为"放行 + 提示新路径"，而是转成**带可执行命令的 `deny`**（旧行为是 `updatedInput` 被桥接丢弃后原命令照跑）。想手工覆盖宿主的自动探测，在 `policy.yaml` 里写 `hostCapabilities: auto`（默认）｜`updatedInput`｜`noUpdatedInput`。

要求：Windows 10/11，Node.js ≥ 18（Hook 通过 `node` 运行，零依赖），重定向目标盘（如 `D:`）。

## 初始化：install.ps1

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1                      # 默认重定向到 D:\AgentCache
powershell -ExecutionPolicy Bypass -File .\install.ps1 -RedirectRoot "E:\AgentCache" -InstallScheduledTask
powershell -ExecutionPolicy Bypass -File .\install.ps1 -RedirectTemp        # 可选：连 TMP/TEMP 一起重定向
```

脚本做四件事（幂等，可重复执行）：

1. 创建重定向根目录及全部子目录（`npm-cache`、`pip`、`cargo`、`gradle`、`m2`、`ollama\models`…）；
2. 把默认策略复制到 `%USERPROFILE%\.agent-disk-guard\policy.yaml`（已存在不覆盖，`-ForcePolicy` 强制）；
3. 写入用户环境变量（新开终端生效）。变量表由 `dist/cli.js env --format json` 生成，和守卫读到的策略（`redirectRoot`）永远同一口径：

   | 环境变量 | 指向 |
   |---|---|
   | `npm_config_cache` | `<根>\npm-cache` |
   | `npm_config_store_dir` | `<根>\pnpm-store` |
   | `YARN_CACHE_FOLDER` | `<根>\yarn-cache` |
   | `PIP_CACHE_DIR` | `<根>\pip` |
   | `UV_CACHE_DIR` | `<根>\uv-cache` |
   | `XDG_CACHE_HOME` | `<根>\xdg-cache` |
   | `CARGO_HOME` / `RUSTUP_HOME` | `<根>\cargo` / `<根>\rustup` |
   | `GRADLE_USER_HOME` | `<根>\gradle` |
   | `MAVEN_OPTS` | `-Dmaven.repo.local=<根>\m2\repository`（合并已有参数） |
   | `GOPATH` / `GOMODCACHE` / `GOCACHE` | `<根>\go`… |
   | `DOCKER_CONFIG` | `<根>\docker` |
   | `CODEX_HOME` | `<根>\codex` |
   | `OLLAMA_MODELS` | `<根>\ollama\models` |
   | `HF_HOME` | `<根>\huggingface` |
   | `CONDA_PKGS_DIRS` / `NUGET_PACKAGES` | `<根>\conda\pkgs` / `<根>\nuget` |

   写入前，每个变量安装前的原值会记到 `%USERPROFILE%\.agent-disk-guard\env-backup.json`（只在第一次记录，幂等），卸载时据此逐项还原。

4. `-InstallScheduledTask` 时注册计划任务 `AgentDiskGuard Monitor`（每 15 分钟 `monitor --once`，critical 时退出码 2）。

卸载：`.\uninstall.ps1`（按 `env-backup.json` 还原环境变量、移除计划任务；策略与数据**默认保留**，要删策略加 `-RemovePolicy`（会先留一份 `.uninstalled.bak`）；已迁移的 Junction 用 `rollback` 还原）。

## 配置 policy.yaml

解析顺序：环境变量 `AGENTDISKGUARD_POLICY` → `%USERPROFILE%\.agent-disk-guard\policy.yaml` → 插件自带 `config\policy.yaml` → 内置默认。想自定义就复制一份到用户目录改。

```yaml
protectedDrive: "C:"
redirectRoot: "D:\\AgentCache"
fileWriteMode: redirect   # redirect=自动改写到 D 盘 | deny=拒绝 | ask=询问 | off=不检查
commandMode: rewrite      # rewrite=注入缓存参数 | deny=拒绝 | ask=询问 | off=不检查
failOpen: true            # Hook 内部错误时放行，绝不拖死 Agent
hostCapabilities: auto    # auto=按 DSH_* 环境变量探测宿主是否采纳改写入参 | updatedInput | noUpdatedInput
redirectRootFallback: true # redirectRoot 不可写时回退到 <会话工作区>\.agent-cache（false 则不做回退）

protectedPaths:
  - path: "%LOCALAPPDATA%\\Temp"
    redirect: "temp"        # 重定向到 redirectRoot\temp\<子路径>
  - path: "%USERPROFILE%\\.cache"
    redirect: "xdg-cache"   # 省略 redirect 则走 mirror 模式
  - path: "C:\\Windows"
    mode: deny              # 单条覆盖全局模式：系统目录一律拒绝

whitelist:
  - "%USERPROFILE%\\.agent-disk-guard"

commandRules:               # 正则规则，按顺序取第一条命中
  - pattern: "\\bformat\\s+[cC]:"
    action: deny            # deny | ask | allow
    reason: "禁止格式化系统盘"

monitor:
  enabled: true
  warnGB: 20
  criticalGB: 10
  sessionStartCheck: true
```

要点：

- **Junction 自动放行**：目录一旦迁移成 Junction（数据实际已在 D 盘），守卫检测到 reparse point 后不再拦截，用户不会被锁死；
- **mirror 模式**：没有 `redirect` 名的受保护路径，重定向到 `<根>\mirror\home\<相对用户主目录>`；
- **C 盘根散文件**（`C:\foo.txt`）也拦，防止 Agent 往盘根塞垃圾；
- **宿主能力**：`hostCapabilities: auto` 默认按环境变量探测（`DSH_*` 任一，或 `ELECTRON_RUN_AS_NODE=1`）。不采纳改写入参的宿主上，`redirect` / `rewrite` 会转成 `deny` 并在理由里给出改写后的命令——把 `updatedInput` 交给这种宿主只会被桥接丢弃，原命令照跑；
- **回退根**：`redirectRootFallback: true`（默认）下，不采纳改写的宿主直接采用 `<会话工作区>\.agent-cache`（该路径由模型执行，hook 侧探测不到模型的沙箱范围），采纳改写的宿主才按 `redirectRoot` 的可写性回退；`agent-disk-guard doctor` 会显示探测到的宿主与实际使用的根。
- **会话启动提示**：`monitor.sessionStartCheck` 控制空间告警，宿主运行态提示与它无关、始终注入；文本由 `src/notice.ts` 统一生成，Claude Code / ZCode / DSH 三条宿主通路共用同一份。

## 命令一览

```
agent-disk-guard status [--sizes]        C 盘空间 / 策略 / 环境变量状态 / 可迁移目录 / 迁移记录
agent-disk-guard check --tool Bash --input-json '{"command":"npm install"}'
                                         检查一次工具调用，输出决策 JSON（各 Agent 适配层统一入口）
agent-disk-guard env [--format ps|cmd|sh|json] [--set] [--include-temp]
                                         查看/写入用户环境变量
agent-disk-guard migrate <dir> [--yes] [--no-size]
                                         迁移目录（默认 dry-run；--purge-backup 删备份，也需 --yes）
agent-disk-guard rollback <dir> [--yes]  回滚迁移（默认 dry-run）
agent-disk-guard monitor [--watch] [--interval-min 10]
                                         空间检查与告警（critical 退出码 2）
agent-disk-guard doctor                  自检：策略/redirectRoot 可写/robocopy/mklink/hook
agent-disk-guard exec -- npm install     无 Hook Agent 的包装器：注入环境变量 + 拦截检查后执行
```

## 迁移已有缓存目录

```powershell
agent-disk-guard migrate C:\Users\me\.gradle        # 1. dry-run：显示大小、步骤、警告
agent-disk-guard migrate C:\Users\me\.gradle --yes  # 2. 二次确认后执行：
#    robocopy 复制 → 原目录改名 *.adg-bak（备份）→ mklink /J 建 Junction → 验证
agent-disk-guard migrate C:\Users\me\.gradle --purge-backup --yes   # 3. 确认无误后清掉备份（可选）
```

迁移后：原路径是 Junction，一切程序照常用；实际数据在 `D:\AgentCache\gradle`。
硬性拒绝：`C:\Windows`、`Program Files`、`ProgramData`、用户主目录、盘根、与 redirectRoot 相互嵌套、已是 Junction 的目录、目标非空。

## 查看日志与回滚

```powershell
agent-disk-guard status              # 最近 10 条迁移记录
type %USERPROFILE%\.agent-disk-guard\journal.jsonl     # 全量操作日志（JSONL）
type %USERPROFILE%\.agent-disk-guard\agent-disk-guard.log   # 运行日志（自动轮转）
agent-disk-guard rollback C:\Users\me\.gradle           # dry-run
agent-disk-guard rollback C:\Users\me\.gradle --yes     # rmdir 拆 Junction（绝不动 D 盘数据）→ 备份改回原名
```

journal 刻意放在 C 盘（KB 级文本）：即使 D 盘损坏，回滚信息依然可用。

## 接入其他 Agent（适配层）

协议适配层在 `src/adapters.ts`：输入兼容 `{tool_name, tool_input}`（Claude Code / ZCode）、`{toolName, toolInput}`、`{tool, input}`（OpenCode 风格）三种载荷；输出统一为 PreToolUse JSON：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow | deny | ask",
    "permissionDecisionReason": "…",
    "updatedInput": { "…改写后的完整工具入参（可选）" }
  }
}
```

**其他 Claude Code 系 Harness** —— 在其 hooks 配置中加入：

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "^(Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit)$",
      "hooks": [{ "type": "command", "command": "node \"<仓库路径>/dist/hook.js\"", "timeout": 5 }]
    }]
  }
}
```

**Cursor**（Hooks Beta）—— `beforeShellExecution` 返回前调用：
`agent-disk-guard check --tool Bash --input-json "{\"command\":\"npm install\"}"`，
对输出 `permissionDecision: "deny"` 返回 `{permission: "deny"}`；`beforeFileEdit` 用 `--tool Write`。Cursor 当前不支持改写入参，`redirect` 决策请按 reason 里的提示手动换路径。

**OpenCode** —— 插件文件：

```ts
// .opencode/plugin/disk-guard.ts
export const DiskGuard = async ({ project, client, $ }) => {
  // tool.execute.before 里把 {tool, args} 交给 CLI（本插件已兼容该载荷形态）
  const r = await $`agent-disk-guard check --tool ${args.tool} --input-json ${JSON.stringify(args.input)}`
  const d = JSON.parse(r.stdout)
  if (d.hookSpecificOutput?.permissionDecision === "deny") throw new Error(d.hookSpecificOutput.permissionDecisionReason)
}
```

**无 Hook 能力的 Agent** —— 用包装器替代直接执行：`agent-disk-guard exec -- npm install`（注入环境变量、拦截危险命令、改写缓存参数后执行）。

## 安全设计

- **fail-open**：Hook 任何内部错误 → 空输出 + 退出码 0 = 放行，Agent 永远不会被插件卡死；
- **不误删**：迁移是复制+改名，不做原地删除；备份保留，`--purge-backup` 需二次确认；`rollback` 拆 Junction 用 `rmdir`（无 `/s`），结构上不可能删到 D 盘数据；
- **二次确认**：所有写操作（migrate/rollback/purge）默认 dry-run，`--yes` 才执行；
- **系统目录**：`C:\Windows` 等无论全局模式如何一律拒绝（`mode: deny`），拒绝"重定向"变相放行；
- **低开销**：决策是纯函数；只在路径命中受保护目录时才做一次 junction 探测；空输出即放行。

## 测试

```powershell
npm install && npm run build
npm test        # 48 个用例：策略解析 / 路径守卫 / 命令改写 / 决策引擎 / hook 端到端 / 监控分级 / 迁移安全
```

覆盖验收场景：

1. `npm install` → 命令被改写为 `npm install --cache "D:\AgentCache\npm-cache"`；
2. 写 `C:\Users\test\AppData\Local\Temp\abc` → 被改写为 `D:\AgentCache\temp\abc`；
3. 模拟剩余空间 < 10GB → 判定 critical 并输出告警与迁移建议。

## 已知边界

- `docker pull` 的镜像层存在 Docker Desktop 的 WSL2 vhdx 里，环境变量只能改客户端配置；瘦身请用 Docker Desktop 自带的 disk image 位置设置；
- Hook 无法替子进程设置环境变量（那是 `install.ps1`/`env --set`/`exec` 包装器的职责），所以 Hook 只注入命令行参数；
- `npx`/`pnpm`/`cargo`/`go`/`gradle` 等没有可靠的缓存命令行参数，依赖环境变量（Hook 检测到未注入时会在 reason 里提示）；
- 本工具面向 Windows（C/D 盘、junction、robocopy）；WSL/macOS/Linux 侧拦截不在范围内。

## License

[MIT](LICENSE) © luo173176
