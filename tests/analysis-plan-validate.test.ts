import assert from "node:assert/strict";
import test from "node:test";
import { parsePlan, validatePlan } from "../app/lib/analytics/plan/validate.ts";
import { analysisMetricDefinitions } from "../app/lib/analytics/analysis-v2-operations.ts";
import type { AnalysisCapabilities } from "../app/lib/analytics/analysis-v2-types.ts";

const capabilities: AnalysisCapabilities = { mode: "database", name: "测试", coverage: { start: "2025-08-01", end: "2025-08-31" }, currency: "人民币", provenance: "imported", dimensions: ["region", "district", "store", "category", "material", "festival", "offer"], metrics: analysisMetricDefinitions("人民币", ["amount", "orders", "stores", "grams", "rows", "amount_per_day", "amount_per_order", "amount_per_gram", "discount_rate"], "database"), methods: ["aggregate", "compare", "decompose", "scan", "robustness"], limitations: [] };
const scope = (filters: Record<string, string[]> = {}) => ({ period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales" as const, filters });

test("合法计划全部保留，节点引用按依赖顺序检查", () => {
  const { plan, issues } = parsePlan({ question: "七夕怎么样", nodes: [
    { id: "c1", op: "contrast", target: scope({ festivals: ["七夕节"] }), reference: scope({ festivals: ["非节庆"] }), metrics: ["amount_per_day", "discount_rate"] },
    { id: "d1", op: "drill", of: "c1", path: ["region", "district"] },
    { id: "r1", op: "robust", of: "c1", checks: ["largest_store"] },
  ] });
  assert.deepEqual(issues, []);
  const checked = validatePlan(plan!, capabilities, { filters: {} });
  assert.equal(checked.valid.length, 3); assert.deepEqual(checked.issues, []);
});

test("一次返回全部问题：未知指标、缺控制、口径不符、超范围、悬空引用、下钻来源被丢弃", () => {
  const { plan } = parsePlan({ question: "q", nodes: [
    { id: "a", op: "measure", scope: scope(), metrics: ["profit_margin_guess"] },
    { id: "b", op: "measure", scope: scope(), metrics: ["amount_per_gram"], by: ["region"] },
    { id: "c", op: "measure", scope: { ...scope(), population: "net" }, metrics: ["amount_per_order"] },
    { id: "d", op: "measure", scope: { ...scope(), period: { start: "2025-07-01", end: "2025-08-31" } }, metrics: ["amount"] },
    { id: "e", op: "decompose", of: "missing" },
    { id: "f", op: "drill", of: "a", path: ["district", "region"] },
  ] });
  const checked = validatePlan(plan!, capabilities, { filters: {} });
  const messages = checked.issues.map((issue) => `${issue.node}:${issue.message}`).join("\n");
  for (const node of ["a", "b", "c", "d", "e", "f"]) assert.match(messages, new RegExp(`^${node}:`, "m"), `${node} 没有报告问题`);
  assert.equal(checked.valid.length, 0);
});

test("decompose 只能指向 contrast；依赖被丢弃的节点也一并丢弃", () => {
  const { plan } = parsePlan({ question: "q", nodes: [
    { id: "m", op: "measure", scope: scope(), metrics: ["amount"] },
    { id: "x", op: "decompose", of: "m" },
    { id: "bad", op: "contrast", target: scope(), reference: scope(), metrics: ["unknown"] },
    { id: "r", op: "robust", of: "bad", checks: ["largest_store"] },
  ] });
  const checked = validatePlan(plan!, capabilities, { filters: {} });
  assert.deepEqual(checked.valid.map((node) => node.id), ["m"]);
  assert.deepEqual(checked.dropped.map((item) => item.node.id).sort(), ["bad", "r", "x"]);
});

test("结构错误在解析阶段报告：重复 id、未知算子、超上限", () => {
  const { issues } = parsePlan({ question: "q", nodes: [{ id: "a", op: "measure", scope: scope(), metrics: ["amount"] }, { id: "a", op: "magic" }, ...Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, op: "measure", scope: scope(), metrics: ["amount"] }))] });
  const text = issues.map((issue) => issue.message).join("\n");
  assert.match(text, /重复/); assert.match(text, /算子/); assert.match(text, /最多 12/);
});

