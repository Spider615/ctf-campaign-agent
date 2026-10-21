// 从 Agent 查回来的聚合数据算出指标影响因素图谱：先算统计量，再用模板拼出节点、连线和依据。
// 图上的数字全部出自这里，文字是模板，不经过模型。
import { comparePeers, findOutliers, mainPart, peerGroups, type PeerMetric, type PeerStore } from "./peers.ts";
import { etaSquared, logSplit, median, rSquared, strengthOf, twoWayShares, uniqueContributions, withinStoreDayFit } from "./stats.ts";
import type { InsightEdge, InsightEffect, InsightGraph, InsightKpi, InsightNode, InsightNodeId, InsightScore, InsightStrength } from "./types.ts";

// 优惠按名称归成几组（AI 归类）：克减 50、克减 30、金色星期二、一般開單、其他。
export type OfferGroup = "base" | "k50" | "k30" | "gt" | "other";
// 门店日：baseGold 一般開單计价金实收；heavyGold 单件 ≥ 20 克的计价金实收；goldGrams / goldQty 计价金克重、件数。
export type PanelRow = { store: string; day: string; sales: number; gp: number; revEx: number; items: number; orders: number; goldSales: number; baseGold: number; heavyGold: number; goldGrams: number; goldQty: number; k50: number; k30: number; gt: number };
export type StoreRow = { store: string; bigRegion: string; region: string; cityTier: string; image: string; shopType: string; nature: string; area: string; experience: string; age: number | null; name: string };
export type PtypeRow = { ptype: "计价金" | "一口价黄金" | "镶嵌及其他"; sales: number; gp: number; revEx: number; items: number; grams: number };
// dow：0 周日 … 6 周六。baseGold / promoGold：一般開單、除金色星期二外的活动计价金实收。
export type DailyRow = { day: string; dow: number; festival: string | null; sales: number; orders: number; goldSales: number; baseGold: number; promoGold: number };
// 一般足金类的足金行，按日和优惠组汇总；ge20 是单件 ≥ 20 克的实收。
export type GoldRow = { day: string; group: OfferGroup; amount: number; grams: number; qty: number; ge20: number };
export type ThresholdRow = { gram: number; k50: number; base: number };
export type TradeInRow = { group: OfferGroup; orders: number; tradeIn: number; sales: number; recycle: number };
export type DriverData = {
  datasetVersion: string; period: string; rows: number; memberShare: number;
  panel: PanelRow[]; stores: StoreRow[]; ptype: PtypeRow[]; daily: DailyRow[]; gold: GoldRow[]; threshold: ThresholdRow[]; tradein: TradeInRow[];
};


// 格式化：亿、万、百分比、整数。
const n0 = (v: number) => Math.round(v).toLocaleString("zh-CN");
const n1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const yi = (v: number) => `${n1(v / 1e8)} 亿`;
const wan = (v: number) => v >= 1e8 ? yi(v) : `${n0(v / 1e4)} 万`;
const pct = (v: number) => `${n1(v)}%`;
const pp = (v: number) => `${v >= 0 ? "+" : "−"}${n1(Math.abs(v))}pp`;
const times = (v: number) => `×${n1(v)}`;
const day = (d: string) => `${Number(d.slice(4, 6))}/${Number(d.slice(6, 8))}`;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: readonly number[]) => xs.length ? sum(xs) / xs.length : 0;
const ageBand = (age: number | null) => age === null ? "未知" : age <= 2 ? "≤2年" : age <= 5 ? "3-5年" : age <= 10 ? "6-10年" : "10年以上";

