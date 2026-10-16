"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChartNoAxesCombined, Lightbulb, MessageCircle } from "lucide-react";
import { analyticsRequest } from "../../lib/client/analytics";
import type { DatabaseExplainRequest } from "../../lib/analytics/database";
import { conversationRoute } from "../../lib/analytics/intent";
import { historyConversation, historyMessageContext, mergeConversationTimeline, type HistoryMessage } from "../../lib/client/history-conversation";
import { postHistoryStream } from "../../lib/client/history-stream";
import { reduceVisualizationProgress } from "../../lib/analytics/visualization-progress";
import { analyticsAnswerText } from "../../lib/analytics/stream";
import { createSessionRequest, notifySessionsChanged } from "../../lib/client/api";
import { mergeTraceEvent } from "../../lib/tool-trace";
import type { Snapshot } from "../../lib/server/turns";
import { messageToText } from "../../lib/campaign/ics1811/messages";
import { Composer } from "../chat/composer";
import { Conversation } from "../chat/conversation";
import { UserBubble } from "../chat/message-view";
import { ThinkingIndicator } from "../chat/thinking-indicator";
import { HistoryMessageView } from "./history-message";
import { WorkspacePanel } from "../workspace/workspace-panel";
import type { AttachmentReference, ConversationRequest } from "../../lib/attachments/types";
import { attachmentReferences, attachmentSubmission, postAttachmentStream, UnavailableAttachmentsError } from "../../lib/client/attachments";
import { useAttachmentDraft } from "../attachments/use-attachments";
import { useAttachmentAvailability } from "../attachments/use-attachment-availability";

const prompts = [
  { title: "审视优惠方案", text: "帮我看看这档优惠方案，哪里还能改进？", icon: MessageCircle },
  { title: "寻找营销机会", text: "从历史活动中找出值得尝试的新营销机会", icon: Lightbulb },
  { title: "复盘活动表现", text: "哪些区域和门店的活动表现值得重点关注？", icon: ChartNoAxesCombined },
];
const now = () => performance.now();
const noCampaign = () => null;

export function HistoryConversation() {
  const id = useSyncExternalStore(historyConversation.subscribe, historyConversation.activeId, historyConversation.serverActiveId);
  return <WorkspacePanel key={id || "loading"}><UnifiedConversation conversationId={id} /></WorkspacePanel>;
}

