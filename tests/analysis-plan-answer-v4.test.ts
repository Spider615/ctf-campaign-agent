import assert from "node:assert/strict";
import test from "node:test";
import { assemblePlanAnswerV4, planAnswerV4Text, validatePlanAnswerV4 } from "../app/lib/analytics/plan/answer.ts";
import type { PlanAnswerV4Input } from "../app/lib/analytics/plan/answer.ts";
import { resolveBody } from "../app/lib/analytics/plan/refs.ts";
import type { ResolvedBody } from "../app/lib/analytics/plan/refs.ts";
import type { NodeResult, NodeRole, NodeRow, PlanExecution } from "../app/lib/analytics/plan/execute.ts";
import type { PlanNode, PlanScope } from "../app/lib/analytics/plan/types.ts";
import type { AnalysisCapabilities, AnalysisFact, PlanAnswerBlock } from "../app/lib/analytics/analysis-v2-types.ts";

const scope: PlanScope = { period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales", filters: {} };
const capabilities = {
  mode: "snapshot", name: "测试", coverage: { start: "2025-01-01", end: "2025-12-31" }, currency: "人民币", provenance: "sample", dimensions: ["district", "product", "day"],
  dimensionCatalog: [
    { id: "district", label: "分区", filter: "districts", scan: true, definition: "大区加分区", basis: "data" },
    { id: "product", label: "货品", filter: "products", scan: true, definition: "货品大类", basis: "assumption" },
    { id: "day", label: "日期", filter: "days", scan: false, definition: "交易日期", basis: "schema" },
  ],
  metrics: [
    { id: "amount_per_day", label: "日均实收", unit: "money_per_day", grain: "line", additive: false, allowedPopulations: ["sales"], requiredControls: [], definition: "实收除以有成交日期数", basis: "data" },
    { id: "orders", label: "单数", unit: "单", grain: "line", additive: true, allowedPopulations: ["sales"], requiredControls: [], definition: "成交单数", basis: "assumption" },
  ],
  methods: ["aggregate"], limitations: [],
} as unknown as AnalysisCapabilities;
const labels = { metric: (id: string) => capabilities.metrics.find((item) => item.id === id)?.label ?? id, dimension: (id: string) => capabilities.dimensionCatalog?.find((item) => item.id === id)?.label ?? id };

const fact = (id: string, value: number | null, unit: string, metricId = "amount_per_day", objectIds: string[] = []): AnalysisFact => ({ id, frameId: "f", metricId, label: id, value, unit, definition: "d", objectIds, operationId: "op", limitations: [] });
const row = (factId: string, role: NodeRole, key: Record<string, string> = {}, metric = "amount_per_day", sampleRows?: number): NodeRow => ({ key, metric, factId, role, ...(sampleRows !== undefined ? { sampleRows } : {}) });
const done = (node: PlanNode, rows: NodeRow[]): NodeResult => ({ node, status: "completed", operationIds: ["op"], rows });

// m：按分区汇总（日均实收、单数）；t：按日汇总；c：对比；d：沿分区、货品下钻；u：按分区、货品两维汇总（无单维行）。
function execution(): PlanExecution {
  const facts = [
    fact("mv", 1000, "人民币/日"), fact("ma", 300, "人民币/日", "amount_per_day", ["oa"]), fact("mb", 500, "人民币/日", "amount_per_day", ["ob"]), fact("mc", 200, "人民币/日"),
    fact("mo", 30, "单", "orders"), fact("moa", 10, "单", "orders"), fact("mob", 12, "单", "orders"),
    fact("t1", 10, "人民币/日"), fact("t2", 12, "人民币/日"), fact("t3", 9, "人民币/日"),
    fact("cd", 50, "人民币/日", "amount_per_day.delta"), fact("cc", 50, "%", "amount_per_day.relative_change"),
    fact("da", 30, "人民币/日", "amount_per_day.deviation"), fact("db", -20, "人民币/日", "amount_per_day.deviation"),
    fact("dx", 5, "人民币/日", "amount_per_day.deviation"), fact("dy", -8, "人民币/日", "amount_per_day.deviation"), fact("dz", 2, "人民币/日", "amount_per_day.deviation"),
    fact("ua", 1, "人民币/日"), fact("ub", 2, "人民币/日"),
    fact("unused", 7, "人民币/日"),
  ];
  const results = new Map<string, NodeResult>([
    ["m", done({ id: "m", op: "measure", scope, metrics: ["amount_per_day", "orders"], by: ["district"] }, [
      row("mv", "value"), row("ma", "value", { district: "东区" }), row("mb", "value", { district: "南区" }), row("mc", "value", { district: "西区" }),
      row("mo", "value", {}, "orders"), row("moa", "value", { district: "东区" }, "orders"), row("mob", "value", { district: "南区" }, "orders"),
    ])],
    ["t", done({ id: "t", op: "measure", scope, metrics: ["amount_per_day"], by: ["day"] }, [row("t2", "value", { day: "2025-08-02" }), row("t1", "value", { day: "2025-08-01" }), row("t3", "value", { day: "2025-08-03" })])],
    ["c", done({ id: "c", op: "contrast", target: scope, reference: scope, metrics: ["amount_per_day"] }, [row("cd", "delta"), row("cc", "change")])],
    ["d", done({ id: "d", op: "drill", of: "c", path: ["district", "product"], minRows: 1 }, [
      row("da", "deviation", { district: "东区" }, "amount_per_day", 50), row("db", "deviation", { district: "南区" }, "amount_per_day", 50),
      row("dx", "deviation", { district: "东区", product: "金条" }, "amount_per_day", 10), row("dy", "deviation", { district: "东区", product: "手镯" }, "amount_per_day", 10), row("dz", "deviation", { district: "南区", product: "项链" }, "amount_per_day", 10),
    ])],
    ["u", done({ id: "u", op: "measure", scope, metrics: ["amount_per_day"], by: ["district", "product"] }, [row("ua", "value", { district: "东区", product: "金条" }), row("ub", "value", { district: "南区", product: "手镯" })])],
  ]);
  return {
    results,
    evidence: {
      frames: [{ id: "f", snapshotId: "s", datasetVersion: "v", mode: "snapshot", provenance: "sample", scope: { period: scope.period, population: "sales", filters: {} }, currency: "人民币", grain: "line", controls: [], limitations: [] }],
      facts,
      objects: [{ id: "oa", frameId: "f", dimension: "district", value: "东区", label: "东区" }, { id: "ob", frameId: "f", dimension: "district", value: "南区", label: "南区" }],
      methods: [{ id: "mt", operationId: "op", status: "completed", method: "aggregate", frameIds: ["f"], controls: [], checks: [{ name: "聚合", status: "performed", result: "ok" }], sampleRows: 10, groupCount: 1, limitations: [] }],
    },
  };
}

const input = (body: ResolvedBody, extra: Partial<PlanAnswerV4Input> = {}): PlanAnswerV4Input => ({ runId: "r1", question: "八月怎么样", execution: execution(), body, capabilities, droppedNodes: [], reviewNotes: [], ...extra });
const resolved = (text: string) => resolveBody(text, execution(), [], labels);
const charts = (body: PlanAnswerBlock[]) => body.flatMap((block) => block.kind === "chart" ? [block.chart] : []);
const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value));

