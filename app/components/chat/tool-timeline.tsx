"use client";

import { Check, ChevronDown, ChevronRight, Loader2, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { hasMeaningfulTextSelection } from "../../lib/client/text-selection";
import { formatDuration, type AgentTraceEvent, type ToolTrace } from "../../lib/tool-trace";

type TimelineStatus = ToolTrace["status"] | "cancelled";
type ToolTimelineProps = {
  steps: AgentTraceEvent[];
  live: boolean;
  startedAt?: number | null;
  durationMs?: number;
  status?: TimelineStatus;
  context?: "analysis" | "campaign";
};
const isSkill = (step: AgentTraceEvent) => step.tool === "load_campaign_skill" || step.tool === "load_analytics_skill";
const skillTitle = (title: string) => title.replace(/^加载(?:业务规则[：:]\s*|(?:分析)?(?:技能|Skill)[：:]\s*)?/, "").trim();

// 两类对话共用真实轨迹；成功加载的规则合并，业务动作和未成功的加载保留原顺序。
export function ToolTimeline({ steps, live, startedAt, durationMs, status, context = "analysis" }: ToolTimelineProps) {
  const overall = status ?? (steps.some((step) => step.status === "failed" || step.status === "started") ? "failed" : steps.some((step) => step.status === "warning") ? "warning" : "completed");
  const [manual, setManual] = useState<boolean | null>(null);
  const open = live || (manual ?? overall !== "completed");
  const contentId = useId();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [live]);
  const elapsed = live ? Math.max(0, now - (startedAt ?? now)) : durationMs ?? 0;
  const label = live ? context === "campaign" ? "正在准备活动" : "正在分析"
    : overall === "cancelled" ? "已停止" : overall === "failed" ? "执行失败" : overall === "warning" ? "完成，需注意" : "已完成";
  const tone = !live && overall === "failed" ? "text-[#c2413b]" : !live && overall === "warning" ? "text-[#b5761a]" : "text-[#6b7f96]";
  const skills = [...new Set(steps.filter((step) => isSkill(step) && step.status === "completed").map((step) => skillTitle(step.title)))];
  const actions = steps.filter((step) => !isSkill(step) || step.status !== "completed");
  return (
    <section aria-label={context === "campaign" ? "活动准备过程" : "分析过程"} aria-live={live ? "polite" : undefined} className="min-w-0 select-text">
      <button type="button" aria-expanded={open} aria-controls={contentId} onClick={(event) => {
        if (event.detail === 0 || !hasMeaningfulTextSelection(window.getSelection())) setManual(!open);
      }} className={`inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-md text-left text-[13px] hover:text-[#2f4a66] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tone}`}>
        <span className="min-w-0 break-words">{!live && context === "campaign" ? "活动准备 · " : ""}{label} · {formatDuration(elapsed)}</span>
        {open ? <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />}
      </button>
      <div id={contentId} hidden={!open}>
        {skills.length ? <p className="mb-2 break-words text-xs leading-6 text-[#6b7f96]">参考了：{skills.join("、")}</p> : null}
        {actions.length ? <ol className="mt-1">
          {actions.map((step, index) => <TimelineStep key={step.id} step={step} live={live} overall={overall} last={index === actions.length - 1} />)}
        </ol> : null}
      </div>
    </section>
  );
}

function TimelineStep({ step, live, overall, last }: { step: AgentTraceEvent; live: boolean; overall: TimelineStatus; last: boolean }) {
  const running = step.status === "started" && live;
  const pending = step.status === "started" && !live;
  const label = running ? "进行中" : pending ? overall === "cancelled" ? "已停止" : "未完成" : step.status === "completed" ? "完成" : step.status === "warning" ? "需注意" : "失败";
  const Icon = running ? Loader2 : step.status === "completed" ? Check : step.status === "warning" ? TriangleAlert : X;
  const tone = running ? "text-[#2470cc]" : (pending && overall === "cancelled") || step.status === "completed" ? "text-[#7c8ea3]" : step.status === "warning" ? "text-[#b5761a]" : "text-[#c2413b]";
  const [action, ...rest] = step.title.split(" · ");
  const detail = rest.join(" · ");
  return (
    <li className="relative grid grid-cols-[20px_minmax(0,1fr)] gap-x-2 pb-2.5">
      {!last ? <span aria-hidden="true" className="absolute bottom-0 left-[9.5px] top-5 w-px bg-[#e1e8f0]" /> : null}
      <span className={`mt-[3px] grid size-5 place-items-center ${tone}`}>
        <Icon className={`size-3.5 ${running && live ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden="true" />
        {step.status === "completed" ? <span className="sr-only">{label}</span> : null}
      </span>
      <div className="min-w-0">
        <p className="break-words text-[13px] leading-6 text-[#41566f]">
          <span className="font-medium text-[#2f4560]">{action}</span>
          {detail ? <span className="text-[#6b7f96]"> · {detail}</span> : null}
          {!isSkill(step) && step.durationMs !== undefined && step.durationMs >= 1000 ? <span className="ml-1.5 text-[11px] text-[#9aabbd]">{formatDuration(step.durationMs)}</span> : null}
        </p>
        {step.summary && !running ? <p className="break-words text-[12.5px] leading-5 text-[#7c8ea3]">{step.summary}</p> : null}
        {step.status !== "completed" ? <p className={`text-xs leading-5 ${tone}`}>{label}</p> : null}
      </div>
    </li>
  );
}
