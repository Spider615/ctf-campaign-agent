// 目标指标目录：图谱中心可以切换成哪个指标、怎么算、数据够不够。
// 每克让利按日对齐计算（见 score.ts 的 alignedGive），这里的 compute 只给单侧的整体值。
import type { CellSum, InsightCell, InsightFamily, InsightMetricId, InsightSource, InsightStatus } from "./types.ts";

export type InsightMetric = {
  label: string; family: InsightFamily; unit: string; definition: string; status: InsightStatus;
  higherIsBetter: boolean;
  // offerOnly：只看活动侧，没有对照差值（例如渗透率）。
  offerOnly?: boolean;
  compute(sum: CellSum): number | null;
};

// 指标的来源：公式里用到哪些原始列；口径有 AI 判断的写明判断内容。
export const INSIGHT_METRIC_SOURCES: Record<InsightMetricId, InsightSource> = {
  lift_per_store_day: { kind: "derived", columns: ["实际销售金额", "实体分店店号", "交易日期wid"], how: "实收 ÷ 门店数 ÷ 日数" },
  penetration: { kind: "derived", columns: ["实际销售金额", "优惠小类"], how: "挂优惠的实收 ÷（挂优惠 + 一般開單）实收" },
  give_per_gram: { kind: "derived", columns: ["实际销售金额", "销售金重", "交易日期wid", "优惠小类"], how: "同一天一般開單每克实收 − 活动每克实收，按活动克重加权", judgement: "把「一般開單」当作不带优惠的对照，是 AI 判断，待确认" },
  discount_rate: { kind: "inferred", columns: ["销售牌仔价", "实际销售金额"], how: "（牌仔价 − 实收）÷ 牌仔价", judgement: "把「销售牌仔价」当作吊牌标价，是 AI 判断，待确认" },
  margin_rate: { kind: "inferred", columns: ["零售毛利", "实际销售金额"], how: "零售毛利 ÷ 实收", judgement: "直接用源字段「零售毛利」，实测它不等于实收减成本，口径待确认" },
  grams_per_item: { kind: "derived", columns: ["销售金重", "销售件数"], how: "克重 ÷ 件数" },
  items_per_order: { kind: "derived", columns: ["销售单号", "实体分店店号"], how: "明细行数 ÷ 订单数（门店 + 单号去重）" },
  amount_per_order: { kind: "derived", columns: ["实际销售金额", "销售单号", "实体分店店号"], how: "实收 ÷ 订单数" },
  trade_in_rate: { kind: "derived", columns: ["回收金标识：1：是，0：否", "销售单号"], how: "同一张单里有回收金行的订单 ÷ 订单数", judgement: "把「回收金」行理解成以旧换新，是 AI 判断" },
  aged_share: { kind: "derived", columns: ["sku年龄", "实际销售金额"], how: "sku 年龄 ≥ 365 天的实收 ÷ 实收", judgement: "「老货」以 365 天为界是 AI 定的" },
  key_series_share: { kind: "derived", columns: ["是否重点系列描述", "实际销售金额"], how: "重点系列实收 ÷ 实收" },
  return_rate: { kind: "derived", columns: ["实际销售金额", "回收金标识：1：是，0：否"], how: "非回收的负实收 ÷ 正向实收" },
};

const div = (a: number | null, b: number | null, scale = 1): number | null => a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) || b === 0 ? null : a / b * scale;

export const INSIGHT_FAMILIES: readonly InsightFamily[] = ["卖得多", "让得少", "赚得多", "买得大", "换得多", "去库存", "留得住"];

