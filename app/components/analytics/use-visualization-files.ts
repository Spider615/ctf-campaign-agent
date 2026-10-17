"use client";

import { useEffect, useState } from "react";
import { AttachmentRequestError, getAttachment } from "../../lib/client/attachments.ts";

export type VisualizationFileReference = { id: string; version: string };
export function useVisualizationFiles(conversationId: string | undefined, files: readonly VisualizationFileReference[]) {
  const key = [...new Set(files.map((file) => `${file.id}/${file.version}`))].sort().join(",");
  const identity = `${conversationId ?? ""}:${key}`;
  const [result, setResult] = useState({ key: "", status: "checking" as "checking" | "available" | "unavailable" | "error" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!key || !conversationId) return;
    const controller = new AbortController(); let expiry: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const entries = key.split(",");
        const sources = await Promise.all(entries.map((entry) => getAttachment(conversationId, entry.split("/")[0], controller.signal)));
        if (controller.signal.aborted) return;
        const valid = sources.every((source, at) => source.version === entries[at].split("/")[1] && ["ready", "partial"].includes(source.status));
        setResult({ key: identity, status: valid ? "available" : "unavailable" });
        const deadline = Math.min(...sources.map((source) => Date.parse(source.expiresAt)));
        clearTimeout(expiry);
        if (valid && Number.isFinite(deadline)) expiry = setTimeout(() => { if (!controller.signal.aborted) void check(); }, Math.max(100, Math.min(2147483647, deadline - Date.now())));
      } catch (error) {
        if (!controller.signal.aborted) setResult({ key: identity, status: error instanceof AttachmentRequestError && [401, 403, 404, 410].includes(error.status) ? "unavailable" : "error" });
      }
    };
    const removed = (event: Event) => { const detail = (event as CustomEvent<{ conversationId: string; id: string }>).detail; if (detail?.conversationId === conversationId && key.split(",").some((entry) => entry.startsWith(`${detail.id}/`))) { controller.abort(); clearTimeout(expiry); setResult({ key: identity, status: "unavailable" }); } };
    void check(); window.addEventListener("focus", check); window.addEventListener("ctf:attachment-removed", removed);
    return () => { controller.abort(); clearTimeout(expiry); window.removeEventListener("focus", check); window.removeEventListener("ctf:attachment-removed", removed); };
  }, [conversationId, key, identity, retry]);
  return { status: !key ? "available" : !conversationId ? "unavailable" : result.key !== identity ? "checking" : result.status, retry: () => { setResult({ key: identity, status: "checking" }); setRetry((value) => value + 1); } };
}
