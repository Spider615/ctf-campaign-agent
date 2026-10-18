import assert from "node:assert/strict";
import test from "node:test";
import { assemblePlanAnswer, planAnswerText, validatePlanAnswer } from "../app/lib/analytics/plan/answer.ts";
import type { PlanAnswerInput } from "../app/lib/analytics/plan/answer.ts";
import type { Binding, BoundClaim } from "../app/lib/analytics/plan/bind.ts";
import type { NodeResult, NodeRole, NodeRow, PlanExecution } from "../app/lib/analytics/plan/execute.ts";
import type { PlanNode, PlanScope } from "../app/lib/analytics/plan/types.ts";
import type { AnalysisCapabilities, AnalysisFact, AnalysisObject } from "../app/lib/analytics/analysis-v2-types.ts";

const scope = (filters: PlanScope["filters"] = {}): PlanScope => ({ period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales", filters });
const capabilities = {
  mode: "snapshot", name: "测试", coverage: { start: "2025-01-01", end: "2025-12-31" }, currency: "人民币", provenance: "sample", dimensions: ["district", "day"],
  dimensionCatalog: [
    { id: "district", label: "分区", filter: "districts", scan: true, definition: "大区加分区", basis: "data" },
    { id: "festival", label: "节庆", filter: "festivals", scan: true, definition: "节庆口径同月比较", basis: "assumption" },
    { id: "store", label: "门店", filter: "stores", scan: false, definition: "实体分店", basis: "schema" },
    { id: "day", label: "日期", filter: "days", scan: false, definition: "交易日期", basis: "schema" },
  ],
  metrics: [
    { id: "amount_per_day", label: "日均实收", unit: "money_per_day", grain: "line", additive: false, allowedPopulations: ["sales"], requiredControls: [], definition: "实收除以有成交日期数", basis: "data" },
    { id: "orders", label: "单数", unit: "单", grain: "line", additive: true, allowedPopulations: ["sales"], requiredControls: [], definition: "成交单数", basis: "assumption" },
  ],
  methods: ["aggregate"], limitations: [],
} as unknown as AnalysisCapabilities;

const objects: AnalysisObject[] = [{ id: "o1", frameId: "f", dimension: "district", value: "南区/B区", label: "南区/B区" }, { id: "o2", frameId: "f", dimension: "district", value: "东区/A区", label: "东区/A区" }, { id: "o3", frameId: "f", dimension: "festival", value: "七夕节", label: "七夕节" }];
const fact = (id: string, value: number | null, unit = "人民币/日", objectIds: string[] = [], metricId = "amount_per_day.delta"): AnalysisFact => ({ id, frameId: "f", metricId, label: id, value, unit, definition: "d", objectIds, operationId: "op", limitations: [] });
const row = (factId: string, role: NodeRole, key: Record<string, string> = {}, sampleRows?: number): NodeRow => ({ key, metric: "amount_per_day", factId, role, ...(sampleRows !== undefined ? { sampleRows } : {}) });
const done = (node: PlanNode, rows: NodeRow[]): NodeResult => ({ node, status: "completed", operationIds: ["op"], rows });
const window = (start: string, end: string, filters: PlanScope["filters"] = {}): PlanScope => ({ period: { start, end }, population: "sales", filters });
const contrast = (id: string, align?: Extract<PlanNode, { op: "contrast" }>["align"], periods?: { target: PlanScope; reference: PlanScope }): PlanNode => ({ id, op: "contrast", target: periods?.target ?? scope({ festivals: ["七夕节"] }), reference: periods?.reference ?? scope({ festivals: ["非节庆"] }), metrics: ["amount_per_day"], ...(align ? { align } : {}) });

function build(extra: Array<[PlanNode, NodeRow[]]> = [], facts: AnalysisFact[] = []): PlanExecution {
  const base = [fact("fd", 50), fact("fc", 100, "%", [], "amount_per_day.relative_change"), fact("fs", 30, "人民币/日", ["o1"]), fact("fe", -20, "人民币/日", ["o2"]), fact("fx", 5, "人民币/日", ["o2"]), ...facts];
  const results = new Map<string, NodeResult>();
  results.set("c", done(contrast("c"), [row("fd", "delta"), row("fc", "change")]));
  for (const [node, rows] of extra) results.set(node.id, done(node, rows));
  return {
    results,
    evidence: {
      frames: [{ id: "f", snapshotId: "s", datasetVersion: "v", mode: "snapshot", provenance: "sample", scope: { period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales", filters: {} }, currency: "人民币", grain: "line", controls: [], limitations: [] }],
      facts: base, objects,
      methods: [{ id: "m", operationId: "op", status: "completed", method: "aggregate", frameIds: ["f"], controls: [], checks: [{ name: "聚合", status: "performed", result: "ok" }], sampleRows: 10, groupCount: 1, limitations: [] }],
    },
  };
}
const bound = (node: string, factIds: string[], rendered: string, extra: Partial<BoundClaim> = {}): BoundClaim => ({ node, metric: "amount_per_day", assert: "up", text: rendered, factIds, rendered, confidence: "kept", ...extra });
const binding = (extra: Partial<Binding> = {}): Binding => ({ headline: bound("c", ["fd"], "七夕日均实收高 +50.00元/日"), claims: [], actions: [], dropped: [], droppedText: [], cannotConclude: [], questions: [], ...extra });
const input = (execution: PlanExecution, b: Binding, extra: Partial<PlanAnswerInput> = {}): PlanAnswerInput => ({ runId: "r1", question: "七夕怎么样", execution, binding: b, capabilities, droppedNodes: [], reviewNotes: [], ...extra });

test("三种状态", () => {
  const exec = build();
  assert.equal(assemblePlanAnswer(input(exec, binding())).status, "answered");
  assert.equal(assemblePlanAnswer(input(exec, binding(), { droppedNodes: [{ id: "x", reason: "维度不可用" }] })).status, "partial");
  const lost = binding({ dropped: [{ claim: bound("c", [], "x"), reason: "方向" }] });
  assert.equal(assemblePlanAnswer(input(exec, lost)).status, "partial");
  const none = assemblePlanAnswer(input(exec, binding({ headline: undefined })));
  assert.equal(none.status, "unavailable"); assert.equal(none.headline, undefined);
});

test("口径说明与待确认口径划分并去重", () => {
  const exec = build([], [fact("fo", 9, "单", ["o3"], "orders"), fact("fp", 1, "单", ["o1"], "orders")]);
  const b = binding({ headline: bound("c", ["fd", "fs"], "h"), claims: [bound("c", ["fo", "fp", "fc"], "c1")] });
  const answer = assemblePlanAnswer(input(exec, b));
  assert.deepEqual(answer.definitions, ["日均实收：实收除以有成交日期数", "分区：大区加分区"]);
  assert.deepEqual(answer.assumptions, ["口径待确认：单数，成交单数", "口径待确认：节庆，节庆口径同月比较"]);
});

test("cannotConclude 四个来源、去重与上限", () => {
  const exec = build();
  const b = binding({
    headline: bound("c", ["fd"], "主结论"),
    claims: [bound("c", ["fd"], "南区更高", { confidence: "flipped" }), bound("c", ["fd"], "东区暂无数据", { assert: "unavailable" })],
    cannotConclude: ["缺少门店口径", "缺少门店口径"],
    dropped: [{ claim: { node: "c", metric: "amount_per_day", assert: "unavailable", text: "北区的{value}无法计算", }, reason: "找不到对应分组" }, { claim: { node: "c", metric: "amount_per_day", assert: "unavailable", text: "中区无法计算", }, reason: "方向与事实不符：该值实际可以计算" }],
  });
  const answer = assemblePlanAnswer(input(exec, b, { droppedNodes: [{ id: "x", reason: "维度不可用" }] }));
  assert.deepEqual(answer.cannotConclude, ["未执行：维度不可用", "南区更高 在剔除检查后方向翻转，不能作为确定结论", "东区暂无数据", "北区的该值无法计算", "缺少门店口径"]);
  const many = assemblePlanAnswer(input(exec, binding({ cannotConclude: ["a", "b", "c", "d", "e"] }), { droppedNodes: [{ id: "x", reason: "r" }] }));
  assert.equal(many.cannotConclude.length, 5);
  // 代码推出的事项不会被模型写的挤掉。
  assert.equal(many.cannotConclude[0], "未执行：r");
  assert.deepEqual(many.cannotConclude.slice(1), ["a", "b", "c", "d"]);
  assert.deepEqual(answer.plan.at(-1), { id: "x", op: "dropped", status: "dropped", summary: "维度不可用" });
});

test("下钻出条形图：按偏离降序、过滤小样本", () => {
  const drill: PlanNode = { id: "d", op: "drill", of: "c", path: ["district"], minRows: 20 };
  const exec = build([[drill, [row("fs", "deviation", { district: "南区/B区" }, 30), row("fe", "deviation", { district: "东区/A区" }, 25), row("fx", "deviation", { district: "小区" }, 3)]]]);
  const answer = assemblePlanAnswer(input(exec, binding({ headline: bound("d", ["fs"], "南区偏离最大", { metric: "amount_per_day" }) })));
  const chart = answer.chart!;
  assert.equal(chart.kind, "bar"); assert.equal(chart.renderer, "native");
  assert.deepEqual(chart.categories.map((item) => item.label), ["南区/B区", "东区/A区"]);
  assert.deepEqual(chart.series[0].values.map((item) => item.value), [30, -20]);
  assert.deepEqual(chart.factIds, ["fs", "fe"]);
  assert.equal(chart.unit, "元/日"); assert.equal(chart.series[0].values[0].refIds[0], "fs");
  validatePlanAnswer(JSON.parse(JSON.stringify(answer)));
});

test("下钻、扫描未给 minRows 时按默认 200 行过滤", () => {
  const scan: PlanNode = { id: "s", op: "scan", of: "c" };
  const exec = build([[scan, [row("fs", "deviation", { district: "南区/B区" }, 300), row("fe", "deviation", { district: "东区/A区" }, 250), row("fx", "deviation", { district: "小区" }, 199)]]]);
  const answer = assemblePlanAnswer(input(exec, binding({ headline: bound("s", ["fs"], "南区偏离最大") })));
  assert.deepEqual(answer.chart!.categories.map((item) => item.label.replace(/^分区：/, "")), ["南区/B区", "东区/A区"]);
});

test("三个以上对齐方式不同的对比出分层条形图", () => {
  const nodes: Array<[PlanNode, NodeRow[]]> = [
    [contrast("c2", { commonStores: true }), [row("g2", "change")]],
    [contrast("c3", { controls: ["store", "day"] }), [row("g3", "change")]],
  ];
  const exec = build(nodes, [fact("g2", 80, "%", [], "amount_per_day.relative_change"), fact("g3", 60, "%", [], "amount_per_day.relative_change")]);
  const answer = assemblePlanAnswer(input(exec, binding()));
  assert.deepEqual(answer.chart!.categories.map((item) => item.label), ["全量", "共同门店", "同店同日"]);
  assert.deepEqual(answer.chart!.series[0].values.map((item) => item.value), [100, 80, 60]);
  assert.equal(answer.chart!.unit, "%");
  const two = assemblePlanAnswer(input(build(nodes.slice(0, 1), [fact("g2", 80, "%", [], "amount_per_day.relative_change")]), binding()));
  assert.equal(two.chart, undefined);
});

test("同窗口分层：四种对比按分层排序，窗口不同的不合并", () => {
  const wide = { target: window("2025-08-01", "2025-08-31", { festivals: ["七夕节"] }), reference: window("2025-07-01", "2025-07-31", { festivals: ["非节庆"] }) };
  const narrow = { target: window("2025-08-10", "2025-08-20"), reference: window("2025-08-10", "2025-08-20") };
  const nodes: Array<[PlanNode, NodeRow[]]> = [
    [contrast("c", undefined, wide), [row("fd", "delta"), row("fc", "change")]],
    [contrast("c4", { controls: ["store", "day"] }, wide), [row("g4", "change")]],
    [contrast("c3", undefined, narrow), [row("g3", "change")]],
    [contrast("c2", { commonStores: true }, wide), [row("g2", "change")]],
  ];
  const facts = ["g2", "g3", "g4"].map((id, index) => fact(id, 80 - index * 10, "%", [], "amount_per_day.relative_change"));
  const answer = assemblePlanAnswer(input(build(nodes, facts), binding()));
  assert.deepEqual(answer.chart!.categories.map((item) => item.label), ["全量", "共同门店", "同窗口", "同店同日"]);
  assert.deepEqual(answer.chart!.series[0].values.map((item) => item.value), [100, 80, 70, 60]);
  // 只差窗口的两个对比都保留；孤零零的相同窗口不叫同窗口。
  const two = assemblePlanAnswer(input(build(nodes.slice(0, 1).concat([nodes[2]]), facts), binding()));
  assert.equal(two.chart, undefined);
  const mixed = assemblePlanAnswer(input(build([nodes[0], nodes[2], [contrast("c5", { controls: ["district"] }, narrow), [row("g5", "change")]]], [...facts, fact("g5", 40, "%", [], "amount_per_day.relative_change")]), binding()));
  assert.deepEqual(mixed.chart!.categories.map((item) => item.label), ["全量", "同窗口", "同窗口·按分区"]);
  const alone = assemblePlanAnswer(input(build([[contrast("c2", { commonStores: true }), [row("g2", "change")]], [contrast("c3", { controls: ["store", "day"] }), [row("g3", "change")]]], facts), binding()));
  assert.deepEqual(alone.chart!.categories.map((item) => item.label), ["全量", "共同门店", "同店同日"]);
});

test("按日分组的 measure 出折线图，其他情况不出图", () => {
  const measure: PlanNode = { id: "m", op: "measure", scope: scope(), metrics: ["amount_per_day"], by: ["day"] };
  const days = [fact("d1", 10, "人民币/日", [], "amount_per_day"), fact("d2", 12, "人民币/日", [], "amount_per_day")];
  const exec = build([[measure, [row("d2", "value", { day: "2025-08-02" }), row("d1", "value", { day: "2025-08-01" })]]], days);
  const answer = assemblePlanAnswer(input(exec, binding({ headline: bound("m", ["d1"], "走势", { assert: "higher" }) })));
  assert.equal(answer.chart!.kind, "line");
  assert.deepEqual(answer.chart!.categories.map((item) => item.key), ["2025-08-01", "2025-08-02"]);
  const plainMeasure: PlanNode = { id: "m2", op: "measure", scope: scope(), metrics: ["amount_per_day"] };
  assert.equal(assemblePlanAnswer(input(build([[plainMeasure, [row("d1", "value")]]], days), binding({ headline: bound("m2", ["d1"], "x") }))).chart, undefined);
  assert.equal(assemblePlanAnswer(input(build(), binding())).chart, undefined);
});

test("计划摘要由代码生成", () => {
  const answer = assemblePlanAnswer(input(build(), binding()));
  assert.equal(answer.plan[0].id, "c"); assert.match(answer.plan[0].summary, /对比 七夕节 与 非节庆 的 日均实收/);
});

test("validatePlanAnswer 拒绝引用不存在事实、旧版本与超限", () => {
  const answer = assemblePlanAnswer(input(build(), binding({ claims: [bound("c", ["fc"], "变化")], actions: [{ text: "备货", claim: 0 }] })));
  const roundTrip = validatePlanAnswer(JSON.parse(JSON.stringify(answer)));
  assert.equal(roundTrip.headline!.text, answer.headline!.text);
  const copy = () => JSON.parse(JSON.stringify(answer));
  const bad = copy(); bad.claims[0].factIds = ["nope"]; assert.throws(() => validatePlanAnswer(bad), /不存在的事实/);
  const badSchema = copy(); badSchema.schema = "analysis-answer/v2"; assert.throws(() => validatePlanAnswer(badSchema), /版本/);
  const tooMany = copy(); tooMany.cannotConclude = ["1", "2", "3", "4", "5", "6"]; assert.throws(() => validatePlanAnswer(tooMany), /最多/);
  const nonString = copy(); nonString.actions = [1]; assert.throws(() => validatePlanAnswer(nonString), /文字/);
  const manyClaims = copy(); manyClaims.claims = Array.from({ length: 6 }, () => manyClaims.headline); assert.throws(() => validatePlanAnswer(manyClaims), /最多/);
  const badEvidence = copy(); badEvidence.evidence.facts[0].frameId = "missing"; assert.throws(() => validatePlanAnswer(badEvidence));
});

test("planAnswerText 依次拼出主结论、结论、行动、不能下结论和待确认口径", () => {
  const exec = build([], [fact("fo", 9, "单", ["o3"], "orders")]);
  const answer = assemblePlanAnswer(input(exec, binding({ claims: [bound("c", ["fo"], "单数也增加")], actions: [{ text: "备货", claim: 0 }], cannotConclude: ["缺少门店口径"] })));
  const text = planAnswerText(answer);
  assert.ok(text.startsWith("七夕日均实收高 +50.00元/日"));
  for (const part of ["单数也增加", "备货", "缺少门店口径", "口径待确认：单数"]) assert.ok(text.includes(part), part);
  assert.ok(text.indexOf("备货") < text.indexOf("缺少门店口径"));
});

test("主结论绑定分组汇总时，关键数据表和图按分组从高到低列出", () => {
  const m: PlanNode = { id: "m", op: "measure", scope: scope(), by: ["district"], metrics: ["amount_per_day"] };
  const exec = build([[m, [row("g1", "value", { district: "南区/B区" }), row("g2", "value", { district: "东区/A区" })]]], [fact("g1", 10, "人民币/日", ["o1"], "amount_per_day"), fact("g2", 30, "人民币/日", ["o2"], "amount_per_day")]);
  const answer = assemblePlanAnswer(input(exec, binding({ headline: bound("m", ["g2"], "东区/A区最高", { select: { district: "东区/A区" }, assert: "largest" }) })));
  assert.equal(answer.figures?.targetLabel, "日均实收");
  assert.deepEqual(answer.figures?.rows.map((item) => item.label), ["东区/A区", "南区/B区"]);
  assert.equal(answer.chart?.kind, "bar");
  assert.deepEqual(answer.chart?.categories.map((item) => item.label), ["东区/A区", "南区/B区"]);
});
