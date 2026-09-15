import type { ReadbackItem } from "./messages.ts";
import { missingTopics } from "./topics.ts";
import type { CampaignDraft, FieldValue, ValidationIssue } from "./types.ts";

export type SessionStatus = "collecting" | "ready" | "generated";

// 生成过方案就算已生成（缺的项在方案里标待补）；没生成时，齐了是待生成，不齐是收集中。
export function deriveStatus(draft: CampaignDraft, issues: ValidationIssue[]): SessionStatus {
  if (draft.brief.externalName) return "generated";
  if (missingTopics(draft).length > 0 || issues.some((issue) => issue.severity === "blocker")) return "collecting";
  return "ready";
}

export function readbackItems(draft: CampaignDraft): { stated: ReadbackItem[]; inferred: ReadbackItem[] } {
  const stated: ReadbackItem[] = [];
  const inferred: ReadbackItem[] = [];
  const put = (field: FieldValue<unknown>, label: string, text: string) => {
    if (field.provenance === "user") stated.push({ label, value: text });
    else if (field.provenance === "ai") inferred.push({ label, value: text });
    else if (field.provenance === "pending" && field.suggested) inferred.push({ label, value: `${text}（待你确认）` });
  };

  if (draft.intent.reason) stated.push({ label: "由头", value: draft.intent.reason });
  put(draft.intent.occasion, "由头类型", draft.intent.occasion.value);
  put(draft.intent.customerAction, "顾客动作", draft.intent.customerAction.value);
  put(draft.offer.mechanism, "让利机制", draft.offer.mechanism.value);
  if (draft.offer.tiers.some((tier) => tier.thresholdAmount !== null || tier.discountRate !== null || tier.amountOff !== null)) {
    stated.push({ label: "优惠力度", value: draft.offer.tiers.map((tier) => tier.label).join("、") });
  }
  put(draft.offer.stacking, "能否叠加", draft.offer.stacking.value === "是" ? "可以叠加" : "不能叠加");
  put(draft.scope.level, "范围", [draft.scope.level.value, draft.scope.regionCode, draft.scope.divisionCode].filter(Boolean).join(" · "));
  put(draft.scope.markets, "覆盖市场", draft.scope.markets.value.join("、"));
  put(draft.scope.channels, "渠道", draft.scope.channels.value.join("、"));
  const batch = draft.schedule.batches[0];
  if (batch?.startDate || batch?.endDate) stated.push({ label: "起止日期", value: `${batch.startDate || "未填"} 至 ${batch.endDate || "未填"}` });
  put(draft.audience.segments, "人群", draft.audience.segments.value.join("、"));
  put(draft.products.categories, "业务大类", draft.products.categories.value.join("、"));
  put(draft.audience.membership, "会员限制", draft.audience.membership.value);
  if (draft.operations.concessionRate.value !== null) put(draft.operations.concessionRate, "让扣点", String(draft.operations.concessionRate.value));
  if (draft.operations.collectionRate.value !== null) put(draft.operations.collectionRate, "回款率", String(draft.operations.collectionRate.value));
  put(draft.operations.paymentRestricted, "支付方式", draft.operations.paymentRestricted.value ? "有限制" : "不限制");

  return { stated, inferred };
}

export function noIcsReason(draft: CampaignDraft): string {
  return draft.intent.customerAction.value === "只看到"
    ? "顾客动作只到「看到」，属于品牌曝光。报名、互动、到场由 CRM 或活动系统承接，不在 ICS 开单。"
    : "这次没有成交优惠，ICS 只管成交规则，所以不用开单。";
}
