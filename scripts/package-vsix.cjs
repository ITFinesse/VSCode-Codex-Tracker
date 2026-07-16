const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { copyFileSync } = require("node:fs");

copyFileSync(
  join(__dirname, "..", "node_modules", "chart.js", "dist", "chart.umd.js"),
  join(__dirname, "..", "resources", "chart.umd.js")
);

const result = spawnSync("cmd.exe", ["/d", "/c", join(__dirname, "package-vsix.cmd")], { stdio: "inherit" });

if (result.error) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
