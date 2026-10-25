import { validateAnalysisEvidence } from "../analysis-v2-evidence.ts";
import { analysisFactParents } from "../analysis-v2-fact-links.ts";
import { PLAN_ANSWER_SCHEMA, PLAN_ANSWER_V4_SCHEMA } from "../analysis-v2-types.ts";
import type { AnalysisCapabilities, AnalysisEvidence, PlanAnswer, PlanAnswerBlock, PlanAnswerClaim, PlanAnswerFigure, PlanAnswerV4 } from "../analysis-v2-types.ts";
import { SEMANTIC_DIMENSIONS, type SemanticDimensionId } from "../semantic/model.ts";
import { isToolTrace } from "../../tool-trace.ts";
import type { ResolvedVisualization } from "../visualization-types.ts";
import { displayUnit } from "./bind.ts";
import type { PlanExecution } from "./execute.ts";
import { planChart, type ChartLabels, type ChartPlan } from "./chart.ts";
import type { ResolvedBody } from "./refs.ts";
import type { PlanNode, PlanScope } from "./types.ts";

// v3 答案（analysis-answer/v3）只保留校验和纯文本，供旧会话显示；新答案由 assemblePlanAnswerV4 组装。
type PlanContext = { runId: string; execution: PlanExecution; capabilities: AnalysisCapabilities; droppedNodes: Array<{ id: string; reason: string }> };

const unique = (items: string[]) => [...new Set(items)];

// ---- 口径与假设 ----
// 正文引用事实对应的指标与维度定义；依据为 assumption 的单列为「口径待确认」。
function collectDefinitions(factIds: Iterable<string>, evidence: AnalysisEvidence, capabilities: AnalysisCapabilities): { definitions: string[]; assumptions: string[] } {
  const facts = new Map(evidence.facts.map((fact) => [fact.id, fact]));
  const objects = new Map(evidence.objects.map((item) => [item.id, item]));
  const metricIds = new Set<string>(); const dimensionIds = new Set<string>();
  for (const id of factIds) {
    const fact = facts.get(id); if (!fact) continue;
    metricIds.add(fact.metricId.split(".")[0]);
    for (const objectId of fact.objectIds) { const item = objects.get(objectId); if (item) dimensionIds.add(item.dimension); }
  }
  const entries: Array<{ label: string; definition: string; basis?: string }> = [];
  for (const id of metricIds) { const metric = capabilities.metrics.find((item) => item.id === id); if (metric) entries.push(metric); }
  for (const id of dimensionIds) { const dimension = capabilities.dimensionCatalog?.find((item) => item.id === id); if (dimension) entries.push(dimension); }
  const definitions: string[] = []; const assumptions: string[] = [];
  for (const entry of entries) {
    if (entry.basis === "assumption") assumptions.push(`口径待确认：${entry.label}，${entry.definition}`);
    else definitions.push(`${entry.label}：${entry.definition}`);
  }
  return { definitions: unique(definitions), assumptions: unique(assumptions) };
}

// ---- 计划摘要 ----
const metricLabel = (capabilities: AnalysisCapabilities, id: string) => capabilities.metrics.find((item) => item.id === id)?.label ?? id;
const dimensionLabel = (capabilities: AnalysisCapabilities, id: string) => capabilities.dimensionCatalog?.find((item) => item.id === id)?.label ?? SEMANTIC_DIMENSIONS[id as SemanticDimensionId]?.label ?? id;
const periodText = (scope: PlanScope) => `${scope.period.start}至${scope.period.end}`;
const filterText = (scope: PlanScope) => Object.values(scope.filters ?? {}).flat().join("、");
function scopeLabel(scope: PlanScope, other?: PlanScope): string {
  const own = filterText(scope);
  if (own && (!other || own !== filterText(other))) return own;
  return own ? `${own}（${periodText(scope)}）` : periodText(scope);
}

