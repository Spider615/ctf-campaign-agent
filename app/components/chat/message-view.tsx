"use client";

import { FileSpreadsheet, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { messageToText, type ChatMessage, type RetryInput } from "../../lib/campaign/ics1811/messages";
import type { Snapshot } from "../../lib/server/turns";
import { ClarifyCard } from "./clarify-card";
import { CopyButton } from "./copy-button";
import { ReadbackCard } from "./readback-card";

export type MessageActions = {
  busy: boolean;
  onCardSubmit: (answers: Record<string, unknown>) => void;
  onConfirm: () => void;
  onDismiss: (noteId: string) => void;
  onUndo: (versionSeq: number) => void;
  onRetry: (retry: RetryInput) => void;
  onOpenPanel: (tab: string) => void;
};

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-[#651427] px-4 py-2.5 text-[15px] leading-6 text-white">{text}</div>
    </div>
  );
}

// 连着几条 Agent 消息只在第一条显示头像，读起来像一段话。
export function AgentRow({ children, continued = false }: { children: React.ReactNode; continued?: boolean }) {
  return (
    <div className="flex gap-3">
      {continued ? (
        <span className="w-8 shrink-0" />
      ) : (
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full border border-[#d5c3ad] bg-[#f2e6d5] text-sm font-semibold text-[#651427]">周</span>
      )}
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

function EventLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center">
      <span className="max-w-[90%] rounded-full bg-[#efe8df] px-3 py-1 text-center text-[12px] text-[#7d6f72]">{children}</span>
    </div>
  );
}

function Card({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "alert" | "dark" }) {
  const toneClass = { plain: "border-[#e1d6ca] bg-[#fffdfa]", alert: "border-[#efc8bb] bg-[#fff4ef]", dark: "border-[#5a1a29] bg-[#3f101c] text-white" }[tone];
  return <div className={`rounded-2xl border p-4 ${toneClass}`}>{children}</div>;
}

function MessageItem({ message, snapshot, actions, isLastAgent, continued }: { message: ChatMessage; snapshot: Snapshot; actions: MessageActions; isLastAgent: boolean; continued: boolean }) {
  const content = message.content;
  switch (content.kind) {
    case "user_text":
    case "user_card_submit":
      return <UserBubble text={content.kind === "user_text" ? content.text : content.label} />;
    case "user_edit":
      return <EventLine>{content.origin === "panel" ? "你在草稿里改了" : "工具改了"}：{content.label}</EventLine>;
    case "user_event":
      return <EventLine>{content.label}</EventLine>;
    case "agent_text":
      return (
        <AgentRow continued={continued}>
          <p className="whitespace-pre-wrap pt-1 text-[15px] leading-7 text-[#35262a]">{content.text}</p>
        </AgentRow>
      );
    case "agent_error":
      return (
        <AgentRow continued={continued}>
          <Card tone="alert">
            <p className="text-sm text-[#8f2f1d]">{content.text}</p>
            {content.retry && isLastAgent ? (
              <Button type="button" variant="outline" size="sm" disabled={actions.busy} className="mt-3 h-8 bg-white" onClick={() => content.retry && actions.onRetry(content.retry)}>
                <RotateCcw />
                重试
              </Button>
            ) : null}
          </Card>
        </AgentRow>
      );
    case "agent_round_card": {
      const open = snapshot.flow.openCardId === message.id;
      return (
        <AgentRow continued={continued}>
          <ClarifyCard
            key={`${message.id}-${snapshot.latest.seq}`}
            message={content}
            pending={open ? snapshot.flow.openQuestions : []}
            draft={snapshot.latest.draft}
            open={open}
            busy={actions.busy}
            onSubmit={actions.onCardSubmit}
          />
        </AgentRow>
      );
    }
    case "agent_change": {
      const canUndo = content.versionSeq === snapshot.latest.seq && snapshot.latest.seq > 1;
      return (
        <AgentRow continued={continued}>
          <Card>
            <p className="text-sm font-medium text-[#35262a]">{content.title}</p>
            <ul className="mt-2 space-y-1.5 text-[13px]">
              {content.items.map((item) => (
                <li key={`${item.label}-${item.after}`} className="leading-5">
                  <span className="text-[#8a7d80]">{item.label}：</span>
                  <span className="text-[#a1969a] line-through">{item.before}</span>
                  <span className="mx-1 text-[#a1969a]">→</span>
                  <span className="font-medium text-[#651427]">{item.after}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3">
              {canUndo ? (
                <Button type="button" variant="outline" size="sm" disabled={actions.busy} onClick={() => actions.onUndo(content.versionSeq)} className="h-8 bg-white">
                  <RotateCcw />
                  撤销
                </Button>
              ) : (
                <span className="text-[12px] text-[#9a8d8f]">之后已有修改，可在草稿的「版本」里恢复</span>
              )}
            </div>
          </Card>
        </AgentRow>
      );
    }
    case "agent_readback":
      return (
        <AgentRow continued={continued}>
          <ReadbackCard
            message={content}
            current={snapshot.flow.readbackId === message.id && snapshot.flow.phase !== "confirmed"}
            busy={actions.busy}
            onConfirm={actions.onConfirm}
            onDismiss={actions.onDismiss}
          />
        </AgentRow>
      );
    case "agent_fill_sheet": {
      const outdated = content.versionSeq !== snapshot.latest.seq;
      return (
        <AgentRow continued={continued}>
          <Card tone="dark">
            <p className="flex items-center gap-2 text-sm text-[#dfbf82]">
              <FileSpreadsheet className="size-4" />
              1811 填写值已生成
            </p>
            <p className="mt-2 text-[13px] leading-6 text-[#e8d9dc]">
              {content.sheet.details.length} 条明细 · {content.sheet.postActions.length} 项建完后待办
              {outdated ? " · 之后信息改过，这份已过期" : ""}
            </p>
            <Button type="button" onClick={() => actions.onOpenPanel("sheet")} className="mt-3 h-9 rounded-xl bg-[#d2a85e] px-4 text-[#351018] hover:bg-[#e0b970]">
              查看填写值
            </Button>
          </Card>
        </AgentRow>
      );
    }
    default:
      return null;
  }
}

export function MessageList({ snapshot, actions }: { snapshot: Snapshot; actions: MessageActions }) {
  const messages = snapshot.messages;
  const lastAgentIndex = messages.findLastIndex((message) => message.role === "assistant");
  return (
    <>
      {messages.map((message, index) => {
        const isEvent = message.content.kind === "user_event" || message.content.kind === "user_edit";
        return (
          <div key={message.id} className="group/message">
            <MessageItem
              message={message}
              snapshot={snapshot}
              actions={actions}
              isLastAgent={index === lastAgentIndex}
              continued={message.role === "assistant" && messages[index - 1]?.role === "assistant"}
            />
            {isEvent ? null : (
              <div className={`mt-1 flex opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100 max-md:opacity-100 ${message.role === "user" ? "justify-end" : "pl-11"}`}>
                <CopyButton text={messageToText(message.content)} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
