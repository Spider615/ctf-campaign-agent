import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachmentPython, parseAttachment } from "../agent/attachments/parser.ts";
import { createAttachmentStore } from "../agent/attachments/store.ts";
import { createReadStream } from "node:fs";

async function fixtures(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "ctf-parser-adversarial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generated = spawnSync(attachmentPython(), ["-c", `import pathlib,sys,zipfile
from openpyxl import Workbook
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(root/'empty-member.zip','w') as z:
 z.writestr('readable.txt','可读正文')
 z.writestr('empty.html','<html><body><script>财务金额900元</script></body></html>')
with zipfile.ZipFile(root/'damaged-member.zip','w') as z:
 z.writestr('first.txt','第一份正文')
 z.writestr('damaged.txt',b'bad-member-payload')
 z.writestr('last.txt','最后一份正文')
data=(root/'damaged-member.zip').read_bytes();data=data.replace(b'bad-member-payload',b'BAD-member-payload',1);(root/'damaged-member.zip').write_bytes(data)
for name,rows in [('formula-only',[['金额'],['=1+2']]),('numeric-text',[['甲','100'],['乙','200']]),('merged-numeric',[['地区','金额'],[None,'100'],['甲',200]]),('merged-formula',[['地区','金额'],[None,'=1+2'],['甲',200]])]:
 book=Workbook();sheet=book.active
 for row in rows:sheet.append(row)
 if name.startswith('merged-'):sheet.merge_cells('A1:A2')
 book.save(root/(name+'.xlsx'))
 with zipfile.ZipFile(root/(name+'.xlsx')) as z:content={n:z.read(n) for n in z.namelist()}
 with zipfile.ZipFile(root/(name+'-large.xlsx'),'w',zipfile.ZIP_DEFLATED) as z:
  for member,value in content.items():z.writestr(member,value)
  z.writestr('xl/padding.xml',b' '*(17*1024*1024))
(root/'broken-quotes.csv').write_text('门店,金额\\n甲,10\\n"乙,20\\n丙,30\\n',encoding='utf-8')
`, root], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  return { root, parse: (name: string) => parseAttachment(join(root, name), join(root, name + "-parsed"), name, new AbortController().signal) };
}

test("混合压缩包的无正文页面标记失败，不冒充完整覆盖", async (t) => {
  const { parse } = await fixtures(t); const parsed = await parse("empty-member.zip");
  assert.equal(parsed.status, "partial");
  assert.equal(parsed.entries.find((entry) => entry.path === "empty.html")?.status, "failed");
  assert.match(parsed.entries.find((entry) => entry.path === "empty.html")?.detail ?? "", /没有可读取正文/);
});

test("损坏压缩成员保留失败条目并继续读取后续合法成员", async (t) => {
  const { parse } = await fixtures(t); const parsed = await parse("damaged-member.zip");
  assert.equal(parsed.status, "partial");
  assert.equal(parsed.entries.find((entry) => entry.path === "damaged.txt")?.status, "failed");
  assert.equal(parsed.entries.find((entry) => entry.path === "last.txt")?.status, "ready");
  assert.match(JSON.stringify(parsed.blocks), /最后一份正文/);
});

test("大小 Excel 中只有缺失公式缓存的行仍保留原始位置和缺值", async (t) => {
  const { root } = await fixtures(t); const store = createAttachmentStore({ directory: join(root, "private") });
  t.after(() => store.close()); const scope = { owner: crypto.randomUUID(), conversationId: crypto.randomUUID() };
  for (const name of ["formula-only.xlsx", "formula-only-large.xlsx"]) {
    const item = await store.upload(scope, { name, body: createReadStream(join(root, name)) });
    await store.prepare(scope, [item.id]);
    const { document } = await store.document(scope, item.id);
    assert.equal(document.status, "partial");
    const rows = []; for await (const row of store.rows(scope, item.id, document.tables[0].id)) rows.push(row);
    assert.deepEqual(rows.map((row) => [row.rowNumber, row.values]), [[2, [null]]], name);
  }
});

test("大小 Excel 的文本型数字首行不能被吞成未经确认的表头", async (t) => {
  const { root } = await fixtures(t); const store = createAttachmentStore({ directory: join(root, "private") });
  t.after(() => store.close()); const scope = { owner: crypto.randomUUID(), conversationId: crypto.randomUUID() };
  for (const name of ["numeric-text.xlsx", "numeric-text-large.xlsx"]) {
    const item = await store.upload(scope, { name, body: createReadStream(join(root, name)) }); await store.prepare(scope, [item.id]);
    const { document } = await store.document(scope, item.id); const table = document.tables[0];
    const rows = []; for await (const row of store.rows(scope, item.id, table.id)) rows.push(row);
    assert.deepEqual(rows.map((row) => row.rowNumber), [1, 2], name);
    assert.match(table.calculationBlocked ?? "", /表头|列含义/);
  }
});

test("CSV 未闭合引号明确失败，不能吞并后续记录后标为完整读取", async (t) => {
  const { parse } = await fixtures(t); const parsed = await parse("broken-quotes.csv");
  assert.equal(parsed.status, "failed"); assert.match(parsed.warnings.join("；"), /引号|CSV|格式/);
});

test("合并表头候选包含文本数字或公式时保留原始记录并阻止歧义汇总", async (t) => {
  const { root } = await fixtures(t); const store = createAttachmentStore({ directory: join(root, "private") });
  t.after(() => store.close()); const scope = { owner: crypto.randomUUID(), conversationId: crypto.randomUUID() };
  for (const name of ["merged-numeric.xlsx", "merged-numeric-large.xlsx", "merged-formula.xlsx", "merged-formula-large.xlsx"]) {
    const item = await store.upload(scope, { name, body: createReadStream(join(root, name)) }); await store.prepare(scope, [item.id]);
    const { document } = await store.document(scope, item.id); const table = document.tables[0];
    const rows = []; for await (const row of store.rows(scope, item.id, table.id)) rows.push(row);
    assert.deepEqual(rows.map((row) => row.rowNumber), [2, 3], name);
    assert.deepEqual(table.columns, ["地区", "金额"], name);
    assert.match(table.calculationBlocked ?? "", /合并|边界/);
  }
});

test("新版解析不覆盖旧成功来源，同内容重新上传使用独立新版本", async (t) => {
  const { root } = await fixtures(t); const directory = join(root, "private");
  const store = createAttachmentStore({ directory }); t.after(() => store.close());
  const scope = { owner: crypto.randomUUID(), conversationId: crypto.randomUUID() };
  const upload = () => store.upload(scope, { name: "formula-only.xlsx", body: createReadStream(join(root, "formula-only.xlsx")) });
  const first = await upload(); await store.prepare(scope, [first.id]);
  const metadata = join(directory, scope.owner, scope.conversationId, first.id, "metadata.json");
  const legacy = { ...JSON.parse(await readFile(metadata, "utf8")), parserVersion: "attachments/3", version: createHash("sha256").update(`${first.contentHash}/attachments/3`).digest("hex") };
  await writeFile(metadata, JSON.stringify(legacy));
  const retried = await store.retry(scope, first.id); assert.equal(retried.id, first.id); assert.equal(retried.version, legacy.version);
  const current = await upload(); assert.notEqual(current.id, first.id); assert.equal(current.parserVersion, "attachments/4"); assert.notEqual(current.version, legacy.version);
  assert.deepEqual(await store.get(scope, first.id), legacy);
});
