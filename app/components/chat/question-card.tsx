"use client";

import { Check, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { stripParenthetical } from "../../lib/campaign/evidence";
import type { QuestionPrefill } from "../../lib/campaign/messages";
import {
  CATEGORY_OPTIONS,
  CHANNEL_OPTIONS,
  CUSTOMER_ACTION_OPTIONS,
  FIELD_LABEL,
  FIELD_WHY,
  LEVEL_OPTIONS,
  MARKET_OPTIONS,
  MECHANISM_OPTIONS,
  OCCASION_OPTIONS,
  SEGMENT_OPTIONS,
  type FieldKey,
  type TopicId,
} from "../../lib/campaign/topics";
import type { CampaignDraft } from "../../lib/campaign/types";

const AUTO_SUBMIT: FieldKey[] = ["customerAction", "occasion", "stacking", "paymentRestricted"];

export function Chip({ selected, disabled, onClick, children }: { selected: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`min-h-9 rounded-full border px-3.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9c6b2f] disabled:cursor-not-allowed disabled:opacity-55 ${
        selected ? "border-[#7a2134] bg-[#f6e9ec] font-medium text-[#651427]" : "border-[#ddd4ca] bg-white text-[#5f5256] hover:border-[#bda998]"
      }`}
    >
      {selected ? <Check className="mr-1 inline size-3.5" /> : null}
      {children}
    </button>
  );
}

const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

function parseNumber(text: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : Number.NaN;
}

function parseStores(text: string): { stores: Array<{ code: string; name: string }>; error: string | null } {
  const stores: Array<{ code: string; name: string }> = [];
  for (const line of text.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const match = /^(\S+)[\s　]+(.+)$/.exec(line);
    if (!match || !/^[A-Za-z0-9-]+$/.test(match[1])) return { stores: [], error: `「${line}」格式不对，应为「行号 行名」` };
    if (!stores.some((store) => store.code === match[1])) stores.push({ code: match[1], name: match[2].trim() });
  }
  return { stores, error: stores.length ? null : "请至少填一家门店" };
}

