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

// 逐日折线：几条线都是「平常工作日的几倍」，同一根纵轴（不用双纵轴）。悬停一天显示各线原值。
function Lines({ chart }: { chart: Extract<InsightChart, { kind: "lines" }> }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 300; const H = 170; const l = 26; const r = 44; const t = 22; const b = 18; const pw = W - l - r; const ph = H - t - b;
  const n = chart.labels.length; const max = Math.max(1, ...chart.series.flatMap((s) => s.values));
  const step = [0.5, 1, 2, 5].find((s) => max / s <= 5) ?? 10; const top = Math.ceil(max / step) * step;
  const x = (i: number) => l + (n > 1 ? i / (n - 1) : 0.5) * pw; const y = (v: number) => t + ph - v / top * ph;
  const idx = (label: string) => chart.labels.indexOf(label);
  const band = chart.band ? { a: idx(chart.band.from), b: idx(chart.band.to) } : null;
  const ticks: number[] = []; for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  // 横轴只标首尾、铺开那天和 mark 那天；和已标的挨得近（不到 4 天）就不标，免得字叠在一起。
  const shown = new Set<number>();
  for (const i of [0, n - 1, ...(band && band.a >= 0 ? [band.a] : []), ...(chart.marks ?? []).map((m) => idx(m.at))]) if (i >= 0 && [...shown].every((j) => Math.abs(i - j) >= 4)) shown.add(i);
  return <div>
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={chart.title}
      onMouseMove={(e) => { const box = e.currentTarget.getBoundingClientRect(); const px = (e.clientX - box.left) / box.width * W; setHover(Math.max(0, Math.min(n - 1, Math.round((px - l) / pw * (n - 1))))); }}
      onMouseLeave={() => setHover(null)}>
      {band && band.a >= 0 && band.b >= 0 ? <g>
        <rect x={x(band.a)} y={t} width={x(band.b) - x(band.a)} height={ph} fill="#eef3ff" />
        <text x={(x(band.a) + x(band.b)) / 2} y={t - 12} fontSize="9" textAnchor="middle" fill="#3b5bdb">{chart.band!.label}</text>
      </g> : null}
      {ticks.map((v) => <g key={v}>
        <line x1={l} x2={W - r} y1={y(v)} y2={y(v)} stroke={v === 1 ? "#cbd5e1" : "#eef2f7"} strokeDasharray={v === 1 ? "3 3" : undefined} />
        <text x={l - 4} y={y(v) + 3} fontSize="9" textAnchor="end" fill="#94a3b8">{v === 0 ? "0" : `${fmt(v, step < 1 ? 1 : 0)}×`}</text>
      </g>)}
      {chart.series.map((s) => <path key={s.label} d={s.values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("")} fill="none" stroke={TONE[s.tone]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />)}
      {/* 线尾直接写名字，不用对照图例 */}
      {chart.series.map((s, k) => { const v = s.values[n - 1]; const other = chart.series[1 - k]?.values[n - 1];
        const dy = other !== undefined && Math.abs(y(v) - y(other)) < 10 ? (v >= other ? -6 : 6) : 0;
        return <text key={`l${s.label}`} x={W - r + 4} y={y(v) + dy + 3} fontSize="9" textAnchor="start" fill={TONE[s.tone]} fontWeight="600">{s.label}</text>; })}
      {(chart.marks ?? []).map((m) => { const i = idx(m.at); if (i < 0) return null; const v = Math.max(...chart.series.map((s) => s.values[i]));
        return <text key={m.at} x={x(i) - 4} y={Math.max(9, y(v) - 4)} fontSize="9" textAnchor="end" fill="#b45309" fontWeight="600">{m.label} {fmt(v, 1)}×</text>; })}
      {chart.labels.map((label, i) => shown.has(i) ? <text key={label} x={x(i)} y={H - 5} fontSize="9" textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fill="#94a3b8">{label}</text> : null)}
      {hover !== null ? <g>
        <line x1={x(hover)} x2={x(hover)} y1={t} y2={t + ph} stroke="#94a3b8" />
        {chart.series.map((s) => <circle key={s.label} cx={x(hover)} cy={y(s.values[hover])} r="3" fill={TONE[s.tone]} stroke="#fff" strokeWidth="1.5" />)}
      </g> : null}
    </svg>
    <p className="min-h-4 text-[11.5px] tabular-nums text-[#334155]" aria-live="polite">{hover !== null
      ? <><b className="font-semibold">{chart.labels[hover]}</b>{chart.series.map((s) => <span key={s.label} className="ml-2"><span aria-hidden="true" className="mr-1 inline-block h-0.5 w-2.5 align-middle" style={{ background: TONE[s.tone] }} />{s.label} {s.hover[hover]}（{fmt(s.values[hover], 1)}×）</span>)}</>
      : <span className="text-[#94a3b8]">1× = 平常工作日的日均；把鼠标移到图上看每天的数</span>}</p>
  </div>;
}

export function InsightChartView({ chart, plain = false }: { chart: InsightChart; plain?: boolean }) {
  return <figure className={plain ? "m-0" : "mt-1 rounded-lg border border-[#dbe5ff] bg-white/85 p-2.5"}>
    {plain ? null : <figcaption className="mb-2 text-[12px] font-semibold text-[#1e3a8a]">{chart.title}</figcaption>}
    {chart.kind === "bars" ? <Bars chart={chart} /> : chart.kind === "split" ? <Split chart={chart} /> : chart.kind === "columns" ? <Columns chart={chart} /> : chart.kind === "lines" ? <Lines chart={chart} /> : chart.kind === "compare" ? <Compare chart={chart} /> : <Scatter chart={chart} />}
    {chart.legend && chart.kind !== "split" ? <Legend items={chart.legend} /> : null}
    {plain ? <figcaption className="mt-1.5 text-[11.5px] leading-relaxed text-[#94a3b8]">{chart.title}{chart.kind === "compare" && chart.note ? `；${chart.note}` : ""}</figcaption> : null}
    {chart.note && !(plain && chart.kind === "compare") ? <p className="mt-2 text-[11.5px] leading-relaxed text-[#64748b]">{chart.note}</p> : null}
  </figure>;
}