// 节点的一句话说明：计划摘要、正文步骤的执行结果和正文复核共用，模型据此知道每个节点算的是什么范围。
export function summarize(node: PlanNode, capabilities: AnalysisCapabilities): string {
  const metrics = (list: string[]) => list.map((id) => metricLabel(capabilities, id)).join("、");
  const dims = (list: string[]) => list.map((id) => dimensionLabel(capabilities, id)).join("、");
  switch (node.op) {
    case "measure": return `统计 ${scopeLabel(node.scope)} 的 ${metrics(node.metrics)}${node.by?.length ? `，按${dims(node.by)}分组` : ""}`;
    // 写明哪边是目标、哪边是参照：差额和变化都是「目标减参照」，写结论时据此判断哪边更高。
    case "contrast": return `对比 ${metrics(node.metrics)}：目标 ${scopeLabel(node.target, node.reference)}，参照 ${scopeLabel(node.reference, node.target)}（差额、变化 = 目标 − 参照）`;
    case "decompose": return `拆解 ${node.of} 的变化来源（量与价的贡献）`;
    case "drill": return `沿${dims(node.path)}逐层下钻 ${node.of}`;
    case "scan": return `扫描 ${node.of} 的${node.dimensions?.length ? dims(node.dimensions) : "各个"}维度，找偏离最大的分组`;
    case "robust": return `检查 ${node.of} 的稳健性（${node.checks.map((check) => ({ largest_store: "剔除最大门店", largest_order: "剔除最大订单", halves: "前后两半", alternative_window: "替代窗口" })[check]).join("、")}）`;
    case "scenario": return `情景推演 ${node.of}：${node.reason}`;
  }
}

function planRows(input: Pick<PlanContext, "execution" | "capabilities" | "droppedNodes">): PlanAnswer["plan"] {
  const rows: PlanAnswer["plan"] = [];
  for (const result of input.execution.results.values()) {
    const summary = summarize(result.node, input.capabilities);
    rows.push({ id: result.node.id, op: result.node.op, status: result.status, summary: result.status !== "completed" && result.message ? `${summary}（${result.message}）` : summary });
  }
  for (const node of input.droppedNodes) rows.push({ id: node.id, op: "dropped", status: "dropped", summary: node.reason });
  return rows;
}

// ---- 图表 ----
// 图表推导在 chart.ts，v4 组装和正文解析共用；这里只把推导结果转成可显示的图。
type ChartContext = Pick<PlanContext, "runId" | "execution" | "capabilities">;
export const chartLabels = (capabilities: AnalysisCapabilities): ChartLabels => ({ metric: (id) => metricLabel(capabilities, id), dimension: (id) => dimensionLabel(capabilities, id) });
const plain = (value: number | null) => value === null ? null : String(Number(value.toFixed(6)));

// v4 的图直接放在正文块里，位置由块顺序决定，afterBlockIndex 固定为 0。
function resolveChart(plan: ChartPlan, input: ChartContext, id: string): ResolvedVisualization {
  const { evidence } = input.execution;
  const first = plan.points[0].fact;
  const metricId = first.metricId.split(".")[0];
  const frame = evidence.frames.find((item) => item.id === first.frameId);
  const filters = frame ? Object.values(frame.scope.filters).flat().join("、") : "";
  const period = frame ? `${frame.scope.period.start}至${frame.scope.period.end}` : "";
  const facts = plan.points.map((point) => point.fact);
  const limitations = unique([...(frame?.limitations ?? []), ...facts.flatMap((fact) => fact.limitations)]).slice(0, 5);
  return {
    id, revision: 1, kind: plan.kind, renderer: "native", afterBlockIndex: 0,
    title: plan.title, unit: displayUnit(first.unit), scope: [filters, period].filter(Boolean).join("，"),
    definition: input.capabilities.metrics.find((item) => item.id === metricId)?.definition ?? first.definition,
    limitations, selectionLabel: plan.selectionLabel,
    categories: plan.points.map((point) => ({ key: point.key, label: point.label })),
    series: [{ key: metricId, label: metricLabel(input.capabilities, metricId), values: facts.map((fact) => ({ value: fact.value, exact: plain(fact.value), refIds: [fact.id] })) }],
    sourceIds: unique(facts.map((fact) => fact.operationId)), factIds: unique(facts.map((fact) => fact.id)), objectIds: unique(facts.flatMap((fact) => fact.objectIds)),
  };
}

