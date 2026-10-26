"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CHANNEL_LABEL, CHANNELS, ENTRY_LABEL, beijingDate, turnStatusText } from "../../lib/internal/format";

const STATUSES = ["answered", "partial", "failed", "cancelled", "interrupted", "running"];

// 筛选条件存在 URL 里，刷新和分享链接都保留；日期默认最近 7 天（北京时间）。
export function useUsageQuery() {
  const params = useSearchParams();
  const query = new URLSearchParams(params.toString());
  if (!query.get("from")) query.set("from", beijingDate(-6));
  if (!query.get("to")) query.set("to", beijingDate());
  return query;
}

export function UsageFilters({ withKeyword = false, withStatus = false }: { withKeyword?: boolean; withStatus?: boolean }) {
  const router = useRouter(); const pathname = usePathname(); const query = useUsageQuery();
  const [draft, setDraft] = useState(() => Object.fromEntries(query.entries()) as Record<string, string>);
  const set = (name: string, value: string) => setDraft((current) => ({ ...current, [name]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams(Object.entries(draft).filter(([name, value]) => value && name !== "page"));
    router.push(`${pathname}?${next.toString()}`);
  };
  const select = "h-9 rounded-md border border-[#d6e6f7] bg-white px-2 text-sm text-[#293b54]";
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3 rounded-2xl border border-[#d6e6f7] bg-white/80 p-4 text-sm">
      <label className="grid gap-1 text-[13px] text-[#637a95]">开始<Input type="date" value={draft.from ?? ""} onChange={(event) => set("from", event.target.value)} className="h-9 w-[150px]" /></label>
      <label className="grid gap-1 text-[13px] text-[#637a95]">结束<Input type="date" value={draft.to ?? ""} onChange={(event) => set("to", event.target.value)} className="h-9 w-[150px]" /></label>
      <label className="grid gap-1 text-[13px] text-[#637a95]">入口
        <select className={select} value={draft.entry ?? ""} onChange={(event) => set("entry", event.target.value)}>
          <option value="">全部</option>
          {Object.entries(ENTRY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-[13px] text-[#637a95]">渠道
        <select className={select} value={draft.channel ?? ""} onChange={(event) => set("channel", event.target.value)}>
          <option value="">全部</option>
          {CHANNELS.map((value) => <option key={value} value={value}>{CHANNEL_LABEL[value]}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-[13px] text-[#637a95]">模型<Input value={draft.model ?? ""} onChange={(event) => set("model", event.target.value)} placeholder="如 deepseek-flash" className="h-9 w-[160px]" /></label>
      {withStatus ? (
        <label className="grid gap-1 text-[13px] text-[#637a95]">状态
          <select className={select} value={draft.status ?? ""} onChange={(event) => set("status", event.target.value)}>
            <option value="">全部</option>
            {STATUSES.map((value) => <option key={value} value={value}>{turnStatusText(value)}</option>)}
          </select>
        </label>
      ) : null}
      {withKeyword ? <label className="grid gap-1 text-[13px] text-[#637a95]">问题关键词<Input value={draft.keyword ?? ""} onChange={(event) => set("keyword", event.target.value)} className="h-9 w-[180px]" /></label> : null}
      <Button type="submit" size="sm" className="h-9">查询</Button>
    </form>
  );
}
