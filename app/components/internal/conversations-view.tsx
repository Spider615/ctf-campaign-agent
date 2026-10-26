"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { internalGet } from "../../lib/internal/client";
import { CHANNEL_LABEL, ENTRY_LABEL, durationText, timeText, tokenText } from "../../lib/internal/format";
import type { ConversationRow } from "../../lib/internal/types";
import { UsageFilters, useUsageQuery } from "./filters";
import { DataTable, InternalShell, Notice } from "./internal-shell";

const PAGE = 50;

// 会话列表：会话不显示金额，账单按天对账。访客编号是浏览器标识的哈希，不等于真实客户。
export function ConversationsView() {
  const params = useUsageQuery();
  const offset = Number(params.get("offset") ?? 0) || 0;
  const query = params.toString();
  const [state, setState] = useState<{ query: string; rows?: ConversationRow[]; error?: string }>({ query: "" });
  useEffect(() => {
    const controller = new AbortController();
    internalGet<{ conversations: ConversationRow[] }>(`conversations?${query}`, controller.signal)
      .then(({ conversations }) => setState({ query, rows: conversations }), (error: Error) => { if (!controller.signal.aborted) setState({ query, error: error.message }); });
    return () => controller.abort();
  }, [query]);
  const loading = state.query !== query;
  const rows = loading ? undefined : state.rows;
  const page = (next: number) => { const copy = new URLSearchParams(query); copy.set("offset", String(next)); return `/internal/conversations?${copy.toString()}`; };

  return (
    <InternalShell active="/internal/conversations" title="会话">
      <UsageFilters withKeyword withStatus />
      <div className="mt-5 space-y-3">
        {loading ? <Notice>正在读取…</Notice> : null}
        {!loading && state.error ? <Notice tone="error">{state.error}</Notice> : null}
        {rows && !rows.length ? <Notice>没有符合条件的会话。</Notice> : null}
        {rows?.length ? (
          <DataTable head={["最近提问时间", "入口", "访客", "会话", "最近问题", "轮数", "渠道", "输入 Token", "输出 Token", "执行耗时"]} minWidth={1100}>
            {rows.map((row) => (
              <tr key={row.key} className="hover:bg-[#f8fbff]">
                <td className="whitespace-nowrap">{timeText(row.lastAt)}</td>
                <td className="whitespace-nowrap">{ENTRY_LABEL[row.entry] ?? row.entry}{row.internal ? <span className="ml-1.5 rounded bg-[#fff4e5] px-1.5 py-0.5 text-[12px] text-[#a0610b]">内部</span> : null}</td>
                <td className="font-mono text-[12px] text-[#637a95]">{row.visitor ?? "—"}</td>
                <td className="max-w-[220px]"><Link className="text-[#2470cc] hover:underline" href={`/internal/conversations/${encodeURIComponent(row.key)}`}>{row.title || "（空）"}</Link></td>
                <td className="max-w-[260px] text-[#4f6681]">{row.lastQuestion}</td>
                <td>{row.turns}</td>
                <td className="whitespace-nowrap">{row.channels.map((channel) => CHANNEL_LABEL[channel]).join("、")}</td>
                <td>{tokenText(row.inputTokens)}</td>
                <td>{tokenText(row.outputTokens)}</td>
                <td className="whitespace-nowrap">{durationText(row.durationMs)}</td>
              </tr>
            ))}
          </DataTable>
        ) : null}
        {rows ? (
          <div className="flex gap-3 text-sm">
            {offset > 0 ? <Link className="text-[#2470cc]" href={page(Math.max(0, offset - PAGE))}>上一页</Link> : null}
            {rows.length === PAGE ? <Link className="text-[#2470cc]" href={page(offset + PAGE)}>下一页</Link> : null}
          </div>
        ) : null}
      </div>
    </InternalShell>
  );
}