test("组装后 refs 指向的文本就是格式化后的数字，重点数字随正文带出", () => {
  const answer = assemblePlanAnswerV4(input(resolved("八月日均实收 {{m.amount_per_day}}。\n\n东区 {{m.amount_per_day|district=东区}}，单数 {{m.orders|district=东区}}。")));
  assert.equal(answer.schema, "analysis-answer/v4");
  const [block] = answer.body;
  assert.equal(block.kind, "markdown");
  if (block.kind !== "markdown") return;
  assert.deepEqual(block.refs.map((ref) => block.text.slice(ref.start, ref.end)), ["1,000.00元/日", "300.00元/日", "10单"]);
  assert.deepEqual(answer.keyFigure, { value: "1,000.00元/日", factId: "mv" });
  assert.equal(answer.status, "answered");
  assert.match(answer.plan[0].summary, /统计/);
});

test("三种状态：正文为空、有 issue 或丢弃节点、正常", () => {
  assert.equal(assemblePlanAnswerV4(input(resolved("日均 {{m.amount_per_day}}。"))).status, "answered");
  assert.equal(assemblePlanAnswerV4(input(resolved("日均 {{m.amount_per_day}}。未知 {{zz.amount}}。"))).status, "partial");
  assert.equal(assemblePlanAnswerV4(input(resolved("日均 {{m.amount_per_day}}。"), { droppedNodes: [{ id: "x", reason: "维度不可用" }] })).status, "partial");
  const none = assemblePlanAnswerV4(input(resolved("未知 {{zz.amount}}。")));
  assert.equal(none.status, "unavailable");
  assert.deepEqual(none.body, [{ kind: "markdown", text: "这次没能得出可以直接采用的结论。", refs: [] }]);
  assert.equal(none.keyFigure, undefined);
  assert.deepEqual(none.evidence.facts, []);
  validatePlanAnswerV4(roundTrip(none));
  // 只有画不出来的图时也算正文为空。
  assert.equal(assemblePlanAnswerV4(input({ blocks: [{ kind: "chart", node: "c", metric: "amount_per_day", top: 6 }], issues: [], factIds: [] })).status, "unavailable");
});