// 逐条规则：单个计划里一个合法来源加一个被测节点，断言被测节点被丢弃且提示命中规则。
const withScenarios: AnalysisCapabilities = { ...capabilities, scenarios: ["per_item"] };
const measure = { id: "m", op: "measure", scope: scope(), metrics: ["amount"] };
const contrast = { id: "c", op: "contrast", target: scope(), reference: scope(), metrics: ["amount"] };
function check(nodes: unknown[], pattern?: RegExp, caps: AnalysisCapabilities = capabilities, target = "t") {
  const { plan, issues: parseIssues } = parsePlan({ question: "q", nodes });
  assert.deepEqual(parseIssues, []);
  const checked = validatePlan(plan!, caps, { filters: {} });
  const text = checked.issues.filter((issue) => issue.node === target).map((issue) => issue.message).join("\n");
  if (pattern) {
    assert.ok(checked.dropped.some((item) => item.node.id === target), `${target} 应被丢弃`);
    assert.match(text, pattern);
  } else {
    assert.equal(text, "", `${target} 不应有问题`);
    assert.ok(checked.valid.some((node) => node.id === target), `${target} 应保留`);
  }
}

test("缺少 of 或 of 不是字符串：报告并丢弃", () => {
  for (const op of ["decompose", "drill", "scan", "robust", "scenario"]) {
    check([measure, { id: "t", op, path: ["region"], checks: ["halves"] }], /缺少 of/);
    check([measure, { id: "t", op, of: 1, path: ["region"], checks: ["halves"] }], /缺少 of/);
  }
});

test("of 指向后面的节点或自身：报告只能引用前面", () => {
  check([{ id: "t", op: "scan", of: "m" }, measure], /只能引用前面已声明的节点/);
  check([measure, { id: "t", op: "scan", of: "t" }], /只能引用前面已声明的节点/);
});

test("drill 层级：下级在后通过，反向被丢弃", () => {
  check([measure, { id: "t", op: "drill", of: "m", path: ["region", "district"] }]);
  check([measure, { id: "t", op: "drill", of: "m", path: ["district", "region"] }], /下级/);
});

test("scan：不参与扫描的维度、top 越界被丢弃，合法扫描通过", () => {
  check([measure, { id: "t", op: "scan", of: "m", dimensions: ["store"] }], /不参与扫描/);
  check([measure, { id: "t", op: "scan", of: "m", top: 0 }], /top 取/);
  check([measure, { id: "t", op: "scan", of: "m", top: 11 }], /top 取/);
  check([measure, { id: "t", op: "scan", of: "m", dimensions: ["region"], top: 10 }]);
});

test("robust：未知检查、缺替代窗口、非销售口径剔除最大订单", () => {
  check([measure, { id: "t", op: "robust", of: "m", checks: ["magic"] }], /checks 取/);
  check([measure, { id: "t", op: "robust", of: "m", checks: ["alternative_window"] }], /替代窗口/);
  check([measure, { id: "t", op: "robust", of: "m", checks: ["alternative_window"], alternative: { start: "2025-08-01", end: "2025-08-15" } }]);
  const net = { id: "n", op: "measure", scope: { ...scope(), population: "net" }, metrics: ["amount"] };
  check([net, { id: "t", op: "robust", of: "n", checks: ["largest_order"] }], /只适用于销售口径/);
  const netContrast = { id: "n", op: "contrast", target: { ...scope(), population: "net" }, reference: { ...scope(), population: "net" }, metrics: ["amount"] };
  check([netContrast, { id: "t", op: "robust", of: "n", checks: ["largest_order"] }], /只适用于销售口径/);
  check([measure, { id: "t", op: "robust", of: "m", checks: ["largest_order"] }]);
  check([measure, { id: "s", op: "scan", of: "m" }, { id: "t", op: "robust", of: "s", checks: ["largest_store"] }], /robust 只能检查 measure 或 contrast 节点/);
});

