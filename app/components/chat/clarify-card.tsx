"use client";

import { Check, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CLARIFY_CATALOG, OFFER_CLARIFY_KEYS, splitList, type ClarifyKey } from "../../lib/campaign/clarify";
import { stripParenthetical } from "../../lib/campaign/evidence";
import type { StoredMessage } from "../../lib/campaign/messages";
import type { CampaignDraft } from "../../lib/campaign/types";
import { Chip } from "./question-card";

type ClarifyMessage = Extract<StoredMessage, { kind: "agent_clarify" }>;

type ClarifyCardProps = {
  message: ClarifyMessage;
  draft: CampaignDraft;
  open: boolean;
  busy: boolean;
  onSubmit: (answers: Record<string, unknown>) => void;
};

const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

function parseNumber(text: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : Number.NaN;
}

function initialSingle(draft: CampaignDraft, key: ClarifyKey): string {
  switch (key) {
    case "customerAction":
      return draft.intent.customerAction.value === "还没定" ? "" : draft.intent.customerAction.value;
    case "occasion":
      return draft.intent.occasion.provenance === "pending" && !draft.intent.occasion.suggested ? "" : draft.intent.occasion.value;
    case "mechanism":
      return draft.offer.mechanism.value === "还没定" || draft.offer.mechanism.provenance === "default" ? "" : draft.offer.mechanism.value;
    case "stacking":
      return draft.offer.stacking.provenance === "user" ? draft.offer.stacking.value : "";
    case "membership":
      return draft.audience.membership.provenance === "user" ? draft.audience.membership.value : "";
    case "paymentRestricted":
      return draft.operations.paymentRestricted.provenance === "user" ? String(draft.operations.paymentRestricted.value) : "";
    default:
      return "";
  }
}

function initialMulti(draft: CampaignDraft, key: ClarifyKey): string[] {
  switch (key) {
    case "markets":
      return draft.scope.markets.value;
    case "channels":
      return draft.scope.channels.value;
    case "categories":
      return draft.products.categories.value;
    case "segments":
      return draft.audience.segments.value;
    case "series":
      return splitList(draft.products.series);
    default:
      return [];
  }
}

