---
description: 回滚一次目录迁移（拆 Junction、还原 C 盘目录；先 dry-run，执行需明确确认）
argument-hint: [原C盘目录路径]
---

用户要求回滚迁移：$ARGUMENTS

流程：

1. 参数为空时，运行 `agent-disk-guard status` 查看"最近迁移记录"，列出可回滚的目录供用户选择；
2. 运行 `agent-disk-guard rollback "<目录>"`（dry-run），展示回滚计划；
3. 用户明确确认后运行带 `--yes` 的命令；
4. 完成后验证：原路径不再是 Junction、数据可读；提醒用户 D 盘副本保留位置（确认无误后可手动删除，或由用户明确要求时清理）。
