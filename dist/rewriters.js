"use strict";
/**
 * AgentDiskGuard — 命令改写器。
 * 对 npm/pip/yarn/uv/mvn/git clone 等常见包管理命令追加缓存/目标参数，
 * 使其写入 D 盘重定向目录。依赖已由 install.ps1 注入的用户环境变量时自动跳过（避免冗余参数）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.rewriteCommand = rewriteCommand;
const util_1 = require("./util");
const pathguard_1 = require("./pathguard");
/** 会写缓存的 npm 子命令；`npm run/test/ls` 之类不该被塞 --cache。 */
const NPM_CACHE_SUBCOMMANDS = new Set([
    "install",
    "i",
    "ci",
    "add",
    "a",
    "update",
    "up",
    "rebuild",
    "rb",
    "dedupe",
    "dd",
    "link",
    "ln",
    "exec",
    "x",
    "init",
    "create",
]);
/** 命令包装器：其首 token 不是真正的包管理命令，真正的命令在 -Command / -c 之后的字符串里。 */
const WRAPPERS = new Set(["pwsh", "powershell", "cmd", "bash", "sh", "zsh", "sudo", "env", "call"]);
/** 已由环境变量接管、无需注入命令行参数的工具（仅记录说明）。 */
const ENV_MANAGED_TOOLS = {
    pnpm: { env: "npm_config_store_dir", target: "pnpm-store" },
    conda: { env: "CONDA_PKGS_DIRS", target: "conda" },
    cargo: { env: "CARGO_HOME", target: "cargo" },
    rustup: { env: "RUSTUP_HOME", target: "rustup" },
    go: { env: "GOPATH", target: "go" },
    gradle: { env: "GRADLE_USER_HOME", target: "gradle" },
    docker: { env: "DOCKER_CONFIG", target: "docker" },
    ollama: { env: "OLLAMA_MODELS", target: "ollama\\models" },
    huggingface: { env: "HF_HOME", target: "huggingface" },
};
/** 按换行、&&、;、| 切分命令，保留分隔符；引号内的分隔符不算分隔符。 */
function splitSegments(cmd) {
    const parts = [];
    let cur = "";
    let quote = null;
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if (quote) {
            if (ch === quote)
                quote = null;
            cur += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            cur += ch;
            continue;
        }
        const two = cmd.slice(i, i + 2);
        if (two === "&&" || two === "||") {
            parts.push(cur, two);
            cur = "";
            i++;
            continue;
        }
        if (ch === "\n" || ch === ";" || (ch === "|" && cmd[i + 1] !== "|")) {
            parts.push(cur, ch);
            cur = "";
            continue;
        }
        cur += ch;
    }
    parts.push(cur);
    return parts;
}
const isSeparator = (s) => /^(\r?\n|&&|\|\||;|\|)$/.test(s);
/** 该 npm 调用是否会写缓存（子命令属于会下载/落盘的那批才算）。 */
function npmWritesCache(segment) {
    for (const t of segment.trim().split(/\s+/).slice(1)) {
        if (t.startsWith("-"))
            continue;
        if (NPM_CACHE_SUBCOMMANDS.has(t.toLowerCase()))
            return true;
    }
    return false;
}
/**
 * 取出包装器内层命令：`pwsh -Command "npm install"` → `npm install`。
 * 不是包装器、或没有 -Command/-c 参数时返回 null。
 */
