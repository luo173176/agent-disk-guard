#!/usr/bin/env node
/** AgentDiskGuard CLI 启动器（npm bin 入口）。 */
try {
  const cli = require("../dist/cli.js");
  // dist/cli.js 直接运行时有 require.main 守卫；经本 shim require 时需显式调用 main
  if (typeof cli.main === "function") {
    process.exit(cli.main(process.argv.slice(2)) ?? 0);
  }
  throw new Error("dist/cli.js 缺少 main 导出，请重新构建: npm run build");
} catch (e) {
  process.stderr.write("AgentDiskGuard CLI 启动失败（是否尚未构建？在插件目录运行: npm install && npm run build）\n" + String(e && e.message ? e.message : e) + "\n");
  process.exit(1);
}
