import { spawn } from "node:child_process";

try { process.loadEnvFile(".env.local"); }
catch (error) { if (error?.code !== "ENOENT") throw error; }

const children = [
  spawn(process.execPath, ["scripts/local-broker.mjs"], { stdio: "inherit", env: process.env }),
  spawn("npm", ["run", "dev:web"], { stdio: "inherit", env: process.env }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 200).unref();
}

for (const child of children) child.on("exit", (code) => { if (!stopping && code !== 0) stop(code || 1); });
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
