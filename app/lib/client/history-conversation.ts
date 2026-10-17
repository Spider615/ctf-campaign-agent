import { restoreVisualizationProgress, type VisualizationProgressState } from "../analytics/visualization-progress.ts";
import type { DatabaseExplainRequest } from "../analytics/database.ts";
import type { AgentTraceEvent } from "../tool-trace.ts";
import { analyticsAnswerText, isAnalysisAnswer, validateAnalyticsAnswerResult, type AnalyticsAnswerResult } from "../analytics/stream.ts";
import { isConversationAnswer } from "../attachments/answer.ts";
import type { AttachmentReference, ConversationRequest } from "../attachments/types.ts";

export type HistoryMessage = { id: string; role: "user" | "assistant"; text: string; createdAt: string; answer?: AnalyticsAnswerResult; request?: DatabaseExplainRequest | ConversationRequest; attachments?: AttachmentReference[]; status?: "running" | "done" | "failed" | "cancelled"; trace?: AgentTraceEvent[]; startedAt?: number; durationMs?: number; phase?: "analyzing" | "writing"; visualizationState?: VisualizationProgressState; afterMessageId?: string };
export function replaceHistoryAttachment(messages: HistoryMessage[], previousId: string, file: AttachmentReference): HistoryMessage[] {
  return messages.map((message) => ({ ...message,
    ...(message.attachments ? { attachments: [...new Map(message.attachments.map((item) => item.id === previousId ? file : item).map((item) => [item.id, item])).values()] } : {}),
    ...(message.request && "attachmentIds" in message.request ? { request: { ...message.request, attachmentIds: [...new Set(message.request.attachmentIds.map((id) => id === previousId ? file.id : id))] } } : {}),
  }));
}
type Thread = { id: string; title: string; messages: HistoryMessage[]; context: string[]; campaignId: string | null; updatedAt: string };
export type ConversationSummary = Pick<Thread, "id" | "title" | "updatedAt" | "campaignId">;
type Persistence = { getItem(key: string): string | null; setItem(key: string, value: string): void };
const key = "ctf:conversations:v2"; const legacyKey = "ctf:history-conversation:v1";
const empty: HistoryMessage[] = []; const emptyThreads: ConversationSummary[] = [];
const messagesValid = (value: unknown): value is HistoryMessage[] => Array.isArray(value) && value.length <= 40 && value.every((item) => item && typeof item.id === "string" && ["user", "assistant"].includes(item.role) && typeof item.text === "string" && typeof item.createdAt === "string");
const contextValid = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 200 && value.every((text) => typeof text === "string" && text.length <= 500);
const finishPending = (messages: HistoryMessage[]) => messages.map((m) => m.status === "running" ? { ...m, status: "cancelled" as const, text: "上次等待已结束，可以继续追问或重新分析。" } : m);
const restoreMessages = (messages: HistoryMessage[]) => finishPending(messages).map((stored) => {
  const message = { ...stored, ...(stored.visualizationState === undefined ? {} : { visualizationState: restoreVisualizationProgress(stored.visualizationState) }) };
  // 旧记录保留旧合同；新记录恢复时重新核验，不能凭存储里的正文绕过引用检查。
  if (!message.answer || !("schema" in message.answer)) return message;
  try { const answer = validateAnalyticsAnswerResult(message.answer); return { ...message, answer, text: analyticsAnswerText(answer) }; }
  catch { return { ...message, answer: undefined, status: "failed" as const, text: "上次回答未通过完整性核验，请重新分析。" }; }
});

export function historyMessageContext(message: HistoryMessage): string {
  if (!message.answer) return message.text;
  if (isConversationAnswer(message.answer)) return `以下为用户上传资料的问答，不等同于已核验经营数据或执行事实：${message.answer.blocks.map((block) => block.text).join("\n\n")}`;
  if (!isAnalysisAnswer(message.answer)) return `${message.text}\n${message.answer.sources?.map((source) => `已查询范围：${source.scope}；口径：${source.definition}`).join("\n") ?? ""}`.trim();
  const answer = message.answer;
  // 只带已校验的正文与公开业务范围；数据库、私有记录和操作内部标识不进入后续模型上下文。
  const selectWithin = (values: string[], budget: number) => [...new Set(values)].filter((value) => { if (value.length > budget) return false; budget -= value.length; return true; });
  const scopeTerms = [...Object.values(answer.task.hardScope.filters), ...Object.values(answer.task.focus ?? {})].flatMap((values) => values ?? []);
  const context = selectWithin([...answer.task.context.filter((text) => scopeTerms.some((term) => text.includes(term))), ...answer.task.context.slice().reverse()], 800);
  const task = { hardScope: answer.task.hardScope, ...(answer.task.focus ? { focus: answer.task.focus } : {}), ...(answer.task.goal ? { goal: answer.task.goal } : {}), context, userQuotes: selectWithin(answer.task.needs.map((need) => need.userQuote), 600) };
  const taskLine = `公开任务范围：${JSON.stringify(task)}`;
  const scopeLines = selectWithin(answer.evidence.frames.map((frame) => `公开分析范围：${JSON.stringify({ period: frame.scope.period, population: frame.scope.population, filters: frame.scope.filters, mode: frame.mode, provenance: frame.provenance, currency: frame.currency, grain: frame.grain, controls: frame.controls })}`), Math.max(0, 2400 - taskLine.length));
  // 完整范围仍在已保存回答及用户持续要求中；历史摘要留出正文空间，不截断结构化 JSON。
  const prefix = taskLine.length <= 2400 ? [taskLine, ...scopeLines].join("\n") : `公开任务范围摘要过长，后续须按用户持续要求核对完整范围。原问题：${answer.task.question}\n范围原话：${context.join("；")}`;
  return `${prefix}\n${analyticsAnswerText({ ...answer, visualizations: undefined }).slice(0, 3999 - prefix.length)}`.trim();
}

