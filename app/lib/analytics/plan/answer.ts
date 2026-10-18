import { validateAnalysisEvidence } from "../analysis-v2-evidence.ts";
import { analysisFactParents } from "../analysis-v2-fact-links.ts";
import { PLAN_ANSWER_SCHEMA } from "../analysis-v2-types.ts";
import type { AnalysisCapabilities, AnalysisEvidence, AnalysisFact, PlanAnswer, PlanAnswerClaim, PlanAnswerFigure } from "../analysis-v2-types.ts";
import { SEMANTIC_DIMENSIONS, type SemanticDimensionId } from "../semantic/model.ts";
import { isToolTrace } from "../../tool-trace.ts";
import type { ResolvedVisualization } from "../visualization-types.ts";
import { displayUnit, formatValue } from "./bind.ts";
import type { Binding, BoundClaim } from "./bind.ts";
import type { NodeRow, PlanExecution } from "./execute.ts";
import { DEFAULT_MIN_ROWS, type PlanNode, type PlanScope } from "./types.ts";

const MAX_CLAIMS = 5;
const MAX_ACTIONS = 3;
const MAX_CANNOT = 5;
const MAX_BARS = 8;
const MAX_POINTS = 366;

export type PlanAnswerInput = { runId: string; question: string; execution: PlanExecution; binding: Binding; capabilities: AnalysisCapabilities; droppedNodes: Array<{ id: string; reason: string }>; reviewNotes: string[] };

const unique = (items: string[]) => [...new Set(items)];
const hasDigit = (text: string) => /[0-9０-９]/.test(text);

