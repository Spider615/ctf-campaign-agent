import assert from "node:assert/strict";
import test from "node:test";
import { createSnapshotAnalysisProvider } from "../app/lib/analytics/analysis-v2-snapshot.ts";
import { createAnalysisOperations } from "../app/lib/analytics/analysis-v2-operations.ts";
import { createEvidenceRegistry, validateAnalysisDraft } from "../app/lib/analytics/analysis-v2-evidence.ts";
import { analysisEvidencePage, createEvidenceDelivery } from "../agent/analytics-evidence-context.ts";
import type { AnalyticsDataset } from "../app/lib/analytics/types.ts";
import type { AnalysisDraft } from "../app/lib/analytics/analysis-v2-types.ts";
import { formatAnalysisNode } from "../app/lib/analytics/analysis-v2-format.ts";

async function fixture() {
  const dataset: AnalyticsDataset = { schema: "analytics-dataset/v1", id: "calculation-fixture", version: "calculation-v1", name: "合成经营数据", provenance: "sample", currency: "CNY", createdAt: "2026-04-01", minDate: "2026-04-01", maxDate: "2026-04-01", rules: [], sourceFiles: [], mappings: { sales: {}, campaigns: {} }, warnings: [], rows: [{ lineId: "row", date: "2026-04-01", store: "模拟门店", category: "模拟货类", netSales: 1000, quantity: 100, orderId: "order", region: null, city: null, sku: null, memberId: null, memberSegment: null, campaignId: null, cost: 600, weightGrams: null }] };
  const session = await createSnapshotAnalysisProvider(dataset).open();
  const evidence = await createAnalysisOperations(session, { filters: {} }).execute({ needIds: ["need"], purpose: "确认当前经营基线", method: "aggregate", scope: { period: { start: "2026-04-01", end: "2026-04-01" }, population: "sales", filters: {} }, metrics: ["amount", "quantity"] });
  const amount = evidence.facts.find((item) => item.metricId === "amount")!.id;
  const quantity = evidence.facts.find((item) => item.metricId === "quantity")!.id;
  const delivery = createEvidenceDelivery(); delivery.record(analysisEvidencePage(evidence));
  const input = { needIds: ["need"], purpose: "按明确假设计算保本新增销量", frameId: evidence.frames[0].id,
    assumptions: [{ key: "cut", label: "假设每件额外优惠", value: 1.5, unit: "CNY/件", reason: "仅用于比较方案的情景参数，尚非已执行事实" }],
    calculations: [
      { key: "price", label: "当前每件销售金额", unit: "CNY/件", op: "divide", args: [{ kind: "fact", id: amount }, { kind: "fact", id: quantity }] },
      { key: "next_price", label: "假设调整后每件销售金额", unit: "CNY/件", op: "subtract", args: [{ kind: "result", key: "price" }, { kind: "assumption", key: "cut" }] },
      { key: "ratio", label: "保本所需销量倍数", unit: "", op: "divide", args: [{ kind: "result", key: "price" }, { kind: "result", key: "next_price" }] },
      { key: "growth", label: "保本所需新增销量比例", unit: "", op: "subtract", args: [{ kind: "result", key: "ratio" }, { kind: "constant", value: 1 }] },
      { key: "growth_pct", label: "保本所需新增销量百分比", unit: "%", op: "multiply", args: [{ kind: "result", key: "growth" }, { kind: "constant", value: 100 }] },
    ] };
  return { session, evidence, delivery, input, amount, quantity };
}
async function calculator() {
  const calculationModule = await import("../agent/analytics-calculations.ts").catch(() => null);
  assert.ok(calculationModule, "通用的证据计算工具尚未实现"); return calculationModule;
}

test("通用计算按真实基线和显式假设生成保本量，保留完整依赖与假设身份", async () => {
  const f = await fixture();
  try {
    const { calculateAnalysis } = await calculator();
    const outcome = calculateAnalysis(f.input, f.evidence, f.delivery.hasReadFact);
    assert.equal(outcome.facts.find((item) => item.metricId === "calculation.price")!.value, 10);
    assert.equal(outcome.facts.find((item) => item.metricId === "calculation.next_price")!.value, 8.5);
    assert.ok(Math.abs(outcome.facts.find((item) => item.metricId === "calculation.growth_pct")!.value! - 17.64705882352942) < 1e-10);
    assert.ok(outcome.facts.some((item) => item.assumption?.reason.includes("情景参数")));
    const registry = createEvidenceRegistry(); registry.ingest(f.evidence); registry.ingest(outcome);
    const page = analysisEvidencePage(registry.view(), { ids: [outcome.facts.at(-1)!.id], includeParents: true });
    assert.ok(page.facts.some((item) => item.id === f.amount));
    assert.ok(page.facts.some((item) => item.assumption));
    const display = { evidence: registry.view(), userConditions: [], trialParameters: [] } as never;
    assert.match(formatAnalysisNode({ kind: "fact_ref", factId: outcome.facts.at(-1)!.id }, display), /情景测算/);
    assert.match(formatAnalysisNode({ kind: "fact_ref", factId: outcome.facts[0].id }, display), /假设/);
    assert.equal(calculateAnalysis({ ...f.input, purpose: "复用同一计算", needIds: ["another"] }, f.evidence, f.delivery.hasReadFact).operationId, outcome.operationId);
  } finally { await f.session.close(); }
});

