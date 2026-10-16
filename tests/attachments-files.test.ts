import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import test from "node:test";
import { createAttachmentStore } from "../agent/attachments/store.ts";
import { createAttachmentTools } from "../agent/attachments/tools.ts";
import { attachmentPython } from "../agent/attachments/parser.ts";

const owner = "11111111-1111-4111-8111-111111111111"; const conversationId = "22222222-2222-4222-8222-222222222222"; const scope = { owner, conversationId };
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "ctf-attachments-test-")); const fixtures = join(directory, "fixtures");
  const generated = spawnSync(attachmentPython(), ["tests/helpers/attachment-fixtures.py", fixtures], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const store = createAttachmentStore({ directory: join(directory, "private") });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const upload = async (name: string) => {
    const item = await store.upload(scope, { name, body: Readable.from([await readFile(join(fixtures, name))]) });
    for (let n = 0; n < 300; n++) { const latest = await store.get(scope, item.id); if (!["queued", "processing"].includes(latest.status)) return latest; await new Promise((resolve) => setTimeout(resolve, 30)); }
    throw new Error("合成附件解析没有结束");
  };
  return { directory, store, upload };
}

test("真实 CSV 保留前导零和引号换行，计算覆盖全表且缺值不补零", async (t) => {
  const { store, upload } = await setup(t); const item = await upload("销售.csv"); assert.equal(item.status, "ready", item.error);
  const tools = createAttachmentTools(store, scope, [item.id]); const listed = await tools.list();
  assert.equal(listed[0].tables[0].rows, 3);
  const page = await tools.read({ attachmentId: item.id, offset: 0, limit: 20 });
  assert.match(JSON.stringify(page), /001/); assert.match(JSON.stringify(page), /含换行/);
  const sum = await tools.calculate({ attachmentId: item.id, tableId: listed[0].tables[0].id, operation: "sum", column: "实收" });
  assert.ok("value" in sum);
  assert.equal(sum.value, "0.3"); assert.equal(sum.missingRows, 1); assert.equal(sum.matchedRows, 3);
  assert.match(tools.sources().at(-1)!.excerpt, /0\.3/);
});

test("无明确表头的 CSV 和 TSV 保留首行及原始行号，歧义解除前不能汇总", async (t) => {
  const { store, upload } = await setup(t);
  for (const [name, firstRow] of [["无表头.csv", ["100"]], ["无表头.tsv", ["甲", "100"]]] as const) {
    const item = await upload(name); assert.ok(["ready", "partial"].includes(item.status), item.error);
    const tools = createAttachmentTools(store, scope, [item.id]); const [file] = await tools.list(); const table = file.tables[0];
    assert.equal(table.rows, 3, name);
    const page = await tools.read({ attachmentId: item.id, tableId: table.id });
    assert.ok("rows" in page && page.rows); assert.deepEqual(page.rows.map((row) => row.rowNumber), [1, 2, 3]);
    assert.deepEqual(page.rows[0].values, firstRow);
    assert.match(table.warnings.join("；"), /表头/);
    await assert.rejects(tools.calculate({ attachmentId: item.id, tableId: table.id, operation: "sum", column: table.columns.at(-1)! }), /表头|列含义/);
  }
});

test("GB18030 CSV 和 HTML 正文可读取，HTML 脚本不进入来源", async (t) => {
  const { store, upload } = await setup(t);
  const csv = await upload("中文.csv"); const html = await upload("方案.html"); assert.equal(csv.status, "ready", csv.error); assert.equal(html.status, "ready", html.error);
  const tools = createAttachmentTools(store, scope, [csv.id, html.id]);
  assert.match(JSON.stringify(await tools.read({ attachmentId: csv.id })), /东区/);
  const page = JSON.stringify(await tools.read({ attachmentId: html.id })); assert.match(page, /会员到店礼/); assert.doesNotMatch(page, /偷读密钥|alert\(1\)/);
});

test("DOCX PPTX XLSX 的真实解析保留段落、幻灯片与工作表位置", async (t) => {
  const { store, upload } = await setup(t);
  for (const [name, expected] of [["方案.docx", /段落|表格/], ["活动.pptx", /第 1 页/], ["销售.xlsx", /华东/]] as const) {
    const item = await upload(name); assert.ok(["ready", "partial"].includes(item.status), `${name}: ${item.error}`);
    const tools = createAttachmentTools(store, scope, [item.id]); const content = JSON.stringify(await tools.read({ attachmentId: item.id, limit: 30 })); assert.match(content, expected);
    if (name.endsWith("xlsx")) assert.match(JSON.stringify(item.warnings), /公式|缓存/);
  }
});

