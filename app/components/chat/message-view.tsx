"use client";

import { ChevronDown, ChevronUp, FileSpreadsheet, Megaphone, RotateCcw } from "lucide-react";
import { useState } from "react";

import { messageToText, type ChatMessage, type RetryInput, type StoredMessage } from "../../lib/campaign/ics1811/messages";
import { formatMessageTime, messageTimeTitle } from "../../lib/client/message-time";
import { plainText } from "../../lib/markdown";
import type { Snapshot } from "../../lib/server/turns";
import { promoCtaMessageId } from "../../lib/client/promo-cta";
import { CopyButton } from "./copy-button";
import { MarkdownText } from "./markdown-text";
import { AgentAvatar } from "./agent-avatar";
import { ToolRunCard } from "./tool-run-card";

export type MessageActions = {
  busy: boolean;
  onUndo: (versionSeq: number) => void;
  onRetry: (retry: RetryInput) => void;
  onOpenPanel: (tab: string) => void;
  onGeneratePromo: () => void;
};

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] cursor-text select-text whitespace-pre-wrap rounded-2xl rounded-br-md bg-[linear-gradient(135deg,#247cff,#397fdf)] px-4 py-2.5 text-[15px] leading-6 text-white shadow-[0_8px_20px_rgba(36,124,255,0.18)]">{text}</div>
    </div>
  );
}

export function MessageTimestamp({ iso }: { iso: string }) {
  const label = formatMessageTime(iso);
  if (!label) return null;
  return <time dateTime={iso} title={messageTimeTitle(iso)} className="select-none text-[11px] text-[#8ca0b7]">{label}</time>;
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
      <div className="min-w-0 flex-1 cursor-text select-text space-y-2">{children}</div>
    </div>
  );
}

function EventLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center">
      <span className="max-w-[90%] cursor-text select-text rounded-full border border-[#dae8f6] bg-white/55 px-3 py-1 text-center text-[12px] text-[#71869f]">{children}</span>
    </div>
  );
}

