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
exports.logError = exports.logWarn = exports.logInfo = exports.logDebug = void 0;
exports.configureLogging = configureLogging;
exports.log = log;
/**
 * AgentDiskGuard — 轻量日志。
 * 日志写入数据目录（KB 级文本），并按需镜像到 stderr。
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const util_1 = require("./util");
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let minStderrLevel = LEVELS.warn; // hook 模式下 stderr 不会干扰 stdout JSON，但保持安静
let minFileLevel = LEVELS.info;
function configureLogging(opts = {}) {
    if (opts.stderr)
        minStderrLevel = opts.quiet ? 99 : LEVELS[opts.stderr];
    if (opts.file)
        minFileLevel = LEVELS[opts.file];
}
function logFile() {
    return path.join((0, util_1.dataDir)(), "agent-disk-guard.log");
}
function log(level, msg, extra) {
    const line = new Date().toISOString() +
        ` [${level.toUpperCase()}] ` +
        msg +
        (extra ? " " + JSON.stringify(extra) : "");
    if (LEVELS[level] >= minStderrLevel) {
        process.stderr.write(line + "\n");
    }
    if (LEVELS[level] >= minFileLevel) {
        try {
            (0, util_1.ensureDir)((0, util_1.dataDir)());
            fs.appendFileSync(logFile(), line + "\n", "utf8");
            // 防止日志无限膨胀：超过 2MB 轮转保留一份
            const st = fs.statSync(logFile());
            if (st.size > 2 * 1024 * 1024) {
                fs.renameSync(logFile(), logFile() + ".1");
            }
        }
        catch {
            /* 日志失败不影响主流程 */
        }
    }
}
const logDebug = (m, e) => log("debug", m, e);
exports.logDebug = logDebug;
const logInfo = (m, e) => log("info", m, e);
exports.logInfo = logInfo;
const logWarn = (m, e) => log("warn", m, e);
exports.logWarn = logWarn;
const logError = (m, e) => log("error", m, e);
exports.logError = logError;
