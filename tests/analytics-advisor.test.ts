import assert from "node:assert/strict";
import test from "node:test";
import { sampleDataset } from "../app/lib/analytics/sample.ts";
import { runAnalysis } from "../app/lib/analytics/engine.ts";
import { validateExplanation, validateAnalyticsResponse, isAnalyticsExplainRequest } from "../app/lib/analytics/explain.ts";
import { composeAdvice, reportSource, citationNumbers, sourceStatement } from "../app/lib/analytics/advisor.ts";
import { createAnalyticsTools } from "../agent/analytics-tools.ts";
import type { AdvisorSource } from "../app/lib/analytics/types.ts";

const report = () => ({ ...runAnalysis(sampleDataset(), { period: { start: "2026-08-01", end: "2026-09-30" }, filters: {} }), id: "advisor-test", createdAt: "2026-10-13" });

function namedSource(label: string, id = "offer", dimension = "活动"): AdvisorSource {
  const fields = [{ label: "成交金额", value: 1200, unit: "人民币" }];
  return { id: `mysql:fixture:${id}`, kind: "database", title: `${dimension}：${label}`, provenance: "imported", datasetVersion: "a".repeat(64),
    capturedAt: "2026-10-13T00:00:00Z", periodLabel: "2025-08-01至2025-08-31", scope: "仅测试夹具", definition: "测试成交口径", recordId: "fixture",
    rows: [{ label, fields }], statements: [sourceStatement(label, fields)], limitations: [] };
}

test("已引用的活动名称、门店编号及证据日期不会被误判为经营数字", () => {
  const offer = namedSource("H-定价类92折"); const august = namedSource("H-奥莱-8月", "august"); const store = namedSource("1001", "store", "门店");
  for (const [source, text] of [
    [offer, "先在使用H-定价类92折的可比门店验证。"],
    [august, "先在使用「H-奥莱-8月」的可比门店验证。"],
    [store, "先核对门店1001在2025年8月的货品结构。"],
  ] as const) {
    const value = composeAdvice([{ kind: "recommendation", text, evidenceIds: [source.id] }], [offer, august, store]);
    assert.equal(value.advice[0].text, text);
    assert.equal(validateAnalyticsResponse(null, { insightIds: [], nextDimensions: [], tools: [], ...value }).advice![0].text, text);
  }
  assert.throws(() => composeAdvice([{ kind: "recommendation", text: "先核对H-定价类92折", evidenceIds: [store.id] }], [offer, store]), /数字/);
  assert.throws(() => composeAdvice([{ kind: "recommendation", text: "先核对H-定价类93折", evidenceIds: [offer.id] }], [offer]), /数字/);
  assert.throws(() => composeAdvice([{ kind: "recommendation", text: "先核对2024年8月的货品结构", evidenceIds: [store.id] }], [store]), /数字/);
});

test("真实名称中的数字不能用来豁免额外金额或效果承诺", () => {
  const source = namedSource("100", "store", "门店"); const offer = namedSource("H-定价类92折");
  for (const text of ["销售100元", "销售１００元", "销售「100」元", "预计提升「100」个百分点", "预计增长「100」多元", "预计销量「100」", "先核对门店100元的销售", "预计达到门店100多元", "预计达到门店100余元", "预计提升门店「100」个百分点", "目前覆盖门店100个", "建议覆盖门店「100」个", "预计活动100条", "预计活动100笔", "H-定价类92折能提升20%", "H-定价类92折保证增长"]) {
    assert.throws(() => composeAdvice([{ kind: "recommendation", text, evidenceIds: [source.id, offer.id] }], [source, offer]), /数字|因果/, text);
  }
  assert.doesNotThrow(() => composeAdvice([{ kind: "recommendation", text: "先核对门店「100」的货品结构", evidenceIds: [source.id] }], [source]));
});

test("实际窗口和比较窗口中的中文日期可以正常引用", () => {
  const source = namedSource("测试活动");
  for (const [periodLabel, text] of [
    ["2025-08-05至2025-08-31", "先核对2025年8月5日至2025年8月31日的货品结构"],
    ["2025-08-01至2025-08-31；比较2025-07-01至2025-07-31", "先比较2025年8月与2025年7月的货品结构"],
  ]) {
    const current = { ...source, periodLabel };
    const answer = composeAdvice([{ kind: "recommendation", text, evidenceIds: [source.id] }], [current]);
    assert.equal(answer.advice[0].text, text);
  }
  assert.throws(() => composeAdvice([{ kind: "recommendation", text: "先核对2024年8月5日", evidenceIds: [source.id] }], [source]), /数字/);
});

