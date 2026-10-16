import assert from "node:assert/strict";
import test from "node:test";
import { createSnapshotAnalysisProvider } from "../app/lib/analytics/analysis-v2-snapshot.ts";
import { createAnalysisOperations } from "../app/lib/analytics/analysis-v2-operations.ts";
import { createEvidenceRegistry, selectAnalysisEvidence, validateAnalysisDraft } from "../app/lib/analytics/analysis-v2-evidence.ts";
import { createEvidenceDelivery, analysisEvidencePage } from "../agent/analytics-evidence-context.ts";
import type { AnalyticsDataset, SalesRow } from "../app/lib/analytics/types.ts";
import type { AnalysisDraft } from "../app/lib/analytics/analysis-v2-types.ts";
import { normalizeNetChanges } from "../app/lib/analytics/analysis-v2-scenarios.ts";
import { analysisAnswerText, formatAnalysisNode } from "../app/lib/analytics/analysis-v2-format.ts";

const scope = { period: { start: "2026-04-01", end: "2026-04-01" }, population: "sales" as const, filters: {} };
const row = (input: Partial<SalesRow> = {}): SalesRow => ({ lineId: crypto.randomUUID(), date: scope.period.start, store: "模拟A店", orderId: "模拟单", category: "模拟货类", sku: null, region: null, city: null, memberId: null, memberSegment: null, campaignId: null, netSales: 100, quantity: 1, weightGrams: 1, cost: 60, ...input });
export const scenarioDataset = (rows: SalesRow[]): AnalyticsDataset => ({ schema: "analytics-dataset/v1", id: "scenario-synthetic", version: "scenario-v1", name: "合成情景数据", provenance: "sample", currency: "CNY", createdAt: scope.period.start, minDate: scope.period.start, maxDate: scope.period.end, sourceFiles: [], rules: [], warnings: [], mappings: { sales: {}, campaigns: {} }, rows });

test("逐行情景在实收下限内计算完整损失，不能用总克重替代逐行封顶", async () => {
  const session = await createSnapshotAnalysisProvider(scenarioDataset([row({ netSales: 1, weightGrams: 10 }), row({ netSales: 100, weightGrams: 1 })])).open();
  try {
    assert.ok(session.scenario, "快照尚未开放完整逐行情景");
    const result = await session.scenario({ scope, adjustment: { kind: "per_gram", amount: "2" } });
    assert.equal(result.amountCents, 10100); assert.equal(result.lossCents, 300);
    assert.equal(result.units, 11); assert.equal(result.sampleRows, 2);
  } finally { await session.close(); }
});

test("每行半分各自舍入后求和；按件与金额比例遵循各自规则", async () => {
  const session = await createSnapshotAnalysisProvider(scenarioDataset([row(), row()])).open();
  try {
    assert.ok(session.scenario);
    assert.equal((await session.scenario({ scope, adjustment: { kind: "per_item", amount: "0.005" } })).lossCents, 2);
    assert.equal((await session.scenario({ scope, adjustment: { kind: "amount_rate", rate: "0.125" } })).lossCents, 2500);
    const entire = await session.scenario({ scope, adjustment: { kind: "per_item", amount: "9999" } });
    assert.equal(entire.lossCents, entire.amountCents);
  } finally { await session.close(); }
});

test("满额与按单优惠使用店号加单号，先聚合同订单成交部分再判断门槛", async () => {
  const session = await createSnapshotAnalysisProvider(scenarioDataset([row({ netSales: 30 }), row({ netSales: 80 }), row({ store: "模拟B店", netSales: 80 })])).open();
  try {
    assert.ok(session.scenario);
    const threshold = await session.scenario({ scope, adjustment: { kind: "order_threshold", threshold: "100", amount: "20" } });
    assert.equal(threshold.lossCents, 2000); assert.equal(threshold.units, 2); assert.equal(threshold.eligibleUnits, 1);
    assert.equal((await session.scenario({ scope, adjustment: { kind: "per_order", amount: "20" } })).lossCents, 4000);
  } finally { await session.close(); }
});

