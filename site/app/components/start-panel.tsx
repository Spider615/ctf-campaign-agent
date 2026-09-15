"use client";

import {
  ArrowUpRight,
  CirclePlus,
  Clock3,
  Copy,
  FileWarning,
  Loader2,
  MessageSquareText,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type EntryMode = "new" | "copy" | "rejected" | "example";

type RecentSession = {
  id: string;
  title: string;
  updated_at: string;
  status: string;
  versionCount: number;
};

type StartPanelProps = {
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onEntry: (mode: EntryMode) => void;
  onOpenRecent: (id: string) => void;
  busy: boolean;
  error: string;
  recentSessions: RecentSession[];
};

const entryCards = [
  { id: "new" as const, title: "新建活动", detail: "先说一句话，Agent 帮你补齐", icon: CirclePlus },
  { id: "copy" as const, title: "复制上次", detail: "沿用门店参数和活动结构", icon: Copy },
  { id: "rejected" as const, title: "从被拒的改", detail: "只处理 1815 允许修改的字段", icon: FileWarning },
  { id: "example" as const, title: "从示例开始", detail: "打开一份母亲节完整草稿", icon: Sparkles },
];

export function StartPanel({
  prompt,
  onPromptChange,
  onSubmit,
  onEntry,
  onOpenRecent,
  busy,
  error,
  recentSessions,
}: StartPanelProps) {
  return (
    <div className="soft-in grid min-h-[calc(100vh-72px)] grid-cols-[minmax(0,1fr)_310px] gap-6 p-6 max-xl:grid-cols-1 max-md:p-4">
      <section className="mx-auto flex w-full max-w-[920px] flex-col justify-center py-6 max-md:justify-start max-md:py-10">
        <div className="mb-8">
          <span className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-[#8b6b3b]">
            <span className="h-px w-8 bg-[#b99050]" />
            营销活动工作台
          </span>
          <h1 className="max-w-3xl text-[clamp(2rem,4.2vw,4.6rem)] font-semibold leading-[1.05] tracking-[-0.045em] text-[#2c1720]">
            今天要做什么活动？
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-[#766b6d]">
            说清由头、范围和优惠。Agent 会先回读理解，再生成方案和 ICS 开单草稿。
          </p>
        </div>

        <div className="rounded-2xl border border-[#cfc3b6] bg-[#fffdfa] p-3 shadow-[0_22px_70px_rgba(57,24,31,0.08)]">
          <Textarea
            aria-label="活动需求"
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") onSubmit();
            }}
            placeholder="例如：下个月华东区做个母亲节满 3000 减 300 的线下活动"
            className="min-h-32 resize-none border-0 bg-transparent px-3 py-3 text-base leading-7 shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center justify-between gap-3 border-t border-[#ece5dc] px-2 pt-3">
            <span className="hidden text-sm text-[#8a7d80] sm:inline">⌘ + Enter 发送</span>
            <Button
              onClick={onSubmit}
              disabled={busy || prompt.trim().length < 4}
              className="ml-auto h-11 rounded-xl bg-[#651427] px-5 text-[15px] hover:bg-[#791a30]"
            >
              {busy ? <Loader2 className="animate-spin" /> : <MessageSquareText />}
              {busy ? "正在理解" : "让 Agent 理解"}
            </Button>
          </div>
        </div>
        {error ? (
          <div role="alert" className="mt-3 rounded-xl border border-[#efc8bb] bg-[#fff2ec] px-4 py-3 text-sm text-[#8f2f1d]">
            {error}。输入内容已保留，可以重试或从示例开始。
          </div>
        ) : null}

        <div className="mt-8 grid grid-cols-4 gap-3 max-lg:grid-cols-2 max-sm:grid-cols-1">
          {entryCards.map(({ id, title, detail, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onEntry(id)}
              className="group min-h-32 rounded-xl border border-[#ddd4ca] bg-[#fbf8f3]/80 p-4 text-left transition hover:-translate-y-0.5 hover:border-[#b89561] hover:bg-white hover:shadow-[0_12px_28px_rgba(66,31,39,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9c6b2f]"
            >
              <span className="mb-5 flex items-center justify-between">
                <span className="grid size-9 place-items-center rounded-lg bg-[#efe6da] text-[#6a1d2e]">
                  <Icon className="size-4" />
                </span>
                <ArrowUpRight className="size-4 text-[#a79a94] transition group-hover:text-[#651427]" />
              </span>
              <span className="block text-[15px] font-semibold text-[#35262a]">{title}</span>
              <span className="mt-1 block text-[13px] leading-5 text-[#817578]">{detail}</span>
            </button>
          ))}
        </div>
      </section>

      <aside className="rounded-2xl border border-[#ded5cb] bg-[#fffdfa]/85 p-5 max-xl:hidden">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className="text-[13px] font-medium text-[#8f7f82]">日常入口</p>
            <h2 className="mt-1 text-lg font-semibold text-[#35262a]">最近活动</h2>
          </div>
          <Clock3 className="size-4 text-[#9a6d37]" />
        </div>
        <div className="space-y-2">
          {(recentSessions.length ? recentSessions : [
            { id: "seed-1", title: "华东母亲节金饰礼遇", updated_at: "2026-09-14", status: "草稿", versionCount: 3 },
            { id: "seed-2", title: "国庆黄金工费礼遇", updated_at: "2026-09-12", status: "待补字段", versionCount: 2 },
            { id: "seed-3", title: "传承系列城市展", updated_at: "2026-09-08", status: "无需 ICS", versionCount: 1 },
          ]).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => item.id.startsWith("seed-") ? onEntry("copy") : onOpenRecent(item.id)}
              className="w-full rounded-xl border border-transparent p-3 text-left hover:border-[#e3d8cb] hover:bg-[#f8f2ea] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9c6b2f]"
            >
              <span className="line-clamp-2 text-sm font-medium leading-5 text-[#3e2c31]">{item.title}</span>
              <span className="mt-2 flex items-center justify-between text-[12px] text-[#8f8385]">
                <span>{item.status === "draft" ? "草稿" : item.status}</span>
                <span>{item.versionCount} 个版本</span>
              </span>
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}
