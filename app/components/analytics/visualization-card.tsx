"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ResolvedVisualization } from "../../lib/analytics/visualization-types.ts";
import { visualizationHtml, visualizationSvg } from "../../lib/analytics/visualization-html.ts";
import { useWorkspacePanel } from "../workspace/workspace-panel-context.ts";
import { useVisualizationFiles, type VisualizationFileReference } from "./use-visualization-files.ts";

const colors = ["#2470cc", "#168475", "#9b62b0", "#b57524"];
const buttonClass = "min-h-11 rounded-lg px-3 text-xs font-medium transition-colors hover:bg-[#eaf2fc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";
export function VisualizationDataTable({ chart }: { chart: ResolvedVisualization }) {
  return <div className="max-h-[32rem] overflow-auto rounded-xl border border-[#dce6f0]"><table className="w-full border-collapse text-left text-xs leading-6 tabular-nums"><caption className="sr-only">{chart.title}，单位：{chart.unit}</caption><thead className="sticky top-0 bg-[#f2f7fd]"><tr><th scope="col" className="px-3 py-2 font-medium">{chart.xAxis ? `${chart.xAxis.label}（${chart.xAxis.unit}）` : "分组"}</th>{chart.series.map((series) => <th key={series.key} scope="col" className="px-3 py-2 text-right font-medium">{series.label}</th>)}</tr></thead><tbody>{chart.categories.map((category, at) => <tr key={category.key} className="border-t border-[#e7eef6]"><th scope="row" className="break-words px-3 py-2 font-normal">{category.label}</th>{chart.series.map((series) => <td key={series.key} className="whitespace-nowrap px-3 py-2 text-right">{series.values[at].exact ?? "未提供"}</td>)}</tr>)}</tbody></table></div>;
}

function ChartDisplay({ chart }: { chart: ResolvedVisualization }) {
  const [mode, setMode] = useState<"native" | "html" | "table">(chart.renderer);
  const [hidden, setHidden] = useState<string[]>([]); const [active, setActive] = useState<string>("");
  const [width, setWidth] = useState(640); const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width)); });
    observer.observe(container.current); return () => observer.disconnect();
  }, []);
  const svg = useMemo(() => { try { return visualizationSvg(chart, hidden, width); } catch { return ""; } }, [chart, hidden, width]);
  const html = useMemo(() => visualizationHtml(chart), [chart]);
  const inspect = (target: EventTarget) => {
    const point = (target as Element).closest?.("[data-point]")?.getAttribute("data-point");
    if (!point || !/^\d+:\d+$/.test(point)) return;
    const [si, at] = point.split(":").map(Number); const series = chart.series[si], category = chart.categories[at];
    if (!series || !category) return; const value = series.values[at];
    setActive(`${category.label} · ${series.label}：${value.exact ?? "未提供"}${value.exact === null ? "" : chart.unit}`);
  };
  return <div ref={container} className="min-w-0 space-y-3">
    <div role="group" aria-label="图表显示方式" className="flex flex-wrap gap-1 rounded-xl bg-[#f2f7fd] p-1">{([{ key: "native", label: "图表" }, { key: "html", label: "HTML" }, { key: "table", label: "查看数据" }] as const).map((item) => <button key={item.key} type="button" aria-pressed={mode === item.key} onClick={() => setMode(item.key)} className={`${buttonClass} ${mode === item.key ? "bg-white text-[#1e61a4] shadow-sm" : "text-[#5a728c]"}`}>{item.label}</button>)}</div>
    {mode === "table" || !svg ? <VisualizationDataTable chart={chart} /> : mode === "html" ? <iframe title={`${chart.title} HTML 预览`} sandbox="" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'" referrerPolicy="no-referrer" srcDoc={html} className="h-[440px] w-full rounded-xl border border-[#dce6f0] bg-white" /> : <>
      <div aria-label="图例与系列显示" className="flex flex-wrap gap-1">{chart.series.map((series, at) => <button key={series.key} type="button" aria-pressed={!hidden.includes(series.key)} onClick={() => { setHidden((value) => value.includes(series.key) ? value.filter((key) => key !== series.key) : [...value, series.key]); setActive(""); }} className={`${buttonClass} inline-flex items-center gap-2 text-[#425b74] ${hidden.includes(series.key) ? "opacity-50" : ""}`}><span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: colors[at] }} />{series.label}</button>)}</div>
      <div className="max-h-96 min-w-0 overflow-auto rounded-lg bg-white [&_[data-point]:focus]:outline-2 [&_[data-point]:focus]:outline-offset-2 [&_[data-point]:focus]:outline-[#2470cc]" onMouseOver={(event) => inspect(event.target)} onFocusCapture={(event) => inspect(event.target)} onClick={(event) => inspect(event.target)} dangerouslySetInnerHTML={{ __html: svg }} />
      <output aria-live="polite" className="block min-h-6 break-words text-xs leading-6 text-[#526b84]">{active || "选择图中数据可查看具体数值，完整数据可切换查看。"}</output>
    </>}
  </div>;
}