// ---- 证据裁剪 ----
// 答案只带正文、表格和图表引用的事实，以及推出它们的父事实、对象、范围和方法；
// 执行中算过但没用上的分组事实不进答案，免得一次回答带上几千条事实、撑爆会话存储。
function citedEvidence(evidence: AnalysisEvidence, cited: Iterable<string>): AnalysisEvidence {
  const byId = new Map(evidence.facts.map((fact) => [fact.id, fact]));
  const keep = new Set<string>(); const stack = [...cited];
  while (stack.length) {
    const id = stack.pop()!; if (keep.has(id)) continue;
    const fact = byId.get(id); if (!fact) continue;
    keep.add(id); stack.push(...analysisFactParents(fact));
  }
  const facts = evidence.facts.filter((fact) => keep.has(fact.id));
  const operations = new Set(facts.map((fact) => fact.operationId));
  const methods = evidence.methods.filter((method) => operations.has(method.operationId));
  const objectIds = new Set(facts.flatMap((fact) => fact.objectIds));
  const objects = evidence.objects.filter((item) => objectIds.has(item.id));
  const frameIds = new Set([...facts.map((fact) => fact.frameId), ...objects.map((item) => item.frameId), ...methods.flatMap((method) => method.frameIds)]);
  return { ...evidence, frames: evidence.frames.filter((frame) => frameIds.has(frame.id)), objects, methods, facts };
}

// ---- v3 校验（流解码与会话恢复用）----
const MAX_CLAIMS = 5;
const MAX_ACTIONS = 3;
const MAX_CANNOT = 5;
const MAX_FIGURES = 6;
function fail(message: string): never { throw new Error(message); }
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function strings(value: unknown, name: string, max?: number): string[] {
  if (!Array.isArray(value)) fail(`${name}必须是数组`);
  if (max !== undefined && value.length > max) fail(`${name}最多 ${max} 条`);
  if (!value.every((item) => typeof item === "string")) fail(`${name}的每一项必须是文字`);
  return [...value] as string[];
}
function claimOf(value: unknown, name: string, factIds: Set<string>): PlanAnswerClaim {
  if (!isRecord(value)) fail(`${name}格式不正确`);
  if (typeof value.text !== "string") fail(`${name}缺少文字`);
  if (value.confidence !== "kept" && value.confidence !== "flipped" && value.confidence !== "unchecked") fail(`${name}的可信度不正确`);
  const ids = strings(value.factIds, `${name}的事实编号`);
  for (const id of ids) if (!factIds.has(id)) fail(`${name}引用了不存在的事实 ${id}`);
  let keyFigure: PlanAnswerClaim["keyFigure"];
  if (value.keyFigure !== undefined) {
    const figure = value.keyFigure;
    if (!isRecord(figure) || typeof figure.value !== "string" || typeof figure.factId !== "string" || !ids.includes(figure.factId)) fail(`${name}的重点数字格式不正确`);
    keyFigure = { value: figure.value, factId: figure.factId };
  }
  return { text: value.text, factIds: ids, confidence: value.confidence, ...(keyFigure ? { keyFigure } : {}) };
}
function chartOf(value: unknown, factIds: Set<string>): ResolvedVisualization {
  if (!isRecord(value)) fail("图表格式不正确");
  if (value.kind !== "bar" && value.kind !== "line") fail("图表类型不正确");
  for (const field of ["id", "title", "unit", "scope", "definition", "selectionLabel"] as const) if (typeof value[field] !== "string") fail(`图表缺少 ${field}`);
  if (!Array.isArray(value.categories) || !Array.isArray(value.series)) fail("图表缺少类别或系列");
  const ids = strings(value.factIds, "图表的事实编号");
  strings(value.sourceIds, "图表的来源编号"); strings(value.objectIds, "图表的对象编号"); strings(value.limitations, "图表的限制");
  for (const id of ids) if (!factIds.has(id)) fail(`图表引用了不存在的事实 ${id}`);
  for (const series of value.series) {
    if (!isRecord(series) || !Array.isArray(series.values)) fail("图表系列格式不正确");
    for (const point of series.values) {
      if (!isRecord(point) || !(point.value === null || typeof point.value === "number") || !Array.isArray(point.refIds)) fail("图表数据点格式不正确");
      for (const id of strings(point.refIds, "图表数据点的事实编号")) if (!factIds.has(id)) fail(`图表引用了不存在的事实 ${id}`);
    }
  }
  return value as unknown as ResolvedVisualization;
}

