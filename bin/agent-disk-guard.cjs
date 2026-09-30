#!/usr/bin/env node
/** AgentDiskGuard CLI 启动器（npm bin 入口）。 */
let cli;
try {
  cli = require("../dist/cli.js");
} catch (e) {
  process.stderr.write(
    "AgentDiskGuard CLI 启动失败（是否尚未构建？在插件目录运行: npm install && npm run build）\n" +
      String(e && e.message ? e.message : e) +
      "\n"
  );
  process.exit(1);
}
if (typeof cli.main !== "function") {
  process.stderr.write("dist/cli.js 缺少 main 导出，请重新构建: npm run build\n");
  process.exit(1);
}
// 用 exitCode 而不是 process.exit()：后者会截断还没刷完的 stdout 管道（status/env 输出较长时可见）。
process.exitCode = cli.main(process.argv.slice(2)) ?? 0;
