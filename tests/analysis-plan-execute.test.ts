import assert from "node:assert/strict";
import test from "node:test";
import { executePlan, rowsFromResult } from "../app/lib/analytics/plan/execute.ts";
import { analysisMetricDefinitions } from "../app/lib/analytics/analysis-v2-operations.ts";
import { createEvidenceRegistry } from "../app/lib/analytics/analysis-v2-evidence.ts";
import { aggregateScenarioRows } from "../app/lib/analytics/analysis-v2-scenarios.ts";
import { semanticDimensionCatalog } from "../app/lib/analytics/semantic/model.ts";
import type { AnalysisAggregateCell, AnalysisDimension, AnalysisDataSession, AnalysisFact, AnalysisOperationResult, AnalysisScope } from "../app/lib/analytics/analysis-v2-types.ts";

// 合成明细：三家门店、每店每天一行；七夕节为 8/23–29，其余日期为非节庆。
type Row = { day: string; festival: string; region: string; district: string; store: string; category: string; material: string; amount: number; quantity: number; grams: number; order: string | null };
const DIMENSIONS = ["day", "festival", "region", "district", "store", "category", "material"] as const satisfies readonly AnalysisDimension[];
const STORES = [{ store: "S1", region: "北区", district: "北区/A区" }, { store: "S2", region: "北区", district: "北区/B区" }, { store: "S3", region: "南区", district: "南区/C区" }];
const day = (n: number) => `2025-08-${String(n).padStart(2, "0")}`;
const scope = (filters: Record<string, string[]> = {}) => ({ period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales" as const, filters });

function fixture(options: { dominantStore?: boolean; missingOrders?: boolean; slowEnd?: boolean } = {}): AnalysisDataSession {
  // 默认：七夕每天合计 100、非节庆每天合计 50，日均差额 50。
  // dominantStore：七夕期间 S1 独大，其余门店低于平日；剔除 S1 后目标减参照变号。
  const daily = options.dominantStore ? { 七夕节: [300, 10, 10], 非节庆: [5, 20, 20] } : { 七夕节: [40, 30, 30], 非节庆: [20, 15, 15] };
  const rows: Row[] = [];
  for (let n = 1; n <= 31; n++) {
    const festival = n >= 23 && n <= 29 ? "七夕节" : "非节庆";
    STORES.forEach((item, index) => rows.push({ ...item, day: day(n), festival, category: "一般足金类", material: "足金", amount: daily[festival][index], quantity: 1, grams: 2, order: `${item.store}-${n}` }));
  }
  if (options.missingOrders) rows[0].order = null;
  // slowEnd：七夕最后两天（8/28–29）每店只卖 5，整段仍高于平日，但这两天低于平日。
  if (options.slowEnd) for (const row of rows) if (row.day >= day(28) && row.day <= day(29)) row.amount = 5;
  const select = (f: AnalysisScope, excludeStores: string[] = [], excludeOrders: string[] = []) => rows.filter((row) => {
    const filters = f.filters;
    if (row.day < f.period.start || row.day > f.period.end) return false;
    if (f.population === "sales" && !(row.amount > 0 && row.quantity > 0)) return false;
    if (f.population === "returns" && !(row.amount < 0)) return false;
    if (f.population === "zero_sales" && row.amount !== 0) return false;
    if (f.population === "recovery") return false;
    if (filters.festivals && !filters.festivals.includes(row.festival)) return false;
    if (filters.regions && !filters.regions.includes(row.region)) return false;
    if (filters.districts && !filters.districts.includes(row.district)) return false;
    if (filters.stores && !filters.stores.includes(row.store)) return false;
    if (excludeStores.includes(row.store)) return false;
    if (row.order && excludeOrders.includes(row.order)) return false;
    return true;
  });
  const metrics = ["amount", "quantity", "grams", "rows", "stores", "orders", "amount_per_day", "amount_per_order"] as const;
  return {
    snapshotId: "plan-fixture", datasetVersion: "plan-fixture-v1", close: async () => {},
    capabilities: { mode: "snapshot", name: "计划执行夹具", coverage: { start: "2025-08-01", end: "2025-08-31" }, currency: "CNY", provenance: "sample", dimensions: [...DIMENSIONS], dimensionCatalog: semanticDimensionCatalog(DIMENSIONS), metrics: analysisMetricDefinitions("CNY", [...metrics], "snapshot"), methods: ["aggregate", "compare", "decompose", "scan", "robustness"], scenarios: ["per_item"], limitations: [] },
    async aggregate(query) {
      const groups = new Map<string, Row[]>();
      for (const row of select(query.scope, query.excludeStores, query.excludeOrders)) {
        const key = JSON.stringify(query.by.map((dimension) => dimension === "order" ? row.order ?? "" : row[dimension as keyof Row]));
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      return [...groups].map(([key, items]): AnalysisAggregateCell => {
        const values = JSON.parse(key) as string[]; const total = (field: "amount" | "quantity" | "grams") => items.reduce((sum, row) => sum + row[field], 0);
        return { dimensions: Object.fromEntries(query.by.map((dimension, index) => [dimension, values[index]])), rows: items.length, amount: total("amount"), quantity: total("quantity"), grams: total("grams"), profit: null, tag_amount: null,
          stores: new Set(items.map((row) => row.store)).size, orders: new Set(items.map((row) => row.order).filter(Boolean)).size, orderMissingRows: items.filter((row) => !row.order).length };
      });
    },
    async scenario(query) {
      return aggregateScenarioRows(select(query.scope).map((row) => ({ amount: row.amount, quantity: row.quantity, grams: row.grams, ...(row.order ? { orderKey: row.order } : {}) })), query.adjustment);
    },
  };
}

test("contrast 产出目标、参照、差额、变化四类行，键为空表示总体", async () => {
  const exec = await executePlan([{ id: "c", op: "contrast", target: scope({ festivals: ["七夕节"] }), reference: scope({ festivals: ["非节庆"] }), metrics: ["amount_per_day"] }], fixture(), { filters: {} }, createEvidenceRegistry());
  const rows = exec.results.get("c")!.rows.filter((row) => row.metric === "amount_per_day");
  assert.deepEqual(rows.map((row) => row.role).sort(), ["change", "delta", "reference", "target"]);
  assert.ok(rows.every((row) => Object.keys(row.key).length === 0));
  const delta = exec.evidence.facts.find((fact) => fact.id === rows.find((row) => row.role === "delta")!.factId)!;
  assert.equal(delta.value, 50);
});

test("drill 沿层级逐层扫描，每层行带样本量，键包含该层及上层维度", async () => {
  const exec = await executePlan([
    { id: "c", op: "contrast", target: scope({ festivals: ["七夕节"] }), reference: scope({ festivals: ["非节庆"] }), metrics: ["amount_per_day"] },
    { id: "d", op: "drill", of: "c", path: ["region", "district"] },
  ], fixture(), { filters: {} }, createEvidenceRegistry());
  const result = exec.results.get("d")!;
  assert.equal(result.status, "completed"); assert.equal(result.operationIds.length, 2);
  const rows = result.rows.filter((row) => row.role === "deviation");
  assert.ok(rows.some((row) => Object.keys(row.key).join() === "region"));
  assert.ok(rows.some((row) => Object.keys(row.key).sort().join() === "district,region"));
  assert.ok(rows.every((row) => typeof row.sampleRows === "number"));
  // 同一节点内键、指标、角色唯一，后续绑定才不含糊
  assert.equal(new Set(result.rows.map((row) => JSON.stringify([Object.entries(row.key).sort(), row.metric, row.role]))).size, result.rows.length);
});

test("补充执行沿用已有节点结果：不重查所指 contrast，也不重复登记证据", async () => {
  const counted = () => { const session = fixture(); let calls = 0; return { session: { ...session, aggregate: (query: Parameters<AnalysisDataSession["aggregate"]>[0], signal?: AbortSignal) => { calls++; return session.aggregate(query, signal); } } as AnalysisDataSession, calls: () => calls }; };
  const contrast = { id: "c", op: "contrast" as const, target: scope({ festivals: ["七夕节"] }), reference: scope({ festivals: ["非节庆"] }), metrics: ["amount_per_day"] };
  const drill = { id: "d", op: "drill" as const, of: "c", path: ["region", "district"] };
  // 基准：一次性执行两个节点的查询数
  const whole = counted(); await executePlan([contrast, drill], whole.session, { filters: {} }, createEvidenceRegistry());
  const { session, calls } = counted(); const registry = createEvidenceRegistry();
  const first = await executePlan([contrast], session, { filters: {} }, registry);
  const afterFirst = calls(); const firstFacts = registry.view().facts.length;
  const followup = await executePlan([contrast, drill], session, { filters: {} }, registry, undefined, first.results);
  assert.equal(calls() - afterFirst, whole.calls() - afterFirst);
  assert.deepEqual([...followup.results.keys()], ["d"]);
  const drilled = followup.results.get("d")!; assert.equal(drilled.status, "completed");
  const drillOps = new Set(drilled.operationIds);
  const added = registry.view().facts.slice(firstFacts);
  assert.ok(added.length > 0 && added.every((fact) => drillOps.has(fact.operationId)));
  assert.equal(new Set(registry.view().facts.map((fact) => fact.id)).size, registry.view().facts.length);
});

test("robust 剔除最大门店后方向不变记为保持，变号记为翻转", async () => {
  const exec = await executePlan([
    { id: "c", op: "contrast", target: scope({ festivals: ["七夕节"] }), reference: scope({ festivals: ["非节庆"] }), metrics: ["amount"] },
    { id: "r", op: "robust", of: "c", checks: ["largest_store", "halves"] },
  ], fixture({ dominantStore: true }), { filters: {} }, createEvidenceRegistry());
  const robust = exec.results.get("r")!.robust!;
  assert.equal(robust.find((item) => item.check === "largest_store")!.kept, false);
  assert.ok(robust.some((item) => item.check === "halves"));
});

test("robust 默认数据剔除最大门店后方向保持", async () => {
  const exec = await executePlan([
    { id: "c", op: "contrast", target: scope({ festivals: ["七夕节"] }), reference: scope({ festivals: ["非节庆"] }), metrics: ["amount_per_day"] },
    { id: "r", op: "robust", of: "c", checks: ["largest_store"] },
  ], fixture(), { filters: {} }, createEvidenceRegistry());
  assert.equal(exec.results.get("r")!.robust![0].kept, true);
});

test("节点执行失败只影响该节点及其依赖，其余节点照常产出", async () => {
  const exec = await executePlan([
    { id: "ok", op: "measure", scope: scope(), metrics: ["amount"] },
    { id: "boom", op: "robust", of: "ok", checks: ["largest_order"] },
  ], fixture({ missingOrders: true }), { filters: {} }, createEvidenceRegistry());
  assert.equal(exec.results.get("ok")!.status, "completed");
  assert.equal(exec.results.get("boom")!.status, "unsupported");
});

test("参数不被分析操作接受时记为不支持，依赖它的节点记为失败", async () => {
  const exec = await executePlan([
    { id: "bad", op: "contrast", target: scope(), reference: { ...scope(), population: "net" }, metrics: ["amount"] },
    { id: "after", op: "decompose", of: "bad" },
    { id: "ok", op: "measure", scope: scope(), metrics: ["amount"], by: ["region"] },
  ], fixture(), { filters: {} }, createEvidenceRegistry());
  assert.equal(exec.results.get("bad")!.status, "unsupported"); assert.ok(exec.results.get("bad")!.message);
  assert.equal(exec.results.get("after")!.status, "failed"); assert.equal(exec.results.get("after")!.message, "依赖的节点未完成");
  const ok = exec.results.get("ok")!;
  assert.deepEqual(ok.rows.filter((row) => row.metric === "amount").map((row) => row.key.region).sort(), ["北区", "南区"]);
  assert.ok(ok.rows.every((row) => row.role === "value"));
});

test("decompose 只产出贡献行，各贡献分量互不冲突", async () => {
  const exec = await executePlan([
    { id: "c", op: "contrast", target: scope({ festivals: ["七夕节"] }), reference: scope({ festivals: ["非节庆"] }), metrics: ["amount"] },
    { id: "x", op: "decompose", of: "c" },
  ], fixture(), { filters: {} }, createEvidenceRegistry());
  const rows = exec.results.get("x")!.rows;
  assert.ok(rows.length >= 3); assert.ok(rows.every((row) => row.role === "contribution"));
  assert.ok(rows.some((row) => row.metric === "amount.quantity_contribution"));
});

test("scan 未给维度时取能力目录中可扫描的维度逐个扫描", async () => {
  const exec = await executePlan([
    { id: "m", op: "measure", scope: scope(), metrics: ["amount"] },
    { id: "s", op: "scan", of: "m" },
  ], fixture(), { filters: {} }, createEvidenceRegistry());
  const result = exec.results.get("s")!;
  // festival、region、district、category、material 可扫描；day、store 不扫描
  assert.equal(result.operationIds.length, 5);
  assert.ok(result.rows.some((row) => row.role === "share" && row.key.festival === "七夕节"));
  assert.ok(!result.rows.some((row) => "store" in row.key || "day" in row.key));
});

test("scenario 以所指 measure 的总体实收为基线做确定性情景", async () => {
  const exec = await executePlan([
    { id: "m", op: "measure", scope: scope(), metrics: ["amount"] },
    { id: "s", op: "scenario", of: "m", adjustment: { kind: "per_item", amount: "10" }, netVolumeChanges: ["0.1"], reason: "每件再减 10 元" },
  ], fixture(), { filters: {} }, createEvidenceRegistry());
  assert.equal(exec.results.get("s")!.status, "completed");
  assert.equal(exec.evidence.facts.find((fact) => fact.metricId === "scenario.static_loss")!.value, 930);
  // 情景行：假设参数不进行；逐项结果以净成交量变化为键
  const rows = exec.results.get("s")!.rows;
  assert.ok(rows.every((row) => row.role === "value" && !row.metric.startsWith("assumption.")));
  assert.deepEqual(rows.find((row) => row.metric === "scenario.static_loss")!.key, {});
  assert.deepEqual(rows.find((row) => row.metric === "scenario.break_even_pct")!.key, {});
  for (const metric of ["scenario.revenue_after", "scenario.revenue_change"]) assert.deepEqual(rows.find((row) => row.metric === metric)!.key, { netVolumeChange: "0.1" });
});

test("取消立即停止，不产生部分结果", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executePlan([{ id: "m", op: "measure", scope: scope(), metrics: ["amount"] }], fixture(), { filters: {} }, createEvidenceRegistry(), controller.signal), /取消|停止|abort/i);
});

test("robust halves 作用于分组 measure 时按总体比较前后两半", async () => {
  const exec = await executePlan([
    { id: "m", op: "measure", scope: scope(), metrics: ["amount"], by: ["region"] },
    { id: "r", op: "robust", of: "m", checks: ["halves"] },
  ], fixture(), { filters: {} }, createEvidenceRegistry());
  const result = exec.results.get("r")!;
  assert.equal(result.robust![0].kept, true);
  assert.deepEqual(result.rows.map((row) => row.key.half).sort(), ["前半", "后半"]);
});

test("robust alternative_window 以替代期顶替目标期，对原参照差额同号记为保持", async () => {
  const exec = await executePlan([
    { id: "c", op: "contrast", target: scope({ festivals: ["七夕节"] }), reference: scope({ festivals: ["非节庆"] }), metrics: ["amount_per_day"] },
    { id: "r", op: "robust", of: "c", checks: ["alternative_window"], alternative: { start: "2025-08-23", end: "2025-08-25" } },
  ], fixture(), { filters: {} }, createEvidenceRegistry());
  const result = exec.results.get("r")!;
  assert.equal(result.robust![0].kept, true);
  const check = exec.evidence.facts.find((fact) => fact.id === result.rows.find((row) => row.role === "check")!.factId)!;
  assert.equal(check.metricId, "amount_per_day.delta"); assert.equal(check.value, 50);
});

test("robust alternative_window 替代期差额变号记为翻转", async () => {
  const exec = await executePlan([
    { id: "c", op: "contrast", target: scope({ festivals: ["七夕节"] }), reference: scope({ festivals: ["非节庆"] }), metrics: ["amount_per_day"] },
    { id: "r", op: "robust", of: "c", checks: ["alternative_window"], alternative: { start: "2025-08-28", end: "2025-08-29" } },
  ], fixture({ slowEnd: true }), { filters: {} }, createEvidenceRegistry());
  assert.equal(exec.results.get("r")!.robust![0].kept, false);
});

test("robust alternative_window 作用于 measure 时只给两个水平值，不判方向", async () => {
  const exec = await executePlan([
    { id: "m", op: "measure", scope: scope(), metrics: ["amount"] },
    { id: "r", op: "robust", of: "m", checks: ["alternative_window"], alternative: { start: "2025-08-01", end: "2025-08-10" } },
  ], fixture(), { filters: {} }, createEvidenceRegistry());
  const item = exec.results.get("r")!.robust![0];
  assert.equal(item.kept, null); assert.match(item.detail, /原值 1900.*核对后 500/);
});

test("robust 所指节点不是 measure 或 contrast 时记为不支持，不抛错", async () => {
  const exec = await executePlan([
    { id: "c", op: "contrast", target: scope({ festivals: ["七夕节"] }), reference: scope({ festivals: ["非节庆"] }), metrics: ["amount"] },
    { id: "x", op: "decompose", of: "c" },
    { id: "r", op: "robust", of: "x", checks: ["largest_store"] },
  ], fixture(), { filters: {} }, createEvidenceRegistry());
  assert.equal(exec.results.get("r")!.status, "unsupported"); assert.match(exec.results.get("r")!.message!, /measure 或 contrast/);
});

test("参照框架由差额派生式确定，与框架出现顺序无关", () => {
  // 参照框架排在前面：按位置奇偶会把两者标反
  const fact = (id: string, frameId: string, metricId: string, extra: Partial<AnalysisFact> = {}): AnalysisFact => ({ id, frameId, metricId, label: id, value: 1, unit: "元", definition: "", objectIds: [], operationId: "op", limitations: [], ...extra });
  const result = { operationId: "op", method: "compare", status: "completed", needIds: ["plan"], purpose: "p", frames: [{ id: "R" }, { id: "T" }], objects: [], methods: [], limitations: [],
    facts: [fact("r", "R", "amount"), fact("t", "T", "amount"), fact("d", "T", "amount.delta", { derivation: { op: "subtract", args: [{ factId: "t" }, { factId: "r" }] } })] } as unknown as AnalysisOperationResult;
  const roles = Object.fromEntries(rowsFromResult(result, new Map(), { metrics: ["amount"], reference: true }).map((row) => [row.factId, row.role]));
  assert.deepEqual(roles, { r: "reference", t: "target", d: "delta" });
});

test("证据登记被拒只让该节点不支持，其余节点照常完成", async () => {
  const registry = createEvidenceRegistry(); const original = registry.ingestAsync.bind(registry); let calls = 0;
  registry.ingestAsync = async (result, signal) => { if (++calls === 2) throw new Error("派生事实单位不一致"); return original(result, signal); };
  const exec = await executePlan([
    { id: "a", op: "measure", scope: scope(), metrics: ["amount"] },
    { id: "b", op: "measure", scope: scope({ festivals: ["七夕节"] }), metrics: ["amount"] },
    { id: "c", op: "measure", scope: scope({ festivals: ["非节庆"] }), metrics: ["amount"] },
  ], fixture(), { filters: {} }, registry);
  assert.equal(exec.results.get("a")!.status, "completed");
  assert.equal(exec.results.get("b")!.status, "unsupported"); assert.match(exec.results.get("b")!.message ?? "", /证据未通过校验/);
  assert.equal(exec.results.get("c")!.status, "completed");
});

test("补充执行传入已有结果：所指节点直接沿用，不重查、不重复登记证据", async () => {
  const registry = createEvidenceRegistry(); const session = fixture();
  const contrast = { id: "c", op: "contrast" as const, target: scope({ festivals: ["七夕节"] }), reference: scope({ festivals: ["非节庆"] }), metrics: ["amount_per_day"] };
  const first = await executePlan([contrast], session, { filters: {} }, registry);
  const before = registry.view().facts.length; const compares = registry.view().methods.filter((method) => method.method === "compare").length;
  const second = await executePlan([{ id: "s", op: "scan", of: "c", dimensions: ["region"] }], session, { filters: {} }, registry, undefined, first.results);
  assert.equal(second.results.get("s")?.status, "completed");
  const after = registry.view();
  assert.equal(after.methods.filter((method) => method.method === "compare").length, compares, "没有重复执行对比");
  assert.ok(after.facts.length > before);
});
