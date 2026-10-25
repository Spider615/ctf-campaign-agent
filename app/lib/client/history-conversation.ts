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
// 与 analytics-access.ts 的 readAnalyticsJson 一致，限制完整 JSON 请求的 UTF-8 字节，保留原后端容量合同。
export const CONVERSATION_SAVE_MAX_BYTES = 2 * 1024 * 1024;
export type HistorySaveState = Readonly<{ status: "idle" | "pending" | "saving" | "saved" | "failed"; code?: "too_large" | "network" | "cancelled"; reason?: string; retryable?: boolean }>;
const idleSave: HistorySaveState = { status: "idle" };
const pendingSave: HistorySaveState = { status: "pending" };
const saving: HistorySaveState = { status: "saving" };
const saved: HistorySaveState = { status: "saved" };
class ConversationSaveError extends Error {
  readonly code: "too_large" | "network";
  readonly retryable: boolean;
  constructor(code: "too_large" | "network", reason: string, retryable: boolean) { super(reason); this.code = code; this.retryable = retryable; }
}
function saveFailure(error: unknown): HistorySaveState {
  if (error instanceof ConversationSaveError) return { status: "failed", code: error.code, reason: error.message, retryable: error.retryable };
  if (error instanceof Error && error.name === "AbortError") return { status: "failed", code: "cancelled", reason: "本次保存已取消，尚未确认保存成功。", retryable: true };
  return { status: "failed", code: "network", reason: error instanceof Error && error.message ? error.message : "对话记录暂时存不上", retryable: true };
}
// 服务端存储：每条对话整条覆盖写，按访问标识和范围读回。
export type RemoteThreads = { list(): Promise<unknown[]>; save(thread: Thread): Promise<void>; remove(id: string): Promise<void>; pointer?: Persistence };
export function remoteThreads(scope: string): RemoteThreads {
  const base = "/api/analytics/conversations";
  return {
    async list() {
      const response = await fetch(`${base}?scope=${encodeURIComponent(scope)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("对话记录暂时读不到");
      return ((await response.json()) as { threads?: unknown[] }).threads ?? [];
    },
    async save(thread) {
      const body = JSON.stringify({ scope, thread });
      const byteLength = new TextEncoder().encode(body).byteLength;
      if (byteLength > CONVERSATION_SAVE_MAX_BYTES) throw new ConversationSaveError("too_large", `当前对话请求为 ${byteLength.toLocaleString("zh-CN")} 字节，超过 2 MiB（${CONVERSATION_SAVE_MAX_BYTES.toLocaleString("zh-CN")} 字节）的保存上限。`, false);
      // 页面关闭时也尽量写完；keepalive 有 64KB 上限，超了就走普通请求。
      const response = await fetch(`${base}/${encodeURIComponent(thread.id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body, keepalive: byteLength < 60_000 });
      if (!response.ok) {
        const detail: unknown = await response.json().catch(() => null);
        const reason = detail && typeof detail === "object" && "error" in detail && typeof detail.error === "string" ? detail.error : `对话记录暂时存不上（HTTP ${response.status}）`;
        throw new ConversationSaveError(response.status === 413 ? "too_large" : "network", reason, response.status !== 413);
      }
    },
    async remove(id) {
      const response = await fetch(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("对话记录暂时删不掉");
    },
    // 只在本浏览器记住上次打开的是哪条对话；对话内容在服务端。
    pointer: { getItem: (k) => { try { return window.localStorage.getItem(`ctf:conversations:${scope}:${k}`); } catch { return null; } }, setItem: (k, v) => { try { window.localStorage.setItem(`ctf:conversations:${scope}:${k}`, v); } catch { /* 记不住上次打开的对话不影响使用。 */ } } },
  };
}
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
const threadValid = (t: Thread) => Boolean(t) && typeof t.id === "string" && typeof t.title === "string" && typeof t.updatedAt === "string" && (t.campaignId === null || typeof t.campaignId === "string") && (t.unread === undefined || typeof t.unread === "boolean") && messagesValid(t.messages) && contextValid(t.context);
const restoreThread = (t: Thread): Thread => { const { focus, ...rest } = t; return { ...rest, messages: restoreMessages(t.messages), ...(focusValid(focus) ? { focus } : {}) }; };
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

// 有 remote 时对话以服务端为准：浏览器存储只当缓存，打开页面后从服务端读回，改动按条写回。
export function createHistoryConversationStore(storage?: Persistence, remote?: RemoteThreads) {
  let loaded = false; let threads: Thread[] = []; let activeId = ""; let snapshot = empty; let index = emptyThreads;
  const listeners = new Set<() => void>();
  const saveListeners = new Set<() => void>();
  const saveStates = new Map<string, HistorySaveState>();
  let saveActiveId = "";
  const revisions = new Map<string, number>();
  const setSaveState = (id: string, state: HistorySaveState) => {
    if (deleted.has(id) || saveStates.get(id) === state) return;
    saveStates.set(id, state); saveListeners.forEach((listener) => listener());
  };
  // 服务端同步：读回之前不写，免得旧缓存盖掉别的标签页刚存的；删掉的对话不让迟到的读回结果复活。
  let synced: Promise<void> | null = null; const dirty = new Set<string>(); const deleted = new Set<string>(); let timer: ReturnType<typeof setTimeout> | undefined;
  const worth = (thread: Thread) => thread.messages.length > 0 || thread.campaignId !== null;
  // 同一时间只有一轮写回，免得同一条对话的旧内容后到、盖掉新内容。
  let flushing: Promise<void> | null = null;
  const failures = new Map<string, number>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  const queue = (delay: number) => {
    if (flushing || timer || ![...dirty].some((id) => !retries.has(id))) return;
    timer = setTimeout(() => { timer = undefined; void flush(); }, delay);
  };
  const flush = (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (!remote || !synced) return Promise.resolve();
    if (flushing) return flushing;
    flushing = (async () => {
      await synced;
      for (const id of [...dirty]) {
        if (retries.has(id)) continue;
        dirty.delete(id); const thread = threads.find((item) => item.id === id); if (!thread || !worth(thread)) continue;
        const revision = revisions.get(id) ?? 0;
        setSaveState(id, saving);
        try {
          // 整条发送时取快照；后续流式更新不能改变这次请求，更不能被旧请求的成功误标为已保存。
          await remote.save(structuredClone(thread)); failures.delete(id);
          if (!deleted.has(id) && revision === (revisions.get(id) ?? 0) && !dirty.has(id)) setSaveState(id, saved);
        } catch (error) {
          if (deleted.has(id) || revision !== (revisions.get(id) ?? 0)) continue;
          const state = saveFailure(error); setSaveState(id, state);
          // 超限等确定性失败不后台循环；新内容或显式重试会重新排队。
          if (!state.retryable) continue;
          dirty.add(id); const count = (failures.get(id) ?? 0) + 1; failures.set(id, count);
          retries.set(id, setTimeout(() => { retries.delete(id); void flush(); }, Math.min(30_000, 2000 * 2 ** count)));
        }
      }
    })().finally(() => { flushing = null; queue(0); });
    return flushing;
  };
  // 流式回答每一小段都会改消息，合并成每秒最多写一次。
  const schedule = (id: string) => {
    if (!remote) return;
    revisions.set(id, (revisions.get(id) ?? 0) + 1); dirty.add(id);
    if (saveStates.get(id)?.status !== "failed") setSaveState(id, pendingSave);
    queue(1000);
  };
  const pull = () => remote!.list().then((stored) => {
    const local = new Map(threads.map((thread) => [thread.id, thread]));
    const fromServer = stored.filter((t): t is Thread => threadValid(t as Thread) && !deleted.has((t as Thread).id)).map(restoreThread);
    const merged = fromServer.map((server) => {
      const mine = local.get(server.id);
      if (mine && (dirty.has(server.id) || mine.updatedAt > server.updatedAt)) return mine;
      setSaveState(server.id, saved); return server;
    });
    const known = new Set(merged.map((thread) => thread.id));
    // 只在本浏览器有、或本地更新的对话（含迁移前的旧记录）补写到服务端。
    for (const thread of threads) if (!known.has(thread.id) || local.get(thread.id) === merged.find((item) => item.id === thread.id)) { if (worth(thread)) { dirty.add(thread.id); setSaveState(thread.id, pendingSave); } }
    threads = [...merged, ...threads.filter((thread) => !known.has(thread.id))];
    // 用户还没开始聊时切到上次打开的那条；已经在新对话里聊了、或从洞察带着焦点过来的就不打断。
    if (!current() || !worth(current()!) && !current()!.focus) {
      const remembered = remote!.pointer?.getItem("active"); const target = threads.find((thread) => thread.id === remembered && worth(thread)) ?? threads.filter(worth).at(-1);
      if (target) { threads = threads.filter((thread) => worth(thread) || thread.id === target.id); activeId = target.id; }
    }
    commit();
  }).catch(() => { /* 服务端读不到时继续用本页记录，之后的改动照常尝试写回。 */ });
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
      if (saved && Array.isArray(saved.threads) && typeof saved.activeId === "string" && saved.threads.every(threadValid)) {
        threads = saved.threads.map(restoreThread); activeId = saved.activeId;
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
    if (remote) {
      synced = pull(); void synced.then(flush);
      // 关页面前把没写完的改动发出去（fetch keepalive）。
      if (typeof window !== "undefined") window.addEventListener("pagehide", () => {
        if (!dirty.size) return;
        for (const waiting of retries.values()) clearTimeout(waiting); retries.clear();
        void flush();
      });
    }
  };
  const commit = (changed?: string) => {
    rebuild(); if (changed) schedule(changed);
    try { persistence()?.setItem(key, JSON.stringify({ activeId, threads })); } catch { /* 存储空间不足不影响本页继续使用。 */ }
    remote?.pointer?.setItem("active", activeId);
    listeners.forEach((listener) => listener());
    if (saveActiveId !== activeId) { saveActiveId = activeId; saveListeners.forEach((listener) => listener()); }
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeSaveState(listener: () => void) { saveListeners.add(listener); return () => { saveListeners.delete(listener); }; },
    serverSaveState: () => idleSave,
    saveState(id?: string) { load(); return saveStates.get(id ?? activeId) ?? idleSave; },
    async retrySave(id?: string) {
      load(); const target = id ?? activeId;
      if (!remote || deleted.has(target) || !threads.some((thread) => thread.id === target && worth(thread))) return;
      const waiting = retries.get(target); if (waiting) clearTimeout(waiting); retries.delete(target); failures.delete(target);
      dirty.add(target); setSaveState(target, pendingSave);
      if (flushing) await flushing;
      if (dirty.has(target)) await flush();
    },
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
      if (focus) thread.focus = focus; else delete thread.focus; commit(thread.id);
    },
    // 指定对话 id 时写进那一条对话，不管它当前是否打开：切走后仍在跑的回答照样落到自己的对话里。
    update(change: (messages: HistoryMessage[]) => HistoryMessage[], expectedId?: string) {
      load(); const thread = expectedId === undefined ? current() : threads.find((item) => item.id === expectedId); if (!thread) return;
      const before = thread.messages; const next = change(before);
      thread.context = [...thread.context, ...next.filter((m) => m.role === "user" && !before.some((old) => old.id === m.id)).map((m) => m.text.slice(0, 500))].slice(0, 200);
      if (!before.length && next.some((m) => m.role === "user")) thread.title = next.find((m) => m.role === "user")!.text.slice(0, 40);
      if (thread.id !== activeId && settled(before, next)) thread.unread = true;
      thread.messages = next.slice(-40); thread.updatedAt = new Date().toISOString(); commit(thread.id);
    },
    // 一条对话只绑一个活动；已绑过的不让迟到的建活动结果改掉。
    bindCampaign(campaignId: string, title: string, expectedId: string) {
      load(); const thread = threads.find((item) => item.id === expectedId); if (!thread || thread.campaignId) return false;
      thread.campaignId = campaignId; if (thread.title === "新对话") thread.title = title.slice(0, 40); thread.updatedAt = new Date().toISOString(); commit(thread.id); return true;
    },
    newConversation() {
      load(); threads = threads.filter((thread) => thread.messages.length || thread.campaignId);
      const thread = makeThread(); threads.push(thread); activeId = thread.id; commit(); return activeId;
    },
    selectConversation(id: string) {
      load(); const thread = threads.find((item) => item.id === id); if (!thread) return false;
      if (activeId === id && !thread.unread) return true; const wasUnread = thread.unread; activeId = id; delete thread.unread; commit(wasUnread ? id : undefined); return true;
    },
    // 回复来自别处（如对话里嵌着的活动）时由调用方标记；用户正看着这条对话时不标。
    markUnread(id: string) {
      load(); const thread = threads.find((item) => item.id === id); if (!thread || thread.id === activeId || thread.unread) return;
      thread.unread = true; commit(thread.id);
    },
    // 活动回复结束时按活动 id 找到它所在的对话再标记。
    markCampaignUnread(campaignId: string) {
      load(); const thread = threads.find((item) => item.campaignId === campaignId); if (thread) this.markUnread(thread.id);
    },
    // 删的是当前对话时切到剩下的最近一条，没有就留一条空对话；服务端的记录一起删。
    deleteConversation(id: string) {
      load(); if (!threads.some((thread) => thread.id === id)) return false;
      threads = threads.filter((thread) => thread.id !== id); dirty.delete(id); deleted.add(id);
      const waiting = retries.get(id); if (waiting) clearTimeout(waiting); retries.delete(id); failures.delete(id); revisions.delete(id); saveStates.delete(id);
      if (remote) void (synced ?? Promise.resolve()).then(() => remote.remove(id)).catch(() => { /* 下次打开时这条还会出现，可以再删。 */ });
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
export const historyConversation = createHistoryConversationStore(undefined, typeof window === "undefined" ? undefined : remoteThreads("analysis"));
