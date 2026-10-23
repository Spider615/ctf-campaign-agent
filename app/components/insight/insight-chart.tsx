"use client";

import { useId, useState } from "react";
import type { InsightChart, InsightChartLegend, InsightChartTone } from "../../lib/insight/types";

// 依据里的小图：数字都由 drivers.ts 算好，这里只画。宽度跟着侧栏走，SVG 用 viewBox 等比缩放。
const TONE: Record<InsightChartTone, string> = { main: "#2f6bff", accent: "#f59e0b", soft: "#9db8ff", muted: "#cbd5e1" };
const fmt = (v: number, digits: number) => v.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });

function Legend({ items }: { items: InsightChartLegend }) {
  return <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#64748b]">{items.map((x) => <li key={x.label} className="flex items-center gap-1"><span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: TONE[x.tone] }} />{x.label}</li>)}</ul>;
}

// 横条：可以有负值，零点放在中间合适的位置。
function Bars({ chart }: { chart: Extract<InsightChart, { kind: "bars" }> }) {
  const lo = Math.min(0, ...chart.bars.map((b) => b.value)); const hi = Math.max(0, ...chart.bars.map((b) => b.value)); const span = hi - lo || 1;
  const zero = (0 - lo) / span * 100;
  return <ul className="space-y-1.5">{chart.bars.map((b) => {
    const left = b.value >= 0 ? zero : zero - (-b.value / span * 100); const width = Math.max(1.5, Math.abs(b.value) / span * 100);
    return <li key={b.label} className="grid grid-cols-[minmax(72px,34%)_1fr_auto] items-center gap-2 text-[12px]">
      <span className="truncate text-[#475569]" title={b.label}>{b.label}</span>
      <span className="relative h-2.5 rounded-full bg-[#eef2f7]">
        {lo < 0 ? <span aria-hidden="true" className="absolute -inset-y-0.5 w-px bg-[#94a3b8]" style={{ left: `${zero}%` }} /> : null}
        <span className="absolute inset-y-0 rounded-full" style={{ left: `${left}%`, width: `${width}%`, background: TONE[b.tone ?? "soft"] }} />
      </span>
      <span className="text-right font-semibold tabular-nums text-[#0f172a]">{b.text}</span>
    </li>; })}</ul>;
}

// 一根条拆成几段：差异各来自哪里。
function Split({ chart }: { chart: Extract<InsightChart, { kind: "split" }> }) {
  const parts = chart.parts.filter((p) => p.value > 0); const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return <div>
    <div className="flex h-6 overflow-hidden rounded-md">{parts.map((p) => <span key={p.label} className="grid place-items-center text-[11px] font-semibold tabular-nums text-white" style={{ width: `${p.value / total * 100}%`, background: TONE[p.tone], color: p.tone === "muted" || p.tone === "soft" ? "#1e293b" : "#fff" }} title={`${p.label} ${fmt(p.value, 1)}%`}>{p.value / total >= 0.12 ? `${fmt(p.value, 1)}%` : ""}</span>)}</div>
    <ul className="mt-2 space-y-0.5 text-[12px]">{parts.map((p) => <li key={p.label} className="flex items-center gap-1.5 text-[#475569]"><span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: TONE[p.tone] }} />{p.label}<span className="ml-auto font-semibold tabular-nums text-[#0f172a]">{fmt(p.value, 1)}%</span></li>)}</ul>
  </div>;
}

