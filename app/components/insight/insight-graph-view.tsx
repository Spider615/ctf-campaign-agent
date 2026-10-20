"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { edgeKey, highlightOf, type InsightSelection } from "../../lib/insight/paths";
import { INSIGHT_SOURCE_LABEL, INSIGHT_SOURCE_KINDS, type InsightEdge, type InsightGraph, type InsightNode, type InsightNodeId, type InsightSourceKind, type InsightStrength } from "../../lib/insight/types";

// 四列从左往右：细项因素 → 因素 → 指标拆解 → 指标。第一列按门店、时间、活动、缺数据分组排。
// 列宽随容器收放：宽了放大节点、拉开间距；窄了先收列间距（到 28），再等比收节点（到 90%），再窄就整体缩放或滚动。
const BOX_W = [214, 180, 156, 186] as const; const BOX_SUM = 736; const GAP_MAX = 62; const GAP_MIN = 28; const BOX_MIN = 0.9;
const naturalWidth = BOX_SUM + GAP_MAX * 3;
type Col = { x: number; w: number };
function columns(width: number): Col[] {
  // 宽屏：节点最多放大到 125%，列间距最多 120，把空白分给两者。
  if (width > naturalWidth) {
    const grow = Math.min(1.3, 1 + (width - naturalWidth) / 2 / BOX_SUM); const gap = Math.floor(Math.min(160, (width - BOX_SUM * grow) / 3));
    let x = 0; return BOX_W.map((w) => { const col = { x, w: Math.floor(w * grow) }; x += col.w + gap; return col; });
  }
  const gap = Math.max(GAP_MIN, Math.min(GAP_MAX, (width - BOX_SUM) / 3));
  const scale = Math.max(BOX_MIN, Math.min(1, (width - gap * 3 - BOX_W[0]) / (BOX_SUM - BOX_W[0])));
  // 第一列放副标题和来源标签，不收。
  let x = 0; return BOX_W.map((w, i) => { const col = { x, w: i === 0 ? w : Math.round(w * scale) }; x += col.w + gap; return col; });
}
const MIN_WIDTH = BOX_W[0] + GAP_MIN * 3 + (BOX_SUM - BOX_W[0]) * BOX_MIN + 4;
const COLUMN_TITLE = ["细项因素", "因素", "指标拆解", "指标"];
// 竖向尺寸随可用高度在紧凑（t = 0）和舒展（t = 1）之间取；再矮就整体缩放（最小 55%），还放不下才在图内滚动。
const MIN_SCALE = 0.55;
type Size = { top: number; leaf: number; gap: number; secLabel: number; secGap: number; node: number; f: number };
const sizeAt = (t: number): Size => ({ top: 26 + 8 * t, leaf: 42 + 8 * t, gap: 5 + 5 * t, secLabel: 16 + 4 * t, secGap: 10 + 10 * t, node: 50 + 8 * t, f: 0.6 + 0.4 * t });
function heightAt(graph: InsightGraph, t: number): number {
  const s = sizeAt(t); const leaves = graph.nodes.filter((n) => n.column === 0); const sections = new Set(leaves.map((n) => n.section)).size;
  return s.top + sections * s.secLabel + Math.max(0, sections - 1) * s.secGap + leaves.length * (s.leaf + s.gap);
}