export function VisualizationSourceSummary({ chart, version }: { chart: ResolvedVisualization; version?: string }) {
  return <div className="space-y-4 text-sm leading-7"><p className="break-words">{chart.scope}</p>{version ? <p className="break-all text-xs text-muted-foreground">数据版本：{version}</p> : null}<p className="break-words">{chart.definition}</p><p>{chart.selectionLabel}</p>{chart.limitations.map((item, at) => <p key={at} className="text-muted-foreground">{item}</p>)}<VisualizationDataTable chart={chart} /></div>;
}

export function VisualizationCard({ chart, status = "final", sourceContent, conversationId, files = [] }: { chart: ResolvedVisualization; status?: "final" | "running" | "incomplete"; sourceContent?: ReactNode; conversationId?: string; files?: readonly VisualizationFileReference[] }) {
  const owner = useId(); const { panelId, activeId, togglePanel, dismissPanel } = useWorkspacePanel();
  const availability = useVisualizationFiles(conversationId, files);
  useEffect(() => () => dismissPanel(owner), [owner, dismissPanel]);
  useEffect(() => { if (availability.status !== "available") dismissPanel(owner); }, [availability.status, owner, dismissPanel]);
  const titleId = `${owner}-title`;
  return <figure data-visualization-card={chart.id} aria-labelledby={titleId} className="min-w-0 space-y-3 rounded-2xl border border-[#d8e5f4] bg-white p-3.5 select-text sm:p-5">
    <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0 flex-1"><h3 id={titleId} className="break-words text-[15px] font-semibold leading-7 text-[#234c75]">{chart.title}</h3><p className="mt-1 break-words text-xs leading-6 text-[#607891]">{chart.scope} · 单位：{chart.unit}</p></div><div className="flex shrink-0 gap-1"><button type="button" onClick={(event) => togglePanel({ id: `${owner}:expanded`, title: chart.title, label: "图表", width: "wide", content: <div className="space-y-4"><p className="text-xs leading-6 text-muted-foreground">{chart.scope} · {chart.unit}</p><ChartDisplay chart={chart} /></div> }, event.currentTarget)} aria-controls={panelId} aria-expanded={activeId === `${owner}:expanded`} disabled={availability.status !== "available"} className={`${buttonClass} text-[#276cac] disabled:opacity-40`}>展开</button><button type="button" onClick={(event) => togglePanel({ id: `${owner}:source`, title: chart.title, label: "图表数据出处", content: sourceContent ?? <VisualizationSourceSummary chart={chart} /> }, event.currentTarget)} aria-controls={panelId} aria-expanded={activeId === `${owner}:source`} disabled={availability.status !== "available"} className={`${buttonClass} text-[#276cac] disabled:opacity-40`}>来源</button></div></div>
    {status !== "final" ? <p role="status" className={`rounded-lg px-3 py-2 text-xs leading-6 ${status === "running" ? "bg-[#edf5ff] text-[#38678f]" : "bg-[#fff8eb] text-[#826530]"}`}>{status === "running" ? "已核验数据 · 分析进行中" : "本次分析未完成，以下为已核验的阶段数据。"}</p> : null}
    <p className="text-xs leading-6 text-[#6b8198]">{chart.selectionLabel}</p>
    {availability.status === "available" ? <ChartDisplay chart={chart} /> : <div role="status" className="rounded-xl bg-[#f5f8fc] px-4 py-6 text-sm leading-7 text-muted-foreground">{availability.status === "checking" ? "正在确认图表来源…" : availability.status === "unavailable" ? "来源文件已删除、过期或版本变化，图表已隐藏。" : <>暂时无法确认文件来源。<button type="button" onClick={availability.retry} className={`${buttonClass} ml-1 text-primary`}>重新检查</button></>}</div>}
    {chart.limitations.length ? <figcaption className="break-words border-t border-[#e7eef7] pt-3 text-xs leading-6 text-[#758496]">{chart.limitations.join("；")}</figcaption> : null}
  </figure>;
}