// 柱：按日或按克。可堆叠；band 用浅底标一段区间，mark 写在柱顶。悬停一根柱显示各段数值。
function Columns({ chart }: { chart: Extract<InsightChart, { kind: "columns" }> }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 300; const H = 150; const top = 26; const bottom = 18; const ph = H - top - bottom;
  const n = chart.points.length; const slot = W / n; const bw = Math.max(2, Math.min(36, slot * (n > 12 ? 0.72 : 0.5)));
  const totals = chart.points.map((p) => chart.stacked ? p.values.reduce((a, v) => a + v, 0) : Math.max(...p.values));
  const max = Math.max(...totals) || 1;
  const idx = (label: string) => chart.points.findIndex((p) => p.label === label);
  const band = chart.band ? { a: idx(chart.band.from), b: idx(chart.band.to) } : null;
  // 横轴标签：点多时只标首尾、区间起点和带 mark 的柱。
  // 挨得太近（不到 4 根柱）的后一个不标，免得字叠在一起。
  const wanted = chart.points.map((p, i) => n <= 12 || i === 0 || i === n - 1 || i === band?.a || p.mark !== undefined);
  // 带 mark 的柱优先：它和前一个标签挨得近时，换掉前一个。
  const shown: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!wanted[i]) continue;
    const near = n > 12 && shown.length > 0 && i - shown.at(-1)! < 4;
    if (!near) shown.push(i); else if (chart.points[i].mark !== undefined) shown[shown.length - 1] = i;
  }
  const showLabel = (i: number) => shown.includes(i);
  const cur = hover !== null ? chart.points[hover] : null;
  return <div>
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={chart.title} onMouseLeave={() => setHover(null)}>
      {band && band.a >= 0 && band.b >= 0 ? <g>
        <rect x={band.a * slot} y={top - 4} width={(band.b - band.a + 1) * slot} height={ph + 4} fill="#eef3ff" />
        <line x1={band.a * slot} x2={(band.b + 1) * slot} y1="14" y2="14" stroke="#7aa2ff" />
        <text x={(band.a + band.b + 1) / 2 * slot} y="10" fontSize="9" textAnchor="middle" fill="#3b5bdb">{chart.band!.label}</text>
      </g> : null}
      <line x1="0" x2={W} y1={top + ph} y2={top + ph} stroke="#e2e8f0" />
      <line x1="0" x2={W} y1={top} y2={top} stroke="#eef2f7" strokeDasharray="2 3" />
      <text x="1" y={top - 2} fontSize="8.5" fill="#94a3b8">{fmt(max, chart.digits)} {chart.unit}</text>
      {chart.points.map((p, i) => {
        const x = i * slot + (slot - bw) / 2; let y = top + ph;
        const segs = chart.stacked ? p.values.map((v, k) => { const h = v / max * ph; y -= h; return <rect key={k} x={x} y={y} width={bw} height={Math.max(0, h)} fill={TONE[chart.series[k].tone]} />; })
          : p.values.map((v, k) => { const w = bw / p.values.length; const h = v / max * ph; return <rect key={k} x={x + k * w} y={top + ph - h} width={Math.max(1, w - 0.5)} height={Math.max(0, h)} fill={TONE[chart.series[k].tone]} rx={n > 12 ? 0 : 1.5} />; });
        const topY = top + ph - totals[i] / max * ph;
        return <g key={p.label} opacity={hover === null || hover === i ? 1 : 0.45}>
          {segs}
          {p.mark ? <text x={x + bw / 2} y={Math.max(9, topY - 3)} fontSize="9" textAnchor="middle" fill="#b45309" fontWeight="600">{p.mark}</text> : null}
          {showLabel(i) ? <text x={x + bw / 2} y={H - 5} fontSize="9" textAnchor="middle" fill="#94a3b8">{p.label}</text> : null}
          <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
        </g>; })}
    </svg>
    <p className="h-4 text-[11.5px] tabular-nums text-[#334155]" aria-live="polite">{cur ? <><b className="font-semibold">{cur.label}</b>{chart.series.map((s, k) => <span key={s.label} className="ml-2"><span aria-hidden="true" className="mr-1 inline-block size-2 rounded-[2px]" style={{ background: TONE[s.tone] }} />{fmt(cur.values[k], chart.digits)} {chart.unit}</span>)}</> : <span className="text-[#94a3b8]">把鼠标移到柱上看数值</span>}</p>
    {chart.series.length > 1 ? <Legend items={chart.series} /> : null}
  </div>;
}

// 门店散点 + 拟合线。轴范围取 2%–98% 分位，避免几家极端店把点挤成一团。
function Scatter({ chart }: { chart: Extract<InsightChart, { kind: "scatter" }> }) {
  const W = 300; const H = 170; const l = 30; const r = 8; const t = 8; const b = 26;
  const q = (xs: number[], p: number) => { const s = [...xs].sort((a, c) => a - c); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))] ?? 0; };
  const xs = chart.points.map((p) => p[0]); const ys = chart.points.map((p) => p[1]);
  const x0 = Math.floor(q(xs, 0.02)); const x1 = Math.ceil(q(xs, 0.98)) || x0 + 1; const y0 = Math.floor(q(ys, 0.02)); const y1 = Math.ceil(q(ys, 0.98)) || y0 + 1;
  const sx = (v: number) => l + (v - x0) / (x1 - x0 || 1) * (W - l - r); const sy = (v: number) => H - b - (v - y0) / (y1 - y0 || 1) * (H - t - b);
  const inside = chart.points.filter(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
  const clipId = useId().replace(/:/g, "");
  return <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={chart.title}>
    <defs><clipPath id={clipId}><rect x={l} y={t} width={W - l - r} height={H - t - b} /></clipPath></defs>
    <line x1={l} x2={W - r} y1={H - b} y2={H - b} stroke="#e2e8f0" /><line x1={l} x2={l} y1={t} y2={H - b} stroke="#e2e8f0" />
    {[x0, (x0 + x1) / 2, x1].map((v) => <text key={`x${v}`} x={sx(v)} y={H - b + 11} fontSize="9" textAnchor="middle" fill="#94a3b8">{fmt(v, 0)}{chart.x.unit}</text>)}
    {[y0, (y0 + y1) / 2, y1].map((v) => <text key={`y${v}`} x={l - 3} y={sy(v) + 3} fontSize="9" textAnchor="end" fill="#94a3b8">{fmt(v, 0)}{chart.y.unit}</text>)}
    <text x={(l + W - r) / 2} y={H - 2} fontSize="9.5" textAnchor="middle" fill="#64748b">{chart.x.label} →</text>
    <g clipPath={`url(#${clipId})`}>
      {inside.map(([x, y], i) => <circle key={i} cx={sx(x)} cy={sy(y)} r="1.8" fill="#2f6bff" fillOpacity="0.28" />)}
      <line x1={sx(x0)} y1={sy(chart.fit.intercept + chart.fit.slope * x0)} x2={sx(x1)} y2={sy(chart.fit.intercept + chart.fit.slope * x1)} stroke="#f59e0b" strokeWidth="2" />
    </g>
    <text x={l + 4} y={t + 9} fontSize="9.5" fill="#64748b">↑ {chart.y.label}</text>
  </svg>;
}