function figuresOf(value: unknown, factIds: Set<string>): PlanAnswer["figures"] {
  if (!isRecord(value) || typeof value.targetLabel !== "string" || (value.referenceLabel !== undefined && typeof value.referenceLabel !== "string") || !Array.isArray(value.rows) || value.rows.length > MAX_FIGURES) fail("关键数据格式不正确");
  const rows = value.rows.map((row, index): PlanAnswerFigure => {
    if (!isRecord(row) || typeof row.label !== "string" || typeof row.target !== "string") fail(`关键数据[${index}]格式不正确`);
    for (const field of ["reference", "change", "scope"] as const) if (row[field] !== undefined && typeof row[field] !== "string") fail(`关键数据[${index}]格式不正确`);
    const ids = strings(row.factIds, `关键数据[${index}]的事实编号`);
    for (const id of ids) if (!factIds.has(id)) fail(`关键数据引用了不存在的事实 ${id}`);
    return { label: row.label, target: row.target, ...(row.reference === undefined ? {} : { reference: row.reference as string }), ...(row.change === undefined ? {} : { change: row.change as string }), ...(row.scope === undefined ? {} : { scope: row.scope as string }), factIds: ids };
  });
  return { targetLabel: value.targetLabel, ...(value.referenceLabel === undefined ? {} : { referenceLabel: value.referenceLabel as string }), rows };
}

export function validatePlanAnswer(value: unknown): PlanAnswer {
  if (!isRecord(value)) fail("分析答案格式不正确");
  if (value.schema !== PLAN_ANSWER_SCHEMA) fail("分析答案版本不正确");
  if (typeof value.runId !== "string" || typeof value.question !== "string") fail("分析答案缺少运行编号或问题");
  if (value.status !== "answered" && value.status !== "partial" && value.status !== "unavailable") fail("分析答案状态不正确");
  const evidence = validateAnalysisEvidence(value.evidence);
  const factIds = new Set(evidence.facts.map((fact) => fact.id));
  if (!Array.isArray(value.claims) || value.claims.length > MAX_CLAIMS) fail(`结论最多 ${MAX_CLAIMS} 条`);
  const claims = value.claims.map((item, index) => claimOf(item, `结论[${index}]`, factIds));
  const headline = value.headline === undefined ? undefined : claimOf(value.headline, "主结论", factIds);
  if (value.status === "unavailable" ? headline !== undefined : headline === undefined) fail("分析答案状态与主结论不一致");
  if (!Array.isArray(value.plan) || !value.plan.every((item) => isRecord(item) && ["id", "op", "status", "summary"].every((field) => typeof item[field] === "string"))) fail("计划摘要格式不正确");
  if (!isRecord(value.review)) fail("复核记录格式不正确");
  if (value.trace !== undefined && !isToolTrace(value.trace)) fail("执行过程记录格式不正确");
  return {
    schema: PLAN_ANSWER_SCHEMA, runId: value.runId, question: value.question, status: value.status,
    ...(headline ? { headline } : {}), claims,
    ...(value.figures === undefined ? {} : { figures: figuresOf(value.figures, factIds) }),
    actions: strings(value.actions, "行动建议", MAX_ACTIONS), cannotConclude: strings(value.cannotConclude, "无法下结论的事项", MAX_CANNOT), questions: strings(value.questions, "追问"),
    assumptions: strings(value.assumptions, "待确认口径"), definitions: strings(value.definitions, "口径说明"),
    ...(value.chart === undefined ? {} : { chart: chartOf(value.chart, factIds) }),
    plan: value.plan.map((item) => ({ id: item.id, op: item.op, status: item.status, summary: item.summary })) as PlanAnswer["plan"],
    review: { notes: strings(value.review.notes, "复核备注") }, evidence,
    ...(value.trace === undefined ? {} : { trace: value.trace }),
  };
}

// ---- 纯文本 ----
export function planAnswerText(answer: PlanAnswer): string {
  const blocks: string[] = [];
  if (answer.headline) blocks.push(answer.headline.text);
  if (answer.figures?.rows.length) {
    const header = `指标 | ${answer.figures.targetLabel}${answer.figures.referenceLabel ? ` | ${answer.figures.referenceLabel} | 变化` : ""}`;
    blocks.push([header, ...answer.figures.rows.map((row) => [row.label, row.target, ...(answer.figures!.referenceLabel ? [row.reference ?? "—", row.change ?? "—"] : [])].join(" | "))].join("\n"));
  }
  if (answer.claims.length) blocks.push(answer.claims.map((claim) => `- ${claim.text}`).join("\n"));
  if (answer.actions.length) blocks.push(`建议：\n${answer.actions.map((action) => `- ${action}`).join("\n")}`);
  if (answer.cannotConclude.length) blocks.push(`还不能下结论：\n${answer.cannotConclude.map((item) => `- ${item}`).join("\n")}`);
  if (answer.assumptions.length) blocks.push(answer.assumptions.map((item) => `- ${item}`).join("\n"));
  return blocks.join("\n\n");
}

