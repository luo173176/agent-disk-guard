#!/usr/bin/env node
/** AgentDiskGuard CLI 启动器（npm bin 入口）。 */
try {
  require("../dist/cli.js");
} catch (e) {
  process.stderr.write("AgentDiskGuard 尚未构建。请在插件目录运行: npm install && npm run build\n" + String(e) + "\n");
  process.exit(1);
}
