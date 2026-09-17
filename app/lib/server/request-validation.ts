import type { CampaignChannel, CampaignDraft, CommunicationCreative } from "../campaign/types.ts";
import { normalizeCampaignDraft } from "../campaign/workspace.ts";
import { emptyFacts } from "../campaign/ics1811/facts.ts";
import type { Ics1811Draft } from "../campaign/ics1811/types.ts";

export type CampaignDocument = CampaignDraft | Ics1811Draft;

const CAMPAIGN_CHANNELS: readonly CampaignChannel[] = ["store", "wechat", "ecommerce", "social", "member_crm", "event"];
const FACT_VIA = ["text", "card", "panel", "proposal"] as const;
const ICS_FACT_KEYS = Object.keys(emptyFacts());

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isStoredFact = (value: unknown) => value === null || isRecord(value) && "value" in value && typeof value.quote === "string" && FACT_VIA.includes(value.via as (typeof FACT_VIA)[number]);
const isFactsRecord = (value: unknown) => isRecord(value) && ICS_FACT_KEYS.every((key) => isStoredFact(value[key]));
const isStringFact = (value: unknown) => isRecord(value) && typeof value.value === "string" && typeof value.quote === "string" && FACT_VIA.includes(value.via as (typeof FACT_VIA)[number]);
const isChannelsFact = (value: unknown) => isRecord(value) && Array.isArray(value.value) && value.value.every((channel) => CAMPAIGN_CHANNELS.includes(channel)) &&
  typeof value.quote === "string" && FACT_VIA.includes(value.via as (typeof FACT_VIA)[number]);
const nullableFact = (value: unknown, validate: (candidate: unknown) => boolean) => value === null || validate(value);

export function isIcs1811Draft(value: unknown): value is Ics1811Draft {
  if (!isRecord(value)) return false;
  const draft = value;
  return (
    draft.schema === "ics1811/v1" &&
    typeof draft.id === "string" &&
    typeof draft.requestText === "string" &&
    isFactsRecord(draft.facts) &&
    Array.isArray(draft.unresolvedStores) &&
    Array.isArray(draft.unresolvedCategories) &&
    Array.isArray(draft.dismissedNotes)
  );
}

function isCommunicationCreative(value: unknown): value is CommunicationCreative {
  if (!isRecord(value) || !isRecord(value.concept) || !Array.isArray(value.channelOutputs)) return false;
  return (
    typeof value.concept.headline === "string" &&
    typeof value.concept.subheadline === "string" &&
    typeof value.concept.coreMessage === "string" &&
    value.channelOutputs.every((output) => isRecord(output) && CAMPAIGN_CHANNELS.includes(output.channel as CampaignChannel) &&
      typeof output.format === "string" && typeof output.copy === "string" && typeof output.cta === "string") &&
    typeof value.visualDirection === "string" &&
    (value.source === "ai" || value.source === "user")
  );
}

export function isCampaignDraft(value: unknown): value is CampaignDraft {
  if (!isRecord(value) || !isRecord(value.brief)) return false;
  const brief = value.brief;
  return (
    value.schema === "campaign/v1" &&
    typeof value.id === "string" &&
    typeof value.requestText === "string" &&
    nullableFact(brief.name, isStringFact) &&
    nullableFact(brief.objective, isStringFact) &&
    nullableFact(brief.audience, isStringFact) &&
    nullableFact(brief.theme, isStringFact) &&
    nullableFact(brief.channels, isChannelsFact) &&
    nullableFact(brief.timing, isStringFact) &&
    nullableFact(brief.scope, isStringFact) &&
    (value.ics1811 === null || isIcs1811Draft(value.ics1811)) &&
    (value.communication === null || isCommunicationCreative(value.communication))
  );
}

// 存储边界逐份调用：两种当前可读文档都转成统一父层；更早的营销方案结构继续返回 null，
// 由 SessionStore 保持原来的 legacy 行为。normalizeCampaignDraft 会克隆输入，不改历史快照。
export function parseCampaignDocument(value: unknown): CampaignDraft | null {
  if (!isCampaignDraft(value) && !isIcs1811Draft(value)) return null;
  return normalizeCampaignDraft(value);
}
