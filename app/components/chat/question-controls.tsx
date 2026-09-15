"use client";

import { Plus, Trash2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import { CODEBOOK } from "../../lib/campaign/ics1811/codebook";
import { discountValue } from "../../lib/campaign/ics1811/phrases";
import type { Gap, Ics1811Draft, OfferPattern, QuestionId } from "../../lib/campaign/ics1811/types";
import { Chip } from "./chip";

// 每道追问题的原始输入。卡片和草稿面板共用：界面只存原始输入，提交时由 toAnswer 换算成卡片回答（结构见 ics1811/card.ts）。
type Tier = { ratio: string; labor: string; free: boolean };
export type RawAnswer = {
  start: string;
  end: string;
  stores: string[];
  query: string;
  pattern: OfferPattern | "";
  discount: string;
  threshold: string;
  amount: string;
  multiple: string;
  diamondNoDiscount: boolean;
  tiers: Tier[];
  choice: string;
  slots: Record<string, string[]>;
  none: boolean;
  concession: string;
  collection: string;
  text: string;
  legal: string;
};

const PATTERNS: Array<{ value: Exclude<OfferPattern, "unsupported">; label: string }> = [
  { value: "discount", label: "打折" },
  { value: "threshold", label: "满减" },
  { value: "per_gram", label: "黄金每克减" },
  { value: "platinum_tradein", label: "铂金以旧换新" },
  { value: "diamond_upgrade", label: "钻石以小换大" },
  { value: "gold_tradein", label: "黄金以旧换新" },
  { value: "diamond_gold_gram", label: "买钻石享黄金克减" },
];

const CHOICES: Partial<Record<QuestionId, Array<{ value: string; label: string }>>> = {
  Q3b: [{ value: "true", label: "能改价（浮动折扣模式）" }, { value: "false", label: "不能改价（固定折扣模式）" }],
  Q3c: [{ value: "once", label: "只减一次" }, { value: "every", label: "每满都减" }],
  Q3d: [{ value: "actual", label: "按实际克重" }, { value: "whole", label: "按整克" }],
  Q4a: [{ value: "true", label: "转为 outlet 餐牌" }, { value: "false", label: "不转餐牌" }],
  Q5b: [{ value: "actual_price", label: "按实际售价算" }, { value: "price_times_discount", label: "按实际售价 × 折扣算" }],
  Q5c: [{ value: "true", label: "有" }, { value: "false", label: "没有" }],
  Q6b: [{ value: "true", label: "法务确认过" }, { value: "false", label: "还没确认" }],
};

const SLOT_LABEL: Record<string, string> = { all: "参与货类", diamond: "钻石用哪个货类", gold: "黄金用哪个货类" };

const text = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(value));
const discountInput = (value: number | null | undefined) => (value === null || value === undefined ? "" : String(Math.round(value * 100) % 10 === 0 ? Math.round(value * 10) : Math.round(value * 100)));

export function initialRaw(gap: Gap, draft: Ics1811Draft): RawAnswer {
  const offer = draft.facts.offer?.value;
  const first = offer?.items[0];
  const slogan = draft.facts.slogan?.value;
  return {
    start: draft.facts.dates?.value.start ?? "",
    end: draft.facts.dates?.value.end ?? "",
    stores: draft.facts.stores?.value ?? [],
    query: "",
    pattern: offer && offer.pattern !== "unsupported" ? offer.pattern : "",
    discount: discountInput(first?.discount),
    threshold: text(first?.threshold),
    amount: text(first?.amount),
    multiple: text(first?.multiple),
    diamondNoDiscount: first?.discount === 1,
    tiers: offer?.pattern === "gold_tradein" && offer.items.length
      ? offer.items.map((item) => ({ ratio: item.upgradeRatio === null ? "" : String(Math.round(item.upgradeRatio * 100)), labor: item.discount ? discountInput(item.discount) : "", free: item.discount === 0 }))
      : [{ ratio: "", labor: "", free: false }],
    choice: "",
    slots: draft.facts.categories?.value ?? {},
    none: false,
    concession: text(draft.facts.rates?.value.concession),
    collection: text(draft.facts.rates?.value.collection),
    text: slogan?.wanted ? slogan.text : "",
    legal: "",
  };
}

const positive = (value: string) => (value.trim() && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null);

function rateValue(value: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(%)?\s*$/.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return match[2] ? number / 100 : number <= 1 ? number : null;
}

