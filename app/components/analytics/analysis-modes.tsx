"use client";

import { MessagesSquare, Network } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { historyConversation } from "../../lib/client/history-conversation";
import { parseSelection, selectionSearch, type InsightFocus } from "../../lib/insight/context";
import type { InsightSelection } from "../../lib/insight/paths";
import type { InsightNodeId } from "../../lib/insight/types";
import { InsightWorkspace } from "../insight/insight-workspace";
import { HistoryConversation } from "./history-conversation";

export type AnalysisMode = "insight" | "qa";
const MODES: Array<{ id: AnalysisMode; label: string; icon: typeof Network }> = [
  { id: "insight", label: "智能洞察", icon: Network },
  { id: "qa", label: "智能问答", icon: MessagesSquare },
];
const noMessages = () => false;
const subscribeHydration = () => () => {};

// 模式和洞察选中状态都存在 URL 里：刷新、前进后退都不丢。用外部 store 订阅地址栏，免得在 effect 里同步 state。
const locationListeners = new Set<() => void>();
const subscribeLocation = (listener: () => void) => {
  locationListeners.add(listener); window.addEventListener("popstate", listener);
  return () => { locationListeners.delete(listener); window.removeEventListener("popstate", listener); };
};
const locationSearch = () => window.location.search;
const serverSearch = () => "";
function writeUrl(mode: AnalysisMode, selection: InsightSelection | null) {
  // 问答模式也带上洞察的选中状态，切回洞察时选中的节点、连线还在。
  const rest = selectionSearch(selection);
  const search = `mode=${mode}${rest ? `&${rest}` : ""}`;
  window.history.replaceState(window.history.state, "", `/analysis?${search}`);
  for (const listener of locationListeners) listener();
}

// 洞察和问答共用一个工作台：两边一直挂载，切换只隐藏，选中的连线和输到一半的问题都保留。
export function AnalysisModes() {
  const search = useSyncExternalStore(subscribeLocation, locationSearch, serverSearch);
  const hasMessages = useSyncExternalStore(historyConversation.subscribe, () => historyConversation.snapshot().length > 0, noMessages);
  const hydrated = useSyncExternalStore(subscribeHydration, () => true, () => false);
  const params = new URLSearchParams(search); const urlMode = params.get("mode");
  // URL 没指定模式时：当前对话已有内容进问答，否则进洞察。
  const mode: AnalysisMode = urlMode === "insight" || urlMode === "qa" ? urlMode : hasMessages ? "qa" : "insight";
  const selection = parseSelection(search);
  const [askFocus, setAskFocus] = useState<InsightFocus | null>(null);
  const [draft, setDraft] = useState<{ text: string; nonce: number } | null>(null);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  // 洞察第一次打开才去算图谱；之后一直挂着，切回来不用重算。用渲染期派生 state 记住「看过」，不在 effect 里补。
  const [visitedInsight, setVisitedInsight] = useState(false);
  if (hydrated && mode === "insight" && !visitedInsight) setVisitedInsight(true);
  const nonce = useRef(0);

  const switchTo = (next: AnalysisMode) => writeUrl(next, selection);
  const changeSelection = (next: InsightSelection | null) => writeUrl("insight", next);
  // 从洞察带着范围去问答、去建活动时开一个新对话：不把这次的范围和问题混进最近那条旧对话。
  // 当前对话还是空的就直接用它，不多留一条空对话。
  const freshConversation = () => { if (historyConversation.snapshot().length || historyConversation.campaignId()) historyConversation.newConversation(); };
  const askQa = (question: string, focus: InsightFocus | null) => { freshConversation(); setAskFocus(focus); nonce.current += 1; setDraft({ text: question, nonce: nonce.current }); switchTo("qa"); };
  const locate = (id: InsightNodeId) => writeUrl("insight", { kind: "node", id });

  const keyDown = (event: React.KeyboardEvent, index: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault(); const next = (index + (event.key === "ArrowRight" ? 1 : MODES.length - 1)) % MODES.length;
    switchTo(MODES[next].id); tabs.current[next]?.focus();
  };

  const active = mode;
  return <div className="flex h-[calc(100dvh-4rem)] min-w-0 flex-col md:h-screen">
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#dbe8f7] bg-white/70 px-4 py-2 backdrop-blur-md md:px-6">
      <div role="tablist" aria-label="分析模式" className="inline-flex rounded-xl bg-[#eaf2fb] p-1">
        {MODES.map(({ id, label, icon: Icon }, index) => <button key={id} ref={(node) => { tabs.current[index] = node; }} type="button" role="tab" id={`mode-tab-${id}`} aria-selected={active === id} aria-controls={`mode-panel-${id}`} tabIndex={active === id ? 0 : -1} onClick={() => switchTo(id)} onKeyDown={(e) => keyDown(e, index)}
          className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active === id ? "bg-white text-[#174e96] shadow-[0_2px_8px_rgba(43,94,151,0.12)]" : "text-[#5c7392] hover:text-[#27415f]"}`}>
          <Icon aria-hidden="true" className="size-4" />{label}
        </button>)}
      </div>
      <p className="hidden text-[12px] text-[#7187a1] sm:block">{active === "insight" ? "没想好问什么？先看哪些因素和活动表现有关" : "有具体问题，直接问小福"}</p>
    </div>
    <div id="mode-panel-insight" role="tabpanel" aria-labelledby="mode-tab-insight" hidden={active !== "insight"} className="min-h-0 flex-1 flex-col data-[on=true]:flex" data-on={active === "insight"}>
      {visitedInsight ? <InsightWorkspace selection={selection} onSelect={changeSelection} onAskQa={askQa} /> : null}
    </div>
    <div id="mode-panel-qa" role="tabpanel" aria-labelledby="mode-tab-qa" hidden={active !== "qa"} className="min-h-0 flex-1" style={{ "--workspace-h": "100%" } as React.CSSProperties}>
      <HistoryConversation embedded insightFocus={askFocus} onClearFocus={() => setAskFocus(null)} draft={draft} onLocate={locate} />
    </div>
  </div>;
}