test("按活动筛选的门店证据允许引用筛选中的真实活动名", () => {
  const source = { ...namedSource("1001", "store", "门店"), scope: "开单优惠名称：H-定价类92折、H-奥莱-8月；货类：测试货类；源币种：人民币，未换汇" };
  for (const text of ["先核对H-定价类92折下门店1001的货品结构", "先在使用「H-奥莱-8月」的可比门店验证"]) {
    assert.equal(composeAdvice([{ kind: "recommendation", text, evidenceIds: [source.id] }], [source]).advice[0].text, text);
  }
  const unsupported = { ...source, scope: "限制：预计增长20%" };
  assert.throws(() => composeAdvice([{ kind: "recommendation", text: "预计增长20%", evidenceIds: [source.id] }], [unsupported]), /数字/);
});

test("完成回合保留已核验数据与建议，移除未核验数字和无效引用", async () => {
  const source = namedSource("H-定价类92折"); let reads = 0;
  const database = { inspect: async () => ({ available: true, name: "测试", limitations: [] }), query: async () => { reads++; return [source]; } };
  const tools = createAnalyticsTools({ mode: "database", question: "有哪些营销机会", history: [] }, undefined, database);
  await tools.read("query_sales_history", { query: { period: { start: "2025-08-01", end: "2025-08-31" } } });
  const answer = tools.finish({ insightIds: [], nextDimensions: [], advice: [
    { kind: "observation", text: "", evidenceIds: [source.id], metricLabels: ["成交金额"] },
    { kind: "recommendation", text: "先在H-定价类92折的可比门店验证", evidenceIds: [source.id] },
    { kind: "hypothesis", text: "销售将提升20%", evidenceIds: [source.id] },
    { kind: "recommendation", text: "扩大推广", evidenceIds: ["未读取来源"] },
  ] });
  assert.equal(answer.partial, true); assert.equal(answer.advice!.length, 2);
  assert.match(answer.advice![0].text, /成交金额为1,200元/);
  assert.equal(answer.advice![1].text, "先在H-定价类92折的可比门店验证");
  assert.ok(!JSON.stringify(answer).includes("20%")); assert.ok(!JSON.stringify(answer).includes("未读取来源"));
  assert.equal(validateAnalyticsResponse(null, answer).partial, true); assert.equal(reads, 1);
});

test("全部判断未通过时仍可展示已经读取的数据，不伪造建议或再次查库", async () => {
  const source = namedSource("测试活动"); let reads = 0;
  const database = { inspect: async () => ({ available: true, name: "测试", limitations: [] }), query: async () => { reads++; return [source]; } };
  const tools = createAnalyticsTools({ mode: "database", question: "有哪些营销机会", history: [] }, undefined, database);
  await tools.read("query_sales_history", {});
  const answer = tools.finish({ insightIds: [], nextDimensions: [], advice: [{ kind: "recommendation", text: "销售将提升20%", evidenceIds: [source.id] }] });
  assert.equal(answer.partial, true); assert.deepEqual(answer.advice!.map((item) => item.kind), ["observation"]);
  assert.match(answer.advice![0].text, /成交金额为1,200元/); assert.equal(answer.sources![0].id, source.id);
  assert.equal(validateAnalyticsResponse(null, answer).partial, true); assert.equal(reads, 1);
});

test("手写观察恢复为真实指标，缺失指标仍不能补零", () => {
  const source = namedSource("测试活动"); source.rows[0].fields.push({ label: "毛利", value: null, unit: "人民币" });
  const answer = composeAdvice([
    { kind: "observation", text: "成交金额999999元", evidenceIds: [source.id], metricLabels: ["成交金额"] },
    { kind: "observation", text: "", evidenceIds: [source.id], metricLabels: ["毛利"] },
  ], [source], "partial");
  assert.equal(answer.partial, true); assert.equal(answer.advice.length, 1);
  assert.match(answer.advice[0].text, /成交金额为1,200元/); assert.ok(!answer.advice[0].text.includes("999999"));
  assert.ok(!answer.advice[0].text.includes("毛利"));
});

