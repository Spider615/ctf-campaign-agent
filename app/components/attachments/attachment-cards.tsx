"use client";

import { File, FileImage, Loader2, RotateCcw, X, Download, Trash2 } from "lucide-react";
import { useState } from "react";
import type { AttachmentReference, AttachmentSummary } from "../../lib/attachments/types";
import { attachmentUrl, deleteAttachment, getAttachment } from "../../lib/client/attachments";
import type { AttachmentDraft } from "./use-attachments";

const sizeText = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const statusText = { uploading: "正在上传", queued: "等待读取", processing: "正在读取", ready: "可以提问", partial: "部分内容可读", failed: "读取失败", unsupported: "暂不支持读取", encrypted: "文件已加密" };

function AttachmentReadScope({ item, summary }: { item: AttachmentReference; summary?: AttachmentSummary }) {
  const [file, setFile] = useState(summary); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const load = async () => { if (file || loading) return; setLoading(true); try { setFile(await getAttachment(item.conversationId, item.id)); } catch (error) { setError(error instanceof Error ? error.message : "读取范围暂时无法打开"); } finally { setLoading(false); } };
  return <details className="max-w-full text-left text-xs leading-5 text-[#627b96]" onToggle={(event) => { if (event.currentTarget.open) void load(); }}>
    <summary className="cursor-pointer py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">查看读取范围{item.status === "partial" ? "（部分可读）" : ""}</summary>
    {loading ? <p role="status">正在核对文件范围…</p> : error ? <p role="alert">{error}</p> : file ? <div className="max-h-60 space-y-2 overflow-y-auto break-words border-t border-[#dbe8f7] py-2">
      <p>{statusText[file.status]} · {file.blockCount} 个文字结构块 · {file.tableCount} 张表格 · {file.imageCount} 张图像</p>
      {file.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
      {file.entries.length ? <ul aria-label="压缩包成员读取清单" className="space-y-2">{file.entries.map((entry, index) => <li key={index}><span className="font-medium">{entry.path}</span> · {statusText[entry.status]}{entry.detail ? `：${entry.detail}` : ""}</li>)}</ul> : null}
    </div> : null}
  </details>;
}

export function DraftAttachmentCards({ draft }: { draft: AttachmentDraft }) {
  if (!draft.files.length && !draft.error) return null;
  return <div className="space-y-2 px-2 pt-2">
    <ul aria-label="待发送附件" className="grid max-h-60 gap-2 overflow-y-auto sm:grid-cols-2">{draft.files.map((item) => {
      const waiting = ["uploading", "queued", "processing"].includes(item.status); const failed = !waiting && !["ready", "partial"].includes(item.status);
      return <li key={item.key} className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2 ${failed ? "border-[#edc9c4] bg-[#fff6f3]" : "border-[#d5e4f5] bg-[#f3f8ff]"}`}>
        {waiting ? <Loader2 aria-hidden="true" className="size-5 shrink-0 animate-spin text-[#247cff] motion-reduce:animate-none" /> : item.attachment?.imageCount && item.attachment.mime.startsWith("image/") ? <>
          {/* 服务端只提供已归一化图片，上传原文件不会作为页面执行。 */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={attachmentUrl(item.attachment.conversationId, item.attachment.id, "image/i1")} alt={`${item.name} 缩略图`} className="size-11 shrink-0 rounded-lg object-cover" />
        </> : item.attachment?.imageCount ? <FileImage aria-hidden="true" className="size-5 shrink-0 text-[#247cff]" /> : <File aria-hidden="true" className="size-5 shrink-0 text-[#54769a]" />}
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-[#27415f]" title={item.name}>{item.name}</p><p className="mt-0.5 text-xs leading-5 text-[#627b96]" role="status">{sizeText(item.size)} · {statusText[item.status]}</p>{item.error ? <p role="alert" className="break-words text-xs leading-5 text-[#a43f37]">{item.error}</p> : null}{item.status === "partial" && item.attachment ? <AttachmentReadScope item={item.attachment} summary={item.attachment} /> : null}</div>
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
    </div>{!item.deleted && !item.unavailable ? <AttachmentReadScope item={item} /> : null}
  </li>)}</ul>{error ? <p role="alert" className="text-right text-xs text-[#a43f37]">{error}</p> : null}</div>;
}
