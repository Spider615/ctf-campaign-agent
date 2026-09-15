import type { InterpretationResult } from "../server/ai-schemas.ts";
import { createMotherDaySeed } from "./demo-seeds.ts";
import { diffDrafts } from "./patcher.ts";
import type { CampaignDraft, CustomerAction, DraftVersion, IcsOrderDraft, OccasionType, OfferMechanism } from "./types.ts";

const occasions: OccasionType[] = ["日历节点", "品牌节点", "外部节点", "线下场", "门店日常经营", "私域日常运营"];
const actions: CustomerAction[] = ["只看到", "参与互动", "到场", "留资", "下单", "带旧货来换", "还没定"];
const mechanisms: OfferMechanism[] = ["无让利", "以旧换新换购", "门槛型", "直接价格", "赠品兑换", "券核销", "还没定"];

export type SavedVersionRecord = {
  seq: number;
  draft: CampaignDraft;
  orders: IcsOrderDraft[];
  createdBy: "ai" | "human" | "rollback";
  createdAt: string;
};

export function rehydrateSessionVersions(records: SavedVersionRecord[]): DraftVersion[] {
  return records.map((record, index) => ({
    seq: record.seq,
    draft: structuredClone(record.draft),
    source: record.createdBy,
    reason: record.createdBy === "ai" ? "已保存的对话修改" : record.createdBy === "rollback" ? "已保存的版本恢复" : "已保存的初始版本",
    createdAt: record.createdAt,
    diffs: index === 0 ? [] : diffDrafts(records[index - 1].draft, record.draft),
  }));
}

export function mergeInterpretation(userText: string, interpretation: InterpretationResult): CampaignDraft {
  const draft = createMotherDaySeed();
  const fields = interpretation.fields;
  draft.id = crypto.randomUUID();
  draft.title = interpretation.summary || userText.slice(0, 28);
  draft.brief.externalName = "";
  draft.brief.icsName = "";
  draft.brief.content = "";
  draft.brief.slogan = "";
  draft.intent.occasion = { value: "日历节点", provenance: "pending" };
  draft.intent.reason = "";
  draft.intent.customerAction = { value: "还没定", provenance: "pending" };
  draft.intent.derivedType = "待确认活动类型";
  draft.audience.segments = { value: [], provenance: "pending" };
  draft.audience.membership = { value: "还没定", provenance: "pending" };
  draft.audience.membershipDescription = "";
  draft.products.categories = { value: [], provenance: "pending" };
  draft.products.series = "";
  draft.offer.mechanism = { value: "还没定", provenance: "pending" };
  draft.offer.offerType = null;
  draft.offer.stacking = { value: "还没定", provenance: "pending" };
  draft.offer.couponAllowed = null;
  draft.scope.level = { value: "区域", provenance: "pending" };
  draft.scope.regionCode = "";
  draft.scope.markets = { value: [], provenance: "pending" };
  draft.scope.channels = { value: [], provenance: "pending" };
  draft.schedule.batches[0].startDate = "";
  draft.schedule.batches[0].endDate = "";
  draft.operations.brandLine = { value: "周大福主品牌（演示门店上次值）", provenance: "default" };
  draft.operations.concessionRate = { value: 0.12, provenance: "default" };
  draft.operations.collectionRate = { value: 0.98, provenance: "default" };
  draft.operations.paymentRestricted = { value: false, provenance: "default" };

  if (fields.occasion && occasions.includes(fields.occasion as OccasionType)) {
    draft.intent.occasion = { value: fields.occasion as OccasionType, provenance: "user" };
  }
  if (fields.reason) draft.intent.reason = fields.reason;
  if (fields.customerAction && actions.includes(fields.customerAction as CustomerAction)) {
    draft.intent.customerAction = { value: fields.customerAction as CustomerAction, provenance: "user" };
  }
  if (fields.audience) draft.audience.segments = { value: fields.audience, provenance: "ai" };
  if (fields.productCategories) draft.products.categories = { value: fields.productCategories, provenance: "user" };
  if (fields.offerMechanism && mechanisms.includes(fields.offerMechanism as OfferMechanism)) {
    draft.offer.mechanism = { value: fields.offerMechanism as OfferMechanism, provenance: "user" };
  }

  const tier = draft.offer.tiers[0];
  tier.thresholdAmount = fields.thresholdAmount ?? null;
  tier.discountRate = fields.discountRate ?? null;
  tier.amountOff = fields.amountOff ?? null;
  tier.label = fields.amountOff
    ? `满 ${fields.thresholdAmount ?? "—"} 减 ${fields.amountOff}`
    : fields.discountRate
      ? `${fields.discountRate * 10} 折`
      : "待补优惠档位";

  if (fields.region) {
    draft.scope.level = { value: "区域", provenance: "user" };
    draft.scope.regionCode = `${fields.region}（请在生产界面选择）`;
  }
  if (fields.markets?.length) draft.scope.markets = { value: fields.markets, provenance: "user" };
  if (fields.channels?.length) {
    const channels = fields.channels.filter((channel): channel is "线上" | "线下" => channel === "线上" || channel === "线下");
    if (channels.length) draft.scope.channels = { value: channels, provenance: "user" };
  }
  if (fields.startDate) draft.schedule.batches[0].startDate = fields.startDate;
  if (fields.endDate) draft.schedule.batches[0].endDate = fields.endDate;

  draft.intent.derivedType = draft.intent.customerAction.value === "只看到"
    ? "品牌展示，不含成交优惠"
    : `${draft.intent.occasion.value} × ${draft.offer.mechanism.value}`;
  draft.operations.activityGroup = draft.offer.mechanism.value === "以旧换新换购"
    ? "增值服务"
    : draft.offer.mechanism.value === "还没定"
      ? null
      : "门槛优惠";

  const unresolved = [...interpretation.unresolved];
  if (fields.region) unresolved.push("区域编码需在 1811 生产界面确认");
  draft.unresolved = [...new Set(unresolved)];

  if (draft.intent.customerAction.value === "只看到") {
    draft.offer.mechanism = { value: "无让利", provenance: "default" };
    draft.offer.offerType = null;
    draft.offer.tiers = [];
  }

  return draft;
}