// 返回 null 表示这一题没作答；error 表示填了但格式不对。
export function toAnswer(gap: Gap, raw: RawAnswer): { answer: Record<string, unknown> | null; error: string | null } {
  const none = { answer: null, error: null };
  const bad = (error: string) => ({ answer: null, error });
  const ok = (answer: Record<string, unknown>) => ({ answer, error: null });
  switch (gap.id) {
    case "Q1":
      if (!raw.start && !raw.end) return none;
      if (!raw.start || !raw.end) return bad("开始、结束日期都要填");
      return raw.start > raw.end ? bad("开始日期不能晚于结束日期") : ok({ start: raw.start, end: raw.end });
    case "Q2":
      return raw.stores.length ? ok({ stores: raw.stores }) : none;
    case "Q3":
    case "Q3a": {
      if (!raw.pattern) return none;
      const discount = raw.discount.trim() ? discountValue(raw.discount.trim()) : null;
      if (raw.discount.trim() && discount === null) return bad("折扣填几折，例如 9 或 95");
      const base = { discount: null, upgradeRatio: null, multiple: null, threshold: null, amount: null };
      switch (raw.pattern) {
        case "discount":
          return discount === null ? none : ok({ pattern: raw.pattern, items: [{ ...base, discount }] });
        case "threshold": {
          const threshold = positive(raw.threshold);
          const amount = positive(raw.amount);
          if (threshold === null && amount === null) return none;
          return threshold !== null && amount !== null ? ok({ pattern: raw.pattern, items: [{ ...base, threshold, amount }] }) : bad("满多少、减多少都要填");
        }
        case "per_gram": {
          const amount = positive(raw.amount);
          return amount === null ? none : ok({ pattern: raw.pattern, items: [{ ...base, amount }] });
        }
        case "platinum_tradein":
          return ok({ pattern: raw.pattern, items: [{ ...base, discount, multiple: positive(raw.multiple) }] });
        case "diamond_upgrade":
          return discount === null ? none : ok({ pattern: raw.pattern, items: [{ ...base, discount }] });
        case "gold_tradein": {
          const items = raw.tiers.filter((tier) => tier.ratio.trim()).map((tier) => ({ ...base, upgradeRatio: positive(tier.ratio) === null ? null : Number(tier.ratio) / 100, discount: tier.free ? 0 : tier.labor.trim() ? discountValue(tier.labor.trim()) : null }));
          if (!items.length) return none;
          return items.some((item) => item.upgradeRatio === null) ? bad("换大比例填百分数，例如 50") : ok({ pattern: raw.pattern, items });
        }
        case "diamond_gold_gram":
          return ok({ pattern: raw.pattern, items: [{ ...base, discount: raw.diamondNoDiscount ? 1 : discount, amount: positive(raw.amount) }] });
      }
      return none;
    }
    case "Q3b":
      return raw.choice ? ok({ editable: raw.choice === "true" }) : none;
    case "Q3c":
      return raw.choice ? ok({ repeat: raw.choice }) : none;
    case "Q3d":
      return raw.choice ? ok({ basis: raw.choice }) : none;
    case "Q3e":
      return none;
    case "Q4": {
      const slots = Object.fromEntries((gap.slots ?? ["all"]).map((slot) => [slot, raw.slots[slot] ?? []]).filter(([, codes]) => (codes as string[]).length));
      return Object.keys(slots).length ? ok({ slots }) : none;
    }
    case "Q4a":
      return raw.choice ? ok({ convert: raw.choice === "true" }) : none;
    case "Q5a": {
      if (raw.none) return ok({ none: true });
      if (!raw.concession.trim() && !raw.collection.trim()) return none;
      const concession = rateValue(raw.concession);
      const collection = rateValue(raw.collection);
      return concession === null || collection === null ? bad("让扣点、回款率填小数或百分数，例如 0.02 或 2%") : ok({ concession, collection });
    }
    case "Q5b":
      return raw.choice ? ok({ commission: raw.choice }) : none;
    case "Q5c":
      return raw.choice ? ok({ has: raw.choice === "true" }) : none;
    case "Q6a":
      if (raw.choice === "no") return ok({ wanted: false });
      if (raw.choice !== "yes") return none;
      if (!raw.text.trim()) return bad("请填写法务确认过的标语原文");
      return raw.legal ? ok({ wanted: true, text: raw.text.trim(), legalConfirmed: raw.legal === "true" }) : bad("请选择法务是否确认过");
    case "Q6b":
      return raw.choice ? ok({ legalConfirmed: raw.choice === "true" }) : none;
  }
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[12px] text-[#7d6f72]">{children}</span>;
}

const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

export function QuestionControl({ gap, raw, disabled, onChange }: { gap: Gap; raw: RawAnswer; disabled: boolean; onChange: (patch: Partial<RawAnswer>) => void }) {
  const choices = CHOICES[gap.id];
  if (choices) {
    return (
      <div className="flex flex-wrap gap-2">
        {choices.map((option) => (
          <Chip key={option.value} disabled={disabled} selected={raw.choice === option.value} onClick={() => onChange({ choice: raw.choice === option.value ? "" : option.value })}>
            {option.label}
          </Chip>
        ))}
      </div>
    );
  }

  switch (gap.id) {
    case "Q1":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <label><Label>开始日期</Label><Input type="date" disabled={disabled} value={raw.start} onChange={(event) => onChange({ start: event.target.value })} className="mt-1 h-9 bg-white" /></label>
          <label><Label>结束日期（当天有效）</Label><Input type="date" disabled={disabled} value={raw.end} onChange={(event) => onChange({ end: event.target.value })} className="mt-1 h-9 bg-white" /></label>
        </div>
      );
    case "Q2": {
      const query = raw.query.trim();
      const candidates = gap.candidates ?? [];
      const stores = CODEBOOK.stores
        .filter((store) => !query || store.display.includes(query))
        .sort((a, b) => Number(candidates.includes(b.display)) - Number(candidates.includes(a.display)));
      return (
        <div className="space-y-2">
          <Input disabled={disabled} value={raw.query} onChange={(event) => onChange({ query: event.target.value })} className="h-9 bg-white" placeholder="按店号或店名查找" />
          <div className="flex flex-wrap gap-2">
            {stores.map((store) => (
              <Chip key={store.code} disabled={disabled} selected={raw.stores.includes(store.code)} onClick={() => onChange({ stores: toggle(raw.stores, store.code) })}>
                {store.display}
              </Chip>
            ))}
          </div>
        </div>
      );
    }
    case "Q3":
    case "Q3a":
      return <OfferControl gap={gap} raw={raw} disabled={disabled} onChange={onChange} />;
    case "Q4":
      return (
        <div className="space-y-3">
          {(gap.slots ?? ["all"]).map((slot) => (
            <div key={slot}>
              {(gap.slots?.length ?? 0) > 1 ? <Label>{SLOT_LABEL[slot] ?? slot}</Label> : null}
              <div className="mt-1 flex flex-wrap gap-2">
                {CODEBOOK.categories.filter((entry) => entry.code !== "不适用").map((entry) => (
                  <Chip key={entry.code} disabled={disabled} selected={(raw.slots[slot] ?? []).includes(entry.code)} onClick={() => onChange({ slots: { ...raw.slots, [slot]: toggle(raw.slots[slot] ?? [], entry.code) } })}>
                    {entry.label}
                  </Chip>
                ))}
              </div>
            </div>
          ))}
        </div>
      );
    case "Q5a":
      return (
        <div className="space-y-2">
          <Chip disabled={disabled} selected={raw.none} onClick={() => onChange({ none: !raw.none })}>没有，都填 0</Chip>
          {raw.none ? null : (
            <div className="grid gap-2 sm:grid-cols-2">
              <label><Label>让扣点</Label><Input disabled={disabled} value={raw.concession} onChange={(event) => onChange({ concession: event.target.value })} className="mt-1 h-9 bg-white" placeholder="例如 0.02 或 2%" /></label>
              <label><Label>回款率</Label><Input disabled={disabled} value={raw.collection} onChange={(event) => onChange({ collection: event.target.value })} className="mt-1 h-9 bg-white" placeholder="例如 0.98 或 98%" /></label>
            </div>
          )}
        </div>
      );
    case "Q6a":
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Chip disabled={disabled} selected={raw.choice === "no"} onClick={() => onChange({ choice: raw.choice === "no" ? "" : "no" })}>不加标语</Chip>
            <Chip disabled={disabled} selected={raw.choice === "yes"} onClick={() => onChange({ choice: raw.choice === "yes" ? "" : "yes" })}>要加标语</Chip>
          </div>
          {raw.choice === "yes" ? (
            <>
              <Input disabled={disabled} value={raw.text} onChange={(event) => onChange({ text: event.target.value })} className="h-9 bg-white" placeholder="法务确认过的标语原文，照抄" />
              <div className="flex flex-wrap gap-2">
                <Chip disabled={disabled} selected={raw.legal === "true"} onClick={() => onChange({ legal: "true" })}>法务确认过</Chip>
                <Chip disabled={disabled} selected={raw.legal === "false"} onClick={() => onChange({ legal: "false" })}>还没确认（这次不填）</Chip>
              </div>
            </>
          ) : null}
        </div>
      );
    default:
      return <p className="text-[12px] text-[#8a7d80]">这一项请直接在对话里说明。</p>;
  }
}

