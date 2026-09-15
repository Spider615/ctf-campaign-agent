"use client";

import { ArrowLeft, ArrowRight, CalendarDays, Check, Info, Layers3, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { calculateOrderCount } from "../lib/campaign/split-orders";
import type { CampaignDraft, CustomerAction, FieldValue, OccasionType, OfferMechanism } from "../lib/campaign/types";
import { SourceBadge } from "./source-badge";

type ReviewFormProps = {
  draft: CampaignDraft;
  onChange: (draft: CampaignDraft) => void;
  onBack: () => void;
  onGenerate: () => void;
  busy: boolean;
  error: string;
};

const actions: CustomerAction[] = ["只看到", "参与互动", "到场", "留资", "下单", "带旧货来换", "还没定"];
const occasions: OccasionType[] = ["日历节点", "品牌节点", "外部节点", "线下场", "门店日常经营", "私域日常运营"];
const mechanisms: OfferMechanism[] = ["无让利", "以旧换新换购", "门槛型", "直接价格", "赠品兑换", "券核销", "还没定"];

function Section({
  index,
  title,
  note,
  children,
}: {
  index: string;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[#ded5cb] bg-[#fffdfa] p-5 shadow-[0_10px_30px_rgba(65,32,39,0.035)] md:p-6">
      <div className="mb-5 flex items-start gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#641428] text-[12px] font-semibold text-white">{index}</span>
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-[#34252a]">{title}</h2>
          {note ? <p className="mt-1 text-sm leading-5 text-[#85797c]">{note}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function FieldLabel({ children, source, required }: { children: React.ReactNode; source?: FieldValue<unknown>; required?: boolean }) {
  return (
    <div className="mb-2 flex min-h-6 items-center justify-between gap-2">
      <label className="text-sm font-medium text-[#4a3a3e]">
        {children}{required ? <span className="ml-1 text-[#aa3c24]">*</span> : null}
      </label>
      {source ? <SourceBadge field={source} /> : null}
    </div>
  );
}

function ChoiceButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-10 rounded-lg border px-3 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9c6b2f] ${
        selected ? "border-[#7a2134] bg-[#f6e9ec] font-medium text-[#651427]" : "border-[#ddd4ca] bg-white text-[#6f6265] hover:border-[#bda998]"
      }`}
    >
      {selected ? <Check className="mr-1 inline size-3.5" /> : null}
      {children}
    </button>
  );
}

export function ReviewForm({ draft, onChange, onBack, onGenerate, busy, error }: ReviewFormProps) {
  const summary = calculateOrderCount(draft);
  const tier = draft.offer.tiers[0];
  const update = (mutate: (next: CampaignDraft) => void) => {
    const next = structuredClone(draft) as CampaignDraft;
    mutate(next);
    onChange(next);
  };
  const toggle = (values: string[], value: string) => (values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  const blockers = [
    draft.intent.occasion.provenance === "pending",
    draft.intent.customerAction.value === "还没定",
    draft.audience.segments.value.length === 0,
    draft.audience.membership.value === "还没定",
    draft.products.categories.value.length === 0,
    draft.intent.customerAction.value !== "只看到" && draft.offer.mechanism.value === "还没定",
    draft.intent.customerAction.value !== "只看到" && draft.offer.stacking.value === "还没定",
    draft.intent.customerAction.value !== "只看到" && (!tier || (tier.discountRate === null && tier.amountOff === null)),
    draft.scope.markets.value.length === 0,
    draft.scope.channels.value.length === 0,
    !draft.schedule.batches[0]?.startDate,
    !draft.schedule.batches[0]?.endDate,
    draft.operations.concessionRate.value === null,
    draft.operations.collectionRate.value === null,
  ].filter(Boolean).length;

  return (
    <div className="soft-in min-h-[calc(100vh-72px)] px-4 py-5 md:px-6">
      <div className="mx-auto max-w-[1280px]">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <button type="button" onClick={onBack} className="mb-2 inline-flex items-center gap-1.5 text-sm text-[#7d6f72] hover:text-[#651427]">
              <ArrowLeft className="size-4" /> 返回
            </button>
            <h1 className="text-2xl font-semibold tracking-[-0.025em] text-[#2d1d22] md:text-3xl">确认 Agent 的理解</h1>
            <p className="mt-1 text-sm text-[#817578]">已填的直接确认，黄色项需要你补。</p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            {["1 说需求", "2 补关键项", "3 拿结果"].map((label, index) => (
              <span key={label} className={`rounded-full px-3 py-1.5 ${index === 1 ? "bg-[#651427] text-white" : "bg-[#e9e2da] text-[#7f7275]"}`}>{label}</span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-5 max-lg:grid-cols-1">
          <div className="space-y-4">
            <Section index="A" title="为什么做，顾客做到哪一步">
              <div className="grid gap-5 md:grid-cols-2">
                <div>
                  <FieldLabel source={draft.intent.occasion} required>由头</FieldLabel>
                  <NativeSelect
                    className="w-full bg-white"
                    value={draft.intent.occasion.value}
                    onChange={(event) => update((next) => { next.intent.occasion = { value: event.target.value as OccasionType, provenance: "user" }; })}
                  >
                    {occasions.map((item) => <NativeSelectOption key={item}>{item}</NativeSelectOption>)}
                  </NativeSelect>
                </div>
                <div>
                  <FieldLabel>真实由头一句话</FieldLabel>
                  <Input value={draft.intent.reason} onChange={(event) => update((next) => { next.intent.reason = event.target.value; })} className="h-10 bg-white" />
                </div>
              </div>
              <div className="mt-5">
                <FieldLabel source={draft.intent.customerAction} required>顾客做到哪一步才算数</FieldLabel>
                <div className="flex flex-wrap gap-2">
                  {actions.map((action) => (
                    <ChoiceButton key={action} selected={draft.intent.customerAction.value === action} onClick={() => update((next) => { next.intent.customerAction = { value: action, provenance: "user" }; })}>
                      {action}
                    </ChoiceButton>
                  ))}
                </div>
              </div>
              <div className="mt-4 rounded-xl bg-[#f5efe7] px-4 py-3 text-sm text-[#6d5d5f]">
                Agent 判断：<strong className="font-semibold text-[#4b3037]">{draft.intent.derivedType}</strong>
              </div>
            </Section>

            <Section index="B" title="人群与货品" note="不按年龄和性别臆测客群。">
              <div className="grid gap-5 md:grid-cols-2">
                <div>
                  <FieldLabel source={draft.audience.segments} required>打的是哪类人</FieldLabel>
                  <div className="flex flex-wrap gap-2">
                    {["为母亲选礼的人", "家庭赠礼客群", "婚嫁客群", "存量会员", "到店游客"].map((item) => (
                      <ChoiceButton key={item} selected={draft.audience.segments.value.includes(item)} onClick={() => update((next) => { next.audience.segments = { value: toggle(next.audience.segments.value, item), provenance: "user" }; })}>{item}</ChoiceButton>
                    ))}
                  </div>
                </div>
                <div>
                  <FieldLabel source={draft.products.categories} required>业务大类</FieldLabel>
                  <div className="flex flex-wrap gap-2">
                    {["镶嵌类", "素金类", "黄金类", "赠品"].map((item) => (
                      <ChoiceButton key={item} selected={draft.products.categories.value.includes(item)} onClick={() => update((next) => { next.products.categories = { value: toggle(next.products.categories.value, item), provenance: "user" }; })}>{item}</ChoiceButton>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-5 grid gap-5 md:grid-cols-2">
                <div>
                  <FieldLabel>主推系列 / 专款</FieldLabel>
                  <Input value={draft.products.series} onChange={(event) => update((next) => { next.products.series = event.target.value; })} className="h-10 bg-white" />
                </div>
                <div>
                  <FieldLabel source={draft.audience.membership}>会员限制</FieldLabel>
                  <NativeSelect className="w-full bg-white" value={draft.audience.membership.value} onChange={(event) => update((next) => { next.audience.membership = { value: event.target.value as "不限" | "限" | "还没定", provenance: "user" }; })}>
                    {(["不限", "限", "还没定"] as const).map((item) => <NativeSelectOption key={item}>{item}</NativeSelectOption>)}
                  </NativeSelect>
                </div>
              </div>
            </Section>

            {draft.intent.customerAction.value === "只看到" ? (
              <section className="rounded-2xl border border-[#d7c8b4] bg-[#f5eee4] p-6">
                <div className="flex gap-3">
                  <Info className="mt-0.5 size-5 text-[#8b6330]" />
                  <div>
                    <h2 className="font-semibold text-[#4b3524]">本次不建 ICS 单</h2>
                    <p className="mt-1 text-sm leading-6 text-[#75624f]">顾客动作只到品牌曝光。展览报名、到场与互动应由 CRM 或活动系统承接。</p>
                  </div>
                </div>
              </section>
            ) : (
              <Section index="C" title="让利规则" note="优惠数字必须由你明确填写。">
                <div className="grid gap-5 md:grid-cols-2">
                  <div>
                    <FieldLabel source={draft.offer.mechanism} required>让利机制</FieldLabel>
                    <NativeSelect className="w-full bg-white" value={draft.offer.mechanism.value} onChange={(event) => update((next) => { next.offer.mechanism = { value: event.target.value as OfferMechanism, provenance: "user" }; })}>
                      {mechanisms.map((item) => <NativeSelectOption key={item}>{item}</NativeSelectOption>)}
                    </NativeSelect>
                  </div>
                  <div>
                    <FieldLabel source={draft.offer.stacking} required>能否叠加其他折扣、券</FieldLabel>
                    <div className="flex gap-2">
                      {(["是", "否", "还没定"] as const).map((item) => <ChoiceButton key={item} selected={draft.offer.stacking.value === item} onClick={() => update((next) => { next.offer.stacking = { value: item, provenance: "user" }; })}>{item}</ChoiceButton>)}
                    </div>
                  </div>
                </div>
                {tier ? (
                  <div className="mt-5 rounded-xl border border-[#e3d8cc] bg-[#faf7f2] p-4">
                    <div className="mb-4 flex items-center justify-between">
                      <div><p className="text-sm font-semibold text-[#46363a]">优惠档位 01</p><p className="mt-1 text-[12px] text-[#8a7e80]">8 折填 0.8；减多少钱填减免额</p></div>
                      <span className="rounded-full bg-white px-2 py-1 text-[12px] text-[#8b6b3b]">一档一行</span>
                    </div>
                    <div className="grid gap-3 md:grid-cols-3">
                      <div><FieldLabel>判断金额（元）</FieldLabel><Input type="number" value={tier.thresholdAmount ?? ""} onChange={(event) => update((next) => { next.offer.tiers[0].thresholdAmount = event.target.value ? Number(event.target.value) : null; })} className="h-10 bg-white" /></div>
                      <div><FieldLabel>折扣率</FieldLabel><Input type="number" step="0.01" value={tier.discountRate ?? ""} onChange={(event) => update((next) => { next.offer.tiers[0].discountRate = event.target.value ? Number(event.target.value) : null; if (event.target.value) next.offer.tiers[0].amountOff = null; })} className="h-10 bg-white" /></div>
                      <div><FieldLabel>减免额（元）</FieldLabel><Input type="number" value={tier.amountOff ?? ""} onChange={(event) => update((next) => { next.offer.tiers[0].amountOff = event.target.value ? Number(event.target.value) : null; if (event.target.value) next.offer.tiers[0].discountRate = null; })} className="h-10 bg-white" /></div>
                    </div>
                  </div>
                ) : null}
              </Section>
            )}

            <Section index="D" title="范围与档期">
              <div className="grid gap-5 md:grid-cols-2">
                <div>
                  <FieldLabel source={draft.scope.level} required>范围层级</FieldLabel>
                  <NativeSelect className="w-full bg-white" value={draft.scope.level.value} onChange={(event) => update((next) => { next.scope.level = { value: event.target.value as CampaignDraft["scope"]["level"]["value"], provenance: "user" }; })}>
                    {(["全国", "区域", "分区", "指定门店", "电商平台"] as const).map((item) => <NativeSelectOption key={item}>{item}</NativeSelectOption>)}
                  </NativeSelect>
                </div>
                <div>
                  <FieldLabel required>范围描述</FieldLabel>
                  <Input value={draft.scope.regionCode} onChange={(event) => update((next) => { next.scope.regionCode = event.target.value; })} className="h-10 bg-white" />
                </div>
              </div>
              <div className="mt-5 grid gap-5 md:grid-cols-2">
                <div>
                  <FieldLabel source={draft.scope.markets} required>覆盖市场</FieldLabel>
                  <div className="flex gap-2">{["内地", "港澳"].map((item) => <ChoiceButton key={item} selected={draft.scope.markets.value.includes(item)} onClick={() => update((next) => { next.scope.markets = { value: toggle(next.scope.markets.value, item), provenance: "user" }; })}>{item}</ChoiceButton>)}</div>
                </div>
                <div>
                  <FieldLabel source={draft.scope.channels} required>渠道</FieldLabel>
                  <div className="flex gap-2">{(["线下", "线上"] as const).map((item) => <ChoiceButton key={item} selected={draft.scope.channels.value.includes(item)} onClick={() => update((next) => { next.scope.channels = { value: toggle(next.scope.channels.value, item) as Array<"线上" | "线下">, provenance: "user" }; })}>{item}</ChoiceButton>)}</div>
                </div>
              </div>
              <div className="mt-5 grid gap-3 rounded-xl border border-[#e3d8cc] bg-[#faf7f2] p-4 md:grid-cols-2">
                <div><FieldLabel required>开始日期</FieldLabel><Input type="date" value={draft.schedule.batches[0]?.startDate ?? ""} onChange={(event) => update((next) => { next.schedule.batches[0].startDate = event.target.value; })} className="h-10 bg-white" /></div>
                <div><FieldLabel required>结束日期</FieldLabel><Input type="date" value={draft.schedule.batches[0]?.endDate ?? ""} onChange={(event) => update((next) => { next.schedule.batches[0].endDate = event.target.value; })} className="h-10 bg-white" /></div>
              </div>
            </Section>

            <Section index="E" title="AI 推不出来、只有你知道的几个数" note="演示门店沿用上次同业务大类的值。">
              <div className="grid gap-5 md:grid-cols-3">
                <div><FieldLabel source={draft.operations.concessionRate} required>让扣点</FieldLabel><Input type="number" step="0.01" value={draft.operations.concessionRate.value ?? ""} onChange={(event) => update((next) => { next.operations.concessionRate = { value: event.target.value === "" ? null : Number(event.target.value), provenance: "user" }; })} className="h-10 bg-white" /></div>
                <div><FieldLabel source={draft.operations.collectionRate} required>回款率</FieldLabel><Input type="number" step="0.01" value={draft.operations.collectionRate.value ?? ""} onChange={(event) => update((next) => { next.operations.collectionRate = { value: event.target.value === "" ? null : Number(event.target.value), provenance: "user" }; })} className="h-10 bg-white" /></div>
                <div>
                  <FieldLabel source={draft.operations.paymentRestricted} required>限制支付方式</FieldLabel>
                  <div className="flex h-10 items-center justify-between rounded-lg border bg-white px-3"><span className="text-sm text-[#6f6265]">{draft.operations.paymentRestricted.value ? "有限制" : "不限制"}</span><Switch checked={draft.operations.paymentRestricted.value} onCheckedChange={(checked) => update((next) => { next.operations.paymentRestricted = { value: checked, provenance: "user" }; })} /></div>
                </div>
              </div>
            </Section>
          </div>

          <aside className="sticky top-5 rounded-2xl border border-[#ccbcae] bg-[#3f101c] p-5 text-white shadow-[0_20px_60px_rgba(66,20,35,0.18)] max-lg:static">
            <div className="flex items-center gap-2 text-[#dfbf82]"><Layers3 className="size-4" /><span className="text-sm font-medium">实时拆单</span></div>
            <div className="mt-4 flex items-end gap-2"><strong className="text-5xl font-semibold tracking-[-0.05em]">{summary.total}</strong><span className="pb-1.5 text-sm text-[#d8c8cc]">条 ICS 草稿</span></div>
            {summary.reason ? <p className="mt-4 rounded-xl bg-white/8 p-3 text-sm leading-6 text-[#f1e7e9]">{summary.reason}</p> : (
              <p className="mt-4 text-sm leading-6 text-[#d8c8cc]">{summary.factors.batches} 批次 × {summary.factors.markets} 市场 × {summary.factors.channels} 渠道 × {summary.factors.scopeUnits} 范围 × {summary.factors.offerTiers} 档优惠</p>
            )}
            <div className="my-5 h-px bg-white/12" />
            <div className="flex items-center justify-between text-sm"><span className="text-[#d8c8cc]">还需补齐</span><strong className={blockers ? "text-[#ffd27d]" : "text-[#a9dfb5]"}>{blockers} 项</strong></div>
            {error ? <div role="alert" className="mt-4 rounded-xl bg-[#7e2534] p-3 text-sm leading-5 text-white">{error}</div> : null}
            <Button onClick={onGenerate} disabled={busy || blockers > 0} className="mt-5 h-12 w-full rounded-xl bg-[#d2a85e] text-[#351018] hover:bg-[#e0b970]">
              {busy ? <Loader2 className="animate-spin" /> : <CalendarDays />}
              {busy ? "正在生成" : "生成活动方案"}
              {!busy ? <ArrowRight /> : null}
            </Button>
            {blockers > 0 ? <p className="mt-2 text-center text-[12px] text-[#cdbdc1]">补齐黄色必填项后可生成</p> : null}
          </aside>
        </div>
      </div>
    </div>
  );
}
