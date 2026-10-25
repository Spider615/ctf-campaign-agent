"use client";

import { Loader2, PanelRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { RetryInput } from "../../lib/campaign/ics1811/messages";
import { QUESTION_EXAMPLE } from "../../lib/campaign/ics1811/questions";
import { thinkingLabel } from "../../lib/campaign/ics1811/thinking";
import { isTurnCancelled } from "../../lib/cancellation";
import {
  ApiError,
  fetchSnapshot,
  notifySessionsChanged,
  notifySessionUpdated,
  postTurn,
  postTurnStream,
  SESSION_UPDATED,
  type TurnBody,
} from "../../lib/client/api";
import { appendLiveReply, emptyLiveReply } from "../../lib/client/live-reply";
import { campaignLiveTurn, campaignTurns, newerSnapshot } from "../../lib/client/background-turns";
import { historyConversation } from "../../lib/client/history-conversation";
import { createTurnOwnership, type TurnOwner } from "../../lib/client/turn-ownership";
import { reconcileSubmittedText, turnWasCommitted } from "../../lib/client/turn-result";
import { CAMPAIGN_STAGE_LABEL, DEFAULT_WORKSPACE_TAB } from "../../lib/client/campaign-workspace";
import { PROMO_CONTINUE_PROMPT, PROMO_GENERATION_PROMPT, promoWasGenerated } from "../../lib/client/promo-cta";
import type { Snapshot } from "../../lib/server/turns";
import { mergeTraceEvent, type AgentTraceEvent } from "../../lib/tool-trace";
import { createClientTurnLease } from "../../lib/turn-identity";
import { DraftPanel, type PanelEdit } from "../draft/draft-panel";
import { Composer } from "./composer";
import { AgentRow, MessageList, MessageTimestamp, UserBubble, type AdditionalChatMessage } from "./message-view";
import { MarkdownText } from "./markdown-text";
import { ThinkingIndicator } from "./thinking-indicator";
import { ToolTimeline } from "./tool-timeline";
import type { AttachmentReference } from "../../lib/attachments/types";
import { attachmentSubmission } from "../../lib/client/attachments";
import { conversationRoute } from "../../lib/analytics/intent";
import { useAttachmentDraft } from "../attachments/use-attachments";
import { useAttachmentChat } from "../attachments/use-attachment-chat";
import { HistoryMessageView } from "../analytics/history-message";

type TurnKind = TurnBody["type"];

const PLACEHOLDER: Record<Snapshot["flow"]["phase"], string> = {
  interpreting: "Agent 正在理解你的需求…",
  collecting: "接着说说这个活动",
  blocked: "说说上面的问题怎么处理",
  ready: "哪里要改直接说，例如：改成每克减 20 元",
  out_of_scope: "说说这次活动的优惠方式，例如：黄金每克减 15 元",
};

// 收集中时输入框提示跟着 Agent 上一句走：有提议就提示点头即可，问了什么就给那个问题的回答示例，
// 不要给一个和眼前问题不相干的固定例子。
function collectingPlaceholder(flow: Snapshot["flow"]): string {
  if (flow.proposals.length) return "同意就回「行」，要改直接说";
  const example = flow.asking.map((gap) => QUESTION_EXAMPLE[gap.id]).find(Boolean);
  return example ? `直接回答就行，例如：${example}` : PLACEHOLDER.collecting;
}

// 只有这两种回合会调模型、需要等待；其余由代码直接处理，不显示等待文案。
const WAITING_KINDS: readonly TurnKind[] = ["interpret", "text"];

const XL = "(min-width: 1280px)";
const SHEET_PANEL_ID = "sheet";
const LAYOUT_KEY = "ics1811-panel-layout";
const EMPTY_ADDITIONAL_MESSAGES: readonly AdditionalChatMessage[] = [];
const NO_TRACE: AgentTraceEvent[] = [];
const EMPTY_LIVE_REPLY = emptyLiveReply();

// 宽度自己存。不能用库的 useDefaultLayout / usePanelRef：它们是裸 hook，会在 RSC/SSR 渲染
// 这个组件时执行，打到空的 React dispatcher，整个会话页 500（已用二分确认）。
// 库的「组件」是客户端引用没问题，出事的只有 hook，所以这里一律用 React 自带的。
function readLayout(): Record<string, number> | undefined {
  try {
    const raw = window.localStorage.getItem(LAYOUT_KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : undefined;
  } catch {
    return undefined;
  }
}

function saveLayout(layout: Record<string, number>): void {
  // 收起态不写进记忆。页面一加载，Group 就会按 defaultSize=0 算出「面板宽 0」并触发这个回调，
  // 在用户还没碰任何东西之前把上次拖出来的宽度抹成 0，下次展开就只能回到 minSize。
  if (!layout[SHEET_PANEL_ID]) return;
  try {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // 隐私模式下写不了就算了，宽度记不住不影响用。
  }
}

export function Conversation({ sessionId, extraMessages = EMPTY_ADDITIONAL_MESSAGES, onExternalText, externalBusy = false, onExternalStop, onBusyChange, autoOpenPanel = true, composerMaxLength = 1000, attachmentConversationId }: {
  sessionId: string; extraMessages?: readonly AdditionalChatMessage[]; onExternalText?: (text: string, snapshot: Snapshot, attachments?: AttachmentReference[]) => boolean;
  externalBusy?: boolean; onExternalStop?: () => void; onBusyChange?: (busy: boolean) => void; autoOpenPanel?: boolean; composerMaxLength?: number;
  attachmentConversationId?: string;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing" | "legacy" | "error">("loading");
  const [interpretationStopped, setInterpretationStopped] = useState(false);
  const [inFlightTurn] = useState(() => createTurnOwnership(sessionId));
  const [turnLease] = useState(createClientTurnLease);
  // 渲染时就更换代次，关闭会话切换到 Effect 清理之间的旧闭包窗口。
  const sessionOwner = inFlightTurn.visit(sessionId);
  // 进行中的回合登记在模块里（background-turns.ts），不随组件卸载中止：切走后接着跑完落库，切回来接着看实时进度。
  const liveTurn = useSyncExternalStore(campaignTurns.subscribe, () => campaignTurns.get(sessionId), () => undefined);
  const busy: TurnKind | null = liveTurn?.state.kind ?? null;
  const stopping = liveTurn?.state.stopping ?? false;
  const pendingText = liveTurn?.state.pendingText ?? null;
  const pendingAt = liveTurn?.state.pendingAt ?? null;
  const liveTrace: AgentTraceEvent[] = liveTurn?.state.trace ?? NO_TRACE;
  const liveReply = liveTurn?.state.reply ?? EMPTY_LIVE_REPLY;
  const livePhase = liveTurn?.state.phase ?? null;
  const runStartedAt = liveTurn?.state.startedAt ?? null;
  const autoStarted = useRef<string | null>(null);
  const [input, setInput] = useState("");
  const attachments = useAttachmentDraft(attachmentConversationId ?? sessionId);
  const fileChat = useAttachmentChat(sessionId);
  const displayedExtraMessages = onExternalText ? extraMessages : [...extraMessages, ...fileChat.messages.map((message) => ({ id: message.id, role: message.role, createdAt: message.createdAt, afterMessageId: message.afterMessageId, content: <HistoryMessageView message={message} busy={fileChat.busy || busy !== null} onRetry={fileChat.retry} onFileDeleted={fileChat.deleted} /> }))];
  const submittedTextTurn = useRef(0);
  const [error, setError] = useState("");
  const [stoppedTrace, setStoppedTrace] = useState<{ steps: AgentTraceEvent[]; durationMs: number } | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState(DEFAULT_WORKSPACE_TAB);
  // 面板收起时把手也要收起来，否则对话右边挂着一条没有来由的竖线。
  // 这个库不写任何表示折叠的 data-* 属性（只有 data-panel / data-separator），所以只能自己记。
  const [panelCollapsed, setPanelCollapsed] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  // 宽屏下的填写值面板：默认收起，靠这个把手拉开、合上；宽度由库存进 localStorage。
  const sheetPanel = useRef<PanelImperativeHandle | null>(null);

  const stateOf = (caught: unknown) => (caught instanceof ApiError && caught.status === 404 ? "missing" : caught instanceof ApiError && caught.status === 410 ? "legacy" : "error");

  const stopGeneration = useCallback(() => {
    const current = campaignTurns.get(sessionId);
    if (!current || current.controller.signal.aborted) return;
    // 只在当前页面保留停止时已收到的真实过程，不改活动事实、取消请求或落库合同。
    setStoppedTrace({ steps: current.state.trace, durationMs: Math.max(0, Date.now() - (current.state.startedAt ?? Date.now())) });
    // 停止后登记保留到请求自己收尾，期间仍算忙，免得新回合和正在取消的回合抢同一个版本号。
    campaignTurns.abort(sessionId, {
      keep: true,
      change: (state) => ({ ...state, stopping: true, pendingText: null, pendingAt: null, trace: [], reply: emptyLiveReply(), phase: null, startedAt: null }),
    });
    if (current.state.kind === "interpret") setInterpretationStopped(true);
  }, [sessionId]);

  useEffect(() => {
    inFlightTurn.activate(sessionOwner);
    autoStarted.current = null;
    // 路由用 key={id} 隔离会话，界面状态由新实例的 useState 初始值重置。
    // 卸载（切到别的会话）不中止进行中的回合，只让这个实例不再改界面。
    return () => {
      inFlightTurn.deactivate(sessionOwner);
    };
  }, [inFlightTurn, sessionOwner]);

  const load = useCallback(async (turn?: TurnOwner): Promise<Snapshot | null> => {
    const owner = turn ?? sessionOwner;
    try {
      return await inFlightTurn.readCurrent(owner, () => fetchSnapshot(owner.sessionId, turn?.signal), (next) => {
        setSnapshot(next);
        if (next.flow.pendingInterpretation === false) setInterpretationStopped(false);
        setLoadState("ready");
      });
    } catch (caught) {
      if (inFlightTurn.isCurrent(owner)) setLoadState(stateOf(caught));
      return null;
    }
  }, [inFlightTurn, sessionOwner]);

  useEffect(() => {
    let cancelled = false;
    fetchSnapshot(sessionId)
      .then((next) => {
        if (cancelled || !inFlightTurn.ownsSession(sessionOwner)) return;
        // 后台回合可能在这次读取期间落库并推来更新的快照，不能被这次较早的读取盖回去。
        setSnapshot((current) => newerSnapshot(current, next));
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (!cancelled && inFlightTurn.ownsSession(sessionOwner)) setLoadState(stateOf(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [inFlightTurn, sessionId, sessionOwner]);

  useEffect(() => {
    const onUpdate = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (!detail || detail === sessionId) void load();
    };
    window.addEventListener(SESSION_UPDATED, onUpdate);
    return () => window.removeEventListener(SESSION_UPDATED, onUpdate);
  }, [load, sessionId]);

  const messageCount = snapshot?.messages.length ?? 0;
  useEffect(() => {
    // 等卡片完成布局再滚到底，否则首次打开时最后一张卡会被截在视口外。
    const frame = requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: "end" }));
    return () => cancelAnimationFrame(frame);
  }, [messageCount, busy, liveTrace.length, liveReply.text, loadState, extraMessages, fileChat.messages]);

  const send = async (body: TurnBody): Promise<{ snapshot: Snapshot; committed: boolean } | null> => {
    if (!inFlightTurn.ownsSession(sessionOwner) || !snapshot || snapshot.session.id !== sessionId || campaignTurns.has(sessionId) || externalBusy) return null;
    const streams = WAITING_KINDS.includes(body.type);
    const requestSessionId = sessionId;
    const controller = new AbortController();
    const turn = inFlightTurn.begin(sessionOwner, streams ? controller.signal : undefined);
    if (!turn) return null;
    const entry = campaignTurns.begin(requestSessionId, campaignLiveTurn(body.type, streams, body.type === "text" ? body.text : undefined), controller);
    if (!entry) {
      inFlightTurn.finish(turn);
      return null;
    }
    const clientTurnId = turnLease.acquire(body);
    // 界面归属：这个组件实例还开着同一个会话。实时进度不看它，只看登记有没有被停止或替换。
    const ownsUi = () => inFlightTurn.ownsTurn(turn);
    const live = () => campaignTurns.isLive(requestSessionId, entry.token);
    const patch = (change: Parameters<typeof campaignTurns.patch>[2]) => {
      if (live()) campaignTurns.patch(requestSessionId, entry.token, change);
    };
    onBusyChange?.(true);
    setError("");
    setStoppedTrace(null);
    try {
      const payload = { ...body, expectedSeq: snapshot.latest.seq, clientTurnId };
      const next = streams
        ? await postTurnStream(requestSessionId, payload, {
            onTrace: (event) => patch((state) => ({ ...state, trace: mergeTraceEvent(state.trace, event) })),
            onPhase: (phase) => patch((state) => ({ ...state, phase })),
            onTextDelta: (delta) => {
              const arrivedAt = new Date().toISOString();
              patch((state) => ({ ...state, reply: appendLiveReply(state.reply, delta, arrivedAt) }));
            },
            onTextReset: () => patch((state) => ({ ...state, reply: emptyLiveReply() })),
          }, controller.signal)
        : await postTurn(requestSessionId, payload);
      turnLease.complete(clientTurnId);
      if (controller.signal.aborted) return null;
      notifySessionsChanged();
      if (!ownsUi()) {
        // 用户已经切走：结果已落库，通知可能已切回来的新界面重新读取，并在侧栏标未读。
        notifySessionUpdated(requestSessionId); historyConversation.markCampaignUnread(requestSessionId);
        return null;
      }
      setSnapshot(next);
      if (next.flow.pendingInterpretation === false) setInterpretationStopped(false);
      return {
        snapshot: next,
        committed: turnWasCommitted(next, clientTurnId, body.type === "text" ? body.text : undefined),
      };
    } catch (caught) {
      if (isTurnCancelled(caught) || controller.signal.aborted) {
        if (ownsUi() && body.type === "interpret") setInterpretationStopped(true);
        return null;
      }
      if (!ownsUi()) {
        // 不在场时失败：Agent 失败会落一条可重试的消息，让切回来的界面读到它。
        notifySessionUpdated(requestSessionId); historyConversation.markCampaignUnread(requestSessionId);
        return null;
      }
      if (caught instanceof ApiError && caught.status === 409) {
        const reconciled = await load(turn);
        if (reconciled) turnLease.complete(clientTurnId);
        return reconciled ? {
          snapshot: reconciled,
          committed: turnWasCommitted(reconciled, clientTurnId, body.type === "text" ? body.text : undefined),
        } : null;
      }
      setError(caught instanceof Error ? caught.message : "没保存成功，可以重试");
      return null;
    } finally {
      campaignTurns.end(requestSessionId, entry.token);
      if (inFlightTurn.finish(turn)) onBusyChange?.(false);
    }
  };

  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });

  // 刚建好的会话只有用户那句话：进入对话页后自动开始理解，期间显示思考动画。
  const needsInterpretation = Boolean(
    !interpretationStopped && snapshot?.session.id === sessionId && snapshot.flow.pendingInterpretation &&
    !snapshot.messages.some((message) => message.role === "assistant"),
  );
  useEffect(() => { onBusyChange?.(busy !== null || needsInterpretation || fileChat.busy); }, [busy, needsInterpretation, onBusyChange, fileChat.busy]);
  const retryInterpretation = () => {
    if (!inFlightTurn.ownsSession(sessionOwner)) return;
    autoStarted.current = null;
    setInterpretationStopped(false);
  };
  useEffect(() => {
    if (!needsInterpretation) return;
    const timer = window.setTimeout(() => {
      if (autoStarted.current === sessionId) return;
      autoStarted.current = sessionId;
      void sendRef.current({ type: "interpret" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [needsInterpretation, sessionId]);

  // 展开时把上次拖到的宽度还原回来；没有记录就用三栏布局下舒适的默认宽度。
  // resize() 按 CSS 尺寸字符串解析，传裸数字会被算成 0 像素、把面板直接塌回收起，
  // 表现就是「点了没反应」（展开又立刻塌回）。所以这里必须带上百分号。
  const expandPanel = useCallback(() => {
    // 先读再展开：expand() 会同步触发 onLayoutChange，把记忆里的宽度覆盖成刚展开的 minSize，
    // 读写顺序反了就永远只能回到 minSize。
    const saved = readLayout()?.[SHEET_PANEL_ID];
    const target = saved ? Math.min(44, Math.max(30, saved)) : 34;
    sheetPanel.current?.expand();
    sheetPanel.current?.resize(`${target}%`);
  }, []);

  // 桌面端默认就是三栏工作台；平板和手机仍然只在用户点「填写值」后打开抽屉。
  useEffect(() => {
    if (!autoOpenPanel || loadState !== "ready" || !window.matchMedia(XL).matches) return;
    const frame = window.requestAnimationFrame(expandPanel);
    return () => window.cancelAnimationFrame(frame);
  }, [autoOpenPanel, expandPanel, loadState, sessionId]);

  // 宽屏拉开右侧面板，窄屏改用抽屉；对话始终是主体，面板要用的时候才出现。
  const openPanel = (tab: string) => {
    setPanelTab(tab);
    if (window.matchMedia(XL).matches) expandPanel();
    else setPanelOpen(true);
  };

  // 从填写值跳回说这句话的那条消息。窄屏上面板是浮层，得先关掉，否则滚过去也被盖住。
  const showSource = (messageId: string) => {
    if (!window.matchMedia(XL).matches) setPanelOpen(false);
    window.requestAnimationFrame(() => {
      const node = document.getElementById(`msg-${messageId}`);
      if (!node) return;
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.classList.add("ring-2", "ring-[#247cff]");
      window.setTimeout(() => node.classList.remove("ring-2", "ring-[#247cff]"), 1600);
    });
  };

  const togglePanel = () => {
    if (!window.matchMedia(XL).matches) {
      setPanelOpen(true);
      return;
    }
    if (sheetPanel.current?.isCollapsed()) expandPanel();
    else sheetPanel.current?.collapse();
  };

  if (loadState === "loading" || (loadState === "ready" && snapshot && snapshot.session.id !== sessionId)) {
    return (
      <div className="grid h-[var(--workspace-h,calc(100dvh-4rem))] place-items-center text-sm text-[#6d829d] md:h-[var(--workspace-h,100vh)]">
        <span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在打开活动…</span>
      </div>
    );
  }

  if (loadState !== "ready" || !snapshot) {
    const title = loadState === "missing" ? "找不到这个活动" : loadState === "legacy" ? "这个活动是旧版本创建的" : "活动暂时打不开";
    return (
      <div className="grid h-[var(--workspace-h,calc(100dvh-4rem))] place-items-center px-4 text-center md:h-[var(--workspace-h,100vh)]">
        <div>
          <p className="text-lg font-semibold text-[#20314d]">{title}</p>
          <div className="mt-4 flex justify-center gap-2">
            {loadState === "error" ? <Button variant="outline" onClick={() => void load()}>重试</Button> : null}
            <Button asChild className="bg-[#247cff] text-white hover:bg-[#176bea]"><Link href="/">新建活动</Link></Button>
          </div>
        </div>
      </div>
    );
  }

  const { flow } = snapshot;
  const pendingInterpretation = flow.pendingInterpretation;
  const placeholder = interpretationStopped
    ? "已停止理解，可以继续补充，或点「继续理解」"
    : pendingInterpretation && !needsInterpretation && busy !== "interpret"
      ? "没理解成功，点上面的「重试」"
      : flow.phase === "collecting" ? collectingPlaceholder(flow) : PLACEHOLDER[flow.phase];

  // 等待时说清系统拿这句话要做什么，别只说「正在思考」。
  const waitingKind = busy && WAITING_KINDS.includes(busy) ? busy : needsInterpretation ? "interpret" : null;
  const waiting = waitingKind
    ? pendingText === PROMO_GENERATION_PROMPT || pendingText === PROMO_CONTINUE_PROMPT
      ? "正在加载传播规则并起草分渠道方案…"
      : thinkingLabel({
          turnKind: waitingKind as "interpret" | "text",
          phase: flow.phase,
          asking: flow.asking.map((gap) => gap.id),
          hasProposals: flow.proposals.length > 0,
        })
    : undefined;

  const actions = {
    busy: busy !== null || externalBusy,
    onUndo: (versionSeq: number) => void send({ type: "undo", versionSeq }),
    onRetry: (retry: RetryInput) => void send(retry.type === "text" ? { type: "text", text: retry.text } : { type: "interpret" }),
    onOpenPanel: openPanel,
    onGeneratePromo: () => {
      void send({ type: "text", text: PROMO_GENERATION_PROMPT }).then((result) => {
        if (promoWasGenerated(result?.snapshot ?? null)) openPanel("communications");
      });
    },
  };

  const panel = (
    <DraftPanel
      snapshot={snapshot}
      busy={busy !== null || externalBusy}
      tab={panelTab}
      onTabChange={setPanelTab}
      onEdit={async (edit: PanelEdit) => Boolean((await send({ type: "edit", origin: "panel", ...edit }))?.snapshot)}
      onDismiss={(noteId) => void send({ type: "dismiss", noteId })}
      onRollback={(seq) => void send({ type: "rollback", seq })}
      onShowSource={showSource}
      onGenerateCommunication={actions.onGeneratePromo}
      onContinueCommunication={() => {
        void send({ type: "text", text: PROMO_CONTINUE_PROMPT }).then((result) => {
          if (promoWasGenerated(result?.snapshot ?? null)) openPanel("communications");
        });
      }}
    />
  );

  const conversation = (
    <section data-testid="chat" className="flex h-full min-w-0 flex-1 flex-col bg-white/22">
      <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-[#d9e7f6] bg-white/72 px-4 shadow-[0_6px_22px_rgba(49,93,143,0.04)] backdrop-blur-xl md:px-6">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[#20314d]">{snapshot.latest.campaign.brief.name?.value ?? snapshot.latest.fill?.info.name.value ?? snapshot.session.title}</p>
          <p className="mt-0.5 text-[12px] text-[#7187a1]">
            {CAMPAIGN_STAGE_LABEL[snapshot.workspace.stage]}
            {pendingInterpretation || !snapshot.latest.fill ? "" : ` · 1811 ${snapshot.latest.fill.details.length} 条明细`}
            {flow.phase === "collecting" && flow.missing.length ? ` · 还差 ${flow.missing.length} 项` : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-11 border-[#cfe0f2] bg-white/80 text-[#49647f] shadow-[0_4px_14px_rgba(44,94,148,0.05)] hover:border-[#94bfff] hover:bg-[#f4f9ff] hover:text-[#247cff]" onClick={togglePanel}>
          <PanelRight />
          活动工作台
        </Button>
      </header>

      {/* relative 不能省：滚动区得是绝对定位后代的包含块。否则思考圆点的读屏文字（sr-only）逃出裁剪，
          整页被撑到对话内容那么高，滚轮滚到底会把整个工作台滚出视口。 */}
      <div className="relative min-h-0 flex-1 overflow-y-auto px-4 py-7 md:px-8">
        <div className="mx-auto flex max-w-[780px] flex-col gap-5">
          <MessageList snapshot={snapshot} actions={actions} extraMessages={displayedExtraMessages} />
          {pendingText ? (
            <div className="cursor-text select-text">
              <UserBubble text={pendingText} />
              {pendingAt ? <div className="mt-1 flex min-h-7 items-center justify-end"><MessageTimestamp iso={pendingAt} /></div> : null}
            </div>
          ) : null}
          {!stopping && liveTrace.length ? (
            <AgentRow>
              <ToolTimeline steps={liveTrace} live startedAt={runStartedAt} context="campaign" />
            </AgentRow>
          ) : null}
          {stoppedTrace ? (
            <AgentRow>
              <ToolTimeline steps={stoppedTrace.steps} live={false} status="cancelled" durationMs={stoppedTrace.durationMs} context="campaign" />
            </AgentRow>
          ) : null}
          {!stopping && liveReply.text ? (
            <AgentRow continued={liveTrace.length > 0}>
              <div aria-live="polite"><MarkdownText text={liveReply.text} /></div>
              {liveReply.startedAt ? <MessageTimestamp iso={liveReply.startedAt} /> : null}
            </AgentRow>
          ) : null}
          {!stopping && !liveReply.text && waiting ? (
            <ThinkingIndicator continued={liveTrace.length > 0} label={livePhase === "writing" ? "正在组织回复…" : waiting} />
          ) : null}
          <div ref={endRef} />
        </div>
      </div>

      <div className="shrink-0 border-t border-[#dce9f6] bg-[linear-gradient(180deg,rgba(238,246,255,.55),rgba(244,249,255,.96))] px-4 py-3 backdrop-blur-xl md:px-8">
        <div className="mx-auto max-w-[780px]">
          {error ? <p role="alert" className="mb-2 rounded-xl border border-[#f2c8c3] bg-[#fff4f2] px-3 py-2 text-[13px] text-[#a43f37]">{error}</p> : null}
          {interpretationStopped ? (
            <div role="status" className="mb-2 flex items-center justify-between gap-2 px-3 text-[13px] text-[#59718d]">
              <span>已停止理解，你可以继续补充，或继续理解</span>
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={retryInterpretation}>继续理解</Button>
            </div>
          ) : null}
          <Composer
            value={input}
            onChange={setInput}
            busy={busy !== null || externalBusy || fileChat.busy || (pendingInterpretation && !interpretationStopped)}
            attachments={attachments}
            maxLength={composerMaxLength}
            stoppable={externalBusy || fileChat.busy || Boolean(busy && WAITING_KINDS.includes(busy))}
            stopping={stopping}
            onStop={externalBusy ? onExternalStop : fileChat.busy ? fileChat.stop : stopGeneration}
            placeholder={placeholder}
            onSubmit={() => {
              if (!inFlightTurn.ownsSession(sessionOwner)) return;
              if (attachments.files.length && !attachments.ready) return;
              const files = attachments.references();
              const text = files.length ? attachmentSubmission(input, files).question : input.trim().slice(0, 1000);
              if (!text) return;
              if (snapshot && onExternalText?.(text, snapshot, files)) { setInput(""); attachments.clear(); return; }
              if (snapshot && !onExternalText && (files.length || fileChat.hasFiles && conversationRoute(text, true, true) === "analysis" && !/(?:不要|不用|无需).*?(?:文件|附件|资料)/.test(text))) { fileChat.send(text, files, snapshot); setInput(""); attachments.clear(); return; }
              const textTurn = ++submittedTextTurn.current;
              setInput("");
              void send({ type: "text", text }).then((result) => {
                setInput((current) => reconcileSubmittedText(current, text, {
                  committed: result?.committed ?? false,
                  current: submittedTextTurn.current === textTurn && inFlightTurn.ownsSession(sessionOwner),
                }));
              });
            }}
          />
        </div>
      </div>
    </section>
  );

  return (
    <div className="h-[var(--workspace-h,calc(100dvh-4rem))] md:h-[var(--workspace-h,100vh)]">
      <ResizablePanelGroup orientation="horizontal" onLayoutChange={saveLayout}>
        <ResizablePanel id="chat" minSize="30%" className="min-w-0">
          {conversation}
        </ResizablePanel>
        {panelCollapsed ? null : <ResizableHandle withHandle className="hidden bg-[#d4e4f4] xl:flex" />}
        <ResizablePanel
          id={SHEET_PANEL_ID}
          collapsible
          collapsedSize={0}
          defaultSize={0}
          minSize="30%"
          maxSize="44%"
          panelRef={sheetPanel}
          onResize={(size) => setPanelCollapsed(size.asPercentage === 0)}
          className="hidden bg-white/78 backdrop-blur-xl xl:block"
        >
          {panel}
        </ResizablePanel>
      </ResizablePanelGroup>

      <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
        <SheetContent side="right" className="w-full gap-0 border-l-[#d9e7f6] bg-[#f8fbff] p-0 sm:max-w-[440px]">
          <SheetHeader className="sr-only">
            <SheetTitle>活动工作台</SheetTitle>
            <SheetDescription>随对话实时更新的 Brief、执行轨、上线检查、传播方案和 1811 产物</SheetDescription>
          </SheetHeader>
          {panel}
        </SheetContent>
      </Sheet>
    </div>
  );
}