export const STRENGTH_STYLE: Record<InsightStrength, { stroke: string; width: number; dash?: string; pill: string }> = {
  strong: { stroke: "#2f6bff", width: 2.4, pill: "强" },
  med: { stroke: "#7aa2ff", width: 1.7, pill: "中" },
  weak: { stroke: "#c3cddb", width: 1.2, dash: "4 4", pill: "弱" },
  id: { stroke: "#94a3b8", width: 1.3, pill: "恒等式" },
  missing: { stroke: "#c98a1e", width: 1.3, dash: "1.5 4", pill: "缺" },
};
// 有分数的线按分数加粗：0 分 1.2px，100 分 5px；没分数的按档位默认粗细。
const edgeWidth = (e: InsightEdge) => e.score ? 1.2 + Math.sqrt(e.score.value / 100) * 3.8 : STRENGTH_STYLE[e.strength].width;
// 节点上、线上显示的强度：有分数显示分数，否则显示效应值或档位。
// 分数一律保留一位小数：图上、线上、详情里写的是同一个数，不能一处 13、一处 12.6。
export const scoreText = (x: { score?: { value: number }; strength?: InsightStrength }) => x.score ? x.score.value.toFixed(1) : x.strength ? STRENGTH_STYLE[x.strength].pill : "";
export const SOURCE_TAG: Record<InsightSourceKind, string> = {
  field: "border-[#dde7f3] bg-white text-[#6b7d96]", derived: "border-[#dde7f3] bg-white text-[#6b7d96]",
  grouping: "border-transparent bg-[#efeafb] text-[#6d4fc2]", inferred: "border-transparent bg-[#efeafb] text-[#6d4fc2]",
  suggested: "border-[#b7791f] bg-transparent text-[#b7791f]",
};

type Box = { x: number; y: number; w: number; h: number };

// 第一列按分组自上而下排；其余列放在所连节点的平均高度，再往下推开避免重叠。
function layout(graph: InsightGraph, COL: Col[], size: Size): { boxes: Map<InsightNodeId, Box>; sections: Array<{ label: string; y: number }>; height: number } {
  const boxes = new Map<InsightNodeId, Box>(); const sections: Array<{ label: string; y: number }> = [];
  const { top: TOP, leaf: LEAF_H, gap: GAP, node: NODE_H, f } = size;
  let y = TOP; let section: string | undefined;
  for (const n of graph.nodes.filter((x) => x.column === 0)) {
    if (n.section !== section) { if (section !== undefined) y += size.secGap; sections.push({ label: n.section ?? "", y }); y += size.secLabel; section = n.section; }
    boxes.set(n.id, { x: COL[0].x, y, w: COL[0].w, h: LEAF_H }); y += LEAF_H + GAP;
  }
  const height = y;
  const mid = (id: InsightNodeId) => { const b = boxes.get(id); return b ? b.y + b.h / 2 : 0; };
  const place = (ids: InsightNodeId[], column: 1 | 2 | 3, gap: number, want: (id: InsightNodeId) => number) => {
    const list = ids.filter((id) => graph.nodes.some((n) => n.id === id)).map((id) => ({ id, want: want(id) })).sort((a, b) => a.want - b.want);
    let floor = TOP;
    for (const item of list) { const top = Math.max(item.want, floor); boxes.set(item.id, { x: COL[column].x, y: top, w: COL[column].w, h: NODE_H }); floor = top + NODE_H + gap; }
    const over = floor - gap - height; if (over > 0) for (const item of list) boxes.get(item.id)!.y -= over;
  };
  const avgOf = (id: InsightNodeId) => { const ins = graph.edges.filter((e) => e.to === id && graph.nodes.find((n) => n.id === e.from)?.column === 0).map((e) => mid(e.from)); return ins.length ? ins.reduce((a, b) => a + b, 0) / ins.length - NODE_H / 2 : TOP; };
  // 几个微调偏移跟着紧凑程度一起收。
  place(["store", "day", "promo", "mix"], 1, 28 * f, (id) => id === "mix" ? mid("shift") - NODE_H / 2 + 40 * f : avgOf(id));
  place(["orders", "aov", "gm"], 2, 40 * f, (id) => id === "orders" ? (mid("store") + mid("day") + mid("promo")) / 3 - NODE_H / 2 - 40 * f : id === "aov" ? (mid("store") + mid("promo")) / 2 - NODE_H / 2 + 50 * f : (mid("promo") + mid("mix")) / 2 - NODE_H / 2 + 40 * f);
  place(["qty", "sales", "gp"], 3, 40 * f, (id) => id === "qty" ? boxes.get("orders")!.y - 90 * f : id === "sales" ? (boxes.get("orders")!.y + boxes.get("aov")!.y) / 2 : boxes.get("gm")!.y);
  return { boxes, sections, height };
}

