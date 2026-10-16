import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAgentHttpHandler } from "../agent/http-handler.ts";
import { simulatedAnswer } from "./helpers/analysis-v2-answer.ts";
import { quickAnalyticsReply } from "../app/lib/analytics/dialogue.ts";

test("Node分析版本头精确协商，v1默认与v2流结果并存", async (t) => {
  let legacy = 0; let general = 0;
  const server = createServer(createAgentHttpHandler({ token: "test", model: "test", runAgentTurn: async () => { throw new Error("不能调用执行工具"); }, runAnalyticsTurn: async () => { legacy++; return quickAnalyticsReply("你好")!; }, runGeneralAnalyticsTurn: async (_request, _signal, emit) => { general++; emit?.({ type: "phase", phase: "analyzing", at: Date.now() }); return simulatedAnswer(); } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === "object"); const url = `http://127.0.0.1:${address.port}/analytics/database/explain/stream`;
  const headers = { "content-type": "application/json", authorization: "Bearer test" }; const body = JSON.stringify({ mode: "database", question: "你好", history: [] });
  const old = await fetch(url, { method: "POST", headers, body }); assert.equal(old.status, 200); assert.ok((await old.text()).includes('"reply"')); assert.equal(legacy, 1);
  const next = await fetch(url, { method: "POST", headers: { ...headers, "x-analytics-answer-schema": "analysis-answer/v2" }, body }); assert.equal(next.status, 200); const events = (await next.text()).trim().split("\n").map((line) => JSON.parse(line)); assert.equal(events.at(-1).result.schema, "analysis-answer/v2"); assert.equal(general, 1);
  const invalid = await fetch(url, { method: "POST", headers: { ...headers, "x-analytics-answer-schema": "analysis-answer/v3" }, body }); assert.equal(invalid.status, 400); assert.equal(general, 1); assert.equal(legacy, 1);
});