// 对比柱：不画坐标轴，柱顶直接写数，柱下写名字；灰柱是对照，蓝柱是最突出的一档。业务一眼看大小。
function Compare({ chart }: { chart: Extract<InsightChart, { kind: "compare" }> }) {
  const max = Math.max(...chart.items.map((x) => x.value), 0.0001);
  const fill = { base: "#cbd5e1", hot: "#2f6bff", normal: "#c7d6ff" } as const;
  return <div role="img" aria-label={`${chart.title}：${chart.items.map((x) => `${x.label}${x.sub ? `（${x.sub}）` : ""} ${x.text}`).join("，")}`}>
    <div className="flex h-[132px] items-end gap-2 border-b border-[#e4eaf2] px-0.5" aria-hidden="true">
      {chart.items.map((x, i) => <div key={i} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end">
        <b className={`mb-1 whitespace-nowrap text-[12.5px] font-semibold tabular-nums ${x.tone === "hot" ? "text-[#2f6bff]" : "text-[#0f172a]"}`}>{x.text}</b>
        <span className="block w-full max-w-[40px] rounded-t-[5px]" style={{ height: `${Math.max(3, x.value / max * 100)}px`, background: fill[x.tone] }} />
      </div>)}
    </div>
    <div className="flex gap-2 px-0.5 pt-1.5" aria-hidden="true">
      {chart.items.map((x, i) => <span key={i} className="min-w-0 flex-1 text-center text-[11px] leading-[1.35] text-[#334155]">{x.label}{x.sub ? <small className="block text-[10.5px] text-[#94a3b8]">{x.sub}</small> : null}</span>)}
    </div>
  </div>;
}

type LinkedFactor = Extract<InsightChart, { kind: "linked" }>["a"];
const linkedFmt = (v: number, d: number) => v.toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });

