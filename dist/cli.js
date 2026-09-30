"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = main;
/**
 * AgentDiskGuard — CLI。
 *
 *   agent-disk-guard status                 查看 C 盘空间/策略/环境变量/迁移记录
 *   agent-disk-guard check                  检查一次工具调用（供各 Agent 适配层调用）
 *   agent-disk-guard env [--set]            查看/写入用户环境变量
 *   agent-disk-guard migrate <dir> [--yes]  迁移目录到 D 盘（默认 dry-run）
 *   agent-disk-guard rollback <dir> [--yes] 回滚迁移（默认 dry-run）
 *   agent-disk-guard monitor [--watch]      检查磁盘空间并告警
 *   agent-disk-guard doctor                 自检（策略/工具/环境）
 *   agent-disk-guard exec -- <command>      注入环境变量后执行命令（无 Hook Agent 的包装器）
 *
 * 退出码：0 正常；1 错误；2 拦截/低于 critical 阈值（供计划任务与调用方识别）。
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const policy_1 = require("./policy");
const guard_1 = require("./guard");
const envplan_1 = require("./envplan");
const monitor_1 = require("./monitor");
const migrate_1 = require("./migrate");
const journal_1 = require("./journal");
const adapters_1 = require("./adapters");
const util_1 = require("./util");
const logger_1 = require("./logger");
function usage() {
    return [
        "AgentDiskGuard — 防止 AI 编码 Agent 跑满 C 盘",
        "",
        "用法:",
        "  agent-disk-guard status [--sizes] [--json]",
        "  agent-disk-guard check --tool <ToolName> --input-json '<json>'",
        "  agent-disk-guard env [--format ps|cmd|sh|json] [--set] [--include-temp]",
        "  agent-disk-guard migrate <dir> [--yes] [--no-size]",
        "  agent-disk-guard rollback <dir> [--yes]",
        "  agent-disk-guard monitor [--watch] [--interval-min 10] [--json]",
        "  agent-disk-guard doctor",
        "  agent-disk-guard exec -- <command...>",
    ].join("\n");
}
function argValue(args, name, dflt) {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
}
function hasFlag(args, name) {
    return args.includes(name);
}
function printDecision(decision) {
    process.stdout.write(JSON.stringify((0, adapters_1.decisionToPreToolUseOutput)(decision), null, 2) + "\n");
}
function cmdStatus(args) {
    const policy = (0, policy_1.loadPolicy)();
    const withSizes = hasFlag(args, "--sizes");
    const asJson = hasFlag(args, "--json");
    const status = (0, monitor_1.checkDisk)(policy);
    const envPlan = (0, envplan_1.buildEnvPlan)(policy);
    const envState = envPlan.map((v) => {
        const cur = process.env[v.name];
        const ok = cur && (0, util_1.normalizePath)(cur).toLowerCase().startsWith((0, util_1.normalizePath)(v.value).toLowerCase());
        return { ...v, current: cur ?? null, ok: !!ok };
    });
    const cands = (0, monitor_1.suggestCleanup)(policy, withSizes);
    const journal = (0, journal_1.readEntries)().slice(-10).reverse();
    if (asJson) {
        process.stdout.write(JSON.stringify({ policyFile: (0, policy_1.resolvePolicyFilePath)(), redirectRoot: policy.redirectRoot, disk: status, env: envState, cleanup: cands, recentJournal: journal }, null, 2) + "\n");
    }
    else {
        process.stdout.write("== AgentDiskGuard 状态 ==\n");
        process.stdout.write(`策略文件: ${(0, policy_1.resolvePolicyFilePath)() ?? "(内置默认)"}\n`);
        process.stdout.write(`重定向根: ${policy.redirectRoot}\n`);
        process.stdout.write(`写文件模式: ${policy.fileWriteMode} | 命令模式: ${policy.commandMode} | fail-open: ${policy.failOpen}\n\n`);
        process.stdout.write((0, monitor_1.statusLine)(status) + "\n\n");
        process.stdout.write("== 环境变量 ==\n");
        for (const v of envState) {
            process.stdout.write(`${v.ok ? "✅" : "❌"} ${v.name} = ${v.current ?? "(未设置)"}  # ${v.note}\n`);
        }
        process.stdout.write("\n== C 盘可迁移目录 ==\n");
        if (cands.length === 0)
            process.stdout.write("（无 —— 全部已迁移或不存在）\n");
        for (const c of cands) {
            process.stdout.write(`  ${c.path}${c.sizeBytes != null ? `  约 ${(0, util_1.humanBytes)(c.sizeBytes)}` : ""}\n`);
        }
        process.stdout.write("\n== 最近迁移记录 ==\n");
        if (journal.length === 0)
            process.stdout.write("（无）\n");
        for (const e of journal) {
            process.stdout.write(`  [${e.time}] ${e.op} ${e.status} ${e.source} → ${e.dest}\n`);
        }
    }
    return status.level === "critical" ? 2 : 0;
}
function cmdCheck(args) {
    const policy = (0, policy_1.loadPolicy)();
    const toolArg = argValue(args, "--tool");
    const jsonArg = argValue(args, "--input-json");
    let call = null;
    if (toolArg && jsonArg) {
        call = { toolName: toolArg, toolInput: JSON.parse(jsonArg) };
    }
    else {
        // stdin: {tool_name, tool_input} 或 {tool, input}
        const raw = fs.readFileSync(0, "utf8");
        call = (0, adapters_1.normalizeHookInput)(JSON.parse(raw || "{}"));
    }
    if (!call) {
        process.stderr.write("缺少 --tool/--input-json 或 stdin JSON\n");
        return 1;
    }
    const decision = (0, guard_1.evaluateToolCall)(call.toolName, call.toolInput, policy);
    if (hasFlag(args, "--plain")) {
        process.stdout.write(`action: ${decision.action}\nreason: ${decision.reason ?? "-"}\n`);
        if (decision.updatedInput) {
            process.stdout.write(`updatedInput: ${JSON.stringify(decision.updatedInput, null, 2)}\n`);
        }
    }
    else {
        printDecision(decision);
    }
    return decision.action === "deny" ? 2 : 0;
}
function cmdEnv(args) {
    const policy = (0, policy_1.loadPolicy)();
    const includeTemp = hasFlag(args, "--include-temp");
    const plan = (0, envplan_1.buildEnvPlan)(policy, includeTemp);
    const format = argValue(args, "--format", "table");
    if (hasFlag(args, "--set")) {
        const maven = (0, envplan_1.mergeMavenOpts)(process.env.MAVEN_OPTS, policy);
        const toSet = plan
            .filter((v) => v.name !== "MAVEN_OPTS")
            .map((v) => [v.name, v.value]);
        toSet.push(["MAVEN_OPTS", maven]);
        for (const [name, value] of toSet) {
            const r = (0, util_1.execSync)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Environment]::SetEnvironmentVariable('${name}', '${value.replace(/'/g, "''")}', 'User')`], { timeoutMs: 20000 });
            process.stdout.write(`${r.status === 0 ? "✅" : "❌"} ${name} = ${value}\n`);
        }
        process.stdout.write("\n已写入用户环境变量。新开的终端/应用生效（已运行的进程不受影响）。\n");
        return 0;
    }
    if (format === "json") {
        process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    }
    else if (format === "ps") {
        for (const v of plan)
            process.stdout.write(`[Environment]::SetEnvironmentVariable('${v.name}', '${v.value}', 'User')\n`);
    }
    else if (format === "cmd") {
        for (const v of plan)
            process.stdout.write(`setx ${v.name} "${v.value}"\n`);
    }
    else if (format === "sh") {
        for (const v of plan)
            process.stdout.write(`export ${v.name}="${v.value.replace(/\\/g, "/")}"\n`);
    }
    else {
        for (const v of plan)
            process.stdout.write(`${v.name}=${v.value}    # ${v.note}\n`);
    }
    return 0;
}
const MIGRATE_VALUE_FLAGS = new Set(["--yes", "--no-size", "--purge-backup"]);
function cmdMigrate(args) {
    const policy = (0, policy_1.loadPolicy)();
    const dir = args.find((a) => !a.startsWith("--") && !MIGRATE_VALUE_FLAGS.has(a));
    if (!dir) {
        process.stderr.write("用法: agent-disk-guard migrate <dir> [--yes]\n");
        return 1;
    }
    if (hasFlag(args, "--purge-backup")) {
        const r = (0, migrate_1.purgeBackup)(dir, hasFlag(args, "--yes"));
        process.stdout.write(r.message + "\n");
        return r.ok ? 0 : 1;
    }
    const planned = (0, migrate_1.planMigration)(dir, policy, !hasFlag(args, "--no-size"));
    if (!planned.ok || !planned.plan) {
        process.stdout.write(`❌ ${planned.message}\n`);
        return 1;
    }
    process.stdout.write(`== 迁移计划（dry-run）==\n源:   ${planned.plan.source}\n目标: ${planned.plan.dest}\n备份: ${planned.plan.backupPath}\n`);
    for (const w of planned.plan.warnings)
        process.stdout.write(`⚠️  ${w}\n`);
    process.stdout.write("步骤:\n");
    for (const s of planned.plan.steps)
        process.stdout.write(`  - ${s}\n`);
    if (!hasFlag(args, "--yes")) {
        process.stdout.write("\n以上为预演，未做任何修改。确认无误后加 --yes 执行。\n");
        return 0;
    }
    const r = (0, migrate_1.executeMigration)(planned.plan, true);
    process.stdout.write((r.ok ? "✅ " : "❌ ") + r.message + "\n");
    (0, logger_1.logInfo)("migrate", { source: planned.plan.source, ok: r.ok, message: r.message });
    return r.ok ? 0 : 1;
}
function cmdRollback(args) {
    const dir = args.find((a) => !a.startsWith("--") && a !== "--yes" && a !== "--no-size");
    if (!dir) {
        process.stderr.write("用法: agent-disk-guard rollback <dir> [--yes]\n");
        return 1;
    }
    const confirm = hasFlag(args, "--yes");
    const r = (0, migrate_1.rollbackMigration)(dir, confirm, !hasFlag(args, "--no-size"));
    if (r.plan) {
        process.stdout.write(`== 回滚计划${confirm ? "（执行）" : "（dry-run）"} ==\n${r.plan.steps.map((s) => "  - " + s).join("\n")}\n`);
        for (const w of r.plan.warnings)
            process.stdout.write(`⚠️  ${w}\n`);
    }
    process.stdout.write((r.ok ? (confirm ? "✅ " : "以上为预演，未做任何修改。") : "❌ ") + r.message + "\n");
    return r.ok ? 0 : 1;
}
function cmdMonitor(args) {
    const policy = (0, policy_1.loadPolicy)();
    if (!policy.monitor.enabled) {
        process.stdout.write("monitor 已在策略中禁用\n");
        return 0;
    }
    const asJson = hasFlag(args, "--json");
    const once = !hasFlag(args, "--watch");
    const intervalMin = parseInt(argValue(args, "--interval-min", "10"), 10);
    const runOnce = () => {
        const s = (0, monitor_1.checkDisk)(policy);
        const line = (0, monitor_1.statusLine)(s);
        if (asJson)
            process.stdout.write(JSON.stringify(s) + "\n");
        else
            process.stdout.write(new Date().toISOString() + "  " + line + "\n");
        if (s.level === "critical") {
            const cands = (0, monitor_1.suggestCleanup)(policy, false);
            for (const a of (0, monitor_1.cleanupAdvice)(cands.slice(0, 8)))
                process.stdout.write("  " + a + "\n");
            (0, logger_1.logInfo)("monitor critical", { free: s.freeBytes });
        }
        return s;
    };
    if (once) {
        const s = runOnce();
        return s.level === "critical" ? 2 : 0;
    }
    // watch 模式
    process.stdout.write(`进入 watch 模式，每 ${intervalMin} 分钟检查一次（Ctrl+C 退出）\n`);
    const tick = () => {
        try {
            runOnce();
        }
        catch (e) {
            process.stderr.write(String(e) + "\n");
        }
    };
    tick();
    const timer = setInterval(tick, Math.max(1, intervalMin) * 60 * 1000);
    const stop = () => {
        clearInterval(timer);
        process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return 0;
}
function cmdDoctor() {
    const policy = (0, policy_1.loadPolicy)();
    const checks = [];
    const pf = (0, policy_1.resolvePolicyFilePath)();
    checks.push(["策略文件可读", !!pf, pf ?? "使用内置默认策略"]);
    const root = (0, util_1.normalizePath)(policy.redirectRoot);
    let rootOk = false;
    try {
        fs.mkdirSync(root, { recursive: true });
        const probe = path.join(root, ".adg-probe");
        fs.writeFileSync(probe, "ok");
        fs.unlinkSync(probe);
        rootOk = true;
    }
    catch {
        rootOk = false;
    }
    checks.push([`redirectRoot 可写 (${root})`, rootOk, rootOk ? "ok" : "请确认盘符存在且有写权限"]);
    const nodeOk = typeof process.versions.node === "string";
    checks.push(["Node 运行时", nodeOk, process.versions.node ?? ""]);
    const rb = (0, util_1.execSync)("robocopy.exe", ["/?"], { timeoutMs: 10000 });
    checks.push(["robocopy 可用", rb.status !== null, `退出码 ${rb.status}（robocopy 帮助退出码非零属正常）`]);
    const ml = (0, util_1.execSync)("cmd.exe", ["/c", "mklink", "/?"], { timeoutMs: 10000 });
    checks.push(["mklink 可用", ml.stdout.length > 0 || ml.status === 1, ""]);
    const hookJs = path.join(__dirname, "hook.js");
    checks.push(["hook.js 存在", fs.existsSync(hookJs), hookJs]);
    for (const [name, ok, detail] of checks) {
        process.stdout.write(`${ok ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}\n`);
    }
    return checks.every((c) => c[1]) ? 0 : 1;
}
function cmdExec(args) {
    const policy = (0, policy_1.loadPolicy)();
    const dd = args.indexOf("--");
    if (dd < 0 || dd + 1 >= args.length) {
        process.stderr.write("用法: agent-disk-guard exec -- <command...>\n");
        return 1;
    }
    const command = args.slice(dd + 1).join(" ");
    const decision = (0, guard_1.evaluateToolCall)("Bash", { command }, policy);
    if (decision.action === "deny" || (decision.action === "ask" && !hasFlag(args, "--yes"))) {
        process.stdout.write((decision.action === "deny" ? "🚫 已拦截: " : "⚠️ 需确认: ") + (decision.reason ?? "") + "\n");
        return 2;
    }
    const finalCommand = decision.updatedInput && typeof decision.updatedInput.command === "string" ? decision.updatedInput.command : command;
    if (finalCommand !== command) {
        process.stdout.write(`♻️ 已改写为: ${finalCommand}\n`);
    }
    // 注入环境变量后执行
    const env = { ...process.env, AGENTDISKGUARD_ACTIVE: "1" };
    for (const v of (0, envplan_1.buildEnvPlan)(policy))
        env[v.name] = v.value;
    env.MAVEN_OPTS = (0, envplan_1.mergeMavenOpts)(process.env.MAVEN_OPTS, policy);
    const r = (0, util_1.execSync)(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", finalCommand], {
        timeoutMs: 30 * 60 * 1000,
    });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    return r.status ?? 1;
}
function main(argv) {
    (0, logger_1.configureLogging)({ stderr: "error", file: "info" });
    const [cmd, ...rest] = argv;
    if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
        process.stdout.write(usage() + "\n");
        return 0;
    }
    switch (cmd) {
        case "status":
            return cmdStatus(rest);
        case "check":
            return cmdCheck(rest);
        case "env":
            return cmdEnv(rest);
        case "migrate":
            return cmdMigrate(rest);
        case "rollback":
            return cmdRollback(rest);
        case "monitor":
            return cmdMonitor(rest);
        case "doctor":
            return cmdDoctor();
        case "exec":
            return cmdExec(rest);
        default:
            process.stderr.write(`未知子命令: ${cmd}\n\n` + usage() + "\n");
            return 1;
    }
}
// 直接运行 dist/cli.js 时执行
if (require.main === module) {
    const code = main(process.argv.slice(2));
    (0, logger_1.logInfo)("cli 退出", { code });
    process.exit(code);
}
