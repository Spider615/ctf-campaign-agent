import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAgentHttpHandler } from "../agent/http-handler.ts";
import { simulatedPlanAnswerV4 } from "./helpers/plan-answer.ts";
import { httpAnalyticsDatabase } from "./helpers/analytics-http.ts";

async function start(t: { after(fn: () => void): void }, runPlanAnalyticsTurn: Parameters<typeof createAgentHttpHandler>[0]["runPlanAnalyticsTurn"]) {
  const server = createServer(createAgentHttpHandler({ runAgentTurn: async () => { throw new Error("不应调用执行 Agent"); }, runPlanAnalyticsTurn, database: httpAnalyticsDatabase(), token: "test", model: "test", logger: { log() {}, error() {} } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
const body = JSON.stringify({ mode: "database", question: "你好", history: [] });
const headers = { "content-type": "application/json", authorization: "Bearer test", "x-analytics-answer-schema": "analysis-answer/v4" };

test("新问答流在最终 v4 回答之前发出真实过程事件", { timeout: 5000 }, async (t) => {
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  t.after(() => finish());
  const base = await start(t, async (_request, _signal, emit) => {
    emit?.({ type: "phase", phase: "analyzing", at: Date.now() });
    await waiting; return simulatedPlanAnswerV4();
  });
  const response = await fetch(`${base}/analytics/database/explain/stream`, { method: "POST", headers, body });
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /ndjson/);
  const reader = response.body!.getReader();
  const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /"type":"phase"/);
  finish(); const parts = [new TextDecoder().decode(first.value)];
  while (true) { const part = await reader.read(); if (part.done) break; parts.push(new TextDecoder().decode(part.value)); }
  const events = parts.join("").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "result"); assert.deepEqual(events.at(-1).result, simulatedPlanAnswerV4());
});

test("停止新问答流会取消仍挂起的回合", { timeout: 5000 }, async (t) => {
  let cancelled = () => {}; const stopped = new Promise<void>((resolve) => { cancelled = resolve; });
  const base = await start(t, async (_request, signal, emit) => {
    emit?.({ type: "phase", phase: "analyzing", at: Date.now() });
    await new Promise<void>((resolve) => signal?.addEventListener("abort", () => { cancelled(); resolve(); }, { once: true }));
    return simulatedPlanAnswerV4();
  });
  const controller = new AbortController();
  const response = await fetch(`${base}/analytics/database/explain/stream`, { method: "POST", headers, body, signal: controller.signal });
  assert.equal(response.status, 200); await response.body!.getReader().read(); controller.abort();
  await stopped;
});

test("新问答流公开格式错误不宣称正文数字核验失败", async (t) => {
  const base = await start(t, async () => { throw new Error("候选回答格式不完整，请重试"); });
  const response = await fetch(`${base}/analytics/database/explain/stream`, { method: "POST", headers, body });
  assert.equal(response.status, 200);
  const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(events, [{ type: "error", error: "候选回答格式不完整，请重试" }]);
  assert.doesNotMatch(JSON.stringify(events), /正在核验|未通过.*核验/);
});

test("新问答流的底层框架错误仍隐藏身份", async (t) => {
  const base = await start(t, async () => { throw new Error("Claude Code process exited with code 1"); });
  const response = await fetch(`${base}/analytics/database/explain/stream`, { method: "POST", headers, body });
  assert.deepEqual((await response.text()).trim().split("\n").map((line) => JSON.parse(line)), [{ type: "error", error: "Agent 执行出错" }]);
});
