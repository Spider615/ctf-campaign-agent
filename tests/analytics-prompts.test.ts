import assert from "node:assert/strict";
import test from "node:test";
import { buildAnalyticsSystemPrompt } from "../agent/analytics-system-prompt.ts";
import { validateAnalysisDraft } from "../app/lib/analytics/analysis-v2-evidence.ts";
import { analysisPresentationBlocks } from "../app/lib/analytics/analysis-v2-format.ts";
import type { AnalysisDraft, AnalysisFact, FactExpression } from "../app/lib/analytics/analysis-v2-types.ts";
import { simulatedAnswer } from "./helpers/analysis-v2-answer.ts";

function examples(): AnalysisDraft[] {
  const prompt = buildAnalyticsSystemPrompt("2026-10-15");
  const drafts = [...prompt.matchAll(/```json\s*([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]) as AnalysisDraft);
  assert.equal(drafts.length, 2, "新版协议应提供历史判断和拟议试点的完整提交示例");
  return drafts;
}

function context() {
  const answer = simulatedAnswer();
  answer.task.needs[0].id = "example-need";
  for (const frame of answer.evidence.frames) frame.id = "example-period";
  for (const object of answer.evidence.objects) { object.id = "example-store"; object.frameId = "example-period"; }
  for (const fact of answer.evidence.facts) { fact.id = `example-${fact.id}`; fact.frameId = "example-period"; fact.objectIds = ["example-store"]; }
  for (const method of answer.evidence.methods) { method.id = "example-method"; method.frameIds = ["example-period"]; }
  const source = answer.evidence.facts[0]; source.value = 100;
  const reference = { ...structuredClone(answer.evidence.frames[0]), id: "example-reference", scope: { ...answer.evidence.frames[0].scope, period: { start: "2025-01-01", end: "2025-01-28" } } };
  answer.evidence.frames.push(reference);
  answer.evidence.objects.push({ ...answer.evidence.objects[0], id: "example-reference-store", frameId: reference.id });
  const add = (id: string, value: number, metricId: string, unit = "元", frameId = "example-period", derivation?: FactExpression, operationId = "operation"): AnalysisFact => {
    const fact = { ...source, id, value, metricId, unit, frameId, operationId, label: metricId, objectIds: [frameId === reference.id ? "example-reference-store" : "example-store"], ...(derivation ? { derivation } : {}) };
    answer.evidence.facts.push(fact); return fact;
  };
  add("example-reference-amount", 200, "amount", "元", reference.id);
  add("example-quantity", 10, "quantity", "件"); add("example-reference-quantity", 10, "quantity", "件", reference.id);
  add("example-amount-delta", -100, "amount.delta", "元", "example-period", { op: "subtract", args: [{ factId: "example-amount" }, { factId: "example-reference-amount" }] });
  add("example-quantity-delta", 0, "quantity.delta", "件", "example-period", { op: "subtract", args: [{ factId: "example-quantity" }, { factId: "example-reference-quantity" }] });
  answer.evidence.methods[0].method = "compare"; answer.evidence.methods[0].frameIds.push(reference.id);
  const cut = add("example-cut", 2, "assumption.cut", "元/件", "example-period", undefined, "example-calc"); cut.assumption = { reason: "仅为合成情景参数，不代表真实优惠" };
  add("example-price", 10, "calculation.price", "元/件", "example-period", { op: "divide", args: [{ factId: "example-amount" }, { factId: "example-quantity" }] }, "example-calc");
  add("example-next-price", 8, "calculation.next", "元/件", "example-period", { op: "subtract", args: [{ factId: "example-price" }, { factId: "example-cut" }] }, "example-calc");
  add("example-growth", 25, "calculation.growth", "%", "example-period", { op: "multiply", args: [{ constant: 100 }, { op: "subtract", args: [{ op: "divide", args: [{ factId: "example-price" }, { factId: "example-next-price" }] }, { constant: 1 }] }] }, "example-calc");
  answer.evidence.methods.push({ ...answer.evidence.methods[0], id: "example-calculation-method", operationId: "example-calc", method: "aggregate", frameIds: ["example-period"] });
  return answer;
}

test("提示词中的历史判断和试点示例通过真实草稿校验，正文保留引用与排版", () => {
  const answer = context(); const original = structuredClone(answer);
  const drafts = examples();
  for (const draft of drafts) {
    const checked = validateAnalysisDraft(answer.task, draft, answer.evidence);
    assert.equal(checked.valid, true, JSON.stringify(checked.issues));
    const blocks = analysisPresentationBlocks({ ...answer, ...draft });
    const nodes = blocks.flatMap((block) => block.kind === "list" ? block.items.flatMap((item) => item.nodes) : block.nodes);
    assert.ok(nodes.some((node) => node.kind === "object_ref" && node.text === "模拟甲店"));
    assert.ok(nodes.some((node) => node.bold), "示例应能实际渲染重点加粗");
  }
  assert.equal(drafts[0].conclusions[0].level, "comparison_supported");
  assert.equal(drafts[1].conclusions[0].level, "hypothesis");
  assert.ok(drafts[1].conclusions[0].validation);
  assert.ok(!analysisPresentationBlocks({ ...answer, ...drafts[1] }).some((block) => block.kind === "paragraph" && block.nodes.some((node) => node.text.includes("建议动作："))), "示例正文已表达动作时，不应再次补写重复动作");
  assert.deepEqual(answer, original);
});

test("示例编号只演示结构，缺少本回合真实证据时不能作为经营结论提交", () => {
  const answer = context();
  for (const draft of examples()) {
    const checked = validateAnalysisDraft(answer.task, draft, { frames: [], facts: [], objects: [], methods: [] });
    assert.equal(checked.valid, false);
    assert.ok(checked.issues.some((issue) => issue.kind === "missing_evidence"));
  }
});

test("情景示例不能升级为历史观察，也不能把拟议条件反写为用户已确认", () => {
  const answer = context(); const draft = examples()[1];
  const observed = structuredClone(draft); observed.conclusions[0].level = "observed";
  assert.equal(validateAnalysisDraft(answer.task, observed, answer.evidence).valid, false);
  const invented = structuredClone(draft); invented.userConditions = [{ id: "invented", quote: "业务已同意扩大优惠" }];
  assert.equal(validateAnalysisDraft(answer.task, invented, answer.evidence).valid, false);
});
