import { spawn } from "node:child_process";

// 本地一起启动 Agent 服务和页面；任意一个退出，另一个也停掉。
const windows = process.platform === "win32";
const children = ["dev:agent", "dev"].map((script) =>
  spawn(windows ? "npm.cmd" : "npm", ["run", script], { stdio: "inherit", shell: windows }),
);

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  process.exitCode = code ?? 0;
}

for (const child of children) child.on("exit", (code) => stop(code));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
