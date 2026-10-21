import { restoreVisualizationProgress, type VisualizationProgressState } from "../analytics/visualization-progress.ts";
import { RETIRED_ANALYSIS_ANSWER_SCHEMA } from "../analytics/analysis-v2-types.ts";
import type { DatabaseExplainRequest } from "../analytics/database.ts";
import type { AgentTraceEvent } from "../tool-trace.ts";
import { analyticsAnswerText, isPlanAnswer, validateAnalyticsAnswerResult, type AnalyticsAnswerResult } from "../analytics/stream.ts";
import { isConversationAnswer } from "../attachments/answer.ts";
import type { AttachmentReference, ConversationRequest } from "../attachments/types.ts";
import type { InsightFocus } from "../insight/context.ts";

export type HistoryMessage = { id: string; role: "user" | "assistant"; text: string; createdAt: string; answer?: AnalyticsAnswerResult; request?: DatabaseExplainRequest | ConversationRequest; attachments?: AttachmentReference[]; status?: "running" | "done" | "failed" | "cancelled"; trace?: AgentTraceEvent[]; startedAt?: number; durationMs?: number; phase?: "analyzing" | "writing"; visualizationState?: VisualizationProgressState; afterMessageId?: string };
export function replaceHistoryAttachment(messages: HistoryMessage[], previousId: string, file: AttachmentReference): HistoryMessage[] {
  return messages.map((message) => ({ ...message,
    ...(message.attachments ? { attachments: [...new Map(message.attachments.map((item) => item.id === previousId ? file : item).map((item) => [item.id, item])).values()] } : {}),
    ...(message.request && "attachmentIds" in message.request ? { request: { ...message.request, attachmentIds: [...new Set(message.request.attachmentIds.map((id) => id === previousId ? file.id : id))] } } : {}),
  }));
}
// unread：回复在用户没看着这条对话时结束，侧栏标小红点；打开这条对话即清除。
// focus：从洞察带过来的「正在看」，跟着对话存，刷新、切走再切回来都还在。
type Thread = { id: string; title: string; messages: HistoryMessage[]; context: string[]; campaignId: string | null; updatedAt: string; unread?: boolean; focus?: InsightFocus };
export type ConversationSummary = Pick<Thread, "id" | "title" | "updatedAt" | "campaignId" | "unread">;
type Persistence = { getItem(key: string): string | null; setItem(key: string, value: string): void };
const key = "ctf:conversations:v2"; const legacyKey = "ctf:history-conversation:v1";
const empty: HistoryMessage[] = []; const emptyThreads: ConversationSummary[] = [];
const messagesValid = (value: unknown): value is HistoryMessage[] => Array.isArray(value) && value.length <= 40 && value.every((item) => item && typeof item.id === "string" && ["user", "assistant"].includes(item.role) && typeof item.text === "string" && typeof item.createdAt === "string");
const contextValid = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 200 && value.every((text) => typeof text === "string" && text.length <= 500);
const text = (value: unknown) => typeof value === "string" && value.length <= 2000;
// 存储里的 focus 只认结构完整的；节点 id 是否还在图上由用的地方再看，这里不依赖图谱。
const focusValid = (value: unknown): value is InsightFocus => {
  const f = value as Record<string, unknown> | null;
  return Boolean(f) && typeof f === "object" && text(f!.label) && (f!.kind === "node" ? text(f!.id) : f!.kind === "edge" && text(f!.from) && text(f!.to) && text(f!.basis));
};
const finishPending = (messages: HistoryMessage[]) => messages.map((m) => m.status === "running" ? { ...m, status: "cancelled" as const, text: "上次等待已结束，可以继续追问或重新分析。" } : m);
const restoreMessages = (messages: HistoryMessage[]) => finishPending(messages).map((stored) => {
  const message = { ...stored, ...(stored.visualizationState === undefined ? {} : { visualizationState: restoreVisualizationProgress(stored.visualizationState) }) };
  // 旧记录保留旧合同；新记录恢复时重新核验，不能凭存储里的正文绕过引用检查。
  if (!message.answer || !("schema" in message.answer)) return message;
  // v2 旧答案的结构化合同已退役：恢复时只保留已存的正文，不再渲染也不再参与后续上下文。
  if ((message.answer as { schema: string }).schema === RETIRED_ANALYSIS_ANSWER_SCHEMA) return { ...message, answer: undefined, status: message.status ?? "done" as const };
  try { const answer = validateAnalyticsAnswerResult(message.answer); return { ...message, answer, text: analyticsAnswerText(answer) }; }
  catch { return { ...message, answer: undefined, status: "failed" as const, text: "上次回答未通过完整性核验，请重新分析。" }; }
});

export function historyMessageContext(message: HistoryMessage): string {
  if (!message.answer) return message.text;
  if (isConversationAnswer(message.answer)) return `以下为用户上传资料的问答，不等同于已核验经营数据或执行事实：${message.answer.blocks.map((block) => block.text).join("\n\n")}`;
  if (isPlanAnswer(message.answer)) return `${message.text}\n${analyticsAnswerText(message.answer)}`.trim();
  return `${message.text}\n${message.answer.sources?.map((source) => `已查询范围：${source.scope}；口径：${source.definition}`).join("\n") ?? ""}`.trim();
}

