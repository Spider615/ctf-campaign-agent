import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { simulatedAnswer } from "./helpers/analysis-v2-answer.ts";
import { consumeAnalyticsStream, encodeAnalyticsStreamEvent } from "../app/lib/analytics/stream.ts";
import { reduceVisualizationProgress, restoreVisualizationProgress } from "../app/lib/analytics/visualization-progress.ts";
import type { VisualizationProgressEvent } from "../app/lib/analytics/visualization-types.ts";
import { createAgentHttpHandler } from "../agent/http-handler.ts";
import { postHistoryStream } from "../app/lib/client/history-stream.ts";
import { createHistoryConversationStore } from "../app/lib/client/history-conversation.ts";

function preview(): Extract<VisualizationProgressEvent, { action: "upsert" }> {
  return { type: "visualization", schema: "analysis-visualization/v1", runId: "run", epoch: 0, action: "upsert", preview: { spec: { id: "chart", revision: 1, kind: "bar", renderer: "native", afterBlockIndex: 0, source: { kind: "analysis", operationId: "operation", metricId: "amount", dimension: "store" }, selection: { mode: "all" } }, evidence: simulatedAnswer().evidence } };
}

test("图表预览在字节分帧后核验交付，未知来源和终态后追加不能通过", async () => {
  const event = preview(); const final = encodeAnalyticsStreamEvent({ type: "result", result: simulatedAnswer() });
  const bytes = new TextEncoder().encode(encodeAnalyticsStreamEvent(event) + final); let at = 0;
  const response = new Response(new ReadableStream({ pull(output) { if (at < bytes.length) output.enqueue(bytes.slice(at, ++at)); else output.close(); } }));
  const progress: unknown[] = []; await consumeAnalyticsStream(response, (item) => progress.push(item)); assert.equal(progress.length, 1);
  const invalid = preview(); invalid.preview.spec.source = { kind: "analysis", operationId: "invented", metricId: "amount", dimension: "store" };
  await assert.rejects(consumeAnalyticsStream(new Response(encodeAnalyticsStreamEvent(invalid) + final)), /图表|来源|操作/);
  await assert.rejects(consumeAnalyticsStream(new Response(final + encodeAnalyticsStreamEvent(event))), /最终结果/);
});

test("阶段图表修订去重、冲突拒绝、证据撤回且旧代次不能恢复", () => {
  const event = preview(); const state = reduceVisualizationProgress(undefined, event);
  assert.equal(state.items.length, 1); assert.deepEqual(reduceVisualizationProgress(state, event), state);
  const conflict = structuredClone(event); conflict.preview.spec.renderer = "html";
  assert.throws(() => reduceVisualizationProgress(state, conflict), /修订|冲突/);
  conflict.preview.spec.revision = 2;
  const next = reduceVisualizationProgress(state, conflict); assert.equal(next.items[0].preview.spec.renderer, "html");
  const retracted = reduceVisualizationProgress(next, { type: "visualization", schema: "analysis-visualization/v1", runId: "run", epoch: 1, action: "retract", ids: ["chart"], reason: "snapshot_changed" });
  assert.equal(retracted.items.length, 0); assert.ok(retracted.invalidated);
  assert.throws(() => reduceVisualizationProgress(retracted, event), /代次|失效/);
  assert.equal(restoreVisualizationProgress(state)?.items.length, 1);
  const stored = structuredClone(state); stored.items[0].preview.spec.source = { kind: "analysis", operationId: "fake", metricId: "amount", dimension: "store" };
  assert.equal(restoreVisualizationProgress(stored), undefined);
});

test("Node 精确转交图表能力，旧客户端仍只有原过程与答案", async (t) => {
  const capabilities: Array<string | undefined> = [];
  const server = createServer(createAgentHttpHandler({ token: "test", model: "test", runAgentTurn: async () => { throw new Error("不调用执行"); }, runGeneralAnalyticsTurn: async (_request, _signal, emit, capability) => { capabilities.push(capability); if (capability) emit?.(preview()); return simulatedAnswer(); } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === "object"); const url = `http://127.0.0.1:${address.port}/analytics/database/explain/stream`;
  for (const capability of [undefined, "future", "analysis-visualization/v1"]) {
    const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json", "x-analytics-answer-schema": "analysis-answer/v2", ...(capability ? { "x-analytics-visuals": capability } : {}) }, body: JSON.stringify({ mode: "database", question: "你好", history: [] }) });
    assert.equal(response.status, 200); const text = await response.text(); assert.equal(text.includes('"type":"visualization"'), capability === "analysis-visualization/v1");
  }
  assert.deepEqual(capabilities, [undefined, undefined, "analysis-visualization/v1"]);
});

test("浏览器历史分析请求声明可视化能力，不改变业务请求体", async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_url, options) => { const headers = new Headers(options?.headers); assert.equal(headers.get("X-Analytics-Visuals"), "analysis-visualization/v1"); return new Response(encodeAnalyticsStreamEvent({ type: "result", result: simulatedAnswer() }), { headers: { "content-type": "application/x-ndjson" } }); };
  const answer = await postHistoryStream({ mode: "database", question: "你好", history: [] }, () => {});
  assert.equal("schema" in answer && answer.schema, "analysis-answer/v2");
});

test("会话恢复把阶段图标为未完成，并重新核验而非信任浏览器缓存", () => {
  const memory = new Map<string, string>(); const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value); } };
  const store = createHistoryConversationStore(storage);
  const state = reduceVisualizationProgress(undefined, preview());
  store.update(() => [{ id: "message", role: "assistant", text: "", createdAt: new Date().toISOString(), status: "running", visualizationState: state }]);
  const restored = createHistoryConversationStore(storage).snapshot()[0]; assert.equal(restored.status, "cancelled"); assert.equal(restored.visualizationState?.items.length, 1);
  const raw = JSON.parse(memory.get("ctf:conversations:v2")!); raw.threads[0].messages[0].visualizationState.items[0].preview.evidence.facts[0].frameId = "fake";
  memory.set("ctf:conversations:v2", JSON.stringify(raw));
  assert.equal(createHistoryConversationStore(storage).snapshot()[0].visualizationState, undefined);
});
