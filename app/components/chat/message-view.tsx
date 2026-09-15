"use client";

import { AlertTriangle, CalendarDays, Info, Layers3, RotateCcw, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { messageToText, type ChatMessage, type StoredMessage } from "../../lib/campaign/messages";
import type { TopicId } from "../../lib/campaign/topics";
import type { Snapshot } from "../../lib/server/turns";
import { ClarifyCard } from "./clarify-card";
import { CopyButton } from "./copy-button";

export type MessageActions = {
  busy: boolean;
  onAnswer: (topic: TopicId, values: Record<string, unknown>) => void;
  onClarifySubmit: (answers: Record<string, unknown>) => void;
  onGenerate: () => void;
  onUndo: (versionSeq: number) => void;
  onRetry: (retry: NonNullable<Extract<StoredMessage, { kind: "agent_error" }>["retry"]>) => void;
  onOpenPanel: (tab: string) => void;
};

type ItemFlags = {
  isLastAgent: boolean;
  isLatestOfKind: boolean;
  afterLatestPlan: boolean;
};

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-[#651427] px-4 py-2.5 text-[15px] leading-6 text-white">{text}</div>
    </div>
  );
}

export function AgentRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full border border-[#d5c3ad] bg-[#f2e6d5] text-sm font-semibold text-[#651427]">周</span>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

function EventLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-center">
      <span className="rounded-full bg-[#efe8df] px-3 py-1 text-[12px] text-[#7d6f72]">{children}</span>
    </div>
  );
}

function AgentText({ children }: { children: React.ReactNode }) {
  return <p className="whitespace-pre-wrap pt-1 text-[15px] leading-7 text-[#35262a]">{children}</p>;
}

function Card({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "warm" | "alert" | "dark" }) {
  const toneClass = {
    plain: "border-[#e1d6ca] bg-[#fffdfa]",
    warm: "border-[#d7c8b4] bg-[#f5eee4]",
    alert: "border-[#efc8bb] bg-[#fff4ef]",
    dark: "border-[#5a1a29] bg-[#3f101c] text-white",
  }[tone];
  return <div className={`rounded-2xl border p-4 ${toneClass}`}>{children}</div>;
}

