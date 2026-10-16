import test from "node:test";
import assert from "node:assert/strict";
import { analysisReviewClaims, inspectAnalysisGlobalSupport, validateReviewClaimChecks, packAnalysisReviewClaims, expandReviewClaimGroups } from "../agent/analytics-review-support.ts";
import type { AnalysisDraft, AnalysisEvidence } from "../app/lib/analytics/analysis-v2-types.ts";

const evidence: AnalysisEvidence = {
  frames: [{ id: "window", snapshotId: "snapshot", datasetVersion: "sample", mode: "snapshot", provenance: "sample", scope: { period: { start: "2026-09-01", end: "2026-09-07" }, population: "sales", filters: {} }, currency: "CNY", grain: "group", controls: [], limitations: [] }],
  facts: [{ id: "amount", frameId: "window", operationId: "aggregate", metricId: "amount", label: "实收", value: 700, unit: "CNY", definition: "实际选定记录", objectIds: ["store"], limitations: [] }],
  objects: [{ id: "store", frameId: "window", dimension: "store", value: "某店", label: "某店" }], methods: [],
};
const draft: AnalysisDraft = {
  status: "conditional",
  conclusions: [{ id: "direction", needIds: ["need-1"], level: "hypothesis", judgement: "已有记录显示金额变化", factIds: ["amount"], objectIds: ["store"], methodIds: [], limitations: ["没有客流字段"], action: "先检查成交结构", validation: "补足客流后再验证机制" }],
  blocks: [
    { kind: "heading", nodes: [{ kind: "text", text: "结论" }] },
    { kind: "paragraph", conclusionId: "direction", nodes: [{ kind: "object_ref", objectId: "store" }, { kind: "text", text: "实收" }, { kind: "fact_ref", factId: "amount" }, { kind: "text", text: "。这说明客流因素已排除。" }] },
    { kind: "bullet", conclusionId: "direction", nodes: [{ kind: "text", text: "将牌价作为成本计算毛利" }] },
  ],
  questions: ["该店是否由大单带动？"], userConditions: [],
  trialParameters: [{ id: "pilot", kind: "duration_days", value: 7, objectIds: [], conditions: ["须补齐会员标识后度量复购"], status: "proposed" }],
  coverage: [{ needId: "need-1", status: "conditional", reason: "机制尚未验证" }],
};

test("复核目录覆盖实际正文、建议、验证、限制、追问和拟议条件，不能只覆盖结论摘要", () => {
  const before = structuredClone(draft);
  const claims = analysisReviewClaims(draft, evidence);
  const texts = claims.map((claim) => claim.text).join("\n");
  for (const text of ["已有记录显示金额变化", "客流因素已排除", "将牌价作为成本", "先检查成交结构", "补足客流", "没有客流字段", "是否由大单带动", "补齐会员标识"]) assert.ok(texts.includes(text), text);
  assert.ok(texts.includes("700.00元"), "只解析已登记事实，不由模型补值");
  assert.ok(texts.includes("某店"));
  assert.equal(new Set(claims.map((claim) => claim.id)).size, claims.length);
  assert.deepEqual(analysisReviewClaims(draft, evidence), claims, "同稿续窗引用保持稳定");
  assert.deepEqual(draft, before, "复核不改原草稿");
});

test("总体结论核对完成不能豁免尚未读取或漏审的正文和追问", () => {
  const claims = analysisReviewClaims(draft, evidence);
  const checks = claims.map((claim) => ({ claimId: claim.id, status: "supported" as const, reason: "核对了此项实际范围和解释边界" }));
  const read = new Set(claims.map((claim) => claim.id));
  assert.equal(validateReviewClaimChecks(claims, checks, read), undefined);
  assert.match(validateReviewClaimChecks(claims, checks.slice(0, -1), read)!, /完整|遗漏/);
  read.delete(claims[0].id);
  assert.match(validateReviewClaimChecks(claims, checks, read)!, /读取/);
});

