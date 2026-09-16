"use client";

import { BookOpenText, CircleHelp, Menu, Plus, Sparkles, Trash2, X } from "lucide-react";
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
  readback: "待确认",
  confirmed: "已生成填写值",
};

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-9 place-items-center rounded-xl border border-[#d8a95c] bg-[#8c2038] shadow-[0_5px_14px_rgba(140,32,56,0.18)]">
        <span className="text-lg font-semibold text-[#f3cd86]">周</span>
      </span>
      <div>
        <p className="text-sm font-semibold tracking-wide text-[#17243a]">周大福</p>
        <p className="text-[11px] text-[#7186a1]">1811 AI 工作台</p>
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
    // 只改名称、内容和起止日期；标语只能由用户照抄法务确认过的原文，优惠和门店在对话里改。
    updateFields: async ({ name, content, startDate, endDate }) => {
      const id = locationRef.current.activeId;
      if (!id) return "当前没有打开的活动。";
      if ((startDate && !endDate) || (!startDate && endDate)) return "开始、结束日期要一起给。";
      const seq = (await fetchSnapshot(id)).latest.seq;
      const copy = { ...(name !== undefined ? { name } : {}), ...(content !== undefined ? { content } : {}) };
      await postTurn(id, {
        type: "edit",
        origin: "tool",
        ...(startDate && endDate ? { answers: { Q1: { start: startDate, end: endDate } } } : {}),
        ...(Object.keys(copy).length ? { copy } : {}),
        expectedSeq: seq,
      });
      notifySessionUpdated(id);
      notifySessionsChanged();
      return "已更新当前活动，并重新复述。";
    },
    readSummary: async () => {
      const id = locationRef.current.activeId;
      if (!id) return "当前没有打开的活动。";
      const snapshot = await fetchSnapshot(id);
      return {
        status: snapshot.session.status,
        phase: snapshot.flow.phase,
        name: snapshot.latest.fill.info.name.value,
        detailCount: snapshot.latest.fill.details.length,
        roundsUsed: snapshot.flow.roundsUsed,
        missing: snapshot.flow.missing,
        canConfirm: snapshot.flow.canConfirm,
        blockers: snapshot.latest.checks.filter((check) => check.severity === "blocker").map((check) => check.message),
      };
    },
  }), []);

  const close = () => setMobileNav(false);

  const removeSession = async (id: string, title: string) => {
    if (!window.confirm(`删除「${title}」？删掉的活动找不回来。`)) return;
    try {
      const response = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(String(response.status));
      notifySessionsChanged();
      // 删的正是当前打开的会话时，留在原地就是一个读不到的页面，退回新建页。
      if (id === activeId) router.push("/");
    } catch {
      window.alert("删不掉这个活动，请重试。");
    }
  };

  const referenceLinks = [
    { href: "/codes", label: "代码表", icon: BookOpenText },
    { href: "/open-questions", label: "待确认清单", icon: CircleHelp },
  ];

  return (
    <div className="min-h-screen text-[#17243a]">
      <header className="sticky top-0 z-40 flex h-16 items-center border-b border-[#d9e7f6] bg-white/85 px-4 shadow-[0_6px_20px_rgba(58,104,154,0.06)] backdrop-blur-xl md:hidden">
        <button type="button" aria-label="打开导航" onClick={() => setMobileNav(true)} className="mr-3 grid size-11 place-items-center rounded-xl text-[#47617f] transition hover:bg-[#edf5ff] hover:text-[#247cff]">
          <Menu />
        </button>
        <Brand />
      </header>

      <div className="grid min-h-screen grid-cols-[252px_minmax(0,1fr)] max-md:block">
        <aside
          className={`fixed inset-y-0 left-0 z-50 flex w-[252px] flex-col border-r border-[#d9e7f6] bg-white/90 text-[#26364f] shadow-[18px_0_50px_rgba(49,93,143,0.07)] backdrop-blur-xl transition-transform md:sticky md:top-0 md:h-screen md:translate-x-0 ${mobileNav ? "translate-x-0" : "-translate-x-full"}`}
        >
          <div className="flex h-[76px] items-center justify-between border-b border-[#e4eef9] px-5">
            <Brand />
            <button type="button" aria-label="关闭导航" onClick={close} className="grid size-11 place-items-center rounded-xl text-[#60758f] transition hover:bg-[#edf5ff] md:hidden">
              <X />
            </button>
          </div>

          <div className="px-3 pt-4.5">
            <Link
              href="/"
              onClick={close}
              className="flex h-12 items-center justify-center gap-2 rounded-xl bg-[#247cff] text-sm font-semibold text-white shadow-[0_10px_24px_rgba(36,124,255,0.24)] transition hover:-translate-y-0.5 hover:bg-[#176bea] hover:shadow-[0_14px_28px_rgba(36,124,255,0.28)]"
            >
              <Plus className="size-4" />
              新建优惠活动
            </Link>
          </div>

          <nav className="flex min-h-0 flex-1 flex-col px-3 pb-3" aria-label="主导航">
            <p className="px-3 pb-2 pt-5 text-[11px] font-semibold tracking-[0.14em] text-[#8aa0b9]">最近活动</p>
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
              {sessions.length ? (
                sessions.map((session) => (
                  // 删除按钮不能放进 Link 里，点它会连带触发导航，所以外面包一层定位容器。
                  <div key={session.id} className="group relative">
                    <Link
                      href={`/c/${session.id}`}
                      onClick={close}
                      className={`relative block rounded-xl border py-2.5 pl-3 pr-10 transition ${session.id === activeId ? "border-[#c7ddff] bg-[#eaf4ff] text-[#174e96] shadow-[0_8px_22px_rgba(36,124,255,0.09)] before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-[#247cff]" : "border-transparent text-[#4f6380] hover:border-[#e1ecf8] hover:bg-[#f5f9ff] hover:text-[#223d63]"}`}
                    >
                      <span className="line-clamp-1 text-sm font-medium">{session.title}</span>
                      <span className={`mt-0.5 block text-[11px] ${session.id === activeId ? "text-[#5f82ad]" : "text-[#8da0b7]"}`}>{STATUS_LABEL[session.status] ?? "旧版本"}</span>
                    </Link>
                    <button
                      type="button"
                      aria-label={`删除 ${session.title}`}
                      onClick={() => void removeSession(session.id, session.title)}
                      // 触屏没有 hover，小屏上常显，否则删不掉。
                      className="absolute right-2 top-2 grid size-7 place-items-center rounded-lg text-[#9bb0c7] opacity-0 transition hover:bg-[#ffece9] hover:text-[#c2402c] focus-visible:opacity-100 group-hover:opacity-100 max-md:opacity-100"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))
              ) : (
                <p className="px-3 py-2 text-[13px] text-[#91a4bb]">还没有活动</p>
              )}
            </div>

            <p className="px-3 pb-2 pt-5 text-[11px] font-semibold tracking-[0.14em] text-[#8aa0b9]">规则资料</p>
            {referenceLinks.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                onClick={close}
                className={`mb-1 flex h-11 items-center gap-3 rounded-xl border px-3 text-sm transition ${pathname === href ? "border-[#c7ddff] bg-[#eaf4ff] font-medium text-[#174e96]" : "border-transparent text-[#58708d] hover:border-[#e1ecf8] hover:bg-[#f5f9ff] hover:text-[#234d82]"}`}
              >
                <Icon className={`size-4 ${pathname === href ? "text-[#247cff]" : "text-[#7f94ad]"}`} />
                {label}
              </Link>
            ))}
          </nav>

          <div className="m-3 rounded-2xl border border-[#d6e6f8] bg-[linear-gradient(145deg,#f8fbff,#eaf4ff)] p-4 shadow-[0_10px_28px_rgba(43,94,151,0.07)]">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#27415f]">
              <span className="relative flex size-2.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-[#20a674]/35 motion-reduce:animate-none" />
                <span className="relative inline-flex size-2.5 rounded-full bg-[#20a674]" />
              </span>
              AI Agent 已连接
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-[#247cff]">
              <Sparkles className="size-3.5" />
              8 个业务工具 · 实时规则复核
            </div>
            <p className="mt-2 text-[11px] leading-5 text-[#6f85a0]">理解、查表、规则分析和填写值生成都会留下可展开的执行记录。</p>
          </div>
        </aside>

        <main className="min-w-0">{children}</main>
      </div>

      {mobileNav ? <button type="button" aria-label="关闭导航遮罩" onClick={close} className="fixed inset-0 z-40 bg-[#183452]/25 backdrop-blur-[2px] md:hidden" /> : null}
    </div>
  );
}
