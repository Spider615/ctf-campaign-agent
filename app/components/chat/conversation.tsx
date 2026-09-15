"use client";

import { Loader2, PanelRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { RetryInput } from "../../lib/campaign/ics1811/messages";
import {
  ApiError,
  fetchSnapshot,
  notifySessionsChanged,
  postTurn,
  SESSION_UPDATED,
  type TurnBody,
} from "../../lib/client/api";
import type { Snapshot } from "../../lib/server/turns";
import { DraftPanel, PHASE_LABEL, type PanelEdit } from "../draft/draft-panel";
import { Composer } from "./composer";
import { MessageList, UserBubble } from "./message-view";
import { ThinkingIndicator } from "./thinking-indicator";

type TurnKind = TurnBody["type"];

const THINKING_LABEL: Partial<Record<TurnKind, string>> = {
  interpret: "正在理解你的需求",
  text: "正在思考",
  confirm: "正在生成填写值",
};

const PLACEHOLDER: Record<Snapshot["flow"]["phase"], string> = {
  interpreting: "Agent 正在理解你的需求…",
  asking: "直接回复上面的问题，例如：10月1日到7日，没有让扣点和回款率",
  readback: "有不对的地方直接说，例如：改成每克减 20 元",
  blocked: "把仍缺的项直接告诉我，例如：提成按实际售价算",
  confirmed: "还想改哪里直接说，改完会重新复述",
  out_of_scope: "说说这次活动的优惠方式，例如：黄金每克减 15 元",
};

export function Conversation({ sessionId }: { sessionId: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing" | "legacy" | "error">("loading");
  const [busy, setBusy] = useState<TurnKind | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState("sheet");
  const endRef = useRef<HTMLDivElement>(null);

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
  }, [messageCount, busy, loadState]);

  const send = async (body: TurnBody): Promise<boolean> => {
    if (!snapshot || busy) return false;
    setBusy(body.type);
    setError("");
    if (body.type === "text") setPendingText(body.text);
    try {
      const next = await postTurn(sessionId, { ...body, expectedSeq: snapshot.latest.seq });
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

  const openPanel = (tab: string) => {
    setPanelTab(tab);
    if (!window.matchMedia("(min-width: 1280px)").matches) setPanelOpen(true);
  };

  if (loadState === "loading") {
    return (
      <div className="grid h-[calc(100dvh-4rem)] place-items-center text-sm text-[#8a7d80] md:h-screen">
        <span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在打开活动…</span>
      </div>
    );
  }

  if (loadState !== "ready" || !snapshot) {
    const title = loadState === "missing" ? "找不到这个活动" : loadState === "legacy" ? "这个活动是旧版本创建的" : "活动暂时打不开";
    return (
      <div className="grid h-[calc(100dvh-4rem)] place-items-center px-4 text-center md:h-screen">
        <div>
          <p className="text-lg font-semibold text-[#35262a]">{title}</p>
          <div className="mt-4 flex justify-center gap-2">
            {loadState === "error" ? <Button variant="outline" onClick={() => void load()}>重试</Button> : null}
            <Button asChild className="bg-[#651427] text-white hover:bg-[#791a30]"><Link href="/">新建活动</Link></Button>
          </div>
        </div>
      </div>
    );
  }

  const { flow } = snapshot;
  const pendingInterpretation = flow.pendingInterpretation;
  const placeholder = pendingInterpretation && !needsInterpretation && busy !== "interpret" ? "没理解成功，点上面的「重试」" : PLACEHOLDER[flow.phase];
  const thinkingLabel = busy ? THINKING_LABEL[busy] : needsInterpretation ? THINKING_LABEL.interpret : undefined;

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
    />
  );

  return (
    <div className="flex h-[calc(100dvh-4rem)] md:h-screen">
      <section data-testid="chat" className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[#ded5cb] bg-[#fffdfa]/85 px-4 backdrop-blur md:px-6">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[#35262a]">{snapshot.latest.draft.facts.offer ? snapshot.latest.fill.info.name.value : snapshot.session.title}</p>
            <p className="text-[12px] text-[#8a7d80]">
              {PHASE_LABEL[flow.phase]}
              {pendingInterpretation ? "" : ` · ${snapshot.latest.fill.details.length} 条明细`}
              {!pendingInterpretation && flow.missing.length ? ` · 还差 ${flow.missing.length} 项` : ""}
            </p>
          </div>
          <Button variant="outline" size="sm" className="bg-white xl:hidden" onClick={() => setPanelOpen(true)}>
            <PanelRight />
            填写值
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8">
          <div className="mx-auto flex max-w-[760px] flex-col gap-5">
            <MessageList snapshot={snapshot} actions={actions} />
            {pendingText ? <UserBubble text={pendingText} /> : null}
            {thinkingLabel ? <ThinkingIndicator label={thinkingLabel} /> : null}
            <div ref={endRef} />
          </div>
        </div>

        <div className="shrink-0 border-t border-[#ece5dc] bg-[#f7f3ed]/90 px-4 py-3 md:px-8">
          <div className="mx-auto max-w-[760px]">
            {error ? <p role="alert" className="mb-2 rounded-lg bg-[#fff0eb] px-3 py-2 text-[13px] text-[#983523]">{error}</p> : null}
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

      <aside className="hidden w-[420px] shrink-0 border-l border-[#ded5cb] bg-[#fffdfa] xl:block">{panel}</aside>

      <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
        <SheetContent side="right" className="w-full gap-0 bg-[#fffdfa] p-0 sm:max-w-[440px]">
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