function OfferControl({ gap, raw, disabled, onChange }: { gap: Gap; raw: RawAnswer; disabled: boolean; onChange: (patch: Partial<RawAnswer>) => void }) {
  const number = (key: "discount" | "threshold" | "amount" | "multiple", label: string, placeholder: string) => (
    <label key={key}><Label>{label}</Label><Input inputMode="decimal" disabled={disabled} value={raw[key]} onChange={(event) => onChange({ [key]: event.target.value })} className="mt-1 h-9 bg-white" placeholder={placeholder} /></label>
  );
  return (
    <div className="space-y-3">
      {gap.id === "Q3" ? (
        <div className="flex flex-wrap gap-2">
          {PATTERNS.map((option) => (
            <Chip key={option.value} disabled={disabled} selected={raw.pattern === option.value} onClick={() => onChange({ pattern: option.value })}>{option.label}</Chip>
          ))}
        </div>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {raw.pattern === "discount" ? number("discount", "打几折", "例如 9 或 95") : null}
        {raw.pattern === "threshold" ? [number("threshold", "满多少元", "例如 5000"), number("amount", "减多少元", "例如 500")] : null}
        {raw.pattern === "per_gram" ? number("amount", "每克减多少元", "例如 15") : null}
        {raw.pattern === "platinum_tradein" ? [number("multiple", "换大几倍", "1.5、2 或 2.5"), number("discount", "开单打几折", "例如 9")] : null}
        {raw.pattern === "diamond_upgrade" ? number("discount", "开单打几折", "例如 99") : null}
        {raw.pattern === "diamond_gold_gram" ? [number("amount", "黄金每克减多少元", "例如 20"), raw.diamondNoDiscount ? null : number("discount", "钻石打几折", "例如 95")] : null}
      </div>
      {raw.pattern === "diamond_gold_gram" ? (
        <Chip disabled={disabled} selected={raw.diamondNoDiscount} onClick={() => onChange({ diamondNoDiscount: !raw.diamondNoDiscount })}>钻石不打折</Chip>
      ) : null}
      {raw.pattern === "gold_tradein" ? (
        <div className="space-y-2">
          {raw.tiers.map((tier, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <label className="w-28"><Label>换大比例（%）</Label><Input inputMode="decimal" disabled={disabled} value={tier.ratio} onChange={(event) => onChange({ tiers: raw.tiers.map((item, at) => (at === index ? { ...item, ratio: event.target.value } : item)) })} className="mt-1 h-9 bg-white" placeholder="50" /></label>
              {tier.free ? null : <label className="w-28"><Label>工费打几折</Label><Input inputMode="decimal" disabled={disabled} value={tier.labor} onChange={(event) => onChange({ tiers: raw.tiers.map((item, at) => (at === index ? { ...item, labor: event.target.value } : item)) })} className="mt-1 h-9 bg-white" placeholder="8" /></label>}
              <Chip disabled={disabled} selected={tier.free} onClick={() => onChange({ tiers: raw.tiers.map((item, at) => (at === index ? { ...item, free: !item.free } : item)) })}>免工费</Chip>
              {raw.tiers.length > 1 ? (
                <button type="button" aria-label="删除这一档" disabled={disabled} onClick={() => onChange({ tiers: raw.tiers.filter((_, at) => at !== index) })} className="grid size-9 place-items-center rounded-lg text-[#8a7d80] hover:bg-[#f3ece4]"><Trash2 className="size-4" /></button>
              ) : null}
            </div>
          ))}
          <button type="button" disabled={disabled} onClick={() => onChange({ tiers: [...raw.tiers, { ratio: "", labor: "", free: false }] })} className="inline-flex items-center gap-1 text-[13px] text-[#651427]"><Plus className="size-3.5" />再加一个换大比例</button>
        </div>
      ) : null}
    </div>
  );
}
