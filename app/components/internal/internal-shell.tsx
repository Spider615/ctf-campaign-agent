"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { internalLogout } from "../../lib/internal/client";

const NAV = [
  { href: "/internal/stats", label: "统计总览" },
  { href: "/internal/conversations", label: "会话" },
];

// 管理端外壳：只给内部同学用，客户首页没有入口。
export function InternalShell({ active, title, children }: { active: string; title: string; children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-8 md:py-8">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-[#d6e6f7] pb-4">
        <div>
          <p className="text-[12px] font-semibold tracking-[0.12em] text-[#2470cc]">内部管理</p>
          <h1 className="mt-0.5 text-xl font-semibold text-[#20314d]">{title}</h1>
        </div>
        <nav className="flex gap-1">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className={`rounded-lg px-3 py-1.5 text-sm ${active === item.href ? "bg-[#eaf4ff] font-medium text-[#2470cc]" : "text-[#4f6681] hover:bg-[#f1f7ff]"}`}>
              {item.label}
            </Link>
          ))}
        </nav>
        <Button variant="ghost" size="sm" className="ml-auto text-[#4f6681]" onClick={() => { void internalLogout(); }}>退出</Button>
      </header>
      <main className="mt-6">{children}</main>
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