function ItemList({ title, items }: { title: string; items: Array<{ label: string; value: string }> }) {
  return (
    <div className="mt-3">
      <p className="text-[12px] font-medium text-[#8b6b3b]">{title}</p>
      <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        {items.map((item) => (
          <div key={`${item.label}-${item.value}`} className="contents">
            <dt className="text-[#8a7d80]">{item.label}</dt>
            <dd className="text-[#35262a]">{item.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function MessageItem({ message, snapshot, actions, flags }: { message: ChatMessage; snapshot: Snapshot; actions: MessageActions; flags: ItemFlags }) {
  const content = message.content;
  switch (content.kind) {
    case "user_text":
      return <UserBubble text={content.text} />;
    case "user_answer":
      return content.origin === "panel" ? <EventLine>你在草稿里改了：{content.label}</EventLine> : <UserBubble text={content.label} />;
    case "user_clarify_submit":
      return <UserBubble text={content.label} />;
    case "user_event":
      return <EventLine>{content.label}</EventLine>;
    case "agent_clarify":
      return (
        <AgentRow>
          <ClarifyCard
            key={`${message.id}-${snapshot.latest.seq}`}
            message={content}
            draft={snapshot.latest.draft}
            open={snapshot.plan.openClarifyId === message.id}
            busy={actions.busy}
            onSubmit={actions.onClarifySubmit}
          />
        </AgentRow>
      );
    case "agent_readback":
      return (
        <AgentRow>
          <Card>
            <p className="text-[15px] font-medium text-[#35262a]">我理解的是：</p>
            {content.stated.length ? <ItemList title="你说的" items={content.stated} /> : null}
            {content.inferred.length ? <ItemList title="我推断的，不对直接说" items={content.inferred} /> : null}
            {content.uncertain.length ? (
              <div className="mt-3">
                <p className="text-[12px] font-medium text-[#8b6b3b]">我还不确定的</p>
                <ul className="mt-1 list-inside list-disc text-sm text-[#5f5256]">
                  {content.uncertain.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            ) : null}
            <p className="mt-3 rounded-xl bg-[#f5efe7] px-3 py-2 text-[13px] text-[#6d5d5f]">
              活动类型判断：<strong className="font-semibold text-[#4b3037]">{content.derivedType}</strong>
            </p>
          </Card>
        </AgentRow>
      );
    case "agent_question":
      return (
        <AgentRow>
          <AgentText>{content.title}</AgentText>
          <p className="text-[12px] text-[#9a8d8f]">已回答</p>
        </AgentRow>
      );
    case "agent_change": {
      const canUndo = content.versionSeq === snapshot.latest.seq;
      return (
        <AgentRow>
          <Card>
            <p className="text-sm font-medium text-[#35262a]">{content.title}</p>
            <ul className="mt-2 space-y-1.5 text-[13px]">
              {content.items.map((item) => (
                <li key={`${item.label}-${item.after}`} className="leading-5">
                  <span className="text-[#8a7d80]">{item.label}：</span>
                  {item.label.startsWith("确认") ? (
                    <span className="text-[#35262a]">{item.after}</span>
                  ) : (
                    <>
                      <span className="text-[#a1969a] line-through">{item.before}</span>
                      <span className="mx-1 text-[#a1969a]">→</span>
                      <span className="font-medium text-[#651427]">{item.after}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center gap-3">
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
    case "agent_blockers":
      return (
        <AgentRow>
          <Card tone="alert">
            <p className="flex items-center gap-2 text-sm font-medium text-[#8f2f1d]">
              <AlertTriangle className="size-4" />
              有 {content.issues.length} 处和 ICS 开单规则冲突
            </p>
            <ul className="mt-2 space-y-1 text-[13px] text-[#6d3a2c]">
              {content.issues.map((issue) => <li key={`${issue.ruleId}-${issue.path}`}>{issue.ruleId} · {issue.message}</li>)}
            </ul>
            {flags.isLatestOfKind ? (
              <Button type="button" variant="outline" size="sm" className="mt-3 h-8 bg-white" onClick={() => actions.onOpenPanel("fields")}>
                去草稿里改
              </Button>
            ) : null}
          </Card>
        </AgentRow>
      );
    case "agent_no_ics":
      return (
        <AgentRow>
          <Card tone="warm">
            <p className="flex items-center gap-2 text-sm font-semibold text-[#4b3524]">
              <Info className="size-4 text-[#8b6330]" />
              本次不建 ICS 单
            </p>
            <p className="mt-1 text-[13px] leading-6 text-[#75624f]">{content.reason}</p>
          </Card>
        </AgentRow>
      );
    case "agent_ready":
      return (
        <AgentRow>
          <Card tone="dark">
            <p className="flex items-center gap-2 text-sm text-[#dfbf82]">
              <Layers3 className="size-4" />
              可以生成方案了
            </p>
            {content.total > 0 ? (
              <>
                <p className="mt-2 flex items-end gap-2">
                  <strong className="text-4xl font-semibold tracking-[-0.04em]">{content.total}</strong>
                  <span className="pb-1 text-sm text-[#d8c8cc]">条 ICS 单要录入</span>
                </p>
                <p className="mt-1 text-[13px] text-[#d8c8cc]">
                  {content.factors.batches} 批次 × {content.factors.markets} 市场 × {content.factors.channels} 渠道 × {content.factors.scopeUnits} 范围 × {content.factors.offerTiers} 档优惠
                </p>
              </>
            ) : null}
            {content.pendingUi.length ? (
              <p className="mt-2 text-[13px] text-[#e8d9dc]">另有 {content.pendingUi.length} 项要你在 ICS 界面上选：{content.pendingUi.join("；")}</p>
            ) : null}
            <Button
              type="button"
              disabled={!flags.isLatestOfKind || !flags.afterLatestPlan || actions.busy || snapshot.session.status === "generated"}
              onClick={actions.onGenerate}
              className="mt-4 h-10 rounded-xl bg-[#d2a85e] px-4 text-[#351018] hover:bg-[#e0b970]"
            >
              <CalendarDays />
              生成活动方案
            </Button>
          </Card>
        </AgentRow>
      );
    case "agent_regenerate_offer":
      return (
        <AgentRow>
          <AgentText>字段改了，文案里可能还是旧的内容。要重新生成文案吗？</AgentText>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!flags.isLatestOfKind || !flags.afterLatestPlan || actions.busy || snapshot.session.status !== "generated"}
            onClick={actions.onGenerate}
            className="h-8 bg-white"
          >
            <Sparkles />
            重新生成文案
          </Button>
        </AgentRow>
      );
    case "agent_plan":
      return (
        <AgentRow>
          <AgentText>方案好了。想改哪里直接说，比如「活动名克制一点」。</AgentText>
          <Card>
            <p className="text-[12px] font-medium tracking-[0.12em] text-[#9a7442]">活动主张</p>
            <h3 className="mt-2 text-xl font-semibold tracking-[-0.02em] text-[#38242a]">{content.brief.slogan}</h3>
            <p className="mt-2 text-[14px] leading-7 text-[#6d6063]">{content.brief.content}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-[#ece3d9] p-3">
                <p className="text-[12px] text-[#8b7f81]">对外传播名</p>
                <p className="mt-1 font-semibold text-[#3f2d32]">{content.brief.externalName}</p>
              </div>
              <div className="rounded-xl border border-[#ece3d9] p-3">
                <p className="text-[12px] text-[#8b7f81]">ICS 开单名</p>
                <p className="mt-1 font-semibold text-[#3f2d32]">{content.brief.icsName}</p>
              </div>
            </div>
            {content.missing?.length ? (
              <p className="mt-3 rounded-xl bg-[#fff8ec] px-3 py-2 text-[13px] leading-6 text-[#8b5d25]">
                还有 {content.missing.length} 项待补：{content.missing.join("、")}。{content.total === 0 ? "所以暂时拆不出 ICS 单。" : "补齐后才能录入 ICS。"}补在下面的卡片里，或者直接在对话里说。
              </p>
            ) : (
              <p className="mt-3 text-[13px] text-[#6d6063]">
                {content.total > 0
                  ? `要在 ICS 录入 ${content.total} 条优惠规则：${content.readyOrders} 条字段已齐，${content.blockedOrders} 条还有项要在 ICS 界面上选。`
                  : "这次不建 ICS 单。"}
              </p>
            )}
            {content.warnings.length ? <p className="mt-2 text-[12px] text-[#9c642b]">提醒：{content.warnings.join("；")}</p> : null}
            {content.total > 0 ? (
              <Button type="button" variant="outline" size="sm" className="mt-3 h-8 bg-white" onClick={() => actions.onOpenPanel("ics")}>
                查看 ICS 草稿
              </Button>
            ) : null}
          </Card>
        </AgentRow>
      );
    case "agent_text":
      return (
        <AgentRow>
          <AgentText>{content.text}</AgentText>
        </AgentRow>
      );
    case "agent_error":
      return (
        <AgentRow>
          <Card tone="alert">
            <p className="text-sm text-[#8f2f1d]">{content.text}</p>
            {content.retry && flags.isLastAgent ? (
              <Button type="button" variant="outline" size="sm" disabled={actions.busy} className="mt-3 h-8 bg-white" onClick={() => content.retry && actions.onRetry(content.retry)}>
                <RotateCcw />
                重试
              </Button>
            ) : null}
          </Card>
        </AgentRow>
      );
  }
}

export function MessageList({ snapshot, actions }: { snapshot: Snapshot; actions: MessageActions }) {
  const messages = snapshot.messages;
  const lastAgentIndex = messages.findLastIndex((message) => message.role === "assistant");
  const lastPlanIndex = messages.findLastIndex((message) => message.content.kind === "agent_plan");
  const lastIndexByKind = new Map<string, number>();
  messages.forEach((message, index) => lastIndexByKind.set(message.content.kind, index));

  return (
    <>
      {messages.map((message, index) => {
        const content = message.content;
        const isEvent = content.kind === "user_event" || (content.kind === "user_answer" && content.origin === "panel");
        return (
          <div key={message.id} className="group/message">
            <MessageItem
              message={message}
              snapshot={snapshot}
              actions={actions}
              flags={{
                isLastAgent: index === lastAgentIndex,
                isLatestOfKind: lastIndexByKind.get(content.kind) === index,
                afterLatestPlan: index > lastPlanIndex,
              }}
            />
            {isEvent ? null : (
              <div
                className={`mt-1 flex opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100 max-md:opacity-100 ${message.role === "user" ? "justify-end" : "pl-11"}`}
              >
                <CopyButton text={messageToText(content)} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