test("未实际读取、历史参考、不同范围和单位混算不能借计算工具绕过", async () => {
  const f = await fixture();
  try {
    const { calculateAnalysis } = await calculator();
    assert.throws(() => calculateAnalysis(f.input, f.evidence, () => false), /读取/);
    const badUnit = structuredClone(f.input); badUnit.calculations[0].op = "add";
    assert.throws(() => calculateAnalysis(badUnit, f.evidence, f.delivery.hasReadFact), /单位/);
    const historic = structuredClone(f.evidence); historic.frames[0].mode = "historical";
    assert.throws(() => calculateAnalysis(f.input, historic, f.delivery.hasReadFact), /历史|口径/);
    const foreign = structuredClone(f.evidence); foreign.facts[1].frameId = "另一个范围";
    assert.throws(() => calculateAnalysis(f.input, foreign, f.delivery.hasReadFact), /范围/);
    const constant = structuredClone(f.input); constant.calculations[0].args[0] = { kind: "constant", value: 99 } as never;
    assert.throws(() => calculateAnalysis(constant, f.evidence, f.delivery.hasReadFact), /常量|参数|Invalid/);
  } finally { await f.session.close(); }
});

test("计算继续遵守销售比率和同货类同材料的边界，不能只拿假设循环生成经营依据", async () => {
  const f = await fixture();
  try {
    const { calculateAnalysis } = await calculator();
    const net = structuredClone(f.evidence); net.frames[0].scope.population = "net";
    assert.throws(() => calculateAnalysis(f.input, net, f.delivery.hasReadFact), /销售正金额/);
    const spokenUnit = structuredClone(f.input);
    spokenUnit.assumptions[0].unit = "元每件";
    spokenUnit.calculations[0].unit = "元每件"; spokenUnit.calculations[1].unit = "元每件";
    assert.throws(() => calculateAnalysis(spokenUnit, net, f.delivery.hasReadFact), /销售正金额/);
    const grams = structuredClone(f.evidence); grams.facts.find((item) => item.id === f.quantity)!.unit = "克";
    const price = { ...f.input, assumptions: [{ key: "price", label: "假设每克金额", value: 10, unit: "CNY/克", reason: "仅为计算情景" }], calculations: [{ key: "revenue", label: "假设金额", unit: "CNY", op: "multiply", args: [{ kind: "fact", id: f.quantity }, { kind: "assumption", key: "price" }] }] };
    assert.throws(() => calculateAnalysis(price, grams, f.delivery.hasReadFact), /同货类同材料/);
    grams.frames[0].scope.filters = { categories: ["合成货类"], materials: ["合成材料"] };
    assert.equal(calculateAnalysis(price, grams, f.delivery.hasReadFact).facts.at(-1)!.value, 1000);
    const missingControl = structuredClone(grams); missingControl.frames[0].scope.filters = {};
    missingControl.objects = [{ id: "category", frameId: grams.frames[0].id, dimension: "category", value: "合成货类", label: "合成货类" }, { id: "missing-material", frameId: grams.frames[0].id, dimension: "material", value: "", label: "未提供" }];
    missingControl.facts.forEach((fact) => { fact.objectIds = ["category", "missing-material"]; });
    assert.throws(() => calculateAnalysis(price, missingControl, f.delivery.hasReadFact), /同货类同材料/);
    const scenario = calculateAnalysis(f.input, f.evidence, f.delivery.hasReadFact);
    const registry = createEvidenceRegistry(); registry.ingest(f.evidence); registry.ingest(scenario);
    const parameter = scenario.facts.find((item) => item.assumption)!;
    assert.throws(() => calculateAnalysis({ ...f.input, assumptions: [], calculations: [{ key: "repeat", label: "仅重复假设", unit: parameter.unit, op: "multiply", args: [{ kind: "fact", id: parameter.id }, { kind: "constant", value: 1 }] }] }, registry.view(), () => true), /经营依据/);
  } finally { await f.session.close(); }
});

test("已绑定分组的情景参数不能借再次引用转移到另一个对象", async () => {
  const f = await fixture();
  try {
    const { calculateAnalysis } = await calculator();
    const grouped = structuredClone(f.evidence); const frameId = grouped.frames[0].id;
    grouped.objects = ["A", "B"].map((value) => ({ id: `object-${value}`, frameId, dimension: "store", value, label: `模拟${value}店` }));
    grouped.facts.forEach((fact) => { fact.objectIds = ["object-A"]; });
    const outcome = calculateAnalysis(f.input, grouped, f.delivery.hasReadFact);
    const parameter = outcome.facts.find((fact) => fact.assumption)!;
    const amountB = { ...grouped.facts.find((fact) => fact.id === f.amount)!, id: "amount-b", objectIds: ["object-B"] };
    const evidence = { ...grouped, facts: [...grouped.facts, ...outcome.facts, amountB], methods: [...grouped.methods, ...outcome.methods] };
    const input = { ...f.input, assumptions: [], calculations: [{ key: "moved", label: "错误迁移分组参数", unit: "CNY/件", op: "subtract", args: [{ kind: "fact", id: parameter.id }, { kind: "fact", id: parameter.id }] }, { key: "amount", label: "保留经营基线", unit: "CNY", op: "multiply", args: [{ kind: "fact", id: amountB.id }, { kind: "constant", value: 1 }] }] };
    assert.throws(() => calculateAnalysis(input, evidence, () => true), /分组对象|同.*对象/);
  } finally { await f.session.close(); }
});