// ---- 口径与假设 ----
// 本次绑定事实对应的指标与维度定义；依据为 assumption 的单列为「口径待确认」。
function collectDefinitions(bound: BoundClaim[], evidence: AnalysisEvidence, capabilities: AnalysisCapabilities): { definitions: string[]; assumptions: string[] } {
  const facts = new Map(evidence.facts.map((fact) => [fact.id, fact]));
  const objects = new Map(evidence.objects.map((item) => [item.id, item]));
  const metricIds = new Set<string>(); const dimensionIds = new Set<string>();
  for (const claim of bound) for (const id of claim.factIds) {
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

// ---- 无法下结论 ----
function collectCannot(input: PlanAnswerInput): string[] {
  const { binding, droppedNodes } = input;
  // 代码推出的事项排在前面，模型写的放最后，截断时不会把代码事项挤掉。
  const items: string[] = [];
  for (const node of droppedNodes) items.push(`未执行：${node.reason}`);
  const bound = [...(binding.headline ? [binding.headline] : []), ...binding.claims];
  for (const claim of bound) if (claim.confidence === "flipped") items.push(`${claim.rendered} 在剔除检查后方向翻转，不能作为确定结论`);
  for (const claim of bound) if (claim.assert === "unavailable") items.push(claim.rendered);
  // 被丢弃的「不可得」结论：原因是值其实可算或措辞带数字时不呈现，其余用去掉占位符的措辞。
  for (const { claim, reason } of binding.dropped) {
    if (claim.assert !== "unavailable" || /实际可以计算|数字/.test(reason)) continue;
    const text = claim.text.replace(/\{[^}]*\}/g, "该值");
    if (!hasDigit(text)) items.push(text);
  }
  items.push(...binding.cannotConclude);
  return unique(items).slice(0, MAX_CANNOT);
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

// 节点的一句话说明：计划摘要、结论步骤的执行结果和措辞复核共用，模型据此知道每个节点算的是什么范围。
export function summarize(node: PlanNode, capabilities: AnalysisCapabilities): string {
  const metrics = (list: string[]) => list.map((id) => metricLabel(capabilities, id)).join("、");
  const dims = (list: string[]) => list.map((id) => dimensionLabel(capabilities, id)).join("、");
  switch (node.op) {
    case "measure": return `统计 ${scopeLabel(node.scope)} 的 ${metrics(node.metrics)}${node.by?.length ? `，按${dims(node.by)}分组` : ""}`;
    case "contrast": return `对比 ${scopeLabel(node.target, node.reference)} 与 ${scopeLabel(node.reference, node.target)} 的 ${metrics(node.metrics)}`;
    case "decompose": return `拆解 ${node.of} 的变化来源（量与价的贡献）`;
    case "drill": return `沿${dims(node.path)}逐层下钻 ${node.of}`;
    case "scan": return `扫描 ${node.of} 的${node.dimensions?.length ? dims(node.dimensions) : "各个"}维度，找偏离最大的分组`;
    case "robust": return `检查 ${node.of} 的稳健性（${node.checks.map((check) => ({ largest_store: "剔除最大门店", largest_order: "剔除最大订单", halves: "前后两半", alternative_window: "替代窗口" })[check]).join("、")}）`;
    case "scenario": return `情景推演 ${node.of}：${node.reason}`;
  }
}

function planRows(input: PlanAnswerInput): PlanAnswer["plan"] {
  const rows: PlanAnswer["plan"] = [];
  for (const result of input.execution.results.values()) {
    const summary = summarize(result.node, input.capabilities);
    rows.push({ id: result.node.id, op: result.node.op, status: result.status, summary: result.status !== "completed" && result.message ? `${summary}（${result.message}）` : summary });
  }
  for (const node of input.droppedNodes) rows.push({ id: node.id, op: "dropped", status: "dropped", summary: node.reason });
  return rows;
}

// ---- 图表 ----
type Point = { key: string; label: string; fact: AnalysisFact };
type ChartPlan = { kind: "bar" | "line"; title: string; selectionLabel: string; points: Point[] };

const plain = (value: number | null) => value === null ? null : String(Number(value.toFixed(6)));
const keyText = (key: Record<string, string>) => Object.values(key).join(" · ");

// 对比窗口：目标期与参照期。
type ContrastNode = Extract<PlanNode, { op: "contrast" }>;
const windowKey = (node: ContrastNode) => `${periodText(node.target)}|${periodText(node.reference)}`;

// 对比节点的分层描述：对齐方式加窗口。
// 目标期与参照期相同，且同组里还有别的窗口，才算「同窗口」；孤零零的相同期仍按对齐方式叫。
function tierLabel(node: ContrastNode, windows: Set<string>, capabilities: AnalysisCapabilities): string {
  const controls = node.align?.controls ?? []; const common = node.align?.commonStores === true;
  const sameWindow = node.target.period.start === node.reference.period.start && node.target.period.end === node.reference.period.end && [...windows].some((key) => key !== windowKey(node));
  if (controls.includes("store") && controls.includes("day")) return "同店同日";
  if (controls.length) {
    const base = `${common ? "共同门店·" : ""}按${controls.map((id) => dimensionLabel(capabilities, id)).join("×")}`;
    return sameWindow ? `同窗口·${base}` : base;
  }
  if (common) return sameWindow ? "共同门店·同窗口" : "共同门店";
  return sameWindow ? "同窗口" : "全量";
}

const TIER_ORDER = ["全量", "共同门店", "同窗口", "共同门店·同窗口", "同店同日"];
const tierRank = (label: string) => {
  const index = TIER_ORDER.indexOf(label);
  return index >= 0 ? index : label.includes("按") ? TIER_ORDER.length : TIER_ORDER.length + 1;
};

// 依次尝试主结论和各条结论绑定的节点，取第一张能画出来的图；都不行再看计划里有没有下钻、扫描或逐日数据。
function deriveChart(input: PlanAnswerInput, factsById: Map<string, AnalysisFact>): ChartPlan | undefined {
  const bound = [...(input.binding.headline ? [input.binding.headline] : []), ...input.binding.claims];
  const tried = new Set<string>();
  for (const claim of bound) {
    const key = `${claim.node}|${claim.metric}`; if (tried.has(key)) continue; tried.add(key);
    const chart = chartFor(input, factsById, claim.node, claim.metric); if (chart) return chart;
  }
  // 结论没绑到能画图的节点时，用计划里下钻、扫描、逐日的结果；指标取结论里最常用的。
  const metrics = bound.map((claim) => claim.metric);
  for (const result of input.execution.results.values()) {
    if (result.status !== "completed" || !["drill", "scan", "measure"].includes(result.node.op)) continue;
    const metric = metrics.find((id) => result.rows.some((row) => row.metric === id)) ?? result.rows[0]?.metric;
    const chart = metric ? chartFor(input, factsById, result.node.id, metric) : undefined; if (chart) return chart;
  }
  return undefined;
}

function chartFor(input: PlanAnswerInput, factsById: Map<string, AnalysisFact>, nodeId: string, metric: string): ChartPlan | undefined {
  const result = input.execution.results.get(nodeId);
  if (!result || result.status !== "completed") return undefined;
  const { node } = result; const label = metricLabel(input.capabilities, metric);
  const factOf = (row: NodeRow) => factsById.get(row.factId);

  if (node.op === "drill" || node.op === "scan") {
    let rows = result.rows.filter((row) => row.metric === metric && row.role === "deviation" && Object.keys(row.key).length > 0);
    // 下钻只取最深一层，免得父组与子组混在一张图里。
    if (node.op === "drill" && rows.length) { const depth = Math.max(...rows.map((row) => Object.keys(row.key).length)); rows = rows.filter((row) => Object.keys(row.key).length === depth); }
    const minRows = node.minRows ?? DEFAULT_MIN_ROWS;
    const points = rows
      .filter((row) => row.sampleRows !== undefined && row.sampleRows >= minRows)
      .map((row) => ({ row, fact: factOf(row) }))
      .filter((item): item is { row: NodeRow; fact: AnalysisFact } => item.fact !== undefined && item.fact.value !== null)
      .sort((a, b) => Math.abs(b.fact.value!) - Math.abs(a.fact.value!)).slice(0, MAX_BARS)
      .map(({ row, fact }): Point => ({
        key: JSON.stringify(row.key),
        // 扫描跨维度，类别带上维度名区分；下钻直接用取值。
        label: node.op === "scan" && Object.keys(row.key).length === 1 ? `${dimensionLabel(input.capabilities, Object.keys(row.key)[0])}：${keyText(row.key)}` : keyText(row.key), fact,
      }));
    return points.length >= 2 ? { kind: "bar", title: `${label}偏离最大的分组`, selectionLabel: `按偏离幅度取前 ${points.length} 组`, points } : undefined;
  }

  if (node.op === "contrast") {
    const candidates: Array<{ node: ContrastNode; fact: AnalysisFact }> = [];
    for (const item of input.execution.results.values()) {
      if (item.node.op !== "contrast" || item.status !== "completed" || !item.node.metrics.includes(metric)) continue;
      const row = item.rows.find((entry) => entry.metric === metric && entry.role === "change" && Object.keys(entry.key).length === 0);
      const fact = row && factOf(row); if (!fact || fact.value === null) continue;
      candidates.push({ node: item.node, fact });
    }
    const windows = new Set(candidates.map((item) => windowKey(item.node)));
    const seen = new Set<string>(); const tiers: Array<Point & { rank: number }> = [];
    for (const { node: contrastNode, fact } of candidates) {
      const name = tierLabel(contrastNode, windows, input.capabilities);
      if (seen.has(name)) continue; seen.add(name);
      tiers.push({ key: contrastNode.id, label: name, fact, rank: tierRank(name) });
    }
    // 按分层排序，同层保持执行顺序（sort 稳定）。
    const points: Point[] = tiers.sort((a, b) => a.rank - b.rank).map((tier) => ({ key: tier.key, label: tier.label, fact: tier.fact }));
    return points.length >= 3 ? { kind: "bar", title: `${label}变化：不同对齐方式的对比`, selectionLabel: `${points.length} 种对齐方式`, points } : undefined;
  }

  if (node.op === "measure" && node.by?.includes("day")) {
    const points = result.rows
      .filter((row) => row.metric === metric && row.role === "value" && Object.keys(row.key).length === 1 && row.key.day !== undefined)
      .map((row) => ({ row, fact: factOf(row) }))
      .filter((item): item is { row: NodeRow; fact: AnalysisFact } => item.fact !== undefined)
      .sort((a, b) => a.row.key.day.localeCompare(b.row.key.day)).slice(0, MAX_POINTS)
      .map(({ row, fact }): Point => ({ key: row.key.day, label: row.key.day, fact }));
    return points.length >= 2 ? { kind: "line", title: `${label}逐日走势`, selectionLabel: `${points.length} 个日期`, points } : undefined;
  }
  return undefined;
}

function resolveChart(plan: ChartPlan, input: PlanAnswerInput): ResolvedVisualization {
  const { evidence } = input.execution;
  const first = plan.points[0].fact;
  const metricId = first.metricId.split(".")[0];
  const frame = evidence.frames.find((item) => item.id === first.frameId);
  const filters = frame ? Object.values(frame.scope.filters).flat().join("、") : "";
  const period = frame ? `${frame.scope.period.start}至${frame.scope.period.end}` : "";
  const facts = plan.points.map((point) => point.fact);
  const limitations = unique([...(frame?.limitations ?? []), ...facts.flatMap((fact) => fact.limitations)]).slice(0, 5);
  return {
    id: `plan-chart-${input.runId}`, revision: 1, kind: plan.kind, renderer: "native", afterBlockIndex: 0,
    title: plan.title, unit: displayUnit(first.unit), scope: [filters, period].filter(Boolean).join("，"),
    definition: input.capabilities.metrics.find((item) => item.id === metricId)?.definition ?? first.definition,
    limitations, selectionLabel: plan.selectionLabel,
    categories: plan.points.map((point) => ({ key: point.key, label: point.label })),
    series: [{ key: metricId, label: metricLabel(input.capabilities, metricId), values: facts.map((fact) => ({ value: fact.value, exact: plain(fact.value), refIds: [fact.id] })) }],
    sourceIds: unique(facts.map((fact) => fact.operationId)), factIds: unique(facts.map((fact) => fact.id)), objectIds: unique(facts.flatMap((fact) => fact.objectIds)),
  };
}

// ---- 关键数据表 ----
const MAX_FIGURES = 6;
// 从结论绑定的对比节点取总体行：每个指标一行，给目标、参照与变化；没有对比时取单值。
function deriveFigures(input: PlanAnswerInput, factsById: Map<string, AnalysisFact>): PlanAnswer["figures"] {
  const bound = [...(input.binding.headline ? [input.binding.headline] : []), ...input.binding.claims];
  const nodes = [...new Set([...bound.map((claim) => claim.node), ...[...input.execution.results.keys()]])];
  const contrast = nodes.map((id) => input.execution.results.get(id)).find((result) => result?.status === "completed" && result.node.op === "contrast");
  const show = (fact: AnalysisFact | undefined, signed = false) => fact ? formatValue(fact, signed) : undefined;
  const pick = (rows: NodeRow[], metric: string, role: string) => { const row = rows.find((item) => item.metric === metric && item.role === role && !Object.keys(item.key).length); return row ? factsById.get(row.factId) : undefined; };
  if (contrast && contrast.node.op === "contrast") {
    const node = contrast.node;
    const rows: PlanAnswerFigure[] = [];
    for (const metric of node.metrics) {
      const target = pick(contrast.rows, metric, "target"); const reference = pick(contrast.rows, metric, "reference"); const change = pick(contrast.rows, metric, "change");
      if (!target || target.value === null) continue;
      rows.push({ label: metricLabel(input.capabilities, metric), target: show(target)!, ...(reference ? { reference: show(reference) } : {}), ...(change && change.value !== null ? { change: show(change, true) } : {}), factIds: [target, reference, change].filter((fact): fact is AnalysisFact => Boolean(fact)).map((fact) => fact.id) });
      if (rows.length >= MAX_FIGURES) break;
    }
    if (rows.length) return { targetLabel: scopeLabel(node.target, node.reference), referenceLabel: scopeLabel(node.reference, node.target), rows };
  }
  const measure = nodes.map((id) => input.execution.results.get(id)).find((result) => result?.status === "completed" && result.node.op === "measure");
  if (measure && measure.node.op === "measure") {
    const rows: PlanAnswerFigure[] = [];
    for (const metric of measure.node.metrics) { const fact = pick(measure.rows, metric, "value"); if (fact && fact.value !== null) rows.push({ label: metricLabel(input.capabilities, metric), target: show(fact)!, factIds: [fact.id] }); if (rows.length >= MAX_FIGURES) break; }
    if (rows.length) return { targetLabel: scopeLabel(measure.node.scope), rows };
  }
  return undefined;
}

// ---- 兜底主结论 ----
// 模型的主结论和结论都没绑上时，用已算出的第一个对比（或汇总）给一句代码生成的事实陈述，不留空答案。
function fallbackHeadline(input: PlanAnswerInput, factsById: Map<string, AnalysisFact>): PlanAnswerClaim | undefined {
  for (const result of input.execution.results.values()) {
    if (result.status !== "completed") continue;
    const node = result.node;
    if (node.op === "contrast") {
      const metric = node.metrics[0]; const row = (role: string) => result.rows.find((item) => item.metric === metric && item.role === role && !Object.keys(item.key).length);
      const target = row("target"); const reference = row("reference"); const change = row("change");
      const t = target && factsById.get(target.factId); const r = reference && factsById.get(reference.factId); const c = change && factsById.get(change.factId);
      if (!t || !r || t.value === null || r.value === null) continue;
      return { text: `${scopeLabel(node.target, node.reference)}的${metricLabel(input.capabilities, metric)}为 ${formatValue(t, false)}，${scopeLabel(node.reference, node.target)}为 ${formatValue(r, false)}${c && c.value !== null ? `，变化 ${formatValue(c, true)}` : ""}。`, factIds: [t, r, c].filter((fact): fact is AnalysisFact => Boolean(fact)).map((fact) => fact.id), confidence: "unchecked" };
    }
    if (node.op === "measure") {
      const metric = node.metrics[0]; const row = result.rows.find((item) => item.metric === metric && item.role === "value" && !Object.keys(item.key).length);
      const fact = row && factsById.get(row.factId); if (!fact || fact.value === null) continue;
      return { text: `${scopeLabel(node.scope)}的${metricLabel(input.capabilities, metric)}为 ${formatValue(fact, false)}。`, factIds: [fact.id], confidence: "unchecked" };
    }
  }
  return undefined;
}

// ---- 证据裁剪 ----
// 答案只带正文、关键数据表和图表引用的事实，以及推出它们的父事实、对象、范围和方法；
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

// ---- 组装 ----
const toClaim = (claim: BoundClaim): PlanAnswerClaim => ({ text: claim.rendered, factIds: [...claim.factIds], confidence: claim.confidence });

export function assemblePlanAnswer(input: PlanAnswerInput): PlanAnswer {
  const { binding, execution } = input;
  const bound = [...(binding.headline ? [binding.headline] : []), ...binding.claims];
  const { definitions, assumptions } = collectDefinitions(bound, execution.evidence, input.capabilities);
  const factsById = new Map(execution.evidence.facts.map((fact) => [fact.id, fact]));
  const headline = binding.headline ? toClaim(binding.headline) : fallbackHeadline(input, factsById);
  const status: PlanAnswer["status"] = !headline ? "unavailable" : !binding.headline || input.droppedNodes.length || binding.dropped.length ? "partial" : "answered";
  const chartPlan = deriveChart(input, factsById);
  const figures = deriveFigures(input, factsById);
  const chart = chartPlan ? resolveChart(chartPlan, input) : undefined;
  const claims = binding.claims.map(toClaim);
  const evidence = citedEvidence(execution.evidence, [...(headline?.factIds ?? []), ...claims.flatMap((claim) => claim.factIds), ...(figures?.rows ?? []).flatMap((row) => row.factIds), ...(chart?.factIds ?? [])]);
  return {
    schema: PLAN_ANSWER_SCHEMA, runId: input.runId, question: input.question, status,
    ...(headline ? { headline } : {}),
    claims,
    ...(figures ? { figures } : {}),
    actions: binding.actions.map((action) => action.text),
    cannotConclude: collectCannot(input), questions: [...binding.questions],
    assumptions, definitions,
    ...(chart ? { chart } : {}),
    plan: planRows(input), review: { notes: [...input.reviewNotes] }, evidence,
  };
}

// ---- 校验（流解码与会话恢复用）----
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
  return { text: value.text, factIds: ids, confidence: value.confidence };
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