export function ClarifyCard({ message, draft, open, busy, onSubmit }: ClarifyCardProps) {
  const keys = message.questions.map((question) => question.key);
  const has = (key: ClarifyKey) => keys.includes(key);
  const tier = draft.offer.tiers[0];
  const batch = draft.schedule.batches[0];

  const [singles, setSingles] = useState<Record<string, string>>(() => Object.fromEntries(keys.map((key) => [key, initialSingle(draft, key)])));
  const [multis, setMultis] = useState<Record<string, string[]>>(() => Object.fromEntries(keys.map((key) => [key, initialMulti(draft, key)])));
  const [customs, setCustoms] = useState<Record<string, string>>({});
  const [tierMode, setTierMode] = useState<"off" | "rate">(tier?.discountRate != null ? "rate" : "off");
  const [threshold, setThreshold] = useState(tier?.thresholdAmount != null ? String(tier.thresholdAmount) : "");
  const [amountOff, setAmountOff] = useState(tier?.amountOff != null ? String(tier.amountOff) : "");
  const [discount, setDiscount] = useState(tier?.discountRate != null ? String(Number((tier.discountRate * 10).toFixed(2))) : "");
  const [level, setLevel] = useState(draft.scope.level.provenance === "pending" && !draft.scope.level.suggested ? "" : draft.scope.level.value);
  const [scopeText, setScopeText] = useState(
    stripParenthetical(draft.scope.regionCode || draft.scope.divisionCode) || draft.scope.stores.map((store) => `${store.code} ${store.name}`).join("\n"),
  );
  const [startDate, setStartDate] = useState(batch?.startDate ?? "");
  const [endDate, setEndDate] = useState(batch?.endDate ?? "");
  const [concession, setConcession] = useState(draft.operations.concessionRate.value !== null ? String(draft.operations.concessionRate.value) : "");
  const [collection, setCollection] = useState(draft.operations.collectionRate.value !== null ? String(draft.operations.collectionRate.value) : "");

  const action = has("customerAction") ? singles.customerAction : draft.intent.customerAction.value;
  const mechanism = has("mechanism") ? singles.mechanism : draft.offer.mechanism.value === "还没定" ? "" : draft.offer.mechanism.value;
  const onlySee = action === "只看到";
  const noOffer = onlySee || mechanism === "无让利";
  const numericMechanism = mechanism === "门槛型" || mechanism === "直接价格";

  const visible = (key: ClarifyKey) => {
    if (onlySee && OFFER_CLARIFY_KEYS.includes(key)) return false;
    if (noOffer && key !== "mechanism" && OFFER_CLARIFY_KEYS.includes(key)) return false;
    if (key === "tier") return numericMechanism;
    return true;
  };

  const collect = (): { answers: Record<string, unknown>; error: string | null } => {
    const answers: Record<string, unknown> = {};
    for (const key of keys) {
      if (!visible(key)) continue;
      const custom = customs[key]?.trim() ?? "";
      switch (CLARIFY_CATALOG[key].mode) {
        case "single": {
          const choice = singles[key] ?? "";
          if (choice || custom) answers[key] = { ...(choice ? { choice } : {}), ...(custom ? { custom } : {}) };
          break;
        }
        case "multi": {
          const choices = multis[key] ?? [];
          if (choices.length || custom) answers[key] = { ...(choices.length ? { choices } : {}), ...(custom ? { custom } : {}) };
          break;
        }
        case "tier": {
          const thresholdAmount = mechanism === "门槛型" ? parseNumber(threshold) : null;
          if (tierMode === "off") {
            const off = parseNumber(amountOff);
            if (off === null) break;
            if (Number.isNaN(off) || off < 0 || Number.isNaN(thresholdAmount)) return { answers, error: "优惠金额要填不小于 0 的数字" };
            answers.tier = { thresholdAmount, amountOff: off, discountRate: null };
          } else {
            const rate = parseNumber(discount);
            if (rate === null) break;
            if (Number.isNaN(rate) || rate <= 0 || rate > 10 || Number.isNaN(thresholdAmount)) return { answers, error: "折扣填 0 到 10 之间的数，例如 8.5 折填 8.5" };
            answers.tier = { thresholdAmount, amountOff: null, discountRate: Number((rate / 10).toFixed(4)) };
          }
          break;
        }
        case "scope":
          if (level || scopeText.trim()) answers.scope = { ...(level ? { level } : {}), ...(scopeText.trim() ? { text: scopeText.trim() } : {}) };
          break;
        case "dates":
          if (startDate && endDate && startDate > endDate) return { answers, error: "开始日期不能晚于结束日期" };
          if (startDate || endDate) answers.dates = { ...(startDate ? { startDate } : {}), ...(endDate ? { endDate } : {}) };
          break;
        case "rates": {
          const first = parseNumber(concession);
          const second = parseNumber(collection);
          if ((first !== null && (Number.isNaN(first) || first < 0)) || (second !== null && (Number.isNaN(second) || second < 0))) {
            return { answers, error: "让扣点和回款率要填不小于 0 的数字" };
          }
          if (first !== null || second !== null) answers.rates = { ...(first !== null ? { concessionRate: first } : {}), ...(second !== null ? { collectionRate: second } : {}) };
          break;
        }
      }
    }
    return { answers, error: null };
  };

  const { answers, error } = collect();
  const disabled = !open || busy;

  const understood = [
    ...message.stated.map((item) => `${item.label} ${item.value}`),
    ...message.inferred.map((item) => `${item.label} ${item.value}`),
  ];

  return (
    <div className="rounded-2xl border border-[#e1d6ca] bg-[#fffdfa] p-4 shadow-[0_8px_24px_rgba(65,32,39,0.04)]">
      {understood.length ? (
        <p className="text-[13px] leading-6 text-[#6d5d5f]">
          <span className="font-medium text-[#4b3037]">我理解的是：</span>
          {understood.join(" · ")}
        </p>
      ) : null}
      <p className="mt-1 text-sm text-[#35262a]">{message.intro}</p>

      {open ? (
        <div className="mt-3">
          {message.questions.filter((question) => visible(question.key)).map((question) => {
            const entry = CLARIFY_CATALOG[question.key];
            const options = question.options ? question.options.map((value) => ({ value, label: value })) : entry.options ?? [];
            return (
              <div key={question.key} className="border-t border-[#efe7de] py-3">
                <p className="text-sm font-medium text-[#35262a]">{question.title}</p>
                <p className="text-[12px] leading-5 text-[#8a7d80]">{question.why}</p>

                {entry.mode === "single" || entry.mode === "multi" || entry.mode === "scope" ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {options.map((option) => {
                      const selected = entry.mode === "multi"
                        ? (multis[question.key] ?? []).includes(option.value)
                        : entry.mode === "scope" ? level === option.value : singles[question.key] === option.value;
                      return (
                        <Chip
                          key={option.value}
                          selected={selected}
                          disabled={disabled}
                          onClick={() => {
                            if (entry.mode === "multi") setMultis((current) => ({ ...current, [question.key]: toggle(current[question.key] ?? [], option.value) }));
                            else if (entry.mode === "scope") setLevel(level === option.value ? "" : option.value);
                            else setSingles((current) => ({ ...current, [question.key]: current[question.key] === option.value ? "" : option.value }));
                          }}
                        >
                          {option.label}
                        </Chip>
                      );
                    })}
                  </div>
                ) : null}

                {entry.mode === "scope" ? (
                  level === "全国" || level === "电商平台" ? null : (
                    <Textarea
                      value={scopeText}
                      disabled={disabled}
                      onChange={(event) => setScopeText(event.target.value)}
                      className="mt-2 min-h-10 bg-white text-sm"
                      placeholder={level === "指定门店" ? "每行一个门店：行号 行名" : level === "分区" ? "分区名称，例如：闽深 A 区" : "区域名称，例如：华东区（具体编码在 ICS 界面上选）"}
                    />
                  )
                ) : null}

                {entry.mode === "tier" ? (
                  <div className="mt-2 space-y-2">
                    <div className="flex gap-2">
                      <Chip selected={tierMode === "off"} disabled={disabled} onClick={() => setTierMode("off")}>减钱</Chip>
                      <Chip selected={tierMode === "rate"} disabled={disabled} onClick={() => setTierMode("rate")}>打折</Chip>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {mechanism === "门槛型" ? (
                        <Input type="number" inputMode="decimal" disabled={disabled} value={threshold} onChange={(event) => setThreshold(event.target.value)} className="h-9 bg-white" placeholder="满多少元，例如 3000" />
                      ) : null}
                      {tierMode === "off" ? (
                        <Input type="number" inputMode="decimal" disabled={disabled} value={amountOff} onChange={(event) => setAmountOff(event.target.value)} className="h-9 bg-white" placeholder="减多少元，例如 300" />
                      ) : (
                        <Input type="number" inputMode="decimal" disabled={disabled} value={discount} onChange={(event) => setDiscount(event.target.value)} className="h-9 bg-white" placeholder="打几折，例如 8.5" />
                      )}
                    </div>
                  </div>
                ) : null}

                {entry.mode === "dates" ? (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <label className="text-[12px] text-[#7d6f72]">
                      开始日期
                      <Input type="date" disabled={disabled} value={startDate} onChange={(event) => setStartDate(event.target.value)} className="mt-1 h-9 bg-white" />
                    </label>
                    <label className="text-[12px] text-[#7d6f72]">
                      结束日期
                      <Input type="date" disabled={disabled} value={endDate} onChange={(event) => setEndDate(event.target.value)} className="mt-1 h-9 bg-white" />
                    </label>
                  </div>
                ) : null}

                {entry.mode === "rates" ? (
                  <div className="mt-2 space-y-2">
                    {message.prefill ? (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          setConcession(String(message.prefill!.concessionRate));
                          setCollection(String(message.prefill!.collectionRate));
                        }}
                        className="rounded-full border border-[#d6c3a3] bg-[#faf2e5] px-3 py-1.5 text-[13px] text-[#6b4f2c] hover:bg-[#f5e8d3] disabled:opacity-60"
                      >
                        沿用上次：让扣点 {message.prefill.concessionRate}，回款率 {message.prefill.collectionRate}（{message.prefill.source}）
                      </button>
                    ) : null}
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input type="number" inputMode="decimal" step="0.01" disabled={disabled} value={concession} onChange={(event) => setConcession(event.target.value)} className="h-9 bg-white" placeholder="让扣点，例如 0.12" />
                      <Input type="number" inputMode="decimal" step="0.01" disabled={disabled} value={collection} onChange={(event) => setCollection(event.target.value)} className="h-9 bg-white" placeholder="回款率，例如 0.98" />
                    </div>
                  </div>
                ) : null}

                {entry.customPlaceholder ? (
                  <Input
                    value={customs[question.key] ?? ""}
                    disabled={disabled}
                    onChange={(event) => setCustoms((current) => ({ ...current, [question.key]: event.target.value }))}
                    className="mt-2 h-9 bg-white text-sm"
                    placeholder={`其他：${entry.customPlaceholder}`}
                  />
                ) : null}
              </div>
            );
          })}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#efe7de] pt-3">
            <p className="text-[12px] text-[#8a7d80]">都可以不填。没填的项会在方案里标「待补」。</p>
            <Button type="button" disabled={disabled || Boolean(error)} onClick={() => onSubmit(answers)} className="h-10 rounded-xl bg-[#651427] px-5 text-white hover:bg-[#791a30]">
              {busy ? <Loader2 className="animate-spin" /> : <Check />}
              确认提交
            </Button>
          </div>
          {error ? <p className="mt-2 text-[12px] text-[#9a3f24]">{error}</p> : null}
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-[#9a8d8f]">已处理</p>
      )}
    </div>
  );
}