export function buildDriverGraph(data: DriverData, builtAt = new Date().toISOString()): InsightGraph {
  // ---------- 全国 ----------
  const pt = (name: PtypeRow["ptype"]) => data.ptype.find((p) => p.ptype === name) ?? { ptype: name, sales: 0, gp: 0, revEx: 0, items: 0, grams: 0 };
  const total = { sales: sum(data.ptype.map((p) => p.sales)), gp: sum(data.ptype.map((p) => p.gp)), revEx: sum(data.ptype.map((p) => p.revEx)), items: sum(data.ptype.map((p) => p.items)), orders: sum(data.panel.map((p) => p.orders)) };
  const gm = total.revEx > 0 ? total.gp / total.revEx * 100 : 0;
  const gold = pt("计价金"); const fixed = pt("一口价黄金"); const inlay = pt("镶嵌及其他");
  const storeCount = new Set(data.panel.map((p) => p.store)).size;
  const share = (v: number, of: number) => of > 0 ? v / of * 100 : 0;
  const ptGm = (p: PtypeRow) => p.revEx > 0 ? p.gp / p.revEx * 100 : 0;

  // ---------- 门店 + 日期分解 ----------
  const panel = data.panel.filter((p) => p.sales > 0 && p.revEx > 0);
  const sKeys = panel.map((p) => p.store); const dKeys = panel.map((p) => p.day);
  const logSales = Float64Array.from(panel, (p) => Math.log(p.sales));
  const fe = twoWayShares(sKeys, dKeys, logSales);
  const feItems = twoWayShares(sKeys, dKeys, Float64Array.from(panel, (p) => Math.log(Math.max(1, p.items))));
  const panelGm = Float64Array.from(panel, (p) => p.gp / p.revEx * 100);
  // 门店、日期对订单数和客单价各自的影响（双向固定效应）：「门店本身 → 订单数」这类线用它。
  const logOrders = Float64Array.from(panel, (p) => Math.log(Math.max(1, p.orders)));
  const feOrders = twoWayShares(sKeys, dKeys, logOrders);
  const feAov = twoWayShares(sKeys, dKeys, Float64Array.from(panel, (p) => Math.log(p.sales / Math.max(1, p.orders))));
  const feGm = twoWayShares(sKeys, dKeys, panelGm);

  // ---------- 同店同日：有没有这几类活动成交 ----------
  const flags = (["k50", "k30", "gt"] as const).map((k) => Float64Array.from(panel, (p) => p[k] ? 1 : 0));
  const fitSales = withinStoreDayFit(sKeys, dKeys, logSales, flags); const promoSales = fitSales.beta.map(Math.exp);
  const fitOrders = withinStoreDayFit(sKeys, dKeys, logOrders, flags);
  const fitGm = withinStoreDayFit(sKeys, dKeys, panelGm, flags); const promoGm = fitGm.beta;
  const fitGold = withinStoreDayFit(sKeys, dKeys, Float64Array.from(panel, (p) => p.goldSales / p.sales * 100), flags); const promoGold = fitGold.beta;
  const PROMO = ["克减 50", "克减 30", "金色星期二"];
  // 活动机制的偏 R²：只看有计价金成交的门店日，各机制对应的结果去掉门店、日期差异后，相应活动还能解释多少。
  const goldDays = panel.filter((p) => p.goldGrams > 0 && p.goldSales > 0 && p.goldQty > 0);
  const gKeys = goldDays.map((p) => p.store); const gDays = goldDays.map((p) => p.day);
  const flag = (k: "k50" | "k30" | "gt") => Float64Array.from(goldDays, (p) => p[k] ? 1 : 0);
  const fitDepth = withinStoreDayFit(gKeys, gDays, Float64Array.from(goldDays, (p) => p.goldSales / p.goldGrams), [flag("k50"), flag("k30")]);
  const fitHeavy = withinStoreDayFit(gKeys, gDays, Float64Array.from(goldDays, (p) => p.heavyGold / p.goldSales * 100), [flag("k50")]);
  const fitGtSales = withinStoreDayFit(sKeys, dKeys, logSales, [flags[2]]);
  const fitShift = withinStoreDayFit(gKeys, gDays, Float64Array.from(goldDays, (p) => p.baseGold / p.goldSales * 100), [flag("k50"), flag("k30")]);
  const fitGrams = withinStoreDayFit(gKeys, gDays, Float64Array.from(goldDays, (p) => Math.log(p.goldGrams / p.goldQty)), [flag("k50"), flag("k30"), flag("gt")]);

  // ---------- 门店之间：开满 20 天的店 ----------
  const attrOf = new Map(data.stores.map((s) => [s.store, s]));
  const byStore = new Map<string, { days: number; sales: number; gp: number; revEx: number; orders: number; gold: number }>();
  for (const p of panel) { const s = byStore.get(p.store) ?? { days: 0, sales: 0, gp: 0, revEx: 0, orders: 0, gold: 0 }; s.days++; s.sales += p.sales; s.gp += p.gp; s.revEx += p.revEx; s.orders += p.orders; s.gold += p.goldSales; byStore.set(p.store, s); }
  const full = [...byStore].filter(([id, s]) => s.days >= 20 && s.orders > 0 && attrOf.has(id)).map(([id, s]) => ({ id, ...s, attr: attrOf.get(id)! }));
  const attrs = { 区域: full.map((s) => s.attr.region), 城市级别: full.map((s) => s.attr.cityTier), 形象级别: full.map((s) => s.attr.image), 铺型: full.map((s) => s.attr.shopType),
    分店性质: full.map((s) => s.attr.nature), 面积: full.map((s) => s.attr.area), 店型: full.map((s) => s.attr.experience), 店龄: full.map((s) => ageBand(s.attr.age)) };
  const yStoreSales = Float64Array.from(full, (s) => Math.log(s.sales));
  const yStoreOrders = Float64Array.from(full, (s) => Math.log(s.orders));
  const yStoreAov = Float64Array.from(full, (s) => Math.log(s.sales / s.orders));
  const yStoreGm = Float64Array.from(full, (s) => s.gp / s.revEx * 100);
  const goldShare = Float64Array.from(full, (s) => s.gold / s.sales * 100);
  const uSales = uniqueContributions(attrs, yStoreSales); const uOrders = uniqueContributions(attrs, yStoreOrders);
  const uAov = uniqueContributions(attrs, yStoreAov); const uGm = uniqueContributions(attrs, yStoreGm);
  const uGmMix = uniqueContributions(attrs, yStoreGm, [goldShare]);
  const mixOnly = rSquared([new Float64Array(full.length).fill(1), goldShare], yStoreGm) * 100;
  const u = (r: { unique: Record<string, number> }, k: string) => Math.max(0, r.unique[k] * 100);
  const storeSplit = logSplit(full.map((s) => s.sales), full.map((s) => s.orders));
  // 拆解线的分数：门店之间结果的差异，多少来自这一项（对数方差拆分）。件数 = 订单数 × 单均件数；毛利 = 不含税销售额 × 毛利率。
  const itemsOf = new Map<string, number>(); for (const p of panel) itemsOf.set(p.store, (itemsOf.get(p.store) ?? 0) + p.items);
  const qtySplit = logSplit(full.map((s) => Math.max(1, itemsOf.get(s.id) ?? 1)), full.map((s) => s.orders));
  const gpStores = full.filter((s) => s.gp > 0);
  const gpSplit = logSplit(gpStores.map((s) => s.gp), gpStores.map((s) => s.revEx));
  // 大区、区域单独看能解释多少门店日销售额。
  const panelAttr = panel.map((p) => attrOf.get(p.store));
  const etaBig = etaSquared(panelAttr.map((a) => a?.bigRegion ?? "未知"), logSales);
  const etaRegion = etaSquared(panelAttr.map((a) => a?.region ?? "未知"), logSales);
  const medianBy = (key: (s: typeof full[number]) => string, value: (s: typeof full[number]) => number) => {
    const g = new Map<string, number[]>(); for (const s of full) { const k = key(s); g.set(k, [...(g.get(k) ?? []), value(s)]); }
    return [...g].map(([k, v]) => ({ k, n: v.length, m: median(v) ?? 0 }));
  };
  const imageRows = medianBy((s) => s.attr.image, (s) => s.sales).sort((a, b) => b.m - a.m);
  const expSales = medianBy((s) => s.attr.experience, (s) => s.sales); const expAov = medianBy((s) => s.attr.experience, (s) => s.sales / s.orders);
  const expRows = expSales.filter((r) => r.n >= 9).sort((a, b) => b.m - a.m).map((r) => ({ ...r, aov: expAov.find((x) => x.k === r.k)!.m }));
  const natureGm = medianBy((s) => s.attr.nature, (s) => s.gp / s.revEx * 100).sort((a, b) => a.m - b.m);

  // ---------- 日期 ----------
  const daily = [...data.daily].sort((a, b) => a.day.localeCompare(b.day));
  // 全国克减铺开的日子：活动计价金超过一般開單计价金、之后一直如此的第一天。之前的周一、三、四当普通工作日。
  // 只看「从这天起每天都超过」，周末的局部活动不算铺开。
  const rollout = daily.find((d, i) => daily.slice(i).every((x) => x.promoGold > x.baseGold))?.day ?? "99999999";
  const plain = (d: DailyRow) => [1, 3, 4].includes(d.dow) && !d.festival;
  const ordinary = daily.filter((d) => plain(d) && d.day < rollout);
  const ordinaryAvg = mean(ordinary.map((d) => d.sales));
  const tuesdays = daily.filter((d) => d.dow === 2 && d.day < rollout && !d.festival);
  const tueAvg = mean(tuesdays.map((d) => d.sales)); const tueGold = mean(tuesdays.map((d) => d.goldSales)); const ordGold = mean(ordinary.map((d) => d.goldSales));
  const weekendAvg = mean(daily.filter((d) => d.dow === 0 || d.dow === 6).map((d) => d.sales));
  const festDays = daily.filter((d) => d.festival);
  const peak = festDays.reduce<DailyRow | null>((a, b) => !a || b.sales > a.sales ? b : a, null);
  const festName = peak?.festival?.replace(/节$/, "") ?? "节日";
  const daySplit = logSplit(daily.map((d) => d.sales), daily.map((d) => d.orders));
  // 全国逐日销售额对数的差异，节日、星期各解释多少（单变量解释度）。
  const dayLog = Float64Array.from(daily, (d) => Math.log(d.sales));
  const etaFestival = etaSquared(daily.map((d) => d.festival ?? "非节日"), dayLog);
  const etaWeekday = etaSquared(daily.map((d) => String(d.dow)), dayLog);
  // 铺开后的周一、三、四：节日周也算进来（否则没剩几天），只去掉节日当天。
  const after = daily.filter((d) => [1, 3, 4].includes(d.dow) && d.day >= rollout && d.day !== peak?.day);
  const shift = { baseBefore: mean(ordinary.map((d) => d.baseGold)), baseAfter: mean(after.map((d) => d.baseGold)), promoBefore: mean(ordinary.map((d) => d.promoGold)), promoAfter: mean(after.map((d) => d.promoGold)) };
  const shiftPct = shift.baseBefore > 0 ? (shift.baseAfter / shift.baseBefore - 1) * 100 : 0;

  // ---------- 计价金活动：每克让利、克重 ----------
  const baseByDay = new Map(data.gold.filter((g) => g.group === "base" && g.grams > 0).map((g) => [g.day, g.amount / g.grams]));
  const give = (group: OfferGroup) => { let w = 0; let used = 0;
    for (const g of data.gold) if (g.group === group && g.grams > 0 && baseByDay.has(g.day)) { w += (baseByDay.get(g.day)! - g.amount / g.grams) * g.grams; used += g.grams; }
    return used > 0 ? w / used : 0; };
  const goldGroup = (group: OfferGroup) => { const rows = data.gold.filter((g) => g.group === group); const a = sum(rows.map((r) => r.amount));
    return { gramsPerItem: sum(rows.map((r) => r.qty)) > 0 ? sum(rows.map((r) => r.grams)) / sum(rows.map((r) => r.qty)) : 0, ge20: a > 0 ? sum(rows.map((r) => r.ge20)) / a * 100 : 0 }; };
  const g50 = give("k50"), g30 = give("k30"), gGt = give("gt");
  const k50 = goldGroup("k50"), k30 = goldGroup("k30"), gtG = goldGroup("gt"), baseG = goldGroup("base");
  const at = (gram: number) => data.threshold.find((t) => t.gram === gram) ?? { gram, k50: 0, base: 0 };
  const t19 = at(19), t20 = at(20);
  const jump = t19.k50 > 0 && t19.base > 0 && t20.base > 0 ? (t20.k50 / t19.k50) / (t20.base / t19.base) : 0;
  const tr = (group: OfferGroup) => data.tradein.find((t) => t.group === group) ?? { group, orders: 0, tradeIn: 0, sales: 0, recycle: 0 };
  const trGt = tr("gt"), trBase = tr("base");
  const promoTradeIn = ["k50", "k30", "other"].map((g) => tr(g as OfferGroup));
  const promoTradeInShare = share(sum(promoTradeIn.map((t) => t.tradeIn)), sum(promoTradeIn.map((t) => t.orders)));

  // ---------- 解释度分数 ----------
  const areaMax = Math.max(u(uSales, "面积"), u(uSales, "店龄"), u(uSales, "城市级别"));
  // 同一把尺子：这一因素能解释结果差异的百分比（0–100）。分数决定强中弱：≥ 10 强，2–10 中，< 2 弱。
  const S = (value: number, measure: string): InsightScore => ({ value: Math.max(0, Math.min(100, value)), measure });
  const MEASURE = {
    unique: "门店月销售额对数的差异里，这个属性独有解释的比例（8 个门店属性一起回归，拿掉它 R² 掉多少）",
    uniqueGm: "门店毛利率差异里，扣掉货品结构后这个属性独有解释的比例",
    dayEta: "全国逐日销售额对数的差异里，这一项单独解释的比例",
    promo: "去掉门店、日期差异后，有无这三类活动成交还能解释剩余差异的比例（偏 R²）",
    split: "销售额对数的差异里，来自这一项的比例（对数方差拆分）",
    mix: "门店毛利率差异里，单是计价金占比能解释的比例",
    fe: "门店日销售额对数的差异里，这一部分占的比例（门店 + 日期双向固定效应）",
  };
  // 活动机制除了解释度分数，再给一个带单位的效应值，帮业务看懂「差多少」。
  const tradeInShare = share(trGt.tradeIn, trGt.orders);
  const thresholdLift = jump > 0 ? (jump - 1) * 100 : 0;
  const depthGap = Math.max(g30, g50) > 0 ? Math.max(g30, g50) / Math.max(0.01, Math.min(g30, g50)) : 0;
  const aovLift = baseG.gramsPerItem > 0 ? k50.gramsPerItem / baseG.gramsPerItem : 0;
  type Effect = InsightEffect & { strength: InsightStrength };
  const F = (text: string, measure: string, strength: InsightStrength): Effect => ({ text, measure, strength });
  const band = (v: number, strong: number, med: number): InsightStrength => v >= strong ? "strong" : v >= med ? "med" : "weak";
  const ef = {
    depth: F(`克减 50 实让是克减 30 的 ${n1(depthGap)} 倍`, "两档克减的每克实让之比；≥ 1.5 倍为强，1.2–1.5 倍为中", band(depthGap, 1.5, 1.2)),
    threshold: F(`20 克处件数多跳 ${n0(thresholdLift)}%`, "克减 50 在 20 克的件数相对 19 克的跳升，扣掉一般開單同区间的变化；≥ 30% 为强，10–30% 为中", band(thresholdLift, 30, 10)),
    tradein: F(`${tradeInShare >= 99.95 && trGt.tradeIn < trGt.orders ? "99.9%+" : pct(tradeInShare)} 的单带旧金`, "金色星期二订单里带回收旧金的比例；≥ 50% 为强，10–50% 为中", band(tradeInShare, 50, 10)),
    shift: F(`一般開單 ${shiftPct >= 0 ? "+" : "−"}${n1(Math.abs(shiftPct))}%`, "克减铺开前后一般開單计价金日均的变化幅度；≥ 10% 为强，3–10% 为中", band(Math.abs(shiftPct), 10, 3)),
    promoAov: F(`件均克重 ×${n1(aovLift)}`, "克减 50 计价金件均克重是一般開單的几倍；≥ 2 倍为强，1.3–2 倍为中", band(aovLift, 2, 1.3)),
  };
  const sc = {
    image: S(u(uSales, "形象级别"), MEASURE.unique), shoptype: S(u(uSales, "店型"), MEASURE.unique), areaage: S(areaMax, `${MEASURE.unique}；取面积、店龄、城市里最大的一项`),
    region: S(u(uSales, "区域"), MEASURE.unique), natureSales: S(u(uSales, "分店性质"), MEASURE.unique), natureGm: S(u(uGmMix, "分店性质"), MEASURE.uniqueGm),
    qixi: S(etaFestival, MEASURE.dayEta), weekday: S(etaWeekday, MEASURE.dayEta),
    storeOrders: S(feOrders.store, "门店日订单数对数的差异里，门店之间固定差异占的比例（门店 + 日期双向固定效应）"),
    storeAov: S(feAov.store, "门店日客单价对数的差异里，门店之间固定差异占的比例（门店 + 日期双向固定效应）"),
    dayOrders: S(feOrders.day, "门店日订单数对数的差异里，日期差异占的比例（门店 + 日期双向固定效应）"),
    promoOrders: S(fitOrders.r2, "门店日订单数对数的差异里，去掉门店、日期差异后，有无这三类活动成交还能解释的比例（偏 R²）"),
    ordersSales: S(storeSplit.orders, "门店之间销售额的差异里，来自订单数的比例（对数方差拆分：销售额 = 订单数 × 客单价）"),
    aovSales: S(storeSplit.aov, "门店之间销售额的差异里，来自客单价的比例（对数方差拆分；其余是两者同向的部分）"),
    ordersQty: S(qtySplit.orders, "门店之间件数的差异里，来自订单数的比例（对数方差拆分：件数 = 订单数 × 单均件数）"),
    gmGp: S(gpSplit.aov, "门店之间毛利的差异里，来自毛利率的比例（对数方差拆分：毛利 = 不含税销售额 × 毛利率；其余来自销售额）"),
    promoSales: S(fitSales.r2, MEASURE.promo), promoGm: S(fitGm.r2, MEASURE.promo), promoGold: S(fitGold.r2, MEASURE.promo),
    depth: S(fitDepth.r2, "门店日计价金每克实收的差异里，去掉门店、日期差异后，有无克减 30 / 克减 50 成交还能解释的比例（偏 R²）"),
    threshold: S(fitHeavy.r2, "门店日计价金里 20 克以上大件占比的差异，去掉门店、日期差异后，有无克减 50 成交还能解释的比例（偏 R²）"),
    tradein: S(fitGtSales.r2, "门店日销售额对数的差异里，去掉门店、日期差异后，有无金色星期二（以旧换新为主的活动）成交还能解释的比例（偏 R²）"),
    shift: S(fitShift.r2, "门店日计价金里一般開單占比的差异，去掉门店、日期差异后，有无克减成交还能解释的比例（偏 R²）：越高说明活动单越多地替代了一般開單"),
    promoAov: S(fitGrams.r2, "门店日计价金件均克重对数的差异里，去掉门店、日期差异后，有无这三类活动成交还能解释的比例（偏 R²）"),
    mix: S(mixOnly, MEASURE.mix), store: S(fe.store, MEASURE.fe), day: S(fe.day, MEASURE.fe),
  };
  const byScore = (x: InsightScore) => strengthOf(x.value);

  // ---------- 异常、推荐的素材 ----------
  // 门店属性：每个取值的店数、店销售额中位数；样本少于 20 家店的取值不参与比较。
  const attrRows = (key: (s: typeof full[number]) => string) => medianBy(key, (s) => s.sales).filter((r) => r.n >= 20).sort((a, b) => b.m - a.m);
  const short = (k: string) => k.split("/")[0];
  // 同一取值里离群的门店：店销售额高于该取值中位数 3 倍的店数，说明「这一档里也有特别好的店」。
  const outliers = (key: (s: typeof full[number]) => string) => {
    const med = new Map(medianBy(key, (s) => s.sales).map((r) => [r.k, r.m]));
    const hits = full.filter((s) => s.sales > 3 * (med.get(key(s)) ?? Infinity));
    const by = new Map<string, number>(); for (const s of hits) by.set(key(s), (by.get(key(s)) ?? 0) + 1);
    const top = [...by].sort((a, b) => b[1] - a[1])[0];
    return { count: hits.length, top: top ? { k: top[0], n: top[1] } : null };
  };
  // 门店属性的交叉：表现最好的那档里，再按另一属性分，看哪个搭配最高（至少 10 家店）。
  const bestCombo = (a: (s: typeof full[number]) => string, b: (s: typeof full[number]) => string) => {
    const g = new Map<string, number[]>(); for (const s of full) { const k = `${a(s)}\u0000${b(s)}`; g.set(k, [...(g.get(k) ?? []), s.sales]); }
    const rows = [...g].map(([k, v]) => ({ a: k.split("\u0000")[0], b: k.split("\u0000")[1], n: v.length, m: median(v) ?? 0 })).filter((r) => r.n >= 10).sort((x, y) => y.m - x.m);
    return rows[0] ?? null;
  };
  const regionRows = attrRows((s) => s.attr.bigRegion); const areaRows = attrRows((s) => s.attr.area);
  const imageCombo = bestCombo((s) => short(s.attr.image), (s) => s.attr.experience);
  const imageOut = outliers((s) => s.attr.image); const regionOut = outliers((s) => s.attr.bigRegion);
  // 各大区里，同一形象级别的店销售额中位数差多少：差得少说明大区差异主要是门店构成。
  const sameImageAcrossRegions = (() => {
    // 取店数最多的形象级别，样本最稳。
    const top = [...imageRows].sort((a, b) => b.n - a.n)[0]?.k; if (!top) return null;
    const rows = medianBy((s) => s.attr.image === top ? s.attr.bigRegion : "", (s) => s.sales).filter((r) => r.k && r.n >= 20).sort((a, b) => b.m - a.m);
    return rows.length >= 2 ? { image: short(top), hi: rows[0], lo: rows.at(-1)! } : null;
  })();
  // 日期：周几日均（不含节日）；节日里最高的一天和次高的一天。
  const DOW = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const dowRows = DOW.map((name, i) => ({ name, avg: mean(daily.filter((d) => d.dow === i && !d.festival).map((d) => d.sales)) })).filter((r) => r.avg > 0).sort((a, b) => b.avg - a.avg);
  const festSorted = [...festDays].sort((a, b) => b.sales - a.sales);
  const lowDay = [...daily].sort((a, b) => a.sales - b.sales)[0];

  // ---------- 节点 ----------
  const N = (node: InsightNode) => node;
  const imageS = byScore(sc.image); const expS = byScore(sc.shoptype);
  const nodes: InsightNode[] = [
    N({ id: "image", column: 0, section: "门店", kind: "leaf", label: "商圈形象级别", subtitle: `独有贡献 ${pct(u(uSales, "形象级别"))}`, strength: imageS, score: sc.image,
      source: { kind: "field", columns: ["形象级别描述"], how: "门店属性原值，按门店汇总" },
      paragraphs: [`8 个门店属性一起解释门店月销售额对数的 ${pct(uSales.full * 100)}，其中形象级别独有 ${pct(u(uSales, "形象级别"))}。`],
      table: { head: ["形象级别", "店数", "店销售额中位数"], rows: imageRows.filter((r) => r.n >= 20).map((r) => [r.k.split("/")[0], n0(r.n), wan(r.m)]) },
      note: "比较活动效果时要按商圈分层，否则比出来的是商圈差异。" }),
    N({ id: "shoptype", column: 0, section: "门店", kind: "leaf", label: "店型", subtitle: `独有 ${pct(u(uSales, "店型"))} · 客单 ${pct(u(uAov, "店型"))}`, strength: expS, score: sc.shoptype,
      source: { kind: "field", columns: ["零售体验描述"], how: "门店属性原值；「店型」这个叫法是 AI 起的" },
      paragraphs: [`店型（零售体验）对门店销售额独有贡献 ${pct(u(uSales, "店型"))}，对客单价独有 ${pct(u(uAov, "店型"))}。`],
      table: { head: ["店型", "店数", "销售额中位数", "客单中位数"], rows: expRows.slice(0, 5).map((r) => [r.k, n0(r.n), wan(r.m), n0(r.aov)]) } }),
    N({ id: "areaage", column: 0, section: "门店", kind: "leaf", label: "面积、店龄、城市", subtitle: `各独有 ${pct(Math.min(u(uSales, "面积"), u(uSales, "店龄"), u(uSales, "城市级别")))}–${pct(areaMax)}`, strength: byScore(sc.areaage), score: sc.areaage,
      source: { kind: "field", columns: ["分店面积区间", "店龄", "城市级别"], how: "三个门店属性原值", judgement: "三个字段合成一个节点、店龄分成 ≤2 / 3–5 / 6–10 / 10 年以上，是 AI 为了简化做的" },
      paragraphs: [`面积独有 ${pct(u(uSales, "面积"))}、店龄 ${pct(u(uSales, "店龄"))}、城市级别 ${pct(u(uSales, "城市级别"))}。控制了商圈和店型以后，这几项本身的作用不大。`] }),
    N({ id: "region", column: 0, section: "门店", kind: "leaf", label: "大区 / 区域", subtitle: `独有 ${pct(u(uSales, "区域"))}`, strength: byScore(sc.region), score: sc.region,
      source: { kind: "field", columns: ["大区描述", "区域描述"], how: "门店属性原值" },
      paragraphs: [`大区单独看只解释门店日销售额的 ${pct(etaBig)}，区域 ${pct(etaRegion)}；放进多变量后区域独有 ${pct(u(uSales, "区域"))}。`, "看大区好坏之前，要先按门店类型拉平：大区之间的差，多半是各区门店的商圈、店型构成不同。"] }),
    N({ id: "nature", column: 0, section: "门店", kind: "leaf", label: "自营 / 加盟", subtitle: `销售 ${pct(u(uSales, "分店性质"))} · 毛利 ${pct(u(uGmMix, "分店性质"))}`, strength: byScore(sc.natureSales.value >= sc.natureGm.value ? sc.natureSales : sc.natureGm), score: sc.natureSales.value >= sc.natureGm.value ? sc.natureSales : sc.natureGm,
      source: { kind: "field", columns: ["分店性质"], how: "门店属性原值（自营、加盟寄售、加盟批发、合营寄售）" },
      paragraphs: [`对门店销售额独有 ${pct(u(uSales, "分店性质"))}。对毛利率：扣掉货品结构后仍有 ${pct(u(uGmMix, "分店性质"))} 的独有贡献。`],
      table: { head: ["分店性质", "店数", "毛利率中位数"], rows: natureGm.map((r) => [r.k, n0(r.n), pct(r.m)]) },
      note: "原因不明，可能是加盟店进货价口径不同，要问财务。" }),
    N({ id: "qixi", column: 0, section: "时间", kind: "leaf", label: festName, subtitle: peak ? `${day(peak.day)} 一天 ${yi(peak.sales)}` : "数据里没有节日", strength: byScore(sc.qixi), score: sc.qixi,
      source: { kind: "field", columns: ["节庆"], how: `日历表原值${festDays.length ? `，${day(festDays[0].day)}–${day(festDays.at(-1)!.day)} 标为${peak?.festival}` : ""}` },
      paragraphs: peak ? [`${day(peak.day)} 一天 ${yi(peak.sales)}，是普通工作日（${day(rollout)} 之前的周一、三、四，日均 ${yi(ordinaryAvg)}）的 ${n1(peak.sales / ordinaryAvg)} 倍。`] : ["这段时间数据里没有节日。"],
      note: "节日和克减铺开在同一周，节日自己拉多少、活动拉多少拆不开。两年同比按「距节日天数」对齐才能拆。" }),
    N({ id: "weekday", column: 0, section: "时间", kind: "leaf", label: "星期", subtitle: `周二日均 ${yi(tueAvg)}`, strength: byScore(sc.weekday), score: sc.weekday,
      source: { kind: "derived", columns: ["交易日期wid"], how: "由日期算星期几" },
      paragraphs: [`${day(rollout)} 之前，周二日均 ${yi(tueAvg)}，周一、三、四日均 ${yi(ordinaryAvg)}；差额主要在计价金（${yi(tueGold)} 对 ${yi(ordGold)}），这是金色星期二。`, `周末日均 ${yi(weekendAvg)}。`] }),
    N({ id: "depth", column: 0, section: "活动", kind: "leaf", label: "每克让多少", subtitle: `克减30 实让 ${n1(g30)} 元`, strength: byScore(sc.depth), score: sc.depth, effect: { text: ef.depth.text, measure: ef.depth.measure },
      source: { kind: "inferred", columns: ["实际销售金额", "销售金重", "优惠小类", "交易日期wid"], how: "同一天一般開單每克实收 − 活动每克实收，按活动克重加权（一般足金类）", judgement: "把「一般開單」当作没有优惠的对照组，是 AI 的判断；按活动名称里的「克减 30 / 50」归组也是 AI 做的" },
      paragraphs: ["同日对齐后，一般足金类每克实际让利："],
      table: { head: ["活动", "实让（元/克）"], rows: [["克减 30", n1(g30)], ["克减 50", n1(g50)], ["金色星期二", n1(gGt)]] },
      note: "规则表没给，实让和名义的差（克数门槛、叠加规则）要用 Discount Detail 核对。" }),
    N({ id: "threshold", column: 0, section: "活动", kind: "leaf", label: "克重门槛", subtitle: `克减50 在 20 克扎堆`, strength: byScore(sc.threshold), score: sc.threshold, effect: { text: ef.threshold.text, measure: ef.threshold.measure },
      source: { kind: "inferred", columns: ["销售金重", "销售件数", "优惠小类"], how: "按 1 克一档数克减 50 和一般開單的件数（一般足金类）", judgement: "「门槛是 20 克」是 AI 从分布里反推的，规则表没给" },
      paragraphs: [`克减 50 的单件，19 克 ${n0(t19.k50)} 件，20 克 ${n0(t20.k50)} 件；同一区间一般開單是 ${n0(t19.base)} → ${n0(t20.base)} 件。`, `克减 50 的计价金实收 ${pct(k50.ge20)} 在 20 克以上，克减 30 是 ${pct(k30.ge20)}，一般開單 ${pct(baseG.ge20)}。`] }),
    N({ id: "tradein", column: 0, section: "活动", kind: "leaf", label: "以旧换新", subtitle: `星期二 ${pct(share(trGt.recycle, trGt.sales))} 旧金抵`, strength: byScore(sc.tradein), score: sc.tradein, effect: { text: ef.tradein.text, measure: ef.tradein.measure },
      source: { kind: "inferred", columns: ["回收金标识：1：是，0：否", "实际销售金额", "实体分店店号", "销售单号"], how: "同一张单（店号 + 单号）里有回收行的订单数和抵扣金额", judgement: "把件数为 0、金额为负的行理解成以旧换新抵扣的旧金，按单关联到销售，是 AI 的判断" },
      paragraphs: [`金色星期二 ${n0(trGt.orders)} 单里 ${n0(trGt.tradeIn)} 单带回收旧金，旧金抵了 ${yi(trGt.recycle)}，占它 ${yi(trGt.sales)} 成交的 ${pct(share(trGt.recycle, trGt.sales))}。`,
        `一般開單 ${n0(trBase.orders)} 单里 ${n0(trBase.tradeIn)} 单带回收，抵 ${yi(trBase.recycle)}。克减类带回收的单只占 ${pct(promoTradeInShare)}。`, "看金色星期二要看「收了多少新钱」，不是「卖了多少」。"] }),
    N({ id: "shift", column: 0, section: "活动", kind: "leaf", label: "新增还是挪动", subtitle: `一般開單 ${shiftPct >= 0 ? "+" : "−"}${n1(Math.abs(shiftPct))}%`, strength: byScore(sc.shift), score: sc.shift, effect: { text: ef.shift.text, measure: ef.shift.measure },
      source: { kind: "inferred", columns: ["实际销售金额", "优惠小类", "材料种类描述", "交易日期wid"], how: `${day(rollout)} 前后周一、三、四一般開單、活动计价金日均对比`, judgement: `用克减铺开（${day(rollout)}）前后对比来看挪动，是 AI 设计的比较；同期节日的影响没剔掉` },
      paragraphs: [`${day(rollout)} 全国克减铺开后，周一、三、四（不含${peak ? ` ${day(peak.day)}` : "节日当天"}）一般開單计价金日均从 ${wan(shift.baseBefore)} 变为 ${wan(shift.baseAfter)}，活动计价金从 ${wan(shift.promoBefore)} 升到 ${wan(shift.promoAfter)}。`],
      note: "同期离节日更近，新增里混着节日拉动。" }),
    N({ id: "gold", column: 0, section: "缺数据", kind: "leaf", label: "每日金价", subtitle: "跨月跨年比不了", strength: "missing",
      source: { kind: "suggested", columns: [], how: "数据里没有每日金价", judgement: "AI 认为比较活动力度要补每日金价" },
      paragraphs: ["没有每日金价，计价金每克实收里混着金价、工费和让利。", "同日对齐能剔除逐日金价波动，跨月、跨年比较需要每日金价。"] }),
    N({ id: "member", column: 0, section: "缺数据", kind: "leaf", label: "新老会员", subtitle: "分不出新老", strength: "missing",
      source: { kind: "suggested", columns: ["是否会员销售（1：是，0：否）"], how: `原字段只有是不是会员，${pct(data.memberShare)} 的销售额都标为会员`, judgement: "新老会员是业务提的问题，要补会员 ID 和首购日期" },
      paragraphs: [`明细里有「是否会员销售」，但 ${pct(data.memberShare)} 的销售额都是会员，分不出新老。`, "要会员 ID 和首购日期，才能回答「这个活动对新会员、老会员效果是否不同」。"] }),

    N({ id: "store", column: 1, kind: "factor", label: "门店本身", subtitle: `销售额波动的 ${pct(fe.store)}`, score: sc.store,
      source: { kind: "grouping", columns: ["实体分店店号"], how: `门店日销售额对数做门店 + 日期双向固定效应，门店那部分占 ${pct(fe.store)}`, judgement: "把商圈、店型、面积等归成「门店本身」，以及用这个模型拆分，是 AI 的做法" },
      paragraphs: [`把每家店每天的对数销售额拆开：门店之间的固定差异占 ${pct(fe.store)}，日期占 ${pct(fe.day)}，剩下 ${pct(fe.resid)} 是店内逐日波动。`, `毛利率不一样：门店占 ${pct(feGm.store)}，日期只占 ${pct(feGm.day)}。`] }),
    N({ id: "day", column: 1, kind: "factor", label: "日期和活动", subtitle: `销售额波动的 ${pct(fe.day)}`, score: sc.day,
      source: { kind: "grouping", columns: ["交易日期wid", "节庆"], how: `同一个模型里日期那部分占 ${pct(fe.day)}`, judgement: "日期和当天有什么活动分不开，AI 把它们归成一类" },
      paragraphs: [`全国一天卖多少差很多：普通工作日日均 ${yi(ordinaryAvg)}${peak ? `，${festName}当天 ${yi(peak.sales)}` : ""}。`, `日期和当天活动分不开：${day(rollout)} 以后全国克减铺开${peak ? `，${festName}在 ${day(peak.day)}` : ""}。`] }),
    N({ id: "promo", column: 1, kind: "factor", label: "活动和力度", subtitle: `当天销售 ${times(Math.min(...promoSales))}–${times(Math.max(...promoSales))}`, score: sc.promoSales,
      source: { kind: "grouping", columns: ["优惠小类"], how: "同店同日对比有无克减 50 / 克减 30 / 金色星期二成交", judgement: "按名称把优惠小类归成克减 50、克减 30、金色星期二、一般開單几组，是 AI 做的" },
      paragraphs: ["同一家店、同一天比，这家店当天有没有这个活动的成交：", "活动压毛利率，主要是因为卖的货更偏计价金。"],
      table: { head: ["", "当天销售额", "毛利率", "计价金占比"], rows: PROMO.map((name, i) => [name, times(promoSales[i]), pp(promoGm[i]), pp(promoGold[i])]) },
      note: "门店自己选哪天做，又和节日同周，倍数会高估活动本身。" }),
    N({ id: "mix", column: 1, kind: "factor", label: "货品结构", subtitle: `毛利率差异的 ${pct(mixOnly)}`, score: sc.mix,
      source: { kind: "grouping", columns: ["材料种类描述", "实际销售金额"], how: "计价金占销售额比例", judgement: "按材料种类把货归成计价金（足金）、一口价黄金（定价足金）、镶嵌及其他，是 AI 的分法" },
      paragraphs: [`门店之间毛利率差多少，单是「计价金占销售额多少」一个数就解释了 ${pct(mixOnly)}。`, `8 个门店属性一起只解释毛利率的 ${pct(uGm.full * 100)}；加上货品结构到 ${pct(uGmMix.full * 100)}。`],
      table: { head: ["货类", "销售额占比", "毛利占比", "毛利率"], rows: [gold, fixed, inlay].map((p) => [p.ptype, pct(share(p.sales, total.sales)), pct(share(p.gp, total.gp)), pct(ptGm(p))]) } }),

    N({ id: "orders", column: 2, kind: "decomp", label: "订单数", subtitle: `门店间差异 ${pct(storeSplit.orders)}`,
      source: { kind: "derived", columns: ["实体分店店号", "销售单号"], how: "店号 + 销售单号去重计数（单号跨店会重复）" },
      paragraphs: [`销售额 = 订单数 × 客单价。门店之间销售额差多少，${pct(storeSplit.orders)} 是订单数的差，客单价占 ${pct(storeSplit.aov)}（其余是两者同向）。全国逐日看，订单数占 ${pct(daySplit.orders)}。`],
      note: "客流和转化率缺数据，订单数再往下拆不了。" }),
    N({ id: "aov", column: 2, kind: "decomp", label: "客单价", subtitle: `门店间差异 ${pct(storeSplit.aov)}`,
      source: { kind: "derived", columns: ["实际销售金额", "实体分店店号", "销售单号"], how: "销售额 ÷ 订单数" },
      paragraphs: [`8 月客单 ${n0(total.orders > 0 ? total.sales / total.orders : 0)} 元。门店属性里，店型对客单独有 ${pct(u(uAov, "店型"))}，形象级别 ${pct(u(uAov, "形象级别"))}。`, `力度大的活动卖大件：克减 50 计价金件均 ${n1(k50.gramsPerItem)} 克，金色星期二 ${n1(gtG.gramsPerItem)} 克，一般開單 ${n1(baseG.gramsPerItem)} 克。`] }),
    N({ id: "gm", column: 2, kind: "decomp", label: "毛利率", subtitle: "结构 + 让利",
      source: { kind: "derived", columns: ["零售毛利", "rsv"], how: "零售毛利 ÷（rsv ÷ 1.13）", judgement: "rsv 含 13% 增值税、零售毛利不含税，是在 9/8 样例上逐行核对过的；还没和财务确认" },
      paragraphs: [`毛利 = 不含税销售额 × 毛利率。毛利率由两件事决定：卖了什么货（结构），让了多少（活动）。8 月整体 ${pct(gm)}。`] }),

    N({ id: "qty", column: 3, kind: "metric", label: "销量", subtitle: `${n0(total.items / 1e4)} 万件 · ${n0(gold.grams / 1000)} 公斤`,
      source: { kind: "field", columns: ["销售件数", "销售金重"], how: "直接加总" },
      paragraphs: [`${n0(total.items / 1e4)} 万件；计价金按克卖，共 ${n0(gold.grams / 1000)} 公斤，件均 ${n1(gold.items > 0 ? gold.grams / gold.items : 0)} 克。`, `门店日件数的波动里，门店差异占 ${pct(feItems.store)}，日期占 ${pct(feItems.day)}。`] }),
    N({ id: "sales", column: 3, kind: "metric", label: "销售额", subtitle: `${yi(total.sales)}（含税）`,
      source: { kind: "field", columns: ["实际销售金额"], how: "直接加总", judgement: "只算件数 > 0 且金额 > 0 的正常销售行，回收、退货另看；这个口径是 AI 定的，还没和 Power BI 对数" },
      paragraphs: [`正常销售行实收 ${yi(total.sales)}，${n1(total.orders / 1e4)} 万单，客单 ${n0(total.orders > 0 ? total.sales / total.orders : 0)} 元。计价金占 ${pct(share(gold.sales, total.sales))}，一口价黄金 ${pct(share(fixed.sales, total.sales))}，镶嵌及其他 ${pct(share(inlay.sales, total.sales))}。`],
      note: "还没和 Power BI 对数，绝对额先只作参考。" }),
    N({ id: "gp", column: 3, kind: "metric", label: "毛利", subtitle: `${yi(total.gp)} · 毛利率 ${pct(gm)}`,
      source: { kind: "field", columns: ["零售毛利"], how: "直接加总" },
      paragraphs: [`零售毛利 ${yi(total.gp)}，毛利率 ${pct(gm)}（毛利 ÷ 不含税 RSV）。`, `计价金卖了 ${pct(share(gold.sales, total.sales))} 的钱，贡献 ${pct(share(gold.gp, total.gp))} 的毛利；镶嵌及其他卖 ${pct(share(inlay.sales, total.sales))}、贡献 ${pct(share(inlay.gp, total.gp))}。`] }),
  ];

  // ---------- 同类店对比、离群店（peers.ts） ----------
  const peerOf = new Map<string, PeerStore>();
  for (const p of panel) {
    const a = attrOf.get(p.store); if (!a) continue;
    const s = peerOf.get(p.store) ?? { id: p.store, name: a.name, image: a.image, shopType: a.shopType, region: a.region, bigRegion: a.bigRegion, days: 0, sales: 0, gp: 0, revEx: 0, orders: 0, items: 0, gold: 0, baseGold: 0, heavyGold: 0, goldGrams: 0, goldQty: 0, promoDays: 0 };
    s.days++; s.sales += p.sales; s.gp += p.gp; s.revEx += p.revEx; s.orders += p.orders; s.items += p.items; s.gold += p.goldSales; s.baseGold += p.baseGold; s.heavyGold += p.heavyGold; s.goldGrams += p.goldGrams; s.goldQty += p.goldQty; if (p.k50 || p.k30 || p.gt) s.promoDays++;
    peerOf.set(p.store, s);
  }
  const peerAll = [...peerOf.values()].filter((s) => s.orders > 0);
  // 对比只用开满 20 天的店；离群用全部有成交的店，营业天数少的单独归为数据不完整。
  const groupsFull = peerGroups(peerAll.filter((s) => s.days >= 20)); const groupsAll = peerGroups(peerAll);
  const div = (a: number, b: number) => b > 0 ? a / b : NaN;
  const yuan = (v: number) => `${n0(v)} 元`;
  const money = (v: number) => v >= 1e4 ? wan(v) : yuan(v);
  const M: Record<string, PeerMetric> = {
    goldShare: { label: "计价金占比", of: (x) => div(x.gold, x.sales) * 100, kind: "pp", fmt: pct },
    gm: { label: "毛利率", of: (x) => div(x.gp, x.revEx) * 100, kind: "pp", fmt: pct },
    baseShare: { label: "一般開單占计价金比例", of: (x) => div(x.baseGold, x.gold) * 100, kind: "pp", fmt: pct },
    heavyShare: { label: "20 克以上大件占计价金比例", of: (x) => div(x.heavyGold, x.gold) * 100, kind: "pp", fmt: pct },
    perGram: { label: "计价金每克实收", of: (x) => div(x.gold, x.goldGrams), kind: "log", fmt: (v) => `${n0(v)} 元/克` },
    gramsPerItem: { label: "计价金件均克重", of: (x) => div(x.goldGrams, x.goldQty), kind: "log", fmt: (v) => `${n1(v)} 克` },
    promoDays: { label: "有活动成交的天数占比", of: (x) => div(x.promoDays, x.days) * 100, kind: "pp", fmt: pct },
    sales: { label: "月销售额", of: (x) => x.sales, kind: "log", fmt: money },
    dailySales: { label: "日均销售额", of: (x) => div(x.sales, x.days), kind: "log", fmt: money },
    dailyOrders: { label: "日均订单数", of: (x) => div(x.orders, x.days), kind: "log", fmt: (v) => `${n1(v)} 单` },
    aov: { label: "客单价", of: (x) => div(x.sales, x.orders), kind: "log", fmt: yuan },
  };
  const peers = {
    mix: comparePeers(groupsFull, M.goldShare, M.gm, -1),
    shift: comparePeers(groupsFull, M.baseShare, M.dailySales, -1),
    threshold: comparePeers(groupsFull, M.heavyShare, M.aov, 1),
    depth: comparePeers(groupsFull, M.perGram, M.gm, 1),
    promoAov: comparePeers(groupsFull, M.gramsPerItem, M.aov, 1),
    promoOrders: comparePeers(groupsFull, M.promoDays, M.dailyOrders, 1),
  };
  // 离群店：销售额拆成营业天数 × 日均单数 × 客单价；客单价拆成单均件数 × 件均单价；毛利率看计价金占比。
  const salesOut = findOutliers(groupsAll, { metric: M.sales, explain: mainPart([
    { label: "营业天数", of: (x) => x.days, fmt: (v) => `${n0(v)} 天`, incomplete: true },
    { label: "日均订单数", of: M.dailyOrders.of, fmt: M.dailyOrders.fmt },
    { label: "客单价", of: M.aov.of, fmt: yuan },
  ]), incomplete: (x) => x.days < 10 });
  const aovOut = findOutliers(groupsFull, { metric: M.aov, explain: mainPart([
    { label: "单均件数", of: (x) => div(x.items, x.orders), fmt: (v) => `${n1(v)} 件` },
    { label: "件均单价", of: (x) => div(x.sales, x.items), fmt: yuan },
  ]) });
  const gmOut = findOutliers(groupsFull, { metric: M.gm, explain: (x, group, high) => {
    const m = median(group.map(M.goldShare.of).filter(Number.isFinite)) ?? 0; const v = M.goldShare.of(x);
    // 毛利率偏高对应计价金卖得少，偏低对应卖得多；差不到 10pp 就说看不出原因，不硬套。
    // 计价金几乎为 0 的多是不卖足金的子品牌店（名字里看得出来），直接说「不卖计价金」。
    if (high && v < 1 && m >= 10) return { label: `不卖计价金：同类计价金占比 ${pct(m)}` };
    return (high ? m - v : v - m) >= 10 ? { label: `计价金占比${high ? "低" : "高"}：${pct(v)}（同类 ${pct(m)}）` } : { label: "货品结构和同类差不多，数据里看不出原因（可能是进货价或折扣口径）" };
  } });
  const withPeers = (e: InsightEdge, x: ReturnType<typeof comparePeers>): InsightEdge => {
    if (!x) return e;
    // 关系成立时把落后的店放进推荐；关系不成立或方向相反时进异常提醒。
    const anomalies = x.verdict === "reverse" ? [...e.anomalies, `同类店里看，方向和这条线相反：${x.text}`] : e.anomalies;
    return { ...e, peers: x, anomalies };
  };

  // ---------- 连线 ----------
  // 有分数的线：档位由分数换算。恒等式、缺数据没有分数。
  // more：异常（数据里能看到的特殊案例和共同点）、推荐（表现最好的取值和搭配）。推荐给不出时写原因。
  type More = { anomalies?: string[]; recommendation?: string | null; noRecommendation?: string };
  // 有分数的线可以另带一个效应值（effect），作为分数之外的直观说明。
  // 拆解线（恒等式）也给分数，但档位保持「拆解」，画成灰线，和因素线区分。
  const E = (from: InsightNodeId, to: InsightNodeId, x: (InsightScore & { effect?: Effect; identity?: boolean }) | "id" | "missing", basis: string, more: More = {}): InsightEdge => {
    const rest = { basis, anomalies: more.anomalies ?? [], recommendation: more.recommendation ?? null, ...(more.recommendation ? {} : { noRecommendation: more.noRecommendation ?? (x === "id" ? "这是恒等式，没有可选的取值。" : x === "missing" ? "没有数据，推荐不了。" : "关系太弱，按它挑门店或时间意义不大。") }) };
    if (typeof x === "string") return { from, to, strength: x, ...rest };
    const { effect, identity, ...score } = x;
    const restId = identity ? { ...rest, recommendation: null, noRecommendation: "这是恒等式拆解，没有可选的取值；分数说明结果的差异主要来自哪一项。" } : rest;
    return { from, to, strength: identity ? "id" : byScore(score), score, ...(effect ? { effect: { text: effect.text, measure: effect.measure } } : {}), ...restId };
  };
  const raw: InsightEdge[] = [
    E("image", "store", sc.image, `形象级别单独解释门店月销售额差异的 ${pct(u(uSales, "形象级别"))}，8 个门店属性里最大。店销售额中位数：${imageRows.filter((r) => r.n >= 20).map((r) => `${r.k.split("/")[0]} ${wan(r.m)}`).join("，")}。`, { anomalies: [
      ...(imageOut.top ? [`每一档里都有特别好的店：店销售额超过本档中位数 3 倍的有 ${n0(imageOut.count)} 家，其中「${short(imageOut.top.k)}」最多（${n0(imageOut.top.n)} 家）。`] : []),
      ...(imageRows.length >= 2 ? [`最高档「${short(imageRows[0].k)}」只有 ${n0(imageRows[0].n)} 家店，样本比其他档少，中位数波动会大一些。`] : []) ],
      recommendation: imageCombo ? `店销售额中位数最高的搭配是「${imageCombo.a}」+「${imageCombo.b}」：${n0(imageCombo.n)} 家店，中位数 ${wan(imageCombo.m)}。比较活动效果时先按形象级别分层。` : null }),
    E("shoptype", "store", sc.shoptype, `店型独有解释 ${pct(u(uSales, "店型"))}。${expRows.slice(0, 3).map((r) => `${r.k} 中位数 ${wan(r.m)}`).join("，")}。`, { anomalies: expRows.length && expRows[0].n < 30 ? [`最高的「${expRows[0].k}」只有 ${n0(expRows[0].n)} 家店，是少数旗舰店，不代表同类店都能做到。`] : [],
      recommendation: expRows.length >= 2 ? `店数够多（≥ 100 家）的店型里，「${(expRows.find((r) => r.n >= 100) ?? expRows[0]).k}」店销售额中位数最高（${wan((expRows.find((r) => r.n >= 100) ?? expRows[0]).m)}）。` : null }),
    E("areaage", "store", sc.areaage, `面积独有 ${pct(u(uSales, "面积"))}、店龄 ${pct(u(uSales, "店龄"))}、城市级别 ${pct(u(uSales, "城市级别"))}，控制商圈和店型后都不大。`, { anomalies: areaRows.length >= 2 ? [`面积最大的一档不一定卖得最多：店销售额中位数最高的是「${areaRows[0].k}」（${wan(areaRows[0].m)}，${n0(areaRows[0].n)} 家）。`] : [],
      noRecommendation: "控制商圈和店型以后这几项作用都不大，按它们挑门店意义不大。" }),
    E("region", "store", sc.region, `大区只解释门店日销售额的 ${pct(etaBig)}，区域 ${pct(etaRegion)}；多变量里区域独有 ${pct(u(uSales, "区域"))}。大区差异多半是门店构成差异。`, { anomalies: [
      ...(sameImageAcrossRegions ? [`同是「${sameImageAcrossRegions.image}」的店，${sameImageAcrossRegions.hi.k}中位数 ${wan(sameImageAcrossRegions.hi.m)}，${sameImageAcrossRegions.lo.k} ${wan(sameImageAcrossRegions.lo.m)}：拉平商圈以后大区之间仍有差距，但比门店类型之间的差小。`] : []),
      ...(regionOut.top ? [`特别好的店（超过本大区中位数 3 倍）${regionOut.top.k}最多，${n0(regionOut.top.n)} 家，可以从这些店找共性。`] : []) ],
      noRecommendation: regionRows.length ? `大区本身作用很弱（独有 ${pct(u(uSales, "区域"))}），先按商圈和店型拉平再比大区。` : undefined }),
    E("nature", "store", sc.natureSales, `对销售额独有 ${pct(u(uSales, "分店性质"))}；扣掉货品结构后对毛利率独有 ${pct(u(uGmMix, "分店性质"))}。`, { anomalies: natureGm.length >= 2 ? [`毛利率上有差别：${natureGm[0].k}中位数 ${pct(natureGm[0].m)}，${natureGm.at(-1)!.k} ${pct(natureGm.at(-1)!.m)}；原因不明，可能是进货价口径不同，要问财务。`] : [],
      noRecommendation: "对销售额几乎没有独立作用。" }),
    E("qixi", "day", sc.qixi, peak ? `${day(peak.day)} ${festName}一天 ${yi(peak.sales)}，普通工作日日均 ${yi(ordinaryAvg)}。` : "数据里没有节日。", { anomalies: [
      ...(festSorted.length >= 2 ? [`节日期间并不是每天都高：${festName}当天 ${yi(festSorted[0].sales)}，同期最低的 ${day(festSorted.at(-1)!.day)} 只有 ${yi(festSorted.at(-1)!.sales)}。`] : []),
      "节日和克减铺开在同一周，节日自己拉多少、活动拉多少拆不开。" ],
      recommendation: peak ? `${festName}当天（${day(peak.day)}）是全月最高；排活动时把力度集中在节日前几天和当天，两年同比按「距节日天数」对齐。` : null }),
    E("weekday", "day", sc.weekday, `${day(rollout)} 前周二日均 ${yi(tueAvg)}，周一、三、四 ${yi(ordinaryAvg)}，差额主要在计价金（金色星期二）。`, { anomalies: lowDay ? [`全月最低的一天是 ${day(lowDay.day)}（${DOW[lowDay.dow]}），${yi(lowDay.sales)}。`] : [],
      recommendation: dowRows.length ? `不含节日，日均最高的是${dowRows[0].name}（${yi(dowRows[0].avg)}），最低的是${dowRows.at(-1)!.name}（${yi(dowRows.at(-1)!.avg)}）。周二高是金色星期二带的。` : null }),
    E("depth", "promo", { ...sc.depth, effect: ef.depth }, `同日对齐的每克实让：克减 30 是 ${n1(g30)} 元，克减 50 是 ${n1(g50)} 元，金色星期二 ${n1(gGt)} 元。`, { anomalies: [`克减 30 实让 ${n1(g30)} 元/克，不到名义的 30 元；可能有克数门槛或叠加规则，规则表没给。`, `金色星期二每克只让 ${n1(gGt)} 元，它的优惠在旧金抵价上，不在每克实收里。`],
      recommendation: `同日对齐看，克减 50 每克实让 ${n1(g50)} 元，是克减 30 的 ${n1(depthGap)} 倍；定力度时要和它带来的件均克重（×${n1(aovLift)}）一起看。` }),
    E("threshold", "promo", { ...sc.threshold, effect: ef.threshold }, `克减 50 的件数在 19 克是 ${n0(t19.k50)} 件、20 克 ${n0(t20.k50)} 件，一般開單同区间 ${n0(t19.base)} → ${n0(t20.base)} 件；克减 50 计价金实收 ${pct(k50.ge20)} 在 20 克以上。`, { anomalies: [`一般開單同区间是往下走的（${n0(t19.base)} → ${n0(t20.base)} 件），只有克减 50 在 20 克跳起来。`],
      recommendation: `克减 50 的计价金实收 ${pct(k50.ge20)} 在 20 克以上（克减 30 是 ${pct(k30.ge20)}），门槛在把顾客推向 20 克以上；门槛是 20 克要用规则表确认。` }),
    E("tradein", "promo", { ...sc.tradein, effect: ef.tradein }, `金色星期二 ${n0(trGt.orders)} 单里 ${n0(trGt.tradeIn)} 单带回收旧金，抵 ${yi(trGt.recycle)}，占成交 ${pct(share(trGt.recycle, trGt.sales))}；克减类带回收 ${pct(promoTradeInShare)}。`, { anomalies: [`克减类几乎不带回收旧金（${pct(promoTradeInShare)}），以旧换新基本只在金色星期二和一般開單里。`],
      recommendation: `看金色星期二要用「成交 − 旧金抵扣」看收进的新钱：成交 ${yi(trGt.sales)}，其中 ${yi(trGt.recycle)} 是旧金抵的。` }),
    E("shift", "promo", { ...sc.shift, effect: ef.shift }, `克减铺开后一般開單计价金日均 ${wan(shift.baseBefore)} → ${wan(shift.baseAfter)}（${shiftPct >= 0 ? "+" : "−"}${n1(Math.abs(shiftPct))}%），活动计价金 ${wan(shift.promoBefore)} → ${wan(shift.promoAfter)}。`, { anomalies: ["同期离节日更近，新增里混着节日拉动，挪动的比例可能被低估。"],
      recommendation: `大部分像新增：一般開單只降了 ${n1(Math.abs(shiftPct))}%，活动计价金从 ${wan(shift.promoBefore)} 涨到 ${wan(shift.promoAfter)}。` }),
    E("gold", "promo", "missing", "没有每日金价。同日对齐只能剔除逐日波动，跨月、跨年比较活动力度要补金价。", { noRecommendation: "需要先采集每日金价。" }),
    E("member", "orders", "missing", `${pct(data.memberShare)} 的销售额都标为会员，分不出新老，算不了活动对新老会员的单量影响。`, { noRecommendation: "需要先采集会员 ID 和首购日期。" }),
    E("store", "orders", sc.storeOrders, `门店日订单数的差异里，门店之间的固定差异占 ${pct(feOrders.store)}。门店属性里，形象级别对门店订单数独有解释 ${pct(u(uOrders, "形象级别"))}。`, { recommendation: `拉销售额主要靠单量：门店之间差多少，${pct(storeSplit.orders)} 是订单数的差。` }),
    E("store", "aov", sc.storeAov, `门店日客单价的差异里，门店之间的固定差异占 ${pct(feAov.store)}。门店属性里，店型对客单独有 ${pct(u(uAov, "店型"))}、形象级别 ${pct(u(uAov, "形象级别"))}。`, { recommendation: expRows.length ? `客单最高的店型：${[...expRows].sort((a, b) => b.aov - a.aov)[0].k}（中位数 ${n0([...expRows].sort((a, b) => b.aov - a.aov)[0].aov)} 元）。` : null }),
    E("day", "orders", sc.dayOrders, `门店日订单数的差异里，日期差异占 ${pct(feOrders.day)}；全国逐日销售额的波动 ${pct(daySplit.orders)} 来自订单数。`, { recommendation: `逐日看销售额的波动 ${pct(daySplit.orders)} 在单量；排期要看哪天能多来人，而不是哪天客单高。` }),
    E("promo", "orders", sc.promoOrders, `同一家店、同一天，有${PROMO.join(" / ")}成交那天，销售额分别是平时的 ${promoSales.map(times).join(" / ")}，主要多在单量上。`, { anomalies: ["门店自己选哪天做活动，又和节日同周，倍数会高估活动本身。"],
      recommendation: `同店同日看，${PROMO[promoSales.indexOf(Math.max(...promoSales))]}当天销售额倍数最高（${times(Math.max(...promoSales))}）。` }),
    E("promo", "aov", { ...sc.promoAov, effect: ef.promoAov }, `力度大的活动卖大件：克减 50 计价金件均 ${n1(k50.gramsPerItem)} 克，金色星期二 ${n1(gtG.gramsPerItem)} 克，一般開單 ${n1(baseG.gramsPerItem)} 克。`, { recommendation: `力度大的活动卖大件：克减 50 件均 ${n1(k50.gramsPerItem)} 克，是一般開單的 ${n1(aovLift)} 倍。` }),
    E("promo", "gm", sc.promoGm, `同一家店、同一天，有活动成交那天毛利率 ${PROMO.map((name, i) => `${name} ${pp(promoGm[i])}`).join("，")}。`, { anomalies: [`活动压毛利率主要是因为卖的货更偏计价金（见「活动和力度 → 货品结构」）。`],
      recommendation: `毛利率降得最少的是${PROMO[promoGm.indexOf(Math.max(...promoGm))]}（${pp(Math.max(...promoGm))}）。` }),
    E("promo", "mix", sc.promoGold, `同一家店、同一天，有活动成交那天计价金占比 ${PROMO.map((name, i) => `${name} ${pp(promoGold[i])}`).join("，")}。活动压毛利率主要走这条路。`, { recommendation: `计价金占比抬得最少的是${PROMO[promoGold.indexOf(Math.min(...promoGold))]}（${pp(Math.min(...promoGold))}）；想保毛利，活动里配一口价、镶嵌货。` }),
    E("mix", "gm", sc.mix, `只看计价金占比一个数，就解释门店毛利率差异的 ${pct(mixOnly)}。计价金毛利率 ${pct(ptGm(gold))}，一口价黄金 ${pct(ptGm(fixed))}，镶嵌及其他 ${pct(ptGm(inlay))}。`, { anomalies: [`计价金卖了 ${pct(share(gold.sales, total.sales))} 的钱，只贡献 ${pct(share(gold.gp, total.gp))} 的毛利。`],
      recommendation: `毛利率最高的是镶嵌及其他（${pct(ptGm(inlay))}），其次一口价黄金（${pct(ptGm(fixed))}）；保毛利要提这两类的占比。` }),
    E("orders", "qty", { ...sc.ordersQty, identity: true }, `恒等式：件数 = 订单数 × 单均件数（这段时间 ${(total.orders > 0 ? total.items / total.orders : 0).toFixed(2)} 件/单）。门店之间件数的差异，${pct(qtySplit.orders)} 来自订单数。`),
    E("orders", "sales", { ...sc.ordersSales, identity: true }, `恒等式：销售额 = 订单数 × 客单价。门店间差异 ${pct(storeSplit.orders)}、逐日波动 ${pct(daySplit.orders)} 在订单数这一项。`),
    E("aov", "sales", { ...sc.aovSales, identity: true }, `恒等式：销售额 = 订单数 × 客单价。客单价占门店间差异的 ${pct(storeSplit.aov)}、逐日波动的 ${pct(daySplit.aov)}。`),
    E("gm", "gp", { ...sc.gmGp, identity: true }, `恒等式：毛利 = 不含税销售额 × 毛利率。门店之间毛利的差异，${pct(gpSplit.aov)} 来自毛利率，${pct(gpSplit.orders)} 来自销售额。`),
  ];

  const extra: Partial<Record<string, { peers?: ReturnType<typeof comparePeers>; outliers?: string[] }>> = {
    "mix>gm": { peers: peers.mix, outliers: gmOut }, "shift>promo": { peers: peers.shift }, "threshold>promo": { peers: peers.threshold },
    "depth>promo": { peers: peers.depth }, "promo>aov": { peers: peers.promoAov }, "promo>orders": { peers: peers.promoOrders },
    "orders>sales": { outliers: salesOut }, "store>aov": { outliers: aovOut },
  };
  const edges = raw.map((e) => { const x = extra[`${e.from}>${e.to}`]; if (!x) return e;
    const withOut = x.outliers?.length ? { ...e, anomalies: [...x.outliers, ...e.anomalies] } : e;
    return withPeers(withOut, x.peers ?? null); });

  const kpis: InsightKpi[] = [
    { id: "sales", label: "销售额", value: n1(total.sales / 1e8), unit: "亿", detail: `${n1(total.orders / 1e4)} 万单 · 客单 ${n0(total.orders > 0 ? total.sales / total.orders : 0)} 元` },
    { id: "gp", label: "毛利", value: n1(total.gp / 1e8), unit: "亿", detail: `毛利率 ${pct(gm)}（不含税口径）` },
    { id: "qty", label: "销量", value: n0(total.items / 1e4), unit: "万件", detail: `计价金 ${n0(gold.grams / 1000)} 公斤 · 件均 ${n1(gold.items > 0 ? gold.grams / gold.items : 0)} 克` },
  ];
  const summary = [
    `销售额主要看订单数：门店之间的差异 ${pct(storeSplit.orders)} 来自订单数，客单价只占 ${pct(storeSplit.aov)}。`,
    `门店差异主要来自商圈和店型（独有 ${pct(u(uSales, "形象级别"))}、${pct(u(uSales, "店型"))}），大区、区域本身只有 ${pct(u(uSales, "区域"))}。`,
    `毛利率主要看卖了什么货（计价金占比解释 ${pct(mixOnly)}）；活动当天计价金占比高、毛利率低。`,
  ];
  const methods = [
    { title: "门店、日期各占多少", text: `${n0(panel.length / 1e4)} 万个门店日的对数销售额，做门店 + 日期双向固定效应分解。` },
    { title: "哪个门店属性有用", text: `${n0(full.length)} 家开满 20 天的店，8 个属性一起回归，逐个拿掉看 R² 掉多少（独有贡献）。属性之间相关，单看一个会重复算。` },
    { title: "活动带来多少", text: "同一家店、同一天对比（双向去均值），看这家店当天有没有克减 50、克减 30、金色星期二成交。门店自己决定哪天做，仍可能有自选偏差。" },
    { title: "每克让多少", text: "同一天一般開單计价金每克实收减活动每克实收，按活动克重加权，剔除金价逐日波动。" },
    { title: "解释度分数", text: "每条线标一个 0–100 的分数：这一因素能解释结果差异的百分比。门店属性用多变量回归的独有贡献，日期用逐日差异的单变量解释度，活动和活动机制用去掉门店、日期差异后的偏 R²。≥ 10 为强、2–10 为中、不到 2 为弱。活动机制另附一个效应值（如「克减 50 实让是克减 30 的 2.2 倍」）帮助理解差多少。恒等式和缺数据的线没有分数。" },
    { title: "口径", text: "只算正常销售行（件数 > 0 且金额 > 0）；毛利率 = 零售毛利 ÷ 不含税 RSV；回收旧金、退货单独看。还没和 Power BI 对数。" },
  ];
  return { schema: "insight-drivers/v2", datasetVersion: data.datasetVersion, builtAt,
    scope: { period: data.period, rows: data.rows, stores: storeCount, note: "一个月数据，只是相关" }, kpis, nodes, edges, summary, methods };
}