test("robust：checks 不是数组时不抛错，只报告并丢弃", () => {
  for (const checks of [{}, 5]) {
    const { plan } = parsePlan({ question: "q", nodes: [measure, { id: "r", op: "robust", of: "m", checks }] });
    let checked!: ReturnType<typeof validatePlan>;
    assert.doesNotThrow(() => { checked = validatePlan(plan!, capabilities, { filters: {} }); });
    assert.ok(checked.dropped.some((item) => item.node.id === "r"));
    assert.match(checked.issues.filter((issue) => issue.node === "r").map((issue) => issue.message).join("\n"), /checks/);
  }
});

test("scenario：规则不在能力、变化假设数量、理由为空", () => {
  const scenario = { id: "t", op: "scenario", of: "m", adjustment: { kind: "per_item", amount: "10" }, netVolumeChanges: ["0.1"], reason: "门店反馈" };
  check([measure, scenario], /不支持该情景规则/);
  check([measure, scenario], undefined, withScenarios);
  check([measure, { ...scenario, netVolumeChanges: [] }], /净成交量变化/, withScenarios);
  check([measure, { ...scenario, netVolumeChanges: ["1", "2", "3", "4", "5", "6", "7"] }], /净成交量变化/, withScenarios);
  check([measure, { ...scenario, netVolumeChanges: ["1", "2", "3", "4", "5", "6"] }], undefined, withScenarios);
  check([measure, { ...scenario, reason: " " }], /假设理由/, withScenarios);
  check([contrast, { ...scenario, of: "c" }], /只能作用于 measure/, withScenarios);
});

test("控制维度：固定单值或对齐控制后通过", () => {
  const perGram = { id: "t", op: "measure", scope: scope({ categories: ["一般足金类"], materials: ["足金"] }), metrics: ["amount_per_gram"] };
  check([perGram]);
  check([{ ...perGram, scope: scope() }], /需要固定或分组控制/);
  const aligned = { id: "t", op: "contrast", target: scope(), reference: scope(), metrics: ["amount_per_gram"], align: { controls: ["category", "material"] } };
  check([aligned]);
  check([{ ...aligned, align: undefined }], /需要固定或分组控制/);
});

test("contrast：目标与参照口径不同被丢弃", () => {
  check([{ id: "t", op: "contrast", target: scope(), reference: { ...scope(), population: "net" }, metrics: ["amount"] }], /口径必须相同/);
});

test("decompose：被拆解的 contrast 不含实收类指标被丢弃", () => {
  check([{ ...contrast, metrics: ["discount_rate"] }, { id: "t", op: "decompose", of: "c" }], /含实收或日均实收/);
  check([contrast, { id: "t", op: "decompose", of: "c" }]);
});

test("筛选值必须是实际取值，写错时给出最接近的正确值", () => {
  const withValues: AnalysisCapabilities = { ...capabilities, dimensionCatalog: [
    { id: "festival", label: "节庆", filter: "festivals", scan: true, definition: "节庆", basis: "data", values: ["七夕节", "非节庆"] },
    { id: "category", label: "货类", filter: "categories", scan: true, definition: "货类", basis: "data", values: ["一般足金类", "定价黄金类"] },
  ], dimensions: [...capabilities.dimensions, "festival"] };
  const { plan } = parsePlan({ question: "q", nodes: [
    { id: "a", op: "measure", scope: scope({ festivals: ["七夕"] }), metrics: ["amount"] },
    { id: "b", op: "measure", scope: scope({ categories: ["一般足金"] }), metrics: ["amount"] },
    { id: "c", op: "measure", scope: scope({ festivals: ["七夕节"] }), metrics: ["amount"] },
  ] });
  const checked = validatePlan(plan!, withValues, { filters: {} });
  assert.deepEqual(checked.valid.map((node) => node.id), ["c"]);
  const text = checked.issues.map((issue) => `${issue.node}:${issue.message}`).join("\n");
  assert.match(text, /a:节庆没有「七夕」这个取值，可能是：「七夕节」/);
  assert.match(text, /b:货类没有「一般足金」这个取值，可能是：「一般足金类」/);
});

