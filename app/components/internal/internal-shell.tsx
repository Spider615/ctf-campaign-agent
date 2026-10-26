"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { internalLogout } from "../../lib/internal/client";

const NAV = [
  { href: "/internal/stats", label: "统计总览", hint: "按渠道按天的 Token" },
  { href: "/internal/conversations", label: "会话", hint: "提问、回复与执行过程" },
];

// 管理端外壳：左侧菜单，只给内部同学用，客户首页没有入口。窄屏时菜单收到顶部。
export function InternalShell({ active, title, children }: { active: string; title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-[#d6e6f7] bg-white/85 md:sticky md:top-0 md:h-screen md:w-[220px] md:border-r md:border-b-0">
        <div className="px-5 pt-5 pb-3 md:pt-6">
          <p className="text-[12px] font-semibold tracking-[0.12em] text-[#2470cc]">内部管理</p>
          <p className="mt-0.5 text-[15px] font-semibold text-[#20314d]">用量与执行记录</p>
        </div>
        <nav className="flex gap-1 px-3 pb-3 md:flex-col md:pb-0">
          {NAV.map((item) => {
            const current = active === item.href;
            return (
              <Link key={item.href} href={item.href} aria-current={current ? "page" : undefined}
                className={`rounded-xl px-3 py-2 text-sm transition-colors ${current ? "bg-[#eaf4ff] font-medium text-[#2470cc]" : "text-[#4f6681] hover:bg-[#f1f7ff]"}`}>
                {item.label}
                <span className="hidden text-[12px] font-normal text-[#8aa0b9] md:block">{item.hint}</span>
              </Link>
            );
          })}
        </nav>
        <div className="hidden px-3 pb-5 md:mt-auto md:block">
          <Button variant="ghost" size="sm" className="w-full justify-start text-[#4f6681]" onClick={() => { void internalLogout(); }}>退出</Button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8 md:py-8">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-[#20314d]">{title}</h1>
            <Button variant="ghost" size="sm" className="ml-auto text-[#4f6681] md:hidden" onClick={() => { void internalLogout(); }}>退出</Button>
          </div>
          <main className="mt-5">{children}</main>
        </div>
      </div>
    </div>
  );
}

export function Panel({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-[#d6e6f7] bg-white/80 p-4 shadow-[0_8px_26px_rgba(43,94,151,0.05)] md:p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold text-[#20314d]">{title}</h2>
        {note ? <span className="text-[13px] text-[#71869f]">{note}</span> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function DataTable({ head, children, minWidth = 640 }: { head: string[]; children: ReactNode; minWidth?: number }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[#d9e7f6] bg-white">
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-[#d9e7f6] bg-[#f1f7ff] text-[13px] text-[#637a95]">
            {head.map((cell) => <th key={cell} className="px-3 py-2 font-medium whitespace-nowrap">{cell}</th>)}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-[#e5eef8] [&>tr:last-child]:border-b-0 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_td]:text-[#293b54]">{children}</tbody>
      </table>
    </div>
  );
}

export function Notice({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" }) {
  return <p className={`rounded-xl px-4 py-3 text-sm ${tone === "error" ? "bg-[#fff4f2] text-[#b2443b]" : "bg-[#f1f7ff] text-[#4f6681]"}`}>{children}</p>;
}
