import assert from "node:assert/strict";
import test from "node:test";
import { createAnalysisReviewCache } from "../agent/analytics-review-cache.ts";
import { analysisReviewClaims } from "../agent/analytics-review-support.ts";
import type { AnalysisDraft, AnalysisEvidence, AnalysisReviewIssue } from "../app/lib/analytics/analysis-v2-types.ts";

const evidence = Object.freeze({ frames: [], facts: [], objects: [], methods: [] }) as unknown as AnalysisEvidence;
const draft: AnalysisDraft = { status: "answered", conclusions: ["a", "b"].map((id) => ({ id, needIds: [`need-${id}`], level: "observed", judgement: `核对${id}方向`, factIds: [], objectIds: [], methodIds: [], limitations: [] })), blocks: ["a", "b"].map((conclusionId) => ({ kind: "paragraph", conclusionId, nodes: [{ kind: "text", text: `核对${conclusionId}范围。` }] })), questions: ["确认未来执行条件"], userConditions: [], trialParameters: [] };
const supported = { status: "supported" as const, reason: "已核对实际范围" };
const context = { mode: "analysis", rules: "业务规则", task: { needs: ["need-a", "need-b"] }, capabilities: { snapshotId: "frozen" } };
function capture(cache: ReturnType<typeof createAnalysisReviewCache>, current = draft, issue: AnalysisReviewIssue = { needIds: ["need-b"], conclusionIds: ["b"], requirement: "修正范围", kind: "expression" }) {
  const claims = analysisReviewClaims(current, evidence);
  const checks = current.conclusions.map(({ id }) => ({ conclusionId: id, scope: supported, quantitativeMeaning: supported, capability: supported, interpretation: supported }));
  cache.remember({ evidence, context, draft: current, claims }, { verdict: "revise", issues: [issue], checks, claimChecks: claims.map(({ id }) => ({ claimId: id, status: "supported", reason: "已核对实际来源" })) });
}

test("只复用同快照同上下文的真实正面记录，全局来源始终重新审阅", () => {
  const cache = createAnalysisReviewCache(); capture(cache);
  const next = structuredClone(draft); next.conclusions[1].judgement = "修正后的范围";
  const claims = analysisReviewClaims(next, evidence);
  const reuse = cache.reuse({ evidence, context, draft: next, claims });
  assert.deepEqual(reuse.conclusionIds, ["a"]);
  assert.deepEqual(reuse.checks.map((item) => item.conclusionId), ["a"]);
  assert.ok(reuse.claimChecks.length > 0);
  assert.ok(reuse.claimChecks.every((check) => claims.find((claim) => claim.id === check.claimId)?.conclusionId === "a"));
  assert.equal(reuse.fromReview, 1);
  assert.equal(cache.reuse({ evidence: { ...evidence }, context, draft: next, claims }).checks.length, 0);
  for (const extra of [{ rules: "新规则" }, { task: { needs: ["改后的需求"] } }, { capabilities: { snapshotId: "new" } }]) assert.equal(cache.reuse({ evidence, context: { ...context, ...extra }, draft: next, claims }).checks.length, 0);
  next.trialParameters = [{ id: "duration", kind: "duration_days", value: 7, objectIds: [], conditions: ["须确认营业状态"], status: "proposed" }];
  assert.equal(cache.reuse({ evidence, context, draft: next, claims: analysisReviewClaims(next, evidence) }).checks.length, 0);
});

