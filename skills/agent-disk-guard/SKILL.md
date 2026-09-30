---
name: agent-disk-guard
description: Use when the user worries about C: disk space being eaten by AI coding agents, asks to inspect/migrate caches (npm/pip/cargo/gradle), wants to check what AgentDiskGuard blocked or redirected, or needs to roll back a migration. Provides the agent-disk-guard CLI workflow: status, migrate (dry-run + --yes), rollback, env, monitor, doctor.
---

# AgentDiskGuard 使用手册

AgentDiskGuard 已通过 Hook 自动拦截对 C 盘受保护路径的写入，并把 npm/pip 等缓存命令改写到 D 盘（默认 `D:\AgentCache`）。本技能指导你使用配套 CLI 完成主动管理。

## 核心原则

1. **一切危险操作先 dry-run**：`migrate` / `rollback` 不带 `--yes` 只出计划；确认无误后再加 `--yes`。绝不擅自替用户加 `--yes` —— 除非用户在当前对话里明确要求执行。
2. **绝不删除数据**：备份（`*.adg-bak`）与 D 盘副本只在用户明确要求时清理（`--purge-backup --yes`）。
3. **系统目录永远不动**：`C:\Windows`、`Program Files`、`ProgramData`、用户主目录、盘根都在迁移黑名单里。

## 常用流程

### 查看现状

```bash
agent-disk-guard status          # 空间/策略/环境变量/可迁移目录/最近迁移
agent-disk-guard status --sizes  # 附加目录大小测量（较慢，大目录可能要数十秒）
agent-disk-guard doctor          # 自检
```

### 迁移一个大目录到 D 盘

```bash
agent-disk-guard migrate "C:\Users\<u>\.gradle"            # 先出计划
# 向用户展示计划（大小/步骤/警告），得到确认后：
agent-disk-guard migrate "C:\Users\<u>\.gradle" --yes      # 真正执行
# 用户确认一切正常后（可选）：
agent-disk-guard migrate "C:\Users\<u>\.gradle" --purge-backup --yes
```

迁移后原路径是 Junction，所有程序照常使用。

### 回滚

```bash
agent-disk-guard rollback "C:\Users\<u>\.gradle"           # dry-run
agent-disk-guard rollback "C:\Users\<u>\.gradle" --yes     # 拆 Junction、还原 C 盘目录
```

### 环境变量

```bash
agent-disk-guard env                # 查看应有值
agent-disk-guard env --set          # 写入用户环境变量（新终端生效）
```

### 空间告警

```bash
agent-disk-guard monitor --once     # 单次检查，低于 criticalGB 退出码 2
```

## Hook 行为速查

| 场景 | Hook 行为 |
|---|---|
| 写 `C:\Users\<u>\AppData\Local\Temp\x` | 改写为 `D:\AgentCache\temp\x` |
| 写 `C:\Windows\...` | 拒绝（系统目录，任何模式都拒绝） |
| `npm install` | 命令尾追加 `--cache "D:\AgentCache\npm-cache"` |
| `pip install x` | 追加 `--cache-dir "D:\AgentCache\pip"` |
| `git clone <url> <受保护路径>` | 目标改写到 D 盘 |
| 写普通项目目录（含 C 盘项目） | 放行 |
| 目录已是 Junction（已迁移） | 放行（数据实际在 D 盘） |

## 排查

- Hook 没生效：`Settings → Plugin Management` 打开插件详情，确认 hook 标记为可运行；`node -v` 确认 Node ≥ 18。
- 决策是否符合预期：`agent-disk-guard check --tool Bash --input-json '{"command":"npm install"}'`
- 策略来源：`status` 第一行显示当前生效的 policy.yaml 路径。
- 日志：`%USERPROFILE%\.agent-disk-guard\agent-disk-guard.log` 与 `journal.jsonl`。