test("缺金重、缺复合单号或非正单位不产生部分范围情景，失效与退货不参与", async () => {
  const session = await createSnapshotAnalysisProvider(scenarioDataset([row({ weightGrams: null }), row({ weightGrams: 0, orderId: null }), row({ quantity: -1, netSales: -50 })])).open();
  assert.ok(session.scenario);
  const grams = await session.scenario({ scope, adjustment: { kind: "per_gram", amount: "2" } });
  assert.equal(grams.lossCents, null); assert.equal(grams.missingUnits, 1); assert.equal(grams.nonpositiveUnits, 1); assert.equal(grams.sampleRows, 2);
  const orders = await session.scenario({ scope, adjustment: { kind: "per_order", amount: "2" } });
  assert.equal(orders.lossCents, null); assert.equal(orders.missingUnits, 1);
  await assert.rejects(session.scenario({ scope: { ...scope, population: "net" }, adjustment: { kind: "per_item", amount: "2" } }), /销售正金额|sales/);
  await session.close(); await assert.rejects(session.scenario({ scope, adjustment: { kind: "per_item", amount: "2" } }), /失效|快照/);
});

test("不可用币种不声明精确情景能力，未知筛选不被当成有效空范围", async () => {
  const dataset = scenarioDataset([row()]); Object.assign(dataset, { currency: "USD" });
  const unsupported = await createSnapshotAnalysisProvider(dataset).open();
  try { assert.deepEqual(unsupported.capabilities.scenarios, []); } finally { await unsupported.close(); }
  const session = await createSnapshotAnalysisProvider(scenarioDataset([row()])).open();
  try {
    assert.ok(session.scenario);
    await assert.rejects(session.scenario({ scope: { ...scope, filters: { materials: ["未连接材料"] } }, adjustment: { kind: "per_item", amount: "2" } }), /字段|筛选/);
  } finally { await session.close(); }
});

test("受控情景绑定已读总体基线，输出保本条件与完整父链，不能变成历史观察", async () => {
  const session = await createSnapshotAnalysisProvider(scenarioDataset([row({ quantity: 100, netSales: 1000 })])).open();
  try {
    const scenarioModule = await import("../agent/analytics-scenarios.ts").catch(() => null); assert.ok(scenarioModule, "情景尚未接入受控证据");
    const registry = createEvidenceRegistry(); const baseline = await createAnalysisOperations(session, { filters: {} }).execute({ needIds: ["need"], purpose: "基线", method: "aggregate", scope, metrics: ["amount"] }); registry.ingest(baseline);
    const delivery = createEvidenceDelivery(); delivery.record(analysisEvidencePage(baseline));
    const input = { needIds: ["need"], purpose: "计算新增成交的持平条件", baselineFactId: baseline.facts[0].id, adjustment: { kind: "per_item", amount: "1.5" }, netVolumeChanges: ["0", "0.1", "0.2"], reason: "未执行的显式情景，商品及价格结构不变，净增排除成交挪动" };
    await assert.rejects(scenarioModule.simulateAnalysis(input, registry.view(), session, () => false), /已读|读取/);
    const outcome = await scenarioModule.simulateAnalysis(input, registry.view(), session, delivery.hasReadFact); registry.ingest(outcome);
    const fact = outcome.facts.find((item) => item.metricId === "scenario.break_even_pct")!;
    assert.ok(Math.abs(fact.value! - 17.64705882352942) < 1e-10);
    const after = outcome.facts.filter((item) => item.metricId === "scenario.revenue_after"); assert.deepEqual(after.map((item) => item.value), [850, 935, 1020]);
    const draft: AnalysisDraft = { status: "answered", conclusions: [{ id: "c", needIds: ["need"], level: "hypothesis", judgement: "新增成交必须覆盖额外让利", factIds: [after[0].id], objectIds: [], methodIds: [outcome.methods[0].id], limitations: outcome.limitations }], blocks: [{ kind: "paragraph", conclusionId: "c", nodes: [{ kind: "text", text: "假设销量不变时实收为" }, { kind: "fact_ref", factId: after[0].id }] }], questions: [], userConditions: [], trialParameters: [] };
    const selected = selectAnalysisEvidence(draft, registry.view()); assert.ok(selected.facts.some((item) => item.id === baseline.facts[0].id)); assert.ok(selected.facts.some((item) => item.metricId === "scenario.static_loss")); assert.ok(selected.facts.some((item) => item.metricId === "assumption.net_volume_change"));
    const copied = structuredClone(selected); copied.facts.find((item) => item.id === baseline.facts[0].id)!.definition = "合成基线的独立对数口径";
    assert.match(analysisAnswerText({ ...draft, evidence: copied, review: { verdict: "pass" } } as never), /合成基线的独立对数口径/);
    const task = { runId: "run", question: "新增优惠会怎样", context: [], hardScope: { filters: {} }, assumptions: [], needs: [{ id: "need", userQuote: "新增优惠会怎样", judgement: "判断", status: "open" as const, conclusionIds: [] }] };
    assert.equal(validateAnalysisDraft(task, draft, selected).valid, true);
    draft.conclusions[0].level = "observed"; assert.equal(validateAnalysisDraft(task, draft, selected).valid, false);
    const wrong = structuredClone(registry.view()); wrong.facts.find((item) => item.id === input.baselineFactId)!.value = 999;
    await assert.rejects(scenarioModule.simulateAnalysis(input, wrong, session, delivery.hasReadFact), /基线|一致/);
  } finally { await session.close(); }
});

