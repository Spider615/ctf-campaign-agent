// 智能洞察关系图谱的数据结构。图谱由 Agent 服务离线算好，页面只读不算。
// 设计见 docs/superpowers/specs/2026-10-19-insight-graph-design.md。

export const INSIGHT_DIMENSION_IDS = ["materialGroup", "category", "priceBand", "keySeries", "offerDepth", "itemWeight", "storeArea", "salesLevel", "cityTier", "shopType", "region", "storeAge", "storeType", "festival", "dayType"] as const;
export type InsightDimensionId = typeof INSIGHT_DIMENSION_IDS[number];
export type InsightGroupId = "product" | "param" | "store" | "time" | "people";

export const INSIGHT_METRIC_IDS = ["give_per_gram", "lift_per_store_day", "penetration", "discount_rate", "margin_rate", "grams_per_item", "items_per_order", "amount_per_order", "trade_in_rate", "aged_share", "key_series_share", "return_rate"] as const;
export type InsightMetricId = typeof INSIGHT_METRIC_IDS[number];
export type InsightFamily = "卖得多" | "让得少" | "赚得多" | "买得大" | "换得多" | "去库存" | "留得住";

// real 实线；inferred 实线带「推断」；missing 虚线黄框（待采集）。
export type InsightStatus = "real" | "inferred" | "missing";

// 节点的来源：前两种是数据里真实存在的，后两种是 AI 判断的。图上按这四类上色，侧栏写明字段和判断内容。
// field 原始字段：取值直接来自数据表的某一列。
// derived 代码计算：由几列按固定公式算出来（如克重 ÷ 件数分段），公式写在 how 里。
// inferred AI 判断：取值来自数据，但含义或归类是 AI 的解读，没经过业务确认，判断内容写在 judgement 里。
// suggested AI 补全：数据里没有，AI 认为应该有，需要另外采集。
// grouping 分组：只是把维度归成几类，本身不是数据。
export type InsightSourceKind = "field" | "derived" | "inferred" | "suggested" | "grouping";
export type InsightSource = { kind: InsightSourceKind; columns: string[]; how: string; judgement?: string };
export const INSIGHT_SOURCE_LABEL: Record<InsightSourceKind, string> = { field: "数据原始字段", derived: "数据计算", inferred: "AI 判断", suggested: "AI 补全·待采集", grouping: "分组" };
export const isRealSource = (kind: InsightSourceKind) => kind === "field" || kind === "derived";

// 立方的一个格子：一个维度取值 × 一侧（活动 / 一般開單对照）× 一天，基础字段已在数据库汇总。
export type InsightCell = {
  value: string; side: "offer" | "base"; day: string;
  rows: number; stores: number; amount: number; grams: number; quantity: number; tagAmount: number; profit: number;
  orders: number; lines: number; tradeInOrders: number | null; agedAmount: number | null; keySeriesAmount: number; returnAmount: number;
};
// 多个格子累加后的结果；门店数和订单数在格子内去重，跨格相加是近似，见 limitations。
export type CellSum = Omit<InsightCell, "value" | "side" | "day"> & { days: number };

export type InsightRequest = { metric: InsightMetricId; offer: string; category: string };  // offer 为「克减类」或具体优惠名
export type InsightFact = { label: string; value: string };
export type InsightRow = { value: string; offer: number | null; base: number | null; delta: number | null; rows: number; small: boolean };
export type InsightEdge = {
  dimension: InsightDimensionId; status: InsightStatus; strength: number | null; weak: boolean;
  basis: string[]; anomalies: string[]; recommendation: string | null; draft: string | null; best: string | null; table: InsightRow[];
};
// affects：点这个节点时要高亮的节点和指标。维度的影响由数据算（graph.influence），待采集项的影响是 AI 推测。
export type InsightAffects = { dimensions: InsightDimensionId[]; metrics: string[] };
export type InsightNode = { id: string; kind: "metric" | "group" | "dimension" | "missing"; label: string; group?: InsightGroupId; status: InsightStatus; source: InsightSource; facts: InsightFact[]; note?: string; affects?: InsightAffects };
export type InsightDecomposition = { label: string; offer: number | null; base: number | null; share: number | null };
export type InsightGraph = {
  schema: "insight-graph/v2"; datasetVersion: string; builtAt: string; request: InsightRequest;
  metric: { id: InsightMetricId; label: string; unit: string; definition: string; status: InsightStatus; offer: number | null; base: number | null; delta: number | null };
  nodes: InsightNode[]; edges: InsightEdge[]; decomposition: InsightDecomposition[]; limitations: string[];
  // 每个维度对每个目标指标的关系强度（0–1），同一份数据算出；null 是这个指标在当前数据下算不了。
  influence: Partial<Record<InsightDimensionId, Partial<Record<InsightMetricId, number | null>>>>;
};

export const INSIGHT_SAMPLE_MIN_ROWS = 500;
export const INSIGHT_DEFAULT_REQUEST: InsightRequest = { metric: "give_per_gram", offer: "克减类", category: "一般足金类" };
export const INSIGHT_OFFER_CHOICES = ["克减类", "H-克减30元", "H-克减50元", "七夕克减50", "周末礼献克减30", "H-金色星期二", "H-定价类92折"] as const;
export const INSIGHT_CATEGORY_CHOICES = ["一般足金类", "定价黄金类", "钻石类", "工艺金条/金章"] as const;
