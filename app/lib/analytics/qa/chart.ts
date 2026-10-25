import { removeUnderlyingIdentity } from "../../agent/reply-stream.ts";
import { ANALYSIS_DIMENSIONS, type AnalysisDimension, type AnalysisEvidence, type AnalysisFact, type AnalysisOperationResult } from "../analysis-v2-types.ts";
import { analysisFactParents } from "../analysis-v2-fact-links.ts";
import { displayUnit } from "../plan/bind.ts";
import { resolveAnalysisVisualization } from "../visualization.ts";
import type { ResolvedVisualization } from "../visualization-types.ts";

export type DrawQaChartInput = { resultId: string; metric: string; kind: "bar" | "line"; by?: string; top?: number; title?: string; frameIds?: string[] };

const unique = (items: string[]) => [...new Set(items)];
function fail(message: string): never { throw new Error(`图表${message}`); }

// 接口不接受数据点；resultId 由调用方在本轮结果表中解析，不能当作 operationId。
function checkInput(input: DrawQaChartInput): void {
  if (!input || Object.keys(input).some((key) => !["resultId", "metric", "kind", "by", "top", "title", "frameIds"].includes(key))) fail("字段不正确，不能传入或覆盖点的数值");
  if (typeof input.resultId !== "string" || !input.resultId.trim()) fail("结果编号不存在，请选择本轮真实结果");
  if (typeof input.metric !== "string" || !input.metric.trim()) fail("需要真实指标 metricId");
  if (input.kind !== "bar" && input.kind !== "line") fail("类型只支持 bar 或 line");
  if (input.by !== undefined && !ANALYSIS_DIMENSIONS.includes(input.by as AnalysisDimension)) fail("分组必须使用真实维度");
  if (input.top !== undefined && (!Number.isSafeInteger(input.top) || input.top < 1 || input.top > 30)) fail("top 必须是 1 至 30 的整数");
  if (input.top !== undefined && input.kind === "line") fail("趋势与情景折线需要完整序列，不能按前列抽点");
  if (input.title !== undefined && typeof input.title !== "string") fail("标题必须是文字");
  if (input.frameIds !== undefined && (!Array.isArray(input.frameIds) || !input.frameIds.length || input.frameIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(input.frameIds).size !== input.frameIds.length)) fail("frameIds 必须是无重复的真实范围编号");
}

// 只接受实际差额公式证明的目标、参照方向，不能按 frames 数组顺序猜测。
function comparisonPairs(result: AnalysisOperationResult, metric: string, facts: AnalysisFact[]): Array<[AnalysisFact, AnalysisFact]> {
  const selected = new Map(facts.map((fact) => [fact.id, fact]));
  const pairs = new Map<string, [AnalysisFact, AnalysisFact]>();
  for (const delta of result.facts) {
    const formula = delta.derivation;
    if (delta.metricId !== `${metric}.delta` || !formula || !("op" in formula) || formula.op !== "subtract" || formula.args.length !== 2) continue;
    const [a, b] = formula.args;
    if (!("factId" in a) || !("factId" in b)) continue;
    const target = selected.get(a.factId), reference = selected.get(b.factId);
    if (!target || !reference || target.frameId === reference.frameId) continue;
    pairs.set(JSON.stringify([target.id, reference.id]), [target, reference]);
  }
  return [...pairs.values()];
}

function comparisonFrames(result: AnalysisOperationResult, metric: string, facts: AnalysisFact[]): [string, string] | undefined {
  const pairs = new Map<string, [string, string]>();
  for (const [target, reference] of comparisonPairs(result, metric, facts)) {
    const pair: [string, string] = [target.frameId, reference.frameId]; pairs.set(JSON.stringify(pair), pair);
  }
  return pairs.size === 1 ? [...pairs.values()][0] : undefined;
}

function publicChart(chart: ResolvedVisualization): ResolvedVisualization {
  const clean = removeUnderlyingIdentity;
  return {
    ...chart, title: clean(chart.title), unit: clean(displayUnit(chart.unit)), scope: clean(chart.scope), definition: clean(chart.definition), selectionLabel: clean(chart.selectionLabel),
    limitations: unique(chart.limitations.map(clean).filter(Boolean)),
    categories: chart.categories.map((item) => ({ ...item, label: clean(item.label) })),
    series: chart.series.map((item) => ({ ...item, label: clean(item.label), values: item.values.map((point) => ({ ...point, refIds: [...point.refIds] })) })),
    ...(chart.xAxis ? { xAxis: { ...chart.xAxis, label: clean(chart.xAxis.label), unit: clean(chart.xAxis.unit) } } : {}),
  };
}