test("营销建议不能引用不存在的数据出处", () => {
  assert.throws(() => validateExplanation(report(), {
    insightIds: [], nextDimensions: [],
    advice: [{ kind: "recommendation", text: "先在可比门店验证", evidenceIds: ["假的来源"] }],
  }), /来源|证据/);
});

test("模型不能在营销解释中直接补写经营数字", () => {
  assert.throws(() => validateExplanation(report(), {
    insightIds: [], nextDimensions: [],
    advice: [{ kind: "hypothesis", text: "活动可以让销售提升20%", evidenceIds: [] }],
  }), /数字|经营/);
});

test("中文数量和优惠参数也不能绕过经营数字守卫", () => {
  for (const text of ["活动可让销量增加三百件", "预计销售提升二十个百分点", "建议发放每克减两元的优惠", "预计新增五十名会员", "销售会翻一倍", "建议让利贰拾元", "预计销售提升二 十 个百分点", "预计新增五十余名会员", "预计销量增加三百多件", "预计销售提升二十余个百分点", "预计销售增长一半", "预计销售增长三分之一", "销售可以翻番", "销售可以翻倍", "退货率将减半"]) {
    assert.throws(() => validateExplanation(report(), { insightIds: [], nextDimensions: [], advice: [{ kind: "recommendation", text, evidenceIds: [] }] }), /数字|经营/, text);
    assert.throws(() => validateAnalyticsResponse(report(), { insightIds: [], nextDimensions: [], sources: [], tools: [], advice: [{ kind: "recommendation", text, evidenceIds: [] }] }), /数字|经营/, text);
  }
  assert.doesNotThrow(() => validateExplanation(report(), { insightIds: [], nextDimensions: [], advice: [{ kind: "recommendation", text: "先按计价金与一口价分开核对，再在可比门店验证", evidenceIds: [] }] }));
  assert.doesNotThrow(() => validateExplanation(report(), { insightIds: [], nextDimensions: [], advice: [{ kind: "recommendation", text: "先核对千克与克的单位，再比较净金重", evidenceIds: [] }] }));
});

test("同版本报告来源仍须与保存的真实计算结果一致", () => {
  const r = report(); const source = reportSource(r, "overall");
  const value = composeAdvice([{ kind: "observation", text: "", evidenceIds: [source.id] }], [source]);
  assert.doesNotThrow(() => validateAnalyticsResponse(r, { insightIds: [], nextDimensions: [], tools: [], ...value }));
  const fake = structuredClone(source); fake.rows[0].fields.find((f) => f.label === "净销售额")!.value = 999999;
  const forged = composeAdvice([{ kind: "observation", text: "", evidenceIds: [fake.id], metricLabels: ["净销售额"] }], [fake]);
  assert.throws(() => validateAnalyticsResponse(r, { insightIds: [], nextDimensions: [], tools: [], ...forged }), /来源|报告|证据/);
  const wrongTarget = { ...source, reportEvidenceId: { forged: true } };
  assert.throws(() => validateAnalyticsResponse(r, { insightIds: [], nextDimensions: [], tools: [], sources: [wrongTarget], advice: [] }), /来源/);
});

test("建议候选的隐式引用也计入每条来源上限", () => {
  const sources = ["A", "B", "C", "D"].map((id) => ({ ...reportSource(report(), "overall"), id: `history:${id}`, kind: "historical" as const, title: id }));
  assert.throws(() => composeAdvice([{ kind: "recommendation", text: "先在可比门店验证", evidenceIds: sources.slice(0, 3).map((s) => s.id), target: { sourceId: sources[3].id, label: sources[3].title } }], sources), /来源.*过多|上限/);
});

test("快照请求拒绝缺字段、错误覆盖日期和非有限报告数字", () => {
  const request = { report: report(), dataset: sampleDataset(), question: "哪里可以优化" };
  assert.equal(isAnalyticsExplainRequest(request), true);
  for (const change of [
    (r: typeof request) => { delete (r.dataset.rows[0] as Partial<typeof r.dataset.rows[0]>).memberId; },
    (r: typeof request) => { r.dataset.rows[0].date = "2026-02-30"; },
    (r: typeof request) => { r.dataset.minDate = "2024-01-01"; },
    (r: typeof request) => { r.report.metrics.sales = Infinity; },
    (r: typeof request) => { r.dataset.provenance = "imported"; },
  ]) { const invalid = structuredClone(request); change(invalid); assert.equal(isAnalyticsExplainRequest(invalid), false); }
});

