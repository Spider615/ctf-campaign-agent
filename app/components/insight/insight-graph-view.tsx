"use client";

import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { edgeKey, highlightOf, type InsightSelection } from "../../lib/insight/paths";
import { INSIGHT_SOURCE_LABEL, INSIGHT_SOURCE_KINDS, type InsightEdge, type InsightGraph, type InsightNode, type InsightNodeId, type InsightSourceKind, type InsightStory, type InsightStrength } from "../../lib/insight/types";

// 四列从左往右：细项因素 → 因素 → 指标拆解 → 指标。第一列按门店、时间、活动、缺数据分组排。
// 列宽随容器收放：宽了放大节点、拉开间距；窄了先收列间距（到 28），再等比收节点（到 90%），再窄就整体缩放或滚动。
const BOX_W = [220, 196, 150, 200] as const; const BOX_SUM = 766; const GAP_MAX = 62; const GAP_MIN = 28; const BOX_MIN = 0.9;
const naturalWidth = BOX_SUM + GAP_MAX * 3;
type Col = { x: number; w: number };
function columns(width: number): Col[] {
  // 宽屏：节点最多放大到 125%，列间距最多 120，把空白分给两者。
  if (width > naturalWidth) {
    const grow = Math.min(1.2, 1 + (width - naturalWidth) / 2 / BOX_SUM); const gap = Math.floor(Math.min(220, (width - BOX_SUM * grow) / 3));
    let x = 0; return BOX_W.map((w) => { const col = { x, w: Math.floor(w * grow) }; x += col.w + gap; return col; });
  }
  const gap = Math.max(GAP_MIN, Math.min(GAP_MAX, (width - BOX_SUM) / 3));
  const scale = Math.max(BOX_MIN, Math.min(1, (width - gap * 3 - BOX_W[0]) / (BOX_SUM - BOX_W[0])));
  // 第一列放副标题和来源标签，不收。
  let x = 0; return BOX_W.map((w, i) => { const col = { x, w: i === 0 ? w : Math.round(w * scale) }; x += col.w + gap; return col; });
}
const MIN_WIDTH = BOX_W[0] + GAP_MIN * 3 + (BOX_SUM - BOX_W[0]) * BOX_MIN + 4;
const COLUMN_TITLE = ["细项因素", "因素", "指标拆解", "指标"];
// 竖向尺寸：t = 1 是舒展尺寸，画布可缩放，不再按高度压缩。
type Size = { top: number; leaf: number; gap: number; secLabel: number; secGap: number; node: number; f: number };
const sizeAt = (t: number): Size => ({ top: 30 + 6 * t, leaf: 32 + 4 * t, gap: 2 * t, secLabel: 20 + 2 * t, secGap: 8 + 6 * t, node: 52 + 6 * t, f: 0.6 + 0.4 * t });

export const STRENGTH_STYLE: Record<InsightStrength, { stroke: string; width: number; dash?: string; pill: string }> = {
  strong: { stroke: "#2f6bff", width: 2.4, pill: "强" },
  med: { stroke: "#7aa2ff", width: 1.7, pill: "中" },
  weak: { stroke: "#c3cddb", width: 1.2, dash: "3 4", pill: "弱" },
  id: { stroke: "#94a3b8", width: 1.3, pill: "恒等式" },
  missing: { stroke: "#c98a1e", width: 1.3, dash: "1 4", pill: "缺" },
};
// 有分数的线按分数加粗：0 分 1.2px，100 分 5px；没分数的按档位默认粗细。
const edgeWidth = (e: InsightEdge) => e.score ? 1.2 + Math.sqrt(e.score.value / 100) * 3.8 : STRENGTH_STYLE[e.strength].width;
// 节点上、线上显示的强度：有分数显示分数，否则显示效应值或档位。
// 分数一律保留一位小数：图上、线上、详情里写的是同一个数，不能一处 13、一处 12.6。
export const scoreText = (x: { score?: { value: number }; strength?: InsightStrength }) => x.score ? x.score.value.toFixed(1) : x.strength ? STRENGTH_STYLE[x.strength].pill : "";
export const SOURCE_TAG: Record<InsightSourceKind, string> = {
  field: "border-[#dde7f3] bg-white text-[#64748b]", derived: "border-[#dde7f3] bg-white text-[#64748b]",
  grouping: "border-transparent bg-[#efeafb] text-[#6d4fc2]", inferred: "border-transparent bg-[#efeafb] text-[#6d4fc2]",
  suggested: "border-[#b7791f] bg-transparent text-[#b7791f]",
};

