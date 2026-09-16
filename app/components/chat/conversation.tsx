"use client";

import { Loader2, PanelRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { RetryInput } from "../../lib/campaign/ics1811/messages";
import { QUESTION_EXAMPLE } from "../../lib/campaign/ics1811/questions";
import { campaignSteps } from "../../lib/campaign/ics1811/steps";
import { thinkingLabel } from "../../lib/campaign/ics1811/thinking";
import {
  ApiError,
  fetchSnapshot,
  notifySessionsChanged,
  postTurn,
  postTurnStream,
  SESSION_UPDATED,
  type TurnBody,
} from "../../lib/client/api";
import type { Snapshot } from "../../lib/server/turns";
import { mergeTraceEvent, type AgentTraceEvent } from "../../lib/tool-trace";
import { DraftPanel, PHASE_LABEL, type PanelEdit } from "../draft/draft-panel";
import { Composer } from "./composer";
import { AgentRow, MessageList, UserBubble } from "./message-view";
import { StepRail } from "./step-rail";
import { ThinkingIndicator } from "./thinking-indicator";
import { ToolRunCard } from "./tool-run-card";

type TurnKind = TurnBody["type"];

const PLACEHOLDER: Record<Snapshot["flow"]["phase"], string> = {
  interpreting: "Agent 正在理解你的需求…",
  asking: "直接回复上面的问题，例如：10月1日到7日，没有让扣点和回款率",
  readback: "有不对的地方直接说，例如：改成每克减 20 元",
  blocked: "把仍缺的项直接告诉我，例如：提成按实际售价算",
  confirmed: "还想改哪里直接说，改完会重新复述",
  out_of_scope: "说说这次活动的优惠方式，例如：黄金每克减 15 元",
};

// 两轮追问结束后就没有追问卡了，这句提示是用户最后一处能看到「该怎么答」的地方：
// 点名真正缺的项，例子也用这些项的，不要再给一个不相干的固定例子。
function blockedPlaceholder(missingIds: Snapshot["flow"]["missingIds"]): string {
  const examples = missingIds.map((id) => QUESTION_EXAMPLE[id]).filter(Boolean).slice(0, 2);
  return examples.length ? `把仍缺的项直接告诉我，例如：${examples.join("，")}` : PLACEHOLDER.blocked;
}

// 只有这三种回合会调模型、需要等待；其余由代码直接处理，不显示等待文案。
const WAITING_KINDS: readonly TurnKind[] = ["interpret", "text", "confirm"];

const XL = "(min-width: 1280px)";
const SHEET_PANEL_ID = "sheet";
const LAYOUT_KEY = "ics1811-panel-layout";

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

export function Conversation({ sessionId }: { sessionId: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing" | "legacy" | "error">("loading");
  const [busy, setBusy] = useState<TurnKind | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [liveTrace, setLiveTrace] = useState<AgentTraceEvent[]>([]);
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState("sheet");
  // 面板收起时把手也要收起来，否则对话右边挂着一条没有来由的竖线。
  // 这个库不写任何表示折叠的 data-* 属性（只有 data-panel / data-separator），所以只能自己记。
  const [panelCollapsed, setPanelCollapsed] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  // 宽屏下的填写值面板：默认收起，靠这个把手拉开、合上；宽度由库存进 localStorage。
  const sheetPanel = useRef<PanelImperativeHandle | null>(null);

  const stateOf = (caught: unknown) => (caught instanceof ApiError && caught.status === 404 ? "missing" : caught instanceof ApiError && caught.status === 410 ? "legacy" : "error");

  const load = useCallback(async () => {
    try {
      setSnapshot(await fetchSnapshot(sessionId));
      setLoadState("ready");
    } catch (caught) {
      setLoadState(stateOf(caught));
    }
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    fetchSnapshot(sessionId)
      .then((next) => {
        if (cancelled) return;
        setSnapshot(next);
        setLoadState("ready");
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadState(stateOf(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

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
  }, [messageCount, busy, liveTrace.length, loadState]);

  const send = async (body: TurnBody): Promise<boolean> => {
    if (!snapshot || busy) return false;
    setBusy(body.type);
    setError("");
    if (body.type === "text") setPendingText(body.text);
    const streams = WAITING_KINDS.includes(body.type);
    if (streams) {
      setLiveTrace([]);
      setRunStartedAt(Date.now());
    }
    try {
      const payload = { ...body, expectedSeq: snapshot.latest.seq };
      const next = streams
        ? await postTurnStream(sessionId, payload, (event) => setLiveTrace((current) => mergeTraceEvent(current, event)))
        : await postTurn(sessionId, payload);
      setSnapshot(next);
      notifySessionsChanged();
      return true;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) await load();
      setError(caught instanceof Error ? caught.message : "没保存成功，可以重试");
      return false;
    } finally {
      setBusy(null);
      setPendingText(null);
      setLiveTrace([]);
      setRunStartedAt(null);
    }
  };

  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });

  // 刚建好的会话只有用户那句话：进入对话页后自动开始理解，期间显示思考动画。
  const needsInterpretation = Boolean(snapshot?.flow.pendingInterpretation && !snapshot.messages.some((message) => message.role === "assistant"));
  const autoStarted = useRef<string | null>(null);
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
    if (loadState !== "ready" || !window.matchMedia(XL).matches) return;
    const frame = window.requestAnimationFrame(expandPanel);
    return () => window.cancelAnimationFrame(frame);
  }, [expandPanel, loadState, sessionId]);

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

  if (loadState === "loading") {
    return (
      <div className="grid h-[calc(100dvh-4rem)] place-items-center text-sm text-[#6d829d] md:h-screen">
        <span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在打开活动…</span>
      </div>
    );
  }

  if (loadState !== "ready" || !snapshot) {
    const title = loadState === "missing" ? "找不到这个活动" : loadState === "legacy" ? "这个活动是旧版本创建的" : "活动暂时打不开";
    return (
      <div className="grid h-[calc(100dvh-4rem)] place-items-center px-4 text-center md:h-screen">
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
  const placeholder = pendingInterpretation && !needsInterpretation && busy !== "interpret"
    ? "没理解成功，点上面的「重试」"
    : flow.phase === "blocked" ? blockedPlaceholder(flow.missingIds) : PLACEHOLDER[flow.phase];

  // 活动是一步步搭起来的，把「走到哪一步」一直摆在对话上方。
  const steps = campaignSteps({ phase: flow.phase, roundsUsed: flow.roundsUsed, missingCount: flow.missing.length });

  // 等待时说清系统拿这句话要做什么，别只说「正在思考」。
  const waitingKind = busy && WAITING_KINDS.includes(busy) ? busy : needsInterpretation ? "interpret" : null;
  const waiting = waitingKind
    ? thinkingLabel({
        turnKind: waitingKind as "interpret" | "text" | "confirm",
        phase: flow.phase,
        openQuestions: flow.openQuestions.map((gap) => gap.id),
        missingIds: flow.missingIds,
      })
    : undefined;

  const actions = {
    busy: busy !== null,
    onCardSubmit: (answers: Record<string, unknown>) => void send({ type: "card", answers }),
    onConfirm: () => void send({ type: "confirm" }),
    onDismiss: (noteId: string) => void send({ type: "dismiss", noteId }),
    onUndo: (versionSeq: number) => void send({ type: "undo", versionSeq }),
    onRetry: (retry: RetryInput) => void send(retry.type === "text" ? { type: "text", text: retry.text } : { type: "interpret" }),
    onOpenPanel: openPanel,
  };

  const panel = (
    <DraftPanel
      snapshot={snapshot}
      busy={busy !== null}
      tab={panelTab}
      onTabChange={setPanelTab}
      onEdit={(edit: PanelEdit) => send({ type: "edit", origin: "panel", ...edit })}
      onRollback={(seq) => void send({ type: "rollback", seq })}
      onShowSource={showSource}
    />
  );

  const conversation = (
    <section data-testid="chat" className="flex h-full min-w-0 flex-1 flex-col bg-white/22">
      <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-[#d9e7f6] bg-white/72 px-4 shadow-[0_6px_22px_rgba(49,93,143,0.04)] backdrop-blur-xl md:px-6">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[#20314d]">{snapshot.latest.draft.facts.offer ? snapshot.latest.fill.info.name.value : snapshot.session.title}</p>
          <p className="mt-0.5 text-[12px] text-[#7187a1]">
            {PHASE_LABEL[flow.phase]}
            {pendingInterpretation ? "" : ` · ${snapshot.latest.fill.details.length} 条明细`}
            {!pendingInterpretation && flow.missing.length ? ` · 还差 ${flow.missing.length} 项` : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-11 border-[#cfe0f2] bg-white/80 text-[#49647f] shadow-[0_4px_14px_rgba(44,94,148,0.05)] hover:border-[#94bfff] hover:bg-[#f4f9ff] hover:text-[#247cff]" onClick={togglePanel}>
          <PanelRight />
          填写值
        </Button>
      </header>

      <StepRail steps={steps} />

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-7 md:px-8">
        <div className="mx-auto flex max-w-[780px] flex-col gap-5">
          <MessageList snapshot={snapshot} actions={actions} />
          {pendingText ? <UserBubble text={pendingText} /> : null}
          {liveTrace.length ? (
            <AgentRow>
              <ToolRunCard trace={liveTrace} live startedAt={runStartedAt} />
            </AgentRow>
          ) : waiting ? <ThinkingIndicator label={waiting} /> : null}
          <div ref={endRef} />
        </div>
      </div>

      <div className="shrink-0 border-t border-[#dce9f6] bg-[linear-gradient(180deg,rgba(238,246,255,.55),rgba(244,249,255,.96))] px-4 py-3 backdrop-blur-xl md:px-8">
        <div className="mx-auto max-w-[780px]">
          {error ? <p role="alert" className="mb-2 rounded-xl border border-[#f2c8c3] bg-[#fff4f2] px-3 py-2 text-[13px] text-[#a43f37]">{error}</p> : null}
          <Composer
            value={input}
            onChange={setInput}
            busy={busy !== null || pendingInterpretation}
            placeholder={placeholder}
            onSubmit={() => {
              const text = input.trim();
              if (!text) return;
              setInput("");
              void send({ type: "text", text }).then((ok) => {
                if (!ok) setInput(text);
              });
            }}
          />
        </div>
      </div>
    </section>
  );

  return (
    <div className="h-[calc(100dvh-4rem)] md:h-screen">
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
            <SheetTitle>1811 填写值</SheetTitle>
            <SheetDescription>随对话实时更新的 1811 填写值草稿</SheetDescription>
          </SheetHeader>
          {panel}
        </SheetContent>
      </Sheet>
    </div>
  );
}
