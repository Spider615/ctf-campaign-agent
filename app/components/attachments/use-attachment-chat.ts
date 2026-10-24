"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { attachmentReferences, postAttachmentStream, retryConversationAttachments, UnavailableAttachmentsError } from "../../lib/client/attachments";
import { createHistoryConversationStore, remoteThreads, historyMessageContext, replaceHistoryAttachment, type HistoryMessage } from "../../lib/client/history-conversation";
import type { AttachmentReference, ConversationRequest } from "../../lib/attachments/types";
import { reduceVisualizationProgress } from "../../lib/analytics/visualization-progress.ts";
import { analyticsAnswerText } from "../../lib/analytics/stream";
import { mergeTraceEvent } from "../../lib/tool-trace";
import type { Snapshot } from "../../lib/server/turns";
import { messageToText } from "../../lib/campaign/ics1811/messages";
import { useAttachmentAvailability } from "./use-attachment-availability";
import { fileTurns } from "../../lib/client/background-turns";

// 同一活动的文件问答记录在模块里只建一份：切走后仍在跑的回答写进这一份，切回来的新界面读到的也是它。
const stores = new Map<string, ReturnType<typeof createHistoryConversationStore>>();
function storeOf(conversationId: string) {
  let store = stores.get(conversationId);
  if (!store) {
    store = createHistoryConversationStore({ getItem: (key) => typeof window === "undefined" ? null : window.sessionStorage.getItem(`ctf:campaign-files:${conversationId}:${key}`), setItem: (key, value) => { window.sessionStorage.setItem(`ctf:campaign-files:${conversationId}:${key}`, value); } }, remoteThreads(`campaign-files:${conversationId}`));
    stores.set(conversationId, store);
  }
  return store;
}

// 活动里的文件问答按活动存到服务端（scope campaign-files:<活动 id>），不改变 Campaign 的持久化事实。
export function useAttachmentChat(conversationId: string) {
  const [store] = useState(() => storeOf(conversationId));
  const messages = useSyncExternalStore(store.subscribe, store.snapshot, store.serverSnapshot);
  const busy = useSyncExternalStore(fileTurns.subscribe, () => fileTurns.has(conversationId), () => false);
  const markUnavailable = useCallback((ids: string[]) => store.update((messages) => messages.map((message) => ({ ...message, ...(message.attachments ? { attachments: message.attachments.map((file) => ids.includes(file.id) ? { ...file, unavailable: true } : file) } : {}) }))), [store]);
  useAttachmentAvailability(conversationId, messages, markUnavailable);
  const perform = async (request: ConversationRequest, id: string, retryFiles = false) => {
    const started = performance.now(); const entry = fileTurns.begin(conversationId, { id, started }); if (!entry) return;
    const { controller, token } = entry; const live = () => fileTurns.isLive(conversationId, token);
    store.update((messages) => messages.map((message) => message.id === id ? { ...message, text: "", status: "running", trace: [], answer: undefined, visualizationState: undefined, startedAt: Date.now() } : message));
    try {
      if (retryFiles) request = await retryConversationAttachments(request, (previousId, file) => {
        if (live()) store.update((messages) => replaceHistoryAttachment(messages, previousId, file));
      }, controller.signal);
      const answer = await postAttachmentStream(request, (event) => {
        if (!live()) return;
        store.update((messages) => messages.map((message) => message.id !== id ? message : event.type === "trace" ? { ...message, trace: mergeTraceEvent(message.trace ?? [], event.event) } : event.type === "visualization" ? { ...message, visualizationState: reduceVisualizationProgress(message.visualizationState, event) } : { ...message, phase: event.phase }));
      }, controller.signal);
      if (!controller.signal.aborted) store.update((messages) => messages.map((message) => message.id === id ? { ...message, status: "done", answer, visualizationState: undefined, text: analyticsAnswerText(answer), durationMs: performance.now() - started, createdAt: new Date().toISOString() } : message));
    } catch (error) { if (error instanceof UnavailableAttachmentsError) markUnavailable(error.ids); if (!controller.signal.aborted) store.update((messages) => messages.map((message) => message.id === id ? { ...message, status: "failed", text: error instanceof Error ? error.message : "文件回答暂未完成，可以重试", durationMs: performance.now() - started } : message)); }
    finally { fileTurns.end(conversationId, token); }
  };
  return {
    messages, busy,
    hasFiles: attachmentReferences(messages).length > 0,
    send(text: string, files: AttachmentReference[], snapshot: Snapshot) {
      if (fileTurns.has(conversationId)) return;
      const refs = [...new Map([...attachmentReferences(messages), ...files].map((file) => [file.id, file])).values()];
      const history = [...snapshot.messages.slice(-5).map((message) => ({ role: message.role, text: `当前活动对话，不能当作上传资料：${messageToText(message.content)}`.slice(0, 4000) })), ...messages.slice(-5).map((message) => ({ role: message.role, text: historyMessageContext(message).slice(0, 4000) }))].slice(-10);
      const context = [...new Set([...store.context(), ...snapshot.messages.filter((message) => message.role === "user").map((message) => messageToText(message.content).slice(0, 500))])].slice(-200);
      const request: ConversationRequest = { conversationId, question: text.slice(0, 500), attachmentIds: refs.map((file) => file.id), history, context };
      const id = crypto.randomUUID(); const createdAt = new Date().toISOString(); const afterMessageId = snapshot.messages.at(-1)?.id;
      store.update((messages) => [...messages, { id: crypto.randomUUID(), role: "user", text, attachments: files, createdAt, afterMessageId }, { id, role: "assistant", text: "", status: "running", attachments: refs, request, createdAt, afterMessageId }]);
      void perform(request, id);
    },
    stop() { const turn = fileTurns.abort(conversationId); if (!turn) return; const { id, started } = turn.state; store.update((messages) => messages.map((message) => message.id === id ? { ...message, status: "cancelled", text: "已停止本次文件回答，可以继续追问。", durationMs: performance.now() - started } : message)); },
    retry(message: HistoryMessage) { if (message.request && "attachmentIds" in message.request) void perform(message.request, message.id, true); },
    deleted(id: string) { store.update((messages) => messages.map((message) => ({ ...message, ...(message.attachments ? { attachments: message.attachments.map((file) => file.id === id ? { ...file, deleted: true } : file) } : {}) }))); },
  };
}
