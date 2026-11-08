// 洞察和问答之间传递的上下文：在图上选中了什么、怎么写进 URL、怎么写进问答请求。
import { edgeKey, findEdge, findNode, type InsightSelection } from "./paths.ts";
import { INSIGHT_NODE_IDS, INSIGHT_SOURCE_KINDS, INSIGHT_SOURCE_LABEL, type InsightGraph, type InsightNodeId, type InsightSourceKind } from "./types.ts";

// 问答带过去的范围：只记节点或线，不记来源筛选（来源筛选不是一个分析对象）。
// say / todo：页面上的业务结论和 AI 建议，带到问答里，用户追问建议时要先查数据。旧会话里没有这两项。
export type InsightFocus = ({ kind: "node"; id: InsightNodeId; label: string } | { kind: "edge"; from: InsightNodeId; to: InsightNodeId; label: string; basis: string } | { kind: "graph"; label: string }) & { say?: string; todo?: string | null; period?: string; comparison?: string };

const isNode = (id: string | null): id is InsightNodeId => Boolean(id) && (INSIGHT_NODE_IDS as readonly string[]).includes(id!);

export function parseSelection(search: string): InsightSelection | null {
  const params = new URLSearchParams(search);
  const node = params.get("node"); const edge = params.get("edge"); const source = params.get("source");
  if (isNode(node)) return { kind: "node", id: node };
  if (edge) { const [from, to] = edge.split(">"); if (isNode(from) && isNode(to)) return { kind: "edge", from, to }; }
  if (source && (INSIGHT_SOURCE_KINDS as readonly string[]).includes(source)) return { kind: "source", source: source as InsightSourceKind };
  return null;
}

export function selectionSearch(selection: InsightSelection | null): string {
  if (!selection) return "";
  if (selection.kind === "node") return `node=${selection.id}`;
  if (selection.kind === "edge") return `edge=${encodeURIComponent(edgeKey(selection))}`;
  return `source=${selection.source}`;
}

export function selectionLabel(graph: InsightGraph, selection: InsightSelection | null): string {
  if (!selection) return "整张图";
  if (selection.kind === "source") return `来源：${INSIGHT_SOURCE_LABEL[selection.source].name}`;
  if (selection.kind === "node") return `节点：${findNode(graph, selection.id)?.label ?? selection.id}`;
  return `连线：${findNode(graph, selection.from)?.label ?? selection.from} → ${findNode(graph, selection.to)?.label ?? selection.to}`;
}

export function focusOf(graph: InsightGraph, selection: InsightSelection | null): InsightFocus | null {
  const comparison = graph.comparison ? comparisonContext(graph) : undefined;
  const overview: InsightFocus | null = comparison ? { kind: "graph", label: graph.comparison!.title, period: graph.scope.period, comparison } : null;
  if (!selection || selection.kind === "source") return overview;
  const plain = (t: string) => t.replace(/[【】]/g, "");
  const when = { ...(graph.scope.range ? { period: graph.scope.period } : {}), ...(comparison ? { comparison } : {}) };
  if (selection.kind === "node") { const node = findNode(graph, selection.id); return node ? { kind: "node", id: node.id, label: node.label, ...when, ...(node.card ? { say: plain(node.card.say), todo: node.card.todo } : {}) } : overview; }
  const edge = findEdge(graph, selection.from, selection.to); const from = findNode(graph, selection.from); const to = findNode(graph, selection.to);
  return edge && from && to ? { kind: "edge", from: edge.from, to: edge.to, label: `${from.label} → ${to.label}`, basis: edge.basis, ...when, ...(edge.card ? { say: plain(edge.card.say), todo: edge.card.todo } : {}) } : overview;
}

export const focusLabel = (focus: InsightFocus) => focus.label;

// 页面、问图与跳转智能问答共用同一份对照材料，不传门店日原始面板。
export function comparisonContext(graph: InsightGraph): string {
  const c = graph.comparison; if (!c) return "";
  const number = (v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  const samples = c.sample ? ([ ["sales", "销售额"], ["gp", "毛利"], ["qty", "销量"] ] as const).map(([key, label]) => {
    const m = c.metrics[key]!; const amount = key !== "qty"; const format = (v: number) => `${number(amount ? v / 100 : v)}${amount ? "元" : "件"}`;
    return `${label}：可比样本本期 ${format(m.current)}、对照 ${format(m.baseline)}、差额 ${format(m.delta)}${m.rate === null ? "（基准不大于零，不计算变化率）" : `、变化 ${number(m.rate)}%`}`;
  }).join("；") : c.unavailableReason!;
  return `${c.title}，目标范围 ${graph.scope.period}（${graph.scope.range?.from}–${graph.scope.range?.to}）。${samples}。` +
    `可比样本覆盖 ${c.coverage.stores}/${c.coverage.totalStores} 家店，${c.coverage.storeDays}/${c.coverage.totalStoreDays} 个有记录的目标门店日。` +
    `实际使用的基准日期并集：${c.baselineDates.join("、") || "无"}。${c.method}数据推断的全国克减铺开日：${c.rollout ?? "未发现"}。` +
    `${c.limitations.join("")}这是当前数据版本内的可比观察，不是完整客户历史；不能把本期全范围总额除以样本基准。`;
}

// 放进问答请求的 context，不改问题原文。
export function focusContext(focus: InsightFocus): string {
  const what = focus.kind === "node" ? `节点「${focus.label}」` : focus.kind === "edge" ? `连线「${focus.label}」（图上依据：${focus.basis}）` : `整张比较图「${focus.label}」`;
  const card = [focus.say ? `页面上的结论是「${focus.say}」` : "", focus.todo ? `AI 对它的建议是「${focus.todo}」，这是建议不是数据：用户问到建议或「该怎么做」时，要先查数据给出支撑或反证，再说建议` : ""].filter(Boolean).join("；");
  return `用户正在看深度剖析的${focus.comparison ? "可比平日变化图" : "指标影响因素图谱"}（${focus.comparison ? "销售额、毛利、销量相对可比平日的变化" : "销售额、毛利、销量受哪些因素影响"}，${focus.period ? `${focus.period} 全国` : "2025 年 8 月全国"}），选中了${what}。${card ? `${card}。` : ""}「这个」「这条线」「这个因素」指它。没有明确改变时沿用这个范围。${focus.comparison ?? ""}`;
}

// 问答回答用到的语义层维度 → 图上的节点；门店、日期、货品这类明细维度图上没有。
const LOCATE: Record<string, InsightNodeId> = {
  imageLevel: "image", retailExperience: "shoptype", storeArea: "areaage", storeAge: "areaage", cityTier: "areaage",
  region: "region", area: "region", district: "region", storeType: "nature", storeGroup: "nature",
  festival: "qixi", dayType: "weekday", offer: "promo", offerPeriod: "promo", material: "mix", category: "mix",
};
export function locateAnswer(dimensionIds: readonly string[]): InsightNodeId | null {
  for (const id of dimensionIds) if (LOCATE[id]) return LOCATE[id];
  return null;
}
