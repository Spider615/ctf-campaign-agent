import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { sampleDataset } from "../app/lib/analytics/sample.ts";
import { runAnalysis } from "../app/lib/analytics/engine.ts";
import { readAnalysisTool, validateExplanation, selectedInsights } from "../app/lib/analytics/explain.ts";
import { createAgentHttpHandler } from "../agent/http-handler.ts";
import { createAnalyticsRunner } from "../agent/analytics-run-turn.ts";

function report() {
  return { ...runAnalysis(sampleDataset(), { period: { start: "2026-08-01", end: "2026-09-30" }, comparison: { start: "2025-08-01", end: "2025-09-30" }, filters: {} }), id: "report-test", createdAt: "2026-10-10" };
}

test("分析工具读取真实计算结果且不修改报告，输出只能引用已有洞察与维度", () => {
  const r = report(); const before = structuredClone(r);
  const result = readAnalysisTool(r, "query_metrics", { dimension: "memberSegment" }) as { groups: Array<{ value: string }> };
  assert.ok(result.groups.some((g) => g.value === "新会员"));
  assert.deepEqual(r, before);
  assert.throws(() => readAnalysisTool(r, "read_analysis_evidence", { evidenceId: "不存在" }), /证据/);
  assert.throws(() => validateExplanation(r, { insightIds: ["伪造洞察"], nextDimensions: [] }), /洞察/);
  assert.throws(() => validateExplanation(r, { insightIds: [], nextDimensions: ["库存"] }), /维度/);
  assert.deepEqual(validateExplanation(r, { insightIds: [r.insights[0].id], nextDimensions: ["memberSegment"] }).insightIds, [r.insights[0].id]);
});

test("没有匹配证据与尚未解读不同，不能将空选择替换成全部洞察", () => {
  const r = report(); assert.ok(r.insights.length);
  assert.deepEqual(selectedInsights(r, null), r.insights);
  assert.deepEqual(selectedInsights(r, { insightIds: [], nextDimensions: [], tools: [] }), []);
  assert.deepEqual(selectedInsights(r, { insightIds: [r.insights[0].id], nextDimensions: [], tools: [] }), [r.insights[0]]);
});

test("分析解读接口沿用鉴权并将上游错误返回，不能伪造成功", async (t) => {
  const server = createServer(createAgentHttpHandler({ token: "secret", model: "test", runAgentTurn: async () => { throw new Error("不应进入活动执行"); }, runAnalyticsTurn: async () => { throw new Error("分析上游不可用"); } }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const addr = server.address(); assert.ok(addr && typeof addr !== "string");
  const url = `http://127.0.0.1:${addr.port}/analytics/explain`;
  const body = JSON.stringify({ report: report(), question: "会员效果差异" });
  assert.equal((await fetch(url, { method: "POST", body })).status, 401);
  const res = await fetch(url, { method: "POST", body, headers: { authorization: "Bearer secret" } });
  assert.equal(res.status, 502);
  const errorBody = await res.json() as { error: string };
  assert.match(errorBody.error, /上游不可用/);
});

test("SDK 等待可以立即取消，不需要等模型交出下一条消息", async () => {
  const started = Promise.withResolvers<void>(); const controller = new AbortController();
  const runner = createAnalyticsRunner({ model: "test", apiKey: "test", modelBaseUrl: "https://example.invalid", runtimeDir: "/tmp/ctf-analytics-test-runtime", pluginDir: `${process.cwd()}/agent/analytics-plugin` }, { query: () => ({ [Symbol.asyncIterator]() { return { next() { started.resolve(); return new Promise<IteratorResult<never>>(() => {}); } }; } }) });
  const running = runner({ report: report(), question: "复盘" }, controller.signal);
  await started.promise; controller.abort();
  await assert.rejects(running, /停止|取消/);
});
