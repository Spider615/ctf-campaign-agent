import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRequest } from "../app/lib/agent/protocol.ts";
import { createAgentState, runAgentTool, safeToolSummary } from "../app/lib/agent/tools.ts";
import { EXAMPLES } from "../app/lib/campaign/ics1811/examples.ts";
import { applyFactWrites, createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";

const TODAY = "2026-09-16";
const PROMO_CONTEXT = { loadedSkills: new Set(["promo-copy-guide"]) };

const requestFor = (text: string): AgentRequest => ({
  today: TODAY,
  draft: createEmptyDraft("tool-test", text),
  history: [],
  trigger: { kind: "user_message", text },
  phase: "collecting",
  openQuestions: [],
  proposals: [],
  canUndo: false,
});

test("promo copy refuses an empty draft and invented numbers, then stores the creative part", () => {
  const t1 = EXAMPLES[0];

  // 事实还没齐就起草对外文案，等于让模型对着空草稿编，拒绝掉。
  const bare = createAgentState(requestFor("想做个国庆活动"));
  const tooEarly = runAgentTool(bare, "draft_promo_copy", { headline: "国庆好礼", highlights: ["全场优惠"] }, PROMO_CONTEXT);
  assert.equal(tooEarly.isError, true, "优惠和货类都还没有，不能起草宣传文案");

  const ready = createAgentState({
    ...requestFor(t1.first),
    draft: applyFactWrites(createEmptyDraft("promo", t1.first), t1.firstWrites, { text: t1.first, today: TODAY }).draft,
  });

  // 对外文案最容易出事的就是编数字。8888 在 T1 的事实层里不存在，必须挡住。
  const invented = runAgentTool(ready, "draft_promo_copy", { headline: "满8888送好礼", highlights: ["每克减15元"] }, PROMO_CONTEXT);
  assert.equal(invented.isError, true, "事实层里没有的数字不能出现在对外文案里");
  // 用局部变量接住再断言：直接 assert.equal(ready.draft.promo, null) 会让 TS 把这个属性
  // 永久收窄成 null（它不知道后面的 runAgentTool 会改写它），后面读 promo.headline 就成了 never。
  const afterInvented = ready.draft.promo;
  assert.equal(afterInvented, null, "被拒的文案不能落进草稿");

  const ok = runAgentTool(ready, "draft_promo_copy", { headline: "黄金每克减15", highlights: ["一般足金类每克立减15元"] }, PROMO_CONTEXT);
  assert.equal(ok.isError, undefined);
  assert.equal(ready.draft.promo?.headline, "黄金每克减15");
  assert.deepEqual(ready.draft.promo?.highlights, ["一般足金类每克立减15元"]);
  assert.equal(ready.draft.promo?.source, "ai");
});

test("promo copy requires the same-turn guide without mutating state", () => {
  const t1 = EXAMPLES[0];
  const state = createAgentState({
    ...requestFor(t1.first),
    draft: applyFactWrites(createEmptyDraft("promo-gate", t1.first), t1.firstWrites, { text: t1.first, today: TODAY }).draft,
  });
  const before = structuredClone(state);

  const blocked = runAgentTool(state, "draft_promo_copy", {
    headline: "黄金克减季",
    highlights: ["一般足金类每克立减15元"],
  });

  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /先加载 promo-copy-guide/);
  assert.deepEqual(state, before);
  assert.equal(safeToolSummary("draft_promo_copy", blocked, state), "文案尚未生成，Agent 会先加载规则或修正文案");
});

test("campaign tools expose deterministic analysis without changing the draft", () => {
  const state = createAgentState(requestFor("满5000减500，钻石类"));
  const before = structuredClone(state.draft);
  const outcome = runAgentTool(state, "analyze_campaign_state");
  const body = JSON.parse(outcome.text);

  assert.deepEqual(state.draft, before);
  assert.equal(typeof body.detailCount, "number");
  assert.ok(Array.isArray(body.missing));
  // 缺项带题号：模型登记追问要用。
  assert.ok(body.missing.every((gap: { id: string; question: string }) => /^Q\d/.test(gap.id) && gap.question), JSON.stringify(body.missing));
  assert.equal(body.complete, false);
  assert.match(body.next, /ask_campaign_questions/);
  assert.equal(state.analysisRan, true);
});

test("reference lookup returns codebook matches and source labels", () => {
  const state = createAgentState(requestFor("7590门店一般足金类"));
  const outcome = runAgentTool(state, "lookup_ics_reference", { query: "7590 一般足金" });
  const body = JSON.parse(outcome.text);

  assert.ok(body.matches.some((item: { code: string }) => item.code === "7590"));
  assert.ok(body.matches.some((item: { label: string }) => item.label === "一般足金类"));
  assert.ok(body.matches.every((item: { origin: string }) => item.origin));
});

test("the sheet tool needs a complete campaign, not a confirmation", () => {
  const example = EXAMPLES.find((item) => item.id === "T1")!;
  const partial = createAgentState(requestFor("7590门店钻石类打9折"));
  assert.equal(runAgentTool(partial, "generate_ics1811_sheet").isError, true, "信息不齐不能生成");
  assert.equal(partial.sheetGenerated, false);

  const draft = applyFactWrites(createEmptyDraft("tool-complete", example.first), example.firstWrites, {
    text: example.first,
    today: TODAY,
  }).draft;
  // 用户这句话和确认毫无关系：齐了就能生成，不再看用户有没有说「确认」。
  const state = createAgentState({ ...requestFor("名称写得正式一点"), draft, phase: "ready" });
  const analysis = JSON.parse(runAgentTool(state, "analyze_campaign_state").text);
  assert.equal(analysis.complete, true);
  assert.deepEqual(analysis.missing, []);
  assert.match(analysis.next, /直接生成/);
  const sheet = JSON.parse(runAgentTool(state, "generate_ics1811_sheet").text);
  assert.equal(sheet.detailCount, 1);
  assert.equal(state.sheetGenerated, true);
});
