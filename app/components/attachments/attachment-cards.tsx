"use client";

import { File, Loader2, RotateCcw, X, Download, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { AttachmentReference, AttachmentSummary } from "../../lib/attachments/types";
import { attachmentUrl, deleteAttachment, getAttachment } from "../../lib/client/attachments";
import type { AttachmentDraft } from "./use-attachments";

const sizeText = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
function AttachmentIssues({ item }: { item: AttachmentReference }) {
  const [file, setFile] = useState<AttachmentSummary>();
  useEffect(() => {
    if (item.deleted || item.unavailable) return;
    let stopped = false;
    const load = () => { void getAttachment(item.conversationId, item.id).then((value) => { if (!stopped) setFile(value); }).catch(() => {}); };
    const updated = (event: Event) => { const detail = (event as CustomEvent<{ conversationId: string; ids: string[] }>).detail; if (detail?.conversationId === item.conversationId && detail.ids.includes(item.id)) load(); };
    load(); window.addEventListener("ctf:attachments-processed", updated);
    return () => { stopped = true; window.removeEventListener("ctf:attachments-processed", updated); };
  }, [item.conversationId, item.id, item.deleted, item.unavailable]);
  const entries = file?.entries.filter((entry) => entry.status !== "ready") ?? [];
  if (!entries.length) return null;
  return <details className="max-w-full text-left text-xs leading-5 text-[#627b96]">
    <summary className="cursor-pointer py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">未处理文件</summary>
    <ul aria-label="未处理文件清单" className="max-h-60 space-y-2 overflow-y-auto border-t border-[#dbe8f7] py-2">{entries.map((entry, index) => <li key={index} className="break-words"><span className="font-medium">{entry.path}</span>{entry.detail ? `：${entry.detail}` : "：暂时无法完整处理"}</li>)}</ul>
  </details>;
}

export function DraftAttachmentCards({ draft }: { draft: AttachmentDraft }) {
  if (!draft.files.length && !draft.error) return null;
  return <div className="space-y-2 px-2 pt-2">
    <ul aria-label="待发送附件" className="grid max-h-60 gap-2 overflow-y-auto sm:grid-cols-2">{draft.files.map((item) => {
      const waiting = item.status === "uploading"; const failed = !waiting && !["uploaded", "queued", "processing", "ready", "partial"].includes(item.status);
      return <li key={item.key} className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2 ${failed ? "border-[#edc9c4] bg-[#fff6f3]" : "border-[#d5e4f5] bg-[#f3f8ff]"}`}>
        {waiting ? <Loader2 aria-hidden="true" className="size-5 shrink-0 animate-spin text-[#247cff] motion-reduce:animate-none" /> : <File aria-hidden="true" className="size-5 shrink-0 text-[#54769a]" />}
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-[#27415f]" title={item.name}>{item.name}</p><p className="mt-0.5 text-xs leading-5 text-[#627b96]" role="status">{sizeText(item.size)} · {waiting ? "正在上传" : failed ? "上传失败" : "已上传"}</p>{item.error ? <p role="alert" className="break-words text-xs leading-5 text-[#a43f37]">{item.error}</p> : null}</div>
        {failed ? <button type="button" onClick={() => draft.retry(item.key)} aria-label={`重试上传 ${item.name}`} className="grid min-h-11 min-w-11 place-items-center rounded-lg text-[#2470cc] hover:bg-white focus-visible:ring-2 focus-visible:ring-ring"><RotateCcw aria-hidden="true" className="size-4" /></button> : null}
        <button type="button" onClick={() => draft.remove(item.key)} aria-label={`移除附件 ${item.name}`} className="grid min-h-11 min-w-11 place-items-center rounded-lg text-[#5a7594] hover:bg-white focus-visible:ring-2 focus-visible:ring-ring"><X aria-hidden="true" className="size-4" /></button>
      </li>;
    })}</ul>
    {draft.error ? <p role="alert" className="px-1 text-xs leading-5 text-[#a43f37]">{draft.error}</p> : null}
  </div>;
}

export function SentAttachmentCards({ attachments, onDeleted }: { attachments: AttachmentReference[]; onDeleted?: (id: string) => void }) {
  const [error, setError] = useState(""); const [deleting, setDeleting] = useState("");
  const remove = async (item: AttachmentReference) => {
    setDeleting(item.id); setError("");
    try { await deleteAttachment(item.conversationId, item.id); onDeleted?.(item.id); }
    catch (error) { setError(error instanceof Error ? error.message : "文件暂时无法删除"); }
    finally { setDeleting(""); }
  };
  return <div className="mt-2 space-y-2"><ul aria-label="已发送附件" className="flex flex-wrap justify-end gap-2">{attachments.map((item) => <li key={item.id} className="min-w-0 max-w-full rounded-xl border border-[#d1e1f3] bg-white px-3 py-2"><div className="flex min-w-0 items-center gap-2">
    <File aria-hidden="true" className="size-4 shrink-0 text-[#54769a]" /><div className="min-w-0"><p className="max-w-52 truncate text-sm font-medium text-[#385779]" title={item.name}>{item.name}</p><p className="text-xs text-[#7187a1]">{sizeText(item.size)}{item.deleted ? " · 已删除" : item.unavailable ? " · 已失效，请重新上传" : ""}</p></div>
    {!item.deleted && !item.unavailable ? <a href={attachmentUrl(item.conversationId, item.id, "content")} download={item.name} aria-label={`下载 ${item.name}`} className="grid min-h-11 min-w-11 place-items-center rounded-lg text-[#2470cc] hover:bg-[#eff6ff]"><Download aria-hidden="true" className="size-4" /></a> : null}
    {!item.deleted && onDeleted ? <button type="button" disabled={Boolean(deleting)} onClick={() => void remove(item)} aria-label={`删除文件 ${item.name}`} className="grid min-h-11 min-w-11 place-items-center rounded-lg text-[#6d849f] hover:bg-[#fff0ed] hover:text-[#a43f37] disabled:opacity-50"><Trash2 aria-hidden="true" className="size-4" /></button> : null}
    </div>{!item.deleted && !item.unavailable ? <AttachmentIssues item={item} /> : null}
  </li>)}</ul>{error ? <p role="alert" className="text-right text-xs text-[#a43f37]">{error}</p> : null}</div>;
}
