"use client";

import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { createSessionRequest, notifySessionsChanged } from "../../lib/client/api";
import { Composer } from "./composer";

export function EmptyState({ initialMode = "analysis" }: { initialMode?: "analysis" | "execution" }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState(initialMode);

  // 建会话只保存这句话，不等模型；理解过程在对话页里以思考动画展示。
  const start = async (body: { entryMode: "new"; text: string }) => {
    if (mode === "analysis") {
      router.push(`/analysis?question=${encodeURIComponent(body.text.slice(0, 500))}`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const snapshot = await createSessionRequest(body);
      notifySessionsChanged();
      router.push(`/c/${snapshot.session.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "对话暂时无法创建，请重试");
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-[calc(100dvh-4rem)] items-center overflow-hidden px-4 py-12 md:min-h-screen md:px-8">
      <div aria-hidden="true" className="pointer-events-none absolute left-[18%] top-[14%] size-56 rounded-full bg-[#75b8ff]/12 blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute bottom-[8%] right-[12%] size-64 rounded-full bg-[#b9dcff]/20 blur-3xl" />
      <div data-testid="chat" className="relative mx-auto w-full max-w-[820px] text-center">
        <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#cde1fb] bg-white/70 px-3 py-1.5 text-[13px] font-semibold text-[#247cff] shadow-[0_6px_20px_rgba(36,124,255,0.08)] backdrop-blur">
          <Sparkles className="size-3.5" />
          周大福营销决策工作台
        </span>
        <h1 className="text-[clamp(2.15rem,5vw,4rem)] font-bold leading-[1.07] tracking-[-0.045em] text-[#17243a]">
          {mode === "analysis" ? "复盘营销活动" : "从一个想法开始"}
          <span className="block text-[var(--brand-ruby)]">{mode === "analysis" ? "看清数据里的差异" : "一起把营销活动做完整"}</span>
        </h1>
        <p className="mx-auto mt-4 max-w-[680px] text-[15px] leading-7 text-[#657a95] md:text-base">{mode === "analysis" ? "导入经营明细，比较历史表现，发现区域、货类和会员分组的差异。每条结论都能核对计算口径和数据明细。" : "先整理活动目标和范围，再准备执行步骤、优惠配置和传播方案。执行参数由你确认，配置校验与版本记录继续保留。"}</p>
        <div className="mt-5 inline-flex gap-2 rounded-xl border border-border bg-card p-1">
          <button type="button" aria-pressed={mode === "analysis"} onClick={() => setMode("analysis")} className={`min-h-11 rounded-lg px-4 text-sm ${mode === "analysis" ? "bg-secondary text-secondary-foreground" : "text-muted-foreground"}`}>分析经营数据</button>
          <button type="button" aria-pressed={mode === "execution"} onClick={() => setMode("execution")} className={`min-h-11 rounded-lg px-4 text-sm ${mode === "execution" ? "bg-secondary text-secondary-foreground" : "text-muted-foreground"}`}>创建执行活动</button>
        </div>

        <div className="mx-auto mt-8 max-w-[760px] text-left">
          <Composer
            value={text}
            onChange={setText}
            onSubmit={() => void start({ entryMode: "new", text })}
            busy={busy}
            placeholder={mode === "analysis" ? "例如：复盘七夕活动，新老会员的表现有什么差异？" : "例如：国庆做一场新品传播活动，指定门店黄金每克减 40 元"}
          />
        </div>
        {mode === "analysis" ? <div className="mx-auto mt-4 flex max-w-[760px] flex-wrap justify-center gap-2 text-sm">
          <Link href="/analysis?question=复盘历史活动的销售表现" className="inline-flex min-h-11 items-center rounded-lg border border-border bg-card px-3">复盘历史活动</Link>
          <Link href="/analysis?question=比较不同区域和货类的活动效果" className="inline-flex min-h-11 items-center rounded-lg border border-border bg-card px-3">比较分组效果</Link>
          <Link href="/analysis?question=发现新老会员表现的差异" className="inline-flex min-h-11 items-center rounded-lg border border-border bg-card px-3">寻找会员差异</Link>
        </div> : null}
        {error ? (
          <p role="alert" className="mx-auto mt-3 max-w-[760px] rounded-xl border border-[#f2c8c3] bg-[#fff4f2] px-4 py-3 text-left text-sm text-[#a43f37]">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