test("余额归零没有有限持平增量，缺失订单只保留缺失证据，不输出局部收入", async () => {
  const scenarioModule = await import("../agent/analytics-scenarios.ts");
  for (const missingOrder of [false, true]) {
    const session = await createSnapshotAnalysisProvider(scenarioDataset([row({ netSales: 1 }), row({ netSales: 1, orderId: missingOrder ? null : "另单" })])).open();
    try {
      const registry = createEvidenceRegistry(); const baseline = await createAnalysisOperations(session, { filters: {} }).execute({ needIds: ["need"], purpose: "核对基线", method: "aggregate", scope, metrics: ["amount"] }); registry.ingest(baseline);
      const result = await scenarioModule.simulateAnalysis({ needIds: ["need"], purpose: "边界检查", baselineFactId: baseline.facts[0].id, adjustment: { kind: missingOrder ? "per_order" : "per_item", amount: "9999" }, netVolumeChanges: ["0", "1"], reason: "合成边界情景" }, registry.view(), session, () => true);
      registry.ingest(result);
      if (missingOrder) { assert.equal(result.status, "unsupported"); assert.ok(!result.facts.some((fact) => fact.metricId === "scenario.revenue_after")); }
      else { assert.equal(result.facts.find((fact) => fact.metricId === "scenario.break_even_pct")!.value, null); assert.ok(result.facts.filter((fact) => fact.metricId === "scenario.revenue_after").every((fact) => fact.value === 0)); }
    } finally { await session.close(); }
  }
});

