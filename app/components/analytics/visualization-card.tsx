"use client";

import { BarChart3, Maximize2, Table2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ResolvedVisualization } from "../../lib/analytics/visualization-types.ts";
import { visualizationSvg, visualizationValueLabel } from "../../lib/analytics/visualization-html.ts";
import { useWorkspacePanel } from "../workspace/workspace-panel-context.ts";
import { useVisualizationFiles, type VisualizationFileReference } from "./use-visualization-files.ts";

const colors = ["#2470cc", "#168475", "#9b62b0", "#b57524"];
const iconButtonClass = "grid size-9 place-items-center rounded-lg text-[#6b7f96] transition-colors hover:bg-[#eef4fb] hover:text-[#2470cc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 motion-reduce:transition-none";
const buttonClass = "min-h-11 rounded-lg px-3 text-xs font-medium transition-colors hover:bg-[#eaf2fc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";
export function VisualizationDataTable({ chart }: { chart: ResolvedVisualization }) {
  return <div className="max-h-[32rem] overflow-auto rounded-xl border border-[#dce6f0]"><table className="w-full border-collapse text-left text-xs leading-6 tabular-nums"><caption className="sr-only">{chart.title}，单位：{chart.unit}</caption><thead className="sticky top-0 bg-[#f2f7fd]"><tr><th scope="col" className="px-3 py-2 font-medium">{chart.xAxis ? `${chart.xAxis.label}（${chart.xAxis.unit}）` : "分组"}</th>{chart.series.map((series) => <th key={series.key} scope="col" className="px-3 py-2 text-right font-medium">{series.label}</th>)}</tr></thead><tbody>{chart.categories.map((category, at) => <tr key={category.key} className="border-t border-[#e7eef6]"><th scope="row" className="break-words px-3 py-2 font-normal">{category.label}</th>{chart.series.map((series) => <td key={series.key} className="whitespace-nowrap px-3 py-2 text-right">{series.values[at].value === null ? "未提供" : chart.valueFormat === "percent" ? visualizationValueLabel(chart, series.values[at].value!) : series.values[at].exact}</td>)}</tr>)}</tbody></table></div>;
}

