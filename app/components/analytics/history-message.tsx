"use client";

import type { HistoryMessage } from "../../lib/client/history-conversation";
import { AdvisorAnswer } from "./advisor-answer";
import { PlanAnswerV4View, PlanAnswerView } from "./plan-answer";
import { isPlanAnswer, isPlanAnswerV4 } from "../../lib/analytics/stream";
import { AgentRow, MessageTimestamp, UserBubble } from "../chat/message-view";
import { MarkdownText } from "../chat/markdown-text";
import { ThinkingIndicator } from "../chat/thinking-indicator";
import { ToolTimeline } from "../chat/tool-timeline";
import { CopyButton } from "../chat/copy-button";
import { isConversationAnswer } from "../../lib/attachments/answer";
import { SentAttachmentCards } from "../attachments/attachment-cards";
import { FileAnswer } from "../attachments/file-answer";
import { VisualizationProgress } from "./visualization-progress.tsx";
import { Network } from "lucide-react";
import { locateAnswer } from "../../lib/insight/context";
import { INSIGHT_NODE_LABEL, type InsightNodeId } from "../../lib/insight/types";
import type { AnalyticsAnswerResult } from "../../lib/analytics/stream";

// 回答用到的维度从证据里取（分层控制和比较对象），能对上洞察图上的节点时给一个「在图上看」。
function answerDimension(answer: AnalyticsAnswerResult | undefined): InsightNodeId | null {
  if (!answer || !isPlanAnswerV4(answer)) return null;
  return locateAnswer([...answer.evidence.objects.map((o) => o.dimension), ...answer.evidence.frames.flatMap((f) => f.controls)]);
}

export function HistoryMessageView({ message, busy, onRetry, onFileDeleted, onLocate }: { message: HistoryMessage; busy: boolean; onRetry: (message: HistoryMessage) => void; onFileDeleted?: (id: string) => void; onLocate?: (id: InsightNodeId) => void }) {
  if (message.role === "user") return <section id={`history-${message.id}`} aria-label="你的问题" className="scroll-mt-4 cursor-text select-text"><UserBubble text={message.text} />{message.attachments?.length ? <SentAttachmentCards attachments={message.attachments} onDeleted={onFileDeleted} /> : null}<div className="mt-1 flex min-h-7 items-center justify-end gap-3"><MessageTimestamp iso={message.createdAt} /><CopyButton text={message.text} /></div></section>;
  const live = message.status === "running";
  const steps = message.trace ?? [];
  const recorded = message.answer?.trace;
  const incomplete = message.status === "cancelled" || message.status === "failed";
  const partial = message.answer && "status" in message.answer && (message.answer.status === "partial" || message.answer.status === "unavailable");
  const status = message.status === "cancelled" ? "cancelled" : message.status === "failed" ? "failed" : recorded?.status === "failed" ? "failed" : partial ? "warning" : recorded?.status;
  const shownSteps = live ? steps : recorded?.steps ?? steps;
  const durationMs = incomplete ? message.durationMs ?? recorded?.timing?.totalMs ?? recorded?.durationMs : recorded?.timing?.totalMs ?? recorded?.durationMs ?? message.durationMs;
  const hasTrace = shownSteps.length > 0 || !live && (recorded?.status === "failed" || incomplete && durationMs !== undefined);
  const fileQuestion = Boolean(message.request && "attachmentIds" in message.request);
  return <section aria-label="小福的回答" aria-busy={live} className="space-y-3">
    {hasTrace ? <AgentRow><ToolTimeline steps={shownSteps} live={live} startedAt={message.startedAt} durationMs={durationMs} status={status} /></AgentRow> : null}
    {message.visualizationState && !message.answer ? <AgentRow continued={hasTrace}><VisualizationProgress state={message.visualizationState} live={live} conversationId={message.request && "conversationId" in message.request ? message.request.conversationId : undefined} /></AgentRow> : null}
    {live ? <ThinkingIndicator continued={hasTrace || Boolean(message.visualizationState?.items.length)} label={message.phase === "writing" ? fileQuestion ? "正在核验并整理回答" : "正在整理回答" : "正在处理你的问题"} /> : <AgentRow continued={hasTrace}>
      {message.answer && isConversationAnswer(message.answer) ? <FileAnswer answer={message.answer} conversationId={message.request && "conversationId" in message.request ? message.request.conversationId : message.attachments?.[0]?.conversationId ?? ""} /> : message.answer && isPlanAnswerV4(message.answer) ? <PlanAnswerV4View answer={message.answer} /> : message.answer && isPlanAnswer(message.answer) ? <PlanAnswerView answer={message.answer} /> : message.answer?.reply ? <MarkdownText text={message.answer.reply} /> : message.answer ? <AdvisorAnswer explanation={message.answer} onRows={() => {}} conversational /> : <p className="whitespace-pre-wrap break-words text-[15px] leading-7 text-[#425873]" role={message.status === "failed" ? "alert" : undefined}>{message.text}</p>}
      {incomplete && message.request ? <button type="button" disabled={busy} onClick={() => onRetry(message)} className="min-h-11 rounded-lg px-1 text-sm text-[#2470cc] underline-offset-4 hover:underline disabled:opacity-50">重试本次回答</button> : null}
      {onLocate && message.status === "done" && answerDimension(message.answer) ? <button type="button" onClick={() => onLocate(answerDimension(message.answer)!)} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-1 text-sm text-[#2470cc] underline-offset-4 hover:underline"><Network aria-hidden="true" className="size-4" />在洞察图上看「{INSIGHT_NODE_LABEL[answerDimension(message.answer)!]}」</button> : null}
      <div className="flex min-h-7 items-center gap-3"><MessageTimestamp iso={message.createdAt} />{message.status === "done" && message.text ? <CopyButton text={message.text} /> : null}</div>
    </AgentRow>}
  </section>;
}