export function createHistoryConversationStore(storage?: Persistence) {
  let loaded = false; let threads: Thread[] = []; let activeId = ""; let snapshot = empty; let index = emptyThreads;
  const listeners = new Set<() => void>();
  const persistence = () => { try { return storage ?? (typeof window === "undefined" ? null : window.sessionStorage); } catch { return null; } };
  const current = () => threads.find((thread) => thread.id === activeId);
  const rebuild = () => { snapshot = current()?.messages ?? empty; index = threads.filter((thread) => thread.messages.length || thread.campaignId).map(({ id, title, updatedAt, campaignId, unread }) => ({ id, title, updatedAt, campaignId, ...(unread ? { unread } : {}) })).reverse(); };
  // 回复结束：消息从进行中变为完成、失败或已停止。
  const settled = (before: HistoryMessage[], next: HistoryMessage[]) => next.some((message) => message.role === "assistant" && message.status !== undefined && message.status !== "running" && before.find((old) => old.id === message.id)?.status === "running");
  const makeThread = (): Thread => ({ id: crypto.randomUUID(), title: "新对话", messages: [], context: [], campaignId: null, updatedAt: new Date().toISOString() });
  const load = () => {
    if (loaded || storage === undefined && typeof window === "undefined") return;
    loaded = true;
    try {
      const saved = JSON.parse(persistence()?.getItem(key) ?? "null");
      if (saved && Array.isArray(saved.threads) && typeof saved.activeId === "string" && saved.threads.every((t: Thread) => t && typeof t.id === "string" && typeof t.title === "string" && typeof t.updatedAt === "string" && (t.campaignId === null || typeof t.campaignId === "string") && (t.unread === undefined || typeof t.unread === "boolean") && messagesValid(t.messages) && contextValid(t.context))) {
        threads = saved.threads.map((t: Thread) => { const { focus, ...rest } = t; return { ...rest, messages: restoreMessages(t.messages), ...(focusValid(focus) ? { focus } : {}) }; }); activeId = saved.activeId;
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
    focus() { load(); return current()?.focus ?? null; },
    // 设在当前对话上；传 null 是用户点了 × 移除。
    setFocus(focus: InsightFocus | null) {
      load(); const thread = current(); if (!thread || (thread.focus ?? null) === focus) return;
      if (focus) thread.focus = focus; else delete thread.focus; commit();
    },
    // 指定对话 id 时写进那一条对话，不管它当前是否打开：切走后仍在跑的回答照样落到自己的对话里。
    update(change: (messages: HistoryMessage[]) => HistoryMessage[], expectedId?: string) {
      load(); const thread = expectedId === undefined ? current() : threads.find((item) => item.id === expectedId); if (!thread) return;
      const before = thread.messages; const next = change(before);
      thread.context = [...thread.context, ...next.filter((m) => m.role === "user" && !before.some((old) => old.id === m.id)).map((m) => m.text.slice(0, 500))].slice(0, 200);
      if (!before.length && next.some((m) => m.role === "user")) thread.title = next.find((m) => m.role === "user")!.text.slice(0, 40);
      if (thread.id !== activeId && settled(before, next)) thread.unread = true;
      thread.messages = next.slice(-40); thread.updatedAt = new Date().toISOString(); commit();
    },
    // 一条对话只绑一个活动；已绑过的不让迟到的建活动结果改掉。
    bindCampaign(campaignId: string, title: string, expectedId: string) {
      load(); const thread = threads.find((item) => item.id === expectedId); if (!thread || thread.campaignId) return false;
      thread.campaignId = campaignId; if (thread.title === "新对话") thread.title = title.slice(0, 40); thread.updatedAt = new Date().toISOString(); commit(); return true;
    },
    newConversation() {
      load(); threads = threads.filter((thread) => thread.messages.length || thread.campaignId);
      const thread = makeThread(); threads.push(thread); activeId = thread.id; commit(); return activeId;
    },
    selectConversation(id: string) {
      load(); const thread = threads.find((item) => item.id === id); if (!thread) return false;
      if (activeId === id && !thread.unread) return true; activeId = id; delete thread.unread; commit(); return true;
    },
    // 回复来自别处（如对话里嵌着的活动）时由调用方标记；用户正看着这条对话时不标。
    markUnread(id: string) {
      load(); const thread = threads.find((item) => item.id === id); if (!thread || thread.id === activeId || thread.unread) return;
      thread.unread = true; commit();
    },
    // 活动回复结束时按活动 id 找到它所在的对话再标记。
    markCampaignUnread(campaignId: string) {
      load(); const thread = threads.find((item) => item.campaignId === campaignId); if (thread) this.markUnread(thread.id);
    },
    // 删除只动本浏览器保存的对话记录；删的是当前对话时切到剩下的最近一条，没有就留一条空对话。
    deleteConversation(id: string) {
      load(); if (!threads.some((thread) => thread.id === id)) return false;
      threads = threads.filter((thread) => thread.id !== id);
      if (activeId === id) {
        const latest = threads.filter((thread) => thread.messages.length || thread.campaignId).at(-1);
        if (latest) activeId = latest.id; else { const thread = makeThread(); threads.push(thread); activeId = thread.id; }
      }
      commit(); return true;
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
