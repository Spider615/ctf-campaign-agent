"use client";

import { useId, useState } from "react";
import type { AttachmentSource, ConversationAnswer } from "../../lib/attachments/types";
import { attachmentUrl, getAttachment } from "../../lib/client/attachments";
import { MarkdownText } from "../chat/markdown-text";
import { resolveConversationVisualization } from "../../lib/attachments/answer.ts";
import { VisualizationCard } from "../analytics/visualization-card.tsx";
import { AnalysisSourceData } from "../analytics/analysis-answer.tsx";

function FileSource({ source, index, conversationId }: { source: AttachmentSource; index: number; conversationId: string }) {
  const [opened, setOpened] = useState(false); const [error, setError] = useState("");
  const check = async () => {
    if (source.kind === "database") return;
    setError("");
    try { const file = await getAttachment(conversationId, source.attachmentId); if (file.version !== source.version) setError("来源版本已变化，请重新读取文件。"); }
    catch { setError("来源文件已删除、过期或无权读取；以下保留当时回答引用的片段。"); }
  };
  return <details className="group rounded-xl border border-[#d8e6f5] bg-[#f7faff]" onToggle={(event) => { const open = event.currentTarget.open; setOpened(open); if (open) void check(); }}>
    <summary className="min-h-11 cursor-pointer break-words px-3 py-3 text-xs leading-5 text-[#38678f] focus-visible:ring-2 focus-visible:ring-ring">[{index}] {source.name} · {source.location}</summary>
    <div className="space-y-3 border-t border-[#dce8f5] px-3 py-3">
      {error ? <p role="status" className="text-xs leading-5 text-[#9e543e]">{error}</p> : null}
      <blockquote className="select-text whitespace-pre-wrap break-words border-l-2 border-[#b7d5fa] pl-3 text-sm leading-6 text-[#4a6481]">{source.excerpt}</blockquote>
      {opened && source.imageId && !error ? <div className="overflow-hidden rounded-lg border border-[#dce8f5] bg-white">
        {/* 这里只加载通过鉴权的服务端归一化图片。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={attachmentUrl(conversationId, source.attachmentId, `image/${source.imageId}`)} alt={`${source.name}，${source.location}`} className="max-h-96 w-full object-contain" loading="lazy" />
      </div> : null}
      {source.kind !== "database" && !error ? <a href={attachmentUrl(conversationId, source.attachmentId, "content")} download={source.name} className="inline-flex min-h-11 items-center text-xs text-[#2470cc] underline underline-offset-4">下载原文件</a> : null}
    </div>
  </details>;
}

export function FileAnswer({ answer, conversationId }: { answer: ConversationAnswer; conversationId: string }) {
  const prefix = useId();
  const numbering = new Map(answer.sources.map((source, index) => [source.id, index + 1]));
  return <div className="min-w-0 space-y-4 select-text">
    {answer.blocks.map((block, index) => <div key={index} className="space-y-3"><MarkdownText text={block.text} /><div className="flex flex-wrap gap-2">{block.sourceIds.map((id) => <a key={id} href={`#${prefix}-${id}`} onClick={(event) => { event.preventDefault(); const node = document.getElementById(`${prefix}-${id}`); const details = node?.querySelector("details"); if (details) details.open = true; node?.scrollIntoView({ block: "nearest" }); }} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md bg-[#edf5ff] px-2 text-xs font-medium text-[#2470cc]" aria-label={`查看文件来源 ${numbering.get(id)}`}>[{numbering.get(id)}]</a>)}</div>
      {(answer.visualizations?.items ?? []).filter((spec) => spec.afterBlockIndex === index).map((spec) => {
        const database = spec.source.kind === "analysis" ? answer.databaseAnswers?.find((item) => item.visualizations?.items.some((original) => original.id === spec.id)) : undefined;
        return <VisualizationCard key={spec.id} chart={resolveConversationVisualization(spec, answer)} conversationId={conversationId} files={(answer.calculations ?? []).filter((calculation) => spec.source.kind === "attachment" && spec.source.calculationIds.includes(calculation.id)).map((calculation) => ({ id: calculation.attachmentId, version: calculation.version }))} sourceContent={database ? <AnalysisSourceData answer={database} /> : undefined} />;
      })}
    </div>)}
    {answer.limitations.length ? <div className="rounded-xl border border-[#e7d9b5] bg-[#fffaf0] px-3 py-2.5 text-xs leading-6 text-[#826530]">{answer.limitations.map((text, index) => <p key={index}>{text}</p>)}</div> : null}
    <div aria-label="文件回答依据" className="space-y-2">{answer.sources.map((source, index) => <div key={source.id} id={`${prefix}-${source.id}`}><FileSource source={source} index={index + 1} conversationId={conversationId} /></div>)}</div>
  </div>;
}
