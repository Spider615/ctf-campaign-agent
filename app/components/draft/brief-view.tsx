import { Check, CircleDashed, Quote, Route } from "lucide-react";

import type { CampaignWorkspace } from "../../lib/campaign/types";

const STAGE_LABEL: Record<CampaignWorkspace["stage"], string> = {
  briefing: "正在收拢 Brief",
  planning: "方案规划中",
  preparing: "执行准备中",
  blocked: "存在阻断",
  needs_confirmation: "待人工确认",
};

export function BriefView({ workspace }: { workspace: CampaignWorkspace }) {
  const { brief, routing } = workspace;
  const completion = brief.totalCount ? Math.round((brief.completeCount / brief.totalCount) * 100) : 100;

  return (
    <div className="space-y-5 text-[#34292b]">
      <section className="relative overflow-hidden border border-[#e8ddd3] bg-[#fffdf9] shadow-[0_18px_44px_rgba(74,36,37,0.06)]">
        <div className="absolute inset-y-0 left-0 w-1 bg-[#8f1737]" aria-hidden="true" />
        <div className="p-5 pl-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] font-semibold tracking-[0.24em] text-[#9a7650]">CAMPAIGN BRIEF</p>
              <h3 className="mt-2 font-serif text-[22px] leading-tight text-[#431e28]">活动母版</h3>
              <p className="mt-2 text-[12px] leading-5 text-[#76696a]">先确认活动为什么做、对谁说，再让各执行轨并行展开。</p>
            </div>
            <span className={`shrink-0 border px-2.5 py-1 text-[11px] font-medium ${brief.status === "ready" ? "border-[#c8d9c7] bg-[#f3f8f1] text-[#3e704b]" : "border-[#e5c9bf] bg-[#fff6f1] text-[#8f4b37]"}`}>
              {STAGE_LABEL[workspace.stage]}
            </span>
          </div>

          <div className="mt-5 flex items-end justify-between gap-4">
            <div>
              <p className="font-serif text-3xl text-[#8f1737]">{brief.completeCount}<span className="mx-1 text-base text-[#aa9995]">/</span><span className="text-base text-[#6f6061]">{brief.totalCount}</span></p>
              <p className="mt-1 text-[11px] text-[#8c7e7b]">核心信息已确认</p>
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <div className="flex items-center justify-between text-[10px] tracking-[0.08em] text-[#9a8985]">
                <span>BRIEF 完整度</span>
                <span>{completion}%</span>
              </div>
              <div className="mt-2 h-px bg-[#eadfd6]" role="progressbar" aria-label="Brief 完整度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={completion}>
                <div className="h-px bg-[#8f1737] transition-[width] duration-500" style={{ width: `${completion}%` }} />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="brief-fields-title">
        <div className="mb-2 flex items-center justify-between">
          <h4 id="brief-fields-title" className="text-[11px] font-semibold tracking-[0.16em] text-[#6b5559]">已记录的活动依据</h4>
          <span className="text-[10px] text-[#a08f8b]">带 * 为核心项</span>
        </div>
        <div className="border-y border-[#e9dfd7] bg-white/60">
          {brief.items.map((item) => (
            <div key={item.key} className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 border-b border-[#efe7e1] px-1 py-3.5 last:border-b-0">
              <div className="flex items-start gap-1.5 pt-0.5">
                {item.status === "confirmed" ? <Check className="mt-0.5 size-3.5 shrink-0 text-[#8f1737]" aria-hidden="true" /> : <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-[#c4aaa0]" aria-hidden="true" />}
                <p className="text-[11px] font-medium text-[#756568]">{item.label}{item.required ? <span className="ml-0.5 text-[#a71e3f]">*</span> : null}</p>
              </div>
              <div className="min-w-0">
                <p className={`break-words text-[13px] leading-5 ${item.value ? "text-[#32272a]" : "text-[#a37869]"}`}>{item.value ?? "待补充"}</p>
                {item.quote ? (
                  <p className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-4 text-[#9a8884]">
                    <Quote className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                    <span className="line-clamp-2">依据：{item.quote}</span>
                  </p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-l-2 border-[#b38b55] bg-[#faf6ef] px-3.5 py-3">
        <div className="flex items-start gap-2">
          <Route className="mt-0.5 size-4 shrink-0 text-[#9b6b32]" aria-hidden="true" />
          <div>
            <p className="text-[11px] font-semibold tracking-[0.08em] text-[#725333]">当前路由</p>
            <p className="mt-1 text-[12px] leading-5 text-[#6f6260]">{routing.basis.join("；")}</p>
          </div>
        </div>
      </section>
    </div>
  );
}
