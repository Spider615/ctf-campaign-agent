import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as wait } from "node:timers/promises";
import test from "node:test";
import { attachmentPython, parseAttachment } from "../agent/attachments/parser.ts";
import { createAttachmentStore } from "../agent/attachments/store.ts";
import { createAttachmentTools } from "../agent/attachments/tools.ts";

test("上传、查询、下载和服务重启均不解析，发送准备动作才处理全部文件", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ctf-upload-only-"));
  let store = createAttachmentStore({ directory });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const scope = { owner: crypto.randomUUID(), conversationId: crypto.randomUUID() };
  const item = await store.upload(scope, { name: "销售.csv", body: Readable.from([Buffer.from("门店,金额\n甲,0.1\n乙,0.2\n")]) });
  assert.equal(item.status, "uploaded");
  const parsed = join(directory, scope.owner, scope.conversationId, item.id, "parsed");
  assert.equal((await store.get(scope, item.id)).status, "uploaded");
  assert.equal((await store.list(scope))[0].status, "uploaded");
  assert.ok((await store.content(scope, item.id)).path);
  await store.close();
  const metadata = join(directory, scope.owner, scope.conversationId, item.id, "metadata.json");
  const interrupted = JSON.parse(await readFile(metadata, "utf8"));
  await writeFile(metadata, JSON.stringify({ ...interrupted, status: "processing" }));
  store = createAttachmentStore({ directory });
  assert.equal((await store.get(scope, item.id)).status, "uploaded"); assert.equal(existsSync(parsed), false);
  await assert.rejects(store.prepare({ ...scope, owner: crypto.randomUUID() }, [item.id]), /不存在|无权/);
  assert.equal(existsSync(parsed), false);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(store.prepare(scope, [item.id], cancelled.signal), /停止|取消/);
  assert.equal((await store.get(scope, item.id)).status, "uploaded"); assert.equal(existsSync(parsed), false);
  await store.prepare(scope, [item.id]);
  assert.equal((await store.get(scope, item.id)).status, "ready");
  const tools = createAttachmentTools(store, scope, [item.id]); const [file] = await tools.list();
  const sum = await tools.calculate({ attachmentId: item.id, tableId: file.tables[0].id, operation: "sum", column: "金额" });
  assert.ok("value" in sum); assert.equal(sum.value, "0.3"); assert.equal(sum.matchedRows, 2);
});

test("大小工作簿的公式缓存齐全即完整可读，缓存缺失仍保留真实缺值", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ctf-formula-coverage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const generated = spawnSync(attachmentPython(), ["-c", `import pathlib,sys,zipfile,re
from openpyxl import Workbook
root=pathlib.Path(sys.argv[1]);book=Workbook();sheet=book.active
sheet.append(['项目','金额']);sheet.append(['销售','=1+2']);book.save(root/'missing.xlsx')
with zipfile.ZipFile(root/'missing.xlsx') as z: content={name:z.read(name) for name in z.namelist()}
content['xl/worksheets/sheet1.xml']=content['xl/worksheets/sheet1.xml'].replace(b'<v></v>',b'<v>3</v>')
for name,large in [('cached.xlsx',False),('large-cached.xlsx',True),('empty-cached.xlsx',False),('large-empty-cached.xlsx',True)]:
 with zipfile.ZipFile(root/name,'w',zipfile.ZIP_DEFLATED) as z:
  for member,data in content.items():
   if 'empty' in name and member=='xl/worksheets/sheet1.xml':data=data.replace(b'<c r="B2">',b'<c r="B2" t="str">').replace(b'<v>3</v>',b'<v/>')
   z.writestr(member,data)
  if large:z.writestr('xl/padding.xml',b' '*(17*1024*1024))
`, directory], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  for (const name of ["cached.xlsx", "large-cached.xlsx", "empty-cached.xlsx", "large-empty-cached.xlsx"]) {
    const parsed = await parseAttachment(join(directory, name), join(directory, name + "-parsed"), name, new AbortController().signal);
    assert.equal(parsed.status, "ready", parsed.warnings.join("；")); assert.equal(parsed.tables.length, 1);
  }
  const missing = await parseAttachment(join(directory, "missing.xlsx"), join(directory, "missing-parsed"), "missing.xlsx", new AbortController().signal);
  assert.equal(missing.status, "partial"); assert.equal(missing.tables[0].rows[0][1], null); assert.match(missing.warnings.join("；"), /没有缓存/);
});

test("停止最后一个发送请求会停止解析并恢复为已上传，再次发送可以重新处理", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ctf-upload-cancel-"));
  const store = createAttachmentStore({ directory });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const scope = { owner: crypto.randomUUID(), conversationId: crypto.randomUUID() };
  const item = await store.upload(scope, { name: "销售.csv", body: Readable.from([Buffer.from("门店,金额\n" + "甲,0.1\n".repeat(50000))]) });
  const controller = new AbortController();
  const stopped = assert.rejects(store.prepare(scope, [item.id], controller.signal), /停止|取消/);
  while ((await store.get(scope, item.id)).status !== "processing") await wait(5);
  controller.abort(); await stopped;
  assert.equal((await store.get(scope, item.id)).status, "uploaded");
  assert.equal(existsSync(join(directory, scope.owner, scope.conversationId, item.id, "parsed")), false);
  await wait(150); assert.equal((await store.get(scope, item.id)).status, "uploaded");
  await store.prepare(scope, [item.id]); assert.equal((await store.get(scope, item.id)).status, "ready");
});

test("同一附件的多个发送请求共享解析，停止一个请求不会中断另一个", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ctf-upload-shared-"));
  const store = createAttachmentStore({ directory });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const scope = { owner: crypto.randomUUID(), conversationId: crypto.randomUUID() };
  const item = await store.upload(scope, { name: "销售.csv", body: Readable.from([Buffer.from("门店,金额\n" + "甲,0.1\n".repeat(50000))]) });
  const controller = new AbortController();
  const stopped = assert.rejects(store.prepare(scope, [item.id], controller.signal), /停止|取消/);
  const completed = store.prepare(scope, [item.id]);
  while ((await store.get(scope, item.id)).status !== "processing") await wait(5);
  controller.abort(); await stopped; await completed;
  assert.equal((await store.get(scope, item.id)).status, "ready");
});

test("发送时的临时解析失败在再次发送后可恢复，不修改成功来源", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ctf-upload-retry-"));
  let store = createAttachmentStore({ directory, python: "/missing-attachment-python" });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const scope = { owner: crypto.randomUUID(), conversationId: crypto.randomUUID() };
  const item = await store.upload(scope, { name: "销售.csv", body: Readable.from([Buffer.from("门店,金额\n甲,0.1\n")]) });
  await assert.rejects(store.prepare(scope, [item.id]), /Python|解析/);
  assert.equal((await store.get(scope, item.id)).status, "failed");
  await store.close(); store = createAttachmentStore({ directory });
  await store.retry(scope, item.id); await store.prepare(scope, [item.id]);
  const ready = await store.get(scope, item.id); assert.equal(ready.status, "ready"); assert.equal(ready.version, item.version);
  await store.prepare(scope, [item.id]); assert.deepEqual(await store.get(scope, item.id), ready);
});