test("缺失值和零分母保持缺失，不能产生零业绩或无限结果", async () => {
  const f = await fixture();
  try {
    const { calculateAnalysis } = await calculator();
    const missing = structuredClone(f.evidence); missing.facts.find((item) => item.id === f.quantity)!.value = null;
    const result = calculateAnalysis(f.input, missing, f.delivery.hasReadFact);
    assert.ok(result.facts.filter((item) => item.derivation).every((item) => item.value === null));
    const zero = { ...f.input, assumptions: [], calculations: [{ key: "zero_denominator", label: "零分母检查", unit: "CNY", op: "divide", args: [{ kind: "fact", id: f.amount }, { kind: "constant", value: 0 }] }] };
    assert.equal(calculateAnalysis(zero, f.evidence, f.delivery.hasReadFact).facts[0].value, null);
  } finally { await f.session.close(); }
});

test("含情景假设的派生值不能标成真实观察，假设不得伪装成用户事实", async () => {
  const f = await fixture();
  try {
    const { calculateAnalysis } = await calculator(); const outcome = calculateAnalysis(f.input, f.evidence, f.delivery.hasReadFact);
    const registry = createEvidenceRegistry(); registry.ingest(f.evidence); registry.ingest(outcome);
    const fact = outcome.facts.at(-1)!;
    const task = { runId: "run", question: "提高优惠对销售有什么影响", context: [], hardScope: { filters: {} }, assumptions: [], needs: [{ id: "need", userQuote: "提高优惠对销售有什么影响", judgement: "判断影响与保本条件", status: "open" as const, conclusionIds: [] }] };
    const draft: AnalysisDraft = { status: "answered", conclusions: [{ id: "judgement", needIds: ["need"], level: "observed", judgement: "加深优惠需要新增成交补回让利", factIds: [fact.id], objectIds: [], methodIds: [outcome.methods[0].id], limitations: outcome.limitations }], blocks: [{ kind: "paragraph", conclusionId: "judgement", nodes: [{ kind: "text", text: "假设其他条件不变，保本新增销量为" }, { kind: "fact_ref", factId: fact.id }] }], questions: [], userConditions: [], trialParameters: [] };
    const invalid = validateAnalysisDraft(task, draft, registry.view());
    assert.equal(invalid.valid, false); assert.ok(invalid.issues.some((issue) => /假设|情景/.test(issue.requirement)));
    draft.conclusions[0].level = "hypothesis";
    assert.equal(validateAnalysisDraft(task, draft, registry.view()).valid, true);
  } finally { await f.session.close(); }
});

test("重开或改变范围后清除实际读取身份", async () => {
  const f = await fixture();
  try {
    assert.equal(f.delivery.hasReadFact(f.amount), true);
    f.delivery.resetPages(); assert.equal(f.delivery.hasReadFact(f.amount), false);
  } finally { await f.session.close(); }
});

test("重复计算改名称、编号或假设说明不产生新的分析进展", async () => {
  const f = await fixture();
  try {
    const { calculateAnalysis } = await calculator();
    const first = calculateAnalysis(f.input, f.evidence, f.delivery.hasReadFact);
    const renamed = structuredClone(f.input); const keys = new Map(renamed.calculations.map((step) => [step.key, `renamed_${step.key}`]));
    renamed.assumptions[0].key = "renamed_cut"; renamed.assumptions[0].label = "另一种参数写法"; renamed.assumptions[0].reason = "同样的假设，换一种说明";
    for (const step of renamed.calculations) {
      step.key = keys.get(step.key)!; step.label = "另一种结果写法";
      for (const arg of step.args) if ("key" in arg && typeof arg.key === "string") {
        if (arg.kind === "result") arg.key = keys.get(arg.key)!;
        if (arg.kind === "assumption") arg.key = "renamed_cut";
      }
    }
    const repeated = calculateAnalysis(renamed, f.evidence, f.delivery.hasReadFact);
    assert.ok(first.progressKey); assert.equal(repeated.progressKey, first.progressKey);
    assert.notEqual(repeated.operationId, first.operationId, "不同展示名称仍各自保留不可改写的证据身份");
    const tracker = createEvidenceDelivery();
    assert.equal(tracker.record(analysisEvidencePage(first)).changed, true);
    assert.equal(tracker.record(analysisEvidencePage(repeated)).changed, false);
    renamed.assumptions[0].value = 2;
    assert.notEqual(calculateAnalysis(renamed, f.evidence, f.delivery.hasReadFact).progressKey, first.progressKey);
  } finally { await f.session.close(); }
});