test("原始引用、段落位置、未定位缺口及事项缺口都使旧记录失效", () => {
  const current = structuredClone(draft);
  current.blocks[0].nodes = [{ kind: "period_ref", frameId: "frame-a" }];
  const ledger = { ...evidence, frames: [{ id: "frame-a", scope: { period: { start: "2026-10-01", end: "2026-10-02" } } }, { id: "frame-b", scope: { period: { start: "2026-10-01", end: "2026-10-02" } } }] } as unknown as AnalysisEvidence;
  const cache = createAnalysisReviewCache();
  const claims = analysisReviewClaims(current, ledger);
  const checks = current.conclusions.map(({ id }) => ({ conclusionId: id, scope: supported, quantitativeMeaning: supported, capability: supported, interpretation: supported }));
  cache.remember({ evidence: ledger, context, draft: current, claims }, { verdict: "revise", issues: [{ needIds: ["need-b"], conclusionIds: ["b"], requirement: "修正范围", kind: "expression" }], checks, claimChecks: claims.map(({ id }) => ({ claimId: id, status: "supported", reason: "已核对" })) });
  const changed = structuredClone(current); changed.blocks[0].nodes = [{ kind: "period_ref", frameId: "frame-b" }];
  const nextClaims = analysisReviewClaims(changed, ledger);
  assert.deepEqual(nextClaims, claims, "同日期但不同来源的展示文本可完全相同");
  assert.equal(cache.reuse({ evidence: ledger, context, draft: changed, claims: nextClaims }).checks.length, 0);
  const shifted = structuredClone(current); shifted.blocks.reverse();
  assert.equal(cache.reuse({ evidence: ledger, context, draft: shifted, claims: analysisReviewClaims(shifted, ledger) }).checks.length, 0);
  for (const issue of [{ needIds: [], conclusionIds: [], requirement: "整体不一致", kind: "expression" as const }, { needIds: ["need-a"], conclusionIds: ["b"], requirement: "需求间关联需修正", kind: "task_coverage" as const }]) {
    capture(cache, draft, issue);
    assert.equal(cache.reuse({ evidence, context, draft, claims: analysisReviewClaims(draft, evidence) }).checks.length, 0);
  }
});

test("缓存快照不会被调用方后续修改，也不复用未明确支持的检查", () => {
  const cache = createAnalysisReviewCache(); const mutableContext = structuredClone(context); const current = structuredClone(draft);
  const claims = analysisReviewClaims(current, evidence);
  const checks = current.conclusions.map(({ id }) => ({ conclusionId: id, scope: { ...supported }, quantitativeMeaning: { ...supported }, capability: { ...supported }, interpretation: { ...supported } }));
  const record = { verdict: "revise" as const, issues: [{ needIds: ["need-b"], conclusionIds: ["b"], requirement: "修正", kind: "expression" as const }], checks, claimChecks: claims.map(({ id }) => ({ claimId: id, status: "supported" as const, reason: "实际正面记录" })) };
  cache.remember({ evidence, context: mutableContext, draft: current, claims }, record);
  record.checks[0].scope.reason = "不能反写旧记录"; record.issues[0].needIds.push("need-a"); mutableContext.rules = "新规则";
  const reused = cache.reuse({ evidence, context, draft, claims }); assert.equal(reused.checks[0].scope.reason, supported.reason);
  assert.equal(cache.reuse({ evidence, context: mutableContext, draft, claims }).checks.length, 0);
  const uncertain = { ...record, issues: [], checks: [{ ...checks[0], scope: { status: "not_applicable" as const, reason: "尚未明确核对" } }] };
  cache.remember({ evidence, context, draft, claims }, uncertain);
  assert.equal(cache.reuse({ evidence, context, draft, claims }).checks.length, 0);
});

test("前文新增来源导致目录编号移动时按未变真实来源重新绑定旧记录", () => {
  const cache = createAnalysisReviewCache();
  capture(cache, draft, { needIds: ["need-a"], conclusionIds: ["a"], requirement: "修订前文限制", kind: "expression" });
  const next = structuredClone(draft); next.conclusions[0].limitations.push("未来执行仍需确认营业状态");
  const oldClaims = analysisReviewClaims(draft, evidence); const claims = analysisReviewClaims(next, evidence);
  const reuse = cache.reuse({ evidence, context, draft: next, claims });
  assert.deepEqual(reuse.conclusionIds, ["b"]);
  assert.deepEqual(reuse.claimChecks.map((check) => check.claimId), claims.filter((claim) => claim.conclusionId === "b").map((claim) => claim.id));
  assert.ok(reuse.claimOrigins.some((entry) => entry.claimId !== entry.fromClaimId));
  for (const entry of reuse.claimOrigins) {
    const current = claims.find((claim) => claim.id === entry.claimId)!; const origin = oldClaims.find((claim) => claim.id === entry.fromClaimId)!;
    assert.equal(current.source, origin.source); assert.equal(current.text, origin.text); assert.equal(current.context, origin.context);
  }
});
