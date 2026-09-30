/** 构建后自检：入口文件存在且非空、CLI 可加载、包内 hooks 配置可用。 */
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const root = process.cwd();
const dist = path.join(root, "dist");
const required = ["hook.js", "session-check.js", "cli.js", "index.js"];

let ok = true;
function check(label, fn) {
  try {
    fn();
    console.log(`✅ ${label}`);
  } catch (e) {
    ok = false;
    console.log(`❌ ${label}  ${e && e.message ? e.message : e}`);
  }
}

for (const f of required) {
  check(`dist/${f}`, () => {
    const st = fs.statSync(path.join(dist, f));
    if (st.size === 0) throw new Error("文件为空");
  });
}

check("dist/cli.js 可加载并导出 main", () => {
  const m = require(path.join(dist, "cli.js"));
  if (typeof m.main !== "function") throw new Error("缺少 main 导出");
});

for (const cfgName of ["hooks/hooks.json"]) {
  check(`${cfgName} 含 PreToolUse 与 SessionStart`, () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, cfgName), "utf8"));
    const hooks = cfg.hooks || {};
    const pre = hooks.PreToolUse || hooks.preToolUse;
    const session = hooks.SessionStart || hooks.sessionStart;
    if (!Array.isArray(pre) || pre.length === 0) throw new Error("缺少 PreToolUse 配置");
    if (!Array.isArray(session) || session.length === 0) throw new Error("缺少 SessionStart 配置");
  });
}

console.log(ok ? "\n构建自检通过。" : "\n构建自检失败。");
process.exit(ok ? 0 : 1);
