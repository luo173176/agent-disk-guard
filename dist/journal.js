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
exports.journalFile = journalFile;
exports.appendEntry = appendEntry;
exports.readEntries = readEntries;
exports.latestStateFor = latestStateFor;
/**
 * AgentDiskGuard — 操作日志（journal）与回滚。
 * 所有迁移/回滚动作先记 journal（JSONL，追加式），保证可审计、可回滚。
 * journal 刻意放在 C 盘数据目录：即使 D 盘损坏，回滚信息仍然可用。
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const util_1 = require("./util");
function journalFile() {
    return process.env.AGENTDISKGUARD_JOURNAL || path.join((0, util_1.dataDir)(), "journal.jsonl");
}
function appendEntry(entry) {
    fs.mkdirSync(path.dirname(journalFile()), { recursive: true });
    fs.appendFileSync(journalFile(), JSON.stringify(entry) + "\n", "utf8");
}
/** 读取全部 journal 条目（跳过损坏行）。 */
function readEntries() {
    const out = [];
    let raw = "";
    try {
        raw = fs.readFileSync(journalFile(), "utf8");
    }
    catch {
        return out;
    }
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch {
            /* 忽略损坏行 */
        }
    }
    return out;
}
/**
 * 查找某路径链上的最新**结构性**状态（迁移 / 回滚）。
 *
 * 注意：`purge-backup`（清理备份）不是结构变更，必须跳过——否则清理过备份之后
 * `latestStateFor` 会返回 purge 条目，让"该目录已迁移过"的历史凭空消失，回滚无从判断。
 * 备份是否还在，由调用方按 backupPath 自行探测。
 */
function latestStateFor(source) {
    const key = source.toLowerCase();
    const hits = readEntries().filter((e) => e.source.toLowerCase() === key && e.op !== "purge-backup");
    return hits[hits.length - 1];
}
