"use client";

import { highlightOf, lineKey, type InsightSelection } from "../../lib/insight/highlight";
import { INSIGHT_SOURCE_LABEL, isRealSource, type InsightDimensionId, type InsightEdge, type InsightGraph, type InsightNode, type InsightSourceKind } from "../../lib/insight/types";

export type { InsightSelection };

const W = 960; const H = 760; const CX = W / 2; const CY = H / 2;
// 画布是横的，用椭圆排布：左右两侧比上下宽，叶子之间不容易挤在一起。
const GROUP_R = { x: 185, y: 135 }; const LEAF_R = [{ x: 330, y: 255 }, { x: 395, y: 318 }];
// 五组顺时针排开，品类在正上方；每组的扇区按子节点个数分，子节点多的组拿到更大的角度。
const GROUP_SEQUENCE = ["product", "store", "people", "time", "param"] as const;
const rad = (deg: number) => deg * Math.PI / 180;
const at = (r: { x: number; y: number }, deg: number) => ({ x: CX + r.x * Math.cos(rad(deg)), y: CY + r.y * Math.sin(rad(deg)) });

type Placed = InsightNode & { x: number; y: number };

function layout(graph: InsightGraph): { center: Placed; groups: Placed[]; dims: Placed[]; missing: Placed[] } {
  const center = { ...graph.nodes.find((n) => n.kind === "metric")!, x: CX, y: CY };
  const childrenOf = (group: string) => graph.nodes.filter((n) => n.group === group && (n.kind === "dimension" || n.kind === "missing"))
    // 有数据的维度排前面、靠近组中心，待采集的排在扇区两侧。
    .sort((a, b) => Number(a.kind === "missing") - Number(b.kind === "missing"));
  const counts = GROUP_SEQUENCE.map((g) => Math.max(1, childrenOf(g).length));
  const total = counts.reduce((a, b) => a + b, 0); const step = 360 / total;
  const groups: Placed[] = []; const dims: Placed[] = []; const missing: Placed[] = [];
  // 品类扇区的中心对准正上方。
  let cursor = -90 - counts[0] * step / 2;
  GROUP_SEQUENCE.forEach((group, gi) => {
    const span = counts[gi] * step; const mid = cursor + span / 2;
    groups.push({ ...graph.nodes.find((n) => n.id === `group:${group}`)!, ...at(GROUP_R, mid) });
    childrenOf(group).forEach((child, i) => {
      const a = cursor + step * (i + 0.5);
      (child.kind === "missing" ? missing : dims).push({ ...child, ...at(LEAF_R[i % 2], a) });
    });
    cursor += span;
  });
  return { center, groups, dims, missing };
}

const MAX_CHARS = 8;
const label = (text: string, max = MAX_CHARS) => text.length > max ? `${text.slice(0, max)}…` : text;
// 框宽跟着文字走，短标签不占地方。
// 左侧留出来源标签的位置（22 宽 + 两边各 6）。
const TAG_SPACE = 30;
const fit = (text: string) => Math.min(MAX_CHARS + 1, text.length) * 15 + 18 + TAG_SPACE;

// 来源配色：蓝色系是数据里真实存在的，紫色是 AI 判断，黄色虚线是 AI 补全待采集。
export const SOURCE_STYLE: Record<InsightSourceKind, { fill: string; stroke: string; text: string; tag: string; dash?: string }> = {
  field: { fill: "#ffffff", stroke: "#5b8fd9", text: "#1d3557", tag: "数" },
  derived: { fill: "#eef6ff", stroke: "#5b8fd9", text: "#1d3557", tag: "算" },
  inferred: { fill: "#f5f0ff", stroke: "#8b6fd6", text: "#4b3a86", tag: "AI" },
  suggested: { fill: "#fff8e1", stroke: "#d9a93a", text: "#7a5a10", tag: "补", dash: "5 4" },
  grouping: { fill: "#f1f6fc", stroke: "#a9c2df", text: "#20314d", tag: "" },
};

