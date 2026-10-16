import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const environment = join(homedir(), "Library/Application Support/ctf-campaign-agent/attachment-python");
const python = join(environment, "bin/python3");
const uv = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;
const run = (program, args) => { const result = spawnSync(program, args, { stdio: "inherit" }); if (result.error || result.status !== 0) process.exit(result.status || 1); };
mkdirSync(dirname(environment), { recursive: true });
if (!existsSync(python)) {
  if (uv) run("uv", ["venv", "--python", "3.11", environment]);
  else run("python3", ["-m", "venv", environment]);
}
const requirements = join(root, "agent/attachments/requirements.txt");
if (uv) run("uv", ["pip", "install", "--python", python, "-r", requirements]);
else run(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirements]);
if (process.platform === "linux") {
  const site = spawnSync(python, ["-c", "import sysconfig;print(sysconfig.get_paths()['purelib'])"], { encoding: "utf8" });
  if (site.status !== 0) process.exit(1);
  run("cc", ["-shared", "-fPIC", "-O2", join(root, "agent/attachments/office-socket.c"), "-o", join(site.stdout.trim(), "attachment_office_socket.so"), "-ldl"]);
}
console.log(`附件解析依赖已安装：${python}`);
console.log("旧 Office、页面渲染和本地 OCR 还需 LibreOffice、Poppler、Tesseract；可运行 npm run check:attachments 检查。");
