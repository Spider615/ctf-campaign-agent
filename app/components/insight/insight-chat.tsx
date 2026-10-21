"use client";

import { ArrowUp, MessageCircle, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { analyticsRequest } from "../../lib/client/analytics";
import type { InsightAskResult } from "../../lib/insight/ask";
import { selectionLabel } from "../../lib/insight/context";
import { findNode, type InsightSelection } from "../../lib/insight/paths";
import type { InsightGraph, InsightNodeId } from "../../lib/insight/types";
import { MarkdownText } from "../chat/markdown-text";

type Turn = { id: string; role: "user" | "assistant"; text: string; about: string; selection: InsightSelection | null; highlights?: InsightNodeId[]; status?: "running" | "failed" };

// 针对选中对象的推荐问法：点一下填进输入框。
function suggestions(graph: InsightGraph, selection: InsightSelection | null): string[] {
  if (!selection) return ["影响销售额最大的是哪几个因素？", "活动对毛利有什么影响？", "哪些结论是 AI 判断的，可信吗？"];
  if (selection.kind === "edge") return ["这条线说明了什么？", "这个关联可能有什么别的解释？"];
  if (selection.kind === "source") return ["这些项为什么这样判断？", "哪一项最需要业务确认？"];
  const node = findNode(graph, selection.id);
  if (node?.source.kind === "suggested") return ["为什么需要采集这个数据？", "补上之后能回答什么问题？"];
  if (node?.kind === "metric") return [`${node.label}主要受哪些因素影响？`, "这些因素里哪些是 AI 判断的？"];
  return ["它怎么影响到销售额和毛利？", "这个数据是怎么来的？", "这个结论可能有什么别的解释？"];
}

// fill：放在固定高度的容器里，对话列表占满剩余高度、输入框贴底。
export function InsightChat({ graph, selection, onSelect, onHighlight, onAskQa, fill = false }: {
  graph: InsightGraph; selection: InsightSelection | null; onSelect: (selection: InsightSelection | null) => void;
  onHighlight: (ids: InsightNodeId[]) => void; onAskQa: (question: string) => void; fill?: boolean;
}) {
  const [turns, setTurns] = useState<Turn[]>([]); const [input, setInput] = useState(""); const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null); const list = useRef<HTMLDivElement>(null); const box = useRef<HTMLTextAreaElement>(null);
  const busy = turns.some((t) => t.status === "running");
  const about = selectionLabel(graph, selection);
  // 数据更新、图谱换了一版，旧对话的依据就不是这张图了，清空。
  const graphKey = graph.datasetVersion;
  const [seenKey, setSeenKey] = useState(graphKey);
  if (seenKey !== graphKey) { setSeenKey(graphKey); setTurns([]); setError(""); }
  useEffect(() => () => active.current?.abort(), []);
  // 只滚对话列表自己：scrollIntoView 会连带滚动外层的图和页面。
  useEffect(() => { const node = list.current; if (node) node.scrollTop = node.scrollHeight; }, [turns]);

  const send = async (text = input) => {
    const question = text.trim().slice(0, 500); if (!question || busy) return;
    setInput(""); setError("");
    const history = turns.filter((t) => !t.status).slice(-6).map((t) => ({ role: t.role, text: t.text }));
    const userTurn: Turn = { id: crypto.randomUUID(), role: "user", text: question, about, selection };
    const reply: Turn = { id: crypto.randomUUID(), role: "assistant", text: "", about, selection, status: "running" };
    setTurns((items) => [...items, userTurn, reply]);
    const controller = new AbortController(); active.current = controller;
    try {
      const result = await analyticsRequest<InsightAskResult>("/api/analytics/insight/ask", { question, selection, history }, controller.signal);
      setTurns((items) => items.map((t) => t.id === reply.id ? { ...t, text: result.body, highlights: result.highlights, status: undefined } : t));
      if (result.highlights.length) onHighlight(result.highlights);
    } catch (caught) {
      if (controller.signal.aborted) { setTurns((items) => items.filter((t) => t.id !== reply.id)); return; }
      setTurns((items) => items.map((t) => t.id === reply.id ? { ...t, text: caught instanceof Error ? caught.message : "这次没有得到回答，可以重试", status: "failed" } : t));
    }
  };
  const stop = () => { active.current?.abort(); setInput((v) => v || turns.filter((t) => t.role === "user").at(-1)?.text || ""); };

  return <section aria-label="针对图谱提问" className={`flex flex-col rounded-xl border border-[#c7ddff] bg-white ${fill ? "min-h-0 flex-1" : ""}`}>
    <header className="flex items-center gap-2 border-b border-[#e4edf7] px-3 py-2.5">
      <MessageCircle aria-hidden="true" className="size-4 text-[#247cff]" />
      <h3 className="text-[13px] font-semibold text-[#27415f]">问这张图</h3>
      <span className="ml-auto text-[11px] text-[#8397af]">只依据图上算好的数据回答</span>
    </header>
    {turns.length ? <div ref={list} className={`space-y-3 overflow-y-auto overscroll-contain px-3 py-3 ${fill ? "min-h-0 flex-1" : "max-h-[420px]"}`} aria-live="polite">
      {turns.map((t) => t.role === "user" ? <div key={t.id} className="ml-6 rounded-xl bg-[#eaf4ff] px-3 py-2 text-[13px] text-[#174e96]">
        <button type="button" onClick={() => onSelect(t.selection)} className="mb-0.5 block text-[11px] text-[#5c7392] underline-offset-2 hover:underline" title="回到提问时选中的对象">关于 {t.about}</button>{t.text}
      </div> : <div key={t.id} className="text-[13px] leading-6 text-[#27415f]">
        {t.status === "running" ? <p role="status" className="flex items-center gap-2 text-[#7187a1]"><span className="size-3 animate-spin rounded-full border-2 border-[#c7ddff] border-t-[#247cff] motion-reduce:animate-none" />小福正在读图…</p>
          : t.status === "failed" ? <p role="alert" className="text-[#a43f37]">{t.text}</p>
          : <><MarkdownText text={t.text} />
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
              {t.highlights?.length ? <button type="button" onClick={() => onHighlight(t.highlights!)} className="min-h-8 text-[#2470cc] underline-offset-2 hover:underline">在图上标出相关节点</button> : null}
              <button type="button" onClick={() => onAskQa(turns[turns.indexOf(t) - 1]?.text ?? "")} className="min-h-8 text-[#5c7392] underline-offset-2 hover:underline">去智能问答查更细的数据</button>
            </div></>}
      </div>)}
    </div> : <div className={`px-3 pt-3 ${fill ? "min-h-0 flex-1 overflow-y-auto" : ""}`}>
      <p className="text-[12px] text-[#7187a1]">点图上的节点或连线后提问，小福会针对它回答；不选就是问整张图。</p>
      <div className="mt-2 flex flex-wrap gap-1.5">{suggestions(graph, selection).map((q) => <button key={q} type="button" onClick={() => { setInput(q); box.current?.focus(); }} className="min-h-8 rounded-lg border border-[#d4e4f5] bg-[#f8fbff] px-2.5 text-left text-[12px] text-[#27415f] hover:border-[#a8caff]">{q}</button>)}</div>
    </div>}
    <div className="shrink-0 p-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="inline-flex min-h-7 max-w-full items-center gap-1 rounded-full border border-[#c7ddff] bg-[#eef5ff] py-0.5 pl-2.5 pr-1 text-[11px] text-[#174e96]">
          <span className="truncate">针对：{about}</span>
          {selection ? <button type="button" aria-label="改为问整张图" onClick={() => onSelect(null)} className="grid size-6 shrink-0 place-items-center rounded-full hover:bg-[#dbe9ff]"><X aria-hidden="true" className="size-3" /></button> : null}
        </span>
      </div>
      {error ? <p role="alert" className="mb-1.5 text-[12px] text-[#a43f37]">{error}</p> : null}
      <div className="flex items-end gap-2 rounded-xl border border-[#d4e4f5] bg-white p-1.5 focus-within:border-[#7ea7dc]">
        <label htmlFor="insight-chat-input" className="sr-only">针对图谱提问</label>
        <textarea id="insight-chat-input" ref={box} rows={2} maxLength={500} value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
          placeholder="比如：为什么大区之间差别不大？" className="min-h-11 flex-1 resize-none bg-transparent px-1.5 py-1 text-[13px] outline-none placeholder:text-[#9aabbf]" />
        {busy ? <button type="button" aria-label="停止" onClick={stop} className="grid size-10 shrink-0 place-items-center rounded-lg bg-[#5c7392] text-white"><Square aria-hidden="true" className="size-3.5" /></button>
          : <button type="button" aria-label="发送" disabled={!input.trim()} onClick={() => void send()} className="grid size-10 shrink-0 place-items-center rounded-lg bg-[#247cff] text-white disabled:bg-[#b7c7da]"><ArrowUp aria-hidden="true" className="size-4" /></button>}
      </div>
    </div>
  </section>;
}
