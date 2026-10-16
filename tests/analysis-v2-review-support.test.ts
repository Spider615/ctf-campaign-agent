import test from "node:test";
import assert from "node:assert/strict";
import { inspectAnalysisSupport, compareReviewFacts } from "../agent/analytics-review-support.ts";
import type { AnalysisCapabilities, AnalysisDraft, AnalysisEvidence, AnalysisFact, AnalysisFrame } from "../app/lib/analytics/analysis-v2-types.ts";

const frame = (id: string, start: string, end: string, population: "net" | "sales" = "net"): AnalysisFrame => ({ id, snapshotId: "snapshot", datasetVersion: "sample", mode: "snapshot", provenance: "sample", scope: { period: { start, end }, population, filters: {} }, currency: "CNY", grain: "group", controls: [], limitations: [] });
const fact = (id: string, value: number | null, metricId = "amount", frameId = "current"): AnalysisFact => ({ id, frameId, metricId, value, label: metricId, unit: "CNY", definition: "构造事实", objectIds: [], operationId: "decomposition", limitations: [] });
const capabilities: AnalysisCapabilities = { mode: "snapshot", name: "构造样本", coverage: { start: "2026-08-01", end: "2026-09-07" }, currency: "CNY", provenance: "sample", dimensions: ["category"], metrics: [{ id: "amount", label: "实收", unit: "CNY", grain: "line", additive: true, allowedPopulations: ["sales", "net"], requiredControls: [], definition: "实收" }], methods: ["aggregate", "decompose", "robustness"], limitations: ["没有材料字段"] };
const draft: AnalysisDraft = { status: "answered", conclusions: [{ id: "driver", needIds: ["need-1"], level: "comparison_supported", judgement: "净增基本等于单位实收效应", factIds: ["total", "price"], objectIds: [], methodIds: ["method"], limitations: [] }], blocks: [], questions: [], userConditions: [], trialParameters: [] };
const evidence: AnalysisEvidence = { frames: [frame("current", "2026-09-01", "2026-09-07"), frame("reference", "2026-08-01", "2026-08-31")], objects: [], methods: [{ id: "method", operationId: "decomposition", method: "decompose", status: "completed", frameIds: ["current", "reference"], controls: [], checks: [], sampleRows: 20, groupCount: 2, limitations: ["算术贡献不能当作业务原因"] }], facts: [fact("sales", 4200, "amount.sales_contribution"), fact("returns", -1500, "amount.returns_contribution"), { ...fact("total", 2700, "amount.decomposed_change"), derivation: { op: "add", args: [{ factId: "sales" }, { factId: "returns" }] } }, fact("price", 4200, "amount.price_contribution")] };

test("分析复核必须分别审查直接回答、证据适用性和行动价值，不能只核对数字", async () => {
  const { validateDecisionQuality } = await import("../agent/analytics-review-support.ts");
  assert.equal(typeof validateDecisionQuality, "function", "尚未提供决策交付复核门禁");
  const check = { status: "supported" as const, reason: "核对原始问题、真实对象及有依据的条件" };
  const actionDraft = { ...draft, conclusions: [{ ...draft.conclusions[0], action: "在已识别候选中调整货品范围", validation: "观察目标指标与源毛利的可比变化" }] };
  const base = { mode: "analysis" as const, draft: actionDraft, verdict: "accept" as const, issues: [] };
  assert.match(validateDecisionQuality(base)!, /直接回答|决策/);
  const decisionQuality = { directAnswer: check, evidenceFit: check, actionValue: check };
  assert.equal(validateDecisionQuality({ ...base, decisionQuality }), undefined);
  assert.match(validateDecisionQuality({ ...base, decisionQuality: { ...decisionQuality, actionValue: { status: "not_applicable", reason: "不能跳过建议" } } })!, /建议|行动/);
  assert.match(validateDecisionQuality({ ...base, decisionQuality: { ...decisionQuality, evidenceFit: { status: "revise", reason: "不同货品的单次总额比较不支持总体判断" } } })!, /退回|revise/);
  assert.equal(validateDecisionQuality({ ...base, mode: "lookup" }), undefined);
});

