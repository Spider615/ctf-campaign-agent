"use client";

import type { HistoryMessage } from "../../lib/client/history-conversation";
import { formatDuration, type ToolTrace } from "../../lib/tool-trace";
import { AdvisorAnswer } from "./advisor-answer";
import { AnalysisAnswerView } from "./analysis-answer";
import { isAnalysisAnswer } from "../../lib/analytics/stream";
import { AgentRow, MessageTimestamp, UserBubble } from "../chat/message-view";
import { MarkdownText } from "../chat/markdown-text";
import { ThinkingIndicator } from "../chat/thinking-indicator";
import { ToolRunCard } from "../chat/tool-run-card";
import { CopyButton } from "../chat/copy-button";
import { isConversationAnswer } from "../../lib/attachments/answer";
import { SentAttachmentCards } from "../attachments/attachment-cards";
import { FileAnswer } from "../attachments/file-answer";
import { VisualizationProgress } from "./visualization-progress.tsx";

export function HistoryMessageView({ message, busy, onRetry, onFileDeleted }: { message: HistoryMessage; busy: boolean; onRetry: (message: HistoryMessage) => void; onFileDeleted?: (id: string) => void }) {
  if (message.role === "user") return <section id={`history-${message.id}`} aria-label="你的问题" className="scroll-mt-4 cursor-text select-text"><UserBubble text={message.text} />{message.attachments?.length ? <SentAttachmentCards attachments={message.attachments} onDeleted={onFileDeleted} /> : null}<div className="mt-1 flex min-h-7 items-center justify-end gap-3"><MessageTimestamp iso={message.createdAt} /><CopyButton text={message.text} /></div></section>;
  const live = message.status === "running";
  const steps = live ? message.trace ?? [] : (message.trace ?? []).filter((step) => step.status !== "started");
  const recorded: ToolTrace = message.answer?.trace ?? { status: message.status === "failed" || message.status === "cancelled" ? "failed" : "completed", durationMs: message.durationMs ?? 0, steps };
  const hasTrace = (live ? steps : recorded.steps).length > 0;
  const incomplete = message.status === "cancelled" || message.status === "failed";
  return <section aria-label="小福的回答" aria-busy={live} className="space-y-3">
    {hasTrace ? <AgentRow><ToolRunCard trace={live ? steps : recorded} live={live} startedAt={message.startedAt} showToolNames={false} title={live ? "小福正在核对" : message.status === "cancelled" ? "分析已停止" : "查看分析过程"} summary={incomplete ? `已完成 ${steps.filter((step) => step.status === "completed").length} 步${message.durationMs === undefined ? "" : ` · 本次等待 ${formatDuration(message.durationMs)}`}` : !live ? `完成 ${recorded.steps.length} 个步骤 · 用时 ${formatDuration(recorded.durationMs)}` : undefined} /></AgentRow> : null}
    {message.visualizationState && !message.answer ? <AgentRow continued={hasTrace}><VisualizationProgress state={message.visualizationState} live={live} conversationId={message.request && "conversationId" in message.request ? message.request.conversationId : undefined} /></AgentRow> : null}
    {live ? <ThinkingIndicator continued={hasTrace || Boolean(message.visualizationState?.items.length)} label={message.phase === "writing" ? "正在核验并整理回答" : "正在处理你的问题"} /> : <AgentRow continued={hasTrace}>
      {message.answer && isConversationAnswer(message.answer) ? <FileAnswer answer={message.answer} conversationId={message.request && "conversationId" in message.request ? message.request.conversationId : message.attachments?.[0]?.conversationId ?? ""} /> : message.answer && isAnalysisAnswer(message.answer) ? <AnalysisAnswerView answer={message.answer} /> : message.answer?.reply ? <MarkdownText text={message.answer.reply} /> : message.answer ? <AdvisorAnswer explanation={message.answer} onRows={() => {}} conversational /> : <p className="whitespace-pre-wrap break-words text-[15px] leading-7 text-[#425873]" role={message.status === "failed" ? "alert" : undefined}>{message.text}</p>}
      {message.status === "failed" && message.request ? <button type="button" disabled={busy} onClick={() => onRetry(message)} className="min-h-11 rounded-lg px-1 text-sm text-[#2470cc] underline-offset-4 hover:underline disabled:opacity-50">重试本次回答</button> : null}
      <div className="flex min-h-7 items-center gap-3"><MessageTimestamp iso={message.createdAt} />{message.status === "done" && message.text ? <CopyButton text={message.text} /> : null}</div>
    </AgentRow>}
  </section>;
}