test("超出节点上限的节点逐个报原因；补充计划可传入算上已有节点的上限", () => {
  const nodes = Array.from({ length: 14 }, (_, index) => ({ id: `n${index}`, op: "measure" }));
  const capped = parsePlan({ question: "q", nodes });
  assert.equal(capped.plan!.nodes.length, 12);
  assert.ok(capped.issues.some((issue) => issue.node === "n13" && issue.message.includes("超出节点上限")));
  const widened = parsePlan({ question: "q", nodes }, 20);
  assert.equal(widened.plan!.nodes.length, 14);
  assert.equal(widened.issues.length, 0);
});

// 问题类型与活动目标；机制比较时对比节点必须对齐货。
const goods = (categories: string[], materials: string[]) => scope({ categories, materials });
const mechanism = (nodes: unknown[], intent: unknown = { kind: "mechanism", goal: "basket", reason: "比较克减50和克减30" }) => {
  const { plan, issues } = parsePlan({ question: "q", intent, nodes });
  return { plan: plan!, parseIssues: issues, checked: validatePlan(plan!, capabilities, { filters: {} }) };
};

test("intent 缺省时按复盘、无目标处理，不报错", () => {
  const { plan, issues } = parsePlan({ question: "q", nodes: [measure] });
  assert.deepEqual(issues, []);
  assert.deepEqual(plan!.intent, { kind: "review", goal: "none", reason: "" });
});

test("intent 取值不对时报问题：kind、goal 越界，reason 超过 200 字", () => {
  const { plan, issues } = parsePlan({ question: "q", intent: { kind: "guess", goal: "money", reason: "长".repeat(201) }, nodes: [measure] });
  const text = issues.map((issue) => issue.message).join("\n");
  assert.match(text, /intent\.kind 取 lookup、review/);
  assert.match(text, /intent\.goal 取 frequency/);
  assert.match(text, /最多 200 字/);
  assert.equal(plan!.intent!.reason.length, 200);
  const valid = parsePlan({ question: "q", intent: { kind: "mechanism", goal: "basket", reason: "比较两种优惠" }, nodes: [measure] });
  assert.deepEqual(valid.issues, []); assert.deepEqual(valid.plan!.intent, { kind: "mechanism", goal: "basket", reason: "比较两种优惠" });
});

test("机制比较：没对齐货的对比节点报问题并丢弃", () => {
  const cases = [
    { target: scope({ offers: ["克减50"] }), reference: scope({ offers: ["克减30"] }) },
    // 只固定货类，没固定材料
    { target: scope({ categories: ["一般足金类"] }), reference: scope({ categories: ["一般足金类"] }) },
    // 货类不同
    { target: goods(["一般足金类"], ["足金"]), reference: goods(["定价黄金类"], ["足金"]) },
  ];
  for (const sides of cases) {
    const { checked } = mechanism([{ id: "c", op: "contrast", ...sides, metrics: ["amount_per_order"] }]);
    assert.ok(checked.dropped.some((item) => item.node.id === "c"));
    const issue = checked.issues.find((item) => item.node === "c");
    assert.match(issue!.message, /机制比较要先对齐货/); assert.match(issue!.message, /选择效应/);
  }
  // 只控制货类不够
  const { checked } = mechanism([{ id: "c", op: "contrast", target: scope(), reference: scope(), metrics: ["amount_per_order"], align: { controls: ["category"] } }]);
  assert.match(checked.issues.map((item) => item.message).join("\n"), /机制比较要先对齐货/);
});