// ---- v4：自由正文 ----
export type PlanAnswerV4Input = { runId: string; question: string; execution: PlanExecution; body: ResolvedBody; capabilities: AnalysisCapabilities; droppedNodes: Array<{ id: string; reason: string }>; reviewNotes: string[] };

const EMPTY_BODY = "这次没能得出可以直接采用的结论。";
const MAX_V4_BODY = 20000;
const MAX_V4_TABLES = 50;
const MAX_V4_CHARTS = 12;
const MAX_V4_TABLE_ROWS = 200;

export function assemblePlanAnswerV4(input: PlanAnswerV4Input): PlanAnswerV4 {
  const { execution, capabilities } = input;
  // chart 块换成代码推导的图。正文解析已用同一套逻辑预判过，这里仍画不出来时去掉并记进复核备注，不改状态。
  const body: PlanAnswerBlock[] = []; let charts = 0; const notes: string[] = [];
  const labels = chartLabels(capabilities);
  for (const block of input.body.blocks) {
    if (block.kind !== "chart") { body.push(block.kind === "markdown" ? { kind: "markdown", text: block.text, refs: block.refs.map((ref) => ({ ...ref, factIds: [...ref.factIds] })) } : { kind: "table", title: block.title, columns: [...block.columns], rows: block.rows.map((row) => ({ cells: [...row.cells], factIds: [...row.factIds] })) }); continue; }
    const plan = planChart(execution, labels, block.node, block.metric, { ...(block.by ? { by: block.by } : {}), top: block.top });
    if (typeof plan === "string") { notes.push(`图没有画出来：${plan}`); continue; }
    charts += 1;
    body.push({ kind: "chart", chart: resolveChart(plan, input, `plan-chart-${input.runId}-${charts}`) });
  }
  const chartFactIds = body.flatMap((block) => block.kind === "chart" ? block.chart.factIds : []);
  const cited = unique([...input.body.factIds, ...chartFactIds]);
  const { definitions, assumptions } = collectDefinitions(cited, execution.evidence, capabilities);
  const empty = body.length === 0;
  const status: PlanAnswerV4["status"] = empty ? "unavailable" : input.body.issues.length || input.droppedNodes.length ? "partial" : "answered";
  return {
    schema: PLAN_ANSWER_V4_SCHEMA, runId: input.runId, question: input.question, status,
    body: empty ? [{ kind: "markdown", text: EMPTY_BODY, refs: [] }] : body,
    ...(!empty && input.body.keyFigure ? { keyFigure: { ...input.body.keyFigure } } : {}),
    assumptions, definitions,
    plan: planRows(input), review: { notes: [...input.reviewNotes, ...notes] },
    evidence: citedEvidence(execution.evidence, cited),
  };
}

