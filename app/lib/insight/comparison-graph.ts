// 范围图只回答相对自身可比平日的变化。全月继续使用 drivers.ts。
import { comparePeriods, comparisonCents, type ComparisonPanelRow } from "./comparison.ts";
import type { DriverData } from "./drivers.ts";
import { festivalsOf } from "./range.ts";
import type { InsightCard, InsightChart, InsightComparison, InsightComparisonMetric, InsightEdge, InsightGraph, InsightKpi, InsightNode, InsightNodeId, InsightTable } from "./types.ts";

const n = (v: number, digits = 2) => v.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: digits });
const money = (cents: number) => `${n(cents / 100)} 元`;
const signed = (v: number, format = n) => `${v > 0 ? "+" : ""}${format(v)}`;
const rate = (m: InsightComparisonMetric) => m.rate === null ? "对照不大于零，不计算变化率" : `变化 ${signed(m.rate)}%`;
const value = (v: number, amount: boolean) => amount ? money(v) : `${n(v)} 件`;
const compactValue = (v: number, amount: boolean) => {
  const raw = amount ? v / 100 : v;
  const scale = amount && Math.abs(raw) >= 1e8 ? 1e8 : Math.abs(raw) >= 1e4 ? 1e4 : 1;
  return `${n(raw / scale)} ${scale === 1e8 ? "亿" : scale === 1e4 ? "万" : ""}${amount ? "元" : "件"}`;
};
const compactMoney = (v: number) => compactValue(v, true);
const shortChange = (m: InsightComparisonMetric, amount: boolean) => m.rate === null ? `差额 ${signed(m.delta, (v) => compactValue(v, amount))}（不计算变化率）` : `变化 ${signed(m.rate)}%`;
const change = (label: string, m: InsightComparisonMetric, amount = true) => `${label}：可比样本本期 ${value(m.current, amount)}，对照 ${value(m.baseline, amount)}，差额 ${signed(m.delta, (v) => value(v, amount))}，${rate(m)}。`;
const chartOf = (title: string, m: InsightComparisonMetric, amount: boolean): InsightChart => m.current < 0 || m.baseline < 0 ? { kind: "bars", title, bars: [
  { label: "可比平日", value: amount ? m.baseline / 100 : m.baseline, text: value(m.baseline, amount), tone: "muted" },
  { label: "可比样本本期", value: amount ? m.current / 100 : m.current, text: value(m.current, amount), tone: "main" },
] } : ({ kind: "compare", title, note: "本期与对照来自同一批匹配门店日；对照是目标日期结构下的历史期望值。", items: [
  { label: "可比平日", value: amount ? m.baseline / 100 : m.baseline, text: value(m.baseline, amount), tone: "base" },
  { label: "可比样本本期", value: amount ? m.current / 100 : m.current, text: value(m.current, amount), tone: "hot" },
] });
const cardOf = (say: string, c: InsightComparison, how: string, chart?: InsightChart): InsightCard => ({ say, chart, how, watch: c.limitations, todo: null, todoNote: "历史对照和同期观察不能单独确立活动净效果。", evidence: [say, how] });