// 不需要用户拍板的东西一律降成一行：记下了什么、填写值生成了、出错了。
// 整个流程没有要点的确认按钮，追问和提议都在 Agent 的话里。
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
      className="inline-flex min-h-11 select-none items-center gap-1 rounded-md px-1 text-[13px] text-[#2470cc] underline-offset-4 hover:bg-[#edf5ff] hover:underline disabled:opacity-50 md:min-h-8"
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
        <InlineAction onClick={() => onOpenPanel("brief")}>查看活动工作台</InlineAction>
        {canUndo ? (
          <InlineAction disabled={busy} onClick={() => onUndo(content.versionSeq)}>
            <RotateCcw className="size-3" />
            撤销
          </InlineAction>
        ) : (
          <InlineAction onClick={() => onOpenPanel("1811")}>之后已有修改，去 1811 版本里恢复</InlineAction>
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

// 1811 填写值准备好（或后续同步更新）时的那一条。
// 它只代表优惠配置产物，不表示整体活动已审批或可上线。
function SheetNote({ content, first, latestSeq, offerPromo, busy, onOpenPanel, onGeneratePromo }: {
  content: Extract<StoredMessage, { kind: "agent_fill_sheet" }>;
  first: boolean;
  latestSeq: number;
  offerPromo: boolean;
  busy: boolean;
  onOpenPanel: (tab: string) => void;
  onGeneratePromo: () => void;
}) {
  const [open, setOpen] = useState(false);
  const lines = content.lines ?? [];
  const outdated = content.versionSeq !== latestSeq;
  return (
    <div className="border-l-2 border-[#bfe7d8] pl-3.5">
      <AgentNote>
        <span className="inline-flex items-center gap-1.5 font-medium text-[#26785e]">
          <FileSpreadsheet className="size-3.5" />
          {first ? "1811 填写值已准备" : "1811 填写值已同步更新"}
        </span>
        {/* 旧会话存下的这条没有 summary 和 lines，只报明细条数。 */}
        {content.summary ? null : <span>{content.sheet.details.length} 条明细 · {content.sheet.postActions.length} 项建完后待办</span>}
        <InlineAction onClick={() => onOpenPanel("1811")}>查看填写值</InlineAction>
      </AgentNote>
      {content.summary ? <p className="text-[15px] font-medium leading-7 text-[#263950]">{content.summary}</p> : null}
      {lines.length ? (
        <>
          <InlineAction onClick={() => setOpen((value) => !value)}>
            {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            {open ? "收起" : "这次准备了什么"}
          </InlineAction>
          {open ? (
            <ul className="mt-1 space-y-1 text-[14px] leading-7 text-[#425873]">
              {lines.map((line) => <li key={line}>{line}</li>)}
            </ul>
          ) : null}
        </>
      ) : null}
      {outdated ? <p className="mt-1 text-[12px] text-[#8ca0b7]">之后又改过，以右边最新的为准</p> : null}
      {offerPromo ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#cfe0f2] bg-[#f4f9ff] px-3 py-2.5">
          <p className="text-[13px] leading-5 text-[#536b87]">1811 产物已准备。还可以基于 Campaign Brief 生成分渠道传播方案；是否可上线请以上线检查为准。</p>
          <button
            type="button"
            disabled={busy}
            onClick={onGeneratePromo}
            className="inline-flex min-h-9 select-none items-center gap-1.5 rounded-lg bg-[#247cff] px-3 text-[13px] font-medium text-white shadow-sm hover:bg-[#176bea] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Megaphone className="size-3.5" />
            生成传播方案
          </button>
        </div>
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
      // 撤销、恢复、忽略提示（以及旧会话里的确认）都是用户亲手点的按钮，等同于他打了这句话。
      return <UserBubble text={content.label} />;
    case "agent_tool_trace":
      return (
        <AgentRow continued={continued}>
          <ToolRunCard trace={content.trace} live={false} />
        </AgentRow>
      );
    case "agent_text": {
      // 用户回「行」时记下的是代码校验、渲染过的提议值，不是模型嘴上的说法，所以把它摆出来。
      // 只挂在 Agent 最近一次回复下面，而且只列现在仍适用的提议。
      const proposals = message.id === snapshot.flow.replyId ? snapshot.flow.proposals : [];
      return (
        <AgentRow continued={continued}>
          <MarkdownText text={content.text} />
          {/* 这是用户点头时真正会记下的值，不能只是一行灰字：模型嘴上说的和登记的对不上时，用户得看得出来。 */}
          {proposals.length ? (
            <div className="rounded-xl bg-[#f1f7ff] px-3 py-2 text-[13px] leading-6 text-[#34506f]">
              <p className="text-[12px] text-[#6f849d]">回「行」就按这个记：</p>
              <ul>
                {proposals.map((item) => <li key={item.id}>{item.text}</li>)}
              </ul>
            </div>
          ) : null}
        </AgentRow>
      );
    }
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
    case "agent_round_card":
      // 旧会话：那时追问是一张分轮次的卡片，现在只读展示当时问了什么。
      return (
        <AgentRow continued={continued}>
          <p className="whitespace-pre-wrap text-[14px] leading-7 text-[#8196ad]">{messageToText(content)}</p>
        </AgentRow>
      );
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
      // 旧会话：那时要先复述、点确认才生成填写值，现在只读展示当时的复述。
      return (
        <AgentRow continued={continued}>
          <p className="whitespace-pre-wrap text-[14px] leading-7 text-[#8196ad]">
            {content.readback.summary || content.readback.paragraph}
            <span className="ml-1 text-[12px]">（旧版复述）</span>
          </p>
        </AgentRow>
      );
    case "agent_fill_sheet": {
      const firstSheet = snapshot.messages.find((item) => item.content.kind === "agent_fill_sheet");
      const promoMessageId = promoCtaMessageId({
        messages: snapshot.messages,
        briefReady: snapshot.workspace.brief.status === "ready",
        communication: snapshot.latest.communication,
      });
      return (
        <AgentRow continued={continued}>
          <SheetNote
            content={content}
            first={firstSheet?.id === message.id}
            latestSeq={snapshot.latest.seq}
            offerPromo={promoMessageId === message.id}
            busy={actions.busy}
            onOpenPanel={actions.onOpenPanel}
            onGeneratePromo={actions.onGeneratePromo}
          />
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
          // scroll-mt 留出头部的高度，跳回来时不会被压在上面看不见。
          <div key={message.id} id={`msg-${message.id}`} className="group/message cursor-text select-text scroll-mt-24">
            <MessageItem
              message={message}
              snapshot={snapshot}
              actions={actions}
              isLastAgent={index === lastAgentIndex}
              continued={message.role === "assistant" && messages[index - 1]?.role === "assistant"}
            />
            <div className={`mt-1 flex min-h-7 items-center gap-1 ${isEvent ? "justify-center" : message.role === "user" ? "justify-end" : "pl-11"}`}>
              <MessageTimestamp iso={message.createdAt} />
              {isEvent ? null : (
                <span className="select-none opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100 max-md:opacity-100">
                  <CopyButton text={plainText(messageToText(message.content))} />
                </span>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