test("Word 修订按最终稿保留插入并排除删除内容", async (t) => {
  const { store, upload } = await setup(t); const item = await upload("修订.docx"); assert.equal(item.status, "partial");
  const tools = createAttachmentTools(store, scope, [item.id]); const page = JSON.stringify(await tools.read({ attachmentId: item.id }));
  assert.match(page, /最终预算300元/); assert.doesNotMatch(page, /900元/); assert.match(item.warnings.join("；"), /修订|最终稿/);
});

test("图片可供识图但不会在上传时调用模型，混合包逐文件保留来源与失败", async (t) => {
  const { store, upload } = await setup(t); const image = await upload("物料.png"); assert.equal(image.imageCount, 1); assert.equal(image.status, "ready", image.error);
  const archive = await upload("混合.zip"); assert.equal(archive.status, "partial", archive.error);
  assert.ok(archive.entries.some((entry) => entry.path === "资料/方案.docx" && entry.status === "ready"));
  assert.ok(archive.entries.some((entry) => entry.path === "未知.bin" && entry.status === "unsupported"));
  const tools = createAttachmentTools(store, scope, [archive.id]); assert.match(JSON.stringify(await tools.read({ attachmentId: archive.id, limit: 30 })), /资料\/方案.docx/);
});

test("文件读取隔离 owner 和会话，删除后包括旧工具引用一同失效", async (t) => {
  const { store, upload } = await setup(t); const item = await upload("销售.csv");
  await assert.rejects(store.get({ ...scope, conversationId: crypto.randomUUID() }, item.id), /不存在|无权/);
  await assert.rejects(store.get({ ...scope, owner: crypto.randomUUID() }, item.id), /不存在|无权/);
  const tools = createAttachmentTools(store, scope, [item.id]); await tools.read({ attachmentId: item.id }); await store.remove(scope, item.id);
  await assert.rejects(tools.read({ attachmentId: item.id }), /不存在|删除/);
  await assert.rejects(store.get(scope, "../../secret"), /标识/);
});

test("压缩路径穿越和文件数超限会明确失败，不写出任务目录", async (t) => {
  const { upload } = await setup(t);
  const traversal = await upload("越界.zip"); assert.equal(traversal.status, "failed"); assert.match(`${traversal.error} ${traversal.warnings.join(" ")}`, /路径|越界/);
  const many = await upload("超限.zip"); assert.ok(["failed", "partial"].includes(many.status)); assert.match(JSON.stringify(many), /数量|100|限额/);
});

test("损坏文件、外部实体与超限图片明确拒读，加密和链接成员不当作正文", async (t) => {
  const { store, upload } = await setup(t);
  for (const name of ["损坏.docx", "实体.xml", "超像素.png"]) { const file = await upload(name); assert.ok(["failed", "unsupported"].includes(file.status), JSON.stringify(file)); assert.equal(file.blockCount, 0); }
  const encrypted = await upload("加密标记.zip"); assert.equal(encrypted.status, "encrypted"); assert.match(encrypted.error ?? "", /加密/);
  const linked = await upload("链接.zip"); assert.equal(linked.status, "partial"); assert.equal(linked.entries.find((entry) => entry.path === "link.txt")?.status, "failed");
  const tools = createAttachmentTools(store, scope, [linked.id]); const read = JSON.stringify(await tools.read({ attachmentId: linked.id })); assert.match(read, /普通正文可读/); assert.doesNotMatch(read, /private-canary/);
});

test("Excel 视觉分隔空行不吞掉下一条记录，来源保留原始行号", async (t) => {
  const { store, upload } = await setup(t); const item = await upload("空行.xlsx");
  const tools = createAttachmentTools(store, scope, [item.id]); const [file] = await tools.list();
  assert.equal(file.tables.length, 1); assert.equal(file.tables[0].rows, 3);
  const rows = await tools.read({ attachmentId: item.id, tableId: file.tables[0].id });
  assert.ok("rows" in rows && rows.rows); assert.deepEqual(rows.rows.map((row) => row.rowNumber), [2, 4, 5]);
  const sum = await tools.calculate({ attachmentId: item.id, tableId: file.tables[0].id, operation: "sum", column: "金额" });
  assert.ok("value" in sum); assert.equal(sum.value, "60");
});

