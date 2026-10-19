// 洞察和问答、构建之间传递的上下文：选中了什么、怎么写进问答、怎么变成建活动的草稿话。
import { INSIGHT_METRICS } from "./metrics.ts";
import { INSIGHT_DIMENSIONS } from "./ontology.ts";
import { INSIGHT_CATEGORY_CHOICES, INSIGHT_DEFAULT_REQUEST, INSIGHT_DIMENSION_IDS, INSIGHT_METRIC_IDS, INSIGHT_OFFER_CHOICES, type InsightDimensionId, type InsightMetricId, type InsightRequest } from "./types.ts";

export type InsightFocus = InsightRequest & { dimension?: InsightDimensionId; value?: string };

const metricLabel = (id: InsightMetricId) => INSIGHT_METRICS[id].label;
const dimensionLabel = (id: InsightDimensionId) => INSIGHT_DIMENSIONS[id].label;

export function focusLabel(focus: InsightFocus): string {
  const head = focus.dimension ? `${focus.offer} × ${dimensionLabel(focus.dimension)}${focus.value ? `（${focus.value}）` : ""}` : focus.offer;
  return `${head} → ${metricLabel(focus.metric)}`;
}

// 洞察指标换成问答语义层能算的写法：问答没有这些派生指标，但有它们的分子分母。
const QA_METRIC: Record<InsightMetricId, string> = {
  give_per_gram: "每克实收（活动与一般開單同日对比，差值即每克让利）",
  lift_per_store_day: "每店实收与日均实收",
  penetration: "实收（挂该优惠的实收占活动加一般開單实收的比例）",
  discount_rate: "折扣率",
  margin_rate: "毛利率",
  grams_per_item: "克重 ÷ 件数（单件克重）",
  items_per_order: "明细行数 ÷ 订单数（单均行数）",
  amount_per_order: "单均实收",
  trade_in_rate: "订单中带回收金行的比例（以旧换新率）",
  aged_share: "sku 年龄 ≥ 365 天的实收占比",
  key_series_share: "重点系列实收占比",
  return_rate: "退货金额 ÷ 实收",
};
// 「克减类」是洞察里的归并口径，数据里没有这个优惠名；问答要按名称含「克减」的各项优惠理解。
const qaOffer = (offer: string) => offer === "克减类" ? "优惠名称含「克减」的各项优惠（如 H-克减30元、H-克减50元、七夕克减50）" : `优惠「${offer}」`;

// 放进问答请求的 context，不改问题原文。
export function focusContext(focus: InsightFocus): string {
  const where = focus.dimension ? `，按${dimensionLabel(focus.dimension)}看${focus.value ? `，重点是「${focus.value}」` : ""}` : "";
  const relation = focus.dimension ? `「这个关系」「这条线」指${dimensionLabel(focus.dimension)}的不同取值对${metricLabel(focus.metric)}的影响` : `「这个关系」「这张图」指各因素对${metricLabel(focus.metric)}的影响`;
  return `用户正在看洞察图谱：关注 ${QA_METRIC[focus.metric]}，范围是货类 ${focus.category} 里${qaOffer(focus.offer)}的成交，对照为一般開單${where}。${relation}。没有明确改变时沿用这个范围。`;
}

// 建活动的草稿话只写方向，不写日期、门店和力度：这些是人定字段，由用户在对话里补。
export function draftFor(request: InsightRequest, dimension: InsightDimensionId, value: string): string {
  return `8 月数据里${request.category}的${request.offer}活动，在${dimensionLabel(dimension)}为「${value}」时${metricLabel(request.metric)}表现较好，帮我按这个思路创建一个活动：`;
}

// 问答回答用到的语义层维度 → 图上的维度；门店、日期、货品这类明细维度图上没有。
export function locateAnswer(dimensionIds: readonly string[]): InsightDimensionId | null {
  for (const id of dimensionIds) {
    if (id === "offer" || id === "offerPeriod") return "offerDepth";
    if ((INSIGHT_DIMENSION_IDS as readonly string[]).includes(id)) return id as InsightDimensionId;
  }
  return null;
}

export function parseFocus(search: string): InsightFocus | null {
  const params = new URLSearchParams(search);
  const metric = params.get("metric"); const offer = params.get("offer"); const category = params.get("category");
  if (!metric && !offer && !category) return null;
  if (metric && !(INSIGHT_METRIC_IDS as readonly string[]).includes(metric)) return null;
  if (offer && !(INSIGHT_OFFER_CHOICES as readonly string[]).includes(offer)) return null;
  if (category && !(INSIGHT_CATEGORY_CHOICES as readonly string[]).includes(category)) return null;
  const focus: InsightFocus = { metric: (metric ?? INSIGHT_DEFAULT_REQUEST.metric) as InsightMetricId, offer: offer ?? INSIGHT_DEFAULT_REQUEST.offer, category: category ?? INSIGHT_DEFAULT_REQUEST.category };
  const dimension = params.get("dim");
  if (dimension) {
    if (!(INSIGHT_DIMENSION_IDS as readonly string[]).includes(dimension)) return null;
    focus.dimension = dimension as InsightDimensionId;
    const value = params.get("value");
    if (value) focus.value = value.slice(0, 40);
  }
  return focus;
}

export function focusSearch(focus: InsightFocus): string {
  const params = new URLSearchParams({ metric: focus.metric, offer: focus.offer, category: focus.category });
  if (focus.dimension) params.set("dim", focus.dimension);
  if (focus.dimension && focus.value) params.set("value", focus.value);
  return params.toString();
}

export const requestOf = (focus: InsightFocus): InsightRequest => ({ metric: focus.metric, offer: focus.offer, category: focus.category });
