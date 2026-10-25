import assert from "node:assert/strict";
import test from "node:test";
import { createQaResult, pageQaResult } from "../app/lib/analytics/qa/results.ts";
import { capabilityBrief } from "../app/lib/analytics/qa/capabilities.ts";
import type { AnalysisOperationResult } from "../app/lib/analytics/analysis-v2-types.ts";

function result(count = 151): AnalysisOperationResult {
  return {
    operationId: "operation-1", method: "aggregate", status: "completed", purpose: "核对全部门店", needIds: ["qa"], limitations: [],
    frames: [{ id: "f", snapshotId: "snapshot", datasetVersion: "version", mode: "snapshot", provenance: "sample", scope: { period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales", filters: {} }, currency: "CNY", grain: "line", controls: [], limitations: [] }],
    objects: Array.from({ length: count }, (_, i) => ({ id: `o${i}`, frameId: "f", dimension: "store", value: String(i).padStart(4, "0"), label: `门店${i}` })),
    facts: Array.from({ length: count }, (_, i) => ({ id: `v${i}`, frameId: "f", operationId: "operation-1", metricId: "amount", label: "销售实收", value: i === 100 ? null : i * 10.01, unit: "CNY", definition: "原实收按分聚合", objectIds: [`o${i}`], limitations: [] })),
    methods: [{ id: "m", operationId: "operation-1", method: "aggregate", status: "completed", frameIds: ["f"], controls: [], checks: [{ name: "实际聚合", status: "performed", result: "完整读取" }], sampleRows: count, groupCount: count, limitations: [] }],
  };
}

test("结果分页完整读到第101组，游标绑定结果且不修改事实值", () => {
  const stored = createQaResult("r1", result());
  const seen: string[] = []; let cursor: string | undefined;
  do {
    const page = pageQaResult(stored, { cursor, pageSize: 100 });
    assert.equal(page.totalGroups, 151);
    assert.ok(JSON.stringify(page).length <= 16000);
    seen.push(...page.groups.flatMap((g) => g.facts.map((f) => f.id)));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(new Set(seen).size, 151);
  assert.equal(stored.readFactIds.size, 151);
  assert.equal(stored.result.facts[100].value, null);
  assert.throws(() => pageQaResult(createQaResult("r2", result()), { cursor: "qa:r1:1" }), /游标/);
  assert.throws(() => pageQaResult(stored, { cursor: "qa:r1:9999" }), /游标/);
});

test("字符预算在100组之前续页，不静默删除超长标签组", () => {
  const source = result(35);
  source.objects.forEach((object) => { object.label = "较长的真实门店说明".repeat(65) + object.value; });
  const stored = createQaResult("long", source);
  const first = pageQaResult(stored);
  assert.ok(first.groups.length < 35 && first.nextCursor);
  assert.ok(JSON.stringify(first).length <= 16000);
  const seen = [...first.groups]; let cursor: string | null = first.nextCursor;
  while (cursor) { const page = pageQaResult(stored, { cursor }); seen.push(...page.groups); cursor = page.nextCursor; }
  assert.equal(seen.length, 35);
});

test("百分数不再乘100；同一对象的目标参照与差额保持同组", () => {
  const source = result(1);
  source.facts = [source.facts[0], { ...source.facts[0], id: "rate", metricId: "amount.relative_change", value: 12, unit: "%", label: "实收相对变化" }];
  const page = pageQaResult(createQaResult("r", source));
  assert.equal(page.groups.length, 1);
  assert.equal(page.groups[0].facts.length, 2);
  assert.equal(page.groups[0].facts[1].value, 12);
  assert.match(page.groups[0].facts[1].formatted, /12\.00%/);
});

test("能力目录保留完整指标定义并告知维度取值可分页", () => {
  const definition = "需要完整保留的业务口径".repeat(15);
  const brief = capabilityBrief({ mode: "snapshot", name: "测试", currency: "CNY", coverage: { start: "2025-08-01", end: "2025-08-31" }, provenance: "sample", dimensions: ["store"], metrics: [{ id: "amount", label: "实收", unit: "CNY", grain: "line", additive: true, allowedPopulations: ["sales"], requiredControls: [], definition }], methods: ["aggregate"], limitations: [] });
  assert.ok(brief.includes(definition));
  assert.match(brief, /分页/);
});

test("能力目录保留维度定义和依据身份，不只给字段名称", () => {
  const definition = "源表的交易标签，不是审批规则或资格清单";
  const brief = capabilityBrief({ mode: "snapshot", name: "测试", currency: "CNY", coverage: { start: "2025-08-01", end: "2025-08-31" }, provenance: "sample", dimensions: ["offer"], dimensionCatalog: [{ id: "offer", label: "优惠", filter: "offers", scan: true, definition, basis: "assumption" }], metrics: [], methods: ["aggregate"], limitations: [] });
  assert.ok(brief.includes(definition));
  assert.match(brief, /待确认/);
});

test("各读数保留自身指标定义，不能让模型从分离的定义列表猜测对应关系", () => {
  const source = result(2);
  source.facts[0].definition = "当前筛选内的订单成交部分均值，不识别新增订单的均价";
  source.facts[1].definition = "牌价与实收差额，不识别单项优惠是否封顶";
  const page = pageQaResult(createQaResult("definitions", source));
  assert.equal(page.groups[0].facts[0].definition, source.facts[0].definition);
  assert.equal(page.groups[1].facts[0].definition, source.facts[1].definition);
});

test("每个读数明确标注自身分组对象，无对象标签的总体数不冒充某个分组", () => {
  const source = result(2);
  source.facts[1].objectIds = [];
  const facts = pageQaResult(createQaResult("objects", source)).groups.flatMap((group) => group.facts);
  assert.match(facts.find((fact) => fact.id === "v0")!.objectContext, /门店=门店0/);
  assert.match(facts.find((fact) => fact.id === "v0")!.readout, /门店=门店0/);
  assert.match(facts.find((fact) => fact.id === "v1")!.objectContext, /无分组对象标签/);
  assert.match(facts.find((fact) => fact.id === "v1")!.readout, /无分组对象标签/);
});

test("方法控制项不抬高每条读数的比较身份，分组键与排序指标明确返回", () => {
  const source = result(1); source.methods[0].controls = ["dayType"];
  const stored = createQaResult("identities", source, { by: ["campaignType", "offer"], controls: ["dayType"] });
  const page = pageQaResult(stored, { orderBy: { metric: "amount", direction: "desc" } });
  assert.deepEqual(page.queryGrouping?.by, ["campaignType", "offer"]);
  assert.match(page.groupCountDefinition, /组合.*单字段/);
  assert.match(page.orderingMeaning, /amount/);
  assert.match(page.groups[0].facts[0].comparisonContext, /无标准化标记/);
  source.facts[0].comparisonRole = "standardized"; source.facts[0].comparisonControls = ["dayType"];
  const marked = pageQaResult(createQaResult("marked", source)).groups[0].facts[0];
  assert.match(marked.comparisonContext, /已标记标准化/);
  assert.deepEqual(marked.comparisonControls, ["dayType"]);
});

test("读数随身携带真实期间、筛选及比率分母，目标参照不能靠相邻位置辨认", () => {
  const source = result(1);
  source.objects = [];
  source.frames[0].scope.filters = { memberFlags: ["非会员"], festivals: ["节日A"] };
  source.frames.push({ ...source.frames[0], id: "ref", scope: { ...source.frames[0].scope, filters: { memberFlags: ["非会员"], festivals: ["非节庆"] } } });
  source.facts = source.frames.flatMap((frame, index) => {
    const base = { ...source.facts[0], frameId: frame.id, objectIds: [] };
    return [
      { ...base, id: `orders-${index}`, metricId: "orders", label: "订单数", value: index ? 420 : 210, unit: "单" },
      { ...base, id: `days-${index}`, metricId: "period_days", label: "有成交日期数", value: index ? 21 : 7, unit: "日" },
      { ...base, id: `daily-${index}`, metricId: "orders_per_day", label: index ? "参照 · 日均订单" : "目标 · 日均订单", value: index ? 20 : 30, unit: "单/日", derivation: { op: "divide" as const, args: [{ factId: `orders-${index}` }, { factId: `days-${index}` }] } },
    ];
  });
  const original = structuredClone(source);
  const facts = pageQaResult(createQaResult("identity", source)).groups.flatMap((group) => group.facts);
  const target = facts.find((fact) => fact.id === "daily-0")!;
  const reference = facts.find((fact) => fact.id === "daily-1")!;
  assert.match(target.readout, /2025-08-01.*2025-08-31.*非会员.*节日A.*目标.*30单\/日/);
  assert.match(reference.readout, /非节庆.*参照.*20单\/日/);
  assert.match(target.calculation!, /210 单.*÷.*7 日/);
  assert.match(reference.calculation!, /420 单.*÷.*21 日/);
  assert.deepEqual(source, original);
});

test("读数区分观察、计算与假设并保留事实限制，未读计算依据不提前曝光", () => {
  const source = result(2);
  source.facts[0].limitations = ["部分行缺少订单身份"];
  source.facts.push({ ...source.facts[0], id: "derived", objectIds: source.facts[1].objectIds, metricId: "estimated", derivation: { op: "multiply", args: [{ factId: "v0" }, { constant: 2 }] }, assumption: { reason: "仅作情景假设" } });
  const stored = createQaResult("unread", source);
  const first = pageQaResult(stored, { pageSize: 1, orderBy: { metric: "amount", direction: "desc" } });
  const assumed = first.groups[0].facts.find((fact) => fact.id === "derived")!;
  assert.equal(assumed.evidenceKind, "assumption");
  assert.equal(assumed.calculation, undefined);
  assert.deepEqual([...stored.readFactIds].sort(), ["derived", "v1"]);
  const second = pageQaResult(stored, { cursor: first.nextCursor! });
  assert.equal(second.groups[0].facts[0].evidenceKind, "observation");
  assert.deepEqual(second.groups[0].facts[0].limitations, ["部分行缺少订单身份"]);
  assert.match(pageQaResult(stored, { pageSize: 1, orderBy: { metric: "amount", direction: "desc" } }).groups[0].facts.find((fact) => fact.id === "derived")!.calculation!, /0.*×.*2/);
});

test("计算依据不舍入原始精度，图表保留标记不等于结果页已读", () => {
  const source = result(1); source.objects = [];
  const base = { ...source.facts[0], objectIds: [] };
  source.facts = [
    { ...base, id: "money", value: 100, comparisonKey: "inputs" },
    { ...base, id: "weight", metricId: "grams", value: 1.234, unit: "克", comparisonKey: "inputs" },
    { ...base, id: "ratio", metricId: "amount_per_gram", value: 100 / 1.234, unit: "CNY/克", derivation: { op: "divide", args: [{ factId: "money" }, { factId: "weight" }] } },
  ];
  const stored = createQaResult("precise", source);
  const first = pageQaResult(stored, { pageSize: 1 });
  assert.equal(first.groups[0].facts[0].id, "ratio");
  stored.readFactIds.add("money"); stored.readFactIds.add("weight");
  assert.equal(pageQaResult(stored, { pageSize: 1 }).groups[0].facts[0].calculation, undefined);
  pageQaResult(stored, { cursor: first.nextCursor! });
  assert.match(pageQaResult(stored, { pageSize: 1 }).groups[0].facts[0].calculation!, /100.*÷.*1\.234.*克/);
});

test("长名单比较优先返回完整事实及范围，冗余读数注释不能撑破原可读单组", () => {
  const source = result(1); source.method = "compare"; source.objects = [];
  const offers = Array.from({ length: 82 }, (_, index) => String(index).padStart(3, "0") + "x".repeat(72));
  source.frames[0].scope.filters = { offers };
  source.frames.push({ ...source.frames[0], id: "ref", scope: { ...source.frames[0].scope, period: { start: "2025-07-01", end: "2025-07-31" } } });
  const base = { ...source.facts[0], objectIds: [], comparisonKey: "pair" };
  source.facts = [
    { ...base, id: "target", value: 100 }, { ...base, frameId: "ref", id: "reference", value: 90 },
    { ...base, id: "delta", metricId: "amount.delta", value: 10, derivation: { op: "subtract", args: [{ factId: "target" }, { factId: "reference" }] } },
    { ...base, id: "change", metricId: "amount.relative_change", value: 100 / 9, unit: "%", derivation: { op: "multiply", args: [{ constant: 100 }, { op: "divide", args: [{ factId: "delta" }, { factId: "reference" }] }] } },
  ];
  const original = structuredClone(source);
  const page = pageQaResult(createQaResult("compact", source), { pageSize: 1 });
  assert.ok(JSON.stringify(page).length <= 16000);
  assert.equal(page.groups[0].facts.length, 4);
  assert.deepEqual(page.frames.map((frame) => frame.scope.filters.offers), [offers, offers]);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(source, original);
});

test("大量未标对象的控制依据及方法检查仍能完整分页，不塞入一个超大总体组", () => {
  const source = result(180); source.objects = []; source.facts.forEach((fact) => { fact.objectIds = []; });
  source.methods[0].checks = Array.from({ length: 120 }, (_, i) => ({ name: "参与样本", status: "performed", result: `第${i}个实际控制对照：${"需要保留的完整可核查说明".repeat(10)}` }));
  const stored = createQaResult("controlled", source);
  const ids = new Set<string>(), checks = new Set<string>(); let cursor: string | undefined;
  do {
    const page = pageQaResult(stored, { cursor });
    assert.ok(JSON.stringify(page).length <= 16000);
    page.groups.forEach((group) => { group.facts.forEach((fact) => ids.add(fact.id)); group.checks?.forEach((check) => checks.add(check.result)); });
    page.methods.forEach((method) => method.checks?.forEach((check) => checks.add(check.result)));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(ids.size, 180); assert.equal(checks.size, 120);
});

test("全量结果可按真实指标排序，尾部最大值先读；续页不漏且游标保留排序", () => {
  const stored = createQaResult("ranking", result(151));
  const first = pageQaResult(stored, { pageSize: 3, orderBy: { metric: "amount", direction: "desc" } });
  assert.equal(first.groups[0].facts[0].id, "v150");
  const next = pageQaResult(stored, { cursor: first.nextCursor!, pageSize: 3 });
  assert.equal(next.groups[0].facts[0].id, "v147");
  assert.throws(() => pageQaResult(stored, { cursor: first.nextCursor!, orderBy: { metric: "amount", direction: "asc" } }), /排序|游标/);
  assert.throws(() => pageQaResult(stored, { orderBy: { metric: "invented_metric" } }), /指标/);
});