function unwrapInner(segment) {
    const tool = firstToken(segment);
    if (!WRAPPERS.has(tool))
        return null;
    const m = segment.match(/(?:^|\s)(?:-command|-[a-z]*c|\/c)\s+([\s\S]+)$/i);
    if (!m)
        return null;
    let inner = m[1].trim();
    const q = inner[0];
    if (inner.length >= 2 && (q === '"' || q === "'") && inner.endsWith(q))
        inner = inner.slice(1, -1).trim();
    return inner || null;
}
/** 取出段内第一个可执行名（去引号、去 ./、忽略大小写、兼容 npm.cmd）。 */
function firstToken(segment) {
    const m = segment.trim().match(/^(?:"([^"]+)"|(\S+))/);
    if (!m)
        return "";
    const tok = (m[1] ?? m[2] ?? "").trim();
    return tok
        .replace(/^\.\//, "")
        .replace(/\.cmd$|\.exe$|\.bat$/i, "")
        .toLowerCase();
}
/** 段内是否已含某参数（前缀匹配 token）。 */
function hasFlag(segment, flag) {
    const esc = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\s)${esc}(=|\\s|$)`, "i").test(segment);
}
/** 环境变量已指向重定向根 → 无需再注入参数。 */
function envAlreadyRedirected(policy, envName, sub) {
    const v = process.env[envName];
    if (!v)
        return false;
    const want = (0, util_1.normalizePath)(`${policy.redirectRoot}\\${sub}`);
    return (0, util_1.normalizePath)((0, util_1.expandEnv)(v)).toLowerCase().startsWith(want.toLowerCase());
}
/** 在段尾追加参数（引号包裹路径）。 */
function appendFlag(segment, flagText) {
    const trimmed = segment.trimEnd();
    return `${trimmed} ${flagText}`;
}
/** 单段改写。 */
function rewriteSegment(segment, policy, notes) {
    const tool = firstToken(segment);
    if (!tool)
        return segment;
    const root = (0, util_1.normalizePath)(policy.redirectRoot);
    // npm / npm exec（npx）：--cache
    if ((tool === "npm" || tool === "npx" || tool === "npm-cli" || tool === "npmx") && !hasFlag(segment, "--cache")) {
        if (tool === "npm") {
            // 只有会写缓存的子命令才注入；`npm run test` / `npm ls` 之类保持原样
            if (!npmWritesCache(segment))
                return segment;
            if (envAlreadyRedirected(policy, "npm_config_cache", "npm-cache"))
                return segment;
            notes.push(`npm 缓存 → ${root}\\npm-cache`);
            return appendFlag(segment, `--cache "${root}\\npm-cache"`);
        }
        // npx 不传 --cache（会透传给被运行包），依赖环境变量
        if (!envAlreadyRedirected(policy, "npm_config_cache", "npm-cache")) {
            notes.push("npx 依赖 npm_config_cache 环境变量（请运行 install.ps1 或 agent-disk-guard env --set）");
        }
        return segment;
    }
    // pip / pip3：--cache-dir
    if ((tool === "pip" || tool === "pip3") && !hasFlag(segment, "--cache-dir")) {
        if (envAlreadyRedirected(policy, "PIP_CACHE_DIR", "pip"))
            return segment;
        notes.push(`pip 缓存 → ${root}\\pip`);
        return appendFlag(segment, `--cache-dir "${root}\\pip"`);
    }
    // uv / uvx：--cache-dir
    if ((tool === "uv" || tool === "uvx") && !hasFlag(segment, "--cache-dir")) {
        if (envAlreadyRedirected(policy, "UV_CACHE_DIR", "uv-cache"))
            return segment;
        notes.push(`uv 缓存 → ${root}\\uv-cache`);
        return appendFlag(segment, `--cache-dir "${root}\\uv-cache"`);
    }
    // yarn v1：--cache-folder
    if (tool === "yarn" && !hasFlag(segment, "--cache-folder") && !envAlreadyRedirected(policy, "YARN_CACHE_FOLDER", "yarn-cache")) {
        notes.push(`yarn 缓存 → ${root}\\yarn-cache`);
        return appendFlag(segment, `--cache-folder "${root}\\yarn-cache"`);
    }
    // maven：-Dmaven.repo.local
    if (tool === "mvn" && !hasFlag(segment, "-Dmaven.repo.local")) {
        notes.push(`maven 本地仓库 → ${root}\\m2\\repository`);
        return appendFlag(segment, `-Dmaven.repo.local="${root}\\m2\\repository"`);
    }
    // git clone：目标路径落在受保护位置时改写
    if (tool === "git") {
        const cloneIdx = segment.search(/\bclone\b/);
        if (cloneIdx >= 0) {
            const rest = segment.slice(cloneIdx).trim();
            const tokens = rest.match(/(?:"[^"]*"|\S+)+/g) || [];
            if (tokens.length >= 2) {
                const last = tokens[tokens.length - 1];
                const bare = last.replace(/^"|"$/g, "");
                // 最后一个 token 不是选项且形如路径（含 :\ 或以 \ / 开头）→ 视为克隆目标
                if (!bare.startsWith("-") && /(^|[A-Za-z]:)[\\/]/.test(bare)) {
                    const check = (0, pathguard_1.checkPath)(bare, policy);
                    if (check.protected && check.redirectPath) {
                        notes.push(`git clone 目标 ${bare} → ${check.redirectPath}`);
                        const rewritten = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                        return segment.replace(new RegExp(rewritten + "\\s*$"), `"${check.redirectPath}"`);
                    }
                }
            }
        }
        return segment;
    }
    // 环境变量接管的工具：只做提示
    const managed = ENV_MANAGED_TOOLS[tool];
    if (managed && !envAlreadyRedirected(policy, managed.env, managed.target)) {
        notes.push(`${tool} 依赖环境变量 ${managed.env}（请运行 install.ps1 或 agent-disk-guard env --set）`);
    }
    return segment;
}
/** 对整条命令执行改写。 */
function rewriteCommand(command, policy) {
    const notes = [];
    let unrewritable = false;
    const parts = splitSegments(command);
    const out = parts.map((seg) => {
        if (isSeparator(seg))
            return seg;
        const rewritten = rewriteSegment(seg, policy, notes);
        if (rewritten !== seg)
            return rewritten;
        // 段本身没被改写：若它是包装器（pwsh -Command "…"），检查引号里的内层命令。
        // 内层在引号中，字符串手术容易把命令拼坏，所以只报告不改写 —— 由调用方决定是否询问用户。
        const inner = unwrapInner(seg);
        if (inner) {
            const innerRw = rewriteCommand(inner, policy);
            if (innerRw.changed) {
                unrewritable = true;
                notes.push(`嵌套命令无法自动注入缓存参数（请显式加参数或改用目标盘路径）：${innerRw.notes.join("；")}`);
            }
        }
        return rewritten;
    });
    const result = out.join("");
    return { command: result, changed: result !== command, notes: [...new Set(notes)], unrewritable };
}
