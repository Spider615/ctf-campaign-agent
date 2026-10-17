import { ANALYSIS_DIMENSIONS, type AnalysisEvidence, type AnalysisFrame } from "./analysis-v2-types.ts";
import { VISUALIZATION_SCHEMA, VISUALIZATION_LIMITS, type AttachmentCalculation, type ResolvedVisualization, type VisualizationFileSource, type Visualizations, type VisualizationSpec, type VisualizationValue } from "./visualization-types.ts";
import { analysisFactParents } from "./analysis-v2-fact-links.ts";
import { validateAnalysisEvidence } from "./analysis-v2-evidence.ts";

export const visualizationCapability = (value: string | null | undefined) => value === VISUALIZATION_SCHEMA ? VISUALIZATION_SCHEMA : undefined;
function fail(message: string): never { throw new Error(`图表${message}`); }
const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
function object(value: unknown, keys: string[]): Record<string, unknown> { if (!record(value) || Object.keys(value).some((key) => !keys.includes(key))) fail("字段不正确，不能覆盖证据或增加可执行内容"); return value as Record<string, unknown>; }
function text(value: unknown, max = 120): string { return typeof value === "string" && value.trim() && value.length <= max ? value : fail("引用不正确"); }
function integer(value: unknown, min: number, max: number): number { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : fail("数量或位置不正确"); }
function ids(value: unknown, max = 2000): string[] { if (!Array.isArray(value) || !value.length || value.length > max) fail("引用集合不正确"); const result = (value as unknown[]).map((v) => text(v)); if (new Set(result).size !== result.length) fail("引用重复"); return result; }
const dimensionLabels: Record<string, string> = { store: "门店", region: "大区", district: "分区", category: "货类", material: "材料", offer: "活动", memberFlag: "会员标识", storeType: "门店类型", cityTier: "城市层级", mallGroup: "商场", day: "日期", sku: "货品", memberSegment: "会员分组", period: "周期" };
const metricLabels: Record<string, string> = { amount: "销售金额", quantity: "销售件数", grams: "销售克重", profit: "源字段零售毛利", orders: "当前筛选内订单数", stores: "观察门店数", rows: "记录数", tag_amount: "牌价金额", amount_per_order: "当前筛选内每单金额", amount_per_gram: "每克实收", gap_per_gram: "每克牌价与实收差额" };
const populationLabels: Record<string, string> = { sales: "销售正金额行", net: "销售与退货净额", recovery: "回收抵扣候选", returns: "退货", zero_sales: "零元销售", unknown: "口径待确认" };
const additive = new Set(["amount", "quantity", "grams", "profit", "rows", "tag_amount"]);
function realDate(value: string): boolean { const time = Date.parse(`${value}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value; }
// 表头里的单位后缀不进图标题：「扣营销费贡献_元」显示成「扣营销费贡献」。
const readableColumn = (name: string) => name.replace(/[_（(](?:含税|不含税)?(?:元|g|克|件|%|％)[）)]?$/, "").replace(/_去重$/, "").replace(/_/g, "");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => record(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export function parseVisualizationSpec(value: unknown): VisualizationSpec {
  const item = object(value, ["id", "revision", "kind", "renderer", "afterBlockIndex", "source", "selection", "conclusionId", "title"]);
  if (!["bar", "line", "stacked_bar"].includes(String(item.kind)) || !["native", "html"].includes(String(item.renderer))) fail("图形或渲染方式不支持");
  const raw = record(item.source) ? item.source : fail("来源不正确"); let source: VisualizationSpec["source"];
  if (raw.kind === "analysis") {
    object(raw, ["kind", "operationId", "metricId", "dimension", "seriesDimension", "frameIds"]);
    if (![...ANALYSIS_DIMENSIONS, "period"].includes(raw.dimension as never) || raw.seriesDimension !== undefined && !ANALYSIS_DIMENSIONS.includes(raw.seriesDimension as never)) fail("分组维度不支持");
    source = { kind: "analysis", operationId: text(raw.operationId), metricId: text(raw.metricId), dimension: raw.dimension as "period", ...(raw.seriesDimension === undefined ? {} : { seriesDimension: raw.seriesDimension as typeof ANALYSIS_DIMENSIONS[number] }), ...(raw.frameIds === undefined ? {} : { frameIds: ids(raw.frameIds, 4) }) };
  } else if (raw.kind === "scenario") {
    object(raw, ["kind", "operationId", "metricId"]);
    if (!["scenario.revenue_change", "scenario.revenue_after"].includes(String(raw.metricId))) fail("情景指标不支持");
    source = { kind: "scenario", operationId: text(raw.operationId), metricId: raw.metricId as "scenario.revenue_change" | "scenario.revenue_after" };
  } else if (raw.kind === "attachment") {
    object(raw, ["kind", "calculationIds", "dimensionIndex", "seriesIndex"]);
    source = { kind: "attachment", calculationIds: ids(raw.calculationIds, 4), ...(raw.dimensionIndex === undefined ? {} : { dimensionIndex: integer(raw.dimensionIndex, 0, 2) }), ...(raw.seriesIndex === undefined ? {} : { seriesIndex: integer(raw.seriesIndex, 0, 2) }) };
  } else fail("来源类型不支持");
  const selection = object(item.selection, ["mode", "limit", "rankFrameId", "ids"]); let selected: VisualizationSpec["selection"];
  if (selection.mode === "all" && Object.keys(selection).length === 1) selected = { mode: "all" };
  else if (selection.mode === "top" && selection.ids === undefined) selected = { mode: "top", limit: integer(selection.limit, 1, VISUALIZATION_LIMITS.categories), ...(selection.rankFrameId === undefined ? {} : { rankFrameId: text(selection.rankFrameId) }) };
  else if (selection.mode === "selected" && selection.limit === undefined && selection.rankFrameId === undefined) selected = { mode: "selected", ids: ids(selection.ids, 120) };
  else fail("选择规则不正确");
  return { id: text(item.id), revision: integer(item.revision, 1, 10000), kind: item.kind as VisualizationSpec["kind"], renderer: item.renderer as VisualizationSpec["renderer"], afterBlockIndex: integer(item.afterBlockIndex, 0, 79), source: source!, selection: selected!, ...(item.conclusionId === undefined ? {} : { conclusionId: text(item.conclusionId) }), ...(item.title === undefined ? {} : { title: text(item.title, 40) }) };
}

export function parseVisualizations(value: unknown, blockCount: number): Visualizations | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, ["schema", "items"]);
  if (raw.schema !== VISUALIZATION_SCHEMA || !Array.isArray(raw.items) || raw.items.length > VISUALIZATION_LIMITS.charts) fail("版本或图表数量不支持");
  const items = raw.items.map(parseVisualizationSpec);
  if (new Set(items.map((item) => item.id)).size !== items.length || items.some((item) => item.afterBlockIndex >= blockCount)) fail("编号重复或正文位置不存在");
  return { schema: VISUALIZATION_SCHEMA, items };
}

type Entry = { category: string; categoryLabel: string; numericValue?: number; series: string; seriesLabel: string; value: VisualizationValue; objectIds: string[] };
function compareExactDecimal(left: string, right: string): number {
  const [leftWhole, leftFraction = ""] = left.split("."); const [rightWhole, rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const a = BigInt(leftWhole + leftFraction.padEnd(scale, "0")); const b = BigInt(rightWhole + rightFraction.padEnd(scale, "0"));
  return a < b ? -1 : a > b ? 1 : 0;
}
function attachmentDateKey(value: string, monthly: boolean): string {
  const candidate = monthly && /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value;
  const matched = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.0{1,6})?(?:Z|[+-]00:00)?)?$/.exec(candidate);
  if (!matched || !realDate(matched[1])) fail("趋势必须使用真实日期，不能把非零点时间或文字当作日期");
  return monthly ? matched[1].slice(0, 7) + "-01" : matched[1];
}
function fillDateGaps(entries: Entry[], startDate: string, endDate: string, monthly = false): void {
  if (!realDate(startDate) || !realDate(endDate) || entries.some((entry) => !realDate(entry.category))) fail("趋势必须使用真实日期");
  const start = Date.parse(`${startDate}T00:00:00Z`), end = Date.parse(`${endDate}T00:00:00Z`);
  const points = monthly ? (Number(endDate.slice(0, 4)) - Number(startDate.slice(0, 4))) * 12 + Number(endDate.slice(5, 7)) - Number(startDate.slice(5, 7)) + 1 : (end - start) / 86400000 + 1;
  if (points > VISUALIZATION_LIMITS.timePoints) fail("时间范围超过趋势展示上限，请选择明确周期或数据表");
  const observed = new Set(entries.map((entry) => `${entry.series}\u0000${entry.category}`));
  const series = new Map(entries.map((entry) => [entry.series, entry.seriesLabel]));
  const next = (time: number) => { if (!monthly) return time + 86400000; const date = new Date(time); date.setUTCMonth(date.getUTCMonth() + 1); return date.getTime(); };
  for (let time = start; time <= end; time = next(time)) for (const [key, label] of series) {
    const day = new Date(time).toISOString().slice(0, 10);
    if (!observed.has(`${key}\u0000${day}`)) entries.push({ category: day, categoryLabel: monthly ? day.slice(0, 7) : day, series: key, seriesLabel: label, value: { value: null, exact: null, refIds: [] }, objectIds: [] });
  }
}
function assemble(spec: VisualizationSpec, entries: Entry[], base: Omit<ResolvedVisualization, "categories" | "series" | "selectionLabel">): ResolvedVisualization {
  const categories = new Map<string, ResolvedVisualization["categories"][number]>(); const series = new Map<string, { key: string; label: string; values: Map<string, VisualizationValue> }>();
  for (const entry of entries) {
    categories.set(entry.category, { key: entry.category, label: entry.categoryLabel, ...(entry.numericValue === undefined ? {} : { numericValue: entry.numericValue }) });
    if (!series.has(entry.series)) series.set(entry.series, { key: entry.series, label: entry.seriesLabel, values: new Map() });
    const values = series.get(entry.series)!.values;
    if (values.has(entry.category)) fail("分类值重复，当前分组存在歧义；请使用明确的分组或系列维度");
    values.set(entry.category, entry.value);
  }
  if (!categories.size || series.size > VISUALIZATION_LIMITS.series) fail("没有可展示的分组或系列超过四个");
  let selected = [...categories.values()]; const total = selected.length;
  if (spec.kind === "line") {
    if (base.xAxis?.kind === "number") {
      if (selected.some((item) => item.numericValue === undefined || !Number.isFinite(item.numericValue))) fail("情景横轴必须来自真实假设参数");
      selected.sort((a, b) => a.numericValue! - b.numericValue!);
    } else {
      if (selected.some((item) => !item.key.split("/").every(realDate))) fail("趋势必须使用真实时间或日期");
      selected.sort((a, b) => a.key.localeCompare(b.key));
    }
    if (spec.selection.mode !== "all") fail("趋势不能用前列或候选抽点代替完整时间序列");
  } else if (spec.selection.mode === "top" || spec.kind === "bar" && series.size === 1 && spec.selection.mode === "all") {
    const rankId = spec.selection.mode === "top" ? spec.selection.rankFrameId : undefined;
    const ranking = rankId ? [...series.values()].find((item) => item.key === rankId) : series.size === 1 ? [...series.values()][0] : undefined;
    if (!ranking) fail("多系列前列选择需要明确排名序列");
    selected.sort((a, b) => {
      const left = ranking.values.get(a.key), right = ranking.values.get(b.key);
      if (left?.value === undefined || left.value === null) return right?.value === undefined || right.value === null ? a.key.localeCompare(b.key) : 1;
      if (right?.value === undefined || right.value === null) return -1;
      const order = spec.source.kind === "attachment" ? compareExactDecimal(right.exact!, left.exact!) : right.value - left.value;
      return order || a.key.localeCompare(b.key);
    });
    if (spec.selection.mode === "top") selected = selected.slice(0, spec.selection.limit);
  } else if (spec.selection.mode === "selected") {
    const requested = spec.selection.ids;
    if (requested.some((id) => !entries.some((entry) => entry.objectIds.includes(id) || entry.value.refIds.includes(id)))) fail("候选引用不存在");
    const keys = new Set(entries.filter((entry) => requested.some((id) => entry.objectIds.includes(id) || entry.value.refIds.includes(id))).map((entry) => entry.category));
    selected = selected.filter((item) => keys.has(item.key));
  }
  if (selected.length > (spec.kind === "line" ? VISUALIZATION_LIMITS.timePoints : VISUALIZATION_LIMITS.categories)) fail("展示分组过多，请明确前列范围或使用数据表；完整证据仍保留");
  if (spec.kind === "stacked_bar" && spec.selection.mode !== "all") fail("堆叠需要完整可加总构成，不能使用候选子集");
  return { ...base, categories: selected, series: [...series.values()].map((item) => ({ key: item.key, label: item.label, values: selected.map((category) => item.values.get(category.key) ?? { value: null, exact: null, refIds: [] }) })), selectionLabel: spec.selection.mode === "all" ? `全部 ${total} 组` : spec.selection.mode === "top" ? `按指定序列数值降序，展示前 ${selected.length} 组，共 ${total} 组；未提供值排末` : `选定候选 ${selected.length} 组，共 ${total} 组，非总体排名` };
}
const frameScope = (frame: AnalysisFrame) => `${frame.scope.period.start} 至 ${frame.scope.period.end} · ${populationLabels[frame.scope.population]}${Object.entries(frame.scope.filters).length ? ` · ${Object.values(frame.scope.filters).flat().join("、")}` : ""}`;
function exact(value: number | null): string | null { if (value === null) return null; if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) fail("数值超过可靠绘图范围"); return String(Object.is(value, -0) ? 0 : value); }

export function resolveAnalysisVisualization(input: VisualizationSpec, evidence: AnalysisEvidence): ResolvedVisualization {
  const spec = parseVisualizationSpec(input);
  if (spec.source.kind === "scenario") return resolveScenarioVisualization(spec, evidence);
  if (spec.source.kind !== "analysis") fail("来源不是经营分析"); const source = spec.source as Extract<VisualizationSpec["source"], { kind: "analysis" }>;
  const methods = evidence.methods.filter((item) => item.operationId === source.operationId && item.status === "completed");
  if (!methods.length) fail("操作来源不存在或未完成");
  const facts = evidence.facts.filter((fact) => fact.operationId === source.operationId && fact.metricId === source.metricId && (!source.frameIds || source.frameIds.includes(fact.frameId)));
  if (!facts.length) fail("操作没有这个真实指标");
  if (source.frameIds?.some((id) => !facts.some((fact) => fact.frameId === id))) fail("范围引用不存在");
  const frames = new Map(evidence.frames.map((frame) => [frame.id, frame])); const objects = new Map(evidence.objects.map((item) => [item.id, item]));
  const selectedFrames = [...new Set(facts.map((fact) => fact.frameId))].map((id) => frames.get(id) ?? fail("数据范围不存在"));
  const first = selectedFrames[0];
  if (new Set(facts.map((fact) => fact.unit)).size !== 1 || selectedFrames.some((frame) => frame.currency !== first.currency || frame.snapshotId !== first.snapshotId || frame.datasetVersion !== first.datasetVersion || frame.scope.population !== first.scope.population || frame.grain !== first.grain || frame.scope.population === "unknown")) fail("单位、币种、快照或口径不一致");
  const samePeriod = new Set(selectedFrames.map((frame) => canonical(frame.scope.period))).size === 1;
  const metricName = source.metricId === "amount" ? ({ net: "净销售金额", returns: "退货金额", recovery: "回收抵扣候选金额", zero_sales: "零元销售金额", sales: "销售金额", unknown: "金额" })[first.scope.population] : metricLabels[source.metricId] ?? facts[0].label;
  if (source.seriesDimension === source.dimension) fail("分类与系列必须使用不同维度，不能把自身作为堆叠构成");
  if (source.dimension !== "period" && selectedFrames.length > 1 && !methods.some((method) => ["compare", "scan", "robustness"].includes(method.method))) fail("跨范围比较缺少实际比较操作");
  if (spec.kind === "line" && !["day", "period"].includes(source.dimension)) fail("趋势必须使用时间或日期维度");
  if (spec.kind === "stacked_bar" && (!additive.has(source.metricId) || !source.seriesDimension || methods.some((method) => method.method !== "aggregate") || selectedFrames.length !== 1)) fail("堆叠需要同一范围内完整可加总分组与系列");
  if (spec.kind === "stacked_bar" && facts.some((fact) => fact.derivation)) fail("派生值不能自动当作可加总构成");
  if (spec.kind === "stacked_bar" && methods.reduce((sum, method) => sum + method.groupCount, 0) !== facts.length) fail("堆叠遗漏实际分组，不能作为完整构成");
  const entries = facts.map((fact): Entry => {
    if (!methods.some((method) => method.frameIds.includes(fact.frameId))) fail("事实与操作范围不匹配");
    const refs = fact.objectIds.map((id) => objects.get(id) ?? fail("对象引用不存在"));
    if (refs.some((item) => item.frameId !== fact.frameId)) fail("对象与事实范围不一致");
    const category = refs.filter((item) => item.dimension === source.dimension);
    const split = source.seriesDimension ? refs.filter((item) => item.dimension === source.seriesDimension) : [];
    if (source.dimension !== "period" && category.length !== 1 || source.seriesDimension && split.length !== 1) fail("分类维度存在歧义或缺失");
    const frame = frames.get(fact.frameId)!; const period = `${frame.scope.period.start}/${frame.scope.period.end}`;
    if (source.dimension === "day" && (!realDate(category[0].value) || category[0].value < frame.scope.period.start || category[0].value > frame.scope.period.end)) fail("日期不存在或超出实际范围");
    return { category: source.dimension === "period" ? period : category[0].value, categoryLabel: source.dimension === "period" ? `${frame.scope.period.start} 至 ${frame.scope.period.end}` : category[0].label, series: source.dimension === "period" && !split.length ? "metric" : `${frame.id}${split.length ? `:${split[0].value}` : ""}`, seriesLabel: split.length ? split[0].label : selectedFrames.length === 1 || source.dimension === "period" ? metricName : `${frame.scope.period.start} 至 ${frame.scope.period.end}${samePeriod ? ` · ${Object.values(frame.scope.filters).flat().join("、") || (frame.id === first.id ? "目标范围" : "参照范围")}` : ""}`, value: { value: fact.value, exact: exact(fact.value), refIds: [fact.id] }, objectIds: fact.objectIds };
  });
  if (spec.kind === "line" && source.dimension === "day") {
    const starts = selectedFrames.map((frame) => frame.scope.period.start).sort(), ends = selectedFrames.map((frame) => frame.scope.period.end).sort();
    fillDateGaps(entries, starts[0], ends.at(-1)!);
  }
  const usedObjects = [...new Set(facts.flatMap((fact) => fact.objectIds))];
  return assemble(spec, entries, { id: spec.id, revision: spec.revision, kind: spec.kind, renderer: spec.renderer, afterBlockIndex: spec.afterBlockIndex, title: spec.title ?? `${metricName} · 按${dimensionLabels[source.dimension]}`, unit: facts[0].unit.replace(/^CNY/, "元"), scope: selectedFrames.map(frameScope).join("；"), definition: [...new Set(facts.map((fact) => fact.definition))].join("；"), limitations: [...new Set([...selectedFrames.flatMap((frame) => frame.limitations), ...facts.flatMap((fact) => fact.limitations), ...methods.flatMap((method) => method.limitations), ...(spec.kind === "line" ? ["缺少记录的日期保留为空点，不代表零销售或完整观测"] : [])])], factIds: facts.map((fact) => fact.id), objectIds: usedObjects, sourceIds: [] });
}

function resolveScenarioVisualization(spec: VisualizationSpec, evidence: AnalysisEvidence): ResolvedVisualization {
  if (spec.source.kind !== "scenario" || spec.kind !== "line" || spec.selection.mode !== "all") fail("情景图须使用完整条件折线，不能截取前列或伪装成实际趋势");
  const source = spec.source; const index = new Map(evidence.facts.map((fact) => [fact.id, fact]));
  const points = evidence.facts.filter((fact) => fact.operationId === source.operationId && fact.metricId === source.metricId);
  if (!points.length || points.some((fact) => fact.scenario?.kind !== "revenue")) fail("情景图缺少受控计算的真实来源");
  const ids = new Set(points.map((fact) => fact.id));
  for (const id of ids) { const fact = index.get(id); if (!fact) fail("情景父引用缺失"); analysisFactParents(fact).forEach((key) => ids.add(key)); }
  const selected = evidence.facts.filter((fact) => ids.has(fact.id)); const operations = new Set(selected.map((fact) => fact.operationId)); const frames = new Set(selected.map((fact) => fact.frameId));
  try { validateAnalysisEvidence({ facts: selected, frames: evidence.frames.filter((frame) => frames.has(frame.id)), methods: evidence.methods.filter((method) => operations.has(method.operationId)), objects: evidence.objects.filter((object) => selected.some((fact) => fact.objectIds.includes(object.id))) }); }
  catch (error) { fail(`情景依据未通过核验：${error instanceof Error ? error.message : "引用不一致"}`); }
  const entries: Entry[] = [];
  for (const point of points) {
    const scenario = point.scenario; if (scenario?.kind !== "revenue") fail("情景依赖缺失");
    const rate = index.get(scenario.rateFactId)!; const baseline = index.get(scenario.baselineFactId)!;
    if (rate.value === null || point.value === null) fail("情景结果不能使用缺失横轴或金额");
    const label = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 12, useGrouping: false }).format(rate.value);
    const common = { category: String(rate.value), categoryLabel: `${label}%`, numericValue: rate.value, objectIds: point.objectIds };
    entries.push({ ...common, series: "scenario", seriesLabel: "条件测算", value: { value: point.value, exact: exact(point.value), refIds: [point.id, rate.id] } });
    const unchanged = source.metricId === "scenario.revenue_change" ? 0 : baseline.value;
    entries.push({ ...common, series: "unchanged", seriesLabel: "收入持平参照", value: { value: unchanged, exact: exact(unchanged), refIds: [baseline.id] } });
  }
  const frame = evidence.frames.find((item) => item.id === points[0].frameId)!;
  return assemble(spec, entries, { id: spec.id, revision: spec.revision, kind: spec.kind, renderer: spec.renderer, afterBlockIndex: spec.afterBlockIndex, title: spec.title ?? `条件情景 · ${source.metricId === "scenario.revenue_change" ? "实收变化" : "实收金额"}`, unit: points[0].unit.replace(/^CNY/, "元"), xAxis: { kind: "number", label: "假设净成交量变化", unit: "%" }, scope: frameScope(frame), definition: "在价格、商品和优惠结构固定时，按显式净成交量假设计算；横轴不是日期，曲线不是需求预测", limitations: [...new Set(points.flatMap((point) => point.limitations))], factIds: [...ids], objectIds: [...new Set(selected.flatMap((fact) => fact.objectIds))], sourceIds: [] });
}

export function parseAttachmentCalculations(value: unknown): AttachmentCalculation[] {
  if (!Array.isArray(value) || value.length > 100) fail("文件计算集合不正确");
  return value.map((entry) => {
    const raw = object(entry, ["id", "attachmentId", "version", "tableId", "name", "location", "operation", "column", "groupBy", "unit", "filters", "groupCount", "groups", "warnings"]);
    if (!["sum", "count", "distinct", "average", "min", "max", "ratio", "difference", "change_rate"].includes(String(raw.operation)) || !Array.isArray(raw.groups) || raw.groups.length > 10000 || !Array.isArray(raw.groupBy) || raw.groupBy.length > 3 || !Array.isArray(raw.filters) || raw.filters.length > 12 || !Array.isArray(raw.warnings)) fail("文件计算记录不正确");
    const groups = raw.groups.map((entry) => { const group = object(entry, ["labels", "value", "sourceId", "matchedRows", "missingRows"]); if (!Array.isArray(group.labels) || group.labels.length !== (raw.groupBy as unknown[]).length || group.labels.some((v) => typeof v !== "string" || v.length > 1000) || group.value !== null && (typeof group.value !== "string" || !/^[+-]?\d+(?:\.\d+)?$/.test(group.value))) fail("文件计算分组或精确值不正确"); return { labels: group.labels as string[], value: group.value as string | null, sourceId: text(group.sourceId), matchedRows: integer(group.matchedRows, 0, 200000), missingRows: integer(group.missingRows, 0, 200000) }; });
    if (raw.groupCount !== groups.length) fail("文件计算缺少完整分组，不能把分页当总体");
    const result: AttachmentCalculation = { id: text(raw.id), attachmentId: text(raw.attachmentId), version: text(raw.version), tableId: text(raw.tableId), name: text(raw.name, 255), location: text(raw.location, 600), operation: raw.operation as AttachmentCalculation["operation"], groupBy: (raw.groupBy as unknown[]).map((v) => text(v, 500)), unit: text(raw.unit, 100), filters: raw.filters.map((entry) => { const item = object(entry, ["column", "operator", "value"]); return { column: text(item.column, 500), operator: text(item.operator), value: typeof item.value === "string" && item.value.length <= 500 ? item.value : fail("筛选值不正确") }; }), groupCount: groups.length, groups, warnings: (raw.warnings as unknown[]).map((v) => text(v, 1500)), ...(raw.column === undefined ? {} : { column: text(raw.column, 500) }) };
    return result;
  });
}

export function resolveAttachmentVisualization(input: VisualizationSpec, rawCalculations: AttachmentCalculation[], sources: readonly VisualizationFileSource[]): ResolvedVisualization {
  const spec = parseVisualizationSpec(input); if (spec.source.kind !== "attachment") fail("来源不是文件计算"); const source = spec.source as Extract<VisualizationSpec["source"], { kind: "attachment" }>;
  const calculations = source.calculationIds.map((id) => rawCalculations.find((item) => item.id === id) ?? fail("计算来源不存在")); parseAttachmentCalculations(calculations);
  const first = calculations[0];
  if (calculations.some((item) => item.attachmentId !== first.attachmentId || item.version !== first.version || item.tableId !== first.tableId || item.unit !== first.unit || item.operation !== first.operation || canonical(item.filters) !== canonical(first.filters) || canonical(item.groupBy) !== canonical(first.groupBy) || first.unit === "原表数值，单位未提供" && item.column !== first.column)) fail("文件版本、单位或口径不一致");
  const dimension = source.dimensionIndex ?? 0, seriesIndex = source.seriesIndex;
  if (!first.groupBy.length || calculations.some((item) => !item.groupBy[dimension] || seriesIndex !== undefined && !item.groupBy[seriesIndex])) fail("文件计算没有这个分组维度");
  if (spec.kind === "stacked_bar" && (calculations.length !== 1 || first.operation !== "sum" || seriesIndex === undefined || dimension === seriesIndex)) fail("堆叠需要同一计算内可加总的完整分组");
  if (spec.kind === "stacked_bar" && (!/^(元|CNY|人民币|USD|美元|HKD|港元|克|件)$/.test(first.unit) || !/金额|销售额|实收|收入|费用|成本|利润|毛利|克重|重量|数量|件数|销量/.test(first.column ?? "") || /率|比例|占比|单价|均价|每|平均|指数|倍/.test(first.column ?? ""))) fail("文件指标缺少可加总依据或属于比例、均值，请使用分组柱图");
  const monthly = spec.kind === "line" && /^(月份|年月|月度)$/.test(first.groupBy[dimension].trim());
  let approximateCoordinates = false;
  const entries = calculations.flatMap((calculation) => calculation.groups.map((group): Entry => {
    const ref = sources.find((item) => item.id === group.sourceId);
    if (!ref || ref.attachmentId !== calculation.attachmentId || ref.version !== calculation.version || ref.calculationId !== undefined && ref.calculationId !== calculation.id || ref.calculationId === undefined && group.value !== null && !ref.excerpt.replace(/,/g, "").includes(group.value)) fail("文件版本或数值来源不匹配");
    const numeric = group.value === null ? null : Number(group.value);
    if (numeric !== null && (!Number.isFinite(numeric) || Math.abs(numeric) > Number.MAX_SAFE_INTEGER || numeric === 0 && /[1-9]/.test(group.value!) || compareExactDecimal(group.value!.replace(/^[+-]/, ""), String(Number.MAX_SAFE_INTEGER)) > 0)) fail("文件数值精度超过可靠绘图范围，请使用数据表");
    if (group.value !== null && group.value.replace(/^[+-]?0*|\./g, "").length > 15) approximateCoordinates = true;
    const category = spec.kind === "line" ? attachmentDateKey(group.labels[dimension], monthly) : group.labels[dimension];
    return { category, categoryLabel: monthly ? category.slice(0, 7) : category, series: seriesIndex === undefined ? calculation.id : `${calculation.id}:${group.labels[seriesIndex]}`, seriesLabel: seriesIndex === undefined ? readableColumn(calculation.column ?? "记录数") : group.labels[seriesIndex], value: { value: numeric, exact: group.value, refIds: [group.sourceId] }, objectIds: [] };
  }));
  if (spec.kind === "line" && entries.length) {
    const dates = entries.map((entry) => entry.category).sort(); fillDateGaps(entries, dates[0], dates.at(-1)!, monthly);
  }
  return assemble(spec, entries, { id: spec.id, revision: spec.revision, kind: spec.kind, renderer: spec.renderer, afterBlockIndex: spec.afterBlockIndex, title: spec.title ?? `${readableColumn(first.column ?? "记录数")} · 按${readableColumn(first.groupBy[dimension])}`, unit: first.unit === "比率" ? "%" : first.unit, ...(first.unit === "比率" ? { valueFormat: "percent" as const } : {}), scope: `${first.name} · ${first.location}${first.filters.length ? ` · 筛选：${first.filters.map((f) => `${f.column} ${f.operator} ${f.value}`).join("；")}` : ""}`, definition: `全表确定性${{ sum: "求和", count: "计数", distinct: "去重计数", average: "均值", min: "最小值", max: "最大值", ratio: "比值", difference: "差值", change_rate: "变化率" }[first.operation]}；文件计算不等同于已对数经营口径`, limitations: [...new Set([...calculations.flatMap((item) => item.warnings), ...(calculations.some((item) => item.groups.some((group) => group.missingRows)) ? ["计算包含缺失值，仅覆盖有效值；未补零"] : []), ...(approximateCoordinates ? ["图形位置使用近似值；排序、提示和数据表保留完整精确数值"] : []), ...(spec.kind === "line" ? [monthly ? "实际首尾月份之间的缺失月份保留为空点，不代表零值或完整观测" : "实际首尾日期之间的缺失日期保留为空点，不代表零值或完整观测"] : [])])], factIds: [], objectIds: [], sourceIds: [...new Set(entries.flatMap((entry) => entry.value.refIds))] });
}

export function visualizationText(chart: ResolvedVisualization): string {
  const clean = (value: string) => value.replace(/[\t\r\n]+/g, " ");
  return [chart.title, `${chart.scope} · ${chart.unit} · ${chart.selectionLabel}`, [chart.xAxis ? `${chart.xAxis.label}（${chart.xAxis.unit}）` : "分组", ...chart.series.map((series) => clean(series.label))].join("\t"), ...chart.categories.map((category, index) => [clean(category.label), ...chart.series.map((series) => series.values[index].exact ?? "未提供")].join("\t"))].join("\n");
}
