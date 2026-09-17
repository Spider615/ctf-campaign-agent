import { Building2, CircleDot, Gem, Megaphone, Route, Sparkles, Store, Target, UsersRound } from "lucide-react";

import type { CampaignExecutionTrack, CampaignWorkspace } from "../../lib/campaign/types";

const TRACK_LABEL: Record<CampaignWorkspace["routing"]["tracks"][number], string> = {
  brand_launch: "品牌发布",
  transaction_offer: "成交优惠",
  member_crm: "会员触达",
};

const TRACK_ICON = {
  strategy: Target,
  brand_launch: Gem,
  transaction_offer: Sparkles,
  member_crm: UsersRound,
  communications: Megaphone,
  store_readiness: Store,
} satisfies Record<CampaignExecutionTrack["kind"], typeof Target>;

const STATUS = {
  not_started: { label: "未开始", tone: "border-[#ddd4cc] bg-[#faf8f5] text-[#887b76]", dot: "bg-[#b4a9a3]" },
  in_progress: { label: "推进中", tone: "border-[#dbc89f] bg-[#fff9eb] text-[#8a642c]", dot: "bg-[#b88b42]" },
  blocked: { label: "有阻断", tone: "border-[#e4bbb5] bg-[#fff4f2] text-[#96483d]", dot: "bg-[#b85246]" },
  needs_confirmation: { label: "待确认", tone: "border-[#dec9d0] bg-[#fff6f8] text-[#8f4058]", dot: "bg-[#9f3451]" },
  ready: { label: "已准备", tone: "border-[#c6d9c8] bg-[#f2f8f2] text-[#47714d]", dot: "bg-[#56865e]" },
  not_applicable: { label: "不适用", tone: "border-[#dedbd7] bg-[#faf9f7] text-[#958d88]", dot: "bg-[#b9b2ad]" },
} satisfies Record<CampaignExecutionTrack["status"], { label: string; tone: string; dot: string }>;

export function ExecutionTrackView({ workspace }: { workspace: CampaignWorkspace }) {
  return (
    <div className="space-y-5 text-[#34292b]">
      <section className="border border-[#e7ddd5] bg-[#fffdf9] px-4 py-4 shadow-[0_16px_38px_rgba(74,36,37,0.05)]">
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center border border-[#d9c6b0] bg-[#fbf4e9] text-[#8b6030]">
            <Route className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold tracking-[0.22em] text-[#9a7650]">PARALLEL WORKSTREAMS</p>
            <h3 className="mt-1.5 font-serif text-xl text-[#431e28]">并行执行轨</h3>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {workspace.routing.tracks.length ? workspace.routing.tracks.map((track) => (
                <span key={track} className="border border-[#e2d1c3] bg-white px-2 py-1 text-[10px] font-medium text-[#705b54]">{TRACK_LABEL[track]}</span>
              )) : <span className="text-[12px] text-[#96776d]">活动类型还需确认，暂未分轨。</span>}
            </div>
          </div>
          <span className="font-serif text-2xl text-[#8f1737]">{String(workspace.executionTracks.length).padStart(2, "0")}</span>
        </div>
      </section>

      <ol className="relative space-y-0 before:absolute before:bottom-6 before:left-[18px] before:top-5 before:w-px before:bg-[#e1d5cc]" aria-label="活动执行轨">
        {workspace.executionTracks.map((track, index) => {
          const Icon = TRACK_ICON[track.kind];
          const status = STATUS[track.status];
          return (
            <li key={track.id} className="relative grid grid-cols-[38px_minmax(0,1fr)] gap-3 pb-6 last:pb-0">
              <div className="z-10 grid size-[38px] place-items-center border border-[#d8c9be] bg-[#fffdf9] text-[#8f1737] shadow-[0_3px_12px_rgba(80,43,42,0.08)]">
                <Icon className="size-4" aria-hidden="true" />
              </div>
              <article className="min-w-0 border-b border-[#e9dfd7] pb-5 last:border-b-0">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] tracking-[0.16em] text-[#a58f87]">TRACK {String(index + 1).padStart(2, "0")}</p>
                    <h4 className="mt-1 text-[14px] font-semibold text-[#392b2e]">{track.title}</h4>
                  </div>
                  <span className={`inline-flex shrink-0 items-center gap-1.5 border px-2 py-1 text-[10px] font-medium ${status.tone}`}>
                    <span className={`size-1.5 rounded-full ${status.dot}`} aria-hidden="true" />
                    {status.label}
                  </span>
                </div>
                <p className="mt-2 text-[12px] leading-5 text-[#75676a]">{track.summary}</p>

                <div className="mt-3 grid gap-2 bg-[#faf7f3] px-3 py-2.5 text-[11px] sm:grid-cols-[88px_minmax(0,1fr)]">
                  <p className="flex items-center gap-1.5 font-medium text-[#8e7469]"><Building2 className="size-3" aria-hidden="true" />负责角色</p>
                  <p className="text-[#4f4144]">{track.ownerRole}</p>
                  <p className="flex items-center gap-1.5 font-medium text-[#8e7469]"><CircleDot className="size-3" aria-hidden="true" />下一步</p>
                  <p className={track.nextAction ? "text-[#4f4144]" : "text-[#628066]"}>{track.nextAction ?? "当前轨已具备下一阶段条件"}</p>
                </div>

                {track.basis.length ? (
                  <details className="group mt-2">
                    <summary className="cursor-pointer list-none text-[10px] text-[#9a7a6e] marker:hidden hover:text-[#8f1737]">查看判断依据</summary>
                    <ul className="mt-2 space-y-1 border-l border-[#d9c6b0] pl-3 text-[10px] leading-4 text-[#8d7d79]">
                      {track.basis.map((basis) => <li key={basis}>{basis}</li>)}
                    </ul>
                  </details>
                ) : null}
              </article>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