const isAi = (k: InsightSourceKind) => k === "grouping" || k === "inferred";

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
  // 指标是整张图的终点，块更高，上下各让出一点，中线不变。
  for (const id of ["qty", "sales", "gp"] as const) { const b = boxes.get(id); if (b) { b.y -= 12; b.h += 24; } }
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

// 四种节点四种分量：细项因素只有一行字和一根分数细条；因素是发丝边白卡；拆解不画框、直接写数值；指标是最大的数字。
function nodeClass(n: InsightNode, on: boolean, selected: boolean, dim: boolean): string {
  const base = "group insight-in absolute flex flex-col justify-center text-left transition-[opacity,box-shadow,border-color,background-color] duration-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2f6bff]/40";
  const kind = n.kind === "metric" ? "rounded-[4px] border border-[#cfd8e6] bg-white px-4 shadow-[0_1px_0_rgba(255,255,255,0.9)_inset,0_18px_40px_-28px_rgba(15,23,42,0.45)]"
    : n.kind === "decomp" ? "border-l border-[#bcd0ff] pl-3 pr-1"
    : n.kind === "factor" ? "rounded-[4px] border border-[#cfd8e6] bg-[#ffffff] px-3 shadow-[0_10px_24px_-22px_rgba(15,23,42,0.5)]"
    : "rounded-[3px] px-2";
  const state = selected ? (n.kind === "leaf" || n.kind === "decomp" ? "bg-[#eaf0ff]" : "!border-[#2f6bff] shadow-[0_0_0_3px_rgba(47,107,255,0.12)]")
    : n.kind === "leaf" || n.kind === "decomp" ? "hover:bg-[#f1f5fb]" : "hover:border-[#7aa2ff]";
  return `${base} ${kind} ${state} ${dim && !on ? "opacity-[0.38]" : ""}`;
}