test("图表块：measure 按 by 画条形图并按 top 截断，按日画折线，下钻画偏离图；画不出的去掉", () => {
  const body = resolved("开头 {{m.amount_per_day}}。\n::: chart m amount_per_day by district top 2\n中间一句。\n::: chart t amount_per_day by day");
  const answer = assemblePlanAnswerV4(input(body));
  const [bar, line] = charts(answer.body);
  assert.equal(bar.kind, "bar"); assert.equal(bar.id, "plan-chart-r1-1");
  assert.deepEqual(bar.categories.map((item) => item.label), ["南区", "东区"]);
  assert.equal(bar.title, "各分区的日均实收");
  assert.equal(line.kind, "line"); assert.equal(line.id, "plan-chart-r1-2");
  assert.deepEqual(line.categories.map((item) => item.key), ["2025-08-01", "2025-08-02", "2025-08-03"]);
  assert.deepEqual(answer.body.map((block) => block.kind), ["markdown", "chart", "markdown", "chart"]);
  assert.equal(bar.afterBlockIndex, 0);

  // 下钻：不给 by 取最深层；by district 取第一层；top 截断。
  const drill = (by?: string, top = 6) => charts(assemblePlanAnswerV4(input({ blocks: [{ kind: "chart", node: "d", metric: "amount_per_day", ...(by ? { by } : {}), top }], issues: [], factIds: [] })).body)[0];
  assert.deepEqual(drill()?.factIds, ["dy", "dx", "dz"]);
  assert.deepEqual(drill("district")?.categories.map((item) => item.label), ["东区", "南区"]);
  assert.deepEqual(drill(undefined, 2)?.factIds, ["dy", "dx"]);
  assert.equal(drill("store"), undefined);

  // 不给 by 时 measure 按节点自身分组画；按 by 过滤只认单维度行。
  const plain = charts(assemblePlanAnswerV4(input({ blocks: [{ kind: "chart", node: "m", metric: "amount_per_day", top: 8 }], issues: [], factIds: [] })).body)[0];
  assert.deepEqual(plain.categories.map((item) => item.label), ["南区", "东区", "西区"]);
  const twoDims = assemblePlanAnswerV4(input({ blocks: [{ kind: "markdown", text: "说明。", refs: [] }, { kind: "chart", node: "u", metric: "amount_per_day", by: "district", top: 6 }, { kind: "chart", node: "c", metric: "amount_per_day", top: 6 }], issues: [], factIds: [] }));
  assert.deepEqual(twoDims.body.map((block) => block.kind), ["markdown"]);
  // 组装阶段仍画不出的图记进复核备注，不改状态。
  assert.equal(twoDims.status, "answered");
  assert.equal(twoDims.review.notes.length, 2);
  assert.match(twoDims.review.notes[0], /^图没有画出来：.*没有恰好按分区（district）分组/);
  assert.match(twoDims.review.notes[1], /3 种以上对齐方式/);
});

test("正文解析预判画不出的图：记 issue、块丢弃，答案为 partial", () => {
  const body = resolved("日均 {{m.amount_per_day}}。\n::: chart c amount_per_day by district");
  assert.equal(body.issues.length, 1);
  assert.equal(body.issues[0].text, "::: chart c amount_per_day by district");
  assert.match(body.issues[0].reason, /节点「c」是对比节点，不能按维度分组出图/);
  const answer = assemblePlanAnswerV4(input(body));
  assert.deepEqual(answer.body.map((block) => block.kind), ["markdown"]);
  assert.equal(answer.status, "partial"); assert.deepEqual(answer.review.notes, []);
});

