"use client";

import { Loader2, PanelRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { missingFields, TYPING_HINT, type TopicId } from "../../lib/campaign/topics";
import {
  ApiError,
  fetchSnapshot,
  notifySessionsChanged,
  postTurn,
  SESSION_UPDATED,
  type TurnBody,
} from "../../lib/client/api";
import type { Snapshot } from "../../lib/server/turns";
import { DraftPanel } from "../draft/draft-panel";
import { Composer } from "./composer";
import { MessageList, UserBubble } from "./message-view";
import { ThinkingIndicator } from "./thinking-indicator";

const STATUS_LABEL: Record<string, string> = { collecting: "收集中", ready: "待生成", generated: "已生成" };

type TurnKind = TurnBody["type"];

const THINKING_LABEL: Partial<Record<TurnKind, string>> = {
  interpret: "正在理解你的需求",
  text: "正在思考",
  clarify_submit: "正在根据补充信息生成方案",
  generate: "正在生成方案",
};

export function Conversation({ sessionId }: { sessionId: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [busy, setBusy] = useState<TurnKind | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState("fields");
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchSnapshot(sessionId);
      setSnapshot(next);
      setLoadState("ready");
    } catch (caught) {
      setLoadState(caught instanceof ApiError && caught.status === 404 ? "missing" : "error");
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
        if (!cancelled) setLoadState(caught instanceof ApiError && caught.status === 404 ? "missing" : "error");
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
  const needsInterpretation = Boolean(snapshot?.plan.pendingInterpretation && !snapshot.messages.some((message) => message.role === "assistant"));
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

  if (loadState === "missing" || loadState === "error" || !snapshot) {
    return (
      <div className="grid h-[calc(100dvh-4rem)] place-items-center px-4 text-center md:h-screen">
        <div>
          <p className="text-lg font-semibold text-[#35262a]">{loadState === "missing" ? "找不到这个活动" : "活动暂时打不开"}</p>
          <div className="mt-4 flex justify-center gap-2">
            {loadState === "error" ? <Button variant="outline" onClick={() => void load()}>重试</Button> : null}
            <Button asChild className="bg-[#651427] text-white hover:bg-[#791a30]"><Link href="/">新建活动</Link></Button>
          </div>
        </div>
      </div>
    );
  }

  const draft = snapshot.latest.draft;
  const pendingInterpretation = snapshot.plan.pendingInterpretation;
  const placeholder = pendingInterpretation
    ? needsInterpretation || busy === "interpret" ? "Agent 正在理解你的需求…" : "没理解成功，点上面的「重试」"
    : snapshot.plan.openClarifyId
      ? "也可以直接打字补充，例如：10 月 1 日到 7 日，全国线下黄金满 5000 减 500"
      : draft.brief.externalName
        ? TYPING_HINT.brief
        : "继续说说这次活动…";
  const missingCount = missingFields(draft).length;
  const thinkingLabel = busy ? THINKING_LABEL[busy] : needsInterpretation ? THINKING_LABEL.interpret : undefined;

  const actions = {
    busy: busy !== null,
    onAnswer: (topic: TopicId, values: Record<string, unknown>) => void send({ type: "answer", topic, values, origin: "chat" }),
    onClarifySubmit: (answers: Record<string, unknown>) => void send({ type: "clarify_submit", answers }),
    onGenerate: () => void send({ type: "generate" }),
    onUndo: (versionSeq: number) => void send({ type: "undo", versionSeq }),
    onRetry: (retry: { type: "text"; text: string } | { type: "generate" } | { type: "interpret" }) =>
      void send(retry.type === "text" ? { type: "text", text: retry.text } : retry.type === "interpret" ? { type: "interpret" } : { type: "generate" }),
    onOpenPanel: openPanel,
  };

  const panel = (
    <DraftPanel
      snapshot={snapshot}
      busy={busy !== null}
      tab={panelTab}
      onTabChange={setPanelTab}
      onAnswer={(topic, values) => send({ type: "answer", topic, values, origin: "panel" })}
      onRollback={(seq) => void send({ type: "rollback", seq })}
    />
  );

  return (
    <div className="flex h-[calc(100dvh-4rem)] md:h-screen">
      <section data-testid="chat" className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[#ded5cb] bg-[#fffdfa]/85 px-4 backdrop-blur md:px-6">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[#35262a]">{draft.brief.externalName || snapshot.session.title}</p>
            <p className="text-[12px] text-[#8a7d80]">
              {pendingInterpretation ? "理解中" : STATUS_LABEL[snapshot.session.status] ?? snapshot.session.status}
              {pendingInterpretation ? "" : snapshot.session.noIcs ? " · 不建 ICS 单" : ` · ${snapshot.latest.orders.length} 条 ICS 单`}
              {!pendingInterpretation && missingCount ? ` · 还差 ${missingCount} 项` : ""}
            </p>
          </div>
          <Button variant="outline" size="sm" className="bg-white xl:hidden" onClick={() => setPanelOpen(true)}>
            <PanelRight />
            草稿
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

      <aside className="hidden w-[400px] shrink-0 border-l border-[#ded5cb] bg-[#fffdfa] xl:block">{panel}</aside>

      <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
        <SheetContent side="right" className="w-full gap-0 bg-[#fffdfa] p-0 sm:max-w-[420px]">
          <SheetHeader className="sr-only">
            <SheetTitle>活动草稿</SheetTitle>
            <SheetDescription>随对话实时更新的结构化草稿</SheetDescription>
          </SheetHeader>
          {panel}
        </SheetContent>
      </Sheet>
    </div>
  );
}