function FieldBlock({ label, why, showLabel, children }: { label: string; why?: string; showLabel: boolean; children: React.ReactNode }) {
  return (
    <div>
      {showLabel || why ? (
        <div className="mb-2">
          {showLabel ? <p className="text-[13px] font-medium text-[#4a3a3e]">{label}</p> : null}
          {why ? <p className="text-[12px] leading-5 text-[#8a7d80]">{why}</p> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

type QuestionCardProps = {
  topic: TopicId;
  fields: FieldKey[];
  draft: CampaignDraft;
  prefill?: QuestionPrefill;
  busy: boolean;
  compact?: boolean;
  onSubmit: (values: Record<string, unknown>) => void;
};

export function QuestionCard({ topic, fields, draft, prefill, busy, compact = false, onSubmit }: QuestionCardProps) {
  const has = (key: FieldKey) => fields.includes(key);
  const tier = draft.offer.tiers[0];
  const batch = draft.schedule.batches[0];

  const [customerAction, setCustomerAction] = useState<string>(draft.intent.customerAction.value === "还没定" ? "" : draft.intent.customerAction.value);
  const [occasion, setOccasion] = useState<string>(draft.intent.occasion.provenance === "pending" && !draft.intent.occasion.suggested ? "" : draft.intent.occasion.value);
  const [mechanism, setMechanism] = useState<string>(
    draft.offer.mechanism.value === "还没定" || draft.offer.mechanism.provenance === "default" ? "" : draft.offer.mechanism.value,
  );
  const [threshold, setThreshold] = useState(tier?.thresholdAmount != null ? String(tier.thresholdAmount) : "");
  const [discountMode, setDiscountMode] = useState<"off" | "rate">(tier?.discountRate != null ? "rate" : "off");
  const [amountOff, setAmountOff] = useState(tier?.amountOff != null ? String(tier.amountOff) : "");
  const [discount, setDiscount] = useState(tier?.discountRate != null ? String(Number((tier.discountRate * 10).toFixed(2))) : "");
  const [stacking, setStacking] = useState<string>(draft.offer.stacking.provenance === "user" ? draft.offer.stacking.value : "");
  const [level, setLevel] = useState<string>(draft.scope.level.provenance === "pending" && !draft.scope.level.suggested && !draft.scope.regionCode ? "" : draft.scope.level.value);
  const [regionText, setRegionText] = useState(stripParenthetical(draft.scope.regionCode));
  const [divisionText, setDivisionText] = useState(stripParenthetical(draft.scope.divisionCode));
  const [storesText, setStoresText] = useState(draft.scope.stores.map((store) => `${store.code} ${store.name}`).join("\n"));
  const [markets, setMarkets] = useState<string[]>(draft.scope.markets.value);
  const [channels, setChannels] = useState<string[]>(draft.scope.channels.value);
  const [startDate, setStartDate] = useState(batch?.startDate ?? "");
  const [endDate, setEndDate] = useState(batch?.endDate ?? "");
  const [segments, setSegments] = useState<string[]>(draft.audience.segments.value);
  const [otherSegment, setOtherSegment] = useState("");
  const [categories, setCategories] = useState<string[]>(draft.products.categories.value);
  const [membership, setMembership] = useState<string>(draft.audience.membership.provenance === "user" ? draft.audience.membership.value : "");
  const [membershipDescription, setMembershipDescription] = useState(draft.audience.membershipDescription);
  const [concession, setConcession] = useState(draft.operations.concessionRate.value !== null ? String(draft.operations.concessionRate.value) : "");
  const [collection, setCollection] = useState(draft.operations.collectionRate.value !== null ? String(draft.operations.collectionRate.value) : "");
  const [payment, setPayment] = useState<"" | "yes" | "no">(
    draft.operations.paymentRestricted.provenance === "user" ? (draft.operations.paymentRestricted.value ? "yes" : "no") : "",
  );

  const effectiveMechanism = mechanism || (draft.offer.mechanism.value === "还没定" ? "" : draft.offer.mechanism.value);
  const showTier = (effectiveMechanism === "门槛型" || effectiveMechanism === "直接价格") && (has("tier") || has("mechanism"));
  const showStacking = has("stacking") && effectiveMechanism !== "无让利";
  const needsCode = (has("level") || has("scopeCode")) && (level === "区域" || level === "分区" || level === "指定门店");
  const auto = fields.length === 1 && AUTO_SUBMIT.includes(fields[0]);
  const showLabel = fields.length > 1 || compact;
  const why = (key: FieldKey) => (compact ? undefined : FIELD_WHY[key]);

  const build = (): { values: Record<string, unknown> | null; error: string | null } => {
    const incomplete = { values: null, error: null };
    const values: Record<string, unknown> = {};
    switch (topic) {
      case "action":
        if (has("customerAction")) {
          if (!customerAction) return incomplete;
          values.customerAction = customerAction;
        }
        if (has("occasion")) {
          if (!occasion) return incomplete;
          values.occasion = occasion;
        }
        break;
      case "offer": {
        if (has("mechanism")) {
          if (!mechanism) return incomplete;
          values.mechanism = mechanism;
        }
        if (showTier) {
          const thresholdAmount = effectiveMechanism === "门槛型" ? parseNumber(threshold) : null;
          if (effectiveMechanism === "门槛型" && thresholdAmount === null) return incomplete;
          if (Number.isNaN(thresholdAmount) || (thresholdAmount !== null && thresholdAmount <= 0)) return { values: null, error: "判断金额要填大于 0 的数字" };
          if (discountMode === "off") {
            const off = parseNumber(amountOff);
            if (off === null) return incomplete;
            if (Number.isNaN(off) || off < 0) return { values: null, error: "减免额要填不小于 0 的数字" };
            values.tier = { thresholdAmount, discountRate: null, amountOff: off };
          } else {
            const value = parseNumber(discount);
            if (value === null) return incomplete;
            if (Number.isNaN(value) || value <= 0 || value > 10) return { values: null, error: "折扣填 0 到 10 之间的数，例如 8.5 折填 8.5" };
            values.tier = { thresholdAmount, discountRate: Number((value / 10).toFixed(4)), amountOff: null };
          }
        }
        if (showStacking) {
          if (!stacking) return incomplete;
          values.stacking = stacking;
        }
        break;
      }
      case "scope":
        if (has("level")) {
          if (!level) return incomplete;
          values.level = level;
        }
        if (needsCode) {
          values.level = level;
          if (level === "区域") {
            if (!regionText.trim()) return incomplete;
            values.regionText = regionText.trim();
          }
          if (level === "分区") {
            if (!divisionText.trim()) return incomplete;
            values.divisionText = divisionText.trim();
          }
          if (level === "指定门店") {
            if (!storesText.trim()) return incomplete;
            const parsed = parseStores(storesText);
            if (parsed.error) return { values: null, error: parsed.error };
            values.stores = parsed.stores;
          }
        }
        if (has("markets")) {
          if (!markets.length) return incomplete;
          values.markets = markets;
        }
        if (has("channels")) {
          if (!channels.length) return incomplete;
          values.channels = channels;
        }
        break;
      case "schedule":
        if (!startDate || !endDate) return incomplete;
        if (startDate > endDate) return { values: null, error: "开始日期不能晚于结束日期" };
        values.startDate = startDate;
        values.endDate = endDate;
        break;
      case "audience_products":
        if (has("segments")) {
          const all = [...new Set([...segments, ...otherSegment.split(/[、，,]/).map((item) => item.trim()).filter(Boolean)])];
          if (!all.length) return incomplete;
          values.segments = all;
        }
        if (has("categories")) {
          if (!categories.length) return incomplete;
          values.categories = categories;
        }
        if (has("membership")) {
          if (!membership) return incomplete;
          values.membership = membership;
          if (membership === "限" && membershipDescription.trim()) values.membershipDescription = membershipDescription.trim();
        }
        break;
      case "operations":
        if (has("rates")) {
          const first = parseNumber(concession);
          const second = parseNumber(collection);
          if (first === null || second === null) return incomplete;
          if (Number.isNaN(first) || Number.isNaN(second) || first < 0 || second < 0) return { values: null, error: "让扣点和回款率要填不小于 0 的数字" };
          values.concessionRate = first;
          values.collectionRate = second;
        }
        if (has("paymentRestricted")) {
          if (!payment) return incomplete;
          values.paymentRestricted = payment === "yes";
        }
        break;
      default:
        return incomplete;
    }
    return { values, error: null };
  };

  const { values, error } = build();
  const submitAuto = (key: string, value: unknown) => onSubmit({ [key]: value });
  const segmentOptions = [...new Set([...SEGMENT_OPTIONS, ...draft.audience.segments.value])];

  return (
    <div className={compact ? "space-y-4" : "space-y-4 rounded-2xl border border-[#e1d6ca] bg-[#fffdfa] p-4 shadow-[0_8px_24px_rgba(65,32,39,0.04)]"}>
      {has("customerAction") ? (
        <FieldBlock label={FIELD_LABEL.customerAction} why={why("customerAction")} showLabel={showLabel}>
          <div className="flex flex-wrap gap-2">
            {CUSTOMER_ACTION_OPTIONS.map((option) => (
              <Chip key={option} disabled={busy} selected={customerAction === option} onClick={() => (auto ? submitAuto("customerAction", option) : setCustomerAction(option))}>
                {option}
              </Chip>
            ))}
          </div>
        </FieldBlock>
      ) : null}

      {has("occasion") ? (
        <FieldBlock label={FIELD_LABEL.occasion} why={why("occasion")} showLabel={showLabel}>
          <div className="flex flex-wrap gap-2">
            {OCCASION_OPTIONS.map((option) => (
              <Chip key={option} disabled={busy} selected={occasion === option} onClick={() => (auto ? submitAuto("occasion", option) : setOccasion(option))}>
                {option}
              </Chip>
            ))}
          </div>
        </FieldBlock>
      ) : null}

      {has("mechanism") ? (
        <FieldBlock label={FIELD_LABEL.mechanism} why={why("mechanism")} showLabel={showLabel}>
          <div className="flex flex-wrap gap-2">
            {MECHANISM_OPTIONS.map((option) => (
              <Chip key={option} disabled={busy} selected={mechanism === option} onClick={() => setMechanism(option)}>
                {option}
              </Chip>
            ))}
          </div>
        </FieldBlock>
      ) : null}

      {showTier ? (
        <FieldBlock label={FIELD_LABEL.tier} why={why("tier")} showLabel>
          <div className="space-y-3 rounded-xl border border-[#e8ddd1] bg-[#faf7f2] p-3">
            <div className="flex gap-2">
              <Chip selected={discountMode === "off"} disabled={busy} onClick={() => setDiscountMode("off")}>减钱</Chip>
              <Chip selected={discountMode === "rate"} disabled={busy} onClick={() => setDiscountMode("rate")}>打折</Chip>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {effectiveMechanism === "门槛型" ? (
                <label className="text-[12px] text-[#7d6f72]">
                  满多少元
                  <Input type="number" inputMode="decimal" value={threshold} onChange={(event) => setThreshold(event.target.value)} className="mt-1 h-9 bg-white" placeholder="例如 3000" />
                </label>
              ) : null}
              {discountMode === "off" ? (
                <label className="text-[12px] text-[#7d6f72]">
                  减多少元
                  <Input type="number" inputMode="decimal" value={amountOff} onChange={(event) => setAmountOff(event.target.value)} className="mt-1 h-9 bg-white" placeholder="例如 300" />
                </label>
              ) : (
                <label className="text-[12px] text-[#7d6f72]">
                  打几折
                  <Input type="number" inputMode="decimal" value={discount} onChange={(event) => setDiscount(event.target.value)} className="mt-1 h-9 bg-white" placeholder="例如 8.5" />
                </label>
              )}
            </div>
          </div>
        </FieldBlock>
      ) : null}

      {showStacking ? (
        <FieldBlock label={FIELD_LABEL.stacking} why={why("stacking")} showLabel={showLabel}>
          <div className="flex flex-wrap gap-2">
            {([["否", "不能叠加"], ["是", "可以叠加"]] as const).map(([value, label]) => (
              <Chip key={value} disabled={busy} selected={stacking === value} onClick={() => (auto ? submitAuto("stacking", value) : setStacking(value))}>
                {label}
              </Chip>
            ))}
          </div>
        </FieldBlock>
      ) : null}

      {has("level") ? (
        <FieldBlock label={FIELD_LABEL.level} why={why("level")} showLabel={showLabel}>
          <div className="flex flex-wrap gap-2">
            {LEVEL_OPTIONS.map((option) => (
              <Chip key={option} disabled={busy} selected={level === option} onClick={() => setLevel(option)}>
                {option}
              </Chip>
            ))}
          </div>
        </FieldBlock>
      ) : null}

      {needsCode ? (
        <FieldBlock label={level === "指定门店" ? "门店（每行一个：行号 行名）" : level === "分区" ? "分区名称" : "区域名称"} why={has("scopeCode") ? why("scopeCode") : undefined} showLabel>
          {level === "指定门店" ? (
            <Textarea value={storesText} onChange={(event) => setStoresText(event.target.value)} className="min-h-20 bg-white text-sm" placeholder={"3319 东门茂业\n3320 华强北"} />
          ) : (
            <Input
              value={level === "分区" ? divisionText : regionText}
              onChange={(event) => (level === "分区" ? setDivisionText(event.target.value) : setRegionText(event.target.value))}
              className="h-9 bg-white"
              placeholder={level === "分区" ? "例如：闽深 A 区" : "例如：华东区"}
            />
          )}
          <p className="mt-1 text-[12px] text-[#9a8d8f]">具体编码请在 ICS 生产界面上选择。</p>
        </FieldBlock>
      ) : null}

      {has("markets") ? (
        <FieldBlock label={FIELD_LABEL.markets} why={why("markets")} showLabel={showLabel}>
          <div className="flex flex-wrap gap-2">
            {MARKET_OPTIONS.map((option) => (
              <Chip key={option} disabled={busy} selected={markets.includes(option)} onClick={() => setMarkets(toggle(markets, option))}>
                {option}
              </Chip>
            ))}
          </div>
        </FieldBlock>
      ) : null}

      {has("channels") ? (
        <FieldBlock label={FIELD_LABEL.channels} why={why("channels")} showLabel={showLabel}>
          <div className="flex flex-wrap gap-2">
            {CHANNEL_OPTIONS.map((option) => (
              <Chip key={option} disabled={busy} selected={channels.includes(option)} onClick={() => setChannels(toggle(channels, option))}>
                {option}
              </Chip>
            ))}
          </div>
        </FieldBlock>
      ) : null}

      {has("dates") ? (
        <FieldBlock label={FIELD_LABEL.dates} why={why("dates")} showLabel={showLabel}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[12px] text-[#7d6f72]">
              开始日期
              <Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="mt-1 h-9 bg-white" />
            </label>
            <label className="text-[12px] text-[#7d6f72]">
              结束日期
              <Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="mt-1 h-9 bg-white" />
            </label>
          </div>
        </FieldBlock>
      ) : null}

      {has("segments") ? (
        <FieldBlock label={FIELD_LABEL.segments} why={why("segments")} showLabel={showLabel}>
          <div className="flex flex-wrap gap-2">
            {segmentOptions.map((option) => (
              <Chip key={option} disabled={busy} selected={segments.includes(option)} onClick={() => setSegments(toggle(segments, option))}>
                {option}
              </Chip>
            ))}
          </div>
          <Input value={otherSegment} onChange={(event) => setOtherSegment(event.target.value)} className="mt-2 h-9 bg-white" placeholder="其他人群，用顿号分隔" />
        </FieldBlock>
      ) : null}

      {has("categories") ? (
        <FieldBlock label={FIELD_LABEL.categories} why={why("categories")} showLabel={showLabel}>
          <div className="flex flex-wrap gap-2">
            {CATEGORY_OPTIONS.map((option) => (
              <Chip key={option} disabled={busy} selected={categories.includes(option)} onClick={() => setCategories(toggle(categories, option))}>
                {option}
              </Chip>
            ))}
          </div>
        </FieldBlock>
      ) : null}

      {has("membership") ? (
        <FieldBlock label={FIELD_LABEL.membership} why={why("membership")} showLabel={showLabel}>
          <div className="flex flex-wrap gap-2">
            {(["不限", "限"] as const).map((option) => (
              <Chip key={option} disabled={busy} selected={membership === option} onClick={() => setMembership(option)}>
                {option === "不限" ? "不限会员" : "限会员"}
              </Chip>
            ))}
          </div>
          {membership === "限" ? (
            <Input value={membershipDescription} onChange={(event) => setMembershipDescription(event.target.value)} className="mt-2 h-9 bg-white" placeholder="限哪些会员，例如：中高等级及以上（在 ICS 界面勾选）" />
          ) : null}
        </FieldBlock>
      ) : null}

      {has("rates") ? (
        <FieldBlock label={FIELD_LABEL.rates} why={why("rates")} showLabel={showLabel}>
          {prefill ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConcession(String(prefill.concessionRate));
                setCollection(String(prefill.collectionRate));
              }}
              className="mb-2 rounded-full border border-[#d6c3a3] bg-[#faf2e5] px-3 py-1.5 text-[13px] text-[#6b4f2c] hover:bg-[#f5e8d3]"
            >
              沿用上次：让扣点 {prefill.concessionRate}，回款率 {prefill.collectionRate}（{prefill.source}）
            </button>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[12px] text-[#7d6f72]">
              让扣点
              <Input type="number" inputMode="decimal" step="0.01" value={concession} onChange={(event) => setConcession(event.target.value)} className="mt-1 h-9 bg-white" placeholder="例如 0.12" />
            </label>
            <label className="text-[12px] text-[#7d6f72]">
              回款率
              <Input type="number" inputMode="decimal" step="0.01" value={collection} onChange={(event) => setCollection(event.target.value)} className="mt-1 h-9 bg-white" placeholder="例如 0.98" />
            </label>
          </div>
        </FieldBlock>
      ) : null}

      {has("paymentRestricted") ? (
        <FieldBlock label={FIELD_LABEL.paymentRestricted} why={why("paymentRestricted")} showLabel={showLabel}>
          <div className="flex flex-wrap gap-2">
            {([["no", "不限制"], ["yes", "有限制"]] as const).map(([value, label]) => (
              <Chip key={value} disabled={busy} selected={payment === value} onClick={() => (auto ? submitAuto("paymentRestricted", value === "yes") : setPayment(value))}>
                {label}
              </Chip>
            ))}
          </div>
        </FieldBlock>
      ) : null}

      {error ? <p className="text-[12px] text-[#9a3f24]">{error}</p> : null}
      {!auto ? (
        <Button type="button" disabled={busy || !values} onClick={() => values && onSubmit(values)} className="h-9 rounded-xl bg-[#651427] px-4 text-white hover:bg-[#791a30]">
          {busy ? <Loader2 className="animate-spin" /> : <Check />}
          确定
        </Button>
      ) : null}
    </div>
  );
}