// 三次贝塞尔的四个控制点。跨列：从左框右边出、到右框左边进。同列（活动和力度 → 货品结构）：从右边出、绕一个弧回到右边。
function controls(a: Box, b: Box): [number, number, number, number, number, number, number, number] {
  const y1 = a.y + a.h / 2; const y2 = b.y + b.h / 2;
  if (Math.abs(a.x - b.x) < 1) { const x = a.x + a.w; const bulge = 26 + Math.abs(y2 - y1) * 0.25; return [x, y1, x + bulge, y1, x + bulge, y2, x, y2]; }
  const x1 = a.x + a.w; const x2 = b.x; const c = Math.min(90, (x2 - x1) * 0.5);
  return [x1, y1, x1 + c, y1, x2 - c, y2, x2, y2];
}
function edgePath(a: Box, b: Box): string {
  const [x1, y1, cx1, cy1, cx2, cy2, x2, y2] = controls(a, b);
  return `M${x1},${y1} C${cx1},${cy1} ${cx2},${cy2} ${x2},${y2}`;
}

// 贝塞尔曲线采样：点击时找离指针最近的线（线在扇出处挨得很近，用透明粗线会点错）。
function sample(a: Box, b: Box): Array<[number, number]> {
  const [x1, y1, cx1, cy1, cx2, cy2, x2, y2] = controls(a, b);
  return Array.from({ length: 41 }, (_, i) => { const t = i / 40; const u = 1 - t;
    return [u ** 3 * x1 + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t ** 3 * x2, u ** 3 * y1 + 3 * u * u * t * cy1 + 3 * u * t * t * cy2 + t ** 3 * y2] as [number, number]; });
}

