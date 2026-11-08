"use client";

import { BarChart3, Coins, Package, Sparkles } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { analyticsRequest } from "../../lib/client/analytics";
import { focusOf, type InsightFocus } from "../../lib/insight/context";
import { selectionInGraph, type InsightSelection } from "../../lib/insight/paths";
import { isFullRange, rangeLabel, rangeSearch, type InsightRange } from "../../lib/insight/range";
import type { InsightGraph, InsightNodeId } from "../../lib/insight/types";
import { InsightChat } from "./insight-chat";
import { InsightGraphView, InsightLegend } from "./insight-graph-view";
import { InsightRangePicker } from "./insight-range-picker";
import { InsightSidePanel } from "./insight-side-panel";

// 图谱只有一张；选中的节点、连线、来源筛选写进 URL，刷新和从问答回来都还在。
export function InsightWorkspace({ selection, onSelect, range, onRange, onAskQa }: {
  selection: InsightSelection | null; onSelect: (selection: InsightSelection | null) => void;
  range: InsightRange | null; onRange: (range: InsightRange | null) => void;
  onAskQa: (question: string, focus: InsightFocus | null) => void;
}) {
  const [graph, setGraph] = useState<InsightGraph | null>(null);
  // 出错时记下请求的是哪个范围：整页报错只对当前请求有效；换范围失败后报错里写明失败的范围，重试就再请求它。
  const [error, setError] = useState<{ search: string; range: InsightRange | null; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [marked, setMarked] = useState<InsightNodeId[]>([]);
  const [panel, setPanel] = useState<"detail" | "chat">("detail");
  // search 是 URL 里请求的范围，shown 是正在显示的图的范围；两者不同就是正在算（换范围、前进后退、点重试都一样），
  // 不另存 loading，也就不会因为 URL 没变而卡在「正在算」。URL 写了整段数据起止时和全部同等看待（Agent 也当作全部）。
  const search = graph && range && isFullRange(range, graph.scope.dataFrom, graph.scope.dataTo) ? "" : rangeSearch(range);
  const shown = graph ? rangeSearch(graph.scope.range) : null;
  const loading = shown !== null && search !== shown;

  // 失败次数只用来在换范围失败时让范围控件重新挂载、回到旧图的范围；开始新的切换清掉报错时不重新挂载，用户刚选的项不丢。
  const [failures, setFailures] = useState(0);
  const settle = useEffectEvent((result: InsightGraph) => {
    setGraph(result); setError(null); setMarked([]);
    if (selection && !selectionInGraph(result, selection)) { onSelect(null); setPanel("detail"); }
  });
  // 有旧图时换范围失败：URL 退回旧图的范围（不重新请求，见下面 effect 的跳过条件），报错写明失败的范围；没有旧图就整页报错。
  const fail = useEffectEvent((message: string) => {
    setFailures((n) => n + 1);
    setError({ search, range, message: range ? `${rangeLabel(range)}：${message}` : message });
    if (graph) onRange(graph.scope.range);
  });
  // 换范围时保留旧图、顶部提示正在算；第一次算一个新范围要扫全表，之后命中缓存。请求的就是正在显示的范围时不请求。
  useEffect(() => {
    if (shown !== null && search === shown) return;
    const controller = new AbortController();
    analyticsRequest<InsightGraph>(`/api/analytics/insight${search ? `?${search}` : ""}`, undefined, controller.signal)
      .then((result) => { if (!controller.signal.aborted) settle(result); })
      .catch((caught) => { if (!controller.signal.aborted) fail(caught instanceof Error ? caught.message : "洞察图谱暂时算不出来"); });
    return () => controller.abort();
  }, [attempt, search, shown]);
  // 选的就是当前请求的范围时不改 URL，免得白白清掉选中；开始换范围就清掉上一次的报错。
  const changeRange = (next: InsightRange | null) => { if (rangeSearch(next) === search) return; setError(null); onRange(next); };

  const choose = (next: InsightSelection | null) => { setMarked([]); onSelect(next); if (next) setPanel("detail"); };
  const ask = (question = "") => onAskQa(question, graph ? focusOf(graph, selection) : null);

  // 第一次打开就失败（比如链接里的范围太短或越界）：除了重试，URL 带范围时还能直接改看全部。
  if (!graph && error && error.search === search) return <div className="p-4 md:p-6"><div role="alert" className="rounded-xl border border-[#f2c8c3] bg-[#fff4f2] p-4 text-sm text-[#a43f37]">{error.message}
    <button type="button" onClick={() => { setError(null); setAttempt((n) => n + 1); }} className="ml-3 min-h-10 underline">重试</button>
    {range ? <button type="button" onClick={() => changeRange(null)} className="ml-3 min-h-10 underline">改看全部</button> : null}</div></div>;
  if (!graph) return <div role="status" className="m-4 grid min-h-[420px] place-items-center rounded-2xl border border-dashed border-[#c9d8ea] bg-white/60 p-6 text-center md:m-6">
    <div><span className="mx-auto block size-8 animate-spin rounded-full border-2 border-[#c7ddff] border-t-[#247cff] motion-reduce:animate-none" />
      <p className="mt-4 text-sm font-medium text-[#27415f]">正在从销售明细里算影响因素</p>
      <p className="mt-1 text-[12px] text-[#7187a1]">只在第一次或数据更新后要算，约 2 分钟；之后打开直接出图</p></div>
  </div>;

  const selected = selectionInGraph(graph, selection);

  const tab = (id: "detail" | "chat", label: string) => <button type="button" role="tab" id={`insight-tab-${id}`} aria-selected={panel === id} aria-controls={`insight-panel-${id}`} onClick={() => setPanel(id)}
    className={`min-h-8 flex-1 rounded-lg px-3 text-[12.5px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${panel === id ? "bg-white text-[#0f172a] shadow-[0_1px_3px_rgba(15,23,42,0.1)]" : "text-[#64748b] hover:text-[#0f172a]"}`}>{label}</button>;
  const card = "rounded-2xl border border-[#e4eaf2] bg-white/95 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_32px_-16px_rgba(15,23,42,0.12)] backdrop-blur";
  const KPI_ICON = { sales: BarChart3, gp: Coins, qty: Package } as const;

  // 一屏放下：指标卡在上，下面左图右栏，各自在框内滚动，页面本身不滚。窄屏（< 1180px）退回整页滚动、上下排。
  // relative：滚动区里的绝对定位元素（如输入框的读屏标签）以这里为基准，不撑高整页。
  return <section aria-label="深度剖析" className={`relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 md:px-6 ${graph.comparison ? "" : "min-[1180px]:overflow-hidden"}`}>
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      {/* key：图换了范围、或换范围失败退回时，控件按当前图的范围重置。 */}
      <InsightRangePicker key={`${shown}|${failures}`} graph={graph} range={graph.scope.range} onChange={changeRange} />
      {loading ? <span role="status" className="inline-flex items-center gap-1.5 text-[12px] text-[#64748b]"><span className="size-3 animate-spin rounded-full border-2 border-[#c7ddff] border-t-[#247cff] motion-reduce:animate-none" />正在算这段时间的影响因素，第一次约 1 分钟</span> : null}
      {/* 换范围失败后 URL 已退回当前图的范围；重试再请求失败的那个范围。正在算新范围时不显示旧的报错。 */}
      {error && !loading ? <span role="alert" className="text-[12px] text-[#a43f37]">{error.message}<button type="button" onClick={() => changeRange(error.range)} className="ml-2 underline">重试</button></span> : null}
      {graph.scope.range && !loading ? <span className="text-[12px] text-[#64748b]">{graph.scope.period} · {graph.scope.stores.toLocaleString("zh-CN")} 家店{graph.scope.overlap ? <> · <span className="text-[#a16207]">{graph.scope.overlap}</span></> : null}</span> : null}
    </div>

    <div className="grid shrink-0 gap-3 sm:grid-cols-3">
      {graph.kpis.map((k) => { const Icon = KPI_ICON[k.id];
        return <button key={k.id} type="button" onClick={() => choose({ kind: "node", id: k.id })} aria-pressed={selected?.kind === "node" && selected.id === k.id}
          className={`${card} group flex items-center gap-3.5 px-4 py-3 text-left transition hover:border-[#bcd0ff] focus-visible:border-[#2f6bff] focus-visible:outline-none aria-pressed:border-[#2f6bff] aria-pressed:ring-[3px] aria-pressed:ring-[#2f6bff]/15`}>
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[linear-gradient(135deg,#eef3ff,#dfe8ff)] text-[#2f6bff] ring-1 ring-inset ring-[#d6e2ff]"><Icon aria-hidden="true" className="size-5" /></span>
          <span className="min-w-0">
            <span className="flex items-baseline gap-2"><span className="text-[12.5px] font-medium text-[#64748b]">{k.label}</span>
              <span className="text-[26px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-[#0f172a]">{k.value}<small className="ml-0.5 text-[13px] font-medium tracking-normal text-[#94a3b8]">{k.unit}</small></span></span>
            <span className="mt-1 block text-[12px] tabular-nums text-[#64748b]">{k.detail}</span>
            {k.comparison ? <span className="mt-1.5 block space-y-0.5 border-t border-[#eef2f7] pt-1.5 text-[11.5px] tabular-nums text-[#64748b]">
              <span className="block"><b className="mr-1 font-medium text-[#334155]">可比样本</b>本期 {k.comparison.current} / 对照 {k.comparison.baseline}</span>
              <span className="block text-[#1d4ed8]">差额 {k.comparison.delta}{k.comparison.rate === null ? " · 不计算变化率" : ` · ${k.comparison.rate}`}</span>
            </span> : null}
          </span>
        </button>; })}
    </div>

    <div className={`grid gap-3 min-[1180px]:grid-cols-[minmax(0,1fr)_minmax(320px,30%)] ${graph.comparison ? "shrink-0 min-[1180px]:h-[540px]" : "min-[1180px]:min-h-0 min-[1180px]:flex-1"}`}>
      <section aria-label={graph.comparison?.title ?? "影响因素图谱"} className={`${card} flex min-w-0 flex-col pb-2 pl-4 pr-2 pt-3 min-[1180px]:min-h-0`}>
        <div className="mb-2 flex items-center gap-2 pr-2">
          <Sparkles aria-hidden="true" className="size-4 text-[#2f6bff]" />
          <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-[#0f172a]">{graph.comparison?.title ?? "指标影响因素图谱"}</h2>
          <span className="rounded-full bg-[#f1f5f9] px-2 py-0.5 text-[11px] text-[#64748b]">{graph.scope.period} · {graph.scope.stores.toLocaleString("zh-CN")} 家店</span>
        </div>
        <InsightLegend graph={graph} selection={selected} onSelect={choose} />
        <InsightGraphView key={`${graph.datasetVersion}|${shown}`} graph={graph} selection={selected} marked={marked} onSelect={choose} />
      </section>

      <aside aria-label="洞察详情" className={`${card} flex min-w-0 flex-col overflow-hidden min-[1180px]:min-h-0`}>
        <div role="tablist" aria-label="右栏" className="m-3 mb-0 flex shrink-0 rounded-xl bg-[#f1f5f9] p-1">{tab("detail", "详情")}{tab("chat", "问这张图")}</div>
        <div id="insight-panel-detail" role="tabpanel" aria-labelledby="insight-tab-detail" hidden={panel !== "detail"} aria-live="polite" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-3.5 text-sm leading-relaxed text-[#0f172a]">
          <InsightSidePanel graph={graph} selection={selected} onSelect={choose} onAsk={() => ask()} />
        </div>
        {/* 问答一直挂着，切到详情再回来，对话还在。 */}
        <div id="insight-panel-chat" role="tabpanel" aria-labelledby="insight-tab-chat" hidden={panel !== "chat"} className="min-h-0 flex-1 flex-col p-3 data-[on=true]:flex" data-on={panel === "chat"}>
          <InsightChat key={rangeSearch(graph.scope.range)} graph={graph} selection={selected} range={graph.scope.range} onSelect={choose} onHighlight={setMarked} onAskQa={ask} fill />
        </div>
      </aside>
    </div>
  </section>;
}
