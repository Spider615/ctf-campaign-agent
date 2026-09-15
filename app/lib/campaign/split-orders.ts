import type { CampaignDraft, IcsOrderDraft, SplitSummary } from "./types.ts";

function scopeUnits(draft: CampaignDraft): string[] {
  if (draft.scope.level.value === "指定门店") {
    return draft.scope.stores.map((store) => `${store.code} ${store.name}`.trim()).filter(Boolean);
  }
  const selected = draft.scope.regionCode || draft.scope.divisionCode || draft.scope.rowCode;
  return [selected || draft.scope.level.value];
}

export function calculateOrderCount(draft: CampaignDraft): SplitSummary {
  if (draft.intent.customerAction.value === "只看到") {
    return {
      total: 0,
      factors: { batches: 0, markets: 0, channels: 0, scopeUnits: 0, offerTiers: 0 },
      reason: "顾客动作只到品牌曝光，本次不建 ICS 单。",
    };
  }

  const factors = {
    batches: draft.schedule.batches.length,
    markets: draft.scope.markets.value.length,
    channels: draft.scope.channels.value.length,
    scopeUnits: scopeUnits(draft).length,
    offerTiers: draft.offer.tiers.length,
  };

  return {
    total: Object.values(factors).reduce((total, factor) => total * factor, 1),
    factors,
  };
}

export function buildIcsDrafts(draft: CampaignDraft): IcsOrderDraft[] {
  if (calculateOrderCount(draft).total === 0) return [];

  const orders: IcsOrderDraft[] = [];
  let sequence = 1;
  for (const batch of draft.schedule.batches) {
    for (const market of draft.scope.markets.value) {
      for (const channel of draft.scope.channels.value) {
        for (const scopeUnit of scopeUnits(draft)) {
          for (const offerTier of draft.offer.tiers) {
            orders.push({
              id: `ics-${sequence}`,
              activitySequence: String(sequence).padStart(3, "0"),
              name: draft.brief.icsName,
              batch,
              market,
              channel,
              scopeUnit,
              offerTier,
              status: draft.unresolved.length ? "blocked" : "ready",
            });
            sequence += 1;
          }
        }
      }
    }
  }
  return orders;
}