function blockOf(value: unknown, index: number, factIds: Set<string>): PlanAnswerBlock {
  const name = `正文[${index}]`;
  if (!isRecord(value)) fail(`${name}格式不正确`);
  const known = (ids: string[]) => { for (const id of ids) if (!factIds.has(id)) fail(`${name}引用了不存在的事实 ${id}`); return ids; };
  if (value.kind === "markdown") {
    if (typeof value.text !== "string" || !Array.isArray(value.refs)) fail(`${name}格式不正确`);
    const text = value.text;
    const refs = value.refs.map((ref) => {
      if (!isRecord(ref) || !Number.isInteger(ref.start) || !Number.isInteger(ref.end)) fail(`${name}的引用位置格式不正确`);
      const start = ref.start as number; const end = ref.end as number;
      if (start < 0 || end <= start || end > text.length) fail(`${name}的引用位置超出正文范围`);
      return { start, end, factIds: known(strings(ref.factIds, `${name}的事实编号`)) };
    });
    return { kind: "markdown", text, refs };
  }
  if (value.kind === "table") {
    if (typeof value.title !== "string" || !Array.isArray(value.rows)) fail(`${name}格式不正确`);
    if (value.rows.length > MAX_V4_TABLE_ROWS) fail(`${name}最多 ${MAX_V4_TABLE_ROWS} 行`);
    const columns = strings(value.columns, `${name}的列名`);
    const rows = value.rows.map((row, at) => {
      if (!isRecord(row)) fail(`${name}第 ${at + 1} 行格式不正确`);
      const cells = strings(row.cells, `${name}第 ${at + 1} 行`);
      if (cells.length !== columns.length) fail(`${name}第 ${at + 1} 行的单元格数与列数不一致`);
      return { cells, factIds: known(strings(row.factIds, `${name}第 ${at + 1} 行的事实编号`)) };
    });
    return { kind: "table", title: value.title, columns, rows };
  }
  if (value.kind === "chart") return { kind: "chart", chart: chartOf(value.chart, factIds) };
  fail(`${name}的类型不正确`);
}

export function validatePlanAnswerV4(value: unknown): PlanAnswerV4 {
  if (!isRecord(value)) fail("分析答案格式不正确");
  if (value.schema !== PLAN_ANSWER_V4_SCHEMA) fail("分析答案版本不正确");
  if (typeof value.runId !== "string" || typeof value.question !== "string") fail("分析答案缺少运行编号或问题");
  if (value.status !== "answered" && value.status !== "partial" && value.status !== "unavailable") fail("分析答案状态不正确");
  const evidence = validateAnalysisEvidence(value.evidence);
  const factIds = new Set(evidence.facts.map((fact) => fact.id));
  if (!Array.isArray(value.body) || !value.body.length) fail("分析答案缺少正文");
  const body = value.body.map((item, index) => blockOf(item, index, factIds));
  if (body.reduce((sum, block) => sum + (block.kind === "markdown" ? block.text.length : 0), 0) > MAX_V4_BODY) fail(`正文最多 ${MAX_V4_BODY} 个字符`);
  if (body.filter((block) => block.kind === "table").length > MAX_V4_TABLES) fail(`表格最多 ${MAX_V4_TABLES} 个`);
  if (body.filter((block) => block.kind === "chart").length > MAX_V4_CHARTS) fail(`图最多 ${MAX_V4_CHARTS} 个`);
  let keyFigure: PlanAnswerV4["keyFigure"];
  if (value.keyFigure !== undefined) {
    const figure = value.keyFigure;
    if (!isRecord(figure) || typeof figure.value !== "string" || typeof figure.factId !== "string" || !factIds.has(figure.factId)) fail("重点数字格式不正确");
    keyFigure = { value: figure.value, factId: figure.factId };
  }
  if (!Array.isArray(value.plan) || !value.plan.every((item) => isRecord(item) && ["id", "op", "status", "summary"].every((field) => typeof item[field] === "string"))) fail("计划摘要格式不正确");
  if (!isRecord(value.review)) fail("复核记录格式不正确");
  if (value.trace !== undefined && !isToolTrace(value.trace)) fail("执行过程记录格式不正确");
  return {
    schema: PLAN_ANSWER_V4_SCHEMA, runId: value.runId, question: value.question, status: value.status,
    body, ...(keyFigure ? { keyFigure } : {}),
    assumptions: strings(value.assumptions, "待确认口径"), definitions: strings(value.definitions, "口径说明"),
    plan: value.plan.map((item) => ({ id: item.id, op: item.op, status: item.status, summary: item.summary })) as PlanAnswerV4["plan"],
    review: { notes: strings(value.review.notes, "复核备注") }, evidence,
    ...(value.trace === undefined ? {} : { trace: value.trace }),
  };
}

// 复制和历史上下文用：Markdown 原样保留，表格转成「列 | 列」，图只写标题。
export function planAnswerV4Text(answer: PlanAnswerV4): string {
  const blocks = answer.body.map((block) => {
    if (block.kind === "markdown") return block.text;
    if (block.kind === "table") return [block.title, block.columns.join(" | "), ...block.rows.map((row) => row.cells.join(" | "))].join("\n");
    return `图：${block.chart.title}`;
  });
  return blocks.join("\n\n");
}
