import type { Ics1811Draft } from "../campaign/ics1811/types.ts";
import type { CampaignDraft } from "../campaign/types.ts";

export function isIcs1811Draft(value: unknown): value is Ics1811Draft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return (
    draft.schema === "ics1811/v1" &&
    typeof draft.id === "string" &&
    typeof draft.requestText === "string" &&
    Boolean(draft.facts) && typeof draft.facts === "object" && !Array.isArray(draft.facts) &&
    Array.isArray(draft.unresolvedStores) &&
    Array.isArray(draft.unresolvedCategories) &&
    Array.isArray(draft.dismissedNotes)
  );
}

export function isCampaignDraft(value: unknown): value is CampaignDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  const requiredObjects = ["brief", "intent", "audience", "products", "offer", "scope", "schedule", "metric", "operations"];
  return (
    typeof draft.id === "string" &&
    typeof draft.title === "string" &&
    requiredObjects.every((key) => draft[key] && typeof draft[key] === "object" && !Array.isArray(draft[key])) &&
    Array.isArray(draft.unresolved)
  );
}

