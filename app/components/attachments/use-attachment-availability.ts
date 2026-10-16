"use client";

import { useEffect } from "react";
import { attachmentReferences, listAttachments } from "../../lib/client/attachments";
import type { AttachmentReference } from "../../lib/attachments/types";

// 恢复会话和返回页面时核验引用；网络错误不能被误判为用户删除文件。
export function useAttachmentAvailability(conversationId: string, messages: ReadonlyArray<{ attachments?: AttachmentReference[] }>, markUnavailable: (ids: string[]) => void) {
  const refs = attachmentReferences(messages); const key = refs.map((item) => `${item.id}/${item.version}`).sort().join(",");
  useEffect(() => {
    if (!conversationId || !key) return;
    const controller = new AbortController();
    const check = async () => {
      try {
        const files = new Map((await listAttachments(conversationId, controller.signal)).map((file) => [file.id, file]));
        const missing = key.split(",").filter((entry) => { const [id, version] = entry.split("/"); return files.get(id)?.version !== version; }).map((entry) => entry.split("/")[0]);
        if (!controller.signal.aborted && missing.length) markUnavailable(missing);
      } catch { /* 请求失败时保留原引用，提交前会再次验证并明确反馈。 */ }
    };
    void check(); window.addEventListener("focus", check);
    return () => { controller.abort(); window.removeEventListener("focus", check); };
  }, [conversationId, key, markUnavailable]);
}