export function createHistoryConversationStore(storage?: Persistence) {
  let loaded = false; let threads: Thread[] = []; let activeId = ""; let snapshot = empty; let index = emptyThreads;
  const listeners = new Set<() => void>();
  const persistence = () => { try { return storage ?? (typeof window === "undefined" ? null : window.sessionStorage); } catch { return null; } };
  const current = () => threads.find((thread) => thread.id === activeId);
  const rebuild = () => { snapshot = current()?.messages ?? empty; index = threads.filter((thread) => thread.messages.length || thread.campaignId).map(({ id, title, updatedAt, campaignId }) => ({ id, title, updatedAt, campaignId })).reverse(); };
  const makeThread = (): Thread => ({ id: crypto.randomUUID(), title: "新对话", messages: [], context: [], campaignId: null, updatedAt: new Date().toISOString() });
  const load = () => {
    if (loaded || storage === undefined && typeof window === "undefined") return;
    loaded = true;
    try {
      const saved = JSON.parse(persistence()?.getItem(key) ?? "null");
      if (saved && Array.isArray(saved.threads) && typeof saved.activeId === "string" && saved.threads.every((t: Thread) => t && typeof t.id === "string" && typeof t.title === "string" && typeof t.updatedAt === "string" && (t.campaignId === null || typeof t.campaignId === "string") && messagesValid(t.messages) && contextValid(t.context))) {
        threads = saved.threads.map((t: Thread) => ({ ...t, messages: restoreMessages(t.messages) })); activeId = saved.activeId;
      } else {
        const previous = JSON.parse(persistence()?.getItem(legacyKey) ?? "null"); const messages = Array.isArray(previous) ? previous : previous?.messages;
        if (messagesValid(messages) && messages.length) {
          const thread = makeThread(); thread.messages = restoreMessages(messages); thread.context = contextValid(previous?.context) ? previous.context : messages.filter((m) => m.role === "user").map((m) => m.text.slice(0, 500)); thread.title = messages.find((m) => m.role === "user")?.text.slice(0, 40) || thread.title;
          threads = [thread]; activeId = thread.id;
        }
      }
    } catch { /* 浏览器禁止存储时，仍可在本页连续对话。 */ }
    if (!current()) { const thread = makeThread(); threads.push(thread); activeId = thread.id; }
    rebuild();
  };
  const commit = () => { rebuild(); try { persistence()?.setItem(key, JSON.stringify({ activeId, threads })); } catch { /* 存储空间不足不影响本页继续使用。 */ } listeners.forEach((listener) => listener()); };
  const stopCurrent = () => { const thread = current(); if (thread) thread.messages = finishPending(thread.messages); };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    serverSnapshot: () => empty,
    serverThreadsSnapshot: () => emptyThreads,
    serverActiveId: () => "",
    snapshot() { load(); return snapshot; },
    threadsSnapshot() { load(); return index; },
    activeId() { load(); return activeId; },
    context() { load(); return current()?.context ?? []; },
    campaignId() { load(); return current()?.campaignId ?? null; },
    update(change: (messages: HistoryMessage[]) => HistoryMessage[], expectedId?: string) {
      load(); if (expectedId !== undefined && expectedId !== activeId) return;
      const thread = current(); if (!thread) return;
      const before = thread.messages; const next = change(before);
      thread.context = [...thread.context, ...next.filter((m) => m.role === "user" && !before.some((old) => old.id === m.id)).map((m) => m.text.slice(0, 500))].slice(0, 200);
      if (!before.length && next.some((m) => m.role === "user")) thread.title = next.find((m) => m.role === "user")!.text.slice(0, 40);
      thread.messages = next.slice(-40); thread.updatedAt = new Date().toISOString(); commit();
    },
    bindCampaign(campaignId: string, title: string, expectedId: string) {
      load(); if (activeId !== expectedId || !current()) return false;
      const thread = current()!; thread.campaignId = campaignId; if (thread.title === "新对话") thread.title = title.slice(0, 40); thread.updatedAt = new Date().toISOString(); commit(); return true;
    },
    newConversation() {
      load(); stopCurrent(); threads = threads.filter((thread) => thread.messages.length || thread.campaignId);
      const thread = makeThread(); threads.push(thread); activeId = thread.id; commit(); return activeId;
    },
    selectConversation(id: string) {
      load(); if (!threads.some((thread) => thread.id === id)) return false;
      if (activeId === id) return true; stopCurrent(); activeId = id; commit(); return true;
    },
  };
}

// 消息按本次已读活动消息的锚点插入，不用两台机器的墙钟决定先后。
export function mergeConversationTimeline<T extends { id: string }, U extends { afterMessageId?: string }>(messages: readonly T[], extras: readonly U[]): Array<{ kind: "campaign"; message: T } | { kind: "extra"; message: U }> {
  const ids = new Set(messages.map((message) => message.id));
  const result: Array<{ kind: "campaign"; message: T } | { kind: "extra"; message: U }> = extras.filter((message) => !message.afterMessageId || !ids.has(message.afterMessageId)).map((message) => ({ kind: "extra", message }));
  for (const message of messages) { result.push({ kind: "campaign", message }); for (const extra of extras.filter((item) => item.afterMessageId === message.id)) result.push({ kind: "extra", message: extra }); }
  return result;
}
export const historyConversation = createHistoryConversationStore();
