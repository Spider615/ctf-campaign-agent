"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { internalGet } from "../../lib/internal/client";
import { MarkdownText } from "../chat/markdown-text";
import { CHANNEL_LABEL, ENTRY_LABEL, durationText, requestStatusText, timeText, tokenText, turnStatusText } from "../../lib/internal/format";
import type { ConversationDetail as Detail, TurnRecord } from "../../lib/internal/types";
import { DataTable, InternalShell, Notice, Panel } from "./internal-shell";

const statusTone = (status: string) => status === "answered" || status === "done" ? "text-[#26785e]" : status === "partial" || status === "running" ? "text-[#a0610b]" : "text-[#b2443b]";

function Turn({ turn, index }: { turn: TurnRecord; index: number }) {
  const elapsed = turn.finishedAt ? turn.finishedAt - turn.startedAt : undefined;
  return (
    <Panel title={`第 ${index + 1} 轮`} note={`${timeText(turn.startedAt)} · ${CHANNEL_LABEL[turn.channel]} · 耗时 ${durationText(elapsed)} · SDK 启动 ${turn.sdkStarts} 次`}>
      <div className="space-y-3 text-sm">
        <p className={`font-medium ${statusTone(turn.status)}`}>{turnStatusText(turn.status)}</p>
        <div className="rounded-xl bg-[#f1f7ff] px-4 py-3"><p className="text-[12px] text-[#637a95]">客户提问</p><p className="mt-1 whitespace-pre-wrap text-[#20314d]">{turn.question}</p></div>
        {turn.reply ? <div className="rounded-xl border border-[#d9e7f6] px-4 py-3"><p className="text-[12px] text-[#637a95]">公开回复</p><MarkdownText text={turn.reply} /></div> : null}
        {turn.error ? <Notice tone="error">{turn.error}</Notice> : null}
        {turn.trace?.length ? (
          <details className="rounded-xl border border-[#d9e7f6] px-4 py-2">
            <summary className="cursor-pointer text-[13px] text-[#4f6681]">执行过程（{turn.trace.length} 步）</summary>
            <ol className="mt-2 space-y-1.5">
              {turn.trace.map((step, at) => (
                <li key={at} className="text-[13px] leading-6"><span className={statusTone(step.status === "completed" ? "done" : step.status)}>●</span> {step.title}{step.summary ? <span className="text-[#71869f]"> · {step.summary}</span> : null}<span className="text-[#71869f]"> · {durationText(step.durationMs)}</span></li>
              ))}
            </ol>
          </details>
        ) : null}
        {turn.requests.length ? (
          <DataTable head={["开始", "来源", "厂商", "模型", "状态", "输入", "输出", "缓存命中", "缓存写入", "耗时"]} minWidth={900}>
            {turn.requests.map((request) => (
              <tr key={request.id}>
                <td className="whitespace-nowrap">{timeText(request.startedAt)}</td>
                <td>{request.source}</td>
                <td>{request.vendor ?? "未确认"}</td>
                {/* 只显示实际用的模型：上游返回了就用它，没返回用实际发出去的名字。 */}
                <td className="font-mono text-[12px] whitespace-nowrap">{request.upstreamModel ?? request.sentModel}</td>
                <td className={statusTone(request.status)}>{requestStatusText(request.status)}{request.httpStatus && request.httpStatus !== 200 ? ` ${request.httpStatus}` : ""}</td>
                <td>{tokenText(request.inputTokens)}</td>
                <td>{tokenText(request.outputTokens)}</td>
                <td>{tokenText(request.cacheReadTokens)}</td>
                <td>{tokenText(request.cacheWriteTokens)}</td>
                <td className="whitespace-nowrap">{durationText(request.finishedAt ? request.finishedAt - request.startedAt : undefined)}</td>
              </tr>
            ))}
          </DataTable>
        ) : <p className="text-[13px] text-[#71869f]">这一轮没有模型请求记录。</p>}
      </div>
    </Panel>
  );
}

export function ConversationDetailView({ conversationKey }: { conversationKey: string }) {
  const [state, setState] = useState<{ detail?: Detail; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    internalGet<{ conversation: Detail }>(`conversations/${encodeURIComponent(conversationKey)}`, controller.signal)
      .then(({ conversation }) => setState({ detail: conversation }), (error: Error) => { if (!controller.signal.aborted) setState({ error: error.message }); });
    return () => controller.abort();
  }, [conversationKey]);
  const detail = state.detail;
  return (
    <InternalShell active="/internal/conversations" title="会话详情">
      <Link href="/internal/conversations" className="text-sm text-[#2470cc]">← 返回会话列表</Link>
      <div className="mt-4 space-y-4">
        {!detail && !state.error ? <Notice>正在读取…</Notice> : null}
        {state.error ? <Notice tone="error">{state.error}</Notice> : null}
        {detail ? (
          <>
            <p className="text-sm text-[#4f6681]">{ENTRY_LABEL[detail.entry] ?? detail.entry} · 访客 <span className="font-mono">{detail.visitor ?? "—"}</span> · {detail.turns.length} 轮 · 费用按天对账，会话不显示金额</p>
            {detail.turns.map((turn, index) => <Turn key={turn.id} turn={turn} index={index} />)}
          </>
        ) : null}
      </div>
    </InternalShell>
  );
}
