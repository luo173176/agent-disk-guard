# AgentDiskGuard 设计文档

## 1. 目标与约束

| 目标 | 手段 |
|---|---|
| 事前拦截 | PreToolUse Hook，在工具执行前检查文件路径与命令参数 |
| 路径重定向 | 受保护路径写入改写到 `redirectRoot`（如 `D:\AgentCache`） |
| 环境变量注入 | install.ps1 / CLI `env --set` / `exec` 包装器 |
| 已有大目录迁移 | robocopy 复制 + `*.adg-bak` 备份 + `mklink /J` Junction |
| 磁盘监控 | SessionStart 注入告警 + CLI `monitor`（计划任务/watch） |
| 安全可回滚 | 全程 dry-run、备份、JSONL journal、显式 `--yes` 二次确认 |

硬约束：**低开销**（纯函数决策 + fail-open，Hook 不拖慢 Agent）、**零运行时依赖**（自带 YAML 子集解析器，Hook 只需 node + dist）、**不误删**（复制+改名，从不原地删除用户数据）。

## 2. 架构图

```
                         ┌────────────────────────────────────────────────┐
                         │                 AI Coding Agent                │
                         │   (ZCode / Claude Code / Cursor / OpenCode)    │
                         └───────┬───────────────────────────┬────────────┘
                                 │ PreToolUse 载荷           │ 执行工具
                                 │ {tool_name, tool_input}   ▼
                                 ▼                   Bash / Write / Edit / …
              ┌──────────────────────────────────┐
              │        Hook 入口 hook.js         │  ~100ms 冷启动, fail-open
              │  adapters.ts 载荷归一化          │
              └───────┬──────────────────────────┘
                      ▼
              ┌──────────────────────────────────┐   ┌─────────────────────┐
              │        决策引擎 guard.ts         │◄──┤  policy.ts 策略加载  │
              │  纯函数, 无 IO(除 junction 探测) │   │  YAML 子集解析器     │
              └──┬──────────────┬───────────────┘   └─────────────────────┘
                 │              │
        ┌────────▼─────┐  ┌─────▼──────────────┐
        │ pathguard.ts │  │  rewriters.ts      │
        │ 路径判定/镜像 │  │  npm/pip/yarn/git/ │
        │ junction 放行 │  │  mvn 参数注入      │
        └────────┬─────┘  └─────┬──────────────┘
                 ▼              ▼
   ┌────────────────────────────────────────────┐
   │ 输出: { hookSpecificOutput: {              │
   │    hookEventName: "PreToolUse",            │
   │    permissionDecision: allow|deny|ask,     │
   │    permissionDecisionReason, updatedInput? │  ← 改写后的完整工具入参
   │ }} }                                       │
   └────────────────────────────────────────────┘

  周边组件（CLI，不在热路径上）:
   cli.js: status / check / env / migrate / rollback / monitor / doctor / exec
   migrate.ts (robocopy+junction+journal)   monitor.ts (Get-CimInstance 空间查询)
   journal.ts (JSONL 操作日志+回滚依据)      session-check.js (SessionStart 告警)
```

## 3. 数据流：一次 PreToolUse 拦截

```
stdin ──► JSON.parse ──► normalizeHookInput ──► loadPolicy(缓存于进程内)
              │                │
              │ 非法/空载荷     │ 工具名识别不出
              ▼                ▼
          放行(exit 0, 无输出) ──► evaluateToolCall(tool, input, policy)
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              ▼                         ▼                         ▼
        文件类工具                 命令类工具                  其他工具
   Write/Edit/MultiEdit/      Bash/PowerShell           通用兜底: 入参含
   NotebookEdit               command/script 字段        file_path/path 字段
              │                         │                         │
              ▼                         ▼                         ▼
        checkPath(path)          ① commandRules 正则        同文件类路径检查
              │                  ② rewriteCommand
              ▼                         │
   mode = 单条 mode ?? 全局             ▼
   fileWriteMode                  变化? → allow+updatedInput
              │                  (commandMode=deny/ask 则拒绝/询问)
   ┌──────┬──────────┬──────────┐
   ▼      ▼          ▼          ▼
  off    deny       ask      redirect
 放行   拒绝+理由  询问用户   allow + updatedInput
                                 (file_path → D 盘镜像)
```

输出协议（与 ZCode 运行时 schema 逐键核对过，多余键会导致校验失败）：

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask",
    "permissionDecisionReason": "…",
    "updatedInput": { "…完整替换后的工具入参" }
  }
}
```

退出码语义保留：0 通过 / 2 拦截（不使用输出通道时也可仅靠退出码）。

## 4. 路径重定向算法（pathguard.ts）

```
输入 target ──规范化(统一 \ 、压重、留大小写)──► p
1. driveOf(p) ≠ 受保护盘符          → 放行（D/E 盘随便写）
2. 命中 whitelist 前缀              → 放行（如守卫自身数据目录）
3. 命中 protectedPaths 前缀:
     pp.path 是 reparse point?      → 放行 ← Junction 放行：数据已物理在 D 盘,
     │                                      再拦会把用户锁死在已迁移目录
     ▼
   redirect 子目录名?
     ├─ 有: <root>\<redirect>\<相对 pp.path 的子路径>
     └─ 无: <root>\mirror\home\<相对用户主目录>   (盘根场景: mirror\driveC\…)
