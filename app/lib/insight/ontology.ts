// 业务关系本体：目标指标四周挂哪些维度、怎么分组、哪些是待采集项，以及指标之间的分解和取舍关系。
// 维度的取值表达式只描述来源列；SQL 编译在 agent/insight-graph.ts。
import { SEMANTIC_DIMENSIONS, type SemanticDimensionId } from "../analytics/semantic/model.ts";
import { sourceColumns } from "../analytics/semantic/columns.ts";
import type { InsightDimensionId, InsightGroupId, InsightMetricId, InsightSource, InsightStatus } from "./types.ts";

export type InsightDimensionSpec = {
  label: string; group: InsightGroupId; status: InsightStatus; note?: string;
  // 来源和 AI 判断：图上按来源上色，侧栏写明字段和判断内容。
  origin: InsightSource;
  // semantic：复用语义层维度的来源；weight：单件克重分段；offer：按优惠名在 Node 侧映射成力度。
  source: { kind: "semantic"; id: SemanticDimensionId } | { kind: "weight" } | { kind: "offer" };
};

// 待采集项：数据里没有，AI 认为会影响活动效果。affects 是 AI 推测它会影响哪些维度和指标，点它时高亮。
export type InsightMissingSpec = { label: string; need: string; why: string; affects: { dimensions: InsightDimensionId[]; metrics: InsightMetricId[] } };
export const INSIGHT_GROUPS: Record<InsightGroupId, { label: string; missing: readonly InsightMissingSpec[] }> = {
  product: { label: "品类", missing: [] },
  param: { label: "参数", missing: [
    { label: "门槛与封顶", need: "周大福 Discount 规则表（满多少克可用、最多减多少）", why: "克减50 的单件克重是一般開單的 2 倍，看起来有克重门槛，但数据里没有门槛设置", affects: { dimensions: ["offerDepth", "itemWeight"], metrics: ["grams_per_item", "give_per_gram", "amount_per_order"] } },
    { label: "叠加规则", need: "Discount 规则表的叠加设置", why: "同一张单能否叠加多个优惠，会改变每克让利和单均实收", affects: { dimensions: ["offerDepth"], metrics: ["give_per_gram", "discount_rate", "amount_per_order"] } },
    { label: "允许货类", need: "Allow_Stock_Type 允许参与货类", why: "活动只对部分货类生效时，货类之间的对比会被规则本身决定", affects: { dimensions: ["category", "materialGroup", "priceBand"], metrics: ["penetration", "give_per_gram"] } },
  ] },
  store: { label: "门店", missing: [] },
  time: { label: "节日", missing: [{ label: "其他节日", need: "其他月份的数据（8 月只有七夕）", why: "只有一个节日，看不出节日效果是七夕特有的还是节日共有的", affects: { dimensions: ["festival", "dayType"], metrics: ["lift_per_store_day", "penetration"] } }] },
  people: { label: "人", missing: [
    { label: "会员与客群", need: "会员 ID 与等级（现有会员标识 94% 为会员，区分度低）", why: "活动拉来的是新客还是老客，决定它是增量还是提前消费", affects: { dimensions: ["cityTier", "shopType"], metrics: ["lift_per_store_day", "amount_per_order", "trade_in_rate"] } },
    { label: "店员", need: "把操作人code、入职日期纳入分析口径（字段已有）", why: "店员的推荐和讲解影响连带和大件成交", affects: { dimensions: ["storeType", "salesLevel"], metrics: ["items_per_order", "grams_per_item", "amount_per_order"] } },
  ] },
};

