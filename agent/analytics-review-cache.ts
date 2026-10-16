import { createHash } from "node:crypto";
import type { AnalysisDraft, AnalysisEvidence, AnalysisReviewIssue } from "../app/lib/analytics/analysis-v2-types.ts";
import type { AnalysisReviewClaim } from "./analytics-review-support.ts";

type Check = { status: "supported" | "revise" | "not_applicable"; reason: string };
type ConclusionCheck = { conclusionId: string; scope: Check; quantitativeMeaning: Check; capability: Check; interpretation: Check };
type ClaimCheck = { claimId: string; status: "supported" | "revise"; reason: string };
type ReviewRecord = { verdict: "accept" | "revise" | "accept_conditional"; issues: AnalysisReviewIssue[]; checks: ConclusionCheck[]; claimChecks: ClaimCheck[] };
type Input = { evidence: AnalysisEvidence; context: unknown; draft: AnalysisDraft; claims: AnalysisReviewClaim[] };
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");
const contextKey = ({ context, draft }: Input) => fingerprint({ context, status: draft.status, coverage: draft.coverage, userConditions: draft.userConditions, trialParameters: draft.trialParameters, visualizations: draft.visualizations });
const claimContent = (claim: AnalysisReviewClaim) => Object.fromEntries(Object.entries(claim).filter(([key]) => key !== "id"));
const conclusionKeys = ({ draft, claims }: Input) => new Map(draft.conclusions.map((conclusion) => [conclusion.id, fingerprint({ conclusion, blocks: draft.blocks.map((block, index) => ({ index, block })).filter(({ block }) => block.conclusionId === conclusion.id), claims: claims.filter((claim) => claim.conclusionId === conclusion.id).map(claimContent) })]));

// 仅在一个回合内复用已提交的独立正面记录；全局内容及本次整体一致性仍需新的独立审阅。
export function createAnalysisReviewCache() {
  let sequence = 0;
  let prior: { evidence: AnalysisEvidence; contextKey: string; conclusionKeys: Map<string, string>; claims: Array<{ id: string; key: string }>; record: ReviewRecord; sequence: number } | undefined;
  return {
    remember(input: Input, record: ReviewRecord): void {
      prior = { evidence: input.evidence, contextKey: contextKey(input), conclusionKeys: conclusionKeys(input), claims: input.claims.map((claim) => ({ id: claim.id, key: fingerprint(claimContent(claim)) })), record: structuredClone(record), sequence: ++sequence };
    },
    reuse(input: Input) {
      const empty = { conclusionIds: [] as string[], checks: [] as ConclusionCheck[], claimChecks: [] as ClaimCheck[], claimOrigins: [] as Array<{ claimId: string; fromClaimId: string }>, fromReview: undefined as number | undefined };
      if (!prior || prior.evidence !== input.evidence || prior.contextKey !== contextKey(input) || prior.record.issues.some((issue) => !issue.needIds.length && !issue.conclusionIds.length)) return empty;
      const keys = conclusionKeys(input); const conclusionIds = new Set<string>(); const claimChecks: ClaimCheck[] = []; const claimOrigins: Array<{ claimId: string; fromClaimId: string }> = [];
      for (const conclusion of input.draft.conclusions) {
        if (keys.get(conclusion.id) !== prior.conclusionKeys.get(conclusion.id) || prior.record.issues.some((issue) => issue.conclusionIds.includes(conclusion.id) || issue.needIds.some((id) => conclusion.needIds.includes(id)))) continue;
        const checks = prior.record.checks.filter((check) => check.conclusionId === conclusion.id);
        if (checks.length !== 1 || [checks[0].scope, checks[0].quantitativeMeaning, checks[0].capability, checks[0].interpretation].some((check) => check.status !== "supported")) continue;
        const ownClaims = input.claims.filter((claim) => claim.conclusionId === conclusion.id);
        const bindings = ownClaims.map((claim) => { const origins = prior!.claims.filter((origin) => origin.key === fingerprint(claimContent(claim))); const records = origins.length === 1 ? prior!.record.claimChecks.filter((check) => check.claimId === origins[0].id) : []; return { claim, origin: origins[0], records }; });
        if (bindings.some(({ origin, records }) => !origin || records.length !== 1 || records[0].status !== "supported")) continue;
        conclusionIds.add(conclusion.id);
        for (const { claim, origin, records } of bindings) { claimChecks.push({ ...records[0], claimId: claim.id }); claimOrigins.push({ claimId: claim.id, fromClaimId: origin.id }); }
      }
      return { conclusionIds: [...conclusionIds], checks: structuredClone(prior.record.checks.filter((check) => conclusionIds.has(check.conclusionId))), claimChecks: structuredClone(claimChecks), claimOrigins, fromReview: conclusionIds.size ? prior.sequence : undefined };
    },
  };
}