4. 未命中但直接落在 C:\ 盘根          → 拦（防 Agent 往盘根塞文件）
5. 其余 C 盘路径（项目目录等）        → 放行（低误报原则：项目工作不受干扰）
```

## 5. 命令改写算法（rewriters.ts）

按 `\n / && / ; / |` 切段，逐段处理：

| 工具 | 注入 | 跳过条件 |
|---|---|---|
| `npm` | `--cache "<root>\npm-cache"` | 已有 `--cache`，或 `npm_config_cache` 已指向 `<root>` |
| `pip`/`pip3`/`uv`/`uvx` | `--cache-dir "<root>\…"` | 已有该参数或对应环境变量已指向 `<root>` |
| `yarn` | `--cache-folder "<root>\yarn-cache"` | 同上 |
| `mvn` | `-Dmaven.repo.local="<root>\m2\repository"` | 已有该参数 |
| `git clone` | 目标路径命中受保护路径 → 改写目标 | 目标是普通项目目录（放行） |
| `npx`/`pnpm`/`conda`/`cargo`/`go`/`gradle`/`docker`/`ollama` | 不注入（无可靠参数），依赖环境变量 | — |

设计取向：**宁可漏判不可误判**。普通项目目录（哪怕在 C 盘）完全不动；要拦的只有"缓存/临时/系统"这些明确目标。`commandRules` 是用户自行扩展的逃生口。

## 6. 目录迁移状态机（migrate.ts + journal.ts）

```
planMigration(source)                    executeMigration(--yes)          rollbackMigration(--yes)
─────────────────────                    ────────────────────────         ─────────────────────────
源存在/是目录/非 Junction                 ① robocopy /E 复制               a. rmdir <src>   ← 无 /s,
在受保护盘 / 非黑名单                     ② ren src → src.adg-bak             结构上删不到 D 盘数据
与 redirectRoot 不嵌套                    ③ mklink /J src → dest           b. .adg-bak 存在?
目标非空? 源=redirectRoot 子树?                │失败 → 改名回滚+journal        ├─ 是: ren 回原名
测量大小(robocopy /L)                     ④ readdir 验证                    └─ 否: robocopy /MOVE
        │                                 ⑤ journal: done                     搬回 C 盘, journal 记录
   dry-run 报告（零修改）                  备份原地保留；--purge-backup       D 盘副本保留, 输出提示
                                          需再次 --yes
```

journal 每步落盘（JSONL，追加式），记录 source/dest/backupPath/status，`rollback` 依据最新状态决定恢复方式。journal 放在 C 盘用户目录（KB 级）：D 盘故障时回滚信息仍可用。

## 7. 磁盘监控

- **SessionStart Hook**（`session-check.js`）：一次 `Get-CimInstance Win32_LogicalDisk`（200-500ms，仅会话启动时）。`level > ok` 才注入 `additionalContext`（含具体迁移命令），正常时静默；
- **CLI `monitor --once`**：供计划任务（install.ps1 可注册，15 分钟周期）；critical 时退出码 2；
- **CLI `monitor --watch`**：交互式常驻，间隔可调；
- 分级：`free ≤ criticalGB(10)` → critical；`≤ warnGB(20)` → warn；否则 ok。

## 8. 性能预算

| 环节 | 开销 |
|---|---|
| Hook 冷启动（node + 读策略 + 决策） | ~80-120ms（超时上限 5s，远低于正常值） |
| 路径命中受保护目录时 | +1 次 `lstat`（junction 探测，~0.1ms） |
| 命令改写 | 纯字符串/正则，<1ms |
| SessionStart 巡检 | 1 次 PowerShell CIM 查询，200-500ms，每会话一次 |
| 放行路径的输出 | 空（零字节），由退出码语义放行 |

fail-open 兜底：任何异常 → 空输出 + exit 0，Agent 流程不受影响（可配 `failOpen: false` 改为拒绝）。

## 9. 风险与边界

- Docker 镜像层在 WSL2 vhdx 内，本工具只能改客户端配置目录；
- Hook 无法为子进程注入环境变量（进程模型限制），环境变量由 install.ps1 持久化或 `exec` 包装器临时注入；
- 正则规则有误杀可能，故内置规则最少化（format/diskpart/删 Windows），其余交给用户按需添加；
- 迁移期间目录被占用会失败：robocopy 阶段失败 → 未修改源；mklink 阶段失败 → 自动改名恢复原目录。

## 10. 扩展点

- `adapters.ts`：新 Agent 只需实现载荷归一化 + 决策 JSON 的映射；
- `rewriters.ts`：新包管理器加一行表项（工具名 → 注入参数）；
- `policy.yaml`：protectedPaths/commandRules/whitelist 全部数据驱动；
- `cli.ts`：可加 `clean-suggest`（列出可安全删除的 stale 缓存）、webhook 告警等。
