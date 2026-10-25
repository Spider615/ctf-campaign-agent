import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisFact, AnalysisOperationResult } from "../app/lib/analytics/analysis-v2-types.ts";
import { analysisFactParents } from "../app/lib/analytics/analysis-v2-fact-links.ts";
import { qaPresentationFacts } from "../app/lib/analytics/qa/observations.ts";
import { createQaResult, pageQaResult } from "../app/lib/analytics/qa/results.ts";
import { drawQaChart } from "../app/lib/analytics/qa/chart.ts";
import { assembleQaAnswer } from "../app/lib/analytics/qa/answer.ts";
import { validatePlanAnswerV4 } from "../app/lib/analytics/plan/answer.ts";

function fixture(count = 3): AnalysisOperationResult {
  const result: AnalysisOperationResult = {
    operationId: "op", method: "aggregate", status: "completed", purpose: "核对完整门店实收与客单价", needIds: ["qa"], limitations: [],
    frames: [{ id: "frame", snapshotId: "snapshot", datasetVersion: "version", mode: "snapshot", provenance: "sample", scope: { period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales", filters: {} }, currency: "CNY", grain: "line", controls: [], limitations: [] }],
    objects: [], facts: [],
    methods: [{ id: "method", operationId: "op", method: "aggregate", status: "completed", frameIds: ["frame"], controls: [], checks: [{ name: "完整聚合", status: "performed", result: "包含全部业务分组" }], sampleRows: count * 2, groupCount: count, limitations: [] }],
  };
  for (let at = 0; at < count; at++) {
    const objectId = `store-${at}`;
    result.objects.push({ id: objectId, frameId: "frame", dimension: "store", value: String(at).padStart(4, "0"), label: `门店${at}` });
    const amount: AnalysisFact = { id: `amount-${at}`, frameId: "frame", operationId: "op", metricId: "amount", label: "汇总实收", value: at === 1 ? 0 : at === 2 ? null : (at + 1) * 100 + 0.01, unit: "CNY", definition: "真实实收按分聚合", objectIds: [objectId], limitations: at === 2 ? ["实收缺失，未补零"] : [] };
    const orders: AnalysisFact = { ...amount, id: `orders-${at}`, metricId: "orders", label: "汇总订单", value: 2, unit: "单", definition: "选定记录内按门店与单号去重", limitations: [] };
    const numerator: AnalysisFact = { ...amount, id: `numerator-${at}`, label: "客单价分子实收" };
    const denominator: AnalysisFact = { ...orders, id: `denominator-${at}`, label: "客单价分母订单" };
    const ratio: AnalysisFact = { ...amount, id: `ratio-${at}`, metricId: "amount_per_order", label: "客单价", value: amount.value === null ? null : amount.value / 2, unit: "CNY/单", definition: "实收除以去重订单数", derivation: { op: "divide", args: [{ factId: numerator.id }, { factId: denominator.id }] } };
    result.facts.push(amount, orders, numerator, denominator, ratio);
  }
  return result;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const draw = (result: AnalysisOperationResult, top?: number) => drawQaChart({ id: "chart", input: { resultId: "result", metric: "amount", kind: "bar", by: "store", ...(top === undefined ? {} : { top }) }, result, evidence: result });
const ids = (facts: AnalysisFact[]) => facts.map((fact) => fact.id);

function assertCompletePages(source: AnalysisOperationResult) {
  const stored = createQaResult("all", source), seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = pageQaResult(stored, { cursor, pageSize: 2 });
    assert.ok(page.groups.length > 0);
    assert.ok(JSON.stringify(page).length <= 16000);
    for (const fact of page.groups.flatMap((group) => group.facts)) {
      assert.equal(fact.value, source.facts.find((original) => original.id === fact.id)!.value);
      seen.push(fact.id);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.deepEqual([...seen].sort(), ids(source.facts).sort());
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual([...stored.readFactIds].sort(), ids(source.facts).sort());
}

test("同值原始父事实只选展示点，真实零与缺失仍不同，完整输入不可变", () => {
  const source = fixture(), before = structuredClone(source);
  freeze(source);
  const selected = qaPresentationFacts(source);
  assert.deepEqual(ids(selected), ["amount-0", "orders-0", "ratio-0", "amount-1", "orders-1", "ratio-1", "amount-2", "orders-2", "ratio-2"]);
  selected.forEach((fact) => assert.equal(fact, source.facts.find((original) => original.id === fact.id)));
  assertCompletePages(source);
  const chart = draw(source);
  assert.deepEqual(chart.series[0].values.map((point) => point.value), [100.01, 0, null]);
  assert.deepEqual(chart.series[0].values.map((point) => point.exact), ["100.01", "0", null]);
  assert.deepEqual(chart.factIds, ["amount-0", "amount-1", "amount-2"]);
  assert.deepEqual(source, before);
});

test("请求原值在父事实之后时仍选请求原值，不依赖事实登记顺序", () => {
  const source = fixture(1);
  source.facts.reverse();
  const selected = ids(qaPresentationFacts(freeze(source)));
  assert.ok(selected.includes("amount-0") && selected.includes("orders-0"));
  assert.ok(!selected.includes("numerator-0") && !selected.includes("denominator-0"));
  assert.deepEqual(draw(source).series[0].values[0].refIds, ["amount-0"]);
});

test("多个比率只重复父事实时保留稳定原值及每个派生结果的身份", () => {
  const source = fixture(1);
  const [amount, orders, numerator, denominator, ratio] = source.facts;
  source.facts = [numerator, denominator, ratio, { ...amount, id: "numerator-2" }, { ...orders, id: "denominator-2" }, { ...ratio, id: "ratio-2", derivation: { op: "divide", args: [{ factId: "numerator-2" }, { factId: "denominator-2" }] } }];
  assert.deepEqual(ids(qaPresentationFacts(source)), ["numerator-0", "denominator-0", "ratio-0", "ratio-2"]);
  assert.deepEqual(draw(source).series[0].values[0].refIds, ["numerator-0"]);
  assertCompletePages(source);
});

test("嵌套公式里的明确父引用可识别，父链本身保持原样", () => {
  const source = fixture(1), ratio = source.facts[4];
  ratio.derivation = { op: "multiply", args: [{ constant: 1 }, ratio.derivation!] };
  const before = structuredClone(source);
  assert.deepEqual(ids(qaPresentationFacts(freeze(source))), ["amount-0", "orders-0", "ratio-0"]);
  assert.deepEqual(analysisFactParents(ratio), ["numerator-0", "denominator-0"]);
  assert.deepEqual(source, before);
});

for (const method of ["compare", "decompose", "scan", "robustness"] as const) {
  test(`${method}的同值事实和父链完整保留，不采用汇总展示去重`, () => {
    const source = fixture(1); source.method = method; source.methods[0].method = method;
    assert.equal(qaPresentationFacts(freeze(source)), source.facts);
    assert.throws(() => draw(source), /歧义|重复/);
    assertCompletePages(source);
  });
}

for (const name of ["完全无父链", "只有其他指标被公式引用"] as const) {
  test(`${name}时相同原值仍拒绝歧义，分页不漏重复身份`, () => {
    const source = fixture(1);
    if (name === "完全无父链") source.facts.pop();
    else source.facts[4].derivation = { op: "multiply", args: [{ factId: "denominator-0" }, { constant: 1 }] };
    const selected = ids(qaPresentationFacts(freeze(source)));
    assert.ok(selected.includes("amount-0") && selected.includes("numerator-0"));
    assert.throws(() => draw(source), /歧义|重复/);
    assert.throws(() => pageQaResult(createQaResult("ambiguous", source), { orderBy: { metric: "amount" } }), /没有.*指标/);
    assertCompletePages(source);
  });
}

const differentIdentities: Array<[string, (fact: AnalysisFact, source: AnalysisOperationResult) => void]> = [
  ["操作", (fact) => { fact.operationId = "another-operation"; }],
  ["数据范围", (fact, source) => {
    source.frames.push({ ...structuredClone(source.frames[0]), id: "another-frame", scope: { ...source.frames[0].scope, population: "net", period: { start: "2025-09-01", end: "2025-09-30" } } });
    source.methods[0].frameIds.push("another-frame");
    fact.frameId = "another-frame";
  }],
  ["对象", (fact, source) => {
    source.objects.push({ ...source.objects[0], id: "another-store", value: "另一门店", label: "另一门店" });
    fact.objectIds = ["another-store"];
  }],
  ["指标", (fact) => { fact.metricId = "tag_amount"; }],
  ["比较身份", (fact) => { fact.comparisonKey = "another-comparison"; }],
  ["比较角色", (fact) => { fact.comparisonRole = "standardized"; }],
  ["比较控制维度", (fact) => { fact.comparisonControls = ["category"]; }],
  ["比较控制取值", (fact) => { fact.comparisonValues = { category: "另一货类" }; }],
];
for (const [name, change] of differentIdentities) {
  test(`即使原值相同且有父引用，不同${name}的事实也不能合并`, () => {
    const source = fixture(1);
    change(source.facts[2], source);
    const selected = ids(qaPresentationFacts(freeze(source)));
    assert.ok(selected.includes("amount-0") && selected.includes("numerator-0"));
    assertCompletePages(source);
  });
}

const differentReadings: Array<[string, Partial<AnalysisFact>]> = [
  ["实收值", { value: 100.02 }],
  ["实际零值", { value: 0 }],
  ["缺失值", { value: null }],
  ["单位", { unit: "HKD" }],
  ["定义", { definition: "包含退货的净销售金额" }],
  ["局限", { limitations: ["仅覆盖实际读取的部分记录"] }],
  ["显式假设", { assumption: { reason: "维持当前数量结构" } }],
  ["派生值", { derivation: { factId: "amount-0" } }],
  ["情景身份", { scenario: { kind: "static_loss", baselineFactId: "amount-0", parameterFactIds: ["orders-0"] } }],
];
for (const [name, change] of differentReadings) {
  test(`有父引用也不能合并不同${name}，图表不能覆盖或混加`, () => {
    const source = fixture(1);
    Object.assign(source.facts[2], change);
    const selected = ids(qaPresentationFacts(freeze(source)));
    assert.ok(selected.includes("amount-0") && selected.includes("numerator-0"));
    assert.throws(() => draw(source), /单位|歧义|重复/);
    assertCompletePages(source);
  });
}

test("三份原值中只要存在冲突，不能先合并其中同值的两份", () => {
  const source = fixture(1);
  source.facts.push({ ...source.facts[0], id: "conflicting", value: 999.99 });
  const selected = ids(qaPresentationFacts(freeze(source)));
  for (const id of ["amount-0", "numerator-0", "conflicting"]) assert.ok(selected.includes(id));
  assert.throws(() => draw(source), /歧义|重复/);
  assertCompletePages(source);
});

test("相同假设或相同派生关系也不消除两个事实身份", () => {
  for (const extra of [{ assumption: { reason: "相同显式假设" } }, { derivation: { factId: "orders-0" } }] satisfies Array<Partial<AnalysisFact>>) {
    const source = fixture(1);
    Object.assign(source.facts[0], structuredClone(extra)); Object.assign(source.facts[2], structuredClone(extra));
    const selected = ids(qaPresentationFacts(freeze(source)));
    assert.ok(selected.includes("amount-0") && selected.includes("numerator-0"));
    assert.throws(() => draw(source), /歧义|重复/);
    assertCompletePages(source);
  }
});

test("多对象及比较维度的登记顺序不影响身份，排序时不改原数组", () => {
  const source = fixture(1);
  source.objects.push({ id: "category", frameId: "frame", dimension: "category", value: "黄金", label: "黄金" });
  for (const fact of [source.facts[0], source.facts[2]]) {
    fact.objectIds = ["store-0", "category"];
    fact.comparisonRole = "within_stratum"; fact.comparisonControls = ["store", "category"];
    fact.comparisonValues = { store: "0000", category: "黄金" };
  }
  source.facts[2].objectIds.reverse(); source.facts[2].comparisonControls!.reverse();
  source.facts[2].comparisonValues = { category: "黄金", store: "0000" };
  const before = structuredClone(source);
  assert.ok(!ids(qaPresentationFacts(freeze(source))).includes("numerator-0"));
  assertCompletePages(source);
  assert.deepEqual(source, before);
});

test("151组的排序与分页保留755条事实，图表前30组不加总重复父值", () => {
  const source = fixture(151);
  source.objects.forEach((object) => { object.label = `完整真实门店说明${object.value}`.repeat(8); });
  const before = structuredClone(source); freeze(source);
  const stored = createQaResult("large", source);
  const seen: string[] = [], ranked: Array<number | null> = [];
  let cursor: string | undefined, pages = 0;
  do {
    const page = pageQaResult(stored, { cursor, pageSize: 100, ...(cursor ? {} : { orderBy: { metric: "amount", direction: "desc" as const } }) });
    pages++;
    assert.ok(page.groups.length > 0 && page.groups.length <= 100);
    assert.ok(JSON.stringify(page).length <= 16000);
    assert.deepEqual(page.orderBy, { metric: "amount", direction: "desc" });
    for (const group of page.groups) {
      seen.push(...group.facts.map((fact) => fact.id));
      if (!group.kind) ranked.push(group.facts.find((fact) => fact.metricId === "amount")!.value);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.ok(pages > 4);
  assert.equal(seen.length, 755); assert.equal(new Set(seen).size, 755);
  assert.deepEqual([...seen].sort(), ids(source.facts).sort());
  assert.deepEqual([...stored.readFactIds].sort(), ids(source.facts).sort());
  const expected = source.facts.filter((fact) => fact.id.startsWith("amount-")).sort((a, b) => a.value === null ? 1 : b.value === null ? -1 : b.value - a.value);
  assert.deepEqual(ranked, expected.map((fact) => fact.value));
  const chart = draw(source, 30);
  assert.deepEqual(chart.series[0].values.map((point) => point.value), expected.slice(0, 30).map((fact) => fact.value));
  assert.deepEqual(chart.series[0].values.map((point) => point.refIds[0]), expected.slice(0, 30).map((fact) => fact.id));
  assert.deepEqual(new Set(chart.factIds), new Set(expected.map((fact) => fact.id)));
  assert.deepEqual(source, before);
});

test("只读主展示组仍可由比率补全原父链，v4序列化不丢原始事实身份", () => {
  const source = fixture(3), before = structuredClone(source); freeze(source);
  const stored = createQaResult("retained", source);
  const page = pageQaResult(stored, { pageSize: 1 });
  assert.equal(page.groups[0].kind, undefined);
  assert.deepEqual(page.groups[0].facts.map((fact) => fact.id), ["amount-0", "orders-0", "ratio-0"]);
  const answer = assembleQaAnswer({ runId: "run", question: "门店实收与客单价", body: "按照已读门店的真实实收和订单数计算客单价。", charts: new Map(), evidence: source, readFactIds: stored.readFactIds, operations: [{ id: "retained", op: "aggregate", status: "completed", summary: "完整结果已登记，按需读取" }] });
  const back = validatePlanAnswerV4(JSON.parse(JSON.stringify(answer)));
  assert.deepEqual(new Set(back.evidence.facts.map((fact) => fact.id)), new Set(["amount-0", "orders-0", "numerator-0", "denominator-0", "ratio-0"]));
  assert.deepEqual(back.evidence.facts.find((fact) => fact.id === "ratio-0")!.derivation, source.facts[4].derivation);
  assert.deepEqual(source, before);
});
