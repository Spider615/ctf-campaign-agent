// 图上点了什么、要高亮哪些节点和线、影响到哪些指标。纯函数，界面只按结果上色。
import { WEAK_STRENGTH } from "./score.ts";
import type { InsightDimensionId, InsightGraph, InsightGroupId, InsightMetricId, InsightNode, InsightSourceKind } from "./types.ts";

// edge：组到维度的连线（看依据、异常、推荐）；link：中心到组、组到待采集项的连线；source：按来源类型查看。
export type InsightSelection =
  | { kind: "metric" }
  | { kind: "node"; id: string }
  | { kind: "edge"; dimension: InsightDimensionId }
  | { kind: "link"; group: InsightGroupId; to: "center" | string }
  | { kind: "source"; source: InsightSourceKind };

export type InsightHighlight = { nodes: Set<string>; lines: Set<string>; metrics: Map<string, number | null> };

// 线的标识：中心到组 c:group，组到维度 d:dimension，组到待采集项 m:节点 id。
export const lineKey = { center: (group: string) => `c:${group}`, dimension: (dim: string) => `d:${dim}`, missing: (id: string) => `m:${id}` };
const dimOf = (node: InsightNode) => node.id.startsWith("dim:") ? node.id.slice(4) as InsightDimensionId : null;

export function highlightOf(graph: InsightGraph, selection: InsightSelection | null): InsightHighlight | null {
  if (!selection) return null;
  const nodes = new Set<string>(); const lines = new Set<string>(); const metrics = new Map<string, number | null>();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = new Map(graph.edges.map((e) => [e.dimension, e]));
  // 从维度沿线走到中心：维度、它的组、中心，以及两段线都亮。
  const pathToCenter = (dim: InsightDimensionId) => {
    const node = byId.get(`dim:${dim}`); if (!node?.group) return;
    nodes.add(node.id); nodes.add(`group:${node.group}`); nodes.add("metric");
    lines.add(lineKey.dimension(dim)); lines.add(lineKey.center(node.group));
  };
  const dimensionEffects = (dim: InsightDimensionId) => {
    pathToCenter(dim);
    const strengths = graph.influence[dim] ?? {};
    for (const [metric, value] of Object.entries(strengths)) if ((value ?? 0) >= WEAK_STRENGTH) metrics.set(metric, value ?? null);
  };
  const groupEffects = (group: InsightGroupId) => {
    nodes.add(`group:${group}`); nodes.add("metric"); lines.add(lineKey.center(group));
    for (const node of graph.nodes) {
      if (node.group !== group || node.kind === "group") continue;
      nodes.add(node.id);
      const dim = dimOf(node); lines.add(dim ? lineKey.dimension(dim) : lineKey.missing(node.id));
    }
  };
  const missingEffects = (id: string) => {
    const node = byId.get(id); if (!node) return;
    nodes.add(id);
    if (node.group) { nodes.add(`group:${node.group}`); lines.add(lineKey.missing(id)); }
    for (const dim of node.affects?.dimensions ?? []) pathToCenter(dim);
    // 待采集项对指标的影响是 AI 推测，没有强度数字。
    for (const metric of node.affects?.metrics ?? []) metrics.set(metric, null);
  };

  if (selection.kind === "metric") {
    nodes.add("metric");
    for (const edge of graph.edges) if (!edge.weak) pathToCenter(edge.dimension);
    metrics.set(graph.metric.id, null);
  } else if (selection.kind === "edge") {
    dimensionEffects(selection.dimension);
    if (!edges.get(selection.dimension)?.weak) metrics.set(graph.metric.id, edges.get(selection.dimension)?.strength ?? null);
  } else if (selection.kind === "link") {
    if (selection.to === "center") groupEffects(selection.group); else missingEffects(selection.to);
  } else if (selection.kind === "source") {
    for (const node of graph.nodes) if (node.source.kind === selection.source && node.kind !== "metric") {
      nodes.add(node.id);
      const dim = dimOf(node); if (dim) lines.add(lineKey.dimension(dim)); else if (node.kind === "missing" && node.group) lines.add(lineKey.missing(node.id));
    }
    if (graph.nodes[0]?.source.kind === selection.source) nodes.add("metric");
  } else {
    const node = byId.get(selection.id); if (!node) return null;
    const dim = dimOf(node);
    if (node.kind === "group" && node.group) groupEffects(node.group);
    else if (node.kind === "missing") missingEffects(node.id);
    else if (dim) dimensionEffects(dim);
    else nodes.add(node.id);
  }
  return { nodes, lines, metrics };
}

// 某个维度对各指标的影响，从强到弱，给侧栏列表用。
export function influenceList(graph: InsightGraph, dim: InsightDimensionId): Array<{ metric: InsightMetricId; strength: number | null }> {
  return (Object.entries(graph.influence[dim] ?? {}) as Array<[InsightMetricId, number | null]>)
    .map(([metric, strength]) => ({ metric, strength })).sort((a, b) => (b.strength ?? -1) - (a.strength ?? -1));
}
