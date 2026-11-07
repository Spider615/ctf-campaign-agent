"use client";

import { CalendarRange } from "lucide-react";
import { useState } from "react";
import { MIN_RANGE_DAYS, rangeDays, rangeLabel, type InsightRange } from "../../lib/insight/range";
import type { InsightGraph } from "../../lib/insight/types";

// 范围选择：全部数据、节日预设（来自图谱的 scope.festivals）、自定义起止。改了就写进 URL，由工作台重新请求。
const toInput = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const fromInput = (v: string) => v.replaceAll("-", "");

export function InsightRangePicker({ graph, range, onChange }: { graph: InsightGraph; range: InsightRange | null; onChange: (range: InsightRange | null) => void }) {
  const { dataFrom, dataTo, festivals } = graph.scope;
  const preset = !range ? "all" : festivals.find((f) => f.from === range.from && f.to === range.to)?.name ?? "custom";
  const [custom, setCustom] = useState(preset === "custom");
  const [from, setFrom] = useState(range?.from ?? dataFrom); const [to, setTo] = useState(range?.to ?? dataTo);
  const draft = { from, to }; const tooShort = from > to || rangeDays(draft) < MIN_RANGE_DAYS;
  const choose = (value: string) => {
    if (value === "custom") { setCustom(true); return; }
    setCustom(false);
    const f = festivals.find((x) => x.name === value);
    onChange(f ? { from: f.from, to: f.to } : null);
  };
  const field = "min-h-8 rounded-lg border border-[#d9e2ee] bg-white px-2 text-[12.5px] text-[#0f172a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return <div className="flex flex-wrap items-center gap-2">
    <CalendarRange aria-hidden="true" className="size-4 text-[#64748b]" />
    <label className="sr-only" htmlFor="insight-range">时间范围</label>
    <select id="insight-range" value={custom ? "custom" : preset} onChange={(e) => choose(e.target.value)} className={field}>
      <option value="all">全部（{rangeLabel({ from: dataFrom, to: dataTo })}）</option>
      {festivals.map((f) => <option key={f.name} value={f.name}>{f.name}（{rangeLabel(f)}）</option>)}
      <option value="custom">自定义</option>
    </select>
    {custom ? <>
      <input type="date" aria-label="开始日期" value={toInput(from)} min={toInput(dataFrom)} max={toInput(dataTo)} onChange={(e) => setFrom(fromInput(e.target.value))} className={field} />
      <span className="text-[12px] text-[#94a3b8]">至</span>
      <input type="date" aria-label="结束日期" value={toInput(to)} min={toInput(dataFrom)} max={toInput(dataTo)} onChange={(e) => setTo(fromInput(e.target.value))} className={field} />
      <button type="button" disabled={tooShort} onClick={() => onChange(draft)} className="min-h-8 rounded-lg bg-[#2f6bff] px-3 text-[12.5px] font-medium text-white disabled:bg-[#cbd5e1]">看这段</button>
      {tooShort ? <span className="text-[12px] text-[#a43f37]">至少选 {MIN_RANGE_DAYS} 天</span> : null}
    </> : null}
  </div>;
}
