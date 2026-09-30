/** 构建后自检：确认 hook/session-check/cli 三个入口都已产出。 */
import * as fs from "fs";
import * as path from "path";

const dist = path.join(process.cwd(), "dist");
const required = ["hook.js", "session-check.js", "cli.js", "index.js"];
let ok = true;
for (const f of required) {
  const p = path.join(dist, f);
  const exists = fs.existsSync(p);
  if (!exists) ok = false;
  console.log(`${exists ? "✅" : "❌"} dist/${f}`);
}
process.exit(ok ? 0 : 1);