test("旧版本、分组基线与取消不能进入情景交付", async () => {
  const scenarioModule = await import("../agent/analytics-scenarios.ts");
  const session = await createSnapshotAnalysisProvider(scenarioDataset([row()])).open();
  try {
    const baseline = await createAnalysisOperations(session, { filters: {} }).execute({ needIds: ["need"], purpose: "基线", method: "aggregate", scope, metrics: ["amount"] });
    const input = { needIds: ["need"], purpose: "边界检查", baselineFactId: baseline.facts[0].id, adjustment: { kind: "per_item", amount: "2" }, netVolumeChanges: ["0"], reason: "合成情景" };
    const old = structuredClone(baseline); old.frames[0].snapshotId = "old";
    await assert.rejects(scenarioModule.simulateAnalysis(input, old, session, () => true), /快照/);
    const grouped = structuredClone(baseline); grouped.facts[0].objectIds = ["store"];
    await assert.rejects(scenarioModule.simulateAnalysis(input, grouped, session, () => true), /分组|总体/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(scenarioModule.simulateAnalysis(input, baseline, session, () => true, controller.signal), /取消|aborted|Abort/i);
  } finally { await session.close(); }
});

test("等价小数和负零不重复登记，也不能作为新情景进展", async () => {
  assert.deepEqual(normalizeNetChanges(["0000.1000", "0.10", "-0.000", "0.000", "-00.0100", "01.000"]), ["-0.01", "0", "0.1", "1"]);
  const { simulateAnalysis } = await import("../agent/analytics-scenarios.ts");
  const session = await createSnapshotAnalysisProvider(scenarioDataset([row()])).open();
  try {
    const baseline = await createAnalysisOperations(session, { filters: {} }).execute({ needIds: ["need"], purpose: "基线", method: "aggregate", scope, metrics: ["amount"] });
    const input = { needIds: ["need"], purpose: "净增情景", baselineFactId: baseline.facts[0].id, adjustment: { kind: "per_item", amount: "1" }, netVolumeChanges: ["0.1"], reason: "固定结构的假设" };
    const first = await simulateAnalysis(input, baseline, session, () => true);
    const repeated = await simulateAnalysis({ ...input, netVolumeChanges: ["00.1000"] }, baseline, session, () => true);
    assert.equal(repeated.operationId, first.operationId); assert.equal(repeated.progressKey, first.progressKey);
    const registry = createEvidenceRegistry(); registry.ingest(baseline); registry.ingest(first); registry.ingest(repeated);
    const delivery = createEvidenceDelivery(); delivery.record(analysisEvidencePage(first));
    assert.equal(delivery.record(analysisEvidencePage(repeated)).changed, false);
  } finally { await session.close(); }
});

test("补充假设解释可保留新版证据，但不增加数值分析进展", async () => {
  const { simulateAnalysis } = await import("../agent/analytics-scenarios.ts");
  const session = await createSnapshotAnalysisProvider(scenarioDataset([row()])).open();
  try {
    const baseline = await createAnalysisOperations(session, { filters: {} }).execute({ needIds: ["need"], purpose: "基线", method: "aggregate", scope, metrics: ["amount"] });
    const input = { needIds: ["need"], purpose: "净增情景", baselineFactId: baseline.facts[0].id, adjustment: { kind: "per_item", amount: "1" }, netVolumeChanges: ["0"], reason: "显式假设" };
    const first = await simulateAnalysis(input, baseline, session, () => true);
    const clarified = await simulateAnalysis({ ...input, reason: "显式假设，固定商品价格与结构，并排除跨期成交挪动" }, baseline, session, () => true);
    assert.notEqual(clarified.operationId, first.operationId); assert.equal(clarified.progressKey, first.progressKey);
    const registry = createEvidenceRegistry(); registry.ingest(baseline); registry.ingest(first); registry.ingest(clarified);
    const delivery = createEvidenceDelivery(); delivery.record(analysisEvidencePage(first));
    assert.equal(delivery.record(analysisEvidencePage(clarified)).changed, false);
  } finally { await session.close(); }
});

test("情景规则和微小增量展示保留实际精度，最终收入仍展示到分", async () => {
  const { simulateAnalysis } = await import("../agent/analytics-scenarios.ts");
  const session = await createSnapshotAnalysisProvider(scenarioDataset([row({ quantity: 100, netSales: 1000 })])).open();
  try {
    const baseline = await createAnalysisOperations(session, { filters: {} }).execute({ needIds: ["need"], purpose: "基线", method: "aggregate", scope, metrics: ["amount"] });
    const result = await simulateAnalysis({ needIds: ["need"], purpose: "精确规则", baselineFactId: baseline.facts[0].id, adjustment: { kind: "per_item", amount: "0.005" }, netVolumeChanges: ["0.000000000001"], reason: "固定结构的显式假设" }, baseline, session, () => true);
    const answer = { evidence: { ...result, facts: [...baseline.facts, ...result.facts] } } as never;
    const display = (metricId: string) => formatAnalysisNode({ kind: "fact_ref", factId: result.facts.find((fact) => fact.metricId === metricId)!.id }, answer);
    assert.equal(display("assumption.scenario_amount"), "0.005元/件（假设）");
    assert.equal(display("assumption.net_volume_change"), "0.0000000001%（假设）");
    assert.equal(display("scenario.static_loss"), "0.50元（情景测算）");
    assert.equal(display("scenario.revenue_after"), "999.50元（情景测算）");
  } finally { await session.close(); }
});