type Tone = { dim: boolean; lit: boolean; selected: boolean; marked?: boolean };
function Box({ node, tone, onSelect, width, metric = false, weak = false }: { node: Placed; tone: Tone; onSelect: () => void; width: number; metric?: boolean; weak?: boolean }) {
  const h = metric ? 70 : 38;
  const style = metric ? { fill: node.status === "missing" ? "#fff8e1" : "#e8f1ff", stroke: "#247cff", text: "#20314d", tag: "", dash: undefined } : SOURCE_STYLE[node.source.kind];
  const key = (event: React.KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } };
  const tagged = !metric && style.tag;
  return <g role="button" tabIndex={0} aria-pressed={tone.selected} aria-label={`${node.label}，${INSIGHT_SOURCE_LABEL[node.source.kind]}`} onClick={onSelect} onKeyDown={key}
    opacity={tone.dim ? 0.22 : 1} className="cursor-pointer outline-none transition-opacity duration-200 motion-reduce:transition-none [&:focus-visible>rect]:stroke-[#8c2038]">
    {tone.marked ? <g><circle cx={node.x - width / 2} cy={node.y - h / 2} r={9} fill="#20a674" stroke="#fff" strokeWidth={2} /><text x={node.x - width / 2} y={node.y - h / 2 + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff">问</text></g> : null}
    {tone.lit && !tone.selected ? <rect x={node.x - width / 2 - 4} y={node.y - h / 2 - 4} width={width + 8} height={h + 8} rx={metric ? 17 : 12} fill="none" stroke="#f59e0b" strokeWidth={2} opacity={0.75} /> : null}
    <rect x={node.x - width / 2} y={node.y - h / 2} width={width} height={h} rx={metric ? 14 : 9} fill={style.fill} stroke={tone.selected ? "#8c2038" : style.stroke} strokeWidth={tone.selected ? 2.8 : weak ? 1 : 1.4} strokeDasharray={style.dash} />
    <text x={node.x + (tagged ? TAG_SPACE / 2 : 0)} y={node.y + (metric ? -4 : 5)} textAnchor="middle" fontSize={metric ? 20 : 15} fontWeight={metric || node.kind === "group" ? 600 : 400} fill={weak ? "#7f8fa6" : style.text}>{label(node.label, metric ? 12 : MAX_CHARS)}</text>
    {metric ? <text x={node.x} y={node.y + 21} textAnchor="middle" fontSize={13} fill="#5c7392">点开看口径与分解</text> : null}
    {tagged ? <g><rect x={node.x - width / 2 + 6} y={node.y - 9} width={style.tag.length > 1 ? 22 : 18} height={18} rx={4} fill={style.stroke} /><text x={node.x - width / 2 + 6 + (style.tag.length > 1 ? 11 : 9)} y={node.y + 4} textAnchor="middle" fontSize={11} fontWeight={600} fill="#fff">{style.tag}</text></g> : null}
  </g>;
}

function Line({ id, x1, y1, x2, y2, color, width, dash, tone, label: aria, onSelect }: { id: string; x1: number; y1: number; x2: number; y2: number; color: string; width: number; dash?: string; tone: Tone; label: string; onSelect: () => void }) {
  return <g key={id} role="button" tabIndex={0} aria-label={aria} aria-pressed={tone.selected} onClick={onSelect} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
    opacity={tone.dim ? 0.15 : 1} className="cursor-pointer outline-none transition-opacity duration-200 motion-reduce:transition-none [&:focus-visible>line:last-child]:stroke-[#8c2038] [&:hover>line:last-child]:opacity-80">
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={18} />
    {tone.lit ? <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#f59e0b" strokeWidth={width + 6} strokeLinecap="round" opacity={0.35} /> : null}
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={tone.selected ? "#8c2038" : color} strokeWidth={tone.selected ? width + 1.5 : width} strokeDasharray={dash} strokeLinecap="round" />
  </g>;
}

// marked：回答里提到的节点，额外加标记，不改变选中和高亮。
export function InsightGraphView({ graph, selection, onSelect, marked = [] }: { graph: InsightGraph; selection: InsightSelection | null; onSelect: (selection: InsightSelection) => void; marked?: readonly string[] }) {
  const { center, groups, dims, missing } = layout(graph);
  const edges = new Map<InsightDimensionId, InsightEdge>(graph.edges.map((e) => [e.dimension, e]));
  const groupOf = new Map(groups.map((g) => [g.group, g]));
  const lit = highlightOf(graph, selection);
  const selectedNode = selection?.kind === "node" ? selection.id : selection?.kind === "metric" ? "metric" : null;
  const selectedLine = selection?.kind === "edge" ? lineKey.dimension(selection.dimension) : selection?.kind === "link" ? (selection.to === "center" ? lineKey.center(selection.group) : lineKey.missing(selection.to)) : null;
  const markedSet = new Set(marked);
  const nodeTone = (id: string): Tone => ({ selected: selectedNode === id, lit: Boolean(lit?.nodes.has(id)) || markedSet.has(id), dim: Boolean(lit) && !lit!.nodes.has(id) && !markedSet.has(id), marked: markedSet.has(id) });
  const lineTone = (key: string): Tone => ({ selected: selectedLine === key, lit: Boolean(lit?.lines.has(key)), dim: Boolean(lit) && !lit!.lines.has(key) });
  const dimId = (node: Placed) => node.id.slice(4) as InsightDimensionId;
  return <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`以${graph.metric.label}为中心的关系图谱`} className="h-auto w-full select-none">
    {/* 点空白处取消选中 */}
    <rect x={0} y={0} width={W} height={H} fill="transparent" onClick={() => onSelect({ kind: "metric" })} />
    {groups.map((g) => <Line key={lineKey.center(g.group!)} id={lineKey.center(g.group!)} x1={CX} y1={CY} x2={g.x} y2={g.y} color="#b9cbe1" width={2} tone={lineTone(lineKey.center(g.group!))} label={`${g.label}这一组`} onSelect={() => onSelect({ kind: "link", group: g.group!, to: "center" })} />)}
    {/* 组 → 维度：线宽是关系强度，灰线是弱关系 */}
    {dims.map((d) => {
      const dim = dimId(d); const edge = edges.get(dim); const parent = groupOf.get(d.group)!;
      const width = edge ? 1.5 + (edge.strength ?? 0) * 6 : 1.2;
      const color = !edge ? "#d9a93a" : edge.weak ? "#c5d0dc" : d.source.kind === "inferred" ? "#8b6fd6" : "#247cff";
      return <Line key={lineKey.dimension(dim)} id={lineKey.dimension(dim)} x1={parent.x} y1={parent.y} x2={d.x} y2={d.y} color={color} width={width} dash={!edge ? "6 5" : undefined} tone={lineTone(lineKey.dimension(dim))}
        label={edge ? `${d.label}与${graph.metric.label}的关系${edge.weak ? "（弱）" : ""}` : `${d.label}（没有算出）`} onSelect={() => onSelect(edge ? { kind: "edge", dimension: dim } : { kind: "node", id: d.id })} />;
    })}
    {missing.map((m) => { const parent = groupOf.get(m.group)!; return <Line key={lineKey.missing(m.id)} id={lineKey.missing(m.id)} x1={parent.x} y1={parent.y} x2={m.x} y2={m.y} color="#d9a93a" width={1.4} dash="5 5" tone={lineTone(lineKey.missing(m.id))} label={`${m.label}（待采集）`} onSelect={() => onSelect({ kind: "link", group: m.group!, to: m.id })} />; })}
    {groups.map((g) => <Box key={g.id} node={g} width={70} tone={nodeTone(g.id)} onSelect={() => onSelect({ kind: "node", id: g.id })} />)}
    {dims.map((d) => <Box key={d.id} node={d} width={fit(d.label)} weak={edges.get(dimId(d))?.weak} tone={nodeTone(d.id)} onSelect={() => onSelect({ kind: "node", id: d.id })} />)}
    {missing.map((m) => <Box key={m.id} node={m} width={fit(m.label)} tone={nodeTone(m.id)} onSelect={() => onSelect({ kind: "node", id: m.id })} />)}
    <Box node={center} metric width={200} tone={nodeTone("metric")} onSelect={() => onSelect({ kind: "metric" })} />
  </svg>;
}

// 图例兼筛选：点一类来源，只亮这一类节点。
export function InsightLegend({ graph, selection, onSelect }: { graph: InsightGraph; selection: InsightSelection | null; onSelect: (selection: InsightSelection | null) => void }) {
  const counts = new Map<InsightSourceKind, number>();
  for (const n of graph.nodes) if (n.kind !== "metric" && n.kind !== "group" && !n.id.startsWith("missing-metric:")) counts.set(n.source.kind, (counts.get(n.source.kind) ?? 0) + 1);
  const active = selection?.kind === "source" ? selection.source : null;
  const items: Array<{ kind: InsightSourceKind; hint: string }> = [
    { kind: "field", hint: "直接取数据表里的一列" }, { kind: "derived", hint: "几列按固定公式算出" },
    { kind: "inferred", hint: "取值来自数据，含义或归类是 AI 的解读，待确认" }, { kind: "suggested", hint: "数据里没有，AI 认为会影响效果" },
  ];
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-2 pb-1 pt-2 text-[12px] text-[#5c7392]">
    <span className="font-medium text-[#27415f]">来源</span>
    {items.map(({ kind, hint }) => { const style = SOURCE_STYLE[kind]; const on = active === kind; return <button key={kind} type="button" aria-pressed={on} title={hint} onClick={() => onSelect(on ? null : { kind: "source", source: kind })}
      className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-2 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${on ? "border-[#8c2038] bg-white" : "border-transparent hover:border-[#d4e4f5] hover:bg-white"}`}>
      <span className="inline-grid h-[18px] min-w-[18px] place-items-center rounded px-1 text-[11px] font-semibold text-white" style={{ background: style.stroke }}>{style.tag}</span>
      <span className={isRealSource(kind) ? "text-[#1d3557]" : ""}>{INSIGHT_SOURCE_LABEL[kind]}</span><span className="text-[#8397af]">{counts.get(kind) ?? 0}</span>
    </button>; })}
    <span className="ml-auto inline-flex items-center gap-3 text-[11px]">
      <span className="inline-flex items-center gap-1"><span className="inline-block h-1 w-6 rounded bg-[#247cff]" />关系强</span>
      <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-6 rounded bg-[#c5d0dc]" />关系弱</span>
      <span>点任意节点或连线，看它影响到哪些参数</span>
    </span>
  </div>;
}
