import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAgentHttpHandler } from "../agent/http-handler.ts";
import { analyticsAnswerText, consumeAnalyticsStream, encodeAnalyticsStreamEvent, isPlanAnswer, normalizeAnalyticsAnswerSchema, validateAnalyticsAnswerResult } from "../app/lib/analytics/stream.ts";
import { PLAN_ANSWER_SCHEMA, PLAN_ANSWER_V4_SCHEMA } from "../app/lib/analytics/analysis-v2-types.ts";
import { quickAnalyticsReply } from "../app/lib/analytics/dialogue.ts";
import { simulatedPlanAnswer, simulatedPlanAnswerV4 } from "./helpers/plan-answer.ts";

async function start(t: test.TestContext, calls: { legacy: number; plan: number }, answer: () => unknown = simulatedPlanAnswer) {
  const server = createServer(createAgentHttpHandler({
    token: "test", model: "test", runAgentTurn: async () => { throw new Error("不能调用执行工具"); },
    runAnalyticsTurn: async () => { calls.legacy++; return quickAnalyticsReply("你好")!; },
    runPlanAnalyticsTurn: async (_request, _signal, emit) => { calls.plan++; emit?.({ type: "phase", phase: "analyzing", at: Date.now() }); return answer() as ReturnType<typeof simulatedPlanAnswerV4>; },
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}/analytics/database/explain/stream`;
}
const headers = { "content-type": "application/json", authorization: "Bearer test" };
const body = JSON.stringify({ mode: "database", question: "你好", history: [] });

test("v3 请求头走计划运行器，流结果可被解码", async (t) => {
  const calls = { legacy: 0, plan: 0 }; const url = await start(t, calls);
  const response = await fetch(url, { method: "POST", headers: { ...headers, "x-analytics-answer-schema": PLAN_ANSWER_SCHEMA }, body });
  assert.equal(response.status, 200);
  const result = await consumeAnalyticsStream(response);
  assert.ok(isPlanAnswer(result)); assert.deepEqual(result, simulatedPlanAnswer());
  assert.match(analyticsAnswerText(result), /1234\.56/);
  assert.deepEqual(calls, { legacy: 0, plan: 1 });
});

test("v2 请求头返回 400 要求刷新，不调用任何运行器", async (t) => {
  const calls = { legacy: 0, plan: 0 }; const url = await start(t, calls);
  const response = await fetch(url, { method: "POST", headers: { ...headers, "x-analytics-answer-schema": "analysis-answer/v2" }, body });
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: "页面版本已更新，请刷新页面后重试" });
  assert.deepEqual(calls, { legacy: 0, plan: 0 });
});

test("未知版本头仍返回 400，无版本头走旧路径", async (t) => {
  const calls = { legacy: 0, plan: 0 }; const url = await start(t, calls);
  const unknown = await fetch(url, { method: "POST", headers: { ...headers, "x-analytics-answer-schema": "analysis-answer/v9" }, body });
  assert.equal(unknown.status, 400);
  const legacy = await fetch(url, { method: "POST", headers, body });
  assert.equal(legacy.status, 200); assert.ok((await legacy.text()).includes('"reply"'));
  assert.deepEqual(calls, { legacy: 1, plan: 0 });
});

test("版本协商接受 v3 和 v4，流解码拒绝引用未知事实的 v3 结果", () => {
  assert.equal(normalizeAnalyticsAnswerSchema(PLAN_ANSWER_SCHEMA), PLAN_ANSWER_SCHEMA);
  for (const value of [null, undefined, "", "analysis-answer/v2", "ANALYSIS-ANSWER/V3", "v3"]) assert.equal(normalizeAnalyticsAnswerSchema(value), undefined);
  const valid = simulatedPlanAnswer();
  assert.deepEqual(validateAnalyticsAnswerResult(JSON.parse(JSON.stringify(valid))), valid);
  const bad = JSON.parse(JSON.stringify(valid)); bad.headline.factIds = ["no-such-fact"];
  assert.throws(() => validateAnalyticsAnswerResult(bad), /不存在的事实/);
  assert.ok(encodeAnalyticsStreamEvent({ type: "result", result: valid }).includes(PLAN_ANSWER_SCHEMA));
});

test("流消费拒绝引用未知事实的 v3 结果", async () => {
  const bad = JSON.parse(JSON.stringify(simulatedPlanAnswer())); bad.claims = [{ text: "x", factIds: ["ghost"], confidence: "kept" }];
  const response = new Response(`${JSON.stringify({ type: "result", result: bad })}\n`);
  await assert.rejects(consumeAnalyticsStream(response), /不存在的事实/);
});

test("v4 和 v3 请求头都走计划运行器，转发的 v4 结果原样解码", async (t) => {
  for (const schema of [PLAN_ANSWER_V4_SCHEMA, PLAN_ANSWER_SCHEMA]) {
    const calls = { legacy: 0, plan: 0 }; const url = await start(t, calls, simulatedPlanAnswerV4);
    const response = await fetch(url, { method: "POST", headers: { ...headers, "x-analytics-answer-schema": schema }, body });
    assert.equal(response.status, 200);
    const result = await consumeAnalyticsStream(response);
    assert.ok(isPlanAnswer(result)); assert.deepEqual(result, simulatedPlanAnswerV4());
    assert.match(analyticsAnswerText(result), /1,234\.56元/);
    assert.deepEqual(calls, { legacy: 0, plan: 1 });
  }
  assert.equal(normalizeAnalyticsAnswerSchema(PLAN_ANSWER_V4_SCHEMA), PLAN_ANSWER_V4_SCHEMA);
});
