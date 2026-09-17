import { CalendarDays, Gem, Megaphone, MessageCircle, Share2, ShoppingBag, Sparkles, Store, UsersRound } from "lucide-react";

import type { CampaignChannel, CommunicationCreative } from "../../lib/campaign/types";

const CHANNEL = {
  store: { label: "门店", icon: Store },
  wechat: { label: "微信生态", icon: MessageCircle },
  ecommerce: { label: "电商", icon: ShoppingBag },
  social: { label: "社交媒体", icon: Share2 },
  member_crm: { label: "会员 CRM", icon: UsersRound },
  event: { label: "线下活动", icon: CalendarDays },
} satisfies Record<CampaignChannel, { label: string; icon: typeof Store }>;

export function CommunicationsView({ creative }: { creative: CommunicationCreative | null }) {
  if (!creative) {
    return (
      <div className="overflow-hidden border border-[#e6dbd1] bg-[#fffdf9] text-[#34292b] shadow-[0_18px_44px_rgba(74,36,37,0.05)]">
        <div className="grid min-h-64 place-items-center px-6 py-10 text-center">
          <div className="max-w-[290px]">
            <div className="mx-auto grid size-12 place-items-center rounded-full border border-[#d9c3a8] bg-[#fbf3e8] text-[#8c6030]">
              <Megaphone className="size-5" aria-hidden="true" />
            </div>
            <p className="mt-5 text-[10px] font-semibold tracking-[0.22em] text-[#9a7650]">COMMUNICATIONS</p>
            <h3 className="mt-2 font-serif text-[22px] text-[#431e28]">传播方案尚未起草</h3>
            <p className="mt-3 text-[12px] leading-6 text-[#78696b]">Brief 的目标、受众、主题和渠道齐备后，让 Agent 产出核心创意、分渠道内容与视觉方向。所有内容仍需品牌与法务审核。</p>
            <div className="mx-auto mt-6 h-px w-20 bg-[#b89564]" aria-hidden="true" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 text-[#34292b]">
      <section className="relative overflow-hidden bg-[#6f132b] px-5 py-6 text-[#fff9f3] shadow-[0_20px_50px_rgba(85,18,37,0.2)]">
        <Gem className="absolute -bottom-7 -right-5 size-32 rotate-12 text-white/[0.05]" strokeWidth={0.7} aria-hidden="true" />
        <div className="relative">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[10px] font-semibold tracking-[0.24em] text-[#dfc3a2]">01 · CORE IDEA</p>
            <span className="inline-flex items-center gap-1 border border-white/20 bg-white/[0.06] px-2 py-1 text-[9px] tracking-[0.08em] text-[#f2ded3]">
              <Sparkles className="size-3" aria-hidden="true" />{creative.source === "ai" ? "AI 草案" : "用户提供"}
            </span>
          </div>
          <h3 className="mt-7 max-w-[92%] font-serif text-[28px] leading-[1.18] tracking-[-0.02em]">{creative.concept.headline}</h3>
          <p className="mt-3 text-[13px] leading-5 text-[#f2ded7]">{creative.concept.subheadline}</p>
          <div className="mt-6 border-t border-white/20 pt-4">
            <p className="text-[10px] tracking-[0.16em] text-[#d6b895]">核心表达</p>
            <p className="mt-2 text-[12px] leading-6 text-[#fff8f1]">{creative.concept.coreMessage}</p>
          </div>
        </div>
      </section>

      <section aria-labelledby="channel-output-title">
        <div className="mb-3 flex items-end justify-between">
          <div>
            <p className="text-[10px] font-semibold tracking-[0.22em] text-[#9a7650]">02 · CHANNEL KIT</p>
            <h4 id="channel-output-title" className="mt-1 font-serif text-lg text-[#431e28]">分渠道内容</h4>
          </div>
          <span className="font-serif text-xl text-[#8f1737]">{String(creative.channelOutputs.length).padStart(2, "0")}</span>
        </div>
        <div className="divide-y divide-[#e9dfd7] border-y border-[#e9dfd7] bg-white/55">
          {creative.channelOutputs.map((output, index) => {
            const channel = CHANNEL[output.channel];
            const Icon = channel.icon;
            return (
              <article key={`${output.channel}-${index}`} className="px-1 py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-[#6d4a43]">
                    <Icon className="size-4" aria-hidden="true" />
                    <h5 className="text-[12px] font-semibold">{channel.label}</h5>
                  </div>
                  <span className="border border-[#e2d6cd] bg-[#fbf8f4] px-2 py-1 text-[9px] tracking-[0.08em] text-[#8a7771]">{output.format}</span>
                </div>
                <p className="mt-3 whitespace-pre-line text-[12px] leading-6 text-[#514347]">{output.copy}</p>
                <p className="mt-3 border-l-2 border-[#b38b55] pl-2.5 text-[11px] font-medium text-[#805f37]">行动引导 · {output.cta}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="border border-[#e2d4c5] bg-[#faf5ed] p-4">
        <p className="text-[10px] font-semibold tracking-[0.22em] text-[#9a7650]">03 · ART DIRECTION</p>
        <div className="mt-3 flex items-start gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-full border border-[#d9c3a8] text-[#956936]"><Gem className="size-4" aria-hidden="true" /></div>
          <p className="text-[12px] leading-6 text-[#66575a]">{creative.visualDirection}</p>
        </div>
      </section>

      <p className="flex items-start gap-2 border-l-2 border-[#9f3451] bg-[#fff6f8] px-3 py-2.5 text-[10px] leading-4 text-[#785963]">
        <Megaphone className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        这是传播创意草案，不改变活动事实；发布前请由品牌、渠道与法务按实际流程审核。
      </p>
    </div>
  );
}
