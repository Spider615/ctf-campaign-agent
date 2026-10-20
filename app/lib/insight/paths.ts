// 图上的链路：从一个节点或一条线出发，往上游、下游能走到哪些节点和线，以及走到指标的每条完整路径。
// 页面高亮、侧栏「怎么传到指标」、图谱问答的依据材料共用。
import type { InsightEdge, InsightGraph, InsightNodeId, InsightSourceKind } from "./types.ts";

export type InsightSelection = { kind: "node"; id: InsightNodeId } | { kind: "edge"; from: InsightNodeId; to: InsightNodeId } | { kind: "source"; source: InsightSourceKind };
export const edgeKey = (e: { from: string; to: string }) => `${e.from}>${e.to}`;

export function reach(graph: InsightGraph, id: InsightNodeId, direction: "up" | "down"): Set<InsightNodeId> {
  const seen = new Set<InsightNodeId>([id]); const queue = [id];
  while (queue.length) {
    const current = queue.shift()!;
    for (const e of graph.edges) {
      const [from, to] = direction === "down" ? [e.from, e.to] : [e.to, e.from];
      if (from === current && !seen.has(to)) { seen.add(to); queue.push(to); }
    }
  }
  return seen;
}

// 走到底的每条路径（边的数组）。down：从这个节点走到指标；up：从最左的因素走到这个节点。
export function routes(graph: InsightGraph, id: InsightNodeId, direction: "up" | "down"): InsightEdge[][] {
  const out: InsightEdge[][] = [];
  const walk = (current: InsightNodeId, acc: InsightEdge[]) => {
    const next = graph.edges.filter((e) => (direction === "down" ? e.from : e.to) === current);
    if (!next.length) { if (acc.length) out.push(acc); return; }
    for (const e of next) walk(direction === "down" ? e.to : e.from, direction === "down" ? [...acc, e] : [e, ...acc]);
  };
  walk(id, []);
  return out;
}

// 经过一条线的全部完整路径：上游路径 + 这条线 + 下游路径。
export function routesThrough(graph: InsightGraph, edge: InsightEdge): InsightEdge[][] {
  const heads = routes(graph, edge.from, "up"); const tails = routes(graph, edge.to, "down");
  return (heads.length ? heads : [[]]).flatMap((h) => (tails.length ? tails : [[]]).map((t) => [...h, edge, ...t]));
}

// 选中对象要亮的节点和线。节点：它的上下游；线：线的上游和下游；来源：这一类节点，不亮线。
export function highlightOf(graph: InsightGraph, selection: InsightSelection | null): { nodes: Set<InsightNodeId>; edges: Set<string> } | null {
  if (!selection) return null;
  if (selection.kind === "source") return { nodes: new Set(graph.nodes.filter((n) => n.source.kind === selection.source).map((n) => n.id)), edges: new Set() };
  const [up, down] = selection.kind === "node" ? [reach(graph, selection.id, "up"), reach(graph, selection.id, "down")] : [reach(graph, selection.from, "up"), reach(graph, selection.to, "down")];
  const edges = new Set(graph.edges.filter((e) => (down.has(e.from) && down.has(e.to)) || (up.has(e.from) && up.has(e.to))).map(edgeKey));
  if (selection.kind === "edge") edges.add(edgeKey(selection));
  return { nodes: new Set([...up, ...down]), edges };
}

export const findEdge = (graph: InsightGraph, from: string, to: string) => graph.edges.find((e) => e.from === from && e.to === to);
export const findNode = (graph: InsightGraph, id: string) => graph.nodes.find((n) => n.id === id);