function UnifiedConversation({ conversationId }: { conversationId: string }) {
  const messages = useSyncExternalStore(historyConversation.subscribe, historyConversation.snapshot, historyConversation.serverSnapshot);
  const campaignId = useSyncExternalStore(historyConversation.subscribe, historyConversation.campaignId, noCampaign);
  const setMessages = (change: (messages: HistoryMessage[]) => HistoryMessage[]) => historyConversation.update(change, conversationId);
  const [input, setInput] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [executionBusy, setExecutionBusy] = useState(false); const executionLock = useRef(false);
  const executionBusyChanged = useCallback((value: boolean) => { executionLock.current = value; setExecutionBusy(value); }, []);
  const [pendingCreation, setPendingCreation] = useState<string | null>(null);
  const attachments = useAttachmentDraft(conversationId);
  const markUnavailable = useCallback((ids: string[]) => historyConversation.update((items) => items.map((message) => ({ ...message, ...(message.attachments ? { attachments: message.attachments.map((file) => ids.includes(file.id) ? { ...file, unavailable: true } : file) } : {}) })), conversationId), [conversationId]);
  useAttachmentAvailability(conversationId, messages, markUnavailable);
  const active = useRef<{ controller: AbortController; replyId?: string; clock: number } | null>(null);
  const end = useRef<HTMLDivElement>(null); const followBottom = useRef(true);
  useEffect(() => () => { active.current?.controller.abort(); historyConversation.update((items) => items.map((m) => m.status === "running" ? { ...m, status: "cancelled", text: "上次等待已结束，可以继续追问或重新分析。" } : m), conversationId); }, [conversationId]);
  const last = messages.at(-1);
  useEffect(() => { if (last && followBottom.current) end.current?.scrollIntoView({ block: "end" }); }, [last]);
  const owns = (controller: AbortController) => active.current?.controller === controller && !controller.signal.aborted && historyConversation.activeId() === conversationId;

  const perform = async (request: DatabaseExplainRequest | ConversationRequest, replyId: string) => {
    if (active.current || executionLock.current || historyConversation.activeId() !== conversationId) return;
    const controller = new AbortController(); const clock = now(); active.current = { controller, replyId, clock }; setBusy(true); setError("");
    setMessages((items) => items.map((m) => m.id === replyId ? { ...m, status: "running", text: "", answer: undefined, visualizationState: undefined, trace: [], phase: "analyzing", startedAt: Date.now(), durationMs: undefined } : m));
    try {
      await analyticsRequest("/api/analytics/access", undefined, controller.signal);
      const progress: Parameters<typeof postHistoryStream>[1] = (event) => {
        if (!owns(controller)) return;
        setMessages((items) => items.map((m) => m.id !== replyId ? m : event.type === "trace" ? { ...m, trace: mergeTraceEvent(m.trace ?? [], event.event) } : event.type === "visualization" ? { ...m, visualizationState: reduceVisualizationProgress(m.visualizationState, event) } : { ...m, phase: event.phase }));
      };
      const explanation = "attachmentIds" in request ? await postAttachmentStream(request, progress, controller.signal) : await postHistoryStream(request, progress, controller.signal);
      if (owns(controller)) setMessages((items) => items.map((m) => m.id === replyId ? { ...m, status: "done", answer: explanation, visualizationState: undefined, createdAt: new Date().toISOString(), durationMs: now() - clock,
        text: analyticsAnswerText(explanation) } : m));
    } catch (caught) {
      if (caught instanceof UnavailableAttachmentsError) markUnavailable(caught.ids);
      const detail = caught instanceof Error ? caught.message : "本次回答暂未完成，可以重试";
      const text = /数据库|连接|视图|字段映射|访问标识/.test(detail) ? "这次回答暂时无法完成，你的问题已保留，可以稍后重试。" : detail;
      if (owns(controller)) setMessages((items) => items.map((m) => m.id === replyId ? { ...m, status: "failed", text, durationMs: now() - clock } : m));
    } finally { if (active.current?.controller === controller) { active.current = null; setBusy(false); } }
  };
  const analyze = (text: string, snapshot?: Snapshot, newAttachments: AttachmentReference[] = []) => {
    if (active.current || busy || executionLock.current || historyConversation.activeId() !== conversationId) return;
    const question = text.trim().slice(0, 500); if (!question) return;
    const createdAt = new Date().toISOString(); const replyId = crypto.randomUUID(); const afterMessageId = snapshot?.messages.at(-1)?.id;
    const timeline = mergeConversationTimeline(snapshot?.messages ?? [], messages);
    const history = timeline.map((entry) => ({ role: entry.message.role,
      text: entry.kind === "campaign" ? `当前活动草案对话，不能当作历史活动数据：${messageToText(entry.message.content)}` : historyMessageContext(entry.message) })).slice(-10).map((m) => ({ ...m, text: m.text.trim().slice(0, 4000) }));
    const recentContext = timeline.flatMap((entry) => entry.kind === "campaign" ? entry.message.content.kind === "user_text" ? [entry.message.content.text.slice(0, 500)] : [] : entry.message.role === "user" ? [entry.message.text.slice(0, 500)] : []);
    const refs = [...new Map([...attachmentReferences(messages), ...newAttachments].map((file) => [file.id, file])).values()];
    const ignoreFiles = /(?:不要|不用|无需)(?:再)?(?:参考|使用|结合|看)(?:上传的|这些|之前的)?(?:文件|附件|资料)/.test(question) && !newAttachments.length;
    const context = [...new Set([...historyConversation.context(), ...recentContext])].slice(-200);
    const request: DatabaseExplainRequest | ConversationRequest = refs.length && !ignoreFiles ? { conversationId, question, history, context, attachmentIds: refs.map((file) => file.id) } : { mode: "database", question, history, context };
    followBottom.current = true;
    setMessages((items) => [...items, { id: crypto.randomUUID(), role: "user", text: question, createdAt, afterMessageId, ...(newAttachments.length ? { attachments: newAttachments } : {}) }, { id: replyId, role: "assistant", text: "", status: "running", request, createdAt, afterMessageId, ...(refs.length ? { attachments: refs } : {}) }]);
    void perform(request, replyId);
  };
  const createCampaign = async (text: string) => {
    if (active.current || busy || historyConversation.activeId() !== conversationId) return;
    const controller = new AbortController(); active.current = { controller, clock: now() }; setBusy(true); setError(""); setPendingCreation(text);
    try {
      // 只传本次明确执行的用户原话，分析建议及历史参数不能反写成执行事实。
      const snapshot = await createSessionRequest({ entryMode: "new", text }, controller.signal);
      if (owns(controller)) { historyConversation.bindCampaign(snapshot.session.id, text, conversationId); notifySessionsChanged(); }
    } catch (caught) {
      if (owns(controller)) { setError(caught instanceof Error ? caught.message : "这次活动暂未准备好，可以重试"); setInput((current) => current || text); }
    } finally { if (active.current?.controller === controller) { active.current = null; setPendingCreation(null); setBusy(false); } }
  };
  const send = () => {
    if (active.current || busy || (!input.trim() && !attachments.ready) || attachments.files.length && !attachments.ready) return;
    const selected = attachments.references(); const { question: text } = attachmentSubmission(input, selected); setInput("");
    if (selected.length) { analyze(text, undefined, selected); attachments.clear(); }
    else if (conversationRoute(text) === "execution") void createCampaign(text); else analyze(text);
  };
  const stop = () => {
    const turn = active.current; if (!turn) return;
    turn.controller.abort(); active.current = null; setBusy(false);
    if (turn.replyId) setMessages((items) => items.map((m) => m.id === turn.replyId ? { ...m, status: "cancelled", text: "已停止本次回答，你可以继续追问。", durationMs: now() - turn.clock } : m));
    else { setInput((current) => current || pendingCreation || ""); setPendingCreation(null); }
  };
  const retry = (message: HistoryMessage) => { if (message.request) { followBottom.current = true; void perform(message.request, message.id); } };
  const fileDeleted = (id: string) => setMessages((items) => items.map((message) => ({ ...message, ...(message.attachments ? { attachments: message.attachments.map((file) => file.id === id ? { ...file, deleted: true } : file) } : {}) })));

  if (campaignId) return <Conversation sessionId={campaignId} attachmentConversationId={conversationId} autoOpenPanel={false} composerMaxLength={500} externalBusy={busy} onExternalStop={stop} onBusyChange={executionBusyChanged}
    extraMessages={messages.map((message) => ({ id: message.id, role: message.role, createdAt: message.createdAt, afterMessageId: message.afterMessageId, content: <HistoryMessageView message={message} busy={busy || executionBusy} onRetry={retry} onFileDeleted={fileDeleted} /> }))}
    onExternalText={(text, snapshot, files = []) => {
      const analysisWasLast = messages.length > 0 && messages.at(-1)?.afterMessageId === snapshot.messages.at(-1)?.id;
      if (!files.length && conversationRoute(text, true, analysisWasLast) !== "analysis") return false;
      analyze(text, snapshot, files); return true;
    }} />;

  return <section className="flex h-[calc(100dvh-4rem)] min-w-0 flex-col md:h-screen">
    <header className="flex min-h-[76px] shrink-0 items-center border-b border-[#dbe8f7] bg-white/55 px-5 py-4 backdrop-blur-md md:px-8">
      <div><h1 className="text-[15px] font-semibold text-[#17243d]">小福 · 营销顾问</h1><p className="mt-0.5 text-[12px] text-[#7187a1]">从历史数据出发，一起找到值得行动的营销机会</p></div>
    </header>
    <div className="relative min-h-0 flex-1 overflow-y-auto px-4 py-7 md:px-8" onScroll={(event) => { const node = event.currentTarget; followBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }}>
      <div className="mx-auto flex max-w-[780px] flex-col gap-5">
        {!messages.length && !pendingCreation ? <div className="pb-4 pt-[7vh] md:pt-[10vh]">
          <p className="text-sm font-medium text-[var(--brand-ruby)]">你的营销顾问，小福</p>
          <h2 className="mt-3 text-balance text-2xl font-semibold tracking-tight text-[#20314d] md:text-3xl">今天想解决什么营销问题？</h2>
          <p className="mt-3 text-[15px] leading-7 text-[#7187a1]">聊活动复盘、优惠方案，或直接告诉我想做什么活动。</p>
          <div className="mt-7 grid gap-3 sm:grid-cols-3">{prompts.map(({ title, text, icon: Icon }) => <button key={title} type="button" onClick={() => setInput(text)} className="min-h-24 rounded-2xl border border-[#d4e4f5] bg-white/80 px-4 py-4 text-left shadow-[0_8px_24px_rgba(43,94,151,0.04)] transition hover:border-[#a8caff] hover:bg-[#f5f9ff] focus-visible:ring-2 focus-visible:ring-ring"><span className="flex items-center gap-2 text-sm font-semibold text-[#27415f]"><Icon aria-hidden="true" className="size-4 text-[#247cff]" />{title}</span><span className="mt-2 block text-xs leading-5 text-[#7187a1]">{text}</span></button>)}</div>
        </div> : null}
        <div aria-label="营销对话" className="space-y-5">{messages.map((message) => <HistoryMessageView key={message.id} message={message} busy={busy} onRetry={retry} onFileDeleted={fileDeleted} />)}</div>
        {pendingCreation ? <><UserBubble text={pendingCreation} /><ThinkingIndicator label="正在衔接活动准备" /></> : null}
        <div ref={end} />
      </div>
    </div>
    <div className="shrink-0 border-t border-[#dce9f6] bg-[linear-gradient(180deg,rgba(238,246,255,.55),rgba(244,249,255,.96))] px-4 py-3 backdrop-blur-xl md:px-8">
      <div className="mx-auto max-w-[780px]">
        {error ? <p role="alert" className="mb-2 rounded-xl border border-[#f2c8c3] bg-[#fff4f2] px-3 py-2 text-sm text-[#a43f37]">{error}</p> : null}
        <Composer value={input} onChange={setInput} onSubmit={send} onStop={stop} busy={busy} stoppable={busy} attachments={attachments} maxLength={500} placeholder={messages.length ? "继续追问，也可以上传更多资料…" : "说说你的问题，或上传文件一起分析…"} />
        {!messages.length ? <p className="mt-2 text-center text-[11px] leading-5 text-[#8397af]">有数据支持的回答，可点角标查看依据。</p> : null}
      </div>
    </div>
  </section>;
}
