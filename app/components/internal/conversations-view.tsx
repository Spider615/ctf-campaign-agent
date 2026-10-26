"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { internalGet } from "../../lib/internal/client";
import { CHANNEL_LABEL, ENTRY_LABEL, durationText, timeText, tokenText, yuanText } from "../../lib/internal/format";
import type { ConversationRow } from "../../lib/internal/types";
import { UsageFilters, useUsageQuery } from "./filters";
import { DataTable, InternalShell, Notice } from "./internal-shell";
import { Pager } from "./pager";

// 会话列表：会话不显示金额，账单按天对账。访客编号是浏览器标识的哈希，不等于真实客户。
export function ConversationsView() {
  const router = useRouter(); const pathname = usePathname();
  const params = useUsageQuery();
  const query = params.toString();
  const [state, setState] = useState<{ query: string; rows?: ConversationRow[]; total?: number; page?: number; pageSize?: number; error?: string }>({ query: "" });
  useEffect(() => {
    const controller = new AbortController();
    internalGet<{ conversations: ConversationRow[]; total: number; page: number; pageSize: number }>(`conversations?${query}`, controller.signal)
      .then((result) => setState({ query, rows: result.conversations, total: result.total, page: result.page, pageSize: result.pageSize }), (error: Error) => { if (!controller.signal.aborted) setState({ query, error: error.message }); });
    return () => controller.abort();
  }, [query]);
  const loading = state.query !== query;
  const rows = loading ? undefined : state.rows;
  // 翻页和改每页条数都写进 URL，刷新和分享链接保留位置。
  const goTo = (next: { page: number; pageSize: number }) => {
    const copy = new URLSearchParams(query); copy.set("page", String(next.page)); copy.set("pageSize", String(next.pageSize));
    router.push(`${pathname}?${copy.toString()}`);
  };

  return (
    <InternalShell active="/internal/conversations" title="会话">
      <UsageFilters withKeyword withStatus />
      <div className="mt-5 space-y-3">
        {loading ? <Notice>正在读取…</Notice> : null}
        {!loading && state.error ? <Notice tone="error">{state.error}</Notice> : null}
        {rows && !rows.length ? <Notice>没有符合条件的会话。</Notice> : null}
        {rows?.length ? (
          <DataTable head={["最近提问时间", "入口", "访客", "会话", "最近问题", "轮数", "渠道", "输入 Token", "输出 Token", "估算费用", "执行耗时"]} minWidth={1180}>
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
                <td className="whitespace-nowrap font-medium">{yuanText(row.costYuan, row.unpricedRequests)}</td>
                <td className="whitespace-nowrap">{durationText(row.durationMs)}</td>
              </tr>
            ))}
          </DataTable>
        ) : null}
        {rows && state.total !== undefined ? <Pager page={state.page ?? 1} pageSize={state.pageSize ?? 20} total={state.total} onChange={goTo} /> : null}
      </div>
    </InternalShell>
  );
}