// 语义层维度：字段原样取值是「原始字段」，有映射或分段是「数据计算」；语义层标了待确认（assumption）的含义是「AI 判断」。
const semantic = (id: SemanticDimensionId, group: InsightGroupId, extra: Partial<InsightDimensionSpec> & { judgement?: string } = {}): InsightDimensionSpec => {
  const item = SEMANTIC_DIMENSIONS[id]; const source = item.source!; const columns = sourceColumns(source);
  const judgement = extra.judgement ?? (item.basis === "assumption" ? item.definition : undefined);
  const how = source.kind === "column" ? `直接取「${columns[0]}」的值` : source.kind === "age_band" ? `「${columns[0]}」按 0-1、2-3、4-5、6-10、10 年以上分段` : source.kind === "coalesce" ? `取「${columns[0]}」，空值记为「${source.fallback}」` : source.kind === "day_type" ? "由周日、周末、工作日三个标识推出" : `由「${columns.join("」「")}」组合`;
  const rest = { ...extra }; delete rest.judgement;
  return { label: item.label, group, status: judgement ? "inferred" : "real", source: { kind: "semantic", id }, origin: { kind: judgement ? "inferred" : source.kind === "column" ? "field" : "derived", columns, how, ...(judgement ? { judgement } : {}) }, ...rest };
};

export const INSIGHT_DIMENSIONS: Record<InsightDimensionId, InsightDimensionSpec> = {
  materialGroup: semantic("materialGroup", "product", { label: "金 / 珠宝", note: "按材料组别分：饰品黄金、定价黄金、钻石、宝石等" }),
  category: semantic("category", "product", { label: "计价 / 定价", note: "货类已作为顶部筛选，这里在当前筛选下通常只有一个取值", judgement: "把草图里的「加工 / 非加工」对应成货类：计价类（一般足金）= 加工，定价类 = 非加工。对应关系是 AI 判断，待周大福确认" }),
  priceBand: semantic("priceBand", "product"),
  keySeries: semantic("keySeries", "product"),
  offerDepth: { label: "克减力度", group: "param", status: "inferred", source: { kind: "offer" }, note: "不是规则表里的设置",
    origin: { kind: "inferred", columns: ["优惠小类"], how: "从「优惠小类」的名称里解析数字", judgement: "「H-克减30元」读成每克减 30 元，「92折」读成 92 折，「金色星期二」读成以旧换新。名称是运营手写的，解析结果没有和活动规则核对" } },
  itemWeight: { label: "单件克重段", group: "param", status: "real", source: { kind: "weight" }, note: "每行克重 ÷ 件数分段",
    origin: { kind: "derived", columns: ["销售金重", "销售件数"], how: "每行「销售金重 ÷ 销售件数」，分成 <2、2-5、5-10、10-20、20 克以上" } },
  storeArea: semantic("storeArea", "store", { label: "门店面积" }),
  salesLevel: semantic("salesLevel", "store", { label: "销售级别" }),
  cityTier: semantic("cityTier", "store", { label: "城市级别" }),
  shopType: semantic("shopType", "store", { label: "商圈铺型" }),
  region: semantic("region", "store"),
  storeAge: semantic("storeAge", "store"),
  storeType: semantic("storeType", "store"),
  festival: semantic("festival", "time", { note: "8 月只有七夕一个节日（7 天）" }),
  dayType: semantic("dayType", "time"),
};

export const INSIGHT_GROUP_ORDER: readonly InsightGroupId[] = ["product", "param", "store", "time", "people"];

// 实收 = 订单数 × 单均行数 × 每行克重 × 每克实收；单均行数近似连带率。
export const DECOMPOSITION = [
  { id: "orders", label: "订单数" },
  { id: "lines_per_order", label: "单均行数" },
  { id: "grams_per_line", label: "每行克重" },
  { id: "amount_per_gram", label: "每克实收" },
] as const;

// 指标之间拿什么换什么，推断，供指标节点说明。
export const TRADEOFFS: ReadonlyArray<{ a: InsightMetricId; b: InsightMetricId; note: string }> = [
  { a: "give_per_gram", b: "grams_per_item", note: "让利越多，常见的是门槛越高、单件越重" },
  { a: "give_per_gram", b: "margin_rate", note: "每克让利直接压毛利" },
  { a: "trade_in_rate", b: "items_per_order", note: "以旧换新的单子行数更多（含回收行）" },
];
