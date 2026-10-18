"use client";

import { useEffect, useRef, useState } from "react";
import type { AttachmentSource, ConversationAnswer } from "../../lib/attachments/types";
import { AttachmentRequestError, attachmentUrl, getAttachment } from "../../lib/client/attachments";
import { MarkdownText } from "../chat/markdown-text";
import { resolveConversationVisualization } from "../../lib/attachments/answer.ts";
import { VisualizationCard } from "../analytics/visualization-card.tsx";

function FileSource({ source, index, conversationId }: { source: AttachmentSource; index: number; conversationId: string }) {
  const [opened, setOpened] = useState(false); const [status, setStatus] = useState<"checking" | "available" | "unavailable" | "error">(source.kind === "database" ? "available" : "checking");
  const [error, setError] = useState(""); const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);
  const check = async () => {
    if (source.kind === "database") return;
    active.current?.abort(); const controller = new AbortController(); active.current = controller; setError(""); setStatus("checking");
    try {
      const file = await getAttachment(conversationId, source.attachmentId, controller.signal);
      if (controller.signal.aborted) return;
      if (file.version !== source.version) { setStatus("unavailable"); setError("来源版本已变化，请重新读取文件。"); }
      else setStatus("available");
    } catch (caught) {
      if (controller.signal.aborted) return;
      const unavailable = caught instanceof AttachmentRequestError && [401, 403, 404, 410].includes(caught.status);
      setStatus(unavailable ? "unavailable" : "error");
      setError(unavailable ? "来源文件已删除、过期或无权读取；以下保留当时回答引用的片段。" : "暂时无法确认文件来源，以下保留当时回答引用的片段。");
    } finally { if (active.current === controller) active.current = null; }
  };
  return <details className="group rounded-xl border border-[#d8e6f5] bg-[#f7faff]" onToggle={(event) => { const open = event.currentTarget.open; setOpened(open); if (open) void check(); }}>
    <summary className="min-h-11 cursor-pointer break-words px-3 py-3 text-xs leading-5 text-[#38678f] focus-visible:ring-2 focus-visible:ring-ring">[{index}] {source.name} · {source.location}</summary>
    <div className="space-y-3 border-t border-[#dce8f5] px-3 py-3">
      {error ? <p role="status" className="text-xs leading-5 text-[#9e543e]">{error}{status === "error" ? <button type="button" onClick={() => void check()} className="ml-1 min-h-11 rounded-lg px-2 text-[#2470cc] underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring">重新检查</button> : null}</p> : opened && status === "checking" ? <p role="status" className="text-xs leading-5 text-[#627b96]">正在确认文件来源…</p> : null}
      <blockquote className="select-text whitespace-pre-wrap break-words border-l-2 border-[#b7d5fa] pl-3 text-sm leading-6 text-[#4a6481]">{source.excerpt}</blockquote>
      {opened && source.imageId && status === "available" ? <div className="overflow-hidden rounded-lg border border-[#dce8f5] bg-white">
        {/* 这里只加载通过鉴权的服务端归一化图片。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={attachmentUrl(conversationId, source.attachmentId, `image/${source.imageId}`)} alt={`${source.name}，${source.location}`} className="max-h-96 w-full object-contain" loading="lazy" />
      </div> : null}
      {source.kind !== "database" && status === "available" ? <a href={attachmentUrl(conversationId, source.attachmentId, "content")} download={source.name} className="inline-flex min-h-11 items-center text-xs text-[#2470cc] underline underline-offset-4">下载原文件</a> : null}
    </div>
  </details>;
}

// 业务人员先看正文：结论、发现、建议按模型写的 Markdown 排版，图表跟在它支撑的段落后面。
// 口径说明和数据依据默认收起，需要核对时再展开；正文不再逐段挂引用编号。
export function FileAnswer({ answer, conversationId }: { answer: ConversationAnswer; conversationId: string }) {
  return <div className="min-w-0 space-y-4 select-text">
    {answer.blocks.map((block, index) => <div key={index} className="space-y-3"><MarkdownText text={block.text} />
      {(answer.visualizations?.items ?? []).filter((spec) => spec.afterBlockIndex === index && spec.source.kind === "attachment").map((spec) => {
        return <VisualizationCard key={spec.id} chart={resolveConversationVisualization(spec, answer)} conversationId={conversationId} files={(answer.calculations ?? []).filter((calculation) => spec.source.kind === "attachment" && spec.source.calculationIds.includes(calculation.id)).map((calculation) => ({ id: calculation.attachmentId, version: calculation.version }))} />;
      })}
    </div>)}
    <div className="space-y-2 pt-1">
      {answer.limitations.length ? <details className="group rounded-xl border border-[#e6edf5] bg-[#fafcfe]">
        <summary className="min-h-11 cursor-pointer px-3 py-3 text-xs leading-5 text-[#5c7288] focus-visible:ring-2 focus-visible:ring-ring">口径说明</summary>
        <ul className="list-disc space-y-1 border-t border-[#e6edf5] py-3 pl-7 pr-3 text-xs leading-6 text-[#5c7288]">{answer.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul>
      </details> : null}
      {answer.sources.length ? <details aria-label="文件回答依据" className="group rounded-xl border border-[#e6edf5] bg-[#fafcfe]">
        <summary className="min-h-11 cursor-pointer px-3 py-3 text-xs leading-5 text-[#5c7288] focus-visible:ring-2 focus-visible:ring-ring">数据依据（{answer.sources.length} 条）</summary>
        <div className="space-y-2 border-t border-[#e6edf5] p-2">{answer.sources.map((source, index) => <FileSource key={`${conversationId}/${source.attachmentId}/${source.version}/${source.id}`} source={source} index={index + 1} conversationId={conversationId} />)}</div>
      </details> : null}
    </div>
  </div>;
}