test("审阅记录拒绝伪造或重复引用，不用not_applicable跳过经营正文", () => {
  const claims = analysisReviewClaims(draft, evidence);
  const checks = claims.map((claim) => ({ claimId: claim.id, status: "supported" as const, reason: "已核对真实范围" }));
  const read = new Set(claims.map((claim) => claim.id));
  assert.match(validateReviewClaimChecks(claims, [{ ...checks[0], claimId: "invented" }, ...checks.slice(1)], read)!, /真实|未知|引用/);
  assert.match(validateReviewClaimChecks(claims, [checks[0], ...checks.slice(0, -1)], read)!, /重复|完整/);
  const business = claims.findIndex((claim) => claim.text.includes("客流因素已排除"));
  assert.match(validateReviewClaimChecks(claims, checks.map((check, index) => index === business ? { ...check, status: "not_applicable" as const } : check), read)!, /正文|跳过|适用/);
});

test("标题和正文均须明确核对，不能把经营断言放标题后标不适用", () => {
  const claims = analysisReviewClaims(draft, evidence);
  const title = claims.find((claim) => claim.text === "结论")!;
  const body = claims.find((claim) => claim.text.includes("客流因素已排除"))!;
  const question = claims.find((claim) => claim.text.includes("是否由大单带动"))!;
  assert.equal(title.kind, "heading");
  assert.equal(body.conclusionId, "direction");
  assert.deepEqual(body.needIds, ["need-1"]);
  assert.equal(question.kind, "question");
  const checks = claims.map((claim) => ({ claimId: claim.id, status: "supported" as const, reason: claim.id === title.id ? "标题仅作导航，不含经营断言" : "明确核对了对应公开内容" }));
  const read = new Set(claims.map((claim) => claim.id));
  assert.equal(validateReviewClaimChecks(claims, checks, read), undefined);
  assert.match(validateReviewClaimChecks(claims, checks.map((check) => check.claimId === title.id ? { ...check, status: "not_applicable" as const } : check), read)!, /标题.*跳过/);
  const adversarial = structuredClone(draft); adversarial.blocks[0].nodes = [{ kind: "text", text: "客流因素已排除，因此可以全面推广" }];
  const headingClaims = analysisReviewClaims(adversarial, evidence);
  assert.match(validateReviewClaimChecks(headingClaims, headingClaims.map((claim) => ({ claimId: claim.id, status: claim.kind === "heading" ? "not_applicable" as const : "supported" as const, reason: "核对" })), new Set(headingClaims.map((claim) => claim.id)))!, /标题.*跳过/);
});

test("无结论的诚实未完成正文可全局读取，关联真实任务而非编造结论", () => {
  const value = { ...structuredClone(draft), status: "incomplete" as const, conclusions: [], blocks: [{ kind: "paragraph" as const, nodes: [{ kind: "text" as const, text: "必要分析尚未完成" }] }], coverage: undefined };
  const capabilities = { mode: "snapshot" as const, name: "合成", coverage: { start: "2026-09-01", end: "2026-09-07" }, currency: "CNY", provenance: "sample" as const, dimensions: [], metrics: [], methods: [], limitations: [] };
  const packet = inspectAnalysisGlobalSupport(value, evidence, capabilities, ["need-1"]);
  assert.ok(packet.claims.length); assert.ok(packet.claims.every((claim) => !claim.conclusionId && claim.needIds.includes("need-1")));
  const checks = packet.claims.map((claim) => ({ claimId: claim.id, status: "revise" as const, reason: "实际必要判断尚未完成" }));
  assert.equal(validateReviewClaimChecks(packet.claims, checks, new Set(packet.claims.map((claim) => claim.id))), undefined);
});