test("Excel 合并标签和多层表头保留结构，合并金额不擅自复制或求和", async (t) => {
  const { store, upload } = await setup(t);
  const item = await upload("合并.xlsx"); const tools = createAttachmentTools(store, scope, [item.id]); const [file] = await tools.list();
  const sum = await tools.calculate({ attachmentId: item.id, tableId: file.tables[0].id, operation: "sum", column: "金额", filters: [{ column: "地区", operator: "equals", value: "华东" }] });
  assert.ok("value" in sum); assert.equal(sum.value, "30");
  assert.match(JSON.stringify(await store.document(scope, item.id)), /A2:A3/);
  const header = await upload("表头.xlsx"); const headerTools = createAttachmentTools(store, scope, [header.id]); const [headerFile] = await headerTools.list();
  assert.deepEqual(headerFile.tables[0].columns, ["地区", "金额 / 实收", "金额 / 成本"]); assert.equal(headerFile.tables[0].rows, 1);
  const amount = await upload("合并金额.xlsx"); const amountTools = createAttachmentTools(store, scope, [amount.id]); const [amountFile] = await amountTools.list();
  await assert.rejects(amountTools.calculate({ attachmentId: amount.id, tableId: amountFile.tables[0].id, operation: "sum", column: "金额" }), /合并|歧义/);
});

test("有歧义的小数逗号拒绝自动计算，不能当成千分位去掉", async (t) => {
  const { store, upload } = await setup(t); const item = await upload("小数逗号.csv"); const tools = createAttachmentTools(store, scope, [item.id]); const [file] = await tools.list();
  await assert.rejects(tools.calculate({ attachmentId: item.id, tableId: file.tables[0].id, operation: "sum", column: "金额" }), /数字|分隔/);
});

test("混合压缩包的覆盖记录包含失败成员，不能只看成功文本", async (t) => {
  const { store, upload } = await setup(t); const item = await upload("混合.zip"); const tools = createAttachmentTools(store, scope, [item.id]);
  assert.match(JSON.stringify(await tools.coverage()), /未知\.bin|unsupported/);
});

test("同名同内容可去重，不同文件名保留独立来源，过期后原文和引用失效", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ctf-file-expiry-")); let clock = Date.now();
  const store = createAttachmentStore({ directory, clock: () => clock }); t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const upload = (name: string) => store.upload(scope, { name, body: Readable.from([Buffer.from("门店,实收\n甲,10\n")]) });
  const first = await upload("资料.csv"); const repeated = await upload("资料.csv"); const renamed = await upload("资料.txt");
  assert.equal(first.id, repeated.id); assert.notEqual(first.id, renamed.id); assert.match(first.contentHash, /^[a-f0-9]{64}$/); assert.equal(first.parserVersion, "attachments/1");
  clock += 31 * 86400000; await assert.rejects(store.get(scope, first.id), /过期/);
  await assert.rejects(store.content(scope, first.id), /不存在|删除/); await store.remove(scope, first.id);
});

test("真实高压缩率大成员在解包前受限，不能把压缩体积当展开体积", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ctf-file-bomb-")); const store = createAttachmentStore({ directory }); t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const packed = spawnSync(attachmentPython(), ["-c", "import io,sys,zipfile;b=io.BytesIO();z=zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED);z.writestr('oversize.txt',b'x'*(100*1024*1024+1));z.close();sys.stdout.buffer.write(b.getvalue())"], { maxBuffer: 1024 * 1024 });
  assert.equal(packed.status, 0, packed.stderr.toString()); assert.ok(packed.stdout.length < 1024 * 1024);
  let item = await store.upload(scope, { name: "大成员.zip", body: Readable.from([packed.stdout]) });
  for (let n = 0; n < 200 && ["queued", "processing"].includes(item.status); n++) { await new Promise((resolve) => setTimeout(resolve, 30)); item = await store.get(scope, item.id); }
  assert.equal(item.status, "failed"); assert.match(item.error ?? "", /子文件大小超过限额/);
});