export function drawQaChart({ id, input, result, evidence }: { id: string; input: DrawQaChartInput; result: AnalysisOperationResult; evidence: AnalysisEvidence }): ResolvedVisualization {
  checkInput(input);
  if (!result || !Array.isArray(result.facts)) fail(`结果「${input.resultId}」不存在，请使用本轮结果编号`);
  if (result.status !== "completed") fail(`结果「${input.resultId}」未完成或不支持，不能出图`);
  const actual = new Map(evidence.facts.map((fact) => [fact.id, fact]));
  const metricFacts = result.facts.filter((fact) => fact.operationId === result.operationId && fact.metricId === input.metric);
  let facts = metricFacts;
  if (!facts.length) fail(`结果「${input.resultId}」没有真实指标「${input.metric}」或结果为空`);
  if (input.frameIds?.some((frameId) => !facts.some((fact) => fact.frameId === frameId))) fail("frameIds 引用了不存在的指标范围");
  if (input.frameIds) facts = facts.filter((fact) => input.frameIds!.includes(fact.frameId));
  for (const fact of facts) {
    const registered = actual.get(fact.id);
    if (!registered || registered.value !== fact.value || registered.frameId !== fact.frameId || registered.metricId !== fact.metricId || registered.operationId !== fact.operationId) fail("真实结果与已登记证据不一致，请重新读取结果");
  }
  if (input.metric.startsWith("scenario.")) {
    if (!["scenario.revenue_change", "scenario.revenue_after"].includes(input.metric) || input.kind !== "line" || input.by !== undefined) fail("情景只支持完整收入折线和假设数值轴，不能作为日期或分组柱图");
    const keep = new Set(facts.map((fact) => fact.id));
    for (const key of keep) {
      const fact = actual.get(key); if (!fact) fail("情景父引用缺失，请重新读取完整情景结果");
      analysisFactParents(fact).forEach((parent) => keep.add(parent));
    }
    const chart = resolveAnalysisVisualization({ id, revision: 1, kind: "line", renderer: "native", afterBlockIndex: 0, source: { kind: "scenario", operationId: result.operationId, metricId: input.metric as "scenario.revenue_change" | "scenario.revenue_after" }, selection: { mode: "all" } }, { ...evidence, facts: evidence.facts.filter((fact) => keep.has(fact.id)) });
    return publicChart({ ...chart, ...(input.title && removeUnderlyingIdentity(input.title) ? { title: input.title } : {}), sourceIds: unique(chart.factIds.map((key) => actual.get(key)!.operationId)) });
  }
  const objects = new Map(evidence.objects.map((item) => [item.id, item]));
  const dimensions = (fact: AnalysisFact) => fact.objectIds.map((key) => objects.get(key)?.dimension ?? fail("真实分组对象不存在"));
  const availableFrames = unique(facts.map((fact) => fact.frameId));
  let by: AnalysisDimension | "period";
  if (input.by) by = input.by as AnalysisDimension;
  else {
    // 控制层计算也会生成同指标父事实，且可能没有对象。总体只能从真实差额的父引用认定，
    // 不能先按控制对象猜分组，否则会只剩目标分层并悄悄筛掉总体参照。
    const selected = new Set(facts.map((fact) => fact.id));
    const totals = comparisonPairs(result, input.metric, metricFacts).filter((pair) => pair.every((fact) => !fact.objectIds.length) && pair.some((fact) => selected.has(fact.id)));
    if (totals.length > 1) fail("总体比较存在歧义，请用 frameIds 明确选择目标与参照范围");
    if (totals.length === 1) {
      const roots = totals[0].filter((fact) => selected.has(fact.id));
      if (availableFrames.some((frameId) => !roots.some((fact) => fact.frameId === frameId))) fail("总体与其他控制层范围存在歧义，请用 frameIds 明确选择");
      facts = roots; by = "period";
    } else {
      const shapes = unique(facts.filter((fact) => fact.objectIds.length).map((fact) => JSON.stringify(dimensions(fact).sort())));
      if (shapes.length > 1 || shapes.length === 1 && (JSON.parse(shapes[0]) as string[]).length !== 1) fail("分组存在歧义，请用 by 指定真实维度，必要时用 frameIds 选择控制层");
      by = shapes.length ? (JSON.parse(shapes[0]) as AnalysisDimension[])[0] : "period";
    }
  }
  facts = facts.filter((fact) => by === "period" ? fact.objectIds.length === 0 : dimensions(fact).includes(by));
  if (!facts.length) fail(`结果没有按「${by}」分组的真实指标`);
  if (by !== "period" && facts.some((fact) => dimensions(fact).length !== 1)) fail("分类存在额外控制维度，不能投影混加；请明确分组和 frameIds 范围");
  const frames = new Map(evidence.frames.map((frame) => [frame.id, frame]));
  const frameIds = unique(facts.map((fact) => fact.frameId));
  if (availableFrames.some((frameId) => !frameIds.includes(frameId))) fail("所选分组缺少目标或参照范围，不能静默丢弃；请用 frameIds 明确选择");
  const pair = comparisonFrames(result, input.metric, facts);
  if (frameIds.length > 1) {
    const controls = frameIds.map((key) => JSON.stringify([...(frames.get(key)?.controls ?? [])].sort()));
    const roles = unique(facts.map((fact) => JSON.stringify([fact.comparisonRole ?? "", [...(fact.comparisonControls ?? [])].sort()])));
    if (frameIds.length !== 2 || !pair || new Set(controls).size !== 1 || roles.length !== 1) fail("同一指标有多个控制层或范围，请用 frameIds 明确选择，不能混合总体与分层");
    facts.sort((a, b) => pair.indexOf(a.frameId) - pair.indexOf(b.frameId));
  }
  const selected: AnalysisEvidence = { ...evidence, facts };
  let chart: ResolvedVisualization;
  if (by === "period" && pair && frameIds.length === 2) {
    if (input.kind !== "bar") fail("无分组的目标与参照应使用柱图，不能伪装日期趋势");
    const parts = pair.map((frameId) => resolveAnalysisVisualization({ id, revision: 1, kind: "bar", renderer: "native", afterBlockIndex: 0, source: { kind: "analysis", operationId: result.operationId, metricId: input.metric, dimension: "period", frameIds: [frameId] }, selection: { mode: "all" } }, selected));
    const first = frames.get(pair[0])!, second = frames.get(pair[1])!;
    if (first.snapshotId !== second.snapshotId || first.datasetVersion !== second.datasetVersion || first.currency !== second.currency || first.scope.population !== second.scope.population || first.grain !== second.grain || parts[0].unit !== parts[1].unit) fail("目标参照的单位、币种、快照或口径不一致");
    chart = { ...parts[0], title: `${parts[0].series[0].label} · 目标与参照`, categories: [{ key: "comparison", label: parts[0].series[0].label }], series: parts.map((part, at) => ({ ...part.series[0], key: pair[at], label: `${at === 0 ? "目标" : "参照"} · ${part.scope}` })), scope: parts.map((part) => part.scope).join("；"), factIds: unique(parts.flatMap((part) => part.factIds)), objectIds: unique(parts.flatMap((part) => part.objectIds)), limitations: unique(parts.flatMap((part) => part.limitations)) };
  } else {
    chart = resolveAnalysisVisualization({ id, revision: 1, kind: input.kind, renderer: "native", afterBlockIndex: 0, source: { kind: "analysis", operationId: result.operationId, metricId: input.metric, dimension: by, frameIds }, selection: input.top === undefined ? { mode: "all" } : { mode: "top", limit: input.top, ...(pair ? { rankFrameId: pair[0] } : {}) } }, selected);
    if (pair) chart.series = chart.series.map((series) => ({ ...series, label: `${series.key === pair[0] ? "目标" : "参照"} · ${series.label}` }));
  }
  return publicChart({ ...chart, ...(input.title && removeUnderlyingIdentity(input.title) ? { title: input.title } : {}), sourceIds: unique(chart.factIds.map((key) => actual.get(key)!.operationId)) });
}