function ChartDisplay({ chart, showTable = false }: { chart: ResolvedVisualization; showTable?: boolean }) {
  // 只给一张图；原始数值收在标题栏的「数据」按钮里，图画不出来时直接显示数据表。
  const [hidden, setHidden] = useState<string[]>([]);
  // 悬浮提示跟着鼠标走：显示这一行（这个分组或时间点）所有系列的数值。
  const [tip, setTip] = useState<{ at: number; x: number; y: number } | null>(null);
  const [width, setWidth] = useState(640); const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width)); });
    observer.observe(container.current); return () => observer.disconnect();
  }, []);
  const svg = useMemo(() => { try { return visualizationSvg(chart, hidden, width); } catch { return ""; } }, [chart, hidden, width]);
  const formatValue = (value: ResolvedVisualization["series"][number]["values"][number]) => value.value === null ? "未提供" : chart.valueFormat === "percent" ? visualizationValueLabel(chart, value.value) : visualizationValueLabel(chart, value.value) + (/单位未提供/.test(chart.unit) ? "" : chart.unit);
  const inspect = (target: EventTarget, clientX: number, clientY: number) => {
    const element = target as Element; const box = container.current?.getBoundingClientRect();
    const row = element.closest?.("[data-row]")?.getAttribute("data-row") ?? element.closest?.("[data-point]")?.getAttribute("data-point")?.split(":")[1];
    if (row === undefined || row === null || !box || !/^\d+$/.test(row) || !chart.categories[Number(row)]) { setTip(null); return; }
    setTip({ at: Number(row), x: clientX - box.left, y: clientY - box.top });
  };
  return <div ref={container} className="relative min-w-0 space-y-3">
    {showTable || !svg ? <VisualizationDataTable chart={chart} /> : <>
      {chart.series.length > 1 ? <div aria-label="图例与系列显示" className="flex flex-wrap gap-1">{chart.series.map((series, at) => <button key={series.key} type="button" aria-pressed={!hidden.includes(series.key)} onClick={() => { setHidden((value) => value.includes(series.key) ? value.filter((key) => key !== series.key) : [...value, series.key]); setTip(null); }} className={`${buttonClass} inline-flex items-center gap-2 text-[#425b74] ${hidden.includes(series.key) ? "opacity-50" : ""}`}><span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: colors[at] }} />{series.label}</button>)}</div> : null}
      <div className="max-h-96 min-w-0 overflow-auto rounded-lg bg-white [&_[data-point]:focus]:outline-2 [&_[data-point]:focus]:outline-offset-2 [&_[data-point]:focus]:outline-[#2470cc]" onMouseMove={(event) => inspect(event.target, event.clientX, event.clientY)} onMouseLeave={() => setTip(null)} onFocusCapture={(event) => { const rect = (event.target as Element).getBoundingClientRect(); inspect(event.target, rect.right, rect.top); }} onBlurCapture={() => setTip(null)} dangerouslySetInnerHTML={{ __html: svg }} />
      {tip ? <div role="tooltip" aria-live="polite" className="pointer-events-none absolute z-10 min-w-40 max-w-64 rounded-xl border border-[#e6edf5] bg-white px-3.5 py-2.5 text-[13px] shadow-[0_8px_24px_rgba(30,60,100,0.14)]" style={{ left: Math.min(tip.x + 14, width - 180), top: Math.max(0, tip.y + 14) }}>
        <p className="mb-1 break-words font-semibold text-[#22364d]">{chart.categories[tip.at].label}</p>
        {chart.series.filter((series) => !hidden.includes(series.key)).map((series) => <p key={series.key} className="flex items-center justify-between gap-4 leading-6"><span className="flex min-w-0 items-center gap-2 text-[#5c7288]"><span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: colors[chart.series.indexOf(series)] }} /><span className="truncate">{series.label}</span></span><span className="font-semibold tabular-nums text-[#22364d]">{formatValue(series.values[tip.at])}</span></p>)}
      </div> : null}
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
  const titleId = `${owner}-title`; const [showTable, setShowTable] = useState(false);
  const ready = availability.status === "available";
  // 卡片只保留标题、两个图标按钮和图本身；口径、范围和数据来源放进「详情」面板，不在正文里铺开。
  const details = <div className="space-y-4"><ChartDisplay chart={chart} /><VisualizationSourceSummary chart={chart} /></div>;
  return <figure data-visualization-card={chart.id} aria-labelledby={titleId} className="min-w-0 space-y-2 rounded-2xl border border-[#e3ebf4] bg-white px-4 py-3.5 select-text sm:px-5">
    <div className="flex items-center justify-between gap-2">
      <h3 id={titleId} className="min-w-0 break-words text-[14px] font-semibold leading-6 text-[#22364d]">{chart.title}</h3>
      <div className="flex shrink-0 items-center">
        <button type="button" aria-pressed={showTable} aria-label={showTable ? "返回图表" : "查看数据"} title={showTable ? "返回图表" : "查看数据"} onClick={() => setShowTable((value) => !value)} disabled={!ready} className={`${iconButtonClass}`}>{showTable ? <BarChart3 className="size-4" aria-hidden="true" /> : <Table2 className="size-4" aria-hidden="true" />}</button>
        <button type="button" aria-label="展开详情" title="展开详情" onClick={(event) => togglePanel({ id: `${owner}:expanded`, title: chart.title, label: "图表详情", width: "wide", content: sourceContent ? <div className="space-y-4"><ChartDisplay chart={chart} />{sourceContent}</div> : details }, event.currentTarget)} aria-controls={panelId} aria-expanded={activeId === `${owner}:expanded`} disabled={!ready} className={iconButtonClass}><Maximize2 className="size-4" aria-hidden="true" /></button>
      </div>
    </div>
    {status !== "final" ? <p role="status" className="text-xs leading-6 text-[#6b8198]">{status === "running" ? "分析进行中" : "本次分析未完成，以下为阶段数据"}</p> : null}
    {ready ? <ChartDisplay chart={chart} showTable={showTable} /> : <div role="status" className="rounded-xl bg-[#f5f8fc] px-4 py-6 text-sm leading-7 text-muted-foreground">{availability.status === "checking" ? "正在加载图表…" : availability.status === "unavailable" ? "来源文件已删除或过期，图表已隐藏。" : <>暂时无法加载图表。<button type="button" onClick={availability.retry} className={`${buttonClass} ml-1 text-primary`}>重试</button></>}</div>}
  </figure>;
}
