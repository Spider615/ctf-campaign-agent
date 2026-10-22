// 洞察和问答之间传递的上下文：在图上选中了什么、怎么写进 URL、怎么写进问答请求。
import { edgeKey, findEdge, findNode, type InsightSelection } from "./paths.ts";
import { INSIGHT_NODE_IDS, INSIGHT_SOURCE_KINDS, INSIGHT_SOURCE_LABEL, type InsightGraph, type InsightNodeId, type InsightSourceKind } from "./types.ts";

// 问答带过去的范围：只记节点或线，不记来源筛选（来源筛选不是一个分析对象）。
// say / todo：页面上的业务结论和 AI 建议，带到问答里，用户追问建议时要先查数据。旧会话里没有这两项。
export type InsightFocus = ({ kind: "node"; id: InsightNodeId; label: string } | { kind: "edge"; from: InsightNodeId; to: InsightNodeId; label: string; basis: string }) & { say?: string; todo?: string | null };

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
  if (!selection || selection.kind === "source") return null;
  const plain = (t: string) => t.replace(/[【】]/g, "");
  if (selection.kind === "node") { const node = findNode(graph, selection.id); return node ? { kind: "node", id: node.id, label: node.label, ...(node.card ? { say: plain(node.card.say), todo: node.card.todo } : {}) } : null; }
  const edge = findEdge(graph, selection.from, selection.to); const from = findNode(graph, selection.from); const to = findNode(graph, selection.to);
  return edge && from && to ? { kind: "edge", from: edge.from, to: edge.to, label: `${from.label} → ${to.label}`, basis: edge.basis, ...(edge.card ? { say: plain(edge.card.say), todo: edge.card.todo } : {}) } : null;
}

export const focusLabel = (focus: InsightFocus) => focus.label;

// 放进问答请求的 context，不改问题原文。
export function focusContext(focus: InsightFocus): string {
  const what = focus.kind === "node" ? `节点「${focus.label}」` : `连线「${focus.label}」（图上依据：${focus.basis}）`;
  const card = [focus.say ? `页面上的结论是「${focus.say}」` : "", focus.todo ? `页面上 AI 给的建议是「${focus.todo}」，这是建议不是数据：用户问到这条建议时，要先查数据给出支撑或反证，再说建议` : ""].filter(Boolean).join("；");
  return `用户正在看智能洞察的指标影响因素图谱（销售额、毛利、销量受哪些因素影响，2025 年 8 月全国），选中了${what}。${card ? `${card}。` : ""}「这个」「这条线」「这个因素」指它。没有明确改变时沿用这个范围。`;
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