test("复核支持包提供已选小范围相对同口径总体的份额，不能用限制声明代替适用性检查", () => {
  const narrow = { ...frame("narrow", "2026-09-01", "2026-09-07"), scope: { ...evidence.frames[0].scope, filters: { offers: ["模拟局部优惠"] } } };
  const source = { ...evidence, frames: [...evidence.frames, narrow], facts: [...evidence.facts, fact("whole", 10000), fact("chosen", 10, "amount", "narrow")] };
  const conclusion = { ...draft.conclusions[0], factIds: ["chosen"] };
  const packet = inspectAnalysisSupport(conclusion, { ...draft, conclusions: [conclusion] }, source, capabilities);
  assert.equal(packet.selectionContext.length, 1);
  assert.equal(packet.selectionContext[0].selectedFactId, "chosen");
  assert.equal(packet.selectionContext[0].widerFactId, "whole");
  assert.equal(packet.selectionContext[0].sharePct, 0.1);
});

test("独立复核的数值比较只返回真实端点摘要，巨大表达式仍留在注册证据中", () => {
  const wide: AnalysisFact = { ...fact("wide", 4200), derivation: { op: "divide", args: [{ op: "add", args: Array.from({ length: 10000 }, () => ({ factId: "sales" })) }, { constant: 10000 }] } };
  const source = { ...evidence, facts: [...evidence.facts, wide] };
  const checked = compareReviewFacts(source, "wide", "price");
  assert.equal(checked.left.id, "wide"); assert.equal(checked.left.value, 4200); assert.equal(checked.difference, 0); assert.equal(checked.ratio, 1);
  assert.ok(JSON.stringify(checked).length < 8000, "复核算术端点不应携带整个派生表达式");
  assert.ok(JSON.stringify(wide.derivation).length > 100000, "呈现投影不能修改原始派生图");
});

test("复核支持包给出有符号贡献与真实差距，不由模型心算或设近似相等门槛", () => {
  const packet = inspectAnalysisSupport(draft.conclusions[0], draft, evidence, capabilities);
  assert.deepEqual(packet.balances[0].terms.map((term) => [term.factId, term.signedValue]), [["sales", 4200], ["returns", -1500]]);
  assert.equal(packet.balances[0].residual, 0);
  const comparison = compareReviewFacts(evidence, "total", "price");
  assert.equal(comparison.difference, -1500); assert.equal(comparison.ratio, 2700 / 4200);
  assert.equal(comparison.purpose, "仅核对已登记数值之间的算术关系，不产生新的经营事实或可比性证明");
});

test("复核支持包保留真实日历天数，另读相等金额不改变原比较范围", () => {
  const packet = inspectAnalysisSupport(draft.conclusions[0], draft, evidence, capabilities);
  assert.deepEqual(packet.frames.map((item) => item.calendarDays), [7, 31]);
  assert.match(packet.rules.join(""), /无记录.*完整/);
});

test("已确认unsupported与能力缺字段一起进入复核，不能因货类相同补造材料", () => {
  const missing: AnalysisEvidence = { ...evidence, methods: [...evidence.methods, { id: "missing", operationId: "ratio", method: "compare", status: "unsupported", frameIds: [], controls: [], checks: [{ name: "执行能力", status: "unavailable", result: "缺少材料字段，未计算每克实收" }], sampleRows: 0, groupCount: 0, limitations: ["不能手算替代控制"] }] };
  const packet = inspectAnalysisSupport(draft.conclusions[0], draft, missing, capabilities);
  assert.equal(packet.unavailable[0].id, "missing");
  assert.ok(!packet.capabilities.dimensions.includes("material"));
  assert.match(packet.rules.join(""), /不能扩大/);
});

test("只读算术关系拒绝未知、单位冲突和历史未知币种，缺失与零分母保留为空", () => {
  assert.throws(() => compareReviewFacts(evidence, "invented", "price"), /登记/);
  const changed = structuredClone(evidence); changed.facts[1].unit = "克";
  assert.throws(() => compareReviewFacts(changed, "total", "returns"), /单位/);
  changed.facts[1].unit = "CNY"; changed.facts[1].value = 0;
  assert.equal(compareReviewFacts(changed, "total", "returns").ratio, null);
  changed.facts[0].value = null; assert.equal(compareReviewFacts(changed, "sales", "price").difference, null);
  changed.frames[0].currency = "未核对"; changed.frames[0].scope.population = "unknown";
  assert.throws(() => compareReviewFacts(changed, "total", "price"), /口径/);
});
