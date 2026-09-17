import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRequest } from "../app/lib/agent/protocol.ts";
import { createAgentState, finishAgentTurn, runAgentTool, safeToolSummary } from "../app/lib/agent/tools.ts";
import type { CommunicationCreative } from "../app/lib/campaign/types.ts";
import { buildCampaignWorkspace, createCampaignDraft } from "../app/lib/campaign/workspace.ts";
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

const parentRequestFor = (text: string): AgentRequest => {
  const campaign = createCampaignDraft("campaign-tool-test", text);
  const workspace = buildCampaignWorkspace(campaign, TODAY);
  return {
    today: TODAY,
    campaign,
    draft: campaign.ics1811,
    history: [],
    trigger: { kind: "user_message", text },
    campaignStage: workspace.stage,
    ics1811Phase: campaign.ics1811 ? "collecting" : null,
    openQuestions: [],
    proposals: [],
    canUndo: false,
  };
};

test("campaign brief tools work through the parent state without an 1811 child", () => {
  const text = "目标是提升新品认知，面向年轻情侣，主题是福启新章，通过门店和微信发布";
  const state = createAgentState(parentRequestFor(text));

  assert.equal(state.draft, null);
  const updated = runAgentTool(state, "update_campaign_brief", {
    writes: [
      { key: "objective", quote: "提升新品认知" },
      { key: "audience", quote: "年轻情侣" },
      { key: "theme", quote: "福启新章" },
      { key: "channels", quote: "门店和微信" },
      { key: "scope", quote: "全国" },
    ],
  });
  const body = JSON.parse(updated.text);

  assert.equal(updated.isError, undefined);
  assert.deepEqual(body.applied, ["objective", "audience", "theme", "channels"]);
  assert.equal(body.dropped.length, 1);
  assert.equal(state.campaign.brief.objective?.value, "提升新品认知");
  assert.deepEqual(state.campaign.brief.channels?.value, ["store", "wechat"]);
  assert.equal(state.campaign.brief.scope, null, "不在本轮原话里的范围不能落库");

  const analysis = runAgentTool(state, "analyze_campaign_plan");
  const plan = JSON.parse(analysis.text);
  assert.equal(plan.brief.status, "ready");
  assert.equal(plan.artifacts.ics1811.status, "not_applicable");
  assert.ok(plan.executionTracks.some((track: { kind: string }) => track.kind === "communications"));
  assert.equal(state.campaignAnalysisRan, true);

  const result = finishAgentTurn(state, "Brief 已记下。");
  assert.equal(result.draft, null);
  assert.deepEqual(result.brief, state.campaign.brief);
  assert.deepEqual(result.briefApplied, ["objective", "audience", "theme", "channels"]);
});

test("1811-only tools reject a parent campaign with no child and keep facts unchanged", () => {
  const state = createAgentState(parentRequestFor("帮我策划一场新品发布活动"));
  const before = structuredClone(state.campaign);

  for (const name of ["extract_campaign_facts", "analyze_campaign_state", "generate_ics1811_sheet"] as const) {
    const outcome = runAgentTool(state, name, name === "extract_campaign_facts" ? { facts: [{ key: "dates", quote: "十月" }] } : {});
    assert.equal(outcome.isError, true, name);
    assert.match(outcome.text, /不需要 1811|没有 1811/);
  }
  assert.deepEqual(state.campaign, before, "被拒的子流程工具不能改父层事实");
  assert.equal(state.draft, null);
});

test("communication copy needs a ready Brief, rejects invented claims, then stores a multi-channel parent artifact", () => {
  const briefText = "目标是提升新品认知，面向年轻情侣，主题是福启新章，通过门店和微信发布";

  // Brief 还没齐就起草传播方案，等于让模型对着空草稿编，拒绝掉。
  const bare = createAgentState(parentRequestFor("想做个国庆活动"));
  const tooEarly = runAgentTool(bare, "draft_promo_copy", {
    concept: { headline: "国庆臻选", subheadline: "到店探索", coreMessage: "为你呈现新品" },
    channelOutputs: [{ channel: "store", format: "海报", copy: "国庆臻选", cta: "到店了解" }],
    visualDirection: "红金留白",
  }, PROMO_CONTEXT);
  assert.equal(tooEarly.isError, true, "Brief 核心字段不齐时不能起草传播方案");

  const ready = createAgentState(parentRequestFor(briefText));
  runAgentTool(ready, "update_campaign_brief", {
    writes: [
      { key: "objective", quote: "提升新品认知" },
      { key: "audience", quote: "年轻情侣" },
      { key: "theme", quote: "福启新章" },
      { key: "channels", quote: "门店和微信" },
    ],
  });

  const invented = runAgentTool(ready, "draft_promo_copy", {
    concept: { headline: "福启新章", subheadline: "限时7天", coreMessage: "年轻情侣到店即享好礼" },
    channelOutputs: [{ channel: "social", format: "帖子", copy: "限时7天", cta: "立即领取" }],
    visualDirection: "红金留白",
  }, PROMO_CONTEXT);
  assert.equal(invented.isError, true, "未确认的数字、权益和渠道都不能落入传播方案");
  assert.equal(ready.campaign.communication, null);

  const ok = runAgentTool(ready, "draft_promo_copy", {
    concept: {
      headline: "福启新章",
      subheadline: "让心意在此刻相遇",
      coreMessage: "以新品表达年轻情侣的珍贵心意",
    },
    channelOutputs: [
      { channel: "store", format: "门店海报", copy: "福启新章，让心意在此刻相遇", cta: "欢迎到店了解" },
      { channel: "wechat", format: "微信推文", copy: "以新品表达年轻情侣的珍贵心意", cta: "查看活动详情" },
    ],
    visualDirection: "以红金为主色，保留珠宝质感和充足留白",
  }, PROMO_CONTEXT);
  assert.equal(ok.isError, undefined);
  const communication = ready.campaign.communication as CommunicationCreative | null;
  assert.equal(communication?.concept.headline, "福启新章");
  assert.deepEqual(communication?.channelOutputs.map((item) => item.channel), ["store", "wechat"]);
  assert.equal(communication?.source, "ai");
  assert.equal(ready.draft, null, "品牌传播活动不应为了生成文案伪造 1811 子流程");
});

test("promo copy requires the same-turn guide without mutating state", () => {
  const t1 = EXAMPLES[0];
  const state = createAgentState({
    ...requestFor(t1.first),
    draft: applyFactWrites(createEmptyDraft("promo-gate", t1.first), t1.firstWrites, { text: t1.first, today: TODAY }).draft,
  });
  const before = structuredClone(state);

  const blocked = runAgentTool(state, "draft_promo_copy", {
    concept: { headline: "黄金克减季", subheadline: "到店了解", coreMessage: "一般足金类每克立减15元" },
    channelOutputs: [{ channel: "store", format: "海报", copy: "一般足金类每克立减15元", cta: "到店了解" }],
    visualDirection: "红金视觉",
  });

  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /先加载 promo-copy-guide/);
  assert.deepEqual(state, before);
  assert.equal(safeToolSummary("draft_promo_copy", blocked, state), "传播方案尚未生成，Agent 会先加载规则或修正内容");
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