export const INSIGHT_METRICS: Record<InsightMetricId, InsightMetric> = {
  lift_per_store_day: { label: "每店日均实收", family: "卖得多", unit: "元/店日", status: "real", higherIsBetter: true, definition: "实收 ÷ 有成交门店数 ÷ 有成交日数；门店数按格子去重后相加，是近似值", compute: (s) => div(div(s.amount, s.stores), s.days) },
  penetration: { label: "活动渗透率", family: "卖得多", unit: "%", status: "real", higherIsBetter: true, offerOnly: true, definition: "挂该优惠的实收 ÷（挂优惠 + 一般開單）实收；只算活动和一般開單两类成交", compute: () => null },
  give_per_gram: { label: "每克让利", family: "让得少", unit: "元/克", status: "real", higherIsBetter: false, definition: "同一天里一般開單每克实收减活动每克实收，再按活动克重加权；剔除了金价逐日波动", compute: (s) => div(s.amount, s.grams) },
  discount_rate: { label: "折扣率", family: "让得少", unit: "%", status: "inferred", higherIsBetter: false, definition: "（牌仔价 − 实收）÷ 牌仔价；牌仔价是否就是吊牌标价待确认", compute: (s) => div(s.tagAmount - s.amount, s.tagAmount, 100) },
  margin_rate: { label: "毛利率", family: "赚得多", unit: "%", status: "inferred", higherIsBetter: true, definition: "零售毛利 ÷ 实收；源字段毛利实测不等于实收减成本，口径待确认", compute: (s) => div(s.profit, s.amount, 100) },
  grams_per_item: { label: "单件克重", family: "买得大", unit: "克/件", status: "real", higherIsBetter: true, definition: "克重 ÷ 件数；克减类活动常带克重门槛", compute: (s) => div(s.grams, s.quantity) },
  items_per_order: { label: "单均行数", family: "买得大", unit: "行/单", status: "real", higherIsBetter: true, definition: "当前货类内的明细行数 ÷ 订单数，近似连带率；订单按日按格子去重", compute: (s) => div(s.lines, s.orders) },
  amount_per_order: { label: "单均实收", family: "买得大", unit: "元/单", status: "real", higherIsBetter: true, definition: "当前货类内的实收 ÷ 订单数；不是整张订单的客单价", compute: (s) => div(s.amount, s.orders) },
  trade_in_rate: { label: "以旧换新率", family: "换得多", unit: "%", status: "real", higherIsBetter: true, definition: "同一张单里有回收金（金箱）行的订单占比", compute: (s) => div(s.tradeInOrders, s.orders, 100) },
  aged_share: { label: "老货动销占比", family: "去库存", unit: "%", status: "real", higherIsBetter: true, definition: "sku 年龄 ≥ 365 天的实收占比；sku 年龄缺失的行算作非老货", compute: (s) => div(s.agedAmount, s.amount, 100) },
  key_series_share: { label: "重点系列占比", family: "去库存", unit: "%", status: "real", higherIsBetter: true, definition: "重点系列实收占比", compute: (s) => div(s.keySeriesAmount, s.amount, 100) },
  return_rate: { label: "退货率", family: "留得住", unit: "%", status: "real", higherIsBetter: false, definition: "退货金额 ÷ 正向实收；8 月内的退货不一定对应 8 月的销售", compute: (s) => div(s.returnAmount, s.amount, 100) },
};

// 想看但数据里没有的指标：画成虚线黄框，写明要采集什么。
export const MISSING_METRICS: ReadonlyArray<{ id: string; label: string; family: InsightFamily; need: string }> = [
  { id: "new_customer", label: "新客占比", family: "留得住", need: "会员 ID 与首购日期" },
  { id: "repurchase", label: "复购率", family: "留得住", need: "会员 ID 跨月成交记录" },
  { id: "traffic", label: "进店客流与转化", family: "卖得多", need: "门店客流计数" },
  { id: "roi", label: "活动 ROI", family: "赚得多", need: "活动预算与宣传费用" },
  { id: "coupon", label: "用券核销率", family: "卖得多", need: "礼券发放与核销（现有两列全为空值）" },
];

export function sumCells(cells: readonly InsightCell[]): CellSum {
  const days = new Set<string>();
  const sum: CellSum = { rows: 0, stores: 0, amount: 0, grams: 0, quantity: 0, tagAmount: 0, profit: 0, orders: 0, lines: 0, tradeInOrders: 0, agedAmount: 0, keySeriesAmount: 0, returnAmount: 0, days: 0 };
  let tradeIn = true; let aged = true;
  for (const cell of cells) {
    days.add(cell.day);
    sum.rows += cell.rows; sum.stores += cell.stores; sum.amount += cell.amount; sum.grams += cell.grams; sum.quantity += cell.quantity;
    sum.tagAmount += cell.tagAmount; sum.profit += cell.profit; sum.orders += cell.orders; sum.lines += cell.lines;
    sum.keySeriesAmount += cell.keySeriesAmount; sum.returnAmount += cell.returnAmount;
    if (cell.tradeInOrders === null) tradeIn = false; else sum.tradeInOrders = (sum.tradeInOrders ?? 0) + cell.tradeInOrders;
    if (cell.agedAmount === null) aged = false; else sum.agedAmount = (sum.agedAmount ?? 0) + cell.agedAmount;
  }
  sum.days = days.size;
  // 门店数按格子（天）去重后相加，等于「门店日」；除以日数就是日均门店数。
  if (cells.length) sum.stores = sum.stores / Math.max(1, sum.days);
  if (!tradeIn) sum.tradeInOrders = null;
  if (!aged) sum.agedAmount = null;
  return sum;
}