function nodeClass(n: InsightNode, on: boolean, selected: boolean, dim: boolean): string {
  const base = "group absolute flex flex-col justify-center gap-0.5 overflow-hidden rounded-[10px] border pl-3.5 pr-2.5 text-left transition-[opacity,box-shadow,border-color,transform] duration-200 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[#2f6bff]/25";
  const kind = n.kind === "metric" ? "border-transparent bg-[linear-gradient(135deg,#2f6bff,#1d4ed8)] text-white shadow-[0_6px_18px_-6px_rgba(47,107,255,0.55)]"
    : n.kind === "decomp" ? "border-[#d6e2ff] bg-[linear-gradient(180deg,#f5f8ff,#ecf2ff)] shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    : n.kind === "factor" ? "border-[#cfd8e6] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05),0_4px_12px_-6px_rgba(15,23,42,0.12)]"
    : n.strength === "missing" ? "border-dashed border-[#e2b765] bg-[#fffaf0]"
    : "border-[#e4eaf2] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]";
  const state = selected ? "!border-[#2f6bff] ring-[3px] ring-[#2f6bff]/20" : "hover:-translate-y-px hover:border-[#9db8ff] hover:shadow-[0_6px_16px_-8px_rgba(47,107,255,0.45)]";
  return `${base} ${kind} ${state} ${dim && !on ? "opacity-30 saturate-50" : ""}`;
}

export function InsightLegend({ graph, selection, onSelect }: { graph: InsightGraph; selection: InsightSelection | null; onSelect: (s: InsightSelection | null) => void }) {
  const count = (k: InsightSourceKind) => graph.nodes.filter((n) => n.source.kind === k).length;
  const line = (k: InsightStrength, label: string) => <span className="inline-flex items-center gap-1.5"><svg aria-hidden="true" viewBox="0 0 22 8" className="h-2 w-[22px]"><line x1="1" y1="4" x2="21" y2="4" stroke={STRENGTH_STYLE[k].stroke} strokeWidth={STRENGTH_STYLE[k].width + 0.4} strokeDasharray={STRENGTH_STYLE[k].dash} strokeLinecap="round" /></svg>{label}</span>;
  // 两组图例放一行，窄了自动折行；点来源标签只亮这一类。
  return <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-[#eef2f7] pb-2.5 pr-2 text-[12px] text-[#64748b]">
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1" aria-label="线的图例">
      <span className="font-medium text-[#334155]">解释度</span>{line("strong", "≥10 强")}{line("med", "2–10 中")}{line("weak", "<2 弱")}{line("id", "拆解")}{line("missing", "缺数据")}
    </div>
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1" aria-label="按来源筛选">
      <span className="mr-1">来源</span>
      {INSIGHT_SOURCE_KINDS.map((k) => { const on = selection?.kind === "source" && selection.source === k;
        return <button key={k} type="button" aria-pressed={on} title={INSIGHT_SOURCE_LABEL[k].desc} onClick={() => onSelect(on ? null : { kind: "source", source: k })}
          aria-label={`${INSIGHT_SOURCE_LABEL[k].name} ${count(k)} 个`}
          className={`inline-flex min-h-7 items-center gap-1 rounded-full border py-0.5 pl-1 pr-2 text-[#3b4a63] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${on ? "border-[#247cff]" : "border-transparent hover:border-[#247cff]"}`}>
          <span className={`rounded-[5px] border px-1.5 text-[10.5px] font-semibold leading-4 ${SOURCE_TAG[k]}`}>{INSIGHT_SOURCE_LABEL[k].tag}</span>{count(k)}
        </button>; })}
    </div>
    <span className="ml-auto text-[#94a3b8]">线上数字 = 解释度分数（0–100），越粗关系越强</span>
  </div>;
}

// fit：外框高度由页面给定（一屏放下），图按高度收放；否则只按宽度收放，高度随内容。
export function InsightGraphView({ graph, selection, marked, onSelect, fit = false }: { graph: InsightGraph; selection: InsightSelection | null; marked: InsightNodeId[]; onSelect: (s: InsightSelection | null) => void; fit?: boolean }) {
  const frame = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ w: naturalWidth, h: 0 });
  useLayoutEffect(() => {
    const node = frame.current; if (!node) return;
    const observer = new ResizeObserver(([entry]) => setAvailable({ w: Math.floor(entry.contentRect.width), h: Math.floor(entry.contentRect.height) }));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  // 窄屏（手机）不缩放，图在框里滚动；宽屏按框的高度在紧凑和舒展之间取，紧凑还放不下再整体缩放。
  const narrow = available.w < MIN_WIDTH * MIN_SCALE;
  const fitting = fit && available.h > 0 && !narrow;
  const tight = heightAt(graph, 0); const loose = heightAt(graph, 1);
  const t = fitting ? Math.min(1, Math.max(0, (available.h - tight) / (loose - tight))) : 1;
  const widthScale = narrow ? 1 : Math.min(1, available.w / MIN_WIDTH);
  const COL = useMemo(() => columns(narrow ? naturalWidth : available.w / widthScale - 4), [available.w, widthScale, narrow]);
  const WIDTH = COL[3].x + COL[3].w + 4;
  const { boxes, sections, height } = useMemo(() => layout(graph, COL, sizeAt(t)), [graph, COL, t]);
  const scale = narrow ? 1 : Math.max(MIN_SCALE, Math.min(widthScale, fitting ? available.h / height : 1));
  const samples = useMemo(() => graph.edges.map((e) => sample(boxes.get(e.from)!, boxes.get(e.to)!)), [graph, boxes]);
  const [hover, setHover] = useState<InsightSelection | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  // 悬停优先于选中；问答标出的节点在没有悬停、选中时亮。
  const lit = highlightOf(graph, hover ?? selection) ?? (marked.length ? { nodes: new Set(marked), edges: new Set<string>() } : null);
  const nearest = (event: React.MouseEvent): InsightEdge | null => {
    const rect = canvas.current?.getBoundingClientRect(); if (!rect) return null;
    // 图缩放过：指针坐标换回布局坐标。
    const x = (event.clientX - rect.left) / scale; const y = (event.clientY - rect.top) / scale; let best = -1; let distance = 7;
    samples.forEach((points, i) => { for (const [px, py] of points) { const d = Math.hypot(px - x, py - y); if (d < distance) { distance = d; best = i; } } });
    return best >= 0 ? graph.edges[best] : null;
  };
  const onMove = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest("[data-node]")) return;
    const edge = nearest(event);
    if (canvas.current) canvas.current.style.cursor = edge ? "pointer" : "";
    const key = edge ? edgeKey(edge) : null;
    if (key !== (hover?.kind === "edge" ? edgeKey(hover) : null) || hover?.kind === "node") setHover(edge ? { kind: "edge", from: edge.from, to: edge.to } : null);
  };
  const onClick = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest("[data-node]")) return;
    const edge = nearest(event); onSelect(edge ? { kind: "edge", from: edge.from, to: edge.to } : null);
  };
  const selectedKey = selection?.kind === "edge" ? edgeKey(selection) : null; const hoverKey = hover?.kind === "edge" ? edgeKey(hover) : null;

  return <div ref={frame} className={`min-w-0 overflow-auto overscroll-contain ${fit ? "h-[70dvh] min-[1180px]:h-auto min-[1180px]:min-h-0 min-[1180px]:flex-1" : "pb-1"}`}><div style={{ width: WIDTH * scale, height: height * scale }}>
    <div ref={canvas} role="group" aria-label="指标影响因素图谱" className="relative origin-top-left" style={{ width: WIDTH, height, transform: scale < 1 ? `scale(${scale})` : undefined }} onMouseMove={onMove} onMouseLeave={() => setHover(null)} onClick={onClick}>
    {/* 列底：极淡的竖向色带，区分四列，不抢节点。 */}
    {/* 列标题下的细分隔线，区分四列。 */}
    {COL.map((c, i) => <div key={i} aria-hidden="true" className="absolute h-px bg-[linear-gradient(90deg,#e2e8f0,rgba(226,232,240,0))]" style={{ left: c.x, top: 22, width: c.w }} />)}
    <svg aria-hidden="true" className="pointer-events-none absolute left-0 top-0 overflow-visible" width={WIDTH} height={height} viewBox={`0 0 ${WIDTH} ${height}`}>
      <defs>
        <linearGradient id="insight-strong" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stopColor="#7aa2ff" /><stop offset="1" stopColor="#2f6bff" /></linearGradient>
      </defs>
      {graph.edges.map((e) => { const s = STRENGTH_STYLE[e.strength]; const key = edgeKey(e); const on = !lit || lit.edges.has(key); const bold = key === selectedKey || key === hoverKey; const w = edgeWidth(e);
        const d = edgePath(boxes.get(e.from)!, boxes.get(e.to)!);
        return <g key={key} opacity={on ? 1 : 0.08} className="transition-opacity duration-200">
          {bold ? <path d={d} fill="none" stroke={s.stroke} strokeOpacity={0.18} strokeWidth={w + 7} strokeLinecap="round" /> : null}
          <path d={d} fill="none" stroke={e.strength === "strong" ? "url(#insight-strong)" : s.stroke} strokeWidth={bold ? w + 0.8 : w} strokeDasharray={s.dash} strokeLinecap="round" />
          {/* 选中或悬停的线上有流动的光点，表示影响方向。 */}
          {bold && lit?.edges.has(key) ? <path d={d} fill="none" stroke="#fff" strokeOpacity={0.85} strokeWidth={Math.max(1, w * 0.45)} strokeDasharray="2 14" strokeLinecap="round" className="insight-flow" /> : null}
        </g>; })}
    </svg>
    {/* 线上的解释度分数：只标数字（效应值是一句话，放在详情里）。弱线不标；选中时只标链路上的；挨得太近的后一个不标。 */}
    {(() => { const placed: Array<[number, number]> = [];
      return graph.edges.map((e, i) => { const key = edgeKey(e); const onPath = lit?.edges.has(key) ?? false; if (!e.score) return null; if (lit ? !onPath : e.strength === "weak") return null;
        // 放在线的 62% 处：靠近终点那端线已经分开，标签不会压在扇出的起点上。
        const [x, y] = samples[i][25]; if (placed.some(([px, py]) => Math.abs(px - x) < 32 && Math.abs(py - y) < 16)) return null; placed.push([x, y]);
        return <span key={key} aria-hidden="true" className={`pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border px-1.5 text-[10.5px] font-semibold leading-[16px] tabular-nums shadow-sm ${e.strength === "strong" ? "border-[#c9d8ff] bg-white text-[#1d4ed8]" : "border-[#e2e8f0] bg-white text-[#64748b]"}`} style={{ left: x, top: y }}>{scoreText(e)}</span>; }); })()}
    {COLUMN_TITLE.map((title, i) => <div key={title} className="absolute top-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#94a3b8]" style={{ left: COL[i].x }}>{title}</div>)}
    {sections.map((s) => <div key={s.label} className="absolute left-0 flex items-center gap-1.5 text-[11px] font-medium text-[#64748b]" style={{ top: s.y }}><span className="size-1 rounded-full bg-[#94a3b8]" />{s.label}</div>)}
    {graph.nodes.map((n) => { const b = boxes.get(n.id)!; const on = !lit || lit.nodes.has(n.id); const selected = selection?.kind === "node" && selection.id === n.id;
      const tag = SOURCE_TAG[n.source.kind]; const metric = n.kind === "metric";
      return <button key={n.id} type="button" data-node aria-pressed={selected} aria-label={`${n.label}，${n.subtitle}，来源：${INSIGHT_SOURCE_LABEL[n.source.kind].name}`}
        onClick={() => onSelect({ kind: "node", id: n.id })} onMouseEnter={() => setHover({ kind: "node", id: n.id })} onMouseLeave={() => setHover(null)} onFocus={() => setHover({ kind: "node", id: n.id })} onBlur={() => setHover(null)}
        className={nodeClass(n, on, selected, Boolean(lit))} style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
        {n.column === 0 && n.strength ? <span aria-hidden="true" className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full" style={{ background: STRENGTH_STYLE[n.strength].stroke }} /> : null}
        <span className={`flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[13px] font-semibold leading-snug tracking-[-0.01em] ${n.kind === "decomp" ? "text-[#1d4ed8]" : metric ? "" : "text-[#0f172a]"}`}>
          {n.label}
          {/* 细项因素右上角是解释度分数（没有分数的显示档位）。 */}
          {n.column === 0 && n.strength ? <span className={`ml-auto shrink-0 rounded-md px-1.5 text-[11px] font-semibold leading-[18px] tabular-nums ${n.strength === "strong" ? "bg-[#eaf0ff] text-[#1d4ed8]" : n.strength === "missing" ? "bg-[#fdf1d8] text-[#a16207]" : n.strength === "med" ? "bg-[#f1f5fb] text-[#3b5bdb]" : "bg-[#f1f5f9] text-[#94a3b8]"}`} title={n.score ? `解释度 ${n.score.value.toFixed(1)}：${n.score.measure}` : n.effect ? `${n.effect.text}：${n.effect.measure}` : undefined}>{n.score ? scoreText(n) : STRENGTH_STYLE[n.strength].pill}</span> : null}
          {n.column === 0 ? null : <span className={`ml-auto shrink-0 rounded-[5px] border px-1.5 text-[10px] font-medium leading-4 ${metric ? "border-white/25 bg-white/10 text-white" : tag}`}>{INSIGHT_SOURCE_LABEL[n.source.kind].tag}</span>}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`truncate text-[11.5px] leading-snug tabular-nums ${metric ? "text-white/80" : "text-[#64748b]"}`}>{n.subtitle}</span>
          {n.column === 0 ? <span className={`ml-auto shrink-0 rounded-[5px] border px-1.5 text-[10px] font-medium leading-4 ${tag}`}>{INSIGHT_SOURCE_LABEL[n.source.kind].tag}</span> : null}
        </span>
      </button>; })}
  </div></div></div>;
}
