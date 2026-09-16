import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRequest } from "../app/lib/agent/protocol.ts";
import { createAgentState, runAgentTool } from "../app/lib/agent/tools.ts";
import { EXAMPLES } from "../app/lib/campaign/ics1811/examples.ts";
import { applyFactWrites, createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";

const TODAY = "2026-09-16";

const requestFor = (text: string): AgentRequest => ({
  today: TODAY,
  draft: createEmptyDraft("tool-test", text),
  history: [],
  trigger: { kind: "user_message", text },
  phase: "asking",
  roundsUsed: 0,
  openQuestions: [],
  readbackSeq: null,
  canConfirm: false,
  canUndo: false,
});

test("promo copy refuses an empty draft and invented numbers, then stores the creative part", () => {
  const t1 = EXAMPLES[0];

  // 事实还没齐就起草对外文案，等于让模型对着空草稿编，拒绝掉。
  const bare = createAgentState(requestFor("想做个国庆活动"));
  const tooEarly = runAgentTool(bare, "draft_promo_copy", { headline: "国庆好礼", highlights: ["全场优惠"] });
  assert.equal(tooEarly.isError, true, "优惠和货类都还没有，不能起草宣传文案");

  const ready = createAgentState({
    ...requestFor(t1.first),
    draft: applyFactWrites(createEmptyDraft("promo", t1.first), t1.firstWrites, { text: t1.first, today: TODAY }).draft,
  });

  // 对外文案最容易出事的就是编数字。8888 在 T1 的事实层里不存在，必须挡住。
  const invented = runAgentTool(ready, "draft_promo_copy", { headline: "满8888送好礼", highlights: ["每克减15元"] });
  assert.equal(invented.isError, true, "事实层里没有的数字不能出现在对外文案里");
  // 用局部变量接住再断言：直接 assert.equal(ready.draft.promo, null) 会让 TS 把这个属性
  // 永久收窄成 null（它不知道后面的 runAgentTool 会改写它），后面读 promo.headline 就成了 never。
  const afterInvented = ready.draft.promo;
  assert.equal(afterInvented, null, "被拒的文案不能落进草稿");

  const ok = runAgentTool(ready, "draft_promo_copy", { headline: "黄金每克减15", highlights: ["一般足金类每克立减15元"] });
  assert.equal(ok.isError, undefined);
  assert.equal(ready.draft.promo?.headline, "黄金每克减15");
  assert.deepEqual(ready.draft.promo?.highlights, ["一般足金类每克立减15元"]);
  assert.equal(ready.draft.promo?.source, "ai");
});

test("campaign tools expose deterministic analysis without changing the draft", () => {
  const state = createAgentState(requestFor("满5000减500，钻石类"));
  const before = structuredClone(state.draft);
  const outcome = runAgentTool(state, "analyze_campaign_state");
  const body = JSON.parse(outcome.text);

  assert.deepEqual(state.draft, before);
  assert.equal(typeof body.detailCount, "number");
  assert.ok(Array.isArray(body.missing));
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

test("readback and sheet tools use the same deterministic campaign pipeline", () => {
  const example = EXAMPLES.find((item) => item.id === "T1")!;
  const draft = applyFactWrites(createEmptyDraft("tool-complete", example.first), example.firstWrites, {
    text: example.first,
    today: TODAY,
  }).draft;
  const state = createAgentState({
    ...requestFor("确认"),
    draft,
    phase: "readback",
    readbackSeq: 1,
    canConfirm: true,
  });

  const readback = JSON.parse(runAgentTool(state, "build_campaign_readback").text);
  assert.match(readback.summary, /黄金每克减15/);
  assert.equal(state.readbackBuilt, true);

  assert.equal(runAgentTool(state, "generate_ics1811_sheet").isError, true, "没有明确确认时不能生成");
  assert.equal(runAgentTool(state, "confirm_campaign_readback").isError, undefined);
  const sheet = JSON.parse(runAgentTool(state, "generate_ics1811_sheet").text);
  assert.equal(sheet.detailCount, 1);
  assert.equal(state.sheetGenerated, true);
});
