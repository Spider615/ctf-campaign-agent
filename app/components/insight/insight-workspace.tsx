"use client";

import { useEffect, useState } from "react";
import { analyticsRequest } from "../../lib/client/analytics";
import { INSIGHT_METRICS, MISSING_METRICS } from "../../lib/insight/metrics";
import { INSIGHT_CATEGORY_CHOICES, INSIGHT_METRIC_IDS, INSIGHT_OFFER_CHOICES, type InsightDimensionId, type InsightEdge, type InsightGraph, type InsightMetricId } from "../../lib/insight/types";
import { focusSearch, requestOf, type InsightFocus } from "../../lib/insight/context";
import { InsightGraphView, InsightLegend, type InsightSelection } from "./insight-graph-view";
import { InsightSidePanel } from "./insight-side-panel";
import { InsightChat } from "./insight-chat";

const select = "min-h-10 rounded-lg border border-[#d4e4f5] bg-white px-2.5 text-sm text-[#20314d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function InsightWorkspace({ focus, onFocusChange, highlight, onAsk, onDraft, onAskQa }: {
  focus: InsightFocus; onFocusChange: (focus: InsightFocus) => void; highlight?: InsightDimensionId | null;
  onAsk: (focus: InsightFocus) => void; onDraft: (text: string) => void; onAskQa: (question: string, focus: InsightFocus) => void;
}) {
  const [marked, setMarked] = useState<string[]>([]);
  // 每次结果记下它对应的请求；请求变了而结果还没到就是加载中，不用另存 loading。
  const [graph, setGraph] = useState<InsightGraph | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestKey = focusSearch(requestOf(focus));
  const fetchKey = `${requestKey}#${attempt}`;
  const [settled, setSettled] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    analyticsRequest<InsightGraph>(`/api/analytics/insight?${requestKey}`, undefined, controller.signal)
      .then((result) => { if (!controller.signal.aborted) { setGraph(result); setFailure(null); setSettled(fetchKey); } })
      .catch((caught) => { if (!controller.signal.aborted) { setFailure({ key: fetchKey, message: caught instanceof Error ? caught.message : "洞察图谱暂时算不出来" }); setSettled(fetchKey); } });
    return () => controller.abort();
  }, [requestKey, fetchKey]);
  const loading = settled !== fetchKey;
  const error = failure?.key === fetchKey ? failure.message : "";

  // 维度连线的选中写进 URL（刷新、问答回来都还在）；其余选中（节点、其他连线、来源筛选）只在本页保留。
  const [localSelection, setLocalSelection] = useState<InsightSelection | null>(null);
  const choose = (next: InsightSelection | null) => {
    setMarked([]);
    if (next?.kind === "edge") { setLocalSelection(null); onFocusChange({ ...requestOf(focus), dimension: next.dimension }); }
    else { if (focus.dimension) onFocusChange(requestOf(focus)); setLocalSelection(next); }
  };
  const effective: InsightSelection | null = focus.dimension ? { kind: "edge", dimension: focus.dimension } : highlight ? { kind: "edge", dimension: highlight } : localSelection;
  const current = graph && JSON.stringify(graph.request) === JSON.stringify(requestOf(focus)) ? graph : null;
  const ask = (edge: InsightEdge | null) => onAsk(edge ? { ...requestOf(focus), dimension: edge.dimension, ...(edge.best ? { value: edge.best } : {}) } : requestOf(focus));

  return <section aria-label="智能洞察" className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[#e4edf7] bg-white/60 px-4 py-2.5 md:px-6">
      <label className="flex items-center gap-1.5 text-[12px] text-[#5c7392]">看什么
        <select className={select} value={focus.metric} onChange={(e) => { setLocalSelection(null); onFocusChange({ ...requestOf(focus), metric: e.target.value as InsightMetricId }); }}>
          {/* 不按目标分组：能算的在前，缺数据的放最后 */}
          {INSIGHT_METRIC_IDS.map((id) => <option key={id} value={id}>{INSIGHT_METRICS[id].label}{INSIGHT_METRICS[id].status === "inferred" ? "（推断）" : ""}</option>)}
          {MISSING_METRICS.map((m) => <option key={m.id} disabled>{m.label}（缺数据）</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-[12px] text-[#5c7392]">优惠
        <select className={select} value={focus.offer} onChange={(e) => onFocusChange({ ...requestOf(focus), offer: e.target.value })}>{INSIGHT_OFFER_CHOICES.map((o) => <option key={o} value={o}>{o}</option>)}</select>
      </label>
      <label className="flex items-center gap-1.5 text-[12px] text-[#5c7392]">货类
        <select className={select} value={focus.category} onChange={(e) => onFocusChange({ ...requestOf(focus), category: e.target.value })}>{INSIGHT_CATEGORY_CHOICES.map((c) => <option key={c} value={c}>{c}</option>)}</select>
      </label>
      <span className="text-[11px] text-[#8397af]">对照：一般開單 · 2025 年 8 月</span>
      {loading && current ? <span role="status" className="ml-auto text-[11px] text-[#247cff]">正在更新…</span> : null}
    </div>
    <div className="grid min-h-0 flex-1 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_400px] xl:overflow-hidden">
      <div className="min-w-0 p-3 md:p-5 xl:overflow-y-auto">
        {error ? <div role="alert" className="rounded-xl border border-[#f2c8c3] bg-[#fff4f2] p-4 text-sm text-[#a43f37]">{error}<button type="button" onClick={() => setAttempt((n) => n + 1)} className="ml-3 min-h-10 underline">重试</button></div>
          : !current ? <div role="status" className="grid min-h-[420px] place-items-center rounded-2xl border border-dashed border-[#c9d8ea] bg-white/60 p-6 text-center">
            <div><span className="mx-auto block size-8 animate-spin rounded-full border-2 border-[#c7ddff] border-t-[#247cff] motion-reduce:animate-none" /><p className="mt-4 text-sm font-medium text-[#27415f]">正在从 128 万行明细里算关系图谱</p><p className="mt-1 text-[12px] text-[#7187a1]">每个优惠和货类第一次计算约需 1 分钟，之后切换指标会很快</p></div>
          </div>
          : <><div className="overflow-x-auto overscroll-x-contain rounded-2xl border border-[#dbe8f7] bg-white/80 p-2 shadow-[0_8px_24px_rgba(43,94,151,0.04)]"><div className="min-w-[680px]"><InsightLegend graph={current} selection={effective} onSelect={choose} /><InsightGraphView graph={current} selection={effective} onSelect={choose} marked={marked} /></div></div>
            {/* 中心还能换成这些指标，但数据里没有：写明要采集什么。 */}
            <div className="mt-3 rounded-xl border border-dashed border-[#e0b84c] bg-[#fffcf3] px-4 py-3">
              <p className="text-[12px] font-medium text-[#8a6a12]">还想看、但现在数据里没有的指标</p>
              <ul className="mt-2 flex flex-wrap gap-2">{MISSING_METRICS.map((m) => <li key={m.id} className="rounded-lg border border-[#ecd9a2] bg-white px-2.5 py-1 text-[12px] text-[#6f5b25]" title={`需要采集：${m.need}`}>{m.label}<span className="ml-1 text-[11px] text-[#a08a4c]">需要{m.need}</span></li>)}</ul>
            </div></>}
      </div>
      <aside aria-label="洞察详情" className="min-w-0 border-t border-[#e4edf7] bg-[#f8fbff] p-4 xl:overflow-y-auto xl:border-l xl:border-t-0">
        {current ? <div className="mb-3"><InsightChat graph={current} selection={effective} onSelect={choose} onHighlight={setMarked}
          onAskQa={(question) => onAskQa(question, effective?.kind === "edge" ? { ...requestOf(focus), dimension: effective.dimension } : requestOf(focus))} /></div> : null}
        {current ? <InsightSidePanel graph={current} selection={effective} onAsk={ask} onDraft={onDraft} onSelect={choose} onMetric={(metric, dimension) => { setLocalSelection(null); onFocusChange({ ...requestOf(focus), metric, dimension }); }} /> : <p className="text-sm text-[#7187a1]">图谱算好后，点节点看事实，点连线看依据、异常和推荐。</p>}
      </aside>
    </div>
  </section>;
}
