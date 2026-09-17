import { CheckCircle2, CircleDot, Loader2, TriangleAlert, XCircle } from "lucide-react";

import { formatDuration, type AgentTraceEvent } from "../../lib/tool-trace";

const STATUS_COPY = {
  started: "执行中",
  completed: "已完成",
  warning: "需注意",
  failed: "失败",
} as const;

export function ToolStep({ event, live, showSupplement = false }: { event: AgentTraceEvent; live: boolean; showSupplement?: boolean }) {
  const Icon = event.status === "started" ? Loader2 : event.status === "completed" ? CheckCircle2 : event.status === "warning" ? TriangleAlert : XCircle;
  const tone = event.status === "failed"
    ? "text-[#c2413b]"
    : event.status === "warning" ? "text-[#b66b13]" : event.status === "completed" ? "text-[#15805f]" : "text-[#247cff]";
  const iconSurface = event.status === "failed"
    ? "bg-[#fff0ed]"
    : event.status === "warning" ? "bg-[#fff4dc]" : event.status === "completed" ? "bg-[#e8f7f1]" : "bg-[#e9f3ff]";

  return (
    <li className="grid cursor-text select-text grid-cols-[24px_minmax(0,1fr)_auto] gap-x-2.5 rounded-xl border border-[#e1ecf8] bg-white/80 px-3 py-2.5 shadow-[0_3px_12px_rgba(43,94,151,0.04)]">
      <span className={`mt-0.5 grid size-6 select-none place-items-center rounded-full ${iconSurface} ${tone}`}>
        <Icon className={`size-3.5 ${event.status === "started" && live ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-semibold text-[#22314a]">{event.title}</span>
          <code className="max-w-full truncate rounded-md bg-[#eff6ff] px-1.5 py-0.5 font-mono text-[10px] text-[#47709f]">{event.tool}</code>
          {showSupplement ? <span className="select-none rounded-full bg-[#fff4dc] px-1.5 py-0.5 text-[10px] font-medium text-[#9a620d]">系统补跑</span> : null}
          {event.initiatedBy === "orchestrator" && !showSupplement ? <span className="select-none rounded-full bg-[#eef5ff] px-1.5 py-0.5 text-[10px] font-medium text-[#4f72a1]">确定性执行</span> : null}
        </div>
        <p className={`mt-1 text-[12px] leading-5 ${event.summary ? "text-[#61728a]" : "text-[#8aa0bb]"}`}>
          {event.summary ?? (event.status === "started" ? "正在调用并核验结果…" : STATUS_COPY[event.status])}
        </p>
      </div>
      <span className={`mt-0.5 inline-flex select-none items-center gap-1 whitespace-nowrap text-[11px] font-medium ${tone}`}>
        {event.status === "started" ? <CircleDot className="size-3" aria-hidden="true" /> : null}
        {event.durationMs === undefined ? STATUS_COPY[event.status] : formatDuration(event.durationMs)}
      </span>
    </li>
  );
}
