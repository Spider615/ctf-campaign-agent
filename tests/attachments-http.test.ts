import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { createAttachmentStore } from "../agent/attachments/store.ts";
import { createAttachmentsHttpHandler, type ConversationRunner } from "../agent/attachments/http.ts";
import { createAgentHttpHandler } from "../agent/http-handler.ts";
import { consumeAnalyticsStream } from "../app/lib/analytics/stream.ts";
import { largeSimulatedAnswer } from "./helpers/analysis-v2-answer.ts";

const owner = "11111111-1111-4111-8111-111111111111"; const conversationId = "22222222-2222-4222-8222-222222222222";
const headers = { authorization: "Bearer test", "x-attachments-owner": owner, "content-type": "application/octet-stream" };
async function start(t: { after(fn: () => Promise<void>): void }, runConversation?: ConversationRunner) {
  const directory = await mkdtemp(join(tmpdir(), "ctf-attachment-http-")); const store = createAttachmentStore({ directory });
  const attachmentHandler = createAttachmentsHttpHandler({ store, runConversation });
  const server = createServer(createAgentHttpHandler({ runAgentTurn: async () => { throw new Error("不应调用活动 Agent"); }, attachmentHandler, token: "test", model: "test" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${address.port}`, store };
}

test("附件二进制接口单独鉴权并接受不在白名单内的文件后缀", async (t) => {
  const { base } = await start(t); const path = `/attachments?conversationId=${conversationId}&name=notes.custom`;
  assert.equal((await fetch(base + path, { method: "POST", body: "资料" })).status, 401);
  assert.equal((await fetch(base + path, { method: "POST", headers: { authorization: "Bearer test" }, body: "资料" })).status, 401);
  const response = await fetch(base + path, { method: "POST", headers, body: "会员到店方案" }); assert.equal(response.status, 202);
  const { attachment } = await response.json() as { attachment: { id: string; name: string } }; assert.equal(attachment.name, "notes.custom");
  const metadata = await fetch(`${base}/attachments/${attachment.id}?conversationId=${conversationId}`, { headers }); assert.equal(metadata.status, 200);
  assert.equal(metadata.headers.get("cache-control"), "no-store");
});

test("来源、下载和删除全部隔离 owner 与会话，下载不会执行 HTML", async (t) => {
  const { base } = await start(t);
  const upload = await fetch(`${base}/attachments?conversationId=${conversationId}&name=unsafe.html`, { method: "POST", headers, body: "<h1>会员方案</h1><script>throw 1</script>" }); const { attachment } = await upload.json() as { attachment: { id: string } };
  const content = `${base}/attachments/${attachment.id}/content?conversationId=${conversationId}`;
  assert.equal((await fetch(content, { headers: { ...headers, "x-attachments-owner": crypto.randomUUID() } })).status, 404);
  assert.equal((await fetch(content.replace(conversationId, crypto.randomUUID()), { headers })).status, 404);
  const download = await fetch(content, { headers }); assert.equal(download.status, 200); assert.match(download.headers.get("content-disposition")!, /attachment/); assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await fetch(`${base}/attachments/${attachment.id}?conversationId=${conversationId}`, { method: "DELETE", headers })).status, 200);
  assert.equal((await fetch(content, { headers })).status, 404);
  assert.equal((await fetch(`${base}/attachments/${attachment.id}?conversationId=${conversationId}`, { method: "DELETE", headers })).status, 200, "重复删除失效引用仍可从会话移除");
});

test("超大文件、空文件与非法路径在上传入口明确拒绝", async (t) => {
  const { base } = await start(t);
  const path = `${base}/attachments?conversationId=${conversationId}&name=large.txt`;
  assert.equal((await fetch(path, { method: "POST", headers, body: new Uint8Array(25 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await fetch(path, { method: "POST", headers, body: "" })).status, 400);
  assert.equal((await fetch(`${base}/attachments/not-an-id?conversationId=${conversationId}`, { headers })).status, 400);
});

test("文件与经营数据混合回答的大证据也经统一分块完整交付", async (t) => {
  const answer = { schema: "conversation-answer/v1" as const, status: "answered" as const, blocks: [{ text: "已核对文件与经营数据，具体口径见来源。", sourceIds: ["source"] }], limitations: [], sources: [{ id: "source", attachmentId: owner, version: "a".repeat(64), name: "模拟资料.custom", location: "文件正文", kind: "document" as const, excerpt: "已核对文件与经营数据，具体口径见来源。" }], databaseAnswers: [largeSimulatedAnswer()] };
  const { base } = await start(t, async () => answer);
  const uploaded = await fetch(`${base}/attachments?conversationId=${conversationId}&name=example.custom`, { method: "POST", headers, body: "模拟文件正文" });
  const { attachment } = await uploaded.json() as { attachment: { id: string } }; answer.sources[0].attachmentId = attachment.id;
  const response = await fetch(`${base}/attachments/answer/stream?conversationId=${conversationId}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ conversationId, question: "结合经营数据", history: [], attachmentIds: [attachment.id] }) });
  assert.equal(response.status, 200); assert.deepEqual(await consumeAnalyticsStream(response), answer);
});

test("文件问答客户端断开后传播取消，未配置数据库仍可进入独立文件回合", async (t) => {
  let stopped = () => {}; let alarm: ReturnType<typeof setTimeout>;
  const cancelled = new Promise<void>((resolve, reject) => { alarm = setTimeout(() => reject(new Error("文件流断开没有传播取消")), 5000); stopped = () => { clearTimeout(alarm); resolve(); }; });
  t.after(async () => { clearTimeout(alarm); });
  const { base } = await start(t, async (_scope, request, signal) => {
    assert.equal(request.question, "你好，概括文件"); assert.ok(signal);
    return new Promise<never>((_resolve, reject) => { const stop = () => { stopped(); reject(new Error("已取消文件回答")); }; if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true }); });
  });
  const uploaded = await fetch(`${base}/attachments?conversationId=${conversationId}&name=cancel.txt`, { method: "POST", headers, body: "文件正文" });
  const { attachment } = await uploaded.json() as { attachment: { id: string } }; const controller = new AbortController();
  const response = await fetch(`${base}/attachments/answer/stream?conversationId=${conversationId}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ conversationId, question: "你好，概括文件", history: [], attachmentIds: [attachment.id] }), signal: controller.signal });
  assert.equal(response.status, 200); controller.abort(); await cancelled;
});
