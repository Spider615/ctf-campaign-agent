"use client";

import { ChevronDown, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { traceCardSummary, type AgentTraceEvent, type ToolTrace } from "../../lib/tool-trace";
import { ToolStep } from "./tool-step";

type ToolRunCardProps = {
  trace: ToolTrace | AgentTraceEvent[];
  live: boolean;
  startedAt?: number | null;
};

function elapsedLabel(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

export function ToolRunCard({ trace, live, startedAt }: ToolRunCardProps) {
  const steps = Array.isArray(trace) ? trace : trace.steps;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [live]);

  const durationMs = Array.isArray(trace)
    ? Math.max(0, now - (startedAt ?? steps[0]?.startedAt ?? now))
    : trace.durationMs;
  const storedSummary = !Array.isArray(trace) ? traceCardSummary(trace) : null;
  const modelTools = useMemo(() => new Set(steps.filter((step) => step.initiatedBy === "model").map((step) => step.tool)), [steps]);
  const rows = (
    <ol className="space-y-2 px-3 pb-3 pt-1 sm:px-4 sm:pb-4">
      {steps.map((event) => (
        <ToolStep
          key={event.id}
          event={event}
          live={live}
          showSupplement={event.initiatedBy === "orchestrator" && modelTools.has(event.tool)}
        />
      ))}
    </ol>
  );

  const header = (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-3 sm:px-4">
      <span className="relative grid size-7 shrink-0 place-items-center rounded-lg bg-[#e9f3ff] text-[#247cff]">
        {live ? <span className="absolute size-2.5 animate-ping rounded-full bg-[#247cff]/35 motion-reduce:animate-none" aria-hidden="true" /> : null}
        <Sparkles className="relative size-3.5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold text-[#20314d]">{live ? "AI 正在搭建活动" : "AI 工具执行记录"}</p>
        <p className={`truncate text-[11px] ${storedSummary?.tone === "failed" ? "text-[#c2413b]" : storedSummary?.tone === "warning" ? "text-[#a86510]" : "text-[#6c82a0]"}`}>
          {live ? `${steps.filter((step) => step.status !== "started").length} 步已完成 · ${elapsedLabel(durationMs)}` : storedSummary?.label}
        </p>
      </div>
      {!live ? <ChevronDown className="size-4 shrink-0 text-[#7590af] transition-transform group-open:rotate-180" aria-hidden="true" /> : null}
    </div>
  );

  const className = "overflow-hidden rounded-2xl border border-[#bfd8ff] bg-[linear-gradient(145deg,rgba(246,250,255,.98),rgba(235,244,255,.9))] shadow-[0_12px_34px_rgba(36,124,255,0.10)]";
  if (live) {
    return (
      <section role="status" aria-live="polite" aria-label="AI 工具执行进度" className={className}>
        {header}
        {rows}
      </section>
    );
  }
  return (
    <details className={`group ${className}`}>
      <summary className="flex cursor-pointer list-none items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#247cff] focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
        {header}
      </summary>
      {rows}
    </details>
  );
}
