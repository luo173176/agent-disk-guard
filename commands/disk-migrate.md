---
description: 迁移一个 C 盘目录到 D 盘（robocopy + Junction，先 dry-run，执行需明确确认）
argument-hint: [C盘目录路径]
---

用户要求迁移目录：$ARGUMENTS

按以下顺序执行，**缺少用户确认绝不加 --yes**：

1. 参数为空时，先运行 `agent-disk-guard status`，从"可迁移目录"里列出候选并询问用户要迁移哪个；
2. 运行 `agent-disk-guard migrate "<目录>"`（dry-run），向用户展示：预计大小、目标路径、步骤与警告；
3. 明确询问用户确认后才运行带 `--yes` 的命令；若 robocopy 退出码 ≥ 8 或任何一步失败，原样报告错误并停止；
4. 成功后告知：原路径已是 Junction、备份 `*.adg-bak` 的位置、以及后续可用 `--purge-backup --yes` 清理备份（需用户再次确认）。

黑名单（CLI 会硬拒绝，不要尝试绕过）：C:\Windows、Program Files (x86)、ProgramData、用户主目录、盘根。
