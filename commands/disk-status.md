---
description: 查看 C 盘空间与 AgentDiskGuard 状态（可迁移目录、环境变量、迁移记录）
---

运行 `agent-disk-guard status` 并把输出整理成简报：

1. C 盘剩余空间与告警级别；
2. 未生效的环境变量（❌ 项）——如果存在，提示运行 `agent-disk-guard env --set` 或 install.ps1；
3. 可迁移的 C 盘目录清单，按优先级给出建议（大目录优先），并附上对应的 dry-run 迁移命令；
4. 最近的迁移记录（如有异常状态 failed 指出原因）。

不要自动执行任何迁移；只汇报与建议。
