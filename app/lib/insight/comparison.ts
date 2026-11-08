// 范围比较的纯计算：同店同星期匹配历史，不把缺记录视为零成交。
import type { DailyRow, PanelRow, StoreRow } from "./drivers.ts";
import { festivalsOf, rangeLabel, type InsightRange } from "./range.ts";
import type { InsightComparison, InsightComparisonMetric, InsightComparisonTotals } from "./types.ts";

// 旧全月口径仍用数值零；新比较额外保留原查询字段是否有效。
export type ComparisonPanelRow = PanelRow & { invalidFields?: string[] };
const MONEY = { sales: "salesCents", gp: "gpCents", revEx: "revExCents", goldSales: "goldSalesCents" } as const;
const COUNTS = ["orders", "items", "k50", "k30", "gt"] as const;
const REQUIRED = [...Object.keys(MONEY), ...COUNTS] as Array<keyof PanelRow>;
const empty = (): InsightComparisonTotals => ({ salesCents: 0, gpCents: 0, revExCents: 0, goldSalesCents: 0, orders: 0, items: 0, k50: 0, k30: 0, gt: 0 });
const rounded = (value: number) => Math.sign(value) * Math.round(Math.abs(value) + Number.EPSILON * Math.abs(value));
export const comparisonCents = (value: number) => rounded(value * 100);
const weekday = (day: string) => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)))).getUTCDay();
const validField = (row: ComparisonPanelRow, key: keyof PanelRow) => !row.invalidFields?.includes(key) && typeof row[key] === "number" && Number.isFinite(row[key]);
function valid(row: ComparisonPanelRow): boolean {
  return Boolean(row.store) && /^\d{8}$/.test(row.day) && REQUIRED.every((key) => validField(row, key))
    && comparisonCents(row.sales) > 0 && comparisonCents(row.revEx) > 0 && row.orders > 0 && row.items >= 0 && row.goldSales >= 0
    && Object.keys(MONEY).every((key) => Number.isSafeInteger(comparisonCents(row[key as keyof typeof MONEY])))
    && [row.k50, row.k30, row.gt].every((n) => n === 0 || n === 1);
}
function totals(row: PanelRow): InsightComparisonTotals {
  return { salesCents: comparisonCents(row.sales), gpCents: comparisonCents(row.gp), revExCents: comparisonCents(row.revEx), goldSalesCents: comparisonCents(row.goldSales), orders: row.orders, items: row.items, k50: row.k50, k30: row.k30, gt: row.gt };
}
function add(to: InsightComparisonTotals, value: InsightComparisonTotals) {
  for (const key of Object.keys(to) as Array<keyof InsightComparisonTotals>) to[key] += value[key];
}
const metric = (current: number, baseline: number): InsightComparisonMetric => ({ current, baseline, delta: current - baseline, rate: baseline > 0 ? (current - baseline) / baseline * 100 : null });

// 和原图相同：活动计价金从某日开始，每个后续日期都超过一般开单计价金。
export function comparisonRollout(daily: readonly DailyRow[]): string | null {
  const sorted = [...daily].sort((a, b) => a.day.localeCompare(b.day));
  let start: string | null = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (!(sorted[i].promoGold > sorted[i].baseGold)) break;
    start = sorted[i].day;
  }
  return start;
}