test("证据只保留正文和图表引用的事实；口径来自被引用事实", () => {
  const answer = assemblePlanAnswerV4(input(resolved("东区 {{m.amount_per_day|district=东区}}。\n::: chart t amount_per_day by day")));
  assert.deepEqual(answer.evidence.facts.map((item) => item.id).sort(), ["ma", "t1", "t2", "t3"]);
  assert.deepEqual(answer.evidence.objects.map((item) => item.id), ["oa"]);
  assert.deepEqual(answer.definitions, ["日均实收：实收除以有成交日期数", "分区：大区加分区"]);
  assert.deepEqual(answer.assumptions, []);
  const table = assemblePlanAnswerV4(input(resolved("::: table m orders by district")));
  assert.deepEqual(table.evidence.facts.map((item) => item.id).sort(), ["moa", "mob"]);
  assert.deepEqual(table.assumptions, ["口径待确认：单数，成交单数"]);
});

test("validatePlanAnswerV4 往返通过，拒绝越界 refs、不存在的事实和错误版本", () => {
  const answer = assemblePlanAnswerV4(input(resolved("日均 {{m.amount_per_day}}。\n::: table m orders by district\n::: chart m amount_per_day by district")));
  const back = validatePlanAnswerV4(roundTrip(answer));
  assert.deepEqual(back, roundTrip(answer));
  const copy = () => roundTrip(answer);
  const over = copy(); over.body[0].refs[0].end = over.body[0].text.length + 1; assert.throws(() => validatePlanAnswerV4(over), /超出正文范围/);
  const backwards = copy(); backwards.body[0].refs[0].start = 5; backwards.body[0].refs[0].end = 5; assert.throws(() => validatePlanAnswerV4(backwards), /超出正文范围/);
  const negative = copy(); negative.body[0].refs[0].start = -1; assert.throws(() => validatePlanAnswerV4(negative), /超出正文范围/);
  const ghost = copy(); ghost.body[0].refs[0].factIds = ["nope"]; assert.throws(() => validatePlanAnswerV4(ghost), /不存在的事实/);
  const ghostRow = copy(); ghostRow.body[1].rows[0].factIds = ["nope"]; assert.throws(() => validatePlanAnswerV4(ghostRow), /不存在的事实/);
  const ghostChart = copy(); ghostChart.body[2].chart.factIds = ["nope"]; assert.throws(() => validatePlanAnswerV4(ghostChart), /不存在的事实/);
  const v3 = copy(); v3.schema = "analysis-answer/v3"; assert.throws(() => validatePlanAnswerV4(v3), /版本/);
  const kind = copy(); kind.body[0].kind = "html"; assert.throws(() => validatePlanAnswerV4(kind), /类型/);
  const empty = copy(); empty.body = []; assert.throws(() => validatePlanAnswerV4(empty), /正文/);
  const cells = copy(); cells.body[1].rows[0].cells = ["东区"]; assert.throws(() => validatePlanAnswerV4(cells), /单元格数与列数不一致/);
  const long = copy(); long.body[0].text = "长".repeat(1201); long.body[0].refs = []; assert.throws(() => validatePlanAnswerV4(long), /正文最多 1200 个字符/);
  const split = copy(); split.body = [{ kind: "markdown", text: "甲".repeat(700), refs: [] }, { kind: "markdown", text: "乙".repeat(501), refs: [] }]; assert.throws(() => validatePlanAnswerV4(split), /正文最多 1200 个字符/);
  const exact = copy(); exact.body = [{ kind: "markdown", text: "甲".repeat(1200), refs: [] }]; exact.keyFigure = undefined; validatePlanAnswerV4(exact);
  const figure = copy(); figure.keyFigure = { value: "1", factId: "nope" }; assert.throws(() => validatePlanAnswerV4(figure), /重点数字/);
});

test("planAnswerV4Text：Markdown 原文、表格转成竖线分隔、图写标题", () => {
  const answer = assemblePlanAnswerV4(input(resolved("## 结论\n日均 {{m.amount_per_day}}。\n::: table m orders by district\n::: chart t amount_per_day by day")));
  assert.equal(planAnswerV4Text(answer), "## 结论\n日均 1,000.00元/日。\n\n各分区的单数\n分区 | 单数\n南区 | 12单\n东区 | 10单\n\n图：日均实收逐日走势");
});
