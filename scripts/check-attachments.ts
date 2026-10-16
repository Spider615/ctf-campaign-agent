import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { attachmentOffice, parseAttachment } from "../agent/attachments/parser.ts";

const installed = join(homedir(), "Library/Application Support/ctf-campaign-agent/attachment-python/bin/python3");
const python = process.env.ATTACHMENTS_PYTHON || (existsSync(installed) ? installed : "python3");
const dependencies = spawnSync(python, ["-c", "import docx,pptx,openpyxl,pdfplumber,PIL,lxml,pillow_heif; print('文档解析依赖可用')"], { encoding: "utf8" });
if (dependencies.status !== 0) { console.error("附件解析依赖不完整，请运行 npm run install:attachments"); process.exit(1); }
console.log(dependencies.stdout.trim());
for (const [program, args] of [[attachmentOffice(), ["--version"]], ["pdftoppm", ["-v"]], ["tesseract", ["--list-langs"]]] as const) {
  const result = spawnSync(program, args as unknown as string[], { encoding: "utf8", timeout: 10000 });
  if (result.status !== 0) { console.error(`${program} 不可用，对应格式不能完整解析`); process.exitCode = 1; }
  else console.log(`${program} 可用`);
}
const directory = await mkdtemp(join(tmpdir(), "ctf-attachment-check-"));
try {
  const input = join(directory, "input"); await writeFile(input, "项目,金额\n合成验证,0.1\n");
  const parsed = await parseAttachment(input, join(directory, "parsed"), "检查.csv", new AbortController().signal, python);
  if (parsed.status !== "ready" || parsed.tables[0]?.rows[0]?.[1] !== "0.1") throw new Error("解析结果不正确");
  console.log("受限解析进程和实际 CSV 读取通过（未调用模型）");
} catch (error) { console.error(error instanceof Error ? error.message : "文件解析隔离器不可用"); process.exitCode = 1; }
finally { await rm(directory, { recursive: true, force: true }); }