test("重算只使用授权快照并保留原筛选，来源读取后才可引用", () => {
  const dataset = sampleDataset(); const r = { ...report(), query: { period: { start: "2026-08-01", end: "2026-09-30" }, filters: { stores: ["示例门店1"] } } };
  const request = { report: r, dataset, question: "按货类比较" }; const before = structuredClone(request); const tools = createAnalyticsTools(request);
  const query = { period: { start: "2026-08-01", end: "2026-08-07" }, filters: {} };
  const result = tools.read("analyze_snapshot", { query, dimension: "category" }) as { metrics: { sales: number }; query: typeof r.query; evidence: Array<{ id: string }> };
  const expected = runAnalysis(dataset, { ...query, filters: r.query.filters });
  assert.equal(result.metrics.sales, expected.metrics.sales); assert.deepEqual(result.query.filters, r.query.filters);
  const output = { insightIds: [], nextDimensions: [], advice: [{ kind: "observation", text: "", evidenceIds: [result.evidence[0].id], metricLabels: ["净销售额"] }] };
  assert.throws(() => tools.finish(output), /未读取|来源/);
  tools.read("read_analysis_evidence", { evidenceId: result.evidence[0].id });
  const answer = tools.finish(output); assert.match(answer.advice![0].text, new RegExp(expected.metrics.sales.toLocaleString("zh-CN")));
  assert.doesNotThrow(() => validateAnalyticsResponse(r, answer));
  assert.throws(() => tools.read("analyze_snapshot", { query: { ...query, filters: { stores: [] } } }), /筛选/);
  assert.throws(() => tools.read("analyze_snapshot", { query: { ...query, filters: { stores: ["示例门店2"] } } }), /筛选/);
  assert.throws(() => tools.read("analyze_snapshot", { query: { ...query, period: { start: "2024-08-01", end: "2024-08-07" } } }), /周期/);
  assert.throws(() => createAnalyticsTools({ report: r, question: "复盘" }).read("analyze_snapshot", { query }), /授权数据快照/);
  assert.deepEqual(request, before);
});

test("事实句由证据生成，缺失指标不补零，重复引用复用角标", () => {
  const dataset = sampleDataset(); dataset.rows.forEach((row) => { row.cost = null; });
  const r = { ...runAnalysis(dataset, { period: { start: "2026-08-01", end: "2026-08-07" }, filters: {} }), id: "null-test" };
  const source = reportSource(r, "overall");
  assert.equal(source.rows[0].fields.find((f) => f.label === "毛利")!.value, null);
  assert.throws(() => composeAdvice([{ kind: "observation", text: "", evidenceIds: [source.id], metricLabels: ["毛利"] }], [source]), /不能补零/);
  assert.throws(() => composeAdvice([{ kind: "observation", text: "销售已增长", evidenceIds: [source.id] }], [source]), /证据生成/);
  const another: AdvisorSource = { ...source, id: "history:OTHER", kind: "historical", title: "计价金候选", rows: [{ ...source.rows[0], label: "真实候选" }] };
  const value = composeAdvice([
    { kind: "observation", text: "", evidenceIds: [source.id], metricLabels: ["净销售额"] },
    { kind: "recommendation", text: "优先在可比门店验证，核对成本后再决定", evidenceIds: [another.id, source.id], target: { sourceId: another.id, label: "真实候选" } },
  ], [source, another]);
  assert.ok(!value.advice[0].text.includes("毛利"));
  assert.deepEqual([...citationNumbers(value.advice)], [[source.id, 1], [another.id, 2]]);
  assert.throws(() => composeAdvice([{ kind: "recommendation", text: "建议试验", evidenceIds: [], target: { sourceId: another.id, label: "不存在的力度" } }], [another]), /真实对象/);
  const noEvidence = composeAdvice([{ kind: "recommendation", text: "先核对活动规则，再设置门店试验", evidenceIds: [] }], []);
  assert.equal(citationNumbers(noEvidence.advice).size, 0); assert.deepEqual(noEvidence.sources, []);
});
