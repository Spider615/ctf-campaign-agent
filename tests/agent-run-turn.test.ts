import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRequest } from "../app/lib/agent/protocol.ts";
import { AGENT_TOOL_NAMES, createAgentState } from "../app/lib/agent/tools.ts";
import { createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
import { runCampaignToolWithSkillGate } from "../agent/tool-gate.ts";

const requestFor = (text: string): AgentRequest => ({
  today: "2026-09-17",
  draft: createEmptyDraft("runner-gate", text),
  history: [],
  trigger: { kind: "user_message", text },
  phase: "collecting",
  openQuestions: [],
  proposals: [],
  canUndo: false,
});

test("campaign-orchestrator 加载前所有活动工具都被挡住且不修改状态", () => {
  for (const name of AGENT_TOOL_NAMES) {
    const state = createAgentState(requestFor("10月1日到7日，7590店，钻石95折"));
    const before = structuredClone(state);
    const outcome = runCampaignToolWithSkillGate(state, name, {}, new Set());

    assert.equal(outcome.isError, true, name);
    assert.match(outcome.text, /先加载 campaign-orchestrator/, name);
    assert.deepEqual(state, before, `${name} 被门禁拒绝后修改了 AgentState`);
  }
});

test("总体工具只需编排 Skill，1811 工具还需要子流程 Skill", () => {
  const planState = createAgentState(requestFor("做一个会员唤醒活动"));
  const plan = runCampaignToolWithSkillGate(
    planState,
    "analyze_campaign_plan",
    {},
    new Set(["campaign-orchestrator"]),
  );
  assert.equal(plan.isError, undefined);

  const analysisState = createAgentState(requestFor("10月1日到7日，7590店，钻石95折"));
  const missingChildSkill = runCampaignToolWithSkillGate(
    analysisState,
    "analyze_campaign_state",
    {},
    new Set(["campaign-orchestrator"]),
  );
  assert.equal(missingChildSkill.isError, true);
  assert.match(missingChildSkill.text, /campaign-sop/);
  const analysis = runCampaignToolWithSkillGate(
    analysisState,
    "analyze_campaign_state",
    {},
    new Set(["campaign-orchestrator", "campaign-sop"]),
  );
  assert.equal(analysis.isError, undefined);
  assert.equal(analysisState.analysisRan, true);

  const promoState = createAgentState(requestFor("请基于当前活动生成一份对外宣传文案"));
  const before = structuredClone(promoState);
  const promo = runCampaignToolWithSkillGate(
    promoState,
    "draft_promo_copy",
    { headline: "国庆臻选", highlights: ["到店了解活动"] },
    new Set(["campaign-orchestrator", "campaign-sop"]),
  );
  assert.equal(promo.isError, true);
  assert.match(promo.text, /先加载 promo-copy-guide/);
  assert.deepEqual(promoState, before);
});
