"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.additionalContextOutput = exports.decisionToPreToolUseOutput = exports.normalizeHookInput = exports.journalFile = exports.readEntries = exports.purgeBackup = exports.rollbackMigration = exports.executeMigration = exports.planMigration = exports.classifyFree = exports.suggestCleanup = exports.checkDisk = exports.mergeMavenOpts = exports.buildEnvPlan = exports.rewriteCommand = exports.isReparsePoint = exports.computeRedirectPath = exports.checkPath = exports.evaluateToolCall = exports.resolvePolicyFilePath = exports.parseYamlSubset = exports.defaultPolicy = exports.loadPolicy = void 0;
/**
 * AgentDiskGuard — 库入口。
 * 供其他 Node 程序/Agent 插件直接复用决策核心（纯函数，无副作用）。
 */
var policy_1 = require("./policy");
Object.defineProperty(exports, "loadPolicy", { enumerable: true, get: function () { return policy_1.loadPolicy; } });
Object.defineProperty(exports, "defaultPolicy", { enumerable: true, get: function () { return policy_1.defaultPolicy; } });
Object.defineProperty(exports, "parseYamlSubset", { enumerable: true, get: function () { return policy_1.parseYamlSubset; } });
Object.defineProperty(exports, "resolvePolicyFilePath", { enumerable: true, get: function () { return policy_1.resolvePolicyFilePath; } });
var guard_1 = require("./guard");
Object.defineProperty(exports, "evaluateToolCall", { enumerable: true, get: function () { return guard_1.evaluateToolCall; } });
var pathguard_1 = require("./pathguard");
Object.defineProperty(exports, "checkPath", { enumerable: true, get: function () { return pathguard_1.checkPath; } });
Object.defineProperty(exports, "computeRedirectPath", { enumerable: true, get: function () { return pathguard_1.computeRedirectPath; } });
Object.defineProperty(exports, "isReparsePoint", { enumerable: true, get: function () { return pathguard_1.isReparsePoint; } });
var rewriters_1 = require("./rewriters");
Object.defineProperty(exports, "rewriteCommand", { enumerable: true, get: function () { return rewriters_1.rewriteCommand; } });
var envplan_1 = require("./envplan");
Object.defineProperty(exports, "buildEnvPlan", { enumerable: true, get: function () { return envplan_1.buildEnvPlan; } });
Object.defineProperty(exports, "mergeMavenOpts", { enumerable: true, get: function () { return envplan_1.mergeMavenOpts; } });
var monitor_1 = require("./monitor");
Object.defineProperty(exports, "checkDisk", { enumerable: true, get: function () { return monitor_1.checkDisk; } });
Object.defineProperty(exports, "suggestCleanup", { enumerable: true, get: function () { return monitor_1.suggestCleanup; } });
Object.defineProperty(exports, "classifyFree", { enumerable: true, get: function () { return monitor_1.classifyFree; } });
var migrate_1 = require("./migrate");
Object.defineProperty(exports, "planMigration", { enumerable: true, get: function () { return migrate_1.planMigration; } });
Object.defineProperty(exports, "executeMigration", { enumerable: true, get: function () { return migrate_1.executeMigration; } });
Object.defineProperty(exports, "rollbackMigration", { enumerable: true, get: function () { return migrate_1.rollbackMigration; } });
Object.defineProperty(exports, "purgeBackup", { enumerable: true, get: function () { return migrate_1.purgeBackup; } });
var journal_1 = require("./journal");
Object.defineProperty(exports, "readEntries", { enumerable: true, get: function () { return journal_1.readEntries; } });
Object.defineProperty(exports, "journalFile", { enumerable: true, get: function () { return journal_1.journalFile; } });
var adapters_1 = require("./adapters");
Object.defineProperty(exports, "normalizeHookInput", { enumerable: true, get: function () { return adapters_1.normalizeHookInput; } });
Object.defineProperty(exports, "decisionToPreToolUseOutput", { enumerable: true, get: function () { return adapters_1.decisionToPreToolUseOutput; } });
Object.defineProperty(exports, "additionalContextOutput", { enumerable: true, get: function () { return adapters_1.additionalContextOutput; } });
