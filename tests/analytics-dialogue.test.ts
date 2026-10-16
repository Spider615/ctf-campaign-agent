import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnalyticsRunner } from "../agent/analytics-run-turn.ts";
import { composeAdvice, sourceStatement } from "../app/lib/analytics/advisor.ts";
import { validateAnalyticsResponse } from "../app/lib/analytics/explain.ts";
import type { AdvisorSource } from "../app/lib/analytics/types.ts";
import { analyticsDialogueMode, quickAnalyticsReply, quickMonthlySalesQuery } from "../app/lib/analytics/dialogue.ts";

function config(t: { after(fn: () => void): void }) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-dialogue-"));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return { model: "test", apiKey: "test", modelBaseUrl: "https://example.invalid", runtimeDir, pluginDir: "/不存在的插件目录" };
}
const fields = [{ label: "净成交金额", value: 1234.56, unit: "人民币" }];
const source: AdvisorSource = { id: "mysql:test:0", kind: "database", title: "整体：全部选定成交记录", provenance: "imported", datasetVersion: "a".repeat(64), capturedAt: "2026-10-13T00:00:00Z", periodLabel: "2025-08-01至2025-08-31", scope: "全部已提供门店", definition: "含销售与退货，不含回收抵扣；探索口径，尚未对数", recordId: "test", rows: [{ label: "全部选定成交记录", fields }], statements: [sourceStatement("全部选定成交记录", fields)], limitations: ["尚未与Power BI对数"] };

for (const question of ["你好", "您好！", "hi", "谢谢", "你能做什么？", "早上好！", "好的，谢谢你！", "你能帮我做什么？"]) test(`轻量消息「${question}」不读取插件、不查库、不调用模型`, async (t) => {
  const answer = await createAnalyticsRunner({ ...config(t), database: { inspect: async () => { throw new Error("不应查库"); }, query: async () => { throw new Error("不应查库"); } } }, { query: () => { throw new Error("不应调模型"); } })({ mode: "database", question, history: [] });
  assert.ok(typeof answer.reply === "string" && answer.reply.length > 0);
  assert.deepEqual(answer.tools, []); assert.deepEqual(answer.skills, []); assert.deepEqual(answer.sources, []);
  assert.doesNotThrow(() => validateAnalyticsResponse(null, answer));
});

test("明确月份总销售额直接只读查询净成交口径，并由真实证据生成金额", async (t) => {
  const calls: unknown[] = [];
  const database = { inspect: async () => ({ available: true, name: "测试历史", minDate: "2025-08-01", maxDate: "2025-08-31", limitations: [] }), query: async (input: unknown) => { calls.push(input); return [source]; } };
  const answer = await createAnalyticsRunner({ ...config(t), database }, { query: () => { throw new Error("不应调模型"); } })({ mode: "database", question: "25年8月的总销售额是多少？", context: ["你好"], history: [{ role: "user", text: "你好" }] });
  assert.deepEqual(calls, [{ period: { start: "2025-08-01", end: "2025-08-31" }, by: "overall", population: "net", filters: {} }]);
  assert.match(answer.advice![0].text, /2025年8月：净成交金额为1,234.56元/);
  assert.deepEqual(answer.skills, []); assert.deepEqual(answer.sources, [source]);
  assert.doesNotThrow(() => validateAnalyticsResponse(null, answer));
});

test("数据观察重复填写已引用对象时去除候选展示，事实和数字仍由证据生成", () => {
  const input = { kind: "observation", text: "", evidenceIds: [source.id], metricLabels: ["净成交金额"], target: { sourceId: source.id, label: source.title } };
  const answer = composeAdvice([input], [source]);
  assert.equal(answer.advice[0].target, undefined); assert.match(answer.advice[0].text, /1,234.56/);
  assert.throws(() => composeAdvice([{ ...input, text: "卖了999元" }], [source]), /证据生成/);
  assert.throws(() => composeAdvice([{ ...input, target: { sourceId: "fake", label: "fake" } }], [source]), /候选|真实对象/);
  assert.throws(() => composeAdvice([{ ...input, evidenceIds: [] }], [source]), /候选|引用/);
});

test("否定分析与仅比较数值仍是查数；营销决策和混合寒暄不能被吞掉", () => {
  for (const question of ["查询2025年8月销售额，不要分析和建议，只返回数值", "不要给我建议，只查销售额", "对比不同优惠的销售额，只返回金额", "比较2025年8月和7月销售额，只要金额", "各大区的销售额对比", "是否会员销售的占比是多少"]) assert.equal(analyticsDialogueMode(question), "lookup", question);
  for (const question of ["为什么这档优惠的效果差？", "比较不同优惠机制有没有增量", "比较不同优惠机制对销售的影响", "比较不同活动对销售的影响", "你好，帮我分析活动效果", "谢谢，再看一下哪些门店值得做试验"]) { assert.equal(quickAnalyticsReply(question), null); assert.equal(analyticsDialogueMode(question), "analysis"); }
  assert.equal(analyticsDialogueMode("那只看华南呢？", ["各大区销售额是多少"]), "lookup");
  assert.equal(analyticsDialogueMode("那只看华南呢？", ["分析各大区的活动效果"]), "analysis");
  assert.equal(analyticsDialogueMode("华南呢？", ["各大区销售额是多少"]), "lookup");
});

test("总额快捷查询保留业务上下文，旧寒暄答案不迫使新查数调用模型", () => {
  const request = { mode: "database" as const, question: "25年8月的总销售额是多少？", history: [{ role: "user" as const, text: "你好" }, { role: "assistant" as const, text: "你好，我是小福，已核对历史覆盖。想先聊什么？" }], context: ["你好"] };
  assert.ok(quickMonthlySalesQuery(request));
  assert.equal(quickMonthlySalesQuery({ ...request, context: ["只看华北门店"] }), null);
  assert.equal(quickMonthlySalesQuery({ ...request, history: [{ role: "user", text: "只看华北门店" }] }), null);
});
