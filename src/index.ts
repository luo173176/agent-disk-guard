/**
 * AgentDiskGuard — 库入口。
 * 供其他 Node 程序/Agent 插件直接复用决策核心（纯函数，无副作用）。
 */
export { loadPolicy, defaultPolicy, parseYamlSubset, resolvePolicyFilePath, type Policy } from "./policy";
export { evaluateToolCall, type Decision } from "./guard";
export { checkPath, computeRedirectPath, isReparsePoint } from "./pathguard";
export { rewriteCommand } from "./rewriters";
export { buildEnvPlan, mergeMavenOpts, type EnvVar } from "./envplan";
export { checkDisk, suggestCleanup, classifyFree, type DiskStatus } from "./monitor";
export { planMigration, executeMigration, rollbackMigration, purgeBackup, type MigratePlan } from "./migrate";
export { readEntries, journalFile, type JournalEntry } from "./journal";
export { normalizeHookInput, decisionToPreToolUseOutput, additionalContextOutput } from "./adapters";