export function comparePeriods(panel: readonly ComparisonPanelRow[], daily: readonly DailyRow[], range: InsightRange, attributes: readonly StoreRow[] = []): InsightComparison {
  const rollout = comparisonRollout(daily);
  const festival = festivalsOf(daily).find((f) => f.from === range.from && f.to === range.to);
  const title = `${festival?.name ?? rangeLabel(range)}相对可比平日的变化`;
  const days = new Map(daily.map((d) => [d.day, d]));
  const target = panel.filter((p) => p.day >= range.from && p.day <= range.to);
  // store + weekday 索引。每个历史门店日只访问一次，目标日不再扫描整张面板。
  const history = new Map<string, { sum: InsightComparisonTotals; dates: string[] }>();
  for (const p of panel) {
    const day = days.get(p.day);
    if (p.day >= range.from || (rollout && p.day >= rollout) || !day || day.festival || !valid(p)) continue;
    const key = `${p.store}\0${weekday(p.day)}`;
    const group = history.get(key) ?? { sum: empty(), dates: [] };
    add(group.sum, totals(p)); group.dates.push(p.day); history.set(key, group);
  }
  const baselineOf = new Map<string, InsightComparisonTotals>();
  for (const [key, h] of history) if (h.dates.length >= 2) {
    const avg = empty();
    for (const field of Object.keys(avg) as Array<keyof InsightComparisonTotals>) avg[field] = field.endsWith("Cents") ? rounded(h.sum[field] / h.dates.length) : h.sum[field] / h.dates.length;
    baselineOf.set(key, avg);
  }
  const current = empty(); const baseline = empty(); const matchedStores = new Set<string>(); const baselineDates = new Set<string>();
  const matchedDays = new Map<string, { stores: Set<string>; dates: Set<string> }>();
  const storeSamples = new Map<string, { current: InsightComparisonTotals; baseline: InsightComparisonTotals; days: number }>();
  let invalidTargetDays = 0; let insufficientHistoryDays = 0; let storeDays = 0;
  for (const p of target) {
    if (!valid(p)) { invalidTargetDays++; continue; }
    const key = `${p.store}\0${weekday(p.day)}`; const base = baselineOf.get(key);
    if (!base) { insufficientHistoryDays++; continue; }
    const now = totals(p); add(current, now); add(baseline, base); storeDays++; matchedStores.add(p.store);
    const store = storeSamples.get(p.store) ?? { current: empty(), baseline: empty(), days: 0 };
    add(store.current, now); add(store.baseline, base); store.days++; storeSamples.set(p.store, store);
    const match = matchedDays.get(p.day) ?? { stores: new Set<string>(), dates: new Set<string>() };
    match.stores.add(p.store);
    for (const d of history.get(key)!.dates) { baselineDates.add(d); match.dates.add(d); }
    matchedDays.set(p.day, match);
  }
  // 本期全范围总量逐字段保留缺失。存在缺字段时不给这个字段的伪完整总量。
  const targetTotals: InsightComparison["targetTotals"] = { ...empty() };
  for (const [field, output] of Object.entries(MONEY) as Array<[keyof typeof MONEY, typeof MONEY[keyof typeof MONEY]]>) {
    targetTotals[output] = target.length && target.every((p) => validField(p, field)) ? target.reduce((n, p) => n + comparisonCents(p[field]), 0) : null;
  }
  for (const field of COUNTS) targetTotals[field] = target.length && target.every((p) => validField(p, field)) ? target.reduce((n, p) => n + p[field], 0) : null;
  const groups: InsightComparison["groups"] = []; const groupNotes: string[] = [];
  const attr = new Map(attributes.map((s) => [s.store, s]));
  for (const [dimension, name] of [["image", "商圈"], ["shopType", "铺型"], ["region", "区域"]] as const) {
    const grouped = new Map<string, { stores: number; storeDays: number; current: InsightComparisonTotals; baseline: InsightComparisonTotals }>();
    for (const [id, sample] of storeSamples) {
      const label = attr.get(id)?.[dimension]; if (!label) continue;
      const g = grouped.get(label) ?? { stores: 0, storeDays: 0, current: empty(), baseline: empty() };
      g.stores++; g.storeDays += sample.days; add(g.current, sample.current); add(g.baseline, sample.baseline); grouped.set(label, g);
    }
    let shown = 0;
    for (const [label, g] of grouped) if (g.stores >= 9) {
      groups.push({ dimension, label, stores: g.stores, storeDays: g.storeDays, sales: metric(g.current.salesCents, g.baseline.salesCents), gp: metric(g.current.gpCents, g.baseline.gpCents), qty: metric(g.current.items, g.baseline.items) }); shown++;
    }
    if (!shown) groupNotes.push(`${name}没有至少 9 家可比门店的分组，不展示分组变化。`);
    else if ([...grouped.values()].some((g) => g.stores < 9)) groupNotes.push(`${name}中不足 9 家可比门店的分组已省略。`);
  }
  const sample = storeDays ? { current, baseline } : null;
  const sales = sample ? metric(current.salesCents, baseline.salesCents) : null;
  const gp = sample ? metric(current.gpCents, baseline.gpCents) : null;
  const qty = sample ? metric(current.items, baseline.items) : null;
  const aov = sample ? metric(current.salesCents / current.orders, baseline.salesCents / baseline.orders) : null;
  const gm = sample ? metric(current.gpCents / current.revExCents * 100, baseline.gpCents / baseline.revExCents * 100) : null;
  const ordersCents = sample ? rounded((current.orders - baseline.orders) * (aov!.current + aov!.baseline) / 2) : 0;
  const revExCents = sample ? rounded((current.revExCents - baseline.revExCents) * (gm!.current + gm!.baseline) / 200) : 0;
  const overlap = daily.some((d) => d.day >= range.from && d.day <= range.to && d.festival && rollout && d.day >= rollout);
  const limitations = [
    ...(overlap ? [`${festival?.name ?? "节日"}与全国克减重叠，无法单独拆出${festival?.name ?? "节日"}净效果。`] : []),
    "历史同店同星期对照仍是观察，不能据此认定节日或活动带来的净增量。",
    "只匹配有实际记录的门店日；缺记录不等于零成交或未营业，不推断客流、转化率。",
    "活动标记仅代表有成交的门店日覆盖，不是活动销售额份额或活动增量。",
  ];
  return {
    title, status: sample ? "available" : "unavailable", method: "逐个目标门店日匹配同一家店、同一星期几的历史记录；只用目标范围开始前、非节日且早于数据推断的全国克减铺开日，至少 2 条有效记录取均值。金额逐记录换算为整数分，对照在每个匹配单元取整到分后汇总；订单与件数的对照是允许小数的期望值。", minimumHistory: 2, rollout,
    baselineDates: [...baselineDates].sort(), matches: [...matchedDays].sort(([a], [b]) => a.localeCompare(b)).map(([day, match]) => ({ day, stores: match.stores.size, baselineDates: [...match.dates].sort() })),
    coverage: { stores: matchedStores.size, totalStores: new Set(target.map((p) => p.store)).size, storeDays, totalStoreDays: target.length, invalidTargetDays, insufficientHistoryDays },
    targetTotals, sample, metrics: { sales, gp, qty },
    decomposition: sample ? { sales: { ordersCents, aovCents: sales!.delta - ordersCents }, gp: { revExCents, gmCents: gp!.delta - revExCents } } : null,
    ratios: sample ? { aov: aov!, itemsPerOrder: metric(current.items / current.orders, baseline.items / baseline.orders), gm: gm!, goldShare: metric(current.goldSalesCents / current.salesCents * 100, baseline.goldSalesCents / baseline.salesCents * 100) } : null,
    activities: sample ? ([ ["k50", "克减 50"], ["k30", "克减 30"], ["gt", "金色星期二"] ] as const).map(([id, label]) => ({ id, label, current: current[id] / storeDays * 100, baseline: baseline[id] / storeDays * 100, delta: (current[id] - baseline[id]) / storeDays * 100 })) : [],
    groups, groupNotes, limitations,
    unavailableReason: sample ? null : `没有足够对照：${insufficientHistoryDays} 个有效目标门店日不足至少 2 条同店同星期历史记录，另有 ${invalidTargetDays} 个目标门店日缺少必需有效字段。`,
  };
}
