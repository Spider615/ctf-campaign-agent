"use client";

import { Check, ChevronDown, ChevronRight, Loader2, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";

import { formatDuration, type AgentTraceEvent } from "../../lib/tool-trace";

// 分析过程按时间线展示：一行一步，左边状态图标和竖线，标题写做了什么，下面一行灰字写得到了什么。
// 进行中默认展开，完成后收成一行「已完成 · 用时」，点开再看。
export function ToolTimeline({ steps, live, startedAt, durationMs, stopped = false }: { steps: AgentTraceEvent[]; live: boolean; startedAt?: number; durationMs?: number; stopped?: boolean }) {
  // 进行中始终展开；完成后由用户决定是否展开。
  const [manual, setManual] = useState<boolean | null>(null);
  const open = live || (manual ?? false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [live]);
  const elapsed = live ? Math.max(0, now - (startedAt ?? now)) : durationMs ?? 0;
  const label = live ? "正在分析" : stopped ? "已停止" : "已完成";
  return (
    <section aria-label="分析过程" aria-live={live ? "polite" : undefined} className="min-w-0 select-text">
      <button type="button" aria-expanded={open} onClick={() => setManual(!open)} className="inline-flex min-h-9 items-center gap-1 rounded-md text-[13px] text-[#6b7f96] hover:text-[#2f4a66] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {label} · {formatDuration(elapsed)}
        {open ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
      </button>
      {open ? <ol className="mt-1">
        {steps.map((step, index) => <TimelineStep key={step.id} step={step} live={live} last={index === steps.length - 1} />)}
      </ol> : null}
    </section>
  );
}

function TimelineStep({ step, live, last }: { step: AgentTraceEvent; live: boolean; last: boolean }) {
  const running = step.status === "started";
  const Icon = running ? Loader2 : step.status === "completed" ? Check : step.status === "warning" ? TriangleAlert : X;
  const tone = running ? "text-[#2470cc]" : step.status === "completed" ? "text-[#7c8ea3]" : step.status === "warning" ? "text-[#b5761a]" : "text-[#c2413b]";
  const [action, ...rest] = step.title.split(" · ");
  const detail = rest.join(" · ");
  return (
    <li className="relative grid grid-cols-[20px_minmax(0,1fr)] gap-x-2 pb-2.5">
      {!last ? <span aria-hidden="true" className="absolute bottom-0 left-[9.5px] top-5 w-px bg-[#e1e8f0]" /> : null}
      <span className={`mt-[3px] grid size-5 place-items-center ${tone}`}>
        <Icon className={`size-3.5 ${running && live ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden="true" />
        <span className="sr-only">{running ? "进行中" : step.status === "completed" ? "完成" : step.status === "warning" ? "需修改" : "未完成"}</span>
      </span>
      <div className="min-w-0">
        <p className="break-words text-[13px] leading-6 text-[#41566f]">
          <span className="font-medium text-[#2f4560]">{action}</span>
          {detail ? <span className="text-[#6b7f96]"> · {detail}</span> : null}
          {step.durationMs !== undefined && step.durationMs >= 1000 ? <span className="ml-1.5 text-[11px] text-[#9aabbd]">{formatDuration(step.durationMs)}</span> : null}
        </p>
        {step.summary && !running ? <p className="break-words text-[12.5px] leading-5 text-[#7c8ea3]">{step.summary}</p> : null}
      </div>
    </li>
  );
}
