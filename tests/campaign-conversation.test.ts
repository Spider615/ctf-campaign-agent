import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRequest, AgentResult } from "../app/lib/agent/protocol.ts";
import { createAgentState, finishAgentTurn, runAgentTool } from "../app/lib/agent/tools.ts";
import { createMemoryStore } from "../app/lib/server/session-store.ts";
import { createSession, runTurn, type TurnDeps } from "../app/lib/server/turns.ts";

const TODAY = "2026-09-17";

function dependencies(): TurnDeps & { requests: AgentRequest[] } {
  let id = 0;
  let tick = 0;
  const requests: AgentRequest[] = [];
  return {
    store: createMemoryStore(),
    today: TODAY,
    newId: () => `campaign-${++id}`,
    now: () => new Date(Date.UTC(2026, 8, 17, 8, 0, tick++)).toISOString(),
    requests,
    runAgent: async (request): Promise<AgentResult> => {
      requests.push(structuredClone(request));
      const state = createAgentState(request);
      runAgentTool(state, "update_campaign_brief", {
        writes: [
          { key: "objective", quote: "目标是吸引年轻新客" },
          { key: "audience", quote: "面向刚工作的年轻人" },
          { key: "theme", quote: "传承系列新品发布" },
          { key: "channels", quote: "小红书和微信" },
        ],
      });
      return finishAgentTurn(state, "Brief 已整理，接下来可以并行准备传播内容和人工上线检查。");
    },
  };
}

test("brand-only sessions use the harness without inventing an 1811 child", async () => {
  const deps = dependencies();
  const text = "为传承系列新品发布做活动，目标是吸引年轻新客，面向刚工作的年轻人，走小红书和微信";
  let snapshot = await createSession({ entryMode: "new", text }, deps);

  assert.equal(snapshot.latest.campaign.schema, "campaign/v1");
  assert.equal(snapshot.latest.draft, null);
  assert.equal(snapshot.latest.fill, null);
  assert.equal(snapshot.latest.sheet, null);
  assert.deepEqual(snapshot.workspace.routing.tracks, ["brand_launch"]);

  snapshot = await runTurn(snapshot.session.id, { type: "interpret", expectedSeq: snapshot.latest.seq }, deps);

  assert.equal(deps.requests.length, 1, "品牌活动也必须经过真实 Agent 回合");
  assert.equal(deps.requests[0].draft, null);
  assert.equal(deps.requests[0].campaign?.schema, "campaign/v1");
  assert.equal(snapshot.latest.campaign.brief.objective?.quote, "目标是吸引年轻新客");
  assert.equal(snapshot.latest.campaign.brief.channels?.value.join("、"), "wechat、social");
  assert.equal(snapshot.latest.draft, null);
  assert.equal(snapshot.messages.some((message) => message.content.kind === "agent_fill_sheet"), false);
  assert.equal(snapshot.flow.phase, "collecting", "无 1811 子单的父活动不能进入交易优惠专用的 ready 阶段");
  assert.equal(snapshot.workspace.brief.status, "ready");
  assert.equal(snapshot.session.status, "preparing");
  const trace = [...snapshot.messages].reverse().find((message) => message.content.kind === "agent_tool_trace");
  assert.ok(trace?.content.kind === "agent_tool_trace");
  assert.deepEqual(trace.content.trace.steps.map((step) => step.tool), ["analyze_campaign_plan"]);
});

test("an integrated launch keeps one optional 1811 child alongside the parent tracks", async () => {
  const deps = dependencies();
  const snapshot = await createSession({
    entryMode: "new",
    text: "传承系列新品发布，同时做钻石9折优惠，在门店和微信宣传",
  }, deps);

  assert.ok(snapshot.latest.draft, "成交优惠信号应创建一个 1811 子草稿");
  assert.deepEqual(snapshot.workspace.routing.tracks, ["brand_launch", "transaction_offer"]);
  assert.equal(snapshot.latest.campaign.ics1811?.id, snapshot.latest.draft?.id);
});

test("a later transaction request dynamically creates the optional 1811 child before the agent runs", async () => {
  const deps = dependencies();
  let snapshot = await createSession({ entryMode: "new", text: "先策划一场传承系列新品发布活动" }, deps);
  assert.equal(snapshot.latest.draft, null);

  snapshot = await runTurn(snapshot.session.id, {
    type: "text",
    text: "再加上钻石9折的成交优惠",
    expectedSeq: snapshot.latest.seq,
  }, deps);

  assert.ok(deps.requests[0].draft, "Agent 运行前应已经建立 1811 子草稿");
  assert.ok(snapshot.latest.draft);
  assert.deepEqual(snapshot.workspace.routing.tracks, ["brand_launch", "transaction_offer"]);
});

test("a ready brand Brief persists and renders a reviewable communication plan without an 1811 sheet", async () => {
  const deps = dependencies();
  const text = "为传承系列新品发布做活动，目标是吸引年轻新客，面向刚工作的年轻人，走小红书和微信";
  let snapshot = await createSession({ entryMode: "new", text }, deps);
  snapshot = await runTurn(snapshot.session.id, { type: "interpret", expectedSeq: snapshot.latest.seq }, deps);

  deps.runAgent = async (request): Promise<AgentResult> => {
    const state = createAgentState(request);
    const outcome = runAgentTool(state, "draft_promo_copy", {
      concept: {
        headline: "传承新章",
        subheadline: "让东方美学与年轻心意相遇",
        coreMessage: "以传承系列新品，回应刚工作的年轻人对日常珠宝表达的期待",
      },
      channelOutputs: [
        { channel: "wechat", format: "微信推文", copy: "传承新章，让东方美学走进年轻日常。", cta: "查看系列故事" },
        { channel: "social", format: "小红书图文", copy: "把东方美学戴进每一次出发。", cta: "探索传承系列" },
      ],
      visualDirection: "以周大福红与暖金构建克制留白，突出珠宝细节与年轻都市日常",
    }, { loadedSkills: new Set(["promo-copy-guide"]) });
    assert.equal(outcome.isError, undefined);
    return finishAgentTurn(state, "传播方案已起草，已按微信和小红书分别组织内容，仍需人工审核。");
  };

  snapshot = await runTurn(snapshot.session.id, {
    type: "text",
    text: "请基于当前活动生成一份对外营销宣传内容",
    expectedSeq: snapshot.latest.seq,
  }, deps);

  assert.equal(snapshot.latest.campaign.communication?.concept.headline, "传承新章");
  assert.equal(snapshot.latest.communication?.status, "needs_review");
  assert.equal(snapshot.latest.communication?.facts.audience, "面向刚工作的年轻人");
  assert.deepEqual(snapshot.latest.communication?.channelOutputs.map((item) => item.channel), ["wechat", "social"]);
  assert.equal(snapshot.latest.sheet, null);
  assert.equal(snapshot.latest.draft, null);
  assert.equal(snapshot.session.status, "needs_confirmation");
});
