"use client";

import { BookOpenText, CircleHelp, Menu, Plus, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createSessionRequest,
  fetchSnapshot,
  notifySessionsChanged,
  notifySessionUpdated,
  postTurn,
  SESSIONS_CHANGED,
} from "../lib/client/api";
import type { SessionListItem } from "../lib/server/session-store";
import { registerCampaignTools } from "../lib/webmcp";

const STATUS_LABEL: Record<string, string> = {
  collecting: "收集中",
  ready: "待生成",
  generated: "已生成",
};

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-9 place-items-center rounded-xl border border-[#b98152] bg-[#61172a]">
        <span className="text-lg font-semibold text-[#e1b76e]">周</span>
      </span>
      <div>
        <p className="text-sm font-semibold tracking-wide text-white">周大福</p>
        <p className="text-[11px] text-[#c8aeb5]">营销活动 Agent</p>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [mobileNav, setMobileNav] = useState(false);
  const activeId = pathname.startsWith("/c/") ? decodeURIComponent(pathname.slice(3).split("/")[0]) : null;
  const locationRef = useRef({ activeId, router });

  const refresh = useCallback(() => {
    void fetch("/api/sessions")
      .then((response) => (response.ok ? (response.json() as Promise<{ sessions?: SessionListItem[] }>) : { sessions: [] }))
      .then((body) => setSessions(body.sessions ?? []))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
  }, [pathname, refresh]);

  useEffect(() => {
    window.addEventListener(SESSIONS_CHANGED, refresh);
    return () => window.removeEventListener(SESSIONS_CHANGED, refresh);
  }, [refresh]);

  useEffect(() => {
    locationRef.current = { activeId, router };
  });

  useEffect(() => registerCampaignTools({
    startCampaign: async ({ mode, prompt }) => {
      const { router: navigate } = locationRef.current;
      if (mode === "blank" && !prompt) {
        navigate.push("/");
        return "已打开新建活动页面。";
      }
      const snapshot = await createSessionRequest(mode === "example" ? { entryMode: "example" } : { entryMode: "new", text: prompt ?? "" });
      notifySessionsChanged();
      navigate.push(`/c/${snapshot.session.id}`);
      return mode === "example" ? "已打开完整示例对话。" : "已按这句话新建活动，Agent 正在追问缺的信息。";
    },
    updateFields: async (updates) => {
      const id = locationRef.current.activeId;
      if (!id) return "当前没有打开的活动。";
      let seq = (await fetchSnapshot(id)).latest.seq;
      const brief = Object.fromEntries(
        (["title", "externalName", "content", "slogan"] as const).filter((key) => updates[key] !== undefined).map((key) => [key, updates[key]]),
      );
      if (Object.keys(brief).length) {
        seq = (await postTurn(id, { type: "answer", topic: "brief", values: brief, origin: "tool", expectedSeq: seq })).latest.seq;
      }
      const schedule = Object.fromEntries(
        (["startDate", "endDate"] as const).filter((key) => updates[key] !== undefined).map((key) => [key, updates[key]]),
      );
      if (Object.keys(schedule).length) {
        await postTurn(id, { type: "answer", topic: "schedule", values: schedule, origin: "tool", expectedSeq: seq });
      }
      notifySessionUpdated(id);
      notifySessionsChanged();
      return "已更新当前活动，并重新计算拆单与校验结果。";
    },
    readSummary: async () => {
      const id = locationRef.current.activeId;
      if (!id) return "当前没有打开的活动。";
      const snapshot = await fetchSnapshot(id);
      return {
        status: snapshot.session.status,
        title: snapshot.latest.draft.brief.externalName || snapshot.session.title,
        orderCount: snapshot.latest.orders.length,
        noIcs: snapshot.session.noIcs,
        missingTopics: snapshot.plan.missingTopics,
        unresolved: snapshot.latest.draft.unresolved,
        blockers: snapshot.latest.issues.filter((issue) => issue.severity === "blocker").map((issue) => issue.message),
      };
    },
  }), []);

  const close = () => setMobileNav(false);
  const referenceLinks = [
    { href: "/codes", label: "码表与证据", icon: BookOpenText },
    { href: "/open-questions", label: "待确认清单", icon: CircleHelp },
  ];

  return (
    <div className="min-h-screen text-[#2f2226]">
      <header className="sticky top-0 z-40 flex h-16 items-center border-b border-[#ded5cb] bg-[#4a0c1b] px-4 md:hidden">
        <button type="button" aria-label="打开导航" onClick={() => setMobileNav(true)} className="mr-3 grid size-10 place-items-center rounded-lg text-white hover:bg-white/10">
          <Menu />
        </button>
        <Brand />
      </header>

      <div className="grid min-h-screen grid-cols-[248px_minmax(0,1fr)] max-md:block">
        <aside
          className={`fixed inset-y-0 left-0 z-50 flex w-[248px] flex-col bg-[#4a0c1b] text-white transition-transform md:sticky md:top-0 md:h-screen md:translate-x-0 ${mobileNav ? "translate-x-0" : "-translate-x-full"}`}
        >
          <div className="flex h-[76px] items-center justify-between border-b border-white/10 px-5">
            <Brand />
            <button type="button" aria-label="关闭导航" onClick={close} className="grid size-9 place-items-center rounded-lg hover:bg-white/10 md:hidden">
              <X />
            </button>
          </div>

          <div className="px-3 pt-4">
            <Link
              href="/"
              onClick={close}
              className="flex h-10 items-center justify-center gap-2 rounded-xl bg-[#d2a85e] text-sm font-medium text-[#351018] transition hover:bg-[#e0b970]"
            >
              <Plus className="size-4" />
              新建活动
            </Link>
          </div>

          <nav className="flex min-h-0 flex-1 flex-col px-3 pb-3" aria-label="主导航">
            <p className="px-3 pb-2 pt-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#caaeb5]">活动记录</p>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
              {sessions.length ? (
                sessions.map((session) => (
                  <Link
                    key={session.id}
                    href={`/c/${session.id}`}
                    onClick={close}
                    className={`block rounded-xl px-3 py-2.5 transition ${session.id === activeId ? "bg-[#7a1d32] text-white" : "text-[#e4d5d9] hover:bg-white/8 hover:text-white"}`}
                  >
                    <span className="line-clamp-1 text-sm">{session.title}</span>
                    <span className="mt-0.5 block text-[11px] text-[#c9b1b8]">
                      {STATUS_LABEL[session.status] ?? session.status}
                      {session.noIcs ? " · 无需 ICS" : ""}
                    </span>
                  </Link>
                ))
              ) : (
                <p className="px-3 py-2 text-[13px] text-[#cbb6bc]">还没有活动</p>
              )}
            </div>

            <p className="px-3 pb-2 pt-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#caaeb5]">资料</p>
            {referenceLinks.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                onClick={close}
                className={`mb-1 flex h-10 items-center gap-3 rounded-xl px-3 text-sm transition ${pathname === href ? "bg-[#7a1d32] font-medium text-white" : "text-[#d7c4c9] hover:bg-white/8 hover:text-white"}`}
              >
                <Icon className={`size-4 ${pathname === href ? "text-[#e2bb77]" : "text-[#b99fa6]"}`} />
                {label}
              </Link>
            ))}
          </nav>

          <div className="m-3 rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-[#f4e9ec]">
              <Sparkles className="size-4 text-[#d9b36b]" />
              DeepSeek V4.1 Flash
            </div>
            <p className="mt-2 text-[12px] leading-5 text-[#cbb6bc]">模型负责理解和写文案，拆单与规则由代码校验。</p>
          </div>
        </aside>

        <main className="min-w-0">{children}</main>
      </div>

      {mobileNav ? <button type="button" aria-label="关闭导航遮罩" onClick={close} className="fixed inset-0 z-40 bg-black/35 md:hidden" /> : null}
    </div>
  );
}
