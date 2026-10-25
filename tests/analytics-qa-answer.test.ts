import assert from "node:assert/strict";
import test from "node:test";
import { assembleQaAnswer } from "../app/lib/analytics/qa/answer.ts";
import { drawQaChart } from "../app/lib/analytics/qa/chart.ts";
import { removeUnderlyingIdentity, sanitizeAgentReply } from "../app/lib/agent/reply-stream.ts";
import { validatePlanAnswerV4 } from "../app/lib/analytics/plan/answer.ts";
import type { AnalysisCapabilities, AnalysisEvidence, AnalysisOperationResult, PlanAnswerV4 } from "../app/lib/analytics/analysis-v2-types.ts";
import type { ResolvedVisualization } from "../app/lib/analytics/visualization-types.ts";

function evidence(): AnalysisEvidence {
  return {
    frames: [{ id: "f", snapshotId: "s", datasetVersion: "v", mode: "snapshot", provenance: "sample", currency: "CNY", grain: "line", controls: [], limitations: ["观察数据不能说明因果"] , scope: { period: { start: "2025-08-01", end: "2025-08-03" }, population: "sales", filters: {} } }],
    objects: [{ id: "o", frameId: "f", dimension: "district", value: "东区", label: "东区" }],
    facts: [
      { id: "a", frameId: "f", operationId: "op", metricId: "amount", label: "实收", value: 100, unit: "CNY", definition: "销售正金额实收", objectIds: ["o"], limitations: [] },
      { id: "q", frameId: "f", operationId: "op", metricId: "quantity", label: "件数", value: 10, unit: "件", definition: "销售件数", objectIds: ["o"], limitations: [] },
      { id: "avg", frameId: "f", operationId: "derived", metricId: "amount_per_item", label: "件单价", value: 10, unit: "CNY/件", definition: "实收除以件数", objectIds: ["o"], limitations: ["只是结构观察"], derivation: { op: "divide", args: [{ factId: "a" }, { factId: "q" }] } },
      { id: "unused", frameId: "f", operationId: "op", metricId: "rows", label: "行数", value: 500, unit: "条", definition: "行数", objectIds: [], limitations: [] },
    ],
    methods: ["op", "derived"].map((operationId) => ({ id: `m-${operationId}`, operationId, method: "aggregate", status: "completed", frameIds: ["f"], controls: [], checks: [{ name: "汇总", status: "performed", result: "完成" }], sampleRows: 10, groupCount: 1, limitations: ["覆盖已选范围"] })),
  };
}
type Input = Parameters<typeof assembleQaAnswer>[0];
const assemble = (body: string, extra: Partial<Input> = {}) => assembleQaAnswer({ runId: "run", question: "有什么建议", body, charts: new Map(), evidence: evidence(), readFactIds: new Set(["avg"]), operations: [{ id: "r1", op: "aggregate", status: "completed", summary: "查询件单价" }], ...extra });
const markdown = (answer: PlanAnswerV4) => answer.body.flatMap((item) => item.kind === "markdown" ? [item.text] : []).join("\n\n");
const chart = () => {
  const bundle = evidence(); const result: AnalysisOperationResult = { ...bundle, operationId: "op", status: "completed", method: "aggregate", needIds: [], purpose: "查询", limitations: [] };
  return drawQaChart({ id: "c1", input: { resultId: "r1", metric: "amount", by: "district", kind: "bar" }, result, evidence: bundle });
};

test("自由正文数字和提升12%原样保留，长文不被800或1200字截断，引用为空", () => {
  const body = `建议提升12%，另一个未经正文核对的数是9876543。\n\n${"这是完整的业务分析。".repeat(170)}`;
  const answer = assemble(body);
  assert.equal(markdown(answer), body); assert.equal(answer.status, "answered");
  assert.ok(answer.body.every((item) => item.kind !== "markdown" || item.refs.length === 0));
  assert.deepEqual(validatePlanAnswerV4(JSON.parse(JSON.stringify(answer))), answer);
});

test("无图也保留实际已读事实及完整父链、范围、方法和对象，未读无关数据不混入", () => {
  const source = evidence(); const before = structuredClone(source);
  const answer = assemble("件单价可作结构参考。", { evidence: source, readFactIds: (function* () { yield "avg"; })() });
  assert.deepEqual(answer.evidence.facts.map((item) => item.id).sort(), ["a", "avg", "q"]);
  assert.deepEqual(answer.evidence.objects.map((item) => item.id), ["o"]);
  assert.deepEqual(answer.evidence.methods.map((item) => item.operationId).sort(), ["derived", "op"]);
  assert.equal(answer.evidence.frames.length, 1); assert.ok(answer.assumptions.some((item) => item.includes("不能说明因果")));
  assert.deepEqual(answer.review.notes, []); assert.deepEqual(source, before);
  source.facts.push({ ...source.facts.find((item) => item.id === "avg")!, id: "twice", value: 20, derivation: { op: "multiply", args: [{ factId: "avg" }, { constant: 2 }] } });
  const nested = assemble("沿用已读取的计算。", { evidence: source, readFactIds: ["twice"] });
  assert.deepEqual(nested.evidence.facts.map((item) => item.id).sort(), ["a", "avg", "q", "twice"]);
  assert.throws(() => assemble("不能引用不存在的依据。", { readFactIds: ["ghost"] }), /事实依据.*不存在/);
});

