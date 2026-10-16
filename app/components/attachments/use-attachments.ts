"use client";

import { useSyncExternalStore } from "react";
import type { AttachmentReference, AttachmentSummary } from "../../lib/attachments/types";
import { uploadAttachment, getAttachment, retryAttachment, validateAttachmentSelection } from "../../lib/client/attachments";

export type DraftAttachment = { key: string; name: string; size: number; status: "uploading" | AttachmentSummary["status"]; attachment?: AttachmentSummary; error?: string; file?: File };
type State = { files: DraftAttachment[]; error: string };
const empty: State = { files: [], error: "" };
const stores = new Map<string, ReturnType<typeof createDraft>>();
function createDraft(conversationId: string) {
  let state = empty; const listeners = new Set<() => void>(); const active = new Map<string, AbortController>();
  const update = (change: (state: State) => State) => { state = change(state); listeners.forEach((listener) => listener()); };
  const patch = (key: string, change: Partial<DraftAttachment>) => update((state) => ({ ...state, files: state.files.map((item) => item.key === key ? { ...item, ...change } : item) }));
  const execute = async (key: string, retry = false) => {
    const original = state.files.find((item) => item.key === key); if (!original) return;
    const controller = new AbortController(); active.get(key)?.abort(); active.set(key, controller); patch(key, { status: "uploading", error: undefined });
    try {
      let attachment = retry && original.attachment ? await retryAttachment(conversationId, original.attachment.id, controller.signal) : original.file ? await uploadAttachment(conversationId, original.file, controller.signal) : undefined;
      if (!attachment) throw new Error("请重新选择这个文件");
      while (!controller.signal.aborted) {
        patch(key, { attachment, status: attachment.status, error: attachment.error });
        if (!["queued", "processing"].includes(attachment.status)) break;
        await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 600); const stop = () => { clearTimeout(timer); resolve(); }; controller.signal.addEventListener("abort", stop, { once: true }); setTimeout(() => controller.signal.removeEventListener("abort", stop), 650); });
        if (!controller.signal.aborted) attachment = await getAttachment(conversationId, attachment.id, controller.signal);
      }
    } catch (error) { if (!controller.signal.aborted) patch(key, { status: "failed", error: error instanceof Error ? error.message : "上传失败，可以重试" }); }
    finally { if (active.get(key) === controller) active.delete(key); }
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => state,
    serverSnapshot: () => empty,
    select(files: File[]) {
      if (!conversationId) return;
      try {
        const selected = validateAttachmentSelection(state.files, files); const additions = selected.map((file) => ({ key: crypto.randomUUID(), name: file.name, size: file.size, status: "uploading" as const, file }));
        update((state) => ({ files: [...state.files, ...additions], error: "" })); for (const item of additions) void execute(item.key);
      } catch (error) { update((state) => ({ ...state, error: error instanceof Error ? error.message : "文件无法选择" })); }
    },
    remove(key: string) { active.get(key)?.abort(); active.delete(key); update((state) => ({ files: state.files.filter((item) => item.key !== key), error: "" })); },
    retry(key: string) { void execute(key, true); },
    clear() { for (const controller of active.values()) controller.abort(); active.clear(); update(() => empty); },
    references(): AttachmentReference[] { return [...new Map(state.files.flatMap((item) => item.attachment ? [[item.attachment.id, item.attachment] as const] : [])).values()].map(({ id, conversationId, name, size, status, version, imageCount }) => ({ id, conversationId, name, size, status, version, imageCount })); },
  };
}

export function useAttachmentDraft(conversationId: string) {
  let store = stores.get(conversationId); if (!store) { store = createDraft(conversationId); stores.set(conversationId, store); }
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.serverSnapshot);
  return { ...state, select: store.select, remove: store.remove, retry: store.retry, clear: store.clear, references: store.references,
    ready: state.files.length > 0 && state.files.every((item) => item.status === "ready" || item.status === "partial") };
}
export type AttachmentDraft = ReturnType<typeof useAttachmentDraft>;
