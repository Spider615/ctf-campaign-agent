import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { ParsedAttachment } from "../../app/lib/attachments/types.ts";
import { TurnCancelledError, throwIfTurnCancelled } from "../../app/lib/cancellation.ts";

const script = fileURLToPath(new URL("./parse.py", import.meta.url));
type Runtime = { python: string; packages: string[] };
const runtimes = new Map<string, Runtime>();
export function attachmentPython() { const installed = join(homedir(), "Library/Application Support/ctf-campaign-agent/attachment-python/bin/python3"); return process.env.ATTACHMENTS_PYTHON || (existsSync(installed) ? installed : "python3"); }
export function attachmentOffice() {
  const installed = join(homedir(), "Library/Application Support/ctf-campaign-agent/attachment-office/LibreOffice.app/Contents/MacOS/soffice");
  const requested = process.env.ATTACHMENTS_LIBREOFFICE || (existsSync(installed) ? installed : "soffice");
  const located = isAbsolute(requested) ? requested : (process.env.PATH ?? "").split(delimiter).map((path) => join(path, requested)).find(existsSync);
  if (!located || !existsSync(located)) return requested;
  const executable = realpathSync(located);
  // 内置运行时的命令是脚本入口；直接使用同一依赖包内的原生程序以便精确授权。
  const bundled = join(dirname(executable), "../../native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/MacOS/soffice");
  return process.platform === "darwin" && executable.endsWith("/bin/override/soffice") && existsSync(bundled) ? realpathSync(bundled) : executable;
}

function runtime(python: string): Runtime {
  const known = runtimes.get(python); if (known) return known;
  const probe = spawnSync(python, ["-c", "import json,sys,site;print(json.dumps(dict(python=sys.executable,packages=site.getsitepackages()+[site.getusersitepackages()])))"], { encoding: "utf8", timeout: 10000 });
  if (probe.status !== 0) throw new Error("文件解析 Python 不可用，请运行 npm run install:attachments");
  const result = JSON.parse(probe.stdout) as Runtime;
  result.python = realpathSync(result.python); result.packages = result.packages.filter((path) => isAbsolute(path) && existsSync(path));
  runtimes.set(python, result); return result;
}

export async function parseAttachment(input: string, output: string, name: string, signal: AbortSignal, python = attachmentPython()): Promise<ParsedAttachment> {
  // Office 本地进程管道有路径长度上限，临时目录独立且只属于本次任务。
  const scratch = await mkdtemp(process.platform === "darwin" ? "/private/tmp/ctf-file-" : "/tmp/ctf-file-");
  try { return await parseInSandbox(input, output, name, signal, python, scratch); }
  finally { await rm(scratch, { recursive: true, force: true, maxRetries: 3 }); }
}

