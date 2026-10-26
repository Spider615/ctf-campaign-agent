"use client";

import { useEffect, useState } from "react";

import { internalGet } from "../../lib/internal/client";
import { CHANNEL_LABEL, TURN_STATUS_HINT, durationText, groupByChannel, tokenText, turnStatusText } from "../../lib/internal/format";
import type { Overview } from "../../lib/internal/types";
import { UsageFilters, useUsageQuery } from "./filters";
import { DataTable, InternalShell, Notice, Panel } from "./internal-shell";

// 统计总览：两个渠道各一块，各自按天列 Token；费用按渠道按天对账，来源接入前只写「来源未接入」。
export function StatsView() {
  const query = useUsageQuery().toString();
  const [state, setState] = useState<{ query: string; overview?: Overview; error?: string }>({ query: "" });
  useEffect(() => {
    const controller = new AbortController();
    internalGet<{ overview: Overview }>(`overview?${query}`, controller.signal)
      .then(({ overview }) => setState({ query, overview }), (error: Error) => { if (!controller.signal.aborted) setState({ query, error: error.message }); });
    return () => controller.abort();
  }, [query]);
  const loading = state.query !== query;
  const overview = loading ? undefined : state.overview;

  return (
    <InternalShell active="/internal/stats" title="统计总览">
      <UsageFilters />
      <div className="mt-5 space-y-5">
        {loading ? <Notice>正在读取…</Notice> : null}
        {!loading && state.error ? <Notice tone="error">{state.error}</Notice> : null}
        {overview ? (
          <>
            <Panel title="问答轮次" note={`轮次耗时 p50 ${durationText(overview.durations.turnsMs.p50)} · p90 ${durationText(overview.durations.turnsMs.p90)}`}>
              <div className="flex flex-wrap gap-2">
                {Object.entries(overview.statuses).map(([status, count]) => (
                  <span key={status} title={TURN_STATUS_HINT[status]} className="cursor-help rounded-lg border border-[#d9e7f6] bg-white px-3 py-1.5 text-sm text-[#293b54]">
                    {turnStatusText(status)} <b className="ml-1">{count}</b>
                  </span>
                ))}
              </div>
              <p className="mt-3 text-[13px] leading-6 text-[#71869f]">「答了，有保留」：{TURN_STATUS_HINT.partial}。</p>
            </Panel>
            {overview.days.length === 0 ? <Notice>这段时间没有记录。</Notice> : null}
            {groupByChannel(overview.days).map((group) => (
              <Panel key={group.channel} title={CHANNEL_LABEL[group.channel]} note="Token 按北京时间切天；费用按渠道按天对账">
                <DataTable head={["日期", "轮次", "模型请求", "输入 Token", "输出 Token", "缓存命中", "缓存写入", "不完整请求", "实际费用"]} minWidth={900}>
                  {group.rows.map((row) => (
                    <tr key={row.day}>
                      <td className="whitespace-nowrap">{row.day}</td>
                      <td>{row.turns}</td>
                      <td>{row.requests}</td>
                      <td>{tokenText(row.inputTokens)}</td>
                      <td>{tokenText(row.outputTokens)}</td>
                      <td>{tokenText(row.cacheReadTokens)}</td>
                      <td>{tokenText(row.cacheWriteTokens)}</td>
                      <td className={row.incompleteRequests ? "text-[#b2443b]" : ""}>{row.incompleteRequests}</td>
                      <td className="text-[#71869f]">来源未接入</td>
                    </tr>
                  ))}
                </DataTable>
              </Panel>
            ))}
            {overview.models.length ? (
              <Panel title="按模型" note="模型取上游返回的名字，没有返回时取实际发送的名字">
                <DataTable head={["渠道", "模型", "请求", "输入 Token", "输出 Token"]}>
                  {overview.models.map((row) => (
                    <tr key={`${row.channel}-${row.model}`}>
                      <td>{CHANNEL_LABEL[row.channel]}</td>
                      <td className="font-mono text-[13px]">{row.model}</td>
                      <td>{row.requests}</td>
                      <td>{tokenText(row.inputTokens)}</td>
                      <td>{tokenText(row.outputTokens)}</td>
                    </tr>
                  ))}
                </DataTable>
              </Panel>
            ) : null}
          </>
        ) : null}
      </div>
    </InternalShell>
  );
}
