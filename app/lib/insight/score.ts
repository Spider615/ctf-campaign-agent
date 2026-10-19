// 立方格子 → 图谱：节点事实、连线强度、依据、异常、推荐。纯函数，数字全由这里算，文字用模板拼。
import { draftFor } from "./context.ts";
import { INSIGHT_METRIC_SOURCES, INSIGHT_METRICS, MISSING_METRICS, sumCells } from "./metrics.ts";
import { DECOMPOSITION, INSIGHT_DIMENSIONS, INSIGHT_GROUPS, INSIGHT_GROUP_ORDER, TRADEOFFS } from "./ontology.ts";
import { INSIGHT_METRIC_IDS, INSIGHT_SAMPLE_MIN_ROWS, type InsightCell, type InsightDecomposition, type InsightDimensionId, type InsightEdge, type InsightGraph, type InsightMetricId, type InsightNode, type InsightRequest, type InsightRow } from "./types.ts";

export type DimensionCube = { dimension: InsightDimensionId; cells: InsightCell[] };
// 固定一条连线的最优取值后，按另一个维度分组的格子，用来找最好的搭配。
export type PairCube = { anchor: InsightDimensionId; anchorValue: string; other: InsightDimensionId; cells: InsightCell[] };
export type BuildInput = {
  request: InsightRequest; datasetVersion: string; builtAt: string;
  total: InsightCell[]; cubes: DimensionCube[]; pairs?: PairCube[];
  unavailable?: Partial<Record<InsightDimensionId, string>>;
  unavailableMetrics?: Partial<Record<InsightMetricId, string>>;
};