async function parseInSandbox(input: string, output: string, name: string, signal: AbortSignal, python: string, scratch: string): Promise<ParsedAttachment> {
  throwIfTurnCancelled(signal); await mkdir(output, { recursive: true, mode: 0o700 });
  input = realpathSync(input); output = realpathSync(output);
  const selected = runtime(python); let executable: string; let args: string[];
  if (process.platform === "darwin") {
    executable = "/usr/bin/sandbox-exec";
    const quote = (value: string) => JSON.stringify(value);
    // macOS 系统框架需要读取系统运行时；用户文件与临时目录另行禁止，例外只含本任务和解析依赖。
    const office = attachmentOffice();
    const officeExecutable = isAbsolute(office) && existsSync(office) ? realpathSync(office) : undefined;
    const appBoundary = officeExecutable?.lastIndexOf(".app/Contents/MacOS/") ?? -1;
    const officeDirectory = officeExecutable ? appBoundary >= 0 ? officeExecutable.slice(0, appBoundary + 4) : dirname(officeExecutable) : undefined;
    const readable = [dirname(script), dirname(dirname(selected.python)), ...selected.packages, output, scratch, ...(officeDirectory ? [officeDirectory] : [])];
    const exceptions = `${readable.map((path) => `(require-not (subpath ${quote(path)}))`).join(" ")} (require-not (literal ${quote(realpathSync(input))}))`;
    const parents = new Set<string>();
    for (const path of [...readable, input]) for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) parents.add(parent);
    const metadata = `${exceptions} ${[...parents].map((path) => `(require-not (literal ${quote(path)}))`).join(" ")}`;
    const profile = `(version 1)(allow default)(deny network*)(allow network-bind network-inbound (local unix-socket (path-prefix ${quote(scratch + "/")})))${["/Users", "/private/var/folders", "/private/tmp", "/Volumes"].map((root) => `(deny file-read-data (require-all (subpath ${quote(root)}) ${metadata}))(deny file-read-metadata (require-all (subpath ${quote(root)}) ${metadata}))`).join("")}(deny file-write* (require-all (require-not (subpath ${quote(output)})) (require-not (subpath ${quote(scratch)})) (require-not (literal "/dev/null"))))`;
    args = ["-p", profile, selected.python, script, input, output, name];
  } else if (process.platform === "linux") {
    executable = selected.python;
    args = [fileURLToPath(new URL("./sandbox.py", import.meta.url)), script, input, output, name, JSON.stringify(selected.packages), scratch];
  } else throw new Error("文件解析隔离器不可用；当前支持 macOS Seatbelt 与 Linux Landlock/seccomp");
  const locale = process.platform === "linux" ? "C.UTF-8" : "en_US.UTF-8";
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: output, TMPDIR: scratch, LANG: locale, LC_ALL: locale, PYTHONPATH: selected.packages.join(":"), PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1", MAX_CONCURRENCY: "1", SAL_USE_VCLPLUGIN: "svp", SAL_DISABLE_OPENCL: "1", ATTACHMENTS_LIBREOFFICE: attachmentOffice() };
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: output, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stderr = ""; let stdoutSize = 0; let ended = false; let timedOut = false; let memoryExceeded = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } } };
    const abort = () => { kill(); };
    const timeout = setTimeout(() => { timedOut = true; kill(); }, 120000);
    const memoryCheck = process.platform === "darwin" ? setInterval(() => {
      if (!child.pid || ended) return;
      const usage = spawnSync("/bin/ps", ["-axo", "pgid=,rss="], { encoding: "utf8", timeout: 1000 });
      const total = usage.stdout?.trim().split("\n").reduce((sum, line) => { const [group, rss] = line.trim().split(/\s+/).map(Number); return sum + (group === child.pid ? rss : 0); }, 0) ?? 0;
      if (total > 512 * 1024) { memoryExceeded = true; kill(); }
    }, 500) : undefined;
    const finish = (error?: Error) => { if (ended) return; ended = true; clearTimeout(timeout); clearInterval(memoryCheck); signal.removeEventListener("abort", abort); if (error) reject(error); else resolve(); };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data: Buffer) => { stdoutSize += data.length; if (stdoutSize > 65536) kill(); });
    child.stderr.on("data", (data: Buffer) => { if (stderr.length < 6000) stderr += data.toString("utf8").slice(0, 6000 - stderr.length); });
    child.on("error", () => finish(new Error("无法启动文件解析隔离进程")));
    child.on("close", (code, processSignal) => {
      kill(); // 同组转换器不能在解析结束后继续驻留。
      if (code !== 0) { try { writeFileSync(join(output, "parser-error.txt"), `code=${code}, signal=${processSignal}\n${stderr}`, { mode: 0o600 }); } catch { /* 诊断只保存在私有任务目录。 */ } }
      if (signal.aborted) finish(new TurnCancelledError());
      else if (memoryExceeded) finish(new Error("文件解析超过 512 MiB 内存限额，请拆分文件后重试"));
      else if (timedOut) finish(new Error("文件解析超过单任务资源时限，可以缩小文件后重试"));
      else if (code !== 0) finish(new Error(/Operation not permitted|permission|bwrap|sandbox/i.test(stderr) ? "文件解析隔离器启动失败，请检查运行环境的隔离权限" : /No module named/.test(stderr) ? "文件解析依赖缺失，请运行 npm run install:attachments" : "文件解析进程未完成，文件可能损坏或超过资源限制"));
      else finish();
    });
    if (signal.aborted) abort();
  });
  throwIfTurnCancelled(signal);
  const raw = await readFile(join(output, "parsed.json"));
  if (raw.length > 64 * 1024 * 1024) throw new Error("文件解析结果超过资源限额");
  const result = JSON.parse(raw.toString("utf8")) as ParsedAttachment;
  if (!Array.isArray(result.blocks) || !Array.isArray(result.tables) || !Array.isArray(result.images)) throw new Error("文件解析结果格式不正确");
  return result;
}
