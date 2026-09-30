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

本包在 `package.json` 里声明了 `dsh.bundle`（组合包 manifest），安装后经官方桥接插件 `@deepseek-ai/dsh-hooks-claude-code` 把自带的 `hooks/hooks.json` 挂到 DSH 的 PreToolUse / SessionStart 拦截点，开箱即用：

```sh
# 从 GitHub 安装进 profile（dsh plugin add 转发给 pnpm，支持 git 地址）
dsh plugin --profile <name> add github:luo173176/agent-disk-guard
# 或本地 clone 后安装：
dsh plugin --profile <name> add <clone目录>
# npm 发布后也可以：
dsh plugin add agent-disk-guard
```

DSH 专属注意事项：

- DSH 的 Claude Code 桥接**不支持 `updatedInput`**（改写入参会被记录并忽略）。因此建议 DSH 用户把策略 `fileWriteMode` 设为 `deny`：守卫拒绝 C 盘写入并在模型可见的理由里给出 D 盘目标路径，模型会用新路径重试。`deny`/`ask` 决策被桥接完整尊重。
- 命令缓存重定向在 DSH 上主要靠环境变量：先用 `install.ps1` 或 `agent-disk-guard env --set` 写入用户级变量，DSH 及其工具子进程会继承。
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
| DeepSeek Harness（dsh.bundle + 官方 CC 桥接） | ✅ | ✅ | ❌ 桥接忽略 `updatedInput`，建议 `fileWriteMode: deny` | ✅ |

> 不支持 `updatedInput` 的 Host 上，`redirect` 决策会退化为"放行 + 理由里提示新路径"；想强制拦截就把 `policy.yaml` 的 `fileWriteMode` 改成 `deny`。

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
3. 写入用户环境变量（新开终端生效）：

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

4. `-InstallScheduledTask` 时注册计划任务 `AgentDiskGuard Monitor`（每 15 分钟 `monitor --once`，critical 时退出码 2）。

卸载：`.\uninstall.ps1`（只移除环境变量/计划任务/策略，**绝不删除任何数据**；已迁移的 Junction 用 `rollback` 还原）。

## 配置 policy.yaml

解析顺序：环境变量 `AGENTDISKGUARD_POLICY` → `%USERPROFILE%\.agent-disk-guard\policy.yaml` → 插件自带 `config\policy.yaml` → 内置默认。想自定义就复制一份到用户目录改。

```yaml
protectedDrive: "C:"
redirectRoot: "D:\\AgentCache"
fileWriteMode: redirect   # redirect=自动改写到 D 盘 | deny=拒绝 | ask=询问 | off=不检查
commandMode: rewrite      # rewrite=注入缓存参数 | deny=拒绝 | ask=询问 | off=不检查
failOpen: true            # Hook 内部错误时放行，绝不拖死 Agent

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
- **C 盘根散文件**（`C:\foo.txt`）也拦，防止 Agent 往盘根塞垃圾。

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