// 顶部只放来源筛选（会改变高亮的操作）；线型图例浮在画布左下角。
export function InsightLegend({ graph, selection, onSelect }: { graph: InsightGraph; selection: InsightSelection | null; onSelect: (s: InsightSelection | null) => void }) {
  const count = (k: InsightSourceKind) => graph.nodes.filter((n) => n.source.kind === k).length;
  return <div className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1 pb-2 pr-2 text-[12px] text-[#64748b]" aria-label="按来源筛选">
    <span className="mr-1 text-[11px] tracking-[0.2em] text-[#94a3b8]">来源</span>
    {INSIGHT_SOURCE_KINDS.map((k) => { const on = selection?.kind === "source" && selection.source === k;
      return <button key={k} type="button" aria-pressed={on} title={INSIGHT_SOURCE_LABEL[k].desc} onClick={() => onSelect(on ? null : { kind: "source", source: k })}
        aria-label={`${INSIGHT_SOURCE_LABEL[k].name} ${count(k)} 个`}
        className={`inline-flex min-h-7 items-center gap-1.5 border-b px-1 text-[12px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2f6bff]/40 ${on ? "border-[#2f6bff] text-[#0f172a]" : "border-transparent text-[#64748b] hover:text-[#0f172a]"}`}>
        {isAi(k) ? <span aria-hidden="true" className="size-1.5 rounded-full bg-[#2f6bff]" /> : null}{INSIGHT_SOURCE_LABEL[k].tag}<span className="tabular-nums text-[#94a3b8]">{count(k)}</span>
      </button>; })}
  </div>;
}

// 图例压成一行细字：线越粗越强，虚线是弱或缺数据，圆点是 AI 归类 / 判断。
function LineLegend() {
  const line = (k: InsightStrength, label: string) => <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><svg aria-hidden="true" viewBox="0 0 18 6" className="h-1.5 w-[18px]"><line x1="1" y1="3" x2="17" y2="3" stroke={STRENGTH_STYLE[k].stroke} strokeWidth={STRENGTH_STYLE[k].width} strokeDasharray={STRENGTH_STYLE[k].dash} strokeLinecap="round" /></svg>{label}</span>;
  return <div aria-label="图例" className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] text-[#94a3b8]">
    {line("strong", "强")}{line("med", "中")}{line("weak", "弱")}{line("id", "拆解")}{line("missing", "缺数据")}
    <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-[#2f6bff]" />AI 归类 / 判断</span>
  </div>;
}

// 画布顶上的讲解：第几步、一句标题、一句结论，左右翻页。选中节点或线时让位给右栏详情。
function StoryCaption({ stories, index, onStory }: { stories: InsightStory[]; index: number; onStory: (i: number) => void }) {
  const story = stories[index]; if (!story) return null;
  const go = (d: number) => onStory((index + d + stories.length) % stories.length);
  const btn = "grid size-7 place-items-center rounded-full text-[#64748b] transition hover:bg-[#eaf0ff] hover:text-[#0f172a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2f6bff]/40";
  return <div data-overlay className="absolute inset-x-6 top-5 flex items-start gap-5" aria-live="polite">
    <span className={`pt-1 text-[12px] tracking-[0.2em] text-[#2f6bff]`}>{String(index + 1).padStart(2, "0")}<span className="text-[#cbd5e1]"> / {String(stories.length).padStart(2, "0")}</span></span>
    <div key={index} className="insight-in min-w-0 flex-1">
      <p className={`text-[22px] leading-tight tracking-[0.04em] text-[#0f172a]`}>{story.title}</p>
      <p className="mt-1.5 max-w-[620px] text-[12.5px] leading-[1.75] text-[#475569]">{story.text}</p>
    </div>
    <div className="flex shrink-0 items-center gap-0.5">
      <button type="button" aria-label="上一条" onClick={() => go(-1)} className={btn}><ChevronLeft aria-hidden="true" className="size-4" /></button>
      <button type="button" aria-label="下一条" onClick={() => go(1)} className={btn}><ChevronRight aria-hidden="true" className="size-4" /></button>
    </div>
  </div>;
}
// 画布：初始排版按四列算，之后可以拖空白平移、滚轮缩放、拖节点挪位置；「适应窗口」把整张图放进视野，「重排」回到初始位置。
// 节点挪动记成相对初始位置的偏移，窗口变化重新排版时偏移还在。
type View = { x: number; y: number; k: number };
const PAD = 28; const K_MIN = 0.35; const K_MAX = 2.2;
export function InsightGraphView({ graph, selection, marked, onSelect, story, onStory }: { graph: InsightGraph; selection: InsightSelection | null; marked: InsightNodeId[]; onSelect: (s: InsightSelection | null) => void; story: number; onStory: (i: number) => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const node = stage.current; if (!node) return;
    const observer = new ResizeObserver(([entry]) => setSize({ w: Math.floor(entry.contentRect.width), h: Math.floor(entry.contentRect.height) }));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  // 列宽按画布宽度定（至少按最窄排版），竖向用舒展尺寸；放不下交给缩放。
  // 高度只取决于左列行数：先按高度算出会缩到多少，再按缩放后能铺开的宽度排列，免得右边空一大块。
  const fitK = useMemo(() => { const h = layout(graph, columns(MIN_WIDTH), sizeAt(1)).height; return size.h ? Math.min(1, (size.h - 104 - 44) / h) : 1; }, [graph, size.h]);
  const COL = useMemo(() => columns(Math.max(MIN_WIDTH, (size.w - PAD * 2) / Math.max(K_MIN, fitK))), [size.w, fitK]);
  const WIDTH = COL[3].x + COL[3].w + 40;
  const base = useMemo(() => layout(graph, COL, sizeAt(1)), [graph, COL]);
  const [offset, setOffset] = useState<Record<string, { dx: number; dy: number }>>({});
  const boxes = useMemo(() => { const m = new Map<InsightNodeId, Box>(); for (const [id, b] of base.boxes) { const o = offset[id]; m.set(id, o ? { ...b, x: b.x + o.dx, y: b.y + o.dy } : b); } return m; }, [base, offset]);
  const height = base.height;
  const samples = useMemo(() => graph.edges.map((e) => sample(boxes.get(e.from)!, boxes.get(e.to)!)), [graph, boxes]);

  // 视图：用户没动过（平移、缩放）就是「适应窗口」算出来的，随窗口和节点变；动过就存下来保持不变。
  const fitted = useMemo((): View => {
    if (!size.w || !size.h) return { x: PAD, y: PAD, k: 1 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of boxes.values()) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w + 40); y1 = Math.max(y1, b.y + b.h); }
    y0 = Math.min(y0, 0);
    const bw = x1 - x0, bh = y1 - y0;
    // 顶上留出讲解的位置，底下留出图例和按钮。
    const top = 104, bottom = 44;
    const k = Math.max(K_MIN, Math.min(1.15, (size.w - PAD * 2) / bw, (size.h - top - bottom) / bh));
    return { k, x: (size.w - bw * k) / 2 - x0 * k, y: top + (size.h - top - bottom - bh * k) / 2 - y0 * k };
  }, [boxes, size.w, size.h]);
  const [userView, setUserView] = useState<View | null>(null);
  const view = userView ?? fitted;
  const setView = useCallback((f: (v: View) => View) => setUserView((u) => f(u ?? fitted)), [fitted]);
  const fitView = () => setUserView(null);
  const relayout = () => { setOffset({}); setUserView(null); };
  const zoomAt = useCallback((f: number, mx: number, my: number) => {
    setView((v) => { const k = Math.max(K_MIN, Math.min(K_MAX, v.k * f)); return { k, x: mx - (mx - v.x) * k / v.k, y: my - (my - v.y) * k / v.k }; });
  }, [setView]);
  // 滚轮缩放要拦住页面滚动，React 的 onWheel 是被动监听，这里自己挂。
  useEffect(() => {
    const node = stage.current; if (!node) return;
    // 滚轮缩放；按住 Shift 滚轮上下平移（图高过画布时往下看）。
    const wheel = (e: WheelEvent) => { e.preventDefault(); const r = node.getBoundingClientRect();
      if (e.shiftKey) { setView((v) => ({ ...v, y: v.y - (e.deltaY || e.deltaX) })); return; }
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top); };
    node.addEventListener("wheel", wheel, { passive: false }); return () => node.removeEventListener("wheel", wheel);
  }, [zoomAt, setView]);

  // 选中的节点在视野外时（被拖走、缩放过、或从右栏链路里跳过来）把它挪回中间；看得见就不动。
  // 在渲染期比较「上次处理过的选中」，不在 effect 里改状态。
  const focusId = selection?.kind === "node" ? selection.id : selection?.kind === "edge" ? selection.to : null;
  const [seenFocus, setSeenFocus] = useState<string | null>(null);
  if (focusId !== seenFocus) {
    setSeenFocus(focusId);
    const b = focusId ? boxes.get(focusId) : undefined;
    if (b && size.w) {
      const sx = view.x + b.x * view.k, sy = view.y + b.y * view.k, sw = b.w * view.k, sh = b.h * view.k;
      if (sx < 8 || sy < 8 || sx + sw > size.w - 8 || sy + sh > size.h - 52) setUserView({ ...view, x: size.w / 2 - (b.x + b.w / 2) * view.k, y: size.h / 2 - (b.y + b.h / 2) * view.k });
    }
  }

  const [hover, setHover] = useState<InsightSelection | null>(null);
  // 悬停优先于选中；问答标出的节点在没有悬停、选中时亮。
  // 没选中、没悬停、问答也没标时，点亮当前讲解那一步的链路。
  const told = !selection && !marked.length ? graph.stories[story] : undefined;
  const storyLit = told ? (() => { const ids = new Set(told.path); return { nodes: ids, edges: new Set(graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map(edgeKey)) }; })() : null;
  const lit = highlightOf(graph, hover ?? selection) ?? (marked.length ? { nodes: new Set(marked), edges: new Set<string>() } : storyLit);
  const toCanvas = (e: { clientX: number; clientY: number }) => { const r = stage.current!.getBoundingClientRect(); return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k }; };
  const nearest = (e: { clientX: number; clientY: number }): InsightEdge | null => {
    const { x, y } = toCanvas(e); const reach = 7 / Math.min(1, view.k); let best = -1; let distance = reach;
    samples.forEach((points, i) => { for (const [px, py] of points) { const d = Math.hypot(px - x, py - y); if (d < distance) { distance = d; best = i; } } });
    return best >= 0 ? graph.edges[best] : null;
  };

  // 拖动：空白处平移画布；节点上拖动挪节点。挪动超过 3px 才算拖，没挪就当点击。
  const drag = useRef<{ kind: "pan" | "node"; id?: InsightNodeId; sx: number; sy: number; vx: number; vy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [panning, setPanning] = useState(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("[data-overlay]")) return;
    const nodeEl = (e.target as HTMLElement).closest<HTMLElement>("[data-node]");
    const id = nodeEl?.dataset.node as InsightNodeId | undefined;
    const o = id ? offset[id] ?? { dx: 0, dy: 0 } : { dx: 0, dy: 0 };
    drag.current = { kind: id ? "node" : "pan", id, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, ox: o.dx, oy: o.dy, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d) {
      const mx = e.clientX - d.sx, my = e.clientY - d.sy;
      // 真开始拖了才捕获指针：一按下就捕获，点击事件会落到画布上，节点按钮收不到 click。
      if (!d.moved && Math.abs(mx) + Math.abs(my) > 3) { d.moved = true; setPanning(d.kind === "pan"); setHover(null); stage.current?.setPointerCapture(e.pointerId); }
      if (!d.moved) return;
      if (d.kind === "pan") setView((v) => ({ ...v, x: d.vx + mx, y: d.vy + my }));
      else setOffset((prev) => ({ ...prev, [d.id!]: { dx: d.ox + mx / view.k, dy: d.oy + my / view.k } }));
      return;
    }
    if ((e.target as HTMLElement).closest("[data-node], [data-overlay]")) return;
    const edge = nearest(e);
    if (stage.current) stage.current.style.cursor = edge ? "pointer" : "";
    const key = edge ? edgeKey(edge) : null;
    if (key !== (hover?.kind === "edge" ? edgeKey(hover) : null) || hover?.kind === "node") setHover(edge ? { kind: "edge", from: edge.from, to: edge.to } : null);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current; drag.current = null; setPanning(false);
    if (!d) return;
    if (d.moved) { suppressClick.current = true; stage.current?.releasePointerCapture?.(e.pointerId); return; }
    if (d.kind === "pan") { const edge = nearest(e); onSelect(edge ? { kind: "edge", from: edge.from, to: edge.to } : null); }
  };
  const selectedKey = selection?.kind === "edge" ? edgeKey(selection) : null; const hoverKey = hover?.kind === "edge" ? edgeKey(hover) : null;
  const tool = "grid size-8 place-items-center rounded-full text-[#64748b] transition hover:bg-[#eaf0ff] hover:text-[#0f172a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2f6bff]/40";
  const center = () => ({ x: size.w / 2, y: size.h / 2 });

  return <div ref={stage} role="group" aria-label="指标影响因素图谱" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { drag.current = null; setPanning(false); }} onPointerLeave={() => { if (!drag.current) setHover(null); }}
    className={`relative isolate h-[70dvh] min-w-0 touch-none select-none overflow-hidden rounded-[4px] bg-[#f8fafc] min-[1180px]:h-auto min-[1180px]:min-h-0 min-[1180px]:flex-1 ${panning ? "cursor-grabbing" : ""}`}>
    {/* 浅灰底。 */}
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(80%_70%_at_10%_0%,#fffefb_0%,transparent_65%),linear-gradient(180deg,#f8fafc,#f4f7fb)]" />
    <div className="absolute left-0 top-0 origin-top-left" style={{ width: WIDTH, height, transform: `translate(${view.x}px,${view.y}px) scale(${view.k})` }}>
      {/* 列标题下的细分隔线，区分四列。 */}
      {/* 线：第一次打开时从左往右展开。点亮的线走一道慢慢移动的浅光，表示影响方向。 */}
      <svg aria-hidden="true" className="insight-reveal pointer-events-none absolute left-0 top-0 overflow-visible" width={WIDTH} height={height} viewBox={`0 0 ${WIDTH} ${height}`}>
        {graph.edges.map((e) => { const s = STRENGTH_STYLE[e.strength]; const key = edgeKey(e); const on = !lit || lit.edges.has(key); const bold = key === selectedKey || key === hoverKey; const w = edgeWidth(e) * 0.75;
          const d = edgePath(boxes.get(e.from)!, boxes.get(e.to)!);
          const path = Boolean(lit?.edges.has(key));
          return <g key={key} opacity={on ? 1 : 0.18} className="transition-opacity duration-500">
            <path d={d} fill="none" stroke={path ? "#1d4ed8" : s.stroke} strokeWidth={bold ? w + 0.8 : path ? w + 0.3 : w} strokeDasharray={s.dash} strokeLinecap="round" className="transition-[stroke] duration-500" />
            {path ? <path d={d} fill="none" stroke="#ffffff" strokeOpacity={0.9} strokeWidth={Math.max(0.7, w * 0.35)} strokeDasharray="1 22" strokeLinecap="round" className="insight-flow" /> : null}
          </g>; })}
      </svg>
      {/* 线上的分数只在点亮的链路上标，平时靠线的粗细说强弱。 */}
      {lit ? (() => { const placed: Array<[number, number]> = [];
        return graph.edges.map((e, i) => { const key = edgeKey(e); if (!e.score || !lit.edges.has(key)) return null;
          const [x, y] = samples[i][25]; if (placed.some(([px, py]) => Math.abs(px - x) < 32 && Math.abs(py - y) < 16)) return null; placed.push([x, y]);
          return <span key={key} aria-hidden="true" className={`insight-in pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#f8fafc] px-1.5 text-[13px] leading-[18px] tabular-nums text-[#1d4ed8] `} style={{ left: x, top: y }}>{scoreText(e)}</span>; }); })() : null}
      {COLUMN_TITLE.map((title, i) => <div key={title} className={`absolute top-0 text-[13px] tracking-[0.36em] text-[#94a3b8] `} style={{ left: COL[i].x + (i === 0 ? 8 : i === 2 ? 12 : 0) }}>{title}</div>)}
      {base.sections.map((s) => <div key={s.label} className={`absolute text-[13px] tracking-[0.2em] text-[#94a3b8] `} style={{ left: COL[0].x + 8, top: s.y }}>{s.label}</div>)}
      {graph.nodes.map((n) => { const b = boxes.get(n.id)!; const on = !lit || lit.nodes.has(n.id); const selected = selection?.kind === "node" && selection.id === n.id;
        const aiDot = isAi(n.source.kind) ? <span aria-hidden="true" title={INSIGHT_SOURCE_LABEL[n.source.kind].name} className="size-1.5 shrink-0 rounded-full bg-[#2f6bff]" /> : null;
        const score = n.score ? scoreText(n) : n.strength ? STRENGTH_STYLE[n.strength].pill : "";
        const tip = [n.subtitle, `来源：${INSIGHT_SOURCE_LABEL[n.source.kind].name}`].join(" · ");
        return <button key={n.id} type="button" data-node={n.id} aria-pressed={selected} aria-label={`${n.label}，${n.subtitle}，来源：${INSIGHT_SOURCE_LABEL[n.source.kind].name}`} title={tip}
          onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onSelect({ kind: "node", id: n.id }); }}
          onPointerDown={() => { suppressClick.current = false; }}
          onMouseEnter={() => { if (!drag.current) setHover({ kind: "node", id: n.id }); }} onMouseLeave={() => setHover(null)} onFocus={() => setHover({ kind: "node", id: n.id })} onBlur={() => setHover(null)}
          className={`${nodeClass(n, on, selected, Boolean(lit))} cursor-grab active:cursor-grabbing`} style={{ left: b.x, top: b.y, width: b.w, height: b.h, animationDelay: `${n.column * 140 + 80}ms` }}>
          {n.kind === "metric" ? <>
            <span className="flex items-center gap-2 text-[13px] tracking-[0.3em] text-[#64748b]">{n.label}<span className="h-px flex-1 bg-[#e2e8f0]" /></span>
            <span className={`mt-1.5 text-[32px] leading-none tabular-nums tracking-[0.01em] text-[#0f172a]`}>{n.value ?? n.subtitle}</span>
          </> : n.kind === "decomp" ? <>
            <span className="text-[13px] tracking-[0.2em] text-[#64748b]">{n.label}</span>
            <span className={`mt-1.5 text-[23px] leading-none tabular-nums text-[#1d4ed8]`}>{n.value ?? n.subtitle}</span>
          </> : n.kind === "factor" ? <span className="flex min-w-0 items-center gap-2">
            <span className={`truncate text-[17px] tracking-[0.06em] text-[#0f172a]`}>{n.label}</span>{aiDot}
            <span className={`ml-auto shrink-0 text-[15px] tabular-nums text-[#1d4ed8]`}>{score}</span>
          </span> : <>
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={`truncate text-[15px] ${n.strength === "missing" ? "text-[#94a3b8]" : "text-[#0f172a]"}`}>{n.label}</span>{aiDot}
              <span className={`ml-auto shrink-0 text-[14px] tabular-nums ${n.strength === "strong" ? "text-[#1d4ed8]" : n.strength === "missing" ? "text-[#b7791f]" : "text-[#94a3b8]"}`}>{n.strength === "missing" ? "待采集" : score}</span>
            </span>
            {/* 分数细条：满条 = 50 分；缺数据画虚线。 */}
            <span aria-hidden="true" className={`mt-1 block h-[2px] w-full ${n.strength === "missing" ? "bg-[repeating-linear-gradient(90deg,#d9c39a_0_2px,transparent_2px_6px)]" : "bg-[#eef2f7]"}`}>
              {n.score ? <span className="block h-full transition-[width] duration-700" style={{ width: `${Math.min(100, n.score.value * 2)}%`, background: STRENGTH_STYLE[n.strength ?? "weak"].stroke }} /> : null}
            </span>
          </>}
        </button>; })}
    </div>

    {/* 浮层：右上角是讲解（选中时让位），左下角一行图例，右下角一组小按钮。 */}
    {told ? <StoryCaption stories={graph.stories} index={story} onStory={onStory} /> : null}
    <div data-overlay className="absolute bottom-3.5 left-5 hidden max-w-[calc(100%-260px)] sm:block"><LineLegend /></div>
    <div data-overlay aria-label="画布操作" className="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-full border border-[#e4eaf2] bg-[#ffffff]/90 px-1 py-0.5 opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100">
      <button type="button" aria-label="缩小" title="缩小" onClick={() => zoomAt(1 / 1.2, center().x, center().y)} className={tool}><Minus aria-hidden="true" className="size-3.5" /></button>
      <span className={`w-10 text-center text-[11px] tabular-nums text-[#64748b]`}>{Math.round(view.k * 100)}%</span>
      <button type="button" aria-label="放大" title="放大" onClick={() => zoomAt(1.2, center().x, center().y)} className={tool}><Plus aria-hidden="true" className="size-3.5" /></button>
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[#e4eaf2]" />
      <button type="button" aria-label="适应窗口" title="适应窗口" onClick={fitView} className={tool}><Maximize2 aria-hidden="true" className="size-3.5" /></button>
      <button type="button" aria-label="重排" title="重排（节点回到原位）" onClick={relayout} className={tool}><RotateCcw aria-hidden="true" className="size-3.5" /></button>
    </div>
  </div>;
}
