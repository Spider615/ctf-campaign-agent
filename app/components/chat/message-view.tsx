"use client";

import { ChevronDown, ChevronUp, FileSpreadsheet, RotateCcw } from "lucide-react";
import { useState } from "react";

import { messageToText, type ChatMessage, type RetryInput, type StoredMessage } from "../../lib/campaign/ics1811/messages";
import { plainText } from "../../lib/markdown";
import type { Snapshot } from "../../lib/server/turns";
import { ClarifyCard } from "./clarify-card";
import { CopyButton } from "./copy-button";
import { MarkdownText } from "./markdown-text";
import { ReadbackCard } from "./readback-card";
import { AgentAvatar } from "./agent-avatar";
import { ToolRunCard } from "./tool-run-card";

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
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-[linear-gradient(135deg,#247cff,#397fdf)] px-4 py-2.5 text-[15px] leading-6 text-white shadow-[0_8px_20px_rgba(36,124,255,0.18)]">{text}</div>
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
        <AgentAvatar />
      )}
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

function EventLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center">
      <span className="max-w-[90%] rounded-full border border-[#dae8f6] bg-white/55 px-3 py-1 text-center text-[12px] text-[#71869f]">{children}</span>
    </div>
  );
}

// 不需要用户拍板的东西一律降成一行：记下了什么、填写值生成了、出错了。
// 卡片只留给真正要确认的复述——这是「以对话为主，卡片只在要确认时出现」的落点。
function AgentNote({ tone = "muted", children }: { tone?: "muted" | "alert"; children: React.ReactNode }) {
  return (
    <p className={`flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-[13px] leading-6 ${tone === "alert" ? "text-[#b2443b]" : "text-[#6f849d]"}`}>
      {children}
    </p>
  );
}

// 一行里的次要动作（撤销、重试、查看填写值）做成文字按钮，不用实心按钮抢视线。
function InlineAction({ disabled, onClick, children }: { disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-[13px] text-[#2470cc] underline-offset-4 hover:bg-[#edf5ff] hover:underline disabled:opacity-50 md:min-h-8"
    >
      {children}
    </button>
  );
}

// 每一轮改了什么，是「活动一步步搭起来」唯一留在对话里的痕迹：默认一行，
// 想看细节就展开逐项的「改前 → 改后」。hooks 不能写在 switch 分支里，所以单独成组件。
function ChangeNote({ content, canUndo, busy, onUndo, onOpenPanel }: {
  content: Extract<StoredMessage, { kind: "agent_change" }>;
  canUndo: boolean;
  busy: boolean;
  onUndo: (versionSeq: number) => void;
  onOpenPanel: (tab: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const shown = content.items.slice(0, 3).map((item) => `${item.label} ${item.after}`).join("、");
  const rest = content.items.length > 3 ? ` 等 ${content.items.length} 项` : "";
  return (
    <div>
      <AgentNote>
        <span className="text-[#5e748f]">{content.title}：{shown}{rest}</span>
        <InlineAction onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          {open ? "收起这一步" : "看这一步改了什么"}
        </InlineAction>
        <InlineAction onClick={() => onOpenPanel("sheet")}>查看填写值</InlineAction>
        {canUndo ? (
          <InlineAction disabled={busy} onClick={() => onUndo(content.versionSeq)}>
            <RotateCcw className="size-3" />
            撤销
          </InlineAction>
        ) : (
          <InlineAction onClick={() => onOpenPanel("versions")}>之后已有修改，去版本里恢复</InlineAction>
        )}
      </AgentNote>
      {open ? (
        <ul className="mt-1.5 space-y-1 rounded-xl border border-[#dce9f6] bg-white/70 px-3 py-2 text-[13px] leading-5">
          {content.items.map((item) => (
            <li key={`${item.label}-${item.after}`}>
              <span className="text-[#7589a0]">{item.label}：</span>
              <span className="text-[#9aacbf] line-through">{item.before}</span>
              <span className="mx-1 text-[#9aacbf]">→</span>
              <span className="font-medium text-[#1769c5]">{item.after}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function MessageItem({ message, snapshot, actions, isLastAgent, continued }: { message: ChatMessage; snapshot: Snapshot; actions: MessageActions; isLastAgent: boolean; continued: boolean }) {
  const content = message.content;
  switch (content.kind) {
    case "user_text":
    case "user_card_submit":
      return <UserBubble text={content.kind === "user_text" ? content.text : content.label} />;
    case "user_edit":
      // 面板里手改是用户自己的操作，显示成他说的话；WebMCP 工具改的不是用户说的，
      // 伪装成用户消息等于谎报来源，保持事件行。
      return content.origin === "panel" ? <UserBubble text={content.label} /> : <EventLine>工具改了：{content.label}</EventLine>;
    case "user_event":
      // 确认、撤销、恢复、忽略提示都是用户亲手点的按钮，等同于他打了这句话。
      return <UserBubble text={content.label} />;
    case "agent_tool_trace":
      return (
        <AgentRow continued={continued}>
          <ToolRunCard trace={content.trace} live={false} />
        </AgentRow>
      );
    case "agent_text":
      return (
        <AgentRow continued={continued}>
          <MarkdownText text={content.text} />
        </AgentRow>
      );
    case "agent_error":
      return (
        <AgentRow continued={continued}>
          <AgentNote tone="alert">
            <span>{content.text}</span>
            {content.retry && isLastAgent ? (
              <InlineAction disabled={actions.busy} onClick={() => content.retry && actions.onRetry(content.retry)}>
                <RotateCcw className="size-3" />
                重试
              </InlineAction>
            ) : null}
          </AgentNote>
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
          <ChangeNote
            content={content}
            canUndo={canUndo}
            busy={actions.busy}
            onUndo={actions.onUndo}
            onOpenPanel={actions.onOpenPanel}
          />
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
            onOpenPanel={actions.onOpenPanel}
          />
        </AgentRow>
      );
    case "agent_fill_sheet": {
      const outdated = content.versionSeq !== snapshot.latest.seq;
      return (
        <AgentRow continued={continued}>
          <AgentNote>
            <span className="inline-flex items-center gap-1.5 font-medium text-[#58718f]">
              <FileSpreadsheet className="size-3.5 text-[#247cff]" />
              1811 填写值已生成
            </span>
            <span>
              {content.sheet.details.length} 条明细 · {content.sheet.postActions.length} 项建完后待办
              {outdated ? " · 之后信息改过，这份已过期" : ""}
            </span>
            <InlineAction onClick={() => actions.onOpenPanel("sheet")}>查看填写值</InlineAction>
          </AgentNote>
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
          // scroll-mt 留出步骤条和头部的高度，跳回来时不会被压在上面看不见。
          <div key={message.id} id={`msg-${message.id}`} className="group/message scroll-mt-24">
            <MessageItem
              message={message}
              snapshot={snapshot}
              actions={actions}
              isLastAgent={index === lastAgentIndex}
              continued={message.role === "assistant" && messages[index - 1]?.role === "assistant"}
            />
            {isEvent ? null : (
              <div className={`mt-1 flex opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100 max-md:opacity-100 ${message.role === "user" ? "justify-end" : "pl-11"}`}>
                <CopyButton text={plainText(messageToText(message.content))} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