const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fixed = (value: number | null, unit: string) => {
  if (value === null) return "—";
  const abs = Math.abs(value);
  const digits = unit === "%" || abs < 10 ? (abs < 1 ? 2 : 1) : 0;
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: 0 })}${unit}`;
};
const count = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 0 });

// 每克让利：逐日一般開單每克实收 − 活动每克实收，按活动克重加权；没有同日对照的日子丢弃。
export function alignedGive(cells: readonly InsightCell[]): { value: number | null; droppedShare: number } {
  const days = new Map<string, { offer: { a: number; g: number }; base: { a: number; g: number } }>();
  for (const cell of cells) {
    const day = days.get(cell.day) ?? { offer: { a: 0, g: 0 }, base: { a: 0, g: 0 } };
    day[cell.side].a += cell.amount; day[cell.side].g += cell.grams; days.set(cell.day, day);
  }
  let weighted = 0; let used = 0; let dropped = 0;
  for (const day of days.values()) {
    if (day.offer.g <= 0) continue;
    if (day.base.g <= 0) { dropped += day.offer.g; continue; }
    weighted += (day.base.a / day.base.g - day.offer.a / day.offer.g) * day.offer.g; used += day.offer.g;
  }
  return { value: used > 0 ? weighted / used : null, droppedShare: used + dropped > 0 ? dropped / (used + dropped) : 0 };
}

// rows 是活动侧行数：力度维度下对照被复制到每个取值，算进来会虚高。样本够不够也只看活动侧，对照侧另查 baseRows。
type Measured = { offer: number | null; base: number | null; delta: number | null; rows: number; baseRows: number; stores: number; offerGramsPerItem: number | null; dropped: number };
function measure(metric: InsightMetricId, cells: readonly InsightCell[]): Measured {
  const spec = INSIGHT_METRICS[metric];
  const offerCells = cells.filter((c) => c.side === "offer"); const baseCells = cells.filter((c) => c.side === "base");
  const offerSum = sumCells(offerCells); const baseSum = sumCells(baseCells);
  const rows = offerSum.rows; const baseRows = baseSum.rows;
  const offerGramsPerItem = INSIGHT_METRICS.grams_per_item.compute(offerSum);
  if (metric === "penetration") {
    const total = offerSum.amount + baseSum.amount;
    const value = total > 0 ? offerSum.amount / total * 100 : null;
    return { offer: value, base: null, delta: value, rows, baseRows, stores: offerSum.stores, offerGramsPerItem, dropped: 0 };
  }
  const offer = spec.compute(offerSum); const base = spec.compute(baseSum);
  if (metric === "give_per_gram") {
    const aligned = alignedGive(cells);
    return { offer, base, delta: aligned.value, rows, baseRows, stores: offerSum.stores, offerGramsPerItem, dropped: aligned.droppedShare };
  }
  return { offer, base, delta: offer !== null && base !== null ? offer - base : null, rows, baseRows, stores: offerSum.stores, offerGramsPerItem, dropped: 0 };
}

// 连线比较的是每个取值的「活动 vs 对照」差值；渗透率没有对照，比较活动值本身。
const comparable = (metric: InsightMetricId, row: Measured) => metric === "penetration" ? row.offer : row.delta;
// 差值越大越好还是越小越好：每克让利本身就是差值，让得越少越好。
const better = (metric: InsightMetricId) => INSIGHT_METRICS[metric].higherIsBetter;

// 样本够：活动侧行数够、不是一两家店撑起来的（日均门店数 ≥ 5）；有对照的指标对照侧行数也要够。
const enough = (metric: InsightMetricId, m: Measured) => m.rows >= INSIGHT_SAMPLE_MIN_ROWS && m.stores >= 5 && (metric === "penetration" || m.baseRows >= INSIGHT_SAMPLE_MIN_ROWS);

function groupCells(cells: readonly InsightCell[]): Map<string, InsightCell[]> {
  const groups = new Map<string, InsightCell[]>();
  for (const cell of cells) { const list = groups.get(cell.value) ?? []; list.push(cell); groups.set(cell.value, list); }
  return groups;
}

// 一个维度对一个指标的关系强度：各取值比较值按活动行数加权的离散程度，除以整体量级。样本不够时为 null。
function strengthOf(metric: InsightMetricId, cells: readonly InsightCell[], overall: Measured): number | null {
  const usable = [...groupCells(cells)].map(([, c]) => measure(metric, c)).filter((m) => enough(metric, m) && comparable(metric, m) !== null);
  if (usable.length < 2) return null;
  const values = usable.map((m) => comparable(metric, m)!); const weights = usable.map((m) => m.rows); const total = weights.reduce((a, b) => a + b, 0);
  const mean = values.reduce((s, v, i) => s + v * weights[i], 0) / total;
  const spread = Math.sqrt(values.reduce((s, v, i) => s + weights[i] * (v - mean) ** 2, 0) / total);
  return Math.min(1, spread / scaleOf(metric, overall));
}
// 量级：取值之间的差别要和「活动本身带来的差」比。每克让利本身就是差值；渗透率用整体渗透率；
// 其余指标取整体差值和对照值 10% 里较大的那个——只用对照值时，折扣率这种对照接近 0 的指标会被放大到顶。
const scaleOf = (metric: InsightMetricId, overall: Measured) => Math.max(
  metric === "penetration" ? Math.abs(overall.offer ?? 0) : Math.abs(overall.delta ?? 0),
  metric === "give_per_gram" || metric === "penetration" ? 0 : Math.abs(overall.base ?? 0) * 0.1, 1e-9);
export const WEAK_STRENGTH = 0.2;

function edgeFor(input: BuildInput, cube: DimensionCube, overall: Measured): InsightEdge {
  const { request } = input; const metric = request.metric; const spec = INSIGHT_METRICS[metric]; const unit = spec.unit;
  const dimension = cube.dimension; const dimSpec = INSIGHT_DIMENSIONS[dimension];
  const measured = [...groupCells(cube.cells)].map(([value, cells]) => ({ value, m: measure(metric, cells) }));
  const table: InsightRow[] = measured.map(({ value, m }) => ({ value, offer: m.offer, base: m.base, delta: comparable(metric, m), rows: m.rows, small: !enough(metric, m) }))
    .sort((a, b) => (b.delta ?? -Infinity) - (a.delta ?? -Infinity));
  const usable = measured.filter(({ m }) => enough(metric, m) && comparable(metric, m) !== null);
  const values = usable.map(({ m }) => comparable(metric, m)!);
  const smallCount = measured.length - usable.length;
  if (usable.length < 2) {
    return { dimension, status: dimSpec.status, strength: null, weak: true, basis: [measured.length === 1 ? `当前筛选下只有「${measured[0].value}」一个取值，无法比较` : `可比较的取值不到 2 个（${smallCount} 个样本太少或缺数）`], anomalies: [], recommendation: null, draft: null, best: null, table };
  }
  // 用加权标准差而不是极差，免得一个边缘取值撑起整条线。
  const scale = scaleOf(metric, overall);
  const strength = strengthOf(metric, cube.cells, overall) ?? 0;
  const weak = strength < WEAK_STRENGTH;
  const sorted = [...usable].sort((a, b) => comparable(metric, b.m)! - comparable(metric, a.m)!);
  const best = better(metric) ? sorted[0] : sorted[sorted.length - 1];
  const worst = better(metric) ? sorted[sorted.length - 1] : sorted[0];
  const subject = metric === "penetration" || metric === "give_per_gram" ? spec.label : `${spec.label}（活动减一般開單）`;

  const basis: string[] = [];
  const hi = comparable(metric, sorted[0].m)!; const lo = comparable(metric, sorted[sorted.length - 1].m)!;
  basis.push(`${sorted[0].value} 的${subject}最高（${fixed(hi, unit)}），${sorted[sorted.length - 1].value} 最低（${fixed(lo, unit)}），相差 ${fixed(hi - lo, unit)}`);
  if (metric !== "penetration" && overall.delta !== null) basis.push(`整体${subject}为 ${fixed(overall.delta, unit)}，${weak ? "各取值之间差别不大，这个维度关系弱" : "各取值之间差别明显"}`);
  basis.push(`${usable.length} 个取值样本够用${smallCount ? `，${smallCount} 个样本太少（不足 ${INSIGHT_SAMPLE_MIN_ROWS} 行或不足 5 家店）未计入` : ""}`);

  const anomalies: string[] = [];
  const mid = median(values); const mad = median(values.map((v) => Math.abs(v - mid)));
  // 异常要同时满足：统计上离群（2.5 倍稳健标准差），且业务上有量级（偏离至少为整体量级的 25%）。
  if (mad > 0) {
    for (const { value, m } of usable) {
      const v = comparable(metric, m)!;
      if (Math.abs(v - mid) <= Math.max(2.5 * mad * 1.4826, 0.25 * scale)) continue;
      const reasons: string[] = [];
      if (m.offerGramsPerItem !== null && overall.offerGramsPerItem !== null && Math.abs(m.offerGramsPerItem / overall.offerGramsPerItem - 1) > 0.3) reasons.push(`货品结构不同（活动单件克重 ${fixed(m.offerGramsPerItem, "克")}，整体 ${fixed(overall.offerGramsPerItem, "克")}）`);
      if (m.stores < 30) reasons.push(`只有约 ${count(m.stores)} 家店`);
      anomalies.push(`${value}：${subject} ${fixed(v, unit)}，偏离中位数 ${fixed(v - mid, unit)}。${reasons.length ? `可能原因：${reasons.join("；")}` : "原因待查"}`);
    }
  }

  // 每克让利是成本，用「最少 / 最多」说，不说好坏：让利少不等于活动好，要和单件克重、销量一起看。
  const [good, bad] = metric === "give_per_gram" ? ["让利最少", "让利最多"] : ["表现最好", "最差"];
  let recommendation = `8 月里「${best.value}」的${subject === spec.label && metric === "give_per_gram" ? "" : subject}${good}（${fixed(comparable(metric, best.m), unit)}），「${worst.value}」${bad}（${fixed(comparable(metric, worst.m), unit)}）`;
  const pairRows = (input.pairs ?? []).filter((p) => p.anchor === dimension && p.anchorValue === best.value).flatMap((p) => [...groupCells(p.cells)].map(([value, cells]) => ({ other: p.other, value, m: measure(metric, cells) })))
    .filter(({ m }) => enough(metric, m) && comparable(metric, m) !== null)
    .sort((a, b) => better(metric) ? comparable(metric, b.m)! - comparable(metric, a.m)! : comparable(metric, a.m)! - comparable(metric, b.m)!);
  if (pairRows[0]) recommendation += `；再搭配${INSIGHT_DIMENSIONS[pairRows[0].other].label}为「${pairRows[0].value}」时${metric === "give_per_gram" ? "让利最少" : "最好"}（${fixed(comparable(metric, pairRows[0].m), unit)}，活动 ${count(pairRows[0].m.rows)} 行）`;
  return { dimension, status: dimSpec.status, strength, weak, basis, anomalies, recommendation, draft: weak ? null : draftFor(request, dimension, best.value), best: best.value, table };
}

function decompose(total: readonly InsightCell[]): InsightDecomposition[] {
  const parts = (side: "offer" | "base") => {
    const s = sumCells(total.filter((c) => c.side === side));
    const ratio = (a: number, b: number) => b > 0 ? a / b : null;
    return [s.orders, ratio(s.lines, s.orders), ratio(s.grams, s.lines), ratio(s.amount, s.grams)];
  };
  const offer = parts("offer"); const base = parts("base");
  const logs = offer.map((o, i) => o !== null && base[i] !== null && o > 0 && base[i]! > 0 ? Math.log(o / base[i]!) : null);
  const totalLog = logs.every((v) => v !== null) ? logs.reduce((a, b) => a! + b!, 0)! : null;
  return DECOMPOSITION.map((d, i) => ({ label: d.label, offer: offer[i], base: base[i], share: totalLog && Math.abs(totalLog) > 1e-9 ? logs[i]! / totalLog : null }));
}

export function buildInsightGraph(input: BuildInput): InsightGraph {
  const { request } = input; const spec = INSIGHT_METRICS[request.metric];
  const metricMissing = input.unavailableMetrics?.[request.metric];
  const overall = measure(request.metric, input.total);
  const offerSum = sumCells(input.total.filter((c) => c.side === "offer")); const baseSum = sumCells(input.total.filter((c) => c.side === "base"));
  const unit = spec.unit;
  const nodes: InsightNode[] = [{
    id: "metric", kind: "metric", label: spec.label, status: metricMissing ? "missing" : spec.status, note: metricMissing ?? spec.definition, source: INSIGHT_METRIC_SOURCES[request.metric],
    facts: [
      ...(request.metric === "penetration" ? [{ label: "渗透率", value: fixed(overall.offer, unit) }] : [
        { label: `活动（${request.offer}）`, value: fixed(overall.offer, unit) },
        { label: "对照（一般開單）", value: fixed(overall.base, unit) },
        { label: request.metric === "give_per_gram" ? "同日对齐后" : "差值", value: fixed(overall.delta, unit) },
      ]),
      { label: "活动明细行", value: count(offerSum.rows) }, { label: "对照明细行", value: count(baseSum.rows) },
      { label: "活动日均门店", value: count(offerSum.stores) },
    ],
  }];
  for (const group of INSIGHT_GROUP_ORDER) {
    nodes.push({ id: `group:${group}`, kind: "group", label: INSIGHT_GROUPS[group].label, group, status: "real", facts: [], source: { kind: "grouping", columns: [], how: "把维度归成一类，本身不是数据" },
      affects: { dimensions: (Object.keys(INSIGHT_DIMENSIONS) as InsightDimensionId[]).filter((d) => INSIGHT_DIMENSIONS[d].group === group), metrics: [] } });
    for (const item of INSIGHT_GROUPS[group].missing) nodes.push({ id: `missing:${group}:${item.label}`, kind: "missing", label: item.label, group, status: "missing", facts: [], note: `需要采集：${item.need}`,
      source: { kind: "suggested", columns: [], how: `需要采集：${item.need}`, judgement: item.why }, affects: { dimensions: [...item.affects.dimensions], metrics: [...item.affects.metrics] } });
  }
  for (const item of MISSING_METRICS) nodes.push({ id: `missing-metric:${item.id}`, kind: "missing", label: item.label, status: "missing", facts: [{ label: "指标族", value: item.family }], note: `需要采集：${item.need}`, source: { kind: "suggested", columns: [], how: `需要采集：${item.need}` } });

  const edges: InsightEdge[] = [];
  const influence: InsightGraph["influence"] = {};
  const cubes = new Map(input.cubes.map((c) => [c.dimension, c]));
  for (const [id, dim] of Object.entries(INSIGHT_DIMENSIONS) as Array<[InsightDimensionId, typeof INSIGHT_DIMENSIONS[InsightDimensionId]]>) {
    const reason = input.unavailable?.[id]; const cube = cubes.get(id);
    if (reason || !cube) { nodes.push({ id: `dim:${id}`, kind: "dimension", label: dim.label, group: dim.group, status: "missing", facts: [], note: reason ?? "这次没有算出这个维度", source: dim.origin }); continue; }
    const groups = groupCells(cube.cells);
    const rowsOf = (cells: InsightCell[]) => cells.reduce((s, c) => s + c.rows, 0);
    const totalRows = rowsOf(cube.cells);
    const top = [...groups].map(([value, cells]) => ({ value, rows: rowsOf(cells) })).sort((a, b) => b.rows - a.rows).slice(0, 3);
    // 点维度时高亮它明显影响的指标：同一份立方对每个指标算强度，过了弱关系线的就算。
    const strengths = Object.fromEntries(INSIGHT_METRIC_IDS.map((m) => [m, input.unavailableMetrics?.[m] ? null : strengthOf(m, cube.cells, measure(m, input.total))]));
    influence[id] = strengths;
    nodes.push({ id: `dim:${id}`, kind: "dimension", label: dim.label, group: dim.group, status: dim.status, note: dim.note, source: dim.origin,
      affects: { dimensions: [], metrics: INSIGHT_METRIC_IDS.filter((m) => (strengths[m] ?? 0) >= WEAK_STRENGTH) },
      facts: [{ label: "取值个数", value: String(groups.size) }, { label: "当前筛选下的明细行", value: count(totalRows) }, ...top.map((t) => ({ label: t.value, value: `${fixed(totalRows ? t.rows / totalRows * 100 : null, "%")}` }))] });
    if (!metricMissing) edges.push(edgeFor(input, cube, overall));
  }

  const limitations = [
    "只有 2025 年 8 月一个月：结论是同月内的横截面对比，不是活动前后对比",
    "优惠不是随机分给门店的，参加和不参加的门店本身可能就不一样",
    "对照用一般開單，推断为不带优惠的普通开单，待确认",
    "门槛、叠加、封顶规则缺失，克减力度从优惠名称解析",
    ...TRADEOFFS.filter((t) => t.a === request.metric || t.b === request.metric).map((t) => `取舍（推断）：${INSIGHT_METRICS[t.a].label} ↔ ${INSIGHT_METRICS[t.b].label}，${t.note}`),
  ];
  if (overall.dropped > 0.2) limitations.push(`有 ${fixed(overall.dropped * 100, "%")} 的活动克重当天没有一般開單对照，没有计入每克让利`);
  if (request.metric === "items_per_order" || request.metric === "amount_per_order" || request.metric === "trade_in_rate") limitations.push("订单数按日、按维度取值去重后相加，跨日同单会重复计数");
  if (metricMissing) limitations.unshift(metricMissing);

  return {
    schema: "insight-graph/v2", datasetVersion: input.datasetVersion, builtAt: input.builtAt, request,
    metric: { id: request.metric, label: spec.label, unit, definition: spec.definition, status: metricMissing ? "missing" : spec.status, offer: overall.offer, base: overall.base, delta: overall.delta },
    nodes, edges, decomposition: decompose(input.total), limitations, influence,
  };
}
