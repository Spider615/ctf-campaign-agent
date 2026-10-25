import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createAgentHttpHandler } from "../agent/http-handler.ts";
import { analyticsAnswerText, consumeAnalyticsStream, encodeAnalyticsStreamEvent, isPlanAnswer, normalizeAnalyticsAnswerSchema, validateAnalyticsAnswerResult } from "../app/lib/analytics/stream.ts";
import { PLAN_ANSWER_SCHEMA, PLAN_ANSWER_V4_SCHEMA } from "../app/lib/analytics/analysis-v2-types.ts";
import { quickAnalyticsReply } from "../app/lib/analytics/dialogue.ts";
import { simulatedPlanAnswer, simulatedPlanAnswerV4 } from "./helpers/plan-answer.ts";
import { httpAnalyticsDatabase, httpAnalyticsReportRequest } from "./helpers/analytics-http.ts";

async function start(t: test.TestContext, calls: { legacy: number; plan: number }, configured = true) {
  const server = createServer(createAgentHttpHandler({
    token: "test", model: "test", runAgentTurn: async () => { throw new Error("不能调用执行工具"); },
    database: configured ? httpAnalyticsDatabase() : undefined,
    runAnalyticsTurn: async () => { calls.legacy++; return quickAnalyticsReply("你好")!; },
    runPlanAnalyticsTurn: async (_request, _signal, emit) => { calls.plan++; emit?.({ type: "phase", phase: "analyzing", at: Date.now() }); return simulatedPlanAnswerV4(); },
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}
const headers = { "content-type": "application/json", authorization: "Bearer test" };
const body = JSON.stringify({ mode: "database", question: "你好", history: [] });

const endpoints = ["/analytics/database/explain/stream", "/analytics/database/explain", "/analytics/explain"];
const requestBody = (path: string) => path === "/analytics/explain" ? JSON.stringify(httpAnalyticsReportRequest()) : body;

test("数据库流式、JSON 与报告入口：v3/v4 都调用新运行器并返回 v4", async (t) => {
  const calls = { legacy: 0, plan: 0 }; const base = await start(t, calls);
  for (const path of endpoints) for (const schema of [PLAN_ANSWER_SCHEMA, PLAN_ANSWER_V4_SCHEMA]) {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { ...headers, "x-analytics-answer-schema": schema }, body: requestBody(path) });
    assert.equal(response.status, 200, `${path} ${schema}`);
    const result = validateAnalyticsAnswerResult(path.endsWith("/stream") ? await consumeAnalyticsStream(response) : await response.json());
    assert.ok(isPlanAnswer(result)); assert.deepEqual(result, simulatedPlanAnswerV4());
    assert.match(analyticsAnswerText(result), /1,234\.56元/);
  }
  assert.deepEqual(calls, { legacy: 0, plan: 6 });
});

test("三个新请求入口拒绝无头、v2 和未知版本，不能回退旧模型", async (t) => {
  const calls = { legacy: 0, plan: 0 }; const base = await start(t, calls);
  for (const path of endpoints) for (const schema of [undefined, "analysis-answer/v2", "analysis-answer/v9", "ANALYSIS-ANSWER/V4", "analysis-answer/v4, analysis-answer/v3"]) {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { ...headers, ...(schema ? { "x-analytics-answer-schema": schema } : {}) }, body: requestBody(path) });
    assert.equal(response.status, 400, `${path} ${schema ?? "无头"}`);
    const result = await response.json() as { error: string };
    assert.match(result.error, /版本|刷新/);
  }
  assert.deepEqual(calls, { legacy: 0, plan: 0 });
});

test("未配置数据库时问候、致谢、身份与月份问题都返回真实不可用，报告入口仍可用", async (t) => {
  const calls = { legacy: 0, plan: 0 }; const base = await start(t, calls, false);
  for (const path of endpoints.slice(0, 2)) for (const schema of [PLAN_ANSWER_SCHEMA, PLAN_ANSWER_V4_SCHEMA]) for (const question of ["你好", "谢谢", "你是谁", "2025年8月销售额是多少？"]) {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { ...headers, "x-analytics-answer-schema": schema }, body: JSON.stringify({ mode: "database", question, history: [] }) });
    assert.equal(response.status, 503, `${path} ${schema} ${question}`);
    assert.deepEqual(await response.json(), { error: "历史数据库尚未启用" });
  }
  assert.deepEqual(calls, { legacy: 0, plan: 0 });
  const report = await fetch(`${base}/analytics/explain`, { method: "POST", headers: { ...headers, "x-analytics-answer-schema": PLAN_ANSWER_V4_SCHEMA }, body: requestBody("/analytics/explain") });
  assert.equal(report.status, 200); assert.deepEqual(await report.json(), simulatedPlanAnswerV4());
  assert.deepEqual(calls, { legacy: 0, plan: 1 });
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

test("已保存的 v1/v3/v4 消息继续按原合同读取", () => {
  for (const stored of [quickAnalyticsReply("你好")!, simulatedPlanAnswer(), simulatedPlanAnswerV4()]) {
    assert.deepEqual(validateAnalyticsAnswerResult(JSON.parse(JSON.stringify(stored))), stored);
  }
  assert.equal(normalizeAnalyticsAnswerSchema(PLAN_ANSWER_V4_SCHEMA), PLAN_ANSWER_V4_SCHEMA);
});