// 两变量回归联动的单个滑块：isSuggested 时画波动范围、标「按历史关系建议」；否则是用户刚拖过的手动值，或两侧都没拖动过的基准值。
function LinkedSlider({ id, side, f, value, onDrag, isSuggested, anchor, band }: { id: string; side: "a" | "b"; f: LinkedFactor; value: number; onDrag: (v: number) => void; isSuggested: boolean; anchor: "a" | "b" | null; band: (v: number) => [number, number] }) {
  const span = f.max - f.min || 1; const at = (v: number) => `${Math.max(0, Math.min(100, (v - f.min) / span * 100))}%`;
  const [lo, hi] = isSuggested ? band(value) : [0, 0];
  return <div>
    <div className="flex items-baseline justify-between text-[12.5px]">
      <label htmlFor={`${id}-${side}`} className="font-medium text-[#0f172a]">{f.label}</label>
      <span className="tabular-nums text-[#334155]">{linkedFmt(value, f.digits)}{f.unit}<span className={`ml-1.5 ${isSuggested ? "font-semibold text-[#2f6bff]" : "text-[#94a3b8]"}`}>{isSuggested ? "按历史关系建议" : anchor === side ? "手动" : ""}</span></span>
    </div>
    <div className="relative mt-1">
      {isSuggested ? <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 rounded-full bg-[#dbe7ff]" style={{ left: at(Math.max(f.min, lo)), width: `${Math.max(0, (Math.min(f.max, hi) - Math.max(f.min, lo)) / span * 100)}%` }} /> : null}
      <input id={`${id}-${side}`} type="range" min={f.min} max={f.max} step={(f.max - f.min) / 200 || 1} value={value}
        onChange={(e) => onDrag(Number(e.target.value))}
        aria-valuetext={`${f.label} ${linkedFmt(value, f.digits)}${f.unit}${isSuggested ? "，按历史关系给的建议值" : ""}`}
        className="relative h-6 w-full cursor-pointer accent-[#2f6bff]" />
    </div>
    {isSuggested ? <p className="mt-1 text-[11px] leading-relaxed text-[#94a3b8]">历史上{side === "b" ? "日订单数" : "客单价"}在这个水平的门店，{f.label}大多落在 {linkedFmt(lo, f.digits)}–{linkedFmt(hi, f.digits)}{f.unit} 之间，不是精确预测。</p> : null}
    <div className="mt-1 flex justify-between text-[10.5px] tabular-nums text-[#94a3b8]"><span>{linkedFmt(f.min, f.digits)}</span><span>{linkedFmt(f.max, f.digits)}</span></div>
  </div>;
}

// 两变量回归联动：拖一个，另一个按真实回归关系给建议值 + 波动范围（不是恒等式，是历史统计趋势）。
// anchor 记录最后一次被用户拖动的是哪一侧；它是自变量，另一侧是回归算出来的因变量。两侧都没拖动过时 anchor 为 null，只显示基准值。
// 建议值按「相对变化」联动（b' = b0 × (a'/a0)^slope，从 anchor 刚切换时两侧的当前值出发），不是直接取回归线在 a' 处的绝对值——
// 基准值是中位数店的真实值，不在回归线上，拖一小步就跳到回归线绝对值会让客单价突然跳变一大截，相对缩放不会。
function Linked({ chart }: { chart: Extract<InsightChart, { kind: "linked" }> }) {
  const [anchor, setAnchor] = useState<"a" | "b" | null>(null);
  const [aValue, setAValue] = useState(chart.a.base);
  const [bValue, setBValue] = useState(chart.b.base);
  // anchor 切换的那一刻，把当时两侧的值记成这次联动的参照点（不是 chart.a.base/chart.b.base，那是全局基准，不是上次手动值）。
  const [anchorFrom, setAnchorFrom] = useState({ a: chart.a.base, b: chart.b.base });
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const bSuggestFromA = (a: number, a0: number, b0: number) => clamp(b0 * Math.pow(a / a0, chart.aToB.slope), chart.b.min, chart.b.max);
  const aSuggestFromB = (b: number, a0: number, b0: number) => clamp(a0 * Math.pow(b / b0, chart.bToA.slope), chart.a.min, chart.a.max);
  const onDragA = (v: number) => {
    const from = anchor === "a" ? anchorFrom : { a: aValue, b: bValue };
    if (anchor !== "a") { setAnchor("a"); setAnchorFrom(from); }
    setAValue(v); setBValue(bSuggestFromA(v, from.a, from.b));
  };
  const onDragB = (v: number) => {
    const from = anchor === "b" ? anchorFrom : { a: aValue, b: bValue };
    if (anchor !== "b") { setAnchor("b"); setAnchorFrom(from); }
    setBValue(v); setAValue(aSuggestFromB(v, from.a, from.b));
  };
  const sales = aValue * bValue;
  const band = (suggestedBase: number, sigma: number): [number, number] => [suggestedBase * Math.exp(-sigma), suggestedBase * Math.exp(sigma)];
  const id = useId();
  return <div className="space-y-3">
    <div className="rounded-xl bg-[#f5f8ff] px-3 py-2.5" aria-live="polite">
      <p className="text-[11.5px] text-[#64748b]">{chart.sales.label}</p>
      <p className="mt-0.5 flex items-baseline gap-2 tabular-nums">
        <b className="text-[22px] font-semibold leading-none tracking-tight text-[#0f172a]">{linkedFmt(sales, chart.sales.digits)}<small className="ml-0.5 text-[12px] font-medium text-[#64748b]">{chart.sales.unit}</small></b>
        <span className="ml-auto text-[11.5px] text-[#94a3b8]">现在 {linkedFmt(chart.a.base * chart.b.base, chart.sales.digits)}{chart.sales.unit}</span>
      </p>
    </div>
    <LinkedSlider id={id} side="a" f={chart.a} value={aValue} onDrag={onDragA} isSuggested={anchor === "b"} anchor={anchor} band={(v) => band(v, chart.bToA.sigma)} />
    <LinkedSlider id={id} side="b" f={chart.b} value={bValue} onDrag={onDragB} isSuggested={anchor === "a"} anchor={anchor} band={(v) => band(v, chart.aToB.sigma)} />
    <button type="button" onClick={() => { setAnchor(null); setAValue(chart.a.base); setBValue(chart.b.base); setAnchorFrom({ a: chart.a.base, b: chart.b.base }); }} disabled={anchor === null}
      className="min-h-8 whitespace-nowrap rounded-lg border border-[#e4eaf2] px-2.5 text-[12px] text-[#334155] hover:bg-[#f8fafc] disabled:opacity-40">恢复</button>
  </div>;
}

type Lever = Extract<InsightChart, { kind: "levers" }>["levers"][number];
// 在相邻两档之间线性插值；超出数据范围时取两端的值（滑块本身也只能拖到数据范围内）。
const interp = (xs: readonly number[], ys: readonly number[], x: number) => {
  if (x <= xs[0]) return ys[0]; if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let i = 1; while (i < xs.length - 1 && xs[i] < x) i++;
  const w = xs[i] === xs[i - 1] ? 0 : (x - xs[i - 1]) / (xs[i] - xs[i - 1]); return ys[i - 1] + w * (ys[i] - ys[i - 1]);
};
// 拖到 x 时，五个结果各是平时的几倍。曲线先除以 x = 0 处的值，保证「和平时一样」时全部不变。
function leverAt(l: Lever, x: number) {
  const rel = (ys: number[]) => interp(l.xs, ys, x) / (interp(l.xs, ys, 0) || 1);
  const orders = rel(l.orders); const aov = rel(l.aov); const gp = rel(l.gp); const revEx = rel(l.revEx);
  return { orders, aov, items: rel(l.items), sales: orders * aov, gp, gm: gp / (revEx || 1) };
}
const LEVER_TONE = { orders: "#2f6bff", sales: "#0f766e", gp: "#f59e0b" } as const;

// 多参数联动：选一个参数拖动，单数、客单价、销量、销售额、毛利、毛利率一起跟着变；从指标点进来时，那个指标的格子描边标出来；下面的小图标出当前位置在三条历史曲线上的哪里。
function Levers({ chart }: { chart: Extract<InsightChart, { kind: "levers" }> }) {
  const [leverId, setLeverId] = useState(chart.initial);
  const [x, setX] = useState(0);
  const l = chart.levers.find((v) => v.id === leverId) ?? chart.levers[0];
  const lo = l.xs[0]; const hi = l.xs[l.xs.length - 1];
  const at = leverAt(l, Math.min(hi, Math.max(lo, x)));
  const id = useId();
  const unitText = l.unit === "点" ? " 个点" : "%";
  const xText = (v: number) => Math.abs(v) < 0.05 ? "和平时一样" : `${v > 0 ? "高" : "低"} ${fmt(Math.abs(v), 1)}${unitText}`;
  const change = (ratio: number) => { const v = (ratio - 1) * 100; return Math.abs(v) < 0.5 ? null : v; };
  const base = { items: chart.base.items, orders: chart.base.orders, aov: chart.base.aov, sales: chart.base.orders * chart.base.aov, gp: chart.base.gp, gm: chart.base.gm };
  const tiles: Array<{ key: string; label: string; value: string; delta: number | null; points?: boolean }> = [
    { key: "orders", label: "单数", value: `${fmt(base.orders * at.orders, 1)} 单`, delta: change(at.orders) },
    { key: "aov", label: "客单价", value: `${fmt(base.aov * at.aov, 0)} 元`, delta: change(at.aov) },
    { key: "qty", label: "销量", value: `${fmt(base.items * at.items, 1)} 件`, delta: change(at.items) },
    { key: "sales", label: "销售额", value: `${fmt(base.sales * at.sales / 1e4, 1)} 万`, delta: change(at.sales) },
    { key: "gp", label: "毛利", value: `${fmt(base.gp * at.gp / 1e4, 1)} 万`, delta: change(at.gp) },
    { key: "gm", label: "毛利率", value: `${fmt(base.gm * at.gm, 1)}%`, delta: Math.abs(base.gm * (at.gm - 1)) < 0.05 ? null : base.gm * (at.gm - 1), points: true },
  ];
  // 销售额、毛利各在哪一档最高（只有落在中间、不在两端时才算「最高点」）。
  const peakOf = (key: "sales" | "gp") => { const v = l.xs.map((p) => leverAt(l, p)[key]); const k = v.indexOf(Math.max(...v)); return k > 0 && k < v.length - 1 ? l.xs[k] : null; };
  const presets = [{ label: "销售额最高处", x: peakOf("sales") }, { label: "毛利最高处", x: peakOf("gp") }].filter((p): p is { label: string; x: number } => p.x !== null);
  // 小图：横轴是这一项的取值（实际刻度），三条线是单数、销售额、毛利是平时的几倍。
  const W = 300; const H = 120; const pl = 30; const pr = 44; const pt = 10; const pb = 18;
  const series = (["orders", "sales", "gp"] as const).map((key) => ({ key, pts: l.xs.map((p) => [p, leverAt(l, p)[key]] as const) }));
  const ys = series.flatMap((s) => s.pts.map(([, v]) => v)); const yMin = Math.min(0.95, ...ys); const yMax = Math.max(1.05, ...ys);
  const sx = (v: number) => pl + (v - lo) / (hi - lo || 1) * (W - pl - pr); const sy = (v: number) => pt + (yMax - v) / (yMax - yMin || 1) * (H - pt - pb);
  const cx = sx(Math.min(hi, Math.max(lo, x)));
  const name = { orders: "单数", sales: "销售额", gp: "毛利" } as const;
  return <div className="space-y-3">
    <div role="group" aria-label="选一个参数来拖动" className="flex gap-1 rounded-lg bg-[#f1f5f9] p-1">
      {chart.levers.map((v) => <button key={v.id} type="button" aria-pressed={v.id === l.id} onClick={() => { setLeverId(v.id); setX(0); }}
        className={`min-h-8 flex-1 rounded-md px-2 text-[12px] transition-colors ${v.id === l.id ? "bg-white font-semibold text-[#0f172a] shadow-sm" : "text-[#64748b] hover:text-[#0f172a]"}`}>{v.label}</button>)}
    </div>
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
        <label htmlFor={`${id}-x`} className="font-medium text-[#0f172a]">{l.axis}</label>
        <b className={`shrink-0 tabular-nums ${Math.abs(x) < 0.05 ? "text-[#94a3b8]" : "text-[#2f6bff]"}`}>{xText(x)}</b>
      </div>
      <input id={`${id}-x`} type="range" min={lo} max={hi} step={(hi - lo) / 200 || 0.01} value={Math.min(hi, Math.max(lo, x))}
        onChange={(e) => setX(Number(e.target.value))} aria-valuetext={`${l.axis}${xText(x)}`}
        className="mt-1 h-6 w-full cursor-pointer accent-[#2f6bff]" />
      <div className="flex justify-between text-[10.5px] tabular-nums text-[#94a3b8]"><span>{xText(lo)}</span><span>{xText(hi)}</span></div>
    </div>
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" aria-live="polite">
      {tiles.map((t) => <div key={t.key} aria-current={chart.focus === t.key ? "true" : undefined} className={`rounded-lg border px-2.5 py-2 transition-colors duration-300 ${chart.focus === t.key ? "ring-2 ring-[#2f6bff] ring-offset-1" : ""} ${t.delta === null ? "border-[#e4eaf2] bg-white" : t.delta > 0 ? "border-[#bbf7d0] bg-[#f0fdf4]" : "border-[#fecaca] bg-[#fef2f2]"}`}>
        <p className="text-[11px] text-[#64748b]">{t.label}</p>
        <p className="mt-0.5 text-[15px] font-semibold leading-tight tabular-nums text-[#0f172a]">{t.value}</p>
        <p className={`text-[11px] font-medium tabular-nums ${t.delta === null ? "text-[#94a3b8]" : t.delta > 0 ? "text-[#047857]" : "text-[#b91c1c]"}`}>
          {t.delta === null ? "不变" : `${t.delta > 0 ? "▲" : "▼"} ${fmt(Math.abs(t.delta), t.points ? 1 : 0)}${t.points ? " 个点" : "%"}`}</p>
      </div>)}
    </div>
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${l.label}从${xText(lo)}到${xText(hi)}时，单数、销售额、毛利各是平时的几倍`}>
      <line x1={pl} x2={W - pr} y1={sy(1)} y2={sy(1)} stroke="#cbd5e1" strokeDasharray="3 3" />
      <text x={pl - 4} y={sy(1) + 3} fontSize="9" textAnchor="end" fill="#94a3b8">平时</text>
      {[yMin, yMax].map((v) => <text key={v} x={pl - 4} y={sy(v) + 3} fontSize="9" textAnchor="end" fill="#94a3b8">{fmt(v, 2)}×</text>)}
      {lo < 0 && hi > 0 ? <line x1={sx(0)} x2={sx(0)} y1={pt} y2={H - pb} stroke="#e2e8f0" /> : null}
      {series.map((s) => <path key={s.key} d={s.pts.map(([p, v], i) => `${i ? "L" : "M"}${sx(p)},${sy(v)}`).join("")} fill="none" stroke={LEVER_TONE[s.key]} strokeWidth="2" strokeLinejoin="round" />)}
      {series.map((s) => { const end = s.pts[s.pts.length - 1]; return <text key={`n${s.key}`} x={W - pr + 4} y={sy(end[1]) + 3} fontSize="9" fill={LEVER_TONE[s.key]} fontWeight="600">{name[s.key]}</text>; })}
      <line x1={cx} x2={cx} y1={pt} y2={H - pb} stroke="#0f172a" strokeOpacity="0.35" />
      {series.map((s) => <circle key={`c${s.key}`} cx={cx} cy={sy(at[s.key])} r="3.5" fill={LEVER_TONE[s.key]} stroke="#fff" strokeWidth="1.5" />)}
      <text x={sx(lo)} y={H - 5} fontSize="9" fill="#94a3b8">{xText(lo)}</text>
      <text x={sx(hi)} y={H - 5} fontSize="9" textAnchor="end" fill="#94a3b8">{xText(hi)}</text>
    </svg>
    <div className="flex flex-wrap gap-1.5">
      <button type="button" onClick={() => setX(0)} disabled={Math.abs(x) < 1e-9}
        className="min-h-8 whitespace-nowrap rounded-lg border border-[#e4eaf2] px-2.5 text-[12px] text-[#334155] hover:bg-[#f8fafc] disabled:opacity-40">回到平时</button>
      {presets.map((p) => <button key={p.label} type="button" onClick={() => setX(p.x)}
        className="min-h-8 whitespace-nowrap rounded-lg border border-[#f1e4c8] bg-[#fffbf2] px-2.5 text-[12px] text-[#92400e] hover:bg-[#fff4dd]">{p.label}（{xText(p.x)}）</button>)}
    </div>
    <p className="text-[11px] leading-relaxed text-[#94a3b8]">{l.note}</p>
  </div>;
}

// 折线：几条线都是「第一个点的几倍」，同一根纵轴（不用双纵轴）。横轴可以是逐日，也可以是门店分档；悬停一个点显示各线原值。
function Lines({ chart }: { chart: Extract<InsightChart, { kind: "lines" }> }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 300; const H = 170; const l = 26; const r = 44; const t = 22; const b = 18; const pw = W - l - r; const ph = H - t - b;
  const n = chart.labels.length; const max = Math.max(1, ...chart.series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  // 空档（null）处折线断开；线尾标签放在最后一个有值的点。
  const pathOf = (vals: Array<number | null>) => { let d = ""; let pen = false; vals.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i)},${y(v)}`; pen = true; }); return d; };
  const lastOf = (vals: Array<number | null>) => { for (let i = vals.length - 1; i >= 0; i--) if (vals[i] !== null) return { i, v: vals[i] as number }; return null; };
  const step = [0.5, 1, 2, 5].find((s) => max / s <= 5) ?? 10; const top = Math.ceil(max / step) * step;
  const pad = n <= 8 ? 16 : 0;
  const x = (i: number) => l + pad + (n > 1 ? i / (n - 1) : 0.5) * (pw - pad * 2); const y = (v: number) => t + ph - v / top * ph;
  const idx = (label: string) => chart.labels.indexOf(label);
  const band = chart.band ? { a: idx(chart.band.from), b: idx(chart.band.to) } : null;
  const ticks: number[] = []; for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  // 点少（门店分档）时每个点都标、画圆点；点多（逐日）时只标首尾、铺开那天和 mark 那天，挨得近的不标。
  const few = n <= 8;
  const shown = new Set<number>();
  if (few) for (let i = 0; i < n; i++) shown.add(i);
  else for (const i of [0, n - 1, ...(band && band.a >= 0 ? [band.a] : []), ...(chart.marks ?? []).map((m) => idx(m.at))]) if (i >= 0 && [...shown].every((j) => Math.abs(i - j) >= 4)) shown.add(i);
  return <div>
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={chart.title}
      onMouseMove={(e) => { const box = e.currentTarget.getBoundingClientRect(); const px = (e.clientX - box.left) / box.width * W; setHover(Math.max(0, Math.min(n - 1, Math.round((px - l - pad) / (pw - pad * 2) * (n - 1))))); }}
      onMouseLeave={() => setHover(null)}>
      {band && band.a >= 0 && band.b >= 0 ? <g>
        <rect x={x(band.a)} y={t} width={x(band.b) - x(band.a)} height={ph} fill="#eef3ff" />
        <text x={(x(band.a) + x(band.b)) / 2} y={t - 12} fontSize="9" textAnchor="middle" fill="#3b5bdb">{chart.band!.label}</text>
      </g> : null}
      {ticks.map((v) => <g key={v}>
        <line x1={l} x2={W - r} y1={y(v)} y2={y(v)} stroke={v === 1 ? "#cbd5e1" : "#eef2f7"} strokeDasharray={v === 1 ? "3 3" : undefined} />
        <text x={l - 4} y={y(v) + 3} fontSize="9" textAnchor="end" fill="#94a3b8">{v === 0 ? "0" : `${fmt(v, step < 1 ? 1 : 0)}×`}</text>
      </g>)}
      {chart.series.map((s) => <path key={s.label} d={pathOf(s.values)} fill="none" stroke={TONE[s.tone]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
      {/* 线尾直接写名字，不用对照图例；两条线的尾巴挨得近就上下错开。 */}
      {chart.series.map((s, k) => { const end = lastOf(s.values); if (!end) return null; const o = lastOf(chart.series[1 - k]?.values ?? []);
        const dy = o && Math.abs(y(end.v) - y(o.v)) < 10 ? (end.v >= o.v ? -6 : 6) : 0;
        return <text key={`l${s.label}`} x={end.i === n - 1 ? W - r + 4 : x(end.i) + 6} y={y(end.v) + dy + 3} fontSize="9" textAnchor="start" fill={TONE[s.tone]} fontWeight="600">{s.label}</text>; })}
      {(chart.marks ?? []).map((m) => { const i = idx(m.at); if (i < 0) return null; const v = Math.max(...chart.series.map((s) => s.values[i] ?? 0));
        return <text key={m.at} x={x(i) - 4} y={Math.max(9, y(v) - 4)} fontSize="9" textAnchor="end" fill="#b45309" fontWeight="600">{m.label} {fmt(v, 1)}×</text>; })}
      {few ? chart.series.map((s) => s.values.map((v, i) => v === null ? null : <circle key={`${s.label}${i}`} cx={x(i)} cy={y(v)} r="2.6" fill={TONE[s.tone]} stroke="#fff" strokeWidth="1.2" />)) : null}
      {chart.labels.map((label, i) => shown.has(i) ? <text key={label} x={x(i)} y={H - 5} fontSize="9" textAnchor={few ? "middle" : i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fill="#94a3b8">{label}</text> : null)}
      {hover !== null ? <g>
        <line x1={x(hover)} x2={x(hover)} y1={t} y2={t + ph} stroke="#94a3b8" />
        {chart.series.map((s) => { const v = s.values[hover]; return v === null ? null : <circle key={s.label} cx={x(hover)} cy={y(v)} r="3" fill={TONE[s.tone]} stroke="#fff" strokeWidth="1.5" />; })}
      </g> : null}
    </svg>
    <p className="min-h-4 text-[11.5px] tabular-nums text-[#334155]" aria-live="polite">{hover !== null
      ? <><b className="font-semibold">{chart.labels[hover]}</b>{chart.series.map((s) => <span key={s.label} className="ml-2"><span aria-hidden="true" className="mr-1 inline-block h-0.5 w-2.5 align-middle" style={{ background: TONE[s.tone] }} />{s.label} {s.hover[hover]}{s.values[hover] === null ? "" : `（${fmt(s.values[hover] as number, 1)}×）`}</span>)}</>
      : <span className="text-[#94a3b8]">1× = {chart.base ?? "平常工作日的日均"}；把鼠标移到图上看{few ? "每一档" : "每天"}的数</span>}</p>
  </div>;
}

export function InsightChartView({ chart, plain = false }: { chart: InsightChart; plain?: boolean }) {
  return <figure className={plain ? "m-0" : "mt-1 rounded-lg border border-[#dbe5ff] bg-white/85 p-2.5"}>
    {plain ? null : <figcaption className="mb-2 text-[12px] font-semibold text-[#1e3a8a]">{chart.title}</figcaption>}
    {chart.kind === "bars" ? <Bars chart={chart} /> : chart.kind === "split" ? <Split chart={chart} /> : chart.kind === "columns" ? <Columns chart={chart} /> : chart.kind === "lines" ? <Lines chart={chart} /> : chart.kind === "compare" ? <Compare chart={chart} /> : chart.kind === "linked" ? <Linked chart={chart} /> : chart.kind === "levers" ? <Levers chart={chart} /> : <Scatter chart={chart} />}
    {chart.legend && chart.kind !== "split" ? <Legend items={chart.legend} /> : null}
    {plain && chart.kind !== "levers" ? <figcaption className="mt-1.5 text-[11.5px] leading-relaxed text-[#94a3b8]">{chart.title}{chart.kind === "compare" && chart.note ? `；${chart.note}` : ""}</figcaption> : null}
    {chart.note && !(plain && chart.kind === "compare") ? <p className="mt-2 text-[11.5px] leading-relaxed text-[#64748b]">{chart.note}</p> : null}
  </figure>;
}
