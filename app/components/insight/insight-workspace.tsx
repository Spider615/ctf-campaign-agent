"use client";

import { BarChart3, Coins, Package, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { analyticsRequest } from "../../lib/client/analytics";
import { focusOf, type InsightFocus } from "../../lib/insight/context";
import type { InsightSelection } from "../../lib/insight/paths";
import type { InsightGraph, InsightNodeId } from "../../lib/insight/types";
import { InsightChat } from "./insight-chat";
import { InsightGraphView, InsightLegend } from "./insight-graph-view";
import { InsightSidePanel } from "./insight-side-panel";

// 图谱只有一张；选中的节点、连线、来源筛选写进 URL，刷新和从问答回来都还在。
export function InsightWorkspace({ selection, onSelect, onAskQa }: {
  selection: InsightSelection | null; onSelect: (selection: InsightSelection | null) => void;
  onAskQa: (question: string, focus: InsightFocus | null) => void;
}) {
  const [graph, setGraph] = useState<InsightGraph | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [marked, setMarked] = useState<InsightNodeId[]>([]);
  const [panel, setPanel] = useState<"detail" | "chat">("detail");

  useEffect(() => {
    const controller = new AbortController();
    analyticsRequest<InsightGraph>("/api/analytics/insight", undefined, controller.signal)
      .then((result) => { if (!controller.signal.aborted) { setGraph(result); setError(""); } })
      .catch((caught) => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "洞察图谱暂时算不出来"); });
    return () => controller.abort();
  }, [attempt]);

  const choose = (next: InsightSelection | null) => { setMarked([]); onSelect(next); if (next) setPanel("detail"); };
  const ask = (question = "") => onAskQa(question, graph ? focusOf(graph, selection) : null);

  if (error && !graph) return <div className="p-4 md:p-6"><div role="alert" className="rounded-xl border border-[#f2c8c3] bg-[#fff4f2] p-4 text-sm text-[#a43f37]">{error}
    <button type="button" onClick={() => { setError(""); setAttempt((n) => n + 1); }} className="ml-3 min-h-10 underline">重试</button></div></div>;
  if (!graph) return <div role="status" className="m-4 grid min-h-[420px] place-items-center rounded-2xl border border-dashed border-[#c9d8ea] bg-white/60 p-6 text-center md:m-6">
    <div><span className="mx-auto block size-8 animate-spin rounded-full border-2 border-[#c7ddff] border-t-[#247cff] motion-reduce:animate-none" />
      <p className="mt-4 text-sm font-medium text-[#27415f]">正在从销售明细里算影响因素</p>
      <p className="mt-1 text-[12px] text-[#7187a1]">只在第一次或数据更新后要算，约 2 分钟；之后打开直接出图</p></div>
  </div>;

  const tab = (id: "detail" | "chat", label: string) => <button type="button" role="tab" id={`insight-tab-${id}`} aria-selected={panel === id} aria-controls={`insight-panel-${id}`} onClick={() => setPanel(id)}
    className={`min-h-8 flex-1 rounded-lg px-3 text-[12.5px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${panel === id ? "bg-white text-[#0f172a] shadow-[0_1px_3px_rgba(15,23,42,0.1)]" : "text-[#64748b] hover:text-[#0f172a]"}`}>{label}</button>;
  const card = "rounded-2xl border border-[#e4eaf2] bg-white/95 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_32px_-16px_rgba(15,23,42,0.12)] backdrop-blur";
  const KPI_ICON = { sales: BarChart3, gp: Coins, qty: Package } as const;

  // 一屏放下：指标卡在上，下面左图右栏，各自在框内滚动，页面本身不滚。窄屏（< 1180px）退回整页滚动、上下排。
  // relative：滚动区里的绝对定位元素（如输入框的读屏标签）以这里为基准，不撑高整页。
  return <section aria-label="智能洞察" className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 md:px-6 min-[1180px]:overflow-hidden">
    <div className="grid shrink-0 gap-3 sm:grid-cols-3">
      {graph.kpis.map((k) => { const Icon = KPI_ICON[k.id];
        return <button key={k.id} type="button" onClick={() => choose({ kind: "node", id: k.id })} aria-pressed={selection?.kind === "node" && selection.id === k.id}
          className={`${card} group flex items-center gap-3.5 px-4 py-3 text-left transition hover:border-[#bcd0ff] focus-visible:border-[#2f6bff] focus-visible:outline-none aria-pressed:border-[#2f6bff] aria-pressed:ring-[3px] aria-pressed:ring-[#2f6bff]/15`}>
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[linear-gradient(135deg,#eef3ff,#dfe8ff)] text-[#2f6bff] ring-1 ring-inset ring-[#d6e2ff]"><Icon aria-hidden="true" className="size-5" /></span>
          <span className="min-w-0">
            <span className="flex items-baseline gap-2"><span className="text-[12.5px] font-medium text-[#64748b]">{k.label}</span>
              <span className="text-[26px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-[#0f172a]">{k.value}<small className="ml-0.5 text-[13px] font-medium tracking-normal text-[#94a3b8]">{k.unit}</small></span></span>
            <span className="mt-1 block truncate text-[12px] tabular-nums text-[#64748b]">{k.detail}</span>
          </span>
        </button>; })}
    </div>

    <div className="grid gap-3 min-[1180px]:min-h-0 min-[1180px]:flex-1 min-[1180px]:grid-cols-[minmax(0,1fr)_minmax(320px,30%)]">
      <section aria-label="影响因素图谱" className={`${card} flex min-w-0 flex-col pb-2 pl-4 pr-2 pt-3 min-[1180px]:min-h-0`}>
        <div className="mb-2 flex items-center gap-2 pr-2">
          <Sparkles aria-hidden="true" className="size-4 text-[#2f6bff]" />
          <h2 className="text-[14px] font-semibold tracking-[-0.01em] text-[#0f172a]">指标影响因素图谱</h2>
          <span className="rounded-full bg-[#f1f5f9] px-2 py-0.5 text-[11px] text-[#64748b]">{graph.scope.period} · {graph.scope.stores.toLocaleString("zh-CN")} 家店</span>
        </div>
        <InsightLegend graph={graph} selection={selection} onSelect={choose} />
        <InsightGraphView graph={graph} selection={selection} marked={marked} onSelect={choose} />
      </section>

      <aside aria-label="洞察详情" className={`${card} flex min-w-0 flex-col overflow-hidden min-[1180px]:min-h-0`}>
        <div role="tablist" aria-label="右栏" className="m-3 mb-0 flex shrink-0 rounded-xl bg-[#f1f5f9] p-1">{tab("detail", "详情")}{tab("chat", "问这张图")}</div>
        <div id="insight-panel-detail" role="tabpanel" aria-labelledby="insight-tab-detail" hidden={panel !== "detail"} aria-live="polite" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-3.5 text-sm leading-relaxed text-[#0f172a]">
          <InsightSidePanel graph={graph} selection={selection} onSelect={choose} onAsk={() => ask()} />
        </div>
        {/* 问答一直挂着，切到详情再回来，对话还在。 */}
        <div id="insight-panel-chat" role="tabpanel" aria-labelledby="insight-tab-chat" hidden={panel !== "chat"} className="min-h-0 flex-1 flex-col p-3 data-[on=true]:flex" data-on={panel === "chat"}>
          <InsightChat graph={graph} selection={selection} onSelect={choose} onHighlight={setMarked} onAskQa={ask} fill />
        </div>
      </aside>
    </div>
  </section>;
}