test("审阅传输共享段落上下文，能完整重建每个原句、位置和真实引用", () => {
  const value = structuredClone(draft);
  value.blocks[1].nodes.push({ kind: "text", text: "金额存在不能证明客流已核对。无记录不能证明因素不存在。" });
  const claims = analysisReviewClaims(value, evidence);
  const packed = packAnalysisReviewClaims(claims);
  const rebuilt = packed.claims.map(({ contextId, ...claim }) => {
    const context = packed.contexts.find((entry) => entry.id === contextId)!;
    return { ...claim, context: context.context, factIds: context.factIds, objectIds: context.objectIds };
  });
  assert.deepEqual(rebuilt, claims);
  const body = packed.claims.filter((claim) => claim.source.startsWith("block:1:"));
  assert.equal(new Set(body.map((claim) => claim.contextId)).size, 1);
  assert.ok(body.length >= 4); assert.ok(body.some((claim) => claim.text.includes("客流因素已排除")));
  const changed = structuredClone(claims); changed[0].objectIds = ["另一个实际对象"];
  const separate = packAnalysisReviewClaims([claims[0], { ...changed[0], id: "other" }]);
  assert.notEqual(separate.claims[0].contextId, separate.claims[1].contextId);
  for (const change of [{ conclusionId: "other" }, { needIds: ["other"] }, { kind: "body" as const }]) {
    const scoped = packAnalysisReviewClaims([claims[0], { ...claims[0], id: "other", ...change }]);
    assert.notEqual(scoped.claims[0].contextId, scoped.claims[1].contextId);
  }
});

test("正面分组只展开明确声明的同上下文原句，负面、遗漏、重复及未读记录仍拒绝", () => {
  const claims = analysisReviewClaims(draft, evidence); const body = claims.filter((claim) => claim.source.startsWith("block:1:"));
  assert.equal(body.length, 2);
  const other = claims.filter((claim) => !body.includes(claim)).map((claim) => ({ claimId: claim.id, status: "supported" as const, reason: "已核对该原始来源" }));
  const grouped = expandReviewClaimGroups(claims, other, [{ claimIds: body.map((claim) => claim.id), reason: "明确核对本段全部原句及每项因果、排除和数值边界" }]);
  assert.equal(grouped.length, claims.length); assert.equal(validateReviewClaimChecks(claims, grouped, new Set(claims.map((claim) => claim.id))), undefined);
  assert.match(validateReviewClaimChecks(claims, grouped.slice(0, -1), new Set(claims.map((claim) => claim.id)))!, /完整|遗漏/);
  assert.match(validateReviewClaimChecks(claims, grouped, new Set(other.map((check) => check.claimId)))!, /读取/);
  for (const ids of [[body[0].id, "unknown"], [body[0].id, body[0].id], [body[0].id, claims[0].id], []]) {
    assert.throws(() => expandReviewClaimGroups(claims, other, [{ claimIds: ids, reason: "核对全部" }]), /真实|重复|上下文|非空/);
  }
  assert.throws(() => expandReviewClaimGroups(claims, [...other, { claimId: body[0].id, status: "revise", reason: "该原句有问题" }], [{ claimIds: body.map((claim) => claim.id), reason: "核对全部" }]), /重复/);
});

test("显示相同日期的不同原段落不能混合，周期引用的真实来源身份保持区分", () => {
  const value = structuredClone(draft), data = structuredClone(evidence);
  data.frames.push({ ...data.frames[0], id: "other-window", scope: { ...data.frames[0].scope, filters: { stores: ["另一门店"] } } });
  value.blocks = ["window", "other-window"].map((frameId) => ({ kind: "paragraph", conclusionId: "direction", nodes: [{ kind: "period_ref", frameId }, { kind: "text", text: "该范围尚需核对经营含义。" }] }));
  const claims = analysisReviewClaims(value, data).filter((claim) => claim.kind === "body");
  assert.equal(claims.length, 2); assert.equal(claims[0].text, claims[1].text);
  assert.notEqual(claims[0].source, claims[1].source);
  const packed = packAnalysisReviewClaims(claims); assert.notEqual(packed.claims[0].contextId, packed.claims[1].contextId);
  assert.throws(() => expandReviewClaimGroups(claims, [], [{ claimIds: claims.map((claim) => claim.id), reason: "同显示内容已核对" }]), /上下文/);
});
