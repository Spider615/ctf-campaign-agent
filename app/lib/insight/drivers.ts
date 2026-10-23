// 从 Agent 查回来的聚合数据算出指标影响因素图谱：先算统计量，再用模板拼出节点、连线和依据。
// 图上的数字全部出自这里，文字是模板，不经过模型。
import { comparePeers, mainPart, outlierTable, peerGroups, shortStoreName, type PeerMetric, type PeerStore } from "./peers.ts";
import { etaSquared, logLinearFit, logSplit, median, rSquared, strengthOf, twoWayShares, uniqueContributions, withinStoreDayFit } from "./stats.ts";
import type { InsightChart, InsightEdge, InsightEffect, InsightGraph, InsightKpi, InsightNode, InsightNodeId, InsightScore, InsightStrength } from "./types.ts";

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
// 百分点差：带方向的白话（高/低、多/少），不到 0.05 的写「基本没差」。
const gap = (v: number, up: string, down: string) => Math.abs(v) < 0.05 ? "基本没差" : `${v > 0 ? up : down} ${n1(Math.abs(v))} 个百分点`;
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
  const panelGm = Float64Array.from(panel, (p) => p.gp / p.revEx * 100);
  // 门店、日期对订单数和客单价各自的影响（双向固定效应）：「门店本身 → 订单数」这类线用它。
  const logOrders = Float64Array.from(panel, (p) => Math.log(Math.max(1, p.orders)));
  const feOrders = twoWayShares(sKeys, dKeys, logOrders);
  const feAov = twoWayShares(sKeys, dKeys, Float64Array.from(panel, (p) => Math.log(p.sales / Math.max(1, p.orders))));

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
  const yStoreAov = Float64Array.from(full, (s) => Math.log(s.sales / s.orders));
  const yStoreGm = Float64Array.from(full, (s) => s.gp / s.revEx * 100);
  const goldShare = Float64Array.from(full, (s) => s.gold / s.sales * 100);
  const uSales = uniqueContributions(attrs, yStoreSales);
  const uAov = uniqueContributions(attrs, yStoreAov);
  const uGmMix = uniqueContributions(attrs, yStoreGm, [goldShare]);
  const mixOnly = rSquared([new Float64Array(full.length).fill(1), goldShare], yStoreGm) * 100;
  const u = (r: { unique: Record<string, number> }, k: string) => Math.max(0, r.unique[k] * 100);
  const storeSplit = logSplit(full.map((s) => s.sales), full.map((s) => s.orders));
  // 订单数 ↔ 客单价：门店间横截面的真实回归关系（不是恒等式），供拖动联动用。月度聚合上算斜率，换算到日均展示不改变斜率。
  const ordersAovFit = logLinearFit(full.map((s) => s.orders), full.map((s) => s.sales / s.orders));
  // 滑块的可拖动范围是各自变量日均口径的 2%–98% 分位（样本实际分布），不是回归线算出来的建议值区间。
  const quantile = (values: readonly number[], p: number) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] ?? 0; };
  const dailyOrders = full.map((s) => s.orders / s.days); const dailyAov = full.map((s) => s.sales / s.orders);
  const midStore = [...full].sort((a, b) => a.orders / a.days - b.orders / b.days)[Math.floor(full.length / 2)];
  const ordersAovChart: InsightChart | undefined = midStore ? { kind: "linked", title: "订单数、客单价按历史数据联动",
    a: { label: "订单数", unit: "单", digits: 0, base: midStore.orders / midStore.days, min: quantile(dailyOrders, 0.02), max: quantile(dailyOrders, 0.98) },
    b: { label: "客单价", unit: "元", digits: 0, base: midStore.sales / midStore.orders, min: quantile(dailyAov, 0.02), max: quantile(dailyAov, 0.98) },
    fit: ordersAovFit, sales: { label: "销售额", unit: "元", digits: 0 } } : undefined;
  // 拆解线的分数：门店之间结果的差异，多少来自这一项（对数方差拆分）。件数 = 订单数 × 单均件数；毛利 = 不含税销售额 × 毛利率。
  const itemsOf = new Map<string, number>(); for (const p of panel) itemsOf.set(p.store, (itemsOf.get(p.store) ?? 0) + p.items);
  const qtySplit = logSplit(full.map((s) => Math.max(1, itemsOf.get(s.id) ?? 1)), full.map((s) => s.orders));
  const gpStores = full.filter((s) => s.gp > 0);
  const gpSplit = logSplit(gpStores.map((s) => s.gp), gpStores.map((s) => s.revEx));
  const medianBy = (key: (s: typeof full[number]) => string, value: (s: typeof full[number]) => number) => {
    const g = new Map<string, number[]>(); for (const s of full) { const k = key(s); g.set(k, [...(g.get(k) ?? []), value(s)]); }
    return [...g].map(([k, v]) => ({ k, n: v.length, m: median(v) ?? 0 }));
  };
  // 「未定义」不是一档商圈，不参与比较。
  const imageRows = medianBy((s) => s.attr.image, (s) => s.sales).filter((r) => r.k && r.k !== "未定义").sort((a, b) => b.m - a.m);
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

  // ---------- 依据里的图 ----------
  // 给总部业务看：标题就是结论，横轴是影响因素、纵轴是结果，单位用元、单、件、%，不出现统计术语。
  // 图上的数都在这里换成展示单位，页面不再算。
  const r1 = (v: number) => Math.round(v * 10) / 10; const r2 = (v: number) => Math.round(v * 100) / 100;
  const lastDay = daily.at(-1)?.day ?? rollout;
  // 横条：每一档一个数，最好的一档用主色。
  const barsOf = (title: string, rows: Array<{ label: string; value: number; text: string }>, best: "max" | "min" | null = "max", note?: string): InsightChart => {
    const pick = best === null ? null : best === "max" ? Math.max(...rows.map((r) => r.value)) : Math.min(...rows.map((r) => r.value));
    return { kind: "bars", title, bars: rows.map((r) => ({ ...r, tone: r.value === pick ? "main" : "soft" })), ...(note ? { note } : {}) };
  };
  const named = (rows: Array<[string, number]>, text: (v: number) => string) => rows.map(([label, v]) => ({ label, value: r1(v), text: text(v) }));
  // 门店按某个数分档：每档的店数和结果中位数（开满 20 天的店）。
  type FullStore = typeof full[number];
  const bandsOf = (by: (s: FullStore) => number, cuts: number[], label: (lo: number, hi: number, i: number) => string, outcome: (s: FullStore) => number) => {
    const edges = [-Infinity, ...cuts, Infinity];
    return edges.slice(0, -1).map((lo, i) => { const hi = edges[i + 1]; const g = full.filter((s) => { const v = by(s); return Number.isFinite(v) && v >= lo && v < hi; });
      return { label: label(lo, hi, i), n: g.length, m: median(g.map(outcome).filter(Number.isFinite)) ?? 0 }; }).filter((r) => r.n >= 20);
  };
  const perDay = (s: FullStore) => s.orders / s.days;

  // 逐日的每单件数、客单价、毛利率：卡片里写「整个月在多少到多少之间」。
  const byDay = new Map<string, { items: number; orders: number; sales: number; gp: number; revEx: number }>();
  for (const p of panel) { const x = byDay.get(p.day) ?? { items: 0, orders: 0, sales: 0, gp: 0, revEx: 0 }; x.items += p.items; x.orders += p.orders; x.sales += p.sales; x.gp += p.gp; x.revEx += p.revEx; byDay.set(p.day, x); }
  type DayAgg = { items: number; orders: number; sales: number; gp: number; revEx: number };
  const dayAgg = daily.map((d): DayAgg => byDay.get(d.day) ?? { items: 0, orders: 0, sales: 0, gp: 0, revEx: 0 });
  type Factor = { of: (x: DayAgg) => number };
  const range = (f: Factor) => { const v = dayAgg.map(f.of).filter((x) => x > 0); return [Math.min(...v), Math.max(...v)]; };
  const ipoF: Factor = { of: (x) => x.orders > 0 ? x.items / x.orders : 0 };
  const aovF: Factor = { of: (x) => x.orders > 0 ? x.sales / x.orders : 0 };
  const gmF: Factor = { of: (x) => x.revEx > 0 ? x.gp / x.revEx * 100 : 0 };
  const [ipoLo, ipoHi] = range(ipoF); const [aovLo, aovHi] = range(aovF); const [gmLo, gmHi] = range(gmF);
  // 指标：横轴放影响因素，不放时间。开满 20 天的店按一个乘数从低到高分 5 档（每档约同样多的店），
  // 柱子是这一档店的结果，柱下写另一个乘数：柱子一路涨、另一个乘数几乎不变，就看得出结果跟着谁走。
  const quintiles = (x: number[], round: (v: number) => number) => {
    const sorted = [...x].filter(Number.isFinite).sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? 0;
    return [...new Set([0.2, 0.4, 0.6, 0.8].map((q) => round(at(q))))].filter((v) => v > 0);
  };
  // 门店按一个乘数从低到高分 5 档，每档两条线：结果和另一个乘数，都换算成第一档的几倍，放在同一根纵轴上。
  // 一条线往上走、另一条线贴着 1 倍，就看得出结果跟着谁走。横轴是档位，不是时间。
  type Line = { label: string; of: (g: FullStore[]) => number; text: (v: number) => string };
  const bandLines = (title: string, by: (s: FullStore) => number, cuts: number[], name: (lo: number, hi: number) => string, result: Line, other: Line, base: string, note: string): InsightChart => {
    const edges = [-Infinity, ...cuts, Infinity];
    const groups = edges.slice(0, -1).map((lo, i) => { const hi = edges[i + 1]; return { label: name(lo, hi), g: full.filter((s) => { const v = by(s); return Number.isFinite(v) && v >= lo && v < hi; }) }; }).filter((x) => x.g.length >= 20);
    const series = [result, other].map((line, k) => { const vals = groups.map((x) => line.of(x.g)); const b = vals[0] || 1;
      return { label: line.label, tone: k ? "accent" as const : "main" as const, values: vals.map((v) => r2(v / b)), hover: vals.map(line.text) }; });
    return { kind: "lines", title, labels: groups.map((x) => x.label), series, base: `${base}「${groups[0]?.label ?? ""}」那一档`, note };
  };
  const med = (g: FullStore[], f: (s: FullStore) => number) => median(g.map(f).filter(Number.isFinite)) ?? 0;
  const itemsOfStore = (s: FullStore) => itemsOf.get(s.id) ?? 0;
  const orderCuts = quintiles(full.map(perDay), (v) => Math.round(v));
  const orderName = (lo: number, hi: number) => lo === -Infinity ? `<${hi}单` : hi === Infinity ? `${lo}单+` : `${lo}–${hi}单`;
  const salesL: Line = { label: "销售额", of: (g) => med(g, (s) => s.sales / s.days), text: (v) => `一天 ${n1(v / 1e4)} 万` };
  const aovL: Line = { label: "客单价", of: (g) => med(g, (s) => s.sales / s.orders), text: (v) => `${n0(v)} 元/单` };
  const ordersL: Line = { label: "订单数", of: (g) => med(g, perDay), text: (v) => `一天 ${n1(v)} 单` };
  const qtyL: Line = { label: "销量", of: (g) => med(g, (s) => itemsOfStore(s) / s.days), text: (v) => `一天 ${n1(v)} 件` };
  const ipoL: Line = { label: "每单件数", of: (g) => med(g, (s) => itemsOfStore(s) / s.orders), text: (v) => `${v.toFixed(2)} 件/单` };
  const gpL: Line = { label: "毛利", of: (g) => med(g, (s) => s.gp / s.days), text: (v) => `一天 ${n1(v / 1e4)} 万` };
  const gmL: Line = { label: "毛利率", of: (g) => med(g, (s) => s.gp / s.revEx * 100), text: pct };
  const per5 = `每档约 ${n0(full.length / 5)} 家店，取中间那家`;
  const salesByOrders = bandLines("单越多的店卖得越多，客单价几乎不变", perDay, orderCuts, orderName, salesL, aovL, "每天来的单最少的",
    `横轴：门店按每天来多少单从少到多分 5 档（${per5}）。`);
  const qtyByOrders = bandLines("单越多的店卖的件数越多，每单件数几乎不变", perDay, orderCuts, orderName, qtyL, ipoL, "每天来的单最少的",
    `横轴：门店按每天来多少单从少到多分 5 档（${per5}）。`);
  const aovCuts = quintiles(full.map((s) => s.sales / s.orders), (v) => Math.round(v / 1000) * 1000);
  const salesByAov = bandLines("客单价高的店也卖得多，但单量也跟着多", (s) => s.sales / s.orders, aovCuts,
    (lo, hi) => lo === -Infinity ? `<${n0(hi / 1000)}千` : hi === Infinity ? `${n0(lo / 1000)}千+` : `${n0(lo / 1000)}–${n0(hi / 1000)}千`, salesL, ordersL, "客单价最低的",
    `横轴：门店按客单价从低到高分 5 档（${per5}）。`);
  const revCuts = quintiles(full.map((s) => s.revEx / s.days), (v) => Math.round(v / 1e4) * 1e4);
  const gpByRev = bandLines("卖得越多的店毛利越多，毛利率几乎不变", (s) => s.revEx / s.days, revCuts,
    (lo, hi) => lo === -Infinity ? `<${n0(hi / 1e4)}万` : hi === Infinity ? `${n0(lo / 1e4)}万+` : `${n0(lo / 1e4)}–${n0(hi / 1e4)}万`, gpL, gmL, "一天卖得最少的",
    `横轴：门店按一天卖多少（不含税）从少到多分 5 档（${per5}）。`);

  // 指标拆解：订单数、客单价、毛利率各自被什么拉动。
  const imageOrders = medianBy((s) => s.attr.image, perDay).filter((r) => r.n >= 20 && r.k !== "未定义").sort((a, b) => b.m - a.m);
  const ordersChart = barsOf("商圈越好的店，每天单越多", imageOrders.map((r) => ({ label: short(r.k), value: r1(r.m), text: `${n1(r.m)} 单` })), "max",
    `门店日均订单数的一般水平。全国一天的单量也随日子变：平常工作日 ${n1(ordinary.length ? mean(ordinary.map((d) => d.orders)) / 1e4 : 0)} 万单${peak ? `，${festName} ${n1(peak.orders / 1e4)} 万单` : ""}。`);
  const aovByOffer = named([["克减 50", k50.gramsPerItem], ["金色星期二", gtG.gramsPerItem], ["克减 30", k30.gramsPerItem], ["一般開單", baseG.gramsPerItem]], (v) => `${n1(v)} 克`);
  const aovChart = barsOf("力度大的活动，顾客买得更重", aovByOffer, "max", "计价金每件平均多少克。买得越重，客单价越高。");
  const gmChart = barsOf("一口价、镶嵌的毛利率是计价金的两倍", [gold, fixed, inlay].map((p) => ({ label: p.ptype, value: r1(ptGm(p)), text: pct(ptGm(p)) })), "max",
    `计价金卖了 ${pct(share(gold.sales, total.sales))} 的钱，只贡献 ${pct(share(gold.gp, total.gp))} 的毛利。卖的货越偏计价金，毛利率越低。`);

  // 因素：门店本身、日期和活动、活动和力度、货品结构。
  const storeChart = barsOf("商圈越好的店，一个月卖得越多", imageRows.filter((r) => r.n >= 20).map((r) => ({ label: short(r.k), value: r1(r.m / 1e4), text: `${wan(r.m)}（${n0(r.n)} 家）` })), "max",
    `门店月销售额的一般水平。门店属性里商圈形象级别影响最大，其次是店型；大区、自营还是加盟本身影响很小。`);
  const dailyChart: InsightChart = { kind: "columns", title: "8/22 起全国做克减，单量和销售额一起涨", unit: "亿", digits: 2, stacked: true,
    series: [{ label: "一般開單计价金", tone: "muted" }, { label: "克减等活动计价金", tone: "main" }, { label: "其余", tone: "soft" }],
    points: daily.map((d) => ({ label: day(d.day), values: [r2(d.baseGold / 1e8), r2(d.promoGold / 1e8), r2(Math.max(0, d.sales - d.baseGold - d.promoGold) / 1e8)], ...(d.day === peak?.day ? { mark: festName } : {}) })),
    ...(rollout <= lastDay ? { band: { from: day(rollout), to: day(lastDay), label: "克减全国铺开" } } : {}),
    note: `每天全国销售额（亿元）。${day(rollout)} 起蓝色的活动单明显变多${peak ? `，但${festName}也在这几天` : ""}，所以涨的部分里活动和节日各占多少拆不开。「其余」是金色星期二、一口价和镶嵌等。` };
  const promoChart = barsOf("同一家店，有活动成交的那天卖得更多", named(PROMO.map((name, i) => [name, promoSales[i]]), (v) => `平时的 ${n1(v)} 倍`), "max",
    "拿同一家店有这个活动成交的日子，和它同期没有的日子比。门店自己挑哪天做、又和节日同周，倍数会偏高。");
  const mixBands = bandsOf((s) => s.gold / s.sales * 100, [50, 65, 75, 85], (lo, hi) => lo === -Infinity ? `不到 ${hi}%` : hi === Infinity ? `${lo}% 以上` : `${lo}–${hi}%`, (s) => s.gp / s.revEx * 100);
  const mixChart = barsOf("计价金卖得越多的店，毛利率越低", mixBands.map((r) => ({ label: r.label, value: r1(r.m), text: `${pct(r.m)}（${n0(r.n)} 家）` })), "max",
    "左边是计价金占门店销售额的比例，一档一档往上；右边是这一档门店的毛利率。店和店毛利率差多少，八成能用这一个比例说清。");

  // 细项因素。
  const imageChart = barsOf("商圈越好的店，一个月卖得越多", imageRows.filter((r) => r.n >= 20).map((r) => ({ label: short(r.k), value: r1(r.m / 1e4), text: `${wan(r.m)}（${n0(r.n)} 家）` })), "max",
    imageRows.length >= 2 ? `门店月销售额的一般水平。${short(imageRows[0].k)}的店是${short(imageRows.at(-1)!.k)}的 ${n1(imageRows[0].m / Math.max(1, imageRows.at(-1)!.m))} 倍，主要差在每天来的单多。` : undefined);
  const bigExp = expRows.filter((r) => r.n >= 30);
  const expChart = barsOf("店型越高端，客单价越高", (bigExp.length >= 2 ? bigExp : expRows).slice(0, 5).map((r) => ({ label: r.k, value: r1(r.aov), text: `${n0(r.aov)} 元（${n0(r.n)} 家）` })), "max",
    "各店型门店客单价的一般水平（只列 30 家店以上的店型）。");
  const areaBands = attrRows((s) => s.attr.area);
  const areaChart = barsOf("面积大的店不一定卖得多", areaBands.map((r) => ({ label: r.k, value: r1(r.m / 1e4), text: `${wan(r.m)}（${n0(r.n)} 家）` })), "max",
    "门店月销售额的一般水平。商圈和店型一样的店里，面积、店龄、城市级别带来的差别都不大。");
  const regionChart = barsOf("各大区的店卖得差不多", regionRows.map((r) => ({ label: r.k, value: r1(r.m / 1e4), text: `${wan(r.m)}（${n0(r.n)} 家）` })), "max",
    regionRows.length >= 2 ? `门店月销售额的一般水平，最高的${regionRows[0].k}比最低的${regionRows.at(-1)!.k}只多 ${n0((regionRows[0].m / Math.max(1, regionRows.at(-1)!.m) - 1) * 100)}%。大区之间的差，多半是各区商圈、店型的构成不同。` : undefined);
  const natureChart = barsOf("自营店毛利率略低于加盟店", natureGm.map((r) => ({ label: r.k, value: r1(r.m), text: `${pct(r.m)}（${n0(r.n)} 家）` })), "max",
    "门店毛利率的一般水平，相差不到 2 个百分点；原因可能是加盟店进货价口径不同，要问财务。对销售额几乎没有影响。");
  const qixiChart: InsightChart = { kind: "columns", title: `${festName}当天卖得最多`, unit: "亿", digits: 2, stacked: false, series: [{ label: "当天销售额", tone: "soft" }],
    points: daily.map((d) => ({ label: day(d.day), values: [r2(d.sales / 1e8)], ...(d.day === peak?.day ? { mark: festName } : {}) })),
    ...(festDays.length ? { band: { from: day(festDays[0].day), to: day(festDays.at(-1)!.day), label: `日历上的${peak?.festival ?? "节日"}` } } : {}),
    note: peak ? `每天全国销售额（亿元）。${day(peak.day)} 一天 ${yi(peak.sales)}，是平常工作日的 ${n1(peak.sales / ordinaryAvg)} 倍；节日前几天就开始往上走。` : undefined };
  const dowChart = barsOf("周二卖得最多：金色星期二", [...DOW.slice(1), DOW[0]].flatMap((name) => dowRows.filter((r) => r.name === name)).map((r) => ({ label: r.name, value: r2(r.avg / 1e8), text: yi(r.avg) })), "max",
    `不含节日，各星期几全国一天的平均销售额。周二多出来的主要是计价金（${yi(tueGold)}，平常工作日 ${yi(ordGold)}）。`);
  const depthChart = barsOf("克减 50 每克实际让 50 多元，克减 30 让 24 元", named([["克减 50", g50], ["克减 30", g30], ["金色星期二", gGt]], (v) => `${n1(v)} 元/克`), "max",
    "同一天里，一般開單每克收的钱减去活动每克收的钱。金色星期二的优惠在旧金抵价上，所以每克几乎不让。");
  const thresholdChart: InsightChart = { kind: "columns", title: "克减 50 的顾客集中买 20 克以上", unit: "件", digits: 0, stacked: false,
    series: [{ label: "克减 50", tone: "main" }, { label: "一般開單", tone: "muted" }],
    points: [...data.threshold].sort((a, b) => a.gram - b.gram).map((t) => ({ label: `${t.gram}克`, values: [t.k50, t.base] })),
    ...(data.threshold.some((t) => t.gram >= 20) && data.threshold.some((t) => t.gram < 20) ? { band: { from: "20克", to: `${Math.max(...data.threshold.map((t) => t.gram))}克`, label: "20 克及以上" } } : {}),
    note: `每克一档卖了多少件。从 19 克到 20 克，一般開單从 ${n0(t19.base)} 件降到 ${n0(t20.base)} 件，克减 50 却从 ${n0(t19.k50)} 件跳到 ${n0(t20.k50)} 件，像是有 20 克的门槛（规则表待确认）。` };
  const tradeInChart = barsOf("金色星期二几乎每单都带旧金换", [
    { label: "金色星期二", value: r1(share(trGt.tradeIn, trGt.orders)), text: pct(share(trGt.tradeIn, trGt.orders)) },
    { label: "一般開單", value: r1(share(trBase.tradeIn, trBase.orders)), text: pct(share(trBase.tradeIn, trBase.orders)) },
    { label: "克减类", value: r1(promoTradeInShare), text: pct(promoTradeInShare) },
  ], "max", `带旧金来换的订单占比。金色星期二卖了 ${yi(trGt.sales)}，其中 ${yi(trGt.recycle)} 是用旧金抵的，收进的新钱是 ${yi(trGt.sales - trGt.recycle)}。`);
  const shiftChart: InsightChart = { kind: "columns", title: "克减带来的大多是新增生意", unit: "万", digits: 0, stacked: true,
    series: [{ label: "一般開單", tone: "muted" }, { label: "克减等活动", tone: "main" }],
    points: [{ label: `${day(rollout)} 之前`, values: [Math.round(shift.baseBefore / 1e4), Math.round(shift.promoBefore / 1e4)] }, { label: `${day(rollout)} 之后`, values: [Math.round(shift.baseAfter / 1e4), Math.round(shift.promoAfter / 1e4)] }],
    note: `周一、三、四全国一天的计价金销售额（万元）。克减铺开后，一般開單只少了 ${n1(Math.abs(shiftPct))}%，活动多出来的远比这个多；但这几天离节日近，新增里也有节日的功劳。` };

  const nodeCharts: Partial<Record<InsightNodeId, InsightChart>> = {
    image: imageChart, shoptype: expChart, areaage: areaChart, region: regionChart, nature: natureChart, qixi: qixiChart, weekday: dowChart,
    depth: depthChart, threshold: thresholdChart, tradein: tradeInChart, shift: shiftChart,
    store: storeChart, day: dailyChart, promo: promoChart, mix: mixChart,
    orders: ordersChart, aov: aovChart, gm: gmChart,
    qty: qtyByOrders, sales: salesByOrders, gp: gpByRev,
  };
  // 连线：图讲的是「左边这一项怎么影响右边那一项」。
  const imageOrdersChart = barsOf("商圈越好的店，每天单越多", imageOrders.map((r) => ({ label: short(r.k), value: r1(r.m), text: `${n1(r.m)} 单（${n0(r.n)} 家）` })), "max", "门店日均订单数的一般水平。");
  const expAovChart = expChart;
  const dayOrdersChart: InsightChart = { kind: "columns", title: "做活动、过节的日子，单量明显更多", unit: "万单", digits: 1, stacked: false, series: [{ label: "订单数", tone: "soft" }],
    points: daily.map((d) => ({ label: day(d.day), values: [r1(d.orders / 1e4)], ...(d.day === peak?.day ? { mark: festName } : {}) })),
    ...(rollout <= lastDay ? { band: { from: day(rollout), to: day(lastDay), label: "克减全国铺开" } } : {}),
    note: `全国每天的订单数（万单）。平常工作日约 ${n1(ordinary.length ? mean(ordinary.map((d) => d.orders)) / 1e4 : 0)} 万单，克减铺开后明显变多${peak ? `，${festName} ${n1(peak.orders / 1e4)} 万单` : ""}。` };
  const promoGmChart = barsOf("有活动成交的那天，毛利率低 4 个百分点左右", named(PROMO.map((name, i) => [name, promoGm[i]]), (v) => gap(v, "高", "低")), "max",
    "同一家店，有这个活动成交的日子比没有的日子，毛利率低多少。条越短降得越少。");
  const promoMixChart = barsOf("有活动成交的那天，卖的计价金更多", named(PROMO.map((name, i) => [name, promoGold[i]]), (v) => gap(v, "多", "少")), "min",
    "同一家店，有这个活动成交的日子比没有的日子，计价金占销售额的比例高多少。这就是活动压毛利率的原因。");
  const edgeCharts: Record<string, InsightChart | undefined> = {
    "image>store": imageChart, "shoptype>store": barsOf("高端店型卖得更多", (bigExp.length >= 2 ? bigExp : expRows).slice(0, 5).map((r) => ({ label: r.k, value: r1(r.m / 1e4), text: `${wan(r.m)}（${n0(r.n)} 家）` })), "max", "各店型门店月销售额的一般水平（只列 30 家店以上的店型）。"),
    "areaage>store": areaChart, "region>store": regionChart, "nature>store": natureChart,
    "qixi>day": qixiChart, "weekday>day": dowChart, "depth>promo": depthChart, "threshold>promo": thresholdChart, "tradein>promo": tradeInChart, "shift>promo": shiftChart,
    "store>orders": imageOrdersChart, "store>aov": expAovChart, "day>orders": dayOrdersChart,
    "promo>orders": promoChart, "promo>aov": aovChart, "promo>gm": promoGmChart, "promo>mix": promoMixChart, "mix>gm": mixChart,
    "orders>sales": salesByOrders, "aov>sales": salesByAov, "orders>qty": qtyByOrders, "gm>gp": gpByRev,
  };

  // ---------- 节点 ----------
  const N = (node: Omit<InsightNode, "card">) => node;
  const imageS = byScore(sc.image); const expS = byScore(sc.shoptype);
  const nodes: Array<Omit<InsightNode, "card">> = [
    N({ id: "image", column: 0, section: "门店", kind: "leaf", label: "商圈形象级别", subtitle: `独有贡献 ${pct(u(uSales, "形象级别"))}`, strength: imageS, score: sc.image,
      source: { kind: "field", columns: ["形象级别描述"], how: "门店属性原值，按门店汇总" },
      paragraphs: [`商圈越好的店卖得越多：${imageRows.filter((r) => r.n >= 20).slice(0, 1).map((r) => `${short(r.k)}的店一个月卖 ${wan(r.m)}`).join("")}${imageRows.length >= 2 ? `，${short(imageRows.at(-1)!.k)}只有 ${wan(imageRows.at(-1)!.m)}` : ""}。在门店的各项属性里，它的影响最大。`],
      note: "比较活动效果时要按商圈分层，否则比出来的是商圈差异。" }),
    N({ id: "shoptype", column: 0, section: "门店", kind: "leaf", label: "店型", subtitle: `独有 ${pct(u(uSales, "店型"))} · 客单 ${pct(u(uAov, "店型"))}`, strength: expS, score: sc.shoptype,
      source: { kind: "field", columns: ["零售体验描述"], how: "门店属性原值；「店型」这个叫法是 AI 起的" },
      paragraphs: ["店型越高端，客单价越高、一个月卖得也越多。店型对客单价的影响比对销售额更明显。"],
      table: { head: ["店型", "店数", "月销售额", "客单价"], rows: expRows.slice(0, 5).map((r) => [r.k, n0(r.n), wan(r.m), n0(r.aov)]) } }),
    N({ id: "areaage", column: 0, section: "门店", kind: "leaf", label: "面积、店龄、城市", subtitle: `各独有 ${pct(Math.min(u(uSales, "面积"), u(uSales, "店龄"), u(uSales, "城市级别")))}–${pct(areaMax)}`, strength: byScore(sc.areaage), score: sc.areaage,
      source: { kind: "field", columns: ["分店面积区间", "店龄", "城市级别"], how: "三个门店属性原值", judgement: "三个字段合成一个节点、店龄分成 ≤2 / 3–5 / 6–10 / 10 年以上，是 AI 为了简化做的" },
      paragraphs: ["面积、店龄、城市级别单独看和销售额有关系，但商圈和店型一样的店放在一起比，这几项带来的差别就很小了。"] }),
    N({ id: "region", column: 0, section: "门店", kind: "leaf", label: "大区 / 区域", subtitle: `独有 ${pct(u(uSales, "区域"))}`, strength: byScore(sc.region), score: sc.region,
      source: { kind: "field", columns: ["大区描述", "区域描述"], how: "门店属性原值" },
      paragraphs: ["各大区的店一个月卖得差不多。大区之间看起来的差别，多半是各区好商圈、高端店型的店多少不同。", "比较大区好坏之前，先按商圈和店型把同类店放在一起比。"] }),
    N({ id: "nature", column: 0, section: "门店", kind: "leaf", label: "自营 / 加盟", subtitle: `销售 ${pct(u(uSales, "分店性质"))} · 毛利 ${pct(u(uGmMix, "分店性质"))}`, strength: byScore(sc.natureSales.value >= sc.natureGm.value ? sc.natureSales : sc.natureGm), score: sc.natureSales.value >= sc.natureGm.value ? sc.natureSales : sc.natureGm,
      source: { kind: "field", columns: ["分店性质"], how: "门店属性原值（自营、加盟寄售、加盟批发、合营寄售）" },
      paragraphs: ["自营还是加盟，对卖多少几乎没有影响；毛利率上，自营店略低一点。"],
      note: "原因不明，可能是加盟店进货价口径不同，要问财务。" }),
    N({ id: "qixi", column: 0, section: "时间", kind: "leaf", label: festName, subtitle: peak ? `${day(peak.day)} 一天 ${yi(peak.sales)}` : "数据里没有节日", strength: byScore(sc.qixi), score: sc.qixi,
      source: { kind: "field", columns: ["节庆"], how: `日历表原值${festDays.length ? `，${day(festDays[0].day)}–${day(festDays.at(-1)!.day)} 标为${peak?.festival}` : ""}` },
      paragraphs: peak ? [`${day(peak.day)} 一天卖了 ${yi(peak.sales)}，是平常工作日（${day(rollout)} 之前的周一、三、四，平均一天 ${yi(ordinaryAvg)}）的 ${n1(peak.sales / ordinaryAvg)} 倍。`] : ["这段时间数据里没有节日。"],
      note: "节日和克减铺开在同一周，节日自己拉多少、活动拉多少拆不开。两年同比按「距节日天数」对齐才能拆。" }),
    N({ id: "weekday", column: 0, section: "时间", kind: "leaf", label: "星期", subtitle: `周二日均 ${yi(tueAvg)}`, strength: byScore(sc.weekday), score: sc.weekday,
      source: { kind: "derived", columns: ["交易日期wid"], how: "由日期算星期几" },
      paragraphs: [`${day(rollout)} 之前，周二平均一天卖 ${yi(tueAvg)}，周一、三、四只有 ${yi(ordinaryAvg)}，周末 ${yi(weekendAvg)}。周二多出来的主要是计价金，这是金色星期二带的。`] }),
    N({ id: "depth", column: 0, section: "活动", kind: "leaf", label: "每克让多少", subtitle: `克减30 实让 ${n1(g30)} 元`, strength: byScore(sc.depth), score: sc.depth, effect: { text: ef.depth.text, measure: ef.depth.measure },
      source: { kind: "inferred", columns: ["实际销售金额", "销售金重", "优惠小类", "交易日期wid"], how: "同一天一般開單每克实收 − 活动每克实收，按活动克重加权（一般足金类）", judgement: "把「一般開單」当作没有优惠的对照组，是 AI 的判断；按活动名称里的「克减 30 / 50」归组也是 AI 做的" },
      paragraphs: [`和同一天的一般開單比，克减 50 每克实际少收 ${n1(g50)} 元，克减 30 少收 ${n1(g30)} 元，都比名义上少一点。`],
      note: "规则表没给，实让和名义的差（克数门槛、叠加规则）要用 Discount Detail 核对。" }),
    N({ id: "threshold", column: 0, section: "活动", kind: "leaf", label: "克重门槛", subtitle: `克减50 在 20 克扎堆`, strength: byScore(sc.threshold), score: sc.threshold, effect: { text: ef.threshold.text, measure: ef.threshold.measure },
      source: { kind: "inferred", columns: ["销售金重", "销售件数", "优惠小类"], how: "按 1 克一档数克减 50 和一般開單的件数（一般足金类）", judgement: "「门槛是 20 克」是 AI 从分布里反推的，规则表没给" },
      paragraphs: [`克减 50 的顾客明显往 20 克以上买：它的计价金销售额 ${pct(k50.ge20)} 来自 20 克以上的货，克减 30 只有 ${pct(k30.ge20)}，一般開單 ${pct(baseG.ge20)}。`] }),
    N({ id: "tradein", column: 0, section: "活动", kind: "leaf", label: "以旧换新", subtitle: `星期二 ${pct(share(trGt.recycle, trGt.sales))} 旧金抵`, strength: byScore(sc.tradein), score: sc.tradein, effect: { text: ef.tradein.text, measure: ef.tradein.measure },
      source: { kind: "inferred", columns: ["回收金标识：1：是，0：否", "实际销售金额", "实体分店店号", "销售单号"], how: "同一张单（店号 + 单号）里有回收行的订单数和抵扣金额", judgement: "把件数为 0、金额为负的行理解成以旧换新抵扣的旧金，按单关联到销售，是 AI 的判断" },
      paragraphs: [`金色星期二 ${n0(trGt.orders)} 单里，${n0(trGt.tradeIn)} 单是带旧金来换的。它卖了 ${yi(trGt.sales)}，其中 ${yi(trGt.recycle)} 是旧金抵的。`, "所以看金色星期二，要看收进了多少新钱，不能只看卖了多少。"] }),
    N({ id: "shift", column: 0, section: "活动", kind: "leaf", label: "新增还是挪动", subtitle: `一般開單 ${shiftPct >= 0 ? "+" : "−"}${n1(Math.abs(shiftPct))}%`, strength: byScore(sc.shift), score: sc.shift, effect: { text: ef.shift.text, measure: ef.shift.measure },
      source: { kind: "inferred", columns: ["实际销售金额", "优惠小类", "材料种类描述", "交易日期wid"], how: `${day(rollout)} 前后周一、三、四一般開單、活动计价金日均对比`, judgement: `用克减铺开（${day(rollout)}）前后对比来看挪动，是 AI 设计的比较；同期节日的影响没剔掉` },
      paragraphs: [`${day(rollout)} 全国克减铺开后，周一、三、四（不含${peak ? ` ${day(peak.day)}` : "节日当天"}）一般開單的计价金从每天 ${wan(shift.baseBefore)} 变成 ${wan(shift.baseAfter)}，只少了 ${n1(Math.abs(shiftPct))}%；活动的计价金却从 ${wan(shift.promoBefore)} 涨到 ${wan(shift.promoAfter)}。多出来的大部分不是从一般開單挪过来的。`],
      note: "同期离节日更近，新增里混着节日拉动。" }),
    N({ id: "gold", column: 0, section: "缺数据", kind: "leaf", label: "每日金价", subtitle: "跨月跨年比不了", strength: "missing",
      source: { kind: "suggested", columns: [], how: "数据里没有每日金价", judgement: "AI 认为比较活动力度要补每日金价" },
      paragraphs: ["没有每日金价，计价金每克实收里混着金价、工费和让利。", "同日对齐能剔除逐日金价波动，跨月、跨年比较需要每日金价。"] }),
    N({ id: "member", column: 0, section: "缺数据", kind: "leaf", label: "新老会员", subtitle: "分不出新老", strength: "missing",
      source: { kind: "suggested", columns: ["是否会员销售（1：是，0：否）"], how: `原字段只有是不是会员，${pct(data.memberShare)} 的销售额都标为会员`, judgement: "新老会员是业务提的问题，要补会员 ID 和首购日期" },
      paragraphs: [`明细里有「是否会员销售」，但 ${pct(data.memberShare)} 的销售额都是会员，分不出新老。`, "要会员 ID 和首购日期，才能回答「这个活动对新会员、老会员效果是否不同」。"] }),

    N({ id: "store", column: 1, kind: "factor", label: "门店本身", subtitle: `销售额波动的 ${pct(fe.store)}`, score: sc.store,
      source: { kind: "grouping", columns: ["实体分店店号"], how: `把每家店每天的销售额，拆成「这家店本身的水平」和「这一天的水平」两部分；门店那部分占 ${pct(fe.store)}`, judgement: "把商圈、店型、面积等归成「门店本身」，以及这样拆分，是 AI 的做法" },
      paragraphs: ["同一天里，好店和一般的店能差好几倍：门店本身是什么样的店，比哪一天影响更大。", "门店属性里，商圈形象级别影响最大，其次是店型；面积、店龄、大区、自营还是加盟的影响都很小。"] }),
    N({ id: "day", column: 1, kind: "factor", label: "日期和活动", subtitle: `销售额波动的 ${pct(fe.day)}`, score: sc.day,
      source: { kind: "grouping", columns: ["交易日期wid", "节庆"], how: `同样的拆法里，「这一天的水平」那部分占 ${pct(fe.day)}`, judgement: "日期和当天有什么活动分不开，AI 把它们归成一类" },
      paragraphs: [`全国一天卖多少差很多：平常工作日一天 ${yi(ordinaryAvg)}${peak ? `，${festName}当天 ${yi(peak.sales)}` : ""}。`, `活动是全国同一天一起变的：${day(rollout)} 起各店一起做克减${peak ? `，${day(peak.day)} 各店一起过${festName}` : ""}。只看日子，分不出哪部分是日子带来的、哪部分是活动带来的，所以放在一起看。`] }),
    N({ id: "promo", column: 1, kind: "factor", label: "活动和力度", subtitle: `当天销售 ${times(Math.min(...promoSales))}–${times(Math.max(...promoSales))}`, score: sc.promoSales,
      source: { kind: "grouping", columns: ["优惠小类"], how: "同店同日对比有无克减 50 / 克减 30 / 金色星期二成交", judgement: "按名称把优惠小类归成克减 50、克减 30、金色星期二、一般開單几组，是 AI 做的" },
      paragraphs: [`拿同一家店有活动成交的日子和没有的日子比：克减 50 那天卖得是平时的 ${n1(promoSales[0])} 倍，克减 30 ${n1(promoSales[1])} 倍，金色星期二 ${n1(promoSales[2])} 倍。`, "但活动那天卖的计价金更多，毛利率会低 4 个百分点左右。"],
      table: { head: ["活动", "当天卖得", "毛利率", "计价金占比"], rows: PROMO.map((name, i) => [name, `平时的 ${n1(promoSales[i])} 倍`, gap(promoGm[i], "高", "低"), gap(promoGold[i], "多", "少")]) },
      note: "门店自己选哪天做，又和节日同周，倍数会高估活动本身。" }),
    N({ id: "mix", column: 1, kind: "factor", label: "货品结构", subtitle: `毛利率差异的 ${pct(mixOnly)}`, score: sc.mix,
      source: { kind: "grouping", columns: ["材料种类描述", "实际销售金额"], how: "计价金占销售额比例", judgement: "按材料种类把货归成计价金（足金）、一口价黄金（定价足金）、镶嵌及其他，是 AI 的分法" },
      paragraphs: ["计价金毛利率低，一口价、镶嵌毛利率高。一家店卖的货越偏计价金，毛利率就越低：店和店毛利率差多少，八成能用「计价金占多少」这一个数说清。"],
      table: { head: ["货类", "销售额占比", "毛利占比", "毛利率"], rows: [gold, fixed, inlay].map((p) => [p.ptype, pct(share(p.sales, total.sales)), pct(share(p.gp, total.gp)), pct(ptGm(p))]) } }),

    N({ id: "orders", column: 2, kind: "decomp", label: "订单数", subtitle: `门店间差异 ${pct(storeSplit.orders)}`,
      source: { kind: "derived", columns: ["实体分店店号", "销售单号"], how: "店号 + 销售单号去重计数（单号跨店会重复）" },
      paragraphs: [`销售额 = 订单数 × 客单价。店和店卖得不一样、一天和一天卖得不一样，主要差在订单数上，客单价差别没那么大。8 月全国 ${n1(total.orders / 1e4)} 万单。`],
      note: "客流和转化率缺数据，订单数再往下拆不了。" }),
    N({ id: "aov", column: 2, kind: "decomp", label: "客单价", subtitle: `门店间差异 ${pct(storeSplit.aov)}`,
      source: { kind: "derived", columns: ["实际销售金额", "实体分店店号", "销售单号"], how: "销售额 ÷ 订单数" },
      paragraphs: [`8 月平均一单 ${n0(total.orders > 0 ? total.sales / total.orders : 0)} 元。高端店型的客单价更高；做力度大的活动时顾客买得更重，客单价也更高。`] }),
    N({ id: "gm", column: 2, kind: "decomp", label: "毛利率", subtitle: "结构 + 让利",
      source: { kind: "derived", columns: ["零售毛利", "rsv"], how: "零售毛利 ÷（rsv ÷ 1.13）", judgement: "rsv 含 13% 增值税、零售毛利不含税，是在 9/8 样例上逐行核对过的；还没和财务确认" },
      paragraphs: [`毛利 = 销售额（不含税）× 毛利率。毛利率主要看卖了什么货：计价金卖得越多越低。8 月整体 ${pct(gm)}。`] }),

    N({ id: "qty", column: 3, kind: "metric", label: "销量", subtitle: `${n0(total.items / 1e4)} 万件 · ${n0(gold.grams / 1000)} 公斤`,
      source: { kind: "field", columns: ["销售件数", "销售金重"], how: "直接加总" },
      paragraphs: [`8 月卖了 ${n0(total.items / 1e4)} 万件，其中计价金 ${n0(gold.grams / 1000)} 公斤。销量 = 订单数 × 每单件数，每单件数基本不变，所以销量的起落看订单数。`] }),
    N({ id: "sales", column: 3, kind: "metric", label: "销售额", subtitle: `${yi(total.sales)}（含税）`,
      source: { kind: "field", columns: ["实际销售金额"], how: "直接加总", judgement: "只算件数 > 0 且金额 > 0 的正常销售行，回收、退货另看；这个口径是 AI 定的，还没和 Power BI 对数" },
      paragraphs: [`8 月卖了 ${yi(total.sales)}，${n1(total.orders / 1e4)} 万单，平均一单 ${n0(total.orders > 0 ? total.sales / total.orders : 0)} 元。销售额 = 订单数 × 客单价，起落主要跟着订单数。`],
      note: "还没和 Power BI 对数，绝对额先只作参考。" }),
    N({ id: "gp", column: 3, kind: "metric", label: "毛利", subtitle: `${yi(total.gp)} · 毛利率 ${pct(gm)}`,
      source: { kind: "field", columns: ["零售毛利"], how: "直接加总" },
      paragraphs: [`8 月毛利 ${yi(total.gp)}，毛利率 ${pct(gm)}。毛利 = 销售额（不含税）× 毛利率，毛利率变化不大，所以毛利基本跟着销售额走。`] }),
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
  const salesOut = outlierTable(groupsAll, { metric: M.sales, explain: mainPart([
    { label: "营业天数", of: (x) => x.days, fmt: (v) => `${n0(v)} 天`, incomplete: true },
    { label: "日均订单数", of: M.dailyOrders.of, fmt: M.dailyOrders.fmt },
    { label: "客单价", of: M.aov.of, fmt: yuan },
  ]), incomplete: (x) => x.days < 10 });
  const aovOut = outlierTable(groupsFull, { metric: M.aov, explain: mainPart([
    { label: "单均件数", of: (x) => div(x.items, x.orders), fmt: (v) => `${n1(v)} 件` },
    { label: "件均单价", of: (x) => div(x.sales, x.items), fmt: yuan },
  ]) });
  const gmOut = outlierTable(groupsFull, { metric: M.gm, explain: (x, group, high) => {
    const m = median(group.map(M.goldShare.of).filter(Number.isFinite)) ?? 0; const v = M.goldShare.of(x);
    // 毛利率偏高对应计价金卖得少，偏低对应卖得多；差不到 10pp 就说看不出原因，不硬套。
    // 计价金几乎为 0 的多是不卖足金的子品牌店（名字里看得出来），直接说「不卖计价金」。
    if (high && v < 1 && m >= 10) return { label: `不卖计价金：同类计价金占比 ${pct(m)}` };
    return (high ? m - v : v - m) >= 10 ? { label: `计价金占比${high ? "低" : "高"}：${pct(v)}（同类 ${pct(m)}）` } : { label: "货品结构和同类差不多，数据里看不出原因（可能是进货价或折扣口径）" };
  } });
  const withPeers = <T extends Omit<InsightEdge, "card">>(e: T, x: ReturnType<typeof comparePeers>): T => {
    if (!x) return e;
    // 关系成立时把落后的店放进推荐；关系不成立或方向相反时进异常提醒。
    const anomalies = x.verdict === "reverse" ? [...e.anomalies, `同类店里看，方向和这条线相反：${x.text}`] : e.anomalies;
    return { ...e, peers: x, anomalies };
  };

  // ---------- 指标：两个乘数各高多少，结果跟着高多少 ----------
  // 同类店（商圈、铺型、区域相同）放在一起，每家店的两个乘数和结果都除以本组中间那家，得到「比同类高多少」。
  // 横轴：这一项比同类高多少（分 6 档）；纵轴：这一档店的结果是同类的几倍（取中间那家）。两条线分别按两个乘数分档。
  // 门店之间的对比不是实验，只能说「高 X% 的店，结果一般高 Y%」，不能说「提 X% 就会涨 Y%」。
  type Lift = { label: string; of: (s: PeerStore) => number; text: (v: number) => string };
  const LIFT_BANDS: Array<{ label: string; lo: number; hi: number; mid: string }> = [
    // 横轴标签要短：侧栏窄，6 个档位挤在一起。完整说法放在 mid，悬停时显示。
    { label: "−20%↓", lo: 0, hi: 0.8, mid: "低 20% 以上" }, { label: "−5~20%", lo: 0.8, hi: 0.95, mid: "低 5%–20%" },
    { label: "持平", lo: 0.95, hi: 1.05, mid: "差不多" }, { label: "+5~20%", lo: 1.05, hi: 1.2, mid: "高 5%–20%" },
    { label: "+20~50%", lo: 1.2, hi: 1.5, mid: "高 20%–50%" }, { label: "+50%↑", lo: 1.5, hi: Infinity, mid: "高 50% 以上" },
  ];
  const liftChart = (title: string, result: Lift, a: Lift, b: Lift, note: string): InsightChart => {
    // 每家店：两个乘数和结果，各自除以本组中间那家。
    const rel = groupsFull.flatMap((g) => {
      const m = (f: (s: PeerStore) => number) => median(g.stores.map(f).filter((v) => Number.isFinite(v) && v > 0)) ?? 0;
      const ma = m(a.of), mb = m(b.of), mr = m(result.of); if (!(ma > 0 && mb > 0 && mr > 0)) return [];
      return g.stores.flatMap((s) => { const va = a.of(s), vb = b.of(s), vr = result.of(s); return va > 0 && vb > 0 && vr > 0 ? [{ a: va / ma, b: vb / mb, r: vr / mr }] : []; });
    });
    const line = (f: Lift, pick: (x: typeof rel[number]) => number, k: number) => {
      // 一档不到 30 家店就不画（null），免得几家特殊的店把线拉歪。
      const cells = LIFT_BANDS.map((band) => { const g = rel.filter((x) => pick(x) >= band.lo && pick(x) < band.hi); return { n: g.length, v: g.length >= 30 ? median(g.map((x) => x.r)) ?? NaN : NaN }; });
      return { label: f.label, tone: k ? "accent" as const : "main" as const, values: cells.map((c) => Number.isFinite(c.v) ? r2(c.v) : null),
        hover: cells.map((c, i) => Number.isFinite(c.v) ? `${f.label}${LIFT_BANDS[i].mid}的店，${result.label}是同类的 ${n1(c.v)} 倍（${n0(c.n)} 家）` : "店太少") };
    };
    return { kind: "lines", title, labels: LIFT_BANDS.map((x) => x.label), series: [line(a, (x) => x.a, 0), line(b, (x) => x.b, 1)], base: "和同类店一样", note };
  };
  // 拖动模拟：一家一般门店（开满 20 天的店里各项取中间那家），结果 = 两个乘数相乘。
  // ref：同类店里，前 1/4 那家比中间那家高多少，各组取中间值。滑块范围 −50% 到 +50%。
  const peerFull = groupsFull.flatMap((g) => g.stores);
  const room = (f: (s: PeerStore) => number) => median(groupsFull.map((g) => {
    const v = g.stores.map(f).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b); if (v.length < 8) return NaN;
    const mid = v[Math.floor((v.length - 1) / 2)]; const q3 = v[Math.floor((v.length - 1) * 0.75)]; return mid > 0 ? (q3 / mid - 1) * 100 : NaN;
  }).filter(Number.isFinite)) ?? 0;
  const typical = (f: (s: PeerStore) => number) => median(peerFull.map(f).filter((x) => Number.isFinite(x) && x > 0)) ?? 0;
  type Knob = { label: string; of: (s: PeerStore) => number; scale: number; unit: string; digits: number };
  const whatIf = (title: string, result: { label: string; unit: string; digits: number; scale: number }, a: Knob, b: Knob): InsightChart => {
    const ra = typical(a.of), rb = typical(b.of); const va = ra * a.scale, vb = rb * b.scale;
    const { scale, ...shown } = result;
    return { kind: "whatif", title, min: -50, max: 50,
      result: { ...shown, base: Math.round(ra * rb * scale * 100) / 100 },
      factors: [a, b].map((k, i) => ({ label: k.label, base: Math.round((i ? vb : va) * 100) / 100, unit: k.unit, digits: k.digits, ref: Math.round(room(k.of)) })),
      note: `以一家一般门店为例（各项取全国开满 20 天的店的中间值）。${result.label} = ${a.label} × ${b.label}：一个不动、另一个提高多少，${result.label}就跟着变多少。三角是同类店（商圈、铺型、区域相同）前 1/4 的店比一般店高多少。` };
  };
  const ordersK: Knob = { label: "每天订单数", of: (s) => div(s.orders, s.days), scale: 1, unit: " 单", digits: 1 };
  const salesWhatIf = whatIf("拖一拖：订单数不变，客单价提高，销售额会怎样", { label: "销售额", unit: " 万", digits: 2, scale: 1e-4 },
    ordersK, { label: "客单价", of: (s) => div(s.sales, s.orders), scale: 1e-4, unit: " 万", digits: 2 });
  const qtyWhatIf = whatIf("拖一拖：订单数、每单件数各提高多少，销量会怎样", { label: "销量", unit: " 件", digits: 1, scale: 1 },
    ordersK, { label: "每单件数", of: (s) => div(s.items, s.orders), scale: 1, unit: " 件", digits: 2 });
  const gpWhatIf = whatIf("拖一拖：销售额、毛利率各提高多少，毛利会怎样", { label: "毛利", unit: " 万", digits: 2, scale: 1e-4 },
    { label: "每天销售额（不含税）", of: (s) => div(s.revEx, s.days), scale: 1e-4, unit: " 万", digits: 2 }, { label: "毛利率", of: (s) => div(s.gp, s.revEx), scale: 100, unit: "%", digits: 1 });
  const L = {
    sales: { label: "销售额", of: (s: PeerStore) => div(s.sales, s.days), text: wan },
    orders: { label: "订单数", of: (s: PeerStore) => div(s.orders, s.days), text: (v: number) => `${n1(v)} 单` },
    aov: { label: "客单价", of: (s: PeerStore) => div(s.sales, s.orders), text: yuan },
    qty: { label: "销量", of: (s: PeerStore) => div(s.items, s.days), text: (v: number) => `${n1(v)} 件` },
    ipo: { label: "每单件数", of: (s: PeerStore) => div(s.items, s.orders), text: (v: number) => `${v.toFixed(2)} 件` },
    gp: { label: "毛利", of: (s: PeerStore) => div(s.gp, s.days), text: wan },
    rev: { label: "销售额", of: (s: PeerStore) => div(s.revEx, s.days), text: wan },
    gm: { label: "毛利率", of: (s: PeerStore) => div(s.gp, s.revEx), text: (v: number) => pct(v * 100) },
  };
  const liftNote = (x: string) => `横轴：这一项比同类店（商圈、铺型、区域都相同）高多少；纵轴：这样的店，${x}是同类的几倍。门店之间的对比，不等于把这一项提上去就一定涨这么多。`;
  const salesLift = liftChart("客单价、订单数各高多少，销售额跟着高多少", L.sales, L.orders, L.aov, liftNote("销售额"));
  const qtyLift = liftChart("订单数、每单件数各高多少，销量跟着高多少", L.qty, L.orders, L.ipo, liftNote("销量"));
  const gpLift = liftChart("销售额、毛利率各高多少，毛利跟着高多少", L.gp, L.rev, L.gm, liftNote("毛利"));

  // ---------- 业务卡片 ----------
  // 给总部业务看：一句话结论（【】里的数字标蓝）→ 一张对比图 → 怎么知道的 → 要注意 → 可以怎么做（AI 建议）。
  // evidence 是支撑建议的数据事实，问答时只能照这些回答，不能把建议本身当成数据。
  type Item = { label: string; sub?: string; value: number; text: string; tone?: "base" | "hot" | "normal" };
  // 对比柱：最高的一档标 hot；base 指定对照那一档（灰）。
  const compare = (title: string, items: Item[], note?: string, hot: "max" | "min" | number = "max"): InsightChart => {
    const vals = items.map((x) => x.value); const pick = hot === "max" ? vals.indexOf(Math.max(...vals)) : hot === "min" ? vals.indexOf(Math.min(...vals)) : hot;
    return { kind: "compare", title, items: items.map((x, i) => ({ ...x, tone: x.tone ?? (i === pick ? "hot" : "normal") })), ...(note ? { note } : {}) };
  };
  type Card = InsightNode["card"];
  const C = (say: string, how: string, watch: string[], todo: string | null, evidence: string[], more: { chart?: InsightChart; sim?: InsightChart; stores?: Card["stores"]; todoNote?: string } = {}): Card =>
    ({ say, how, watch, todo, evidence, ...more, ...(todo ? {} : { todoNote: more.todoNote ?? "数据给不出具体的做法。" }) });
  const imgTop = imageRows[0]; const imgLow = imageRows.at(-1);
  const imgSocial = imageRows.find((r) => r.k.startsWith("社区")) ?? imgLow;
  const imageItems = imageRows.filter((r) => r.n >= 20).map((r): Item => ({ label: short(r.k), sub: `${n0(r.n)} 家`, value: r1(r.m / 1e4), text: `${n0(r.m / 1e4)} 万`, ...(r === imgSocial ? { tone: "base" as const } : {}) }));
  const imageCompare = compare("一家店一个月卖多少（万元）", imageItems, "每档取中间那家店");
  const ordAvgOrders = ordinary.length ? mean(ordinary.map((d) => d.orders)) : 0;
  const k50Ratio = baseG.gramsPerItem > 0 ? k50.gramsPerItem / baseG.gramsPerItem : 0;
  const dayGroups = (() => {
    const avg = (f: (d: DailyRow) => boolean) => { const x = daily.filter(f); return x.length ? mean(x.map((d) => d.sales)) : 0; };
    const before = (d: DailyRow) => d.day < rollout; const notPeak = (d: DailyRow) => d.day !== peak?.day;
    return [
      { label: "平常", value: ordinaryAvg, tone: "base" as const },
      { label: "周末", value: avg((d) => before(d) && (d.dow === 0 || d.dow === 6)) },
      { label: "周二", sub: "金色", value: avg((d) => before(d) && d.dow === 2) },
      { label: "克减后", sub: "平日", value: avg((d) => !before(d) && d.dow >= 1 && d.dow <= 5 && notPeak(d)) },
      { label: "克减后", sub: "周末", value: avg((d) => !before(d) && (d.dow === 0 || d.dow === 6)) },
      ...(peak ? [{ label: festName, sub: day(peak.day), value: peak.sales }] : []),
    ].filter((g) => g.value > 0).map((g): Item => ({ ...g, value: r2(g.value / 1e8), text: n1(g.value / 1e8) }));
  })();
  const dayCompare = compare("全国一天卖多少（亿元）", dayGroups, "同类日子取平均；平常 = 8/22 前不过节的周一、三、四");
  // 「做活动、过节」的日子：金色星期二、克减后、节日当天；周末不算。
  const dayBase = dayGroups[0]?.value ?? 1;
  const promoDays = dayGroups.filter((g) => g.sub === "金色" || g.label === "克减后" || g.label === festName).map((g) => g.value);
  const dayMax = Math.max(...promoDays, dayBase); const dayMin2 = promoDays.length ? Math.min(...promoDays) : dayBase;
  const promoMax = Math.max(...promoSales); const promoTop = PROMO[promoSales.indexOf(promoMax)];
  const promoCompare = compare("同一家店：没活动的日子算 1 倍", [{ label: "没活动", value: 1, text: "1 倍", tone: "base" } as Item, ...PROMO.map((name, i): Item => ({ label: name, value: r1(promoSales[i]), text: `${n1(promoSales[i])} 倍` })).sort((a, b) => a.value - b.value)]);
  const mixItems = mixBands.map((r, i): Item => ({ label: r.label, sub: `${n0(r.n)} 家`, value: r1(r.m), text: pct(r.m), ...(i === mixBands.length - 1 ? { tone: "base" as const } : {}) }));
  const mixCompare = compare("门店毛利率，按计价金占这家店销售额多少分档", mixItems);
  // 店名在侧栏里要一眼认出：去掉品牌前缀（周大福荟馆、JEWELRIA 这类）和「珠宝店」后缀，留下城市和地标。
  const shortStore = shortStoreName;
  const lagStores = (x: ReturnType<typeof comparePeers>, title: string, unit: string, fmtv: (v: number) => number): Card["stores"] | undefined =>
    x?.lagRows.length ? { title, unit, rows: x.lagRows.slice(0, 3).map((r) => ({ name: shortStore(r.name), value: r1(fmtv(r.value)) })), peer: r1(fmtv(median(x.lagRows.slice(0, 3).map((r) => r.peer)) ?? 0)) } : undefined;
  const ptItems = (of: (p: PtypeRow) => number, text: (v: number) => string) => [gold, fixed, inlay].map((p): Item => ({ label: p.ptype, value: r1(of(p)), text: text(of(p)), ...(p === gold ? { tone: "base" as const } : {}) }));
  const ptGmCompare = compare("各类货的毛利率", ptItems(ptGm, pct));
  const tradeItems: Item[] = [
    { label: "金色星期二", value: r1(share(trGt.tradeIn, trGt.orders)), text: pct(share(trGt.tradeIn, trGt.orders)) },
    { label: "一般開單", value: r1(share(trBase.tradeIn, trBase.orders)), text: pct(share(trBase.tradeIn, trBase.orders)), tone: "base" },
    { label: "克减类", value: r1(promoTradeInShare), text: pct(promoTradeInShare) },
  ];
  const depthItems: Item[] = [["克减 30", g30], ["克减 50", g50], ["金色星期二", gGt]].map(([label, v]) => ({ label: label as string, value: r1(v as number), text: `${n1(v as number)} 元` }));
  const gramItems: Item[] = [["一般開單", baseG.gramsPerItem], ["克减 30", k30.gramsPerItem], ["金色星期二", gtG.gramsPerItem], ["克减 50", k50.gramsPerItem]].map(([label, v], i) => ({ label: label as string, value: r1(v as number), text: `${n1(v as number)} 克`, ...(i === 0 ? { tone: "base" as const } : {}) }));
  const heavyItems: Item[] = [["一般開單", baseG.ge20], ["克减 30", k30.ge20], ["克减 50", k50.ge20]].map(([label, v], i) => ({ label: label as string, value: r1(v as number), text: pct(v as number), ...(i === 0 ? { tone: "base" as const } : {}) }));
  const regionItems = regionRows.map((r): Item => ({ label: r.k, sub: `${n0(r.n)} 家`, value: r1(r.m / 1e4), text: `${n0(r.m / 1e4)} 万` }));
  const natureItems = natureGm.map((r): Item => ({ label: r.k.replace("(", "（").replace(")", "）"), sub: `${n0(r.n)} 家`, value: r1(r.m), text: pct(r.m) }));
  const expShown = (bigExp.length >= 2 ? bigExp : expRows).slice(0, 4);
  const expAovItems = expShown.map((r): Item => ({ label: r.k.replace("周大福", ""), sub: `${n0(r.n)} 家`, value: r1(r.aov), text: `${n0(r.aov)} 元` }));
  const expSalesItems = expShown.map((r): Item => ({ label: r.k.replace("周大福", ""), sub: `${n0(r.n)} 家`, value: r1(r.m / 1e4), text: `${n0(r.m / 1e4)} 万` }));
  const areaItems = areaRows.map((r): Item => ({ label: r.k.replace("平方米", "㎡"), sub: `${n0(r.n)} 家`, value: r1(r.m / 1e4), text: `${n0(r.m / 1e4)} 万` }));
  const dowItems = [...DOW.slice(1), DOW[0]].flatMap((name) => dowRows.filter((r) => r.name === name)).map((r): Item => ({ label: r.name, value: r2(r.avg / 1e8), text: n1(r.avg / 1e8) }));
  const dowLow = Math.min(...dowItems.map((x) => x.value));
  const shiftItems: Item[] = [
    { label: "一般開單", sub: `${day(rollout)} 前`, value: r1(shift.baseBefore / 1e4), text: `${n0(shift.baseBefore / 1e4)} 万`, tone: "base" },
    { label: "一般開單", sub: `${day(rollout)} 后`, value: r1(shift.baseAfter / 1e4), text: `${n0(shift.baseAfter / 1e4)} 万`, tone: "base" },
    { label: "活动", sub: `${day(rollout)} 前`, value: r1(shift.promoBefore / 1e4), text: `${n0(shift.promoBefore / 1e4)} 万` },
    { label: "活动", sub: `${day(rollout)} 后`, value: r1(shift.promoAfter / 1e4), text: `${n0(shift.promoAfter / 1e4)} 万`, tone: "hot" },
  ];
  const promoGmItems: Item[] = PROMO.map((name, i) => ({ label: name, value: r1(Math.abs(promoGm[i])), text: `低 ${n1(Math.abs(promoGm[i]))} 个点` }));
  const promoGoldItems: Item[] = PROMO.map((name, i) => ({ label: name, value: r1(promoGold[i]), text: `多 ${n1(promoGold[i])} 个点` }));
  const gtNew = trGt.sales - trGt.recycle;
  const peakTimes = peak && ordinaryAvg > 0 ? peak.sales / ordinaryAvg : 0;
  const orderTimes = peak && ordAvgOrders > 0 ? peak.orders / ordAvgOrders : 0;

  const nodeCards: Record<InsightNodeId, Card> = {
    image: C(`${imgTop ? short(imgTop.k) : ""}的店一个月卖【${imgTop ? n0(imgTop.m / 1e4) : 0} 万】，是社区店的 ${imgTop && imgSocial ? n1(imgTop.m / Math.max(1, imgSocial.m)) : 0} 倍`,
      `${n0(full.length)} 家开满 20 天的店按商圈分档比。在门店的各项条件（商圈、店型、面积、店龄、大区……）里，商圈带来的差别最大。`,
      [...(imgTop && imgTop.n < 150 ? [`${short(imgTop.k)}只有 ${n0(imgTop.n)} 家店，比其他档少很多，数字没那么稳。`] : []), ...(imageOut.top ? [`每一档里都有特别好的店：${short(imageOut.top.k)}里就有 ${n0(imageOut.top.n)} 家卖到本档一般水平的 3 倍以上。`] : [])],
      "比较活动效果、给门店定目标时，先按商圈分开比；同一档里卖得特别好的店，可以去看它们做对了什么。",
      [`各档商圈门店一个月卖多少：${imageRows.filter((r) => r.n >= 20).map((r) => `${short(r.k)} ${wan(r.m)}（${n0(r.n)} 家）`).join("，")}。`, ...(imageOut.top ? [`一个月卖到本档一般水平 3 倍以上的店共 ${n0(imageOut.count)} 家。`] : [])],
      { chart: imageCompare }),
    shoptype: C(`高端店型的客单价更高，一单最多到【${expShown.length ? n0(Math.max(...expShown.map((r) => r.aov))) : 0} 元】`,
      "各店型的店分开比，看一单平均多少钱、一个月卖多少。只列 30 家店以上的店型。",
      expRows.length && expRows[0].n < 30 ? [`卖得最多的「${expRows[0].k}」只有 ${n0(expRows[0].n)} 家，是少数旗舰店，不代表同类都能做到。`] : [],
      "推高单价的货（镶嵌、大克重），优先放在高端店型的店里推。",
      [`各店型客单价：${expShown.map((r) => `${r.k} ${n0(r.aov)} 元（${n0(r.n)} 家）`).join("，")}。`],
      { chart: compare("一单平均多少钱（元）", expAovItems) }),
    areaage: C("面积、店龄、城市级别带来的差别都不大",
      "单独看这几项和销售额有关系，但商圈和店型一样的店放在一起比，差别就很小了。",
      areaRows.length >= 2 ? [`面积最大的一档不一定卖得最多：卖得最多的是「${areaRows[0].k}」的店。`] : [],
      null, [], { chart: areaItems.length >= 2 ? compare("一家店一个月卖多少（万元），按面积分", areaItems) : undefined, todoNote: "这几项影响很小，按它们挑门店意义不大。" }),
    region: C(`各大区的店卖得差不多，最多差【${regionRows.length >= 2 ? n0((regionRows[0].m / Math.max(1, regionRows.at(-1)!.m) - 1) * 100) : 0}%】`,
      "每个大区取中间那家店，看一个月卖多少。",
      ["大区之间看起来的差别，多半是各区好商圈、高端店型的店多少不同，不是大区本身的原因。"],
      "比较大区好坏之前，先把商圈和店型一样的店放在一起比。",
      [`各大区门店一个月卖多少：${regionRows.map((r) => `${r.k} ${wan(r.m)}（${n0(r.n)} 家）`).join("，")}。`],
      { chart: compare("一家店一个月卖多少（万元）", regionItems) }),
    nature: C("自营还是加盟，卖多少几乎一样；毛利率自营店略低",
      "按分店性质分开，看门店毛利率的一般水平。",
      ["毛利率差不到 2 个百分点，原因可能是加盟店进货价口径不同，要问财务。"],
      null, [], { chart: compare("门店毛利率", natureItems), todoNote: "差别很小，原因要先和财务确认。" }),
    qixi: C(`${festName}当天全国卖了【${peak ? yi(peak.sales) : "0"}】，是平常的 ${n1(peakTimes)} 倍`,
      `平常 = ${day(rollout)} 前不过节的周一、三、四，平均一天 ${yi(ordinaryAvg)}。`,
      ["节日和克减全国铺开在同一周，节日自己拉了多少、活动拉了多少，分不开。"],
      `明年${festName}把克减和节日错开一周做，就能看出节日自己拉了多少。`,
      [`${festName}当天 ${peak ? yi(peak.sales) : ""}，平常工作日一天 ${yi(ordinaryAvg)}。`, `克减从 ${day(rollout)} 起全国铺开，和${festName}在同一周。`],
      { chart: dayCompare }),
    weekday: C(`周二一天卖【${yi(tueAvg)}】，比周一三四多一倍多：金色星期二`,
      `看 ${day(rollout)} 前不过节的日子，各星期几全国平均一天卖多少。`,
      [`周二多出来的主要是计价金（周二 ${yi(tueGold)}，平常 ${yi(ordGold)}），而且几乎每单都带旧金来换。`],
      "看金色星期二的效果，要看收进了多少新钱（扣掉旧金抵的部分），不能只看卖了多少。",
      [`${day(rollout)} 前周二平均一天 ${yi(tueAvg)}，周一三四 ${yi(ordinaryAvg)}，周末 ${yi(weekendAvg)}。`, `金色星期二卖了 ${yi(trGt.sales)}，其中 ${yi(trGt.recycle)} 是旧金抵的。`],
      { chart: compare("全国一天卖多少（亿元），不含节日", dowItems.map((x) => x.value === dowLow ? { ...x, tone: "base" as const } : x)) }),
    depth: C(`克减 50 每克实际让【${n1(g50)} 元】，克减 30 让 ${n1(g30)} 元`,
      "和同一天的一般開單比，活动每克少收了多少钱。",
      [`克减 30 实际只让了 ${n1(g30)} 元，不到名义的 30 元，可能有克数门槛或叠加规则，要用规则表核对。`, "金色星期二的优惠在旧金抵价上，所以每克几乎不让。"],
      `定力度时要和它带来的大件一起看：克减 50 顾客平均每件买 ${n1(k50.gramsPerItem)} 克，一般開單 ${n1(baseG.gramsPerItem)} 克。`,
      [`每克实际少收：克减 50 ${n1(g50)} 元，克减 30 ${n1(g30)} 元，金色星期二 ${n1(gGt)} 元。`, `计价金每件平均克重：克减 50 ${n1(k50.gramsPerItem)} 克，一般開單 ${n1(baseG.gramsPerItem)} 克。`],
      { chart: compare("每克实际少收多少钱", depthItems) }),
    threshold: C(`克减 50 的顾客集中买 20 克以上：【${pct(k50.ge20)}】的计价金是 20 克以上的货`,
      "数每个克重卖了多少件，比较克减 50 和一般開單。",
      [`从 19 克到 20 克，克减 50 的件数从 ${n0(t19.k50)} 跳到 ${n0(t20.k50)}，一般開單却从 ${n0(t19.base)} 降到 ${n0(t20.base)}：像是有 20 克的门槛，规则表还没确认。`],
      "如果门槛确实是 20 克，可以重点备 20–22 克的货，让顾客刚好跨过门槛。",
      [`20 克以上的货占计价金销售额：克减 50 ${pct(k50.ge20)}，克减 30 ${pct(k30.ge20)}，一般開單 ${pct(baseG.ge20)}。`, `19 克到 20 克：克减 50 ${n0(t19.k50)} → ${n0(t20.k50)} 件，一般開單 ${n0(t19.base)} → ${n0(t20.base)} 件。`],
      { chart: compare("20 克以上的货占计价金多少", heavyItems) }),
    tradein: C(`金色星期二几乎每单都带旧金换，卖的 ${yi(trGt.sales)} 里【${yi(trGt.recycle)}】是旧金抵的`,
      "按单看有没有回收旧金，以及旧金抵了多少钱。",
      [`金色星期二真正收进的新钱是 ${yi(gtNew)}。克减类基本不带旧金（${pct(promoTradeInShare)}）。`],
      "评估金色星期二时，用「卖了多少 − 旧金抵了多少」看收进的新钱。",
      [`金色星期二 ${n0(trGt.orders)} 单里 ${n0(trGt.tradeIn)} 单带旧金；卖了 ${yi(trGt.sales)}，旧金抵 ${yi(trGt.recycle)}。`, `一般開單 ${n0(trBase.orders)} 单里 ${n0(trBase.tradeIn)} 单带旧金。`],
      { chart: compare("带旧金来换的订单占多少", tradeItems) }),
    shift: C(`克减带来的大多是新增生意：一般開單只少了【${n1(Math.abs(shiftPct))}%】`,
      `比 ${day(rollout)} 克减全国铺开前后，周一、三、四全国一天的计价金销售额。`,
      ["铺开后离节日更近，新增里也有节日的功劳，所以挪过来的比例可能更大一些。"],
      "克减可以继续用来拉新增；节日前后做时，要和平常日子分开评估。",
      [`一般開單计价金每天 ${wan(shift.baseBefore)} → ${wan(shift.baseAfter)}；活动计价金 ${wan(shift.promoBefore)} → ${wan(shift.promoAfter)}。`],
      { chart: compare("周一三四全国一天的计价金（万元）", shiftItems, undefined, 3) }),
    gold: C("数据里没有每日金价", "计价金每克收的钱里，混着金价、工费和让利。", ["同一个月里比没问题；跨月、跨年比活动力度，需要先有每日金价。"], null, [], { todoNote: "需要先采集每日金价。" }),
    member: C(`分不出新老会员：【${pct(data.memberShare)}】的销售都标成了会员`, "明细里只有「是不是会员」。", ["想知道活动对新会员、老会员效果是否不同，需要会员 ID 和首购日期。"], null, [], { todoNote: "需要先采集会员 ID 和首购日期。" }),
    store: C(`门店之间差得多：${imgTop ? short(imgTop.k) : ""}的店一个月卖【${imgTop ? n0(imgTop.m / 1e4) : 0} 万】，社区店 ${imgSocial ? n0(imgSocial.m / 1e4) : 0} 万`,
      "把每家店每天卖多少，分成「这家店本身的水平」和「这一天的水平」两部分，门店本身的部分更大。",
      ["门店条件里，商圈影响最大，其次是店型；面积、店龄、大区、自营还是加盟的影响都很小。"],
      "给门店定目标、比活动效果时，先按商圈和店型分组比。",
      [`各档商圈门店一个月卖多少：${imageRows.filter((r) => r.n >= 20).map((r) => `${short(r.k)} ${wan(r.m)}`).join("，")}。`],
      { chart: imageCompare }),
    day: C(`做活动、过节的日子，一天能卖到平常的【${n1(dayMin2 / Math.max(0.01, dayBase))} 到 ${n1(dayMax / Math.max(0.01, dayBase))} 倍】`,
      `把 8 月每天按「有没有活动、是不是节日」分开，算每类日子全国一天卖多少。`,
      [`${day(rollout)} 克减全国铺开和${festName}在同一周，这几天卖得多，活动和节日各占多少分不开。`],
      `明年${festName}把克减和节日错开一周做，就能看出活动自己拉了多少。`,
      dayGroups.map((g) => `${g.label}${g.sub ? `（${g.sub}）` : ""}全国一天 ${g.text} 亿。`),
      { chart: dayCompare }),
    promo: C(`同一家店，有${promoTop}成交的那天，卖得是平时的【${n1(promoMax)} 倍】`,
      "每家店只和自己比：有这个活动成交的日子，和它没有的日子比，并扣掉那天全国普遍的涨落。",
      ["门店会挑生意好的日子做活动，又和节日同周，倍数会比活动本身的效果偏高。", `活动那天卖的计价金更多，毛利率会低 ${n1(Math.min(...promoGm.map(Math.abs)))}–${n1(Math.max(...promoGm.map(Math.abs)))} 个百分点。`],
      `想拉单量，${promoTop}效果最明显；活动里多配一口价和镶嵌货，可以少压一点毛利。`,
      [...PROMO.map((name, i) => `有${name}成交的那天，同一家店卖得是平时的 ${n1(promoSales[i])} 倍，毛利率低 ${n1(Math.abs(promoGm[i]))} 个百分点。`), `一口价黄金毛利率 ${pct(ptGm(fixed))}，镶嵌 ${pct(ptGm(inlay))}，计价金 ${pct(ptGm(gold))}。`],
      { chart: promoCompare }),
    mix: C(`计价金卖得越多的店，毛利率越低：从【${mixBands.length ? pct(mixBands[0].m) : ""}】降到 ${mixBands.length ? pct(mixBands.at(-1)!.m) : ""}`,
      `计价金本身毛利率只有 ${pct(ptGm(gold))}，一口价黄金 ${pct(ptGm(fixed))}、镶嵌 ${pct(ptGm(inlay))}。所以一家店卖的计价金越多，整体毛利率就越低。`,
      [`计价金卖了 ${pct(share(gold.sales, total.sales))} 的钱，只贡献 ${pct(share(gold.gp, total.gp))} 的毛利。`],
      "想保毛利，提高一口价和镶嵌货的占比。",
      [...mixBands.map((r) => `计价金占 ${r.label}的店（${n0(r.n)} 家），毛利率 ${pct(r.m)}。`), `各类货毛利率：计价金 ${pct(ptGm(gold))}，一口价黄金 ${pct(ptGm(fixed))}，镶嵌及其他 ${pct(ptGm(inlay))}。`],
      { chart: mixCompare }),
    orders: C(`卖得多的店和日子，主要是【单多】，不是每单贵`,
      `销售额 = 订单数 × 客单价。店和店、天和天卖得不一样，主要差在订单数上。8 月全国 ${n1(total.orders / 1e4)} 万单。`,
      ["数据里没有客流和成交率，订单数再往下拆不了。"],
      "提销售额先想办法多来单：好商圈的店和做活动、过节的日子，单量明显更多。",
      [`各档商圈门店一天多少单：${imageOrders.map((r) => `${short(r.k)} ${n1(r.m)} 单`).join("，")}。`, `全国平常工作日约 ${n1(ordAvgOrders / 1e4)} 万单${peak ? `，${festName} ${n1(peak.orders / 1e4)} 万单（${n1(orderTimes)} 倍）` : ""}。`],
      { chart: compare("一家店一天多少单", imageOrders.map((r): Item => ({ label: short(r.k), sub: `${n0(r.n)} 家`, value: r1(r.m), text: `${n1(r.m)} 单`, ...(r.k.startsWith("社区") ? { tone: "base" as const } : {}) }))), ...(ordersAovChart ? { sim: ordersAovChart } : {}) }),
    aov: C(`力度大的活动，顾客每件买得更重：克减 50 是一般開單的【${n1(k50Ratio)} 倍】`,
      `8 月平均一单 ${n0(total.orders > 0 ? total.sales / total.orders : 0)} 元。看每类活动计价金平均每件多少克。`,
      ["高端店型的客单价也更高，但这类店不多。"],
      "想提客单价，力度大的活动配大克重的货一起推。",
      [`计价金每件平均克重：${gramItems.map((x) => `${x.label} ${x.text}`).join("，")}。`],
      { chart: compare("计价金平均每件多少克", gramItems), ...(ordersAovChart ? { sim: ordersAovChart } : {}) }),
    gm: C(`一口价、镶嵌的毛利率是计价金的【2 倍】左右`,
      `毛利 = 销售额（不含税）× 毛利率。8 月整体毛利率 ${pct(gm)}，主要看卖了什么货。`,
      [`计价金卖了 ${pct(share(gold.sales, total.sales))} 的钱，只贡献 ${pct(share(gold.gp, total.gp))} 的毛利。`],
      "保毛利的关键是货品结构：一口价和镶嵌卖得越多，毛利率越高。",
      [`各类货毛利率：计价金 ${pct(ptGm(gold))}，一口价黄金 ${pct(ptGm(fixed))}，镶嵌及其他 ${pct(ptGm(inlay))}。`],
      { chart: ptGmCompare }),
    qty: C(`8 月卖了【${n0(total.items / 1e4)} 万件】，销量跟着订单数走`,
      "销量 = 订单数 × 每单件数。每单件数基本不变，所以看订单数就够了。",
      [], "想多卖件数，重点是多来单，而不是让顾客一单多买几件。",
      [`8 月 ${n0(total.items / 1e4)} 万件、${n1(total.orders / 1e4)} 万单，平均每单 ${(total.orders > 0 ? total.items / total.orders : 0).toFixed(2)} 件。`, `每单件数整个月都在 ${ipoLo.toFixed(2)}–${ipoHi.toFixed(2)} 件。`],
      { chart: qtyLift, sim: qtyWhatIf }),
    sales: C(`8 月卖了【${yi(total.sales)}】，起落主要跟着订单数`,
      `销售额 = 订单数 × 客单价。${n1(total.orders / 1e4)} 万单，平均一单 ${n0(total.orders > 0 ? total.sales / total.orders : 0)} 元。`,
      ["还没和 Power BI 核对，绝对数先只作参考。"],
      "提销售额先抓单量：好商圈的店、做活动和过节的日子。",
      [`8 月 ${yi(total.sales)}、${n1(total.orders / 1e4)} 万单。`, `客单价每天在 ${n0(aovLo)}–${n0(aovHi)} 元之间。`],
      { chart: salesLift, sim: salesWhatIf }),
    gp: C(`8 月毛利【${yi(total.gp)}】，毛利率 ${pct(gm)}，基本跟着销售额走`,
      "毛利 = 销售额（不含税）× 毛利率。毛利率每天变化不大。",
      ["做活动、过节的日子毛利率略低，因为那几天卖的计价金更多。"],
      "保毛利的关键是货品结构：活动里多配一口价和镶嵌货。",
      [`毛利率每天在 ${pct(gmLo)}–${pct(gmHi)} 之间。`, `计价金毛利率 ${pct(ptGm(gold))}，一口价黄金 ${pct(ptGm(fixed))}，镶嵌及其他 ${pct(ptGm(inlay))}。`],
      { chart: gpLift, sim: gpWhatIf }),
  };
  const lagMix = lagStores(peers.mix, "计价金卖得多、毛利率特别低的店", "%", (v) => v);
  const edgeCards: Record<string, Card> = {
    "image>store": { ...nodeCards.image },
    "shoptype>store": C(`高端店型卖得更多：${expShown.length ? expShown[0].k.replace("周大福", "") : ""}一个月【${expShown.length ? n0(expShown[0].m / 1e4) : 0} 万】`,
      "各店型的店分开比一个月卖多少，只列 30 家店以上的店型。", ["店型的影响比商圈小；高端店型多开在好商圈里，两者有重叠。"],
      null, [], { chart: compare("一家店一个月卖多少（万元）", expSalesItems), todoNote: "店型不是能马上改的，先按店型分组比较即可。" }),
    "areaage>store": nodeCards.areaage, "region>store": nodeCards.region, "nature>store": nodeCards.nature,
    "qixi>day": nodeCards.qixi, "weekday>day": nodeCards.weekday, "depth>promo": nodeCards.depth, "threshold>promo": nodeCards.threshold, "tradein>promo": nodeCards.tradein, "shift>promo": nodeCards.shift,
    "gold>promo": nodeCards.gold, "member>orders": nodeCards.member,
    "store>orders": C(`好商圈的店每天单多：${imageOrders.length ? short(imageOrders[0].k) : ""}一天【${imageOrders.length ? n1(imageOrders[0].m) : 0} 单】`,
      "各档商圈取中间那家店，看一天多少单。", ["同一档里差别也不小，社区店里也有一天 20 单以上的店。"],
      "同一档商圈里单量特别多的店，可以去看它们做对了什么。", nodeCards.orders.evidence.slice(0, 1), { chart: nodeCards.orders.chart }),
    "store>aov": nodeCards.shoptype,
    "day>orders": C(`做活动、过节的日子，单量明显更多：${festName}一天【${peak ? n1(peak.orders / 1e4) : 0} 万单】`,
      `平常工作日全国约 ${n1(ordAvgOrders / 1e4)} 万单。`, [`${festName}和克减在同一周，分不开。`],
      "排活动时看哪天能多来人，比看哪天客单高更重要。", nodeCards.orders.evidence.slice(1), { chart: dayCompare }),
    "promo>orders": nodeCards.promo,
    "promo>aov": nodeCards.aov,
    "promo>gm": C(`有活动成交的那天，毛利率低【${n1(Math.min(...promoGm.map(Math.abs)))}–${n1(Math.max(...promoGm.map(Math.abs)))} 个百分点】`,
      "同一家店，有这个活动成交的日子和没有的日子比毛利率。", ["压毛利率主要是因为那天卖的计价金更多，不是让利本身。"],
      "活动里多配一口价和镶嵌货，可以少压一点毛利。",
      [...PROMO.map((name, i) => `有${name}成交的那天，毛利率低 ${n1(Math.abs(promoGm[i]))} 个百分点、计价金占比多 ${n1(promoGold[i])} 个百分点。`)],
      { chart: compare("毛利率比平时低多少（个百分点）", promoGmItems, undefined, "min") }),
    "promo>mix": C(`有活动成交的那天，卖的计价金更多：最多多【${n1(Math.max(...promoGold))} 个百分点】`,
      "同一家店，有这个活动成交的日子和没有的日子比，计价金占销售额多少。", ["这就是活动压毛利率的原因。"],
      "活动里多配一口价和镶嵌货。", PROMO.map((name, i) => `有${name}成交的那天，计价金占比多 ${n1(promoGold[i])} 个百分点。`),
      { chart: compare("计价金占比比平时多多少（个百分点）", promoGoldItems, undefined, "min") }),
    "mix>gm": { ...nodeCards.mix, watch: [...nodeCards.mix.watch, ...(lagMix ? ["同一类店里，也有计价金卖得特别多、毛利率特别低的："] : [])], ...(lagMix ? { stores: lagMix } : {}),
      ...(lagMix ? { todo: "想保毛利，提高一口价和镶嵌货的占比；下面这几家店可以优先看看货品结构。", evidence: [...nodeCards.mix.evidence, ...(peers.mix?.laggards.slice(0, 3) ?? [])] } : {}) },
    "orders>qty": nodeCards.qty, "orders>sales": nodeCards.sales, "aov>sales": nodeCards.sales, "gm>gp": nodeCards.gp,
  };

  // ---------- 连线 ----------
  // 有分数的线：档位由分数换算。恒等式、缺数据没有分数。
  // more：异常（数据里能看到的特殊案例和共同点）、推荐（表现最好的取值和搭配）。推荐给不出时写原因。
  type More = { anomalies?: string[]; recommendation?: string | null; noRecommendation?: string };
  // 有分数的线可以另带一个效应值（effect），作为分数之外的直观说明。
  // 拆解线（恒等式）也给分数，但档位保持「拆解」，画成灰线，和因素线区分。
  const E = (from: InsightNodeId, to: InsightNodeId, x: (InsightScore & { effect?: Effect; identity?: boolean }) | "id" | "missing", basis: string, more: More = {}): Omit<InsightEdge, "card"> => {
    const rest = { basis, anomalies: more.anomalies ?? [], recommendation: more.recommendation ?? null, ...(more.recommendation ? {} : { noRecommendation: more.noRecommendation ?? (x === "id" ? "这是恒等式，没有可选的取值。" : x === "missing" ? "没有数据，推荐不了。" : "关系太弱，按它挑门店或时间意义不大。") }) };
    if (typeof x === "string") return { from, to, strength: x, ...rest };
    const { effect, identity, ...score } = x;
    const restId = identity ? { ...rest, recommendation: null, noRecommendation: "这是恒等式拆解，没有可选的取值；分数说明结果的差异主要来自哪一项。" } : rest;
    return { from, to, strength: identity ? "id" : byScore(score), score, ...(effect ? { effect: { text: effect.text, measure: effect.measure } } : {}), ...restId };
  };
  const raw: Array<Omit<InsightEdge, "card">> = [
    E("image", "store", sc.image, `商圈越好的店一个月卖得越多：${imageRows.filter((r) => r.n >= 20).map((r) => `${short(r.k)} ${wan(r.m)}`).join("，")}。门店属性里它影响最大。`, { anomalies: [
      ...(imageOut.top ? [`每一档里都有特别好的店：一个月卖得超过本档一般水平 3 倍的有 ${n0(imageOut.count)} 家，其中「${short(imageOut.top.k)}」最多（${n0(imageOut.top.n)} 家）。`] : []),
      ...(imageRows.length >= 2 ? [`「${short(imageRows[0].k)}」只有 ${n0(imageRows[0].n)} 家店，比其他档少很多，数字不如别的档稳。`] : []) ],
      recommendation: imageCombo ? `卖得最多的搭配是「${imageCombo.a}」+「${imageCombo.b}」：${n0(imageCombo.n)} 家店，一个月 ${wan(imageCombo.m)}。比较活动效果时，先把同一档商圈的店放在一起比。` : null }),
    E("shoptype", "store", sc.shoptype, `店型越高端卖得越多：${(bigExp.length >= 2 ? bigExp : expRows).slice(0, 3).map((r) => `${r.k}一个月 ${wan(r.m)}`).join("，")}。影响比商圈小。`, { anomalies: expRows.length && expRows[0].n < 30 ? [`最高的「${expRows[0].k}」只有 ${n0(expRows[0].n)} 家店，是少数旗舰店，不代表同类店都能做到。`] : [],
      recommendation: expRows.length >= 2 ? `店数够多（≥ 100 家）的店型里，「${(expRows.find((r) => r.n >= 100) ?? expRows[0]).k}」一个月卖得最多（${wan((expRows.find((r) => r.n >= 100) ?? expRows[0]).m)}）。` : null }),
    E("areaage", "store", sc.areaage, "商圈和店型一样的店放在一起比，面积、店龄、城市级别带来的差别都很小。", { anomalies: areaRows.length >= 2 ? [`面积最大的一档不一定卖得最多：一个月卖得最多的是「${areaRows[0].k}」（${wan(areaRows[0].m)}，${n0(areaRows[0].n)} 家）。`] : [],
      noRecommendation: "控制商圈和店型以后这几项作用都不大，按它们挑门店意义不大。" }),
    E("region", "store", sc.region, `各大区的店卖得差不多${regionRows.length >= 2 ? `：最高的${regionRows[0].k}一个月 ${wan(regionRows[0].m)}，最低的${regionRows.at(-1)!.k} ${wan(regionRows.at(-1)!.m)}` : ""}。大区之间的差，多半是各区好商圈、高端店的多少不同。`, { anomalies: [
      ...(sameImageAcrossRegions ? [`同是「${sameImageAcrossRegions.image}」的店，${sameImageAcrossRegions.hi.k}一个月 ${wan(sameImageAcrossRegions.hi.m)}，${sameImageAcrossRegions.lo.k} ${wan(sameImageAcrossRegions.lo.m)}：商圈一样的店放在一起比，大区之间仍有差距，但比不同商圈之间的差小。`] : []),
      ...(regionOut.top ? [`特别好的店（一个月卖得超过本大区一般水平 3 倍）${regionOut.top.k}最多，${n0(regionOut.top.n)} 家，可以从这些店找共性。`] : []) ],
      noRecommendation: regionRows.length ? "大区本身影响很小，先把商圈和店型一样的店放在一起，再比大区。" : undefined }),
    E("nature", "store", sc.natureSales, "自营还是加盟，对卖多少几乎没有影响；毛利率上自营店略低一点。", { anomalies: natureGm.length >= 2 ? [`毛利率上有差别：${natureGm[0].k}的店 ${pct(natureGm[0].m)}，${natureGm.at(-1)!.k} ${pct(natureGm.at(-1)!.m)}；原因不明，可能是进货价口径不同，要问财务。`] : [],
      noRecommendation: "对销售额几乎没有独立作用。" }),
    E("qixi", "day", sc.qixi, peak ? `${day(peak.day)} ${festName}一天卖了 ${yi(peak.sales)}，平常工作日一天 ${yi(ordinaryAvg)}，是 ${n1(peak.sales / ordinaryAvg)} 倍。` : "数据里没有节日。", { anomalies: [
      ...(festSorted.length >= 2 ? [`节日期间并不是每天都高：${festName}当天 ${yi(festSorted[0].sales)}，同期最低的 ${day(festSorted.at(-1)!.day)} 只有 ${yi(festSorted.at(-1)!.sales)}。`] : []),
      "节日和克减铺开在同一周，节日自己拉多少、活动拉多少拆不开。" ],
      recommendation: peak ? `${festName}当天（${day(peak.day)}）是全月最高；排活动时把力度集中在节日前几天和当天，两年同比按「距节日天数」对齐。` : null }),
    E("weekday", "day", sc.weekday, `${day(rollout)} 前，周二平均一天卖 ${yi(tueAvg)}，周一、三、四只有 ${yi(ordinaryAvg)}。多出来的主要是计价金，这是金色星期二带的。`, { anomalies: lowDay ? [`全月最低的一天是 ${day(lowDay.day)}（${DOW[lowDay.dow]}），${yi(lowDay.sales)}。`] : [],
      recommendation: dowRows.length ? `不含节日，日均最高的是${dowRows[0].name}（${yi(dowRows[0].avg)}），最低的是${dowRows.at(-1)!.name}（${yi(dowRows.at(-1)!.avg)}）。周二高是金色星期二带的。` : null }),
    E("depth", "promo", { ...sc.depth, effect: ef.depth }, `和同一天的一般開單比，每克实际少收：克减 50 ${n1(g50)} 元，克减 30 ${n1(g30)} 元，金色星期二 ${n1(gGt)} 元。`, { anomalies: [`克减 30 实让 ${n1(g30)} 元/克，不到名义的 30 元；可能有克数门槛或叠加规则，规则表没给。`, `金色星期二每克只让 ${n1(gGt)} 元，它的优惠在旧金抵价上，不在每克实收里。`],
      recommendation: `同日对齐看，克减 50 每克实让 ${n1(g50)} 元，是克减 30 的 ${n1(depthGap)} 倍；定力度时要和它带来的件均克重（×${n1(aovLift)}）一起看。` }),
    E("threshold", "promo", { ...sc.threshold, effect: ef.threshold }, `克减 50 的顾客集中买 20 克以上：从 19 克到 20 克，它的件数从 ${n0(t19.k50)} 跳到 ${n0(t20.k50)}，一般開單却从 ${n0(t19.base)} 降到 ${n0(t20.base)}。`, { anomalies: [`一般開單同区间是往下走的（${n0(t19.base)} → ${n0(t20.base)} 件），只有克减 50 在 20 克跳起来。`],
      recommendation: `克减 50 的计价金实收 ${pct(k50.ge20)} 在 20 克以上（克减 30 是 ${pct(k30.ge20)}），门槛在把顾客推向 20 克以上；门槛是 20 克要用规则表确认。` }),
    E("tradein", "promo", { ...sc.tradein, effect: ef.tradein }, `金色星期二几乎每单都带旧金来换：卖了 ${yi(trGt.sales)}，其中 ${yi(trGt.recycle)} 是旧金抵的。克减类基本不带旧金。`, { anomalies: [`克减类几乎不带回收旧金（${pct(promoTradeInShare)}），以旧换新基本只在金色星期二和一般開單里。`],
      recommendation: `看金色星期二要用「成交 − 旧金抵扣」看收进的新钱：成交 ${yi(trGt.sales)}，其中 ${yi(trGt.recycle)} 是旧金抵的。` }),
    E("shift", "promo", { ...sc.shift, effect: ef.shift }, `克减铺开后，一般開單的计价金每天从 ${wan(shift.baseBefore)} 变成 ${wan(shift.baseAfter)}，只少了 ${n1(Math.abs(shiftPct))}%；活动的从 ${wan(shift.promoBefore)} 涨到 ${wan(shift.promoAfter)}。大多是新增，不是挪过来的。`, { anomalies: ["同期离节日更近，新增里混着节日拉动，挪动的比例可能被低估。"],
      recommendation: `大部分像新增：一般開單只降了 ${n1(Math.abs(shiftPct))}%，活动计价金从 ${wan(shift.promoBefore)} 涨到 ${wan(shift.promoAfter)}。` }),
    E("gold", "promo", "missing", "数据里没有每日金价。同一个月里比没问题，跨月、跨年比活动力度时要补上金价。", { noRecommendation: "需要先采集每日金价。" }),
    E("member", "orders", "missing", `${pct(data.memberShare)} 的销售额都标成了会员，分不出新老会员，看不了活动对新老会员的效果。`, { noRecommendation: "需要先采集会员 ID 和首购日期。" }),
    E("store", "orders", sc.storeOrders, `好店每天的单多：${imageOrders.slice(0, 1).map((r) => `${short(r.k)}的店一天 ${n1(r.m)} 单`).join("")}${imageOrders.length >= 2 ? `，${short(imageOrders.at(-1)!.k)} ${n1(imageOrders.at(-1)!.m)} 单` : ""}。`, { recommendation: `拉销售额主要靠单量：门店之间差多少，${pct(storeSplit.orders)} 是订单数的差。` }),
    E("store", "aov", sc.storeAov, `高端店型的客单价更高：${(bigExp.length >= 2 ? bigExp : expRows).slice(0, 3).map((r) => `${r.k} ${n0(r.aov)} 元`).join("，")}。`, { recommendation: expRows.length ? `客单最高的店型：${[...expRows].sort((a, b) => b.aov - a.aov)[0].k}（客单价 ${n0([...expRows].sort((a, b) => b.aov - a.aov)[0].aov)} 元）。` : null }),
    E("day", "orders", sc.dayOrders, `全国一天的单量随日子变化很大：平常工作日约 ${n1(ordinary.length ? mean(ordinary.map((d) => d.orders)) / 1e4 : 0)} 万单${peak ? `，${festName} ${n1(peak.orders / 1e4)} 万单` : ""}。哪天卖得多，主要是那天来的单多。`, { recommendation: `逐日看销售额的波动 ${pct(daySplit.orders)} 在单量；排期要看哪天能多来人，而不是哪天客单高。` }),
    E("promo", "orders", sc.promoOrders, `同一家店，有活动成交的那天卖得更多：${PROMO.map((name, i) => `${name}是平时的 ${n1(promoSales[i])} 倍`).join("，")}，多出来的主要是单量。`, { anomalies: ["门店自己选哪天做活动，又和节日同周，倍数会高估活动本身。"],
      recommendation: `同店同日看，${PROMO[promoSales.indexOf(Math.max(...promoSales))]}当天销售额倍数最高（${times(Math.max(...promoSales))}）。` }),
    E("promo", "aov", { ...sc.promoAov, effect: ef.promoAov }, `力度大的活动卖大件：克减 50 计价金件均 ${n1(k50.gramsPerItem)} 克，金色星期二 ${n1(gtG.gramsPerItem)} 克，一般開單 ${n1(baseG.gramsPerItem)} 克。`, { recommendation: `力度大的活动卖大件：克减 50 件均 ${n1(k50.gramsPerItem)} 克，是一般開單的 ${n1(aovLift)} 倍。` }),
    E("promo", "gm", sc.promoGm, `同一家店，有活动成交的那天毛利率更低：${PROMO.map((name, i) => `${name}${gap(promoGm[i], "高", "低")}`).join("，")}。`, { anomalies: [`活动压毛利率主要是因为卖的货更偏计价金（见「活动和力度 → 货品结构」）。`],
      recommendation: `毛利率降得最少的是${PROMO[promoGm.indexOf(Math.max(...promoGm))]}（${gap(Math.max(...promoGm), "高", "低")}）。` }),
    E("promo", "mix", sc.promoGold, `同一家店，有活动成交的那天卖的计价金更多：计价金占销售额的比例，${PROMO.map((name, i) => `${name}${gap(promoGold[i], "多", "少")}`).join("，")}。活动压毛利率主要就是因为这个。`, { recommendation: `计价金多卖得最少的是${PROMO[promoGold.indexOf(Math.min(...promoGold))]}（${gap(Math.min(...promoGold), "多", "少")}）；想保毛利，活动里配一口价、镶嵌货。` }),
    E("mix", "gm", sc.mix, `计价金毛利率 ${pct(ptGm(gold))}，一口价黄金 ${pct(ptGm(fixed))}，镶嵌及其他 ${pct(ptGm(inlay))}。一家店计价金卖得越多，毛利率越低${mixBands.length >= 2 ? `：计价金占 ${mixBands[0].label}的店 ${pct(mixBands[0].m)}，占 ${mixBands.at(-1)!.label}的 ${pct(mixBands.at(-1)!.m)}` : ""}。`, { anomalies: [`计价金卖了 ${pct(share(gold.sales, total.sales))} 的钱，只贡献 ${pct(share(gold.gp, total.gp))} 的毛利。`],
      recommendation: `毛利率最高的是镶嵌及其他（${pct(ptGm(inlay))}），其次一口价黄金（${pct(ptGm(fixed))}）；保毛利要提这两类的占比。` }),
    E("orders", "qty", { ...sc.ordersQty, identity: true }, `销量 = 订单数 × 每单件数。每单件数基本不变（平均 ${(total.orders > 0 ? total.items / total.orders : 0).toFixed(2)} 件），销量的高低几乎全看订单数。`),
    E("orders", "sales", { ...sc.ordersSales, identity: true }, "销售额 = 订单数 × 客单价。店和店、天和天卖得不一样，主要差在订单数上。"),
    E("aov", "sales", { ...sc.aovSales, identity: true }, "销售额 = 订单数 × 客单价。客单价有差别，但比订单数小得多。"),
    E("gm", "gp", { ...sc.gmGp, identity: true }, "毛利 = 销售额（不含税）× 毛利率。店和店毛利差多少，主要差在销售额上，毛利率的差别小得多。"),
  ];

  const extra: Partial<Record<string, { peers?: ReturnType<typeof comparePeers>; outliers?: ReturnType<typeof outlierTable> }>> = {
    "mix>gm": { peers: peers.mix, outliers: gmOut }, "shift>promo": { peers: peers.shift }, "threshold>promo": { peers: peers.threshold },
    "depth>promo": { peers: peers.depth }, "promo>aov": { peers: peers.promoAov }, "promo>orders": { peers: peers.promoOrders },
    "orders>sales": { outliers: salesOut }, "store>aov": { outliers: aovOut },
  };
  const edges = raw.map((e) => ({ ...e, ...(edgeCharts[`${e.from}>${e.to}`] ? { chart: edgeCharts[`${e.from}>${e.to}`] } : {}) })).map((e) => { const x = extra[`${e.from}>${e.to}`]; if (!x) return e;
    // 离群店：页面画成表（outliers），文字版仍放进异常，问答照文字回答。
    const withOut = x.outliers ? { ...e, outliers: x.outliers, anomalies: [...x.outliers.text, ...e.anomalies] } : e;
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
    scope: { period: data.period, rows: data.rows, stores: storeCount, note: "一个月数据，只是相关" }, kpis, nodes: nodes.map((n) => ({ ...n, card: nodeCards[n.id], ...(nodeCharts[n.id] ? { chart: nodeCharts[n.id] } : {}) })), edges: edges.map((e) => ({ ...e, card: edgeCards[`${e.from}>${e.to}`] ?? nodeCards[e.to] })), summary, methods };
}
