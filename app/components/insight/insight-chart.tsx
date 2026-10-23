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

// 拖动模拟：结果 = 两个乘数相乘。拖滑块改一个乘数（另一个不动），结果按公式算出来；这是算术，不是预测。
// 滑块上的小刻度是同类好店（前 1/4）比一般店高多少，帮业务判断拖到多少是现实的。
function WhatIf({ chart }: { chart: Extract<InsightChart, { kind: "whatif" }> }) {
  const [pcts, setPcts] = useState<number[]>(() => chart.factors.map(() => 0));
  const fmt2 = (v: number, d: number) => v.toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
  const sign = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmt2(Math.abs(v), Math.abs(v) < 10 && v % 1 !== 0 ? 1 : 0)}%`;
  const ratio = pcts.reduce((a, p) => a * (1 + p / 100), 1);
  const after = chart.result.base * ratio; const change = (ratio - 1) * 100;
  const span = chart.max - chart.min; const at = (v: number) => `${(v - chart.min) / span * 100}%`;
  const id = useId();
  return <div className="space-y-3">
    <div className="rounded-xl bg-[#f5f8ff] px-3 py-2.5" aria-live="polite">
      <p className="text-[11.5px] text-[#64748b]">一家店一天的{chart.result.label}</p>
      <p className="mt-0.5 flex items-baseline gap-2 tabular-nums">
        <b className="text-[22px] font-semibold leading-none tracking-tight text-[#0f172a]">{fmt2(after, chart.result.digits)}<small className="ml-0.5 text-[12px] font-medium text-[#64748b]">{chart.result.unit}</small></b>
        <span className={`text-[13px] font-semibold ${change > 0.05 ? "text-[#047857]" : change < -0.05 ? "text-[#b91c1c]" : "text-[#94a3b8]"}`}>{Math.abs(change) < 0.05 ? "不变" : sign(change)}</span>
        <span className="ml-auto text-[11.5px] text-[#94a3b8]">现在 {fmt2(chart.result.base, chart.result.digits)}{chart.result.unit}</span>
      </p>
    </div>
    {chart.factors.map((f, i) => {
      const v = pcts[i]; const now = f.base * (1 + v / 100);
      return <div key={f.label}>
        <div className="flex items-baseline justify-between text-[12.5px]">
          <label htmlFor={`${id}-${i}`} className="font-medium text-[#0f172a]">{f.label}</label>
          <span className="tabular-nums text-[#334155]">{fmt2(now, f.digits)}{f.unit}<span className={`ml-1.5 ${v ? "font-semibold text-[#2f6bff]" : "text-[#94a3b8]"}`}>{v ? sign(v) : "不变"}</span></span>
        </div>
        <div className="relative mt-1">
          <input id={`${id}-${i}`} type="range" min={chart.min} max={chart.max} step={1} value={v}
            onChange={(e) => setPcts((p) => p.map((x, k) => k === i ? Number(e.target.value) : x))}
            aria-valuetext={`${f.label}${v ? sign(v) : "不变"}，${fmt2(now, f.digits)}${f.unit}`}
            className="h-6 w-full cursor-pointer accent-[#2f6bff]" />
          {f.ref > 0 && f.ref <= chart.max ? <span aria-hidden="true" className="pointer-events-none absolute -bottom-3 -translate-x-1/2 whitespace-nowrap text-[10px] text-[#b45309]" style={{ left: at(f.ref) }}>▲ 同类好店 +{fmt2(f.ref, 0)}%</span> : null}
        </div>
        <div className="mt-3.5 flex justify-between text-[10.5px] tabular-nums text-[#94a3b8]"><span>{chart.min}%</span><span>0</span><span>+{chart.max}%</span></div>
      </div>;
    })}
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" onClick={() => setPcts(chart.factors.map(() => 0))} disabled={pcts.every((p) => p === 0)}
        className="min-h-8 whitespace-nowrap rounded-lg border border-[#e4eaf2] px-2.5 text-[12px] text-[#334155] hover:bg-[#f8fafc] disabled:opacity-40">恢复</button>
      {chart.factors.map((f, i) => f.ref > 0 && f.ref <= chart.max ? <button key={f.label} type="button" onClick={() => setPcts(chart.factors.map((_, k) => k === i ? Math.round(f.ref) : 0))}
        className="min-h-8 whitespace-nowrap rounded-lg border border-[#f1e4c8] bg-[#fffbf2] px-2.5 text-[12px] text-[#92400e] hover:bg-[#fff4dd]">{f.label.replace(/^每天|（不含税）$/g, "")}到好店水平</button> : null)}
    </div>
  </div>;
}

type LinkedFactor = Extract<InsightChart, { kind: "linked" }>["a"];
const linkedFmt = (v: number, d: number) => v.toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });

// 两变量回归联动的单个滑块：isSuggested 时画波动范围、标「按历史关系建议」；否则是用户刚拖过的手动值，或两侧都没拖动过的基准值。
function LinkedSlider({ id, side, f, value, onDrag, isSuggested, anchor, band }: { id: string; side: "a" | "b"; f: LinkedFactor; value: number; onDrag: (v: number) => void; isSuggested: boolean; anchor: "a" | "b" | null; band: (v: number) => [number, number] }) {
  const span = f.max - f.min; const at = (v: number) => `${Math.max(0, Math.min(100, (v - f.min) / span * 100))}%`;
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
function Linked({ chart }: { chart: Extract<InsightChart, { kind: "linked" }> }) {
  const [anchor, setAnchor] = useState<"a" | "b" | null>(null);
  const [aValue, setAValue] = useState(chart.a.base);
  const [bValue, setBValue] = useState(chart.b.base);
  const { slope, intercept, sigma } = chart.fit;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const bSuggestFromA = (a: number) => clamp(Math.exp(intercept + slope * Math.log(a)), chart.b.min, chart.b.max);
  // slope 接近 0 或反解结果会冲出 a 的物理范围时，回归关系在这个方向上不可靠：a 不随 b 变化，诚实地反映"这个方向没有稳定关系"，
  // 而不是显示一个被钳制到边界、看似精确却是数学假象的数字（弱回归反解时 1/slope 放大误差，裁出离谱的值）。
  const aSuggestFromB = (b: number) => {
    if (Math.abs(slope) < 1e-6) return aValue;
    const raw = Math.exp((Math.log(b) - intercept) / slope);
    return clamp(raw, chart.a.min, chart.a.max);
  };
  const onDragA = (v: number) => { setAValue(v); setAnchor("a"); setBValue(bSuggestFromA(v)); };
  const onDragB = (v: number) => { setBValue(v); setAnchor("b"); if (Math.abs(slope) >= 1e-6) setAValue(aSuggestFromB(v)); };
  const sales = aValue * bValue;
  const band = (suggestedBase: number): [number, number] => [suggestedBase * Math.exp(-sigma), suggestedBase * Math.exp(sigma)];
  const id = useId();
  return <div className="space-y-3">
    <div className="rounded-xl bg-[#f5f8ff] px-3 py-2.5" aria-live="polite">
      <p className="text-[11.5px] text-[#64748b]">{chart.sales.label}</p>
      <p className="mt-0.5 flex items-baseline gap-2 tabular-nums">
        <b className="text-[22px] font-semibold leading-none tracking-tight text-[#0f172a]">{linkedFmt(sales, chart.sales.digits)}<small className="ml-0.5 text-[12px] font-medium text-[#64748b]">{chart.sales.unit}</small></b>
        <span className="ml-auto text-[11.5px] text-[#94a3b8]">现在 {linkedFmt(chart.a.base * chart.b.base, chart.sales.digits)}{chart.sales.unit}</span>
      </p>
    </div>
    <LinkedSlider id={id} side="a" f={chart.a} value={aValue} onDrag={onDragA} isSuggested={anchor === "b" && Math.abs(slope) >= 1e-6} anchor={anchor} band={band} />
    <LinkedSlider id={id} side="b" f={chart.b} value={bValue} onDrag={onDragB} isSuggested={anchor === "a"} anchor={anchor} band={band} />
    <button type="button" onClick={() => { setAnchor(null); setAValue(chart.a.base); setBValue(chart.b.base); }} disabled={anchor === null}
      className="min-h-8 whitespace-nowrap rounded-lg border border-[#e4eaf2] px-2.5 text-[12px] text-[#334155] hover:bg-[#f8fafc] disabled:opacity-40">恢复</button>
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
    {chart.kind === "bars" ? <Bars chart={chart} /> : chart.kind === "split" ? <Split chart={chart} /> : chart.kind === "columns" ? <Columns chart={chart} /> : chart.kind === "lines" ? <Lines chart={chart} /> : chart.kind === "compare" ? <Compare chart={chart} /> : chart.kind === "whatif" ? <WhatIf chart={chart} /> : chart.kind === "linked" ? <Linked chart={chart} /> : <Scatter chart={chart} />}
    {chart.legend && chart.kind !== "split" ? <Legend items={chart.legend} /> : null}
    {plain && chart.kind !== "whatif" ? <figcaption className="mt-1.5 text-[11.5px] leading-relaxed text-[#94a3b8]">{chart.title}{chart.kind === "compare" && chart.note ? `；${chart.note}` : ""}</figcaption> : null}
    {chart.note && !(plain && chart.kind === "compare") ? <p className="mt-2 text-[11.5px] leading-relaxed text-[#64748b]">{chart.note}</p> : null}
  </figure>;
}
