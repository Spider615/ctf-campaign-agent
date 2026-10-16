import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAgentHttpHandler } from "../agent/http-handler.ts";
import { quickAnalyticsReply } from "../app/lib/analytics/dialogue.ts";

async function start(t: { after(fn: () => void): void }, runAnalyticsTurn: Parameters<typeof createAgentHttpHandler>[0]["runAnalyticsTurn"]) {
  const server = createServer(createAgentHttpHandler({ runAgentTurn: async () => { throw new Error("不应调用执行 Agent"); }, runAnalyticsTurn, token: "test", model: "test", logger: { log() {}, error() {} } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
const body = JSON.stringify({ mode: "database", question: "你好", history: [] });
const headers = { "content-type": "application/json", authorization: "Bearer test" };

test("营销流在最终回答之前发出真实过程事件，不要求寒暄连接数据库", async (t) => {
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  const base = await start(t, async (_request, _signal, emit) => {
    emit?.({ type: "phase", phase: "analyzing", at: Date.now() });
    await waiting; return quickAnalyticsReply("你好")!;
  });
  const response = await fetch(`${base}/analytics/database/explain/stream`, { method: "POST", headers, body });
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /ndjson/);
  const reader = response.body!.getReader();
  const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /"type":"phase"/);
  finish(); const parts = [new TextDecoder().decode(first.value)];
  while (true) { const part = await reader.read(); if (part.done) break; parts.push(new TextDecoder().decode(part.value)); }
  const events = parts.join("").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "result"); assert.ok(events.at(-1).result.reply);
});

test("停止营销流会取消仍挂起的回合", async (t) => {
  let cancelled = () => {}; const stopped = new Promise<void>((resolve) => { cancelled = resolve; });
  const base = await start(t, async (_request, signal, emit) => {
    emit?.({ type: "phase", phase: "analyzing", at: Date.now() });
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => { cancelled(); resolve(); }, { once: true }));
    return quickAnalyticsReply("你好")!;
  });
  const controller = new AbortController();
  const response = await fetch(`${base}/analytics/database/explain/stream`, { method: "POST", headers, body, signal: controller.signal });
  assert.equal(response.status, 200); await response.body!.getReader().read(); controller.abort();
  await stopped;
});
