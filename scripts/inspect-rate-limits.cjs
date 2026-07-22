const { spawn } = require("node:child_process");
const readline = require("node:readline");

const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true
});
const timeout = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
}, 10_000);
const lines = readline.createInterface({ input: child.stdout });
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id !== 2) return;
  clearTimeout(timeout);
  process.stdout.write(JSON.stringify(message, null, 2));
  child.kill();
});
child.stdin.write(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { clientInfo: { name: "VSCode Codex Tracker diagnostics", version: "1.5.1" }, capabilities: { experimentalApi: true } }
}) + "\n");
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: null }) + "\n");