test("图占位按独立块组装，补齐图的事实，未知或内联占位移除并标记partial", () => {
  const c = chart();
  const answer = assemble("开头。\n\n[[chart:c1]]\n\n结尾。", { charts: new Map([["c1", c]]), readFactIds: [] });
  assert.deepEqual(answer.body.map((item) => item.kind), ["markdown", "chart", "markdown"]);
  assert.ok(answer.evidence.facts.some((item) => item.id === "a"));
  assert.equal(answer.status, "answered");
  const unknown = assemble("保留正文。\n\n[[chart:missing]]");
  assert.equal(unknown.status, "partial"); assert.doesNotMatch(markdown(unknown), /\[\[chart:/);
  assert.match(unknown.assumptions.join(""), /missing.*不存在|未生成.*missing|图表.*missing/);
  assert.deepEqual(unknown.review.notes, []);
  const inline = assemble("正文[[chart:c1]]仍然保留。", { charts: new Map([["c1", c]]) });
  assert.equal(inline.status, "partial"); assert.equal(inline.body.some((item) => item.kind === "chart"), false);
});

test("纯Markdown表格保留空单元格与转义竖线，前后正文不丢失，不执行HTML", () => {
  const body = "表前正文。\n\n| 区域 | 数值 | 备注 |\n| :--- | ---: | :---: |\n| 东\\|区 | 12% | |\n| | 0 | <script>globalThis.qaInjected = true</script> |\n\n表后正文。";
  const answer = assemble(body);
  assert.deepEqual(answer.body.map((item) => item.kind), ["markdown", "table", "markdown"]);
  const table = answer.body[1]; assert.equal(table.kind, "table"); if (table.kind !== "table") return;
  assert.deepEqual(table.columns, ["区域", "数值", "备注"]);
  assert.deepEqual(table.rows.map((item) => item.cells), [["东|区", "12%", ""], ["", "0", "<script>globalThis.qaInjected = true</script>"]]);
  assert.ok(table.rows.every((item) => item.factIds.length === 0));
  assert.equal(markdown(answer), "表前正文。\n\n表后正文。");
  assert.equal((globalThis as Record<string, unknown>).qaInjected, undefined);
});

test("P2表格按格清洗身份，带厂商说明的实收行及其他数值行均保留", () => {
  const answer = assemble("我是Claude，由Anthropic提供。\n\n表前正文。\n\n| 指标 | 数值 | 说明 |\n| --- | --- | --- |\n| 实收 | 112元 | 由Claude生成 |\n| 件数 | 7件 | 真实成交 |\n\n表后正文。");
  assert.equal(answer.status, "answered");
  const table = answer.body.find((block) => block.kind === "table"); assert.ok(table);
  assert.deepEqual(table.columns, ["指标", "数值", "说明"]);
  assert.deepEqual(table.rows.map((row) => row.cells), [["实收", "112元", ""], ["件数", "7件", "真实成交"]]);
  assert.equal(markdown(answer), "表前正文。\n\n表后正文。");
  assert.doesNotMatch(JSON.stringify(answer.body), /Claude|Anthropic|我是小福/);
  assert.equal(removeUnderlyingIdentity("我是Claude，由Anthropic提供。"), "");
});

test("P2表格说明格内分句清洗保留真实提升12%与结构，空格和转义竖线不丢", () => {
  for (const outerPipes of [true, false]) {
    const lines = ["指标 | 数值 | 说明", "--- | --- | ---", "实收 | 112元 | 由Claude提供；真实提升12%。", "件数 | 7件 | ", "东\\|区 | | 已确认"];
    const body = lines.map((line) => outerPipes ? `| ${line} |` : `${line} |`).join("\n");
    const answer = assemble(body);
    assert.equal(answer.status, "answered");
    const table = answer.body[0]; assert.equal(table.kind, "table"); if (table.kind !== "table") return;
    assert.deepEqual(table.columns, ["指标", "数值", "说明"]);
    assert.deepEqual(table.rows.map((row) => row.cells), [["实收", "112元", "真实提升12%。"], ["件数", "7件", ""], ["东|区", "", "已确认"]]);
    assert.doesNotMatch(JSON.stringify(answer.body), /Claude|我是小福/);
  }
});

test("非表格分隔线、代码围栏里的表格和图占位保持普通Markdown", () => {
  const body = "段落 | 仍是正文\n不是表头分隔线\n\n```markdown\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |\n[[chart:c1]]\n```";
  const answer = assemble(body, { charts: new Map([["c1", chart()]]) });
  assert.deepEqual(answer.body.map((item) => item.kind), ["markdown"]);
  assert.equal(markdown(answer), body); assert.equal(answer.status, "answered");
});

test("表格内无效图占位标partial，转义及行内代码中的占位保持字面内容", () => {
  const table = assemble("| 项目 | 说明 |\n| --- | --- |\n| 实收 | [[chart:ghost]]另补图 |\n\n表后正文。");
  assert.equal(table.status, "partial");
  const block = table.body[0]; assert.equal(block.kind, "table");
  if (block.kind === "table") assert.equal(block.rows[0].cells[1], "另补图");
  const literal = "示例 `[[chart:c1]]` 与 \\[[chart:ghost]] 都是字面内容。";
  const answer = assemble(literal, { charts: new Map([["c1", chart()]]) });
  assert.equal(markdown(answer), literal); assert.equal(answer.status, "answered");
});

test("身份清洗无固定自我介绍和长度/涨幅副作用，活动旧行为保持原样", () => {
  const body = "我是 Claude，由 Anthropic 提供。\n真实提升12%。\n\n" + "分析正文。".repeat(250);
  const cleaned = removeUnderlyingIdentity(body);
  assert.doesNotMatch(cleaned, /Claude|Anthropic|我是小福/); assert.match(cleaned, /提升12%/);
  assert.ok(cleaned.endsWith("分析正文。".repeat(250)));
  assert.equal(removeUnderlyingIdentity("I am ChatGPT. Powered by OpenAI.\n建议保持观察。"), "建议保持观察。");
  assert.equal(removeUnderlyingIdentity("请用 cursor 继续读取结果。真实提升12%。"), "请用 cursor 继续读取结果。真实提升12%。");
  assert.equal(markdown(assemble(body)), cleaned);
  assert.doesNotMatch(sanitizeAgentReply("实收提升12%。保留活动建议。"), /提升12%/);
});

test("空正文、全身份泄漏、仅无效图占位抛中文可修正错误，不返回固定兜底", () => {
  for (const body of ["", "   \n", "我是Claude，由Anthropic提供。", "[[chart:ghost]]"]) assert.throws(() => assemble(body), /正文.*(?:空|有效|重写|补充)/);
  assert.equal(removeUnderlyingIdentity("我是Claude，由Anthropic提供。"), "");
});

test("表格清洗与超容量都明确反馈，不静默截断200行、50表、12图、20000字", () => {
  const table = (rows: number) => "| 指标 | 说明 |\n| --- | --- |\n" + Array.from({ length: rows }, (_, at) => `| ${at} | 实收 |`).join("\n");
  assert.doesNotThrow(() => assemble("字".repeat(20000)));
  assert.throws(() => assemble("字".repeat(20001)), /20000/);
  assert.doesNotThrow(() => assemble(table(200)));
  assert.throws(() => assemble(table(201)), /200.*行/);
  assert.doesNotThrow(() => assemble(Array.from({ length: 50 }, () => table(1)).join("\n\n")));
  assert.throws(() => assemble(Array.from({ length: 51 }, () => table(1)).join("\n\n")), /50/);
  const charts = new Map<string, ResolvedVisualization>(Array.from({ length: 13 }, (_, at) => [`c${at}`, { ...chart(), id: `c${at}` }]));
  const body = (count: number) => Array.from({ length: count }, (_, at) => `[[chart:c${at}]]`).join("\n\n");
  assert.doesNotThrow(() => assemble(body(12), { charts }));
  assert.throws(() => assemble(body(13), { charts }), /12/);
});

test("实际失败与unsupported操作标partial并保留局限，后续修正成功仍可提交有效答案", () => {
  const operations = [{ id: "bad", op: "compare", status: "unsupported", summary: "缺少共同范围" }, { id: "ok", op: "aggregate", status: "completed", summary: "查询实际实收" }];
  const answer = assemble("按实际实收回答。", { operations });
  assert.equal(answer.status, "partial"); assert.deepEqual(answer.plan, operations);
  assert.match(answer.assumptions.join(""), /缺少共同范围/); assert.deepEqual(answer.review.notes, []);
});

test("真实口径、假设和能力定义随已读结果汇总，不将假设包装为历史观察", () => {
  const source = evidence(); source.facts.find((item) => item.id === "avg")!.assumption = { reason: "组合固定的显式假设" };
  const capabilities = { metrics: [{ id: "amount_per_item", label: "件单价", definition: "实收除件数", basis: "assumption" }], dimensionCatalog: [{ id: "district", label: "分区", definition: "真实区域" }], limitations: ["不能识别复购"] } as unknown as AnalysisCapabilities;
  const answer = assemble("这是条件分析。", { evidence: source, capabilities });
  assert.match(answer.assumptions.join(""), /组合固定/); assert.match(answer.assumptions.join(""), /口径待确认.*件单价/);
  assert.match(answer.definitions.join(""), /真实区域/);
});