test("机制比较：固定同一组货类和材料的对比通过，顺序不同也算相同", () => {
  const { checked } = mechanism([{ id: "c", op: "contrast", target: goods(["一般足金类", "定价黄金类"], ["足金"]), reference: goods(["定价黄金类", "一般足金类"], ["足金"]), metrics: ["amount_per_order"] }]);
  assert.deepEqual(checked.issues, []); assert.deepEqual(checked.valid.map((node) => node.id), ["c"]);
});

test("机制比较：align.controls 同时控制 category、material 时通过", () => {
  const { checked } = mechanism([{ id: "c", op: "contrast", target: scope(), reference: scope(), metrics: ["amount_per_order"], align: { controls: ["category", "material"] } }]);
  assert.deepEqual(checked.issues, []); assert.deepEqual(checked.valid.map((node) => node.id), ["c"]);
});

test("非机制比较（复盘、缺省）不检查货对齐；机制比较只查对比节点", () => {
  const loose = { id: "c", op: "contrast", target: scope(), reference: scope(), metrics: ["amount_per_order"] };
  assert.deepEqual(mechanism([loose], { kind: "review", goal: "revenue", reason: "" }).checked.issues, []);
  assert.deepEqual(mechanism([loose], null).checked.issues, []);
  assert.deepEqual(mechanism([measure]).checked.issues, []);
});

test("货对齐只要求能力目录里有的维度：目录没有材料时只对齐货类即可通过", () => {
  const noMaterial: AnalysisCapabilities = { ...capabilities, dimensions: capabilities.dimensions.filter((item) => item !== "material") };
  const nodes = [
    { id: "f", op: "contrast", target: scope({ categories: ["一般足金类"] }), reference: scope({ categories: ["一般足金类"] }), metrics: ["amount_per_order"] },
    { id: "k", op: "contrast", target: scope(), reference: scope(), metrics: ["amount_per_order"], align: { controls: ["category"] } },
    { id: "x", op: "contrast", target: scope(), reference: scope(), metrics: ["amount_per_order"] },
  ];
  const { plan } = parsePlan({ question: "q", intent: { kind: "mechanism", goal: "basket", reason: "" }, nodes });
  const checked = validatePlan(plan!, noMaterial, { filters: {} });
  assert.deepEqual(checked.valid.map((node) => node.id), ["f", "k"]);
  const issue = checked.issues.find((item) => item.node === "x")!;
  assert.match(issue.message, /固定同一货类（categories），或在 align\.controls 里控制 category；/);
  assert.doesNotMatch(issue.message, /材料|material/);
  // 货类、材料都不在目录里：不检查
  const neither: AnalysisCapabilities = { ...noMaterial, dimensions: noMaterial.dimensions.filter((item) => item !== "category") };
  const bare = parsePlan({ question: "q", intent: { kind: "mechanism", goal: "basket", reason: "" }, nodes: [nodes[2]] });
  assert.deepEqual(validatePlan(bare.plan!, neither, { filters: {} }).issues, []);
});

test("目录有材料时：货类对齐了但材料没对齐，报问题且只提材料", () => {
  for (const sides of [
    { target: scope({ categories: ["一般足金类"] }), reference: scope({ categories: ["一般足金类"] }) },
    { target: scope(), reference: scope(), align: { controls: ["category"] } },
  ]) {
    const { checked } = mechanism([{ id: "c", op: "contrast", ...sides, metrics: ["amount_per_order"] }]);
    const issue = checked.issues.find((item) => item.node === "c")!;
    assert.match(issue.message, /固定同一材料（materials），或在 align\.controls 里控制 material；/);
    assert.doesNotMatch(issue.message, /货类|categor/);
  }
});

