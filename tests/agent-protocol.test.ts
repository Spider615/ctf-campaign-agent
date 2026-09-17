import assert from "node:assert/strict";
import test from "node:test";

import { isAgentRequest, parseAgentResult } from "../app/lib/agent/protocol.ts";
import { applyCampaignBriefWrites } from "../app/lib/campaign/brief.ts";
import { createCampaignDraft } from "../app/lib/campaign/workspace.ts";

test("parent campaign requests support a nullable 1811 child and separate stages", () => {
  const campaign = createCampaignDraft("brand", "策划一场新品发布会");
  assert.equal(isAgentRequest({
    today: "2026-09-17",
    campaign,
    draft: null,
    history: [],
    trigger: { kind: "first_message", text: campaign.requestText },
    campaignStage: "briefing",
    ics1811Phase: null,
    openQuestions: [],
    proposals: [],
    canUndo: false,
  }), true);
});

test("agent results can update controlled parent fields but cannot replace campaign identity", () => {
  const campaign = createCampaignDraft("brand", "新品发布面向年轻人");
  const brief = applyCampaignBriefWrites(campaign.brief, [
    { key: "theme", quote: "新品发布" },
    { key: "audience", quote: "年轻人" },
  ], { text: campaign.requestText }).brief;
  const parsed = parseAgentResult({
    campaign: { ...campaign, id: "model-replaced-id" },
    draft: null,
    brief,
    communication: null,
    briefApplied: ["theme", "audience"],
    applied: [],
    dropped: [],
    reply: "Brief 已整理",
    copyDrafted: false,
    undo: false,
    asking: null,
    proposals: [],
    tools: ["update_campaign_brief", "analyze_campaign_plan"],
    trace: null,
  });

  assert.equal("campaign" in parsed, false, "AgentResult 不能携带或覆盖父对象身份");
  assert.equal(parsed.brief?.theme?.value, "新品发布");
  assert.equal(parsed.draft, null);
});
