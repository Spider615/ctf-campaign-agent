import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { attachmentOffice, attachmentPython, parseAttachment } from "../agent/attachments/parser.ts";

test("PDF 扫描页、HEIC 与常用压缩格式真实解析，脚本空页面明确失败", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ctf-file-formats-")); t.after(() => rm(root, { recursive: true, force: true }));
  const generated = spawnSync(attachmentPython(), ["tests/helpers/attachment-fixtures.py", join(root, "fixtures")], { encoding: "utf8" }); assert.equal(generated.status, 0, generated.stderr);
  const parse = (name: string) => parseAttachment(join(root, "fixtures", name), join(root, name + "-parsed"), name, new AbortController().signal);
  for (const name of ["扫描.pdf", "物料.heic"]) {
    const parsed = await parse(name); assert.ok(["ready", "partial"].includes(parsed.status), JSON.stringify(parsed.warnings)); assert.ok(parsed.images.length > 0); assert.equal(parsed.images[0].mime, "image/jpeg");
  }
  for (const name of ["销售.csv.gz", "销售.csv.bz2", "销售.csv.xz", "资料.tar.gz", "资料.7z"]) {
    const parsed = await parse(name); assert.equal(parsed.status, "ready", JSON.stringify(parsed.warnings)); assert.equal(parsed.tables[0].rows.length, 3); assert.match(parsed.tables[0].archivePath ?? "", /销售\.csv|data\.csv/);
  }
  const empty = await parse("空页面.html"); assert.equal(empty.status, "failed"); assert.match(empty.warnings.join("；"), /没有可读取正文/);
});

test("旧 DOC PPT XLS 在同一个隔离边界内转换后保留可读位置", async (t) => {
  const office = attachmentOffice(); const available = spawnSync(office, ["--version"], { encoding: "utf8", timeout: 10000 });
  if (available.status !== 0) { t.skip("未安装 LibreOffice，完整部署镜像中必须执行此项"); return; }
  const root = await mkdtemp(join(tmpdir(), "ctf-legacy-formats-")); t.after(() => rm(root, { recursive: true, force: true }));
  const generated = spawnSync(attachmentPython(), ["tests/helpers/attachment-fixtures.py", join(root, "fixtures"), "--legacy"], { encoding: "utf8", env: { ...process.env, ATTACHMENTS_LIBREOFFICE: office }, timeout: 140000 }); assert.equal(generated.status, 0, generated.stderr);
  for (const name of ["方案.doc", "活动.ppt", "销售.xls"]) {
    const output = join(root, name + "-parsed"); const parsed = await parseAttachment(join(root, "fixtures", name), output, name, new AbortController().signal);
    const diagnosis = await readFile(join(output, "parser-details.txt"), "utf8").catch(() => "");
    assert.ok(["ready", "partial"].includes(parsed.status), `${name}: ${parsed.warnings.join("；")} ${diagnosis}`); assert.ok(parsed.blocks.length > 0);
  }
});