export function buildComparisonGraph(data: DriverData, fullPanel: readonly ComparisonPanelRow[], builtAt = new Date().toISOString()): InsightGraph {
  if (!data.window) throw new Error("可比平日图谱需要明确的目标范围");
  const c = comparePeriods(fullPanel, data.daily, data.window, data.stores);
  const coverage = `可比样本覆盖 ${n(c.coverage.stores, 0)}/${n(c.coverage.totalStores, 0)} 家店、${n(c.coverage.storeDays, 0)}/${n(c.coverage.totalStoreDays, 0)} 个有记录的目标门店日`;
  const method = `${coverage}。${c.method}`;
  // 顶部保留本期全范围真实聚合，不和可比样本的基准混算。
  const actual = {
    sales: data.ptype.reduce((a, p) => a + comparisonCents(p.sales), 0),
    gp: data.ptype.reduce((a, p) => a + comparisonCents(p.gp), 0),
    qty: data.ptype.reduce((a, p) => a + p.items, 0),
  };
  const kpis: InsightKpi[] = ([ ["sales", "销售额"], ["gp", "毛利"], ["qty", "销量"] ] as const).map(([id, label]) => {
    const amount = id !== "qty"; const raw = amount ? actual[id] / 100 : actual[id];
    const scale = amount ? Math.abs(raw) >= 1e8 ? 1e8 : Math.abs(raw) >= 1e4 ? 1e4 : 1 : raw >= 1e4 ? 1e4 : 1;
    const m = c.metrics[id];
    return { id, label, value: n(raw / scale), unit: `${scale === 1e8 ? "亿" : scale === 1e4 ? "万" : ""}${amount ? "元" : "件"}`, detail: "本期全范围实际值",
      ...(m ? { comparison: { current: compactValue(m.current, amount), baseline: compactValue(m.baseline, amount), delta: signed(m.delta, (v) => compactValue(v, amount)), rate: m.rate === null ? null : `${signed(m.rate)}%` } } : {}) };
  });
  const nodes: InsightNode[] = []; const edges: InsightEdge[] = [];
  function node(id: InsightNodeId, label: string, subtitle: string, column: InsightNode["column"], kind: InsightNode["kind"], say: string, columns: string[], options: { chart?: InsightChart; table?: InsightTable; paragraphs?: string[] } = {}) {
    const card = cardOf(say, c, method, options.chart);
    const item: InsightNode = { id, label, subtitle, column, kind, ...(column === 0 ? { section: "门店" as const } : {}),
      ...(kind === "factor" || kind === "leaf" ? { strength: "observed" as const } : {}),
      source: { kind: "derived", columns, how: method }, card, paragraphs: options.paragraphs ?? [say, coverage], chart: options.chart, table: options.table };
    nodes.push(item); return item;
  }
  for (const k of kpis) {
    const m = c.metrics[k.id]; const amount = k.id !== "qty";
    node(k.id, k.label, m ? rate(m) : `本期 ${k.value}${k.unit} · 无足够对照`, 3, "metric",
      m ? change(k.label, m, amount) : `${k.label}本期全范围实际 ${k.value}${k.unit}。${c.unavailableReason}`, k.id === "gp" ? ["零售毛利", "rsv"] : k.id === "sales" ? ["实际销售金额"] : ["销售件数"],
      { ...(m ? { chart: chartOf(`可比样本${k.label}`, m, amount) } : {}), paragraphs: m ? [change(k.label, m, amount), ...(k.id === "qty" ? ["销量 = 订单数 × 单均件数；历史对照的订单和件数是期望值，允许小数。"] : []), coverage] : [`本期全范围实际 ${k.value}${k.unit}。`, c.unavailableReason!] });
  }
  function edge(from: InsightNodeId, to: InsightNodeId, strength: "change" | "observed", basis: string, chart?: InsightChart) {
    edges.push({ from, to, strength, basis, card: cardOf(basis, c, strength === "change" ? "同一可比样本的恒等式对称拆解，取整余差归最后一项；不是因果归因。" : method, chart), chart,
      anomalies: c.limitations, recommendation: null, noRecommendation: "不能从同期观察推断因果贡献或独立节日效果。" });
  }
  if (c.sample && c.ratios && c.decomposition) {
    const { current, baseline } = c.sample; const r = c.ratios; const d = c.decomposition;
    const orders = { current: current.orders, baseline: baseline.orders, delta: current.orders - baseline.orders, rate: (current.orders - baseline.orders) / baseline.orders * 100 };
    node("orders", "订单数", `本期 ${n(orders.current)} / 对照 ${n(orders.baseline)} 单`, 2, "decomp", `可比样本订单数由对照 ${n(orders.baseline)} 单变为本期 ${n(orders.current)} 单，${rate(orders)}。`, ["销售单号"]);
    node("aov", "客单价", `${rate(r.aov)}`, 2, "decomp", `可比样本客单价本期 ${money(r.aov.current)}，对照 ${money(r.aov.baseline)}，${rate(r.aov)}。`, ["实际销售金额", "销售单号"]);
    node("itemsPerOrder", "单均件数", `本期 ${n(r.itemsPerOrder.current)} / 对照 ${n(r.itemsPerOrder.baseline)} 件`, 2, "decomp", `可比样本每单件数本期 ${n(r.itemsPerOrder.current)} 件，对照 ${n(r.itemsPerOrder.baseline)} 件，${rate(r.itemsPerOrder)}。`, ["销售件数", "销售单号"]);
    const revEx = { current: current.revExCents, baseline: baseline.revExCents, delta: current.revExCents - baseline.revExCents, rate: (current.revExCents - baseline.revExCents) / baseline.revExCents * 100 };
    node("revEx", "不含税销售基数", rate(revEx), 2, "decomp", change("不含税 RSV", revEx), ["rsv"]);
    node("gm", "毛利率", `${signed(r.gm.delta)} 个百分点`, 2, "decomp", `可比样本毛利率本期 ${n(r.gm.current)}%，对照 ${n(r.gm.baseline)}%，相差 ${signed(r.gm.delta)} 个百分点。毛利率 = 零售毛利 ÷ 不含税 RSV。`, ["零售毛利", "rsv"]);
    const activityText = c.activities.map((a) => `${a.label}有成交的门店日覆盖：本期 ${n(a.current)}%，对照 ${n(a.baseline)}%，相差 ${signed(a.delta)} 个百分点`).join("；");
    node("promo", "活动成交覆盖", "克减 / 金色星期二 · 同期观察", 1, "factor", `${activityText}。不是活动销售额份额或活动增量。`, ["优惠小类"], { table: { head: ["有成交的门店日", "本期覆盖", "对照覆盖", "百分点差"], rows: c.activities.map((a) => [a.label, `${n(a.current)}%`, `${n(a.baseline)}%`, signed(a.delta)]) } });
    const mixText = `可比样本计价金销售占比：本期 ${n(r.goldShare.current)}%，对照 ${n(r.goldShare.baseline)}%，相差 ${signed(r.goldShare.delta)} 个百分点；整体毛利率相差 ${signed(r.gm.delta)} 个百分点。这是同期观察，未识别货品结构的独立贡献。`;
    node("mix", "计价金与其他货品", `${signed(r.goldShare.delta)} 个百分点 · 同期观察`, 1, "factor", mixText, ["材料种类描述", "实际销售金额", "零售毛利", "rsv"], { table: { head: ["同口径指标", "本期", "对照"], rows: [
      ["计价金销售额", money(current.goldSalesCents), money(baseline.goldSalesCents)], ["其他货品销售额", money(current.salesCents - current.goldSalesCents), money(baseline.salesCents - baseline.goldSalesCents)],
      ["计价金销售占比", `${n(r.goldShare.current)}%`, `${n(r.goldShare.baseline)}%`], ["整体毛利率（不含税RSV口径）", `${n(r.gm.current)}%`, `${n(r.gm.baseline)}%`],
    ] } });
    edge("orders", "sales", "change", `销售差额 ${money(c.metrics.sales!.delta)}，订单数项 ${signed(d.sales.ordersCents, money)}；采用订单数差 × 本期与对照客单价均值。`);
    edge("aov", "sales", "change", `销售差额 ${money(c.metrics.sales!.delta)}，客单价项 ${signed(d.sales.aovCents, money)}；客单价差 × 本期与对照订单均值，取整余差归此项。与订单数项逐分相加等于销售差额。`);
    edge("revEx", "gp", "change", `毛利差额 ${money(c.metrics.gp!.delta)}，不含税 RSV 项 ${signed(d.gp.revExCents, money)}；不含税 RSV 差 × 本期与对照毛利率均值。`);
    edge("gm", "gp", "change", `毛利差额 ${money(c.metrics.gp!.delta)}，毛利率项 ${signed(d.gp.gmCents, money)}；毛利率差 × 本期与对照不含税 RSV 均值，取整余差归此项。两项逐分相加等于毛利差额。`);
    edge("orders", "qty", "change", `销量 = 订单数 × 单均件数；可比样本订单本期 ${n(current.orders)} 单、对照 ${n(baseline.orders)} 单，销量本期 ${n(current.items)} 件、对照 ${n(baseline.items)} 件。`);
    edge("itemsPerOrder", "qty", "change", `销量 = 订单数 × 单均件数；单均件数本期 ${n(r.itemsPerOrder.current)} 件、对照 ${n(r.itemsPerOrder.baseline)} 件。`);
    edge("promo", "sales", "observed", `${activityText}。这些覆盖与销售变化同时发生，不代表活动销售份额、活动增量或节日净效果。`);
    edge("mix", "gm", "observed", mixText);
    for (const [dimension, id, label, field] of [["image", "image", "商圈分组变化", "形象级别描述"], ["shopType", "shoptype", "铺型分组变化", "铺型"], ["region", "region", "区域分组变化", "区域描述"]] as const) {
      const groups = c.groups.filter((g) => g.dimension === dimension); if (!groups.length) continue;
      const say = `${groups.map((g) => `${g.label}（${g.stores} 家可比门店）的销售额相对自身基准 ${rate(g.sales)}`).join("；")}。分组只是门店背景，不作为节日拉动因素。`;
      node(id, label, "相对各组自身基准 · 同期观察", 0, "leaf", say, [field], { table: { head: ["分组 / 可比店数", "样本本期", "自身对照", "销售变化"], rows: groups.map((g) => [`${g.label} / ${g.stores} 家`, money(g.sales.current), money(g.sales.baseline), g.sales.rate === null ? "不计算变化率" : `${signed(g.sales.rate)}%`]) } });
      edge(id, "sales", "observed", say);
    }
  }
  const overlap = c.limitations.find((s) => s.includes("与全国克减重叠")) ?? null;
  const summary = c.sample ? [
    `可比样本销售额${shortChange(c.metrics.sales!, true)}；变化拆解为订单数项 ${signed(c.decomposition!.sales.ordersCents, compactMoney)}、客单价项 ${signed(c.decomposition!.sales.aovCents, compactMoney)}。`,
    `可比样本毛利${shortChange(c.metrics.gp!, true)}，销量${shortChange(c.metrics.qty!, false)}；整体毛利率相差 ${signed(c.ratios!.gm.delta)} 个百分点。`,
    `活动成交覆盖与计价金占比（${signed(c.ratios!.goldShare.delta)} 个百分点）仅作同期观察。${overlap ?? c.limitations[0]}`,
  ] : [`${c.unavailableReason} 只展示本期全范围实际值。`, kpis.map((k) => `${k.label} ${k.value}${k.unit}`).join("；"), overlap ?? c.limitations[0]];
  return { schema: "insight-drivers/v2", datasetVersion: data.datasetVersion, builtAt,
    scope: { period: data.period, rows: data.rows, stores: c.coverage.totalStores, note: `本期全范围实际值与可比样本分别呈现；${coverage}`, range: data.window, dataFrom: data.dataFrom, dataTo: data.dataTo, festivals: festivalsOf(data.daily), overlap },
    comparison: c, kpis, nodes, edges, summary,
    methods: [ { title: "可比平日", text: c.method }, { title: "覆盖与缺失", text: `${coverage}；缺必需字段 ${c.coverage.invalidTargetDays} 个、历史不足 ${c.coverage.insufficientHistoryDays} 个目标门店日。未匹配部分不参与变化计算。` },
      { title: "对照日期", text: c.baselineDates.length ? `实际使用日期并集：${c.baselineDates.join("、")}；各目标日的历史日期见匹配明细。` : "无满足条件的对照日期。" },
      { title: "数据推断的铺开日", text: c.rollout ?? "未发现持续铺开的日期。" },
      { title: "变化拆解与同期观察", text: "变化拆解使用同一可比样本的恒等式，销售按订单数与客单价，毛利按不含税 RSV 与毛利率做对称拆解；金额逐分守恒。同期观察不给解释度，不排序因果强弱。" },
      { title: "门店分组", text: `仅展示至少 9 家可比门店的商圈、铺型和区域各自变化；${c.groupNotes.join("")}` },
      { title: "证据边界", text: c.limitations.join("") },
    ] };
}
