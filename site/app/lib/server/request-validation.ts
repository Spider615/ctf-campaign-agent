import type { CampaignDraft } from "../campaign/types.ts";

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

