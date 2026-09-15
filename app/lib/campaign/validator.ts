import { noIcsOrders } from "./topics.ts";
import type { CampaignDraft, IcsOrderDraft, ValidationIssue } from "./types.ts";

const issue = (
  ruleId: ValidationIssue["ruleId"],
  severity: ValidationIssue["severity"],
  path: string,
  message: string,
  evidence?: string,
): ValidationIssue => ({ ruleId, severity, path, message, ...(evidence ? { evidence } : {}) });

export function validateDraft(draft: CampaignDraft, orders: IcsOrderDraft[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  draft.schedule.batches.forEach((batch, index) => {
    if (!batch.endDate) issues.push(issue("R2", "blocker", `/schedule/batches/${index}/endDate`, "结束日期不能为空"));
    if (batch.startDate && batch.endDate && batch.startDate > batch.endDate) {
      issues.push(issue("R1", "blocker", `/schedule/batches/${index}`, "开始日期不能晚于结束日期"));
    }
  });

  if ([...draft.brief.icsName].length > 13) {
    issues.push(issue("R3", "warning", "/brief/icsName", "ICS 开单名超过 13 个字；生产口径仍待确认"));
  }
  if (/[<>"'{}\[\]|\\]/u.test(`${draft.brief.icsName}${draft.brief.content}`)) {
    issues.push(issue("R4", "blocker", "/brief", "活动名称或内容含保守黑名单中的特殊字符"));
  }

  const weekdays = draft.schedule.cycleWeekdays.value;
  if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 7)) {
    issues.push(issue("R5", "blocker", "/schedule/cycleWeekdays", "周内循环日只能使用 0–7"));
  }

  if ([0, 2, 3].includes(draft.products.productScope.value) && draft.products.outletTagConversion) {
    issues.push(issue("R6", "blocker", "/products/outletTagConversion", "当前货品范围要求转换餐牌为 0"));
  }
  if (draft.offer.offerType === 14 && draft.products.categories.value.includes("HP货类")) {
    issues.push(issue("R7", "blocker", "/products/categories", "优惠类型 14 不得加入 HP 货类"));
  }
  if (draft.offer.offerType === 12 && draft.offer.tiers.some((tier) => !tier.judgingWeight)) {
    issues.push(issue("R8", "blocker", "/offer/tiers", "优惠类型 12 的判断克重不得为 0"));
  }
  if (draft.offer.tiers.some((tier) => tier.thresholdCount !== null) && draft.offer.offerType !== 17) {
    issues.push(issue("R9", "blocker", "/offer/offerType", "填写判断件数时优惠类型必须为 17"));
  }
  if (draft.offer.tradeInUpgradeRatio !== null && draft.offer.mechanism.value !== "以旧换新换购") {
    issues.push(issue("R10", "blocker", "/offer/tradeInUpgradeRatio", "换购系数只用于以旧换新或换购"));
  }

  if ([draft.scope.regionCode, draft.scope.divisionCode, draft.scope.rowCode].filter(Boolean).length > 1) {
    issues.push(issue("R11", "blocker", "/scope", "区域、分区、行号只能填写一种"));
  }
  if (draft.products.assignedItems.length > 0 && !draft.products.assignedItemMode) {
    issues.push(issue("R12", "blocker", "/products/assignedItemMode", "指定货号前必须打开指定牌仔总开关"));
  }

  // 不建 ICS 单时没有合约参数，R13 不适用。
  if (!noIcsOrders(draft) && draft.operations.concessionRate.value === null) {
    issues.push(issue("R13", "blocker", "/operations/concessionRate", "让扣点必须明确填写，0 也是合法值"));
  }
  if (!noIcsOrders(draft) && draft.operations.collectionRate.value === null) {
    issues.push(issue("R13", "blocker", "/operations/collectionRate", "回款率必须明确填写，0 也是合法值"));
  }
  if ((draft.operations.concessionRate.value ?? 0) > 1) {
    issues.push(issue("R14", "warning", "/operations/concessionRate", "让扣点超过 1，请确认单位与生产回显"));
  }
  if ((draft.operations.collectionRate.value ?? 0) > 1) {
    issues.push(issue("R14", "warning", "/operations/collectionRate", "回款率超过 1，请确认单位与生产回显"));
  }

  if (draft.offer.tiers.length > 1 && orders.length > 0) {
    const expectedTierCopies = orders.length / draft.offer.tiers.length;
    const counts = new Map<string, number>();
    orders.forEach((order) => counts.set(order.offerTier.id, (counts.get(order.offerTier.id) ?? 0) + 1));
    if ([...counts.values()].some((count) => count !== expectedTierCopies)) {
      issues.push(issue("R15", "blocker", "/offer/tiers", "多档优惠必须拆成独立规则行"));
    }
  }

  if (
    draft.offer.mechanism.value === "以旧换新换购" &&
    draft.products.categories.value.includes("黄金类") &&
    draft.operations.activityGroup !== "增值服务"
  ) {
    issues.push(issue("R16", "warning", "/operations/activityGroup", "黄金以旧换新需在 1815 将活动分组改为增值服务"));
  }

  draft.offer.tiers.forEach((tier, index) => {
    if (tier.discountRate !== null && tier.amountOff !== null) {
      issues.push(issue("R17", "blocker", `/offer/tiers/${index}`, "折扣率与减免额不可填在同一档"));
    }
    if (tier.discountRate !== null && (tier.discountRate <= 0 || tier.discountRate > 1)) {
      issues.push(issue("R17", "blocker", `/offer/tiers/${index}/discountRate`, "折扣率应使用 0–1 小数，例如 8 折填 0.8"));
    }
    if (tier.amountOff !== null && tier.amountOff < 0) {
      issues.push(issue("R17", "blocker", `/offer/tiers/${index}/amountOff`, "减免额不能为负数"));
    }
  });

  if (draft.intent.customerAction.value === "只看到" && orders.length > 0) {
    issues.push(issue("R17", "blocker", "/intent/customerAction", "只看到的活动不得生成 ICS 单"));
  }

  return issues;
}

