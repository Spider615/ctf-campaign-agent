import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../app/lib/agent/prompt.ts";
import type { AgentRequest, AgentResult } from "../app/lib/agent/protocol.ts";
import { createAgentState, finishAgentTurn, runAgentTool, type AgentToolName } from "../app/lib/agent/tools.ts";
import { answerToOps, parseAnswer } from "../app/lib/campaign/answers.ts";
import { applyClarifyAnswers, buildClarifyQuestions } from "../app/lib/campaign/clarify.ts";
import { dateEvidenced, numberAppearsInText } from "../app/lib/campaign/evidence.ts";
import { summarizeChanges } from "../app/lib/campaign/messages.ts";
import { applyPatch } from "../app/lib/campaign/patcher.ts";
import { buildIcsDrafts } from "../app/lib/campaign/split-orders.ts";
import { missingFields, noIcsOrders } from "../app/lib/campaign/topics.ts";
import { validateDraft } from "../app/lib/campaign/validator.ts";
import { createEmptyDraft, deriveDraft, EXAMPLE_INTERPRETATION, EXAMPLE_TEXT, mergeInterpretation } from "../app/lib/campaign/workspace-state.ts";
import { guardOps } from "../app/lib/server/ai-schemas.ts";
import { createMemoryStore } from "../app/lib/server/session-store.ts";
import { createSession, runTurn, type Snapshot, type TurnDeps } from "../app/lib/server/turns.ts";

type Step = [AgentToolName, Record<string, unknown>?];
type Script = { steps?: Step[]; reply?: string | null };

// 假的 Agent 服务：按脚本调用真实的工具，模拟模型在一轮里做的事。
function runScript(script: Script, request: AgentRequest): AgentResult {
  const state = createAgentState(request);
  for (const [name, input] of script.steps ?? []) runAgentTool(state, name, input);
  return finishAgentTurn(state, script.reply === undefined ? "好的" : script.reply);
}

function deps(scripts: Array<Script | Error> = []): TurnDeps & { calls: () => number; requests: AgentRequest[] } {
  let counter = 0;
  let tick = 0;
  const requests: AgentRequest[] = [];
  return {
    store: createMemoryStore(),
    today: "2026-09-15",
    newId: () => `id-${++counter}`,
    now: () => new Date(Date.UTC(2026, 8, 15, 8, 0, tick++)).toISOString(),
    runAgent: async (request) => {
      requests.push(structuredClone(request));
      const next = scripts.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("unexpected agent call");
      return runScript(next, request);
    },
    calls: () => requests.length,
    requests,
  };
}

const COPY = { externalName: "母亲节金饰心意", icsName: "母亲节金饰礼遇", content: "华东区线下黄金类满 3000 减 300。", slogan: "把心意戴在身边" };
const PLAN: Script = { steps: [["write_plan", COPY]], reply: "方案生成好了。" };
const STACKING_EDIT: Script = { steps: [["update_fields", { changes: [{ path: "/offer/stacking", value: "否" }] }]], reply: "记下了。" };
const MISSING_KEYS = ["stacking", "markets", "dates", "membership", "rates", "paymentRestricted"];
const FULL_ANSWERS = {
  stacking: { choice: "否" },
  markets: { choices: ["内地"] },
  dates: { startDate: "2027-05-03", endDate: "2027-05-09" },
  membership: { choice: "不限" },
  rates: { concessionRate: 0.12, collectionRate: 0.98 },
  paymentRestricted: { choice: "false" },
};

const exampleDraft = () => mergeInterpretation(EXAMPLE_TEXT, EXAMPLE_INTERPRETATION);
const lastAgent = (snapshot: Snapshot) => [...snapshot.messages].reverse().find((message) => message.role === "assistant")!.content;
const lastOfKind = (snapshot: Snapshot, kind: string) => [...snapshot.messages].reverse().find((message) => message.content.kind === kind)?.content;
const submit = (snapshot: Snapshot, d: TurnDeps, answers: Record<string, unknown>) =>
  runTurn(snapshot.session.id, { type: "clarify_submit", answers, expectedSeq: snapshot.latest.seq }, d);
const say = (snapshot: Snapshot, d: TurnDeps, text: string) =>
  runTurn(snapshot.session.id, { type: "text", text, expectedSeq: snapshot.latest.seq }, d);
const interpret = (snapshot: Snapshot, d: TurnDeps) =>
  runTurn(snapshot.session.id, { type: "interpret", expectedSeq: snapshot.latest.seq }, d);
const agentRequest = (overrides: Partial<AgentRequest> = {}): AgentRequest => ({
  today: "2026-09-15",
  draft: exampleDraft(),
  history: [],
  trigger: { kind: "user_message", text: "不能叠加" },
  openCard: null,
  planIsCurrent: false,
  canUndo: true,
  ...overrides,
});

test("number evidence matches whole numbers and only scales rates", () => {
  assert.equal(numberAppearsInText(0.12, "让扣点 12 个点", true), true);
  assert.equal(numberAppearsInText(0.85, "打85折", true), true);
  assert.equal(numberAppearsInText(3000, "满3,000减300"), true);
  assert.equal(numberAppearsInText(30, "满3000减300"), false);
  assert.equal(numberAppearsInText(50, "满5000减500"), false);
  assert.equal(dateEvidenced("2026-05-10", "5月4号到10号"), true);
  assert.equal(dateEvidenced("2026-10-01", "国庆全国线上满 1000 减 100"), false);
  const sentence = "顾客下单才算，满 2000 减 200，12 月 30 日到 1 月 3 日";
  assert.equal(numberAppearsInText(200, sentence), true, "分句的中文逗号不能把前后两个数字粘在一起");
  assert.equal(dateEvidenced("2026-12-30", sentence), true);
  assert.equal(numberAppearsInText(1000000, "满1，000，000"), true);
});

test("example interpretation keeps only what the sentence established", () => {
  const draft = exampleDraft();
  assert.equal(draft.intent.customerAction.provenance, "user");
  assert.equal(draft.offer.mechanism.provenance, "user");
  assert.equal(draft.scope.markets.suggested, true);
  assert.equal(draft.intent.occasion.provenance, "ai");
  assert.deepEqual(draft.unresolved, ["区域编码需在 1811 生产界面确认"]);
  assert.deepEqual(missingFields(draft), MISSING_KEYS);
});

test("clarify questions keep required gaps even when nothing extra is asked", () => {
  const draft = exampleDraft();
  const keys = buildClarifyQuestions(draft, [], { segments: [], series: [] }).map((question) => question.key);
  assert.deepEqual(keys, MISSING_KEYS);

  const withModel = buildClarifyQuestions(draft, ["series", "customerAction", "segments"], { segments: ["为母亲选礼的人"], series: ["足金手镯"] });
  assert.deepEqual(withModel.find((question) => question.key === "series")?.options, ["足金手镯"]);
  assert.equal(withModel.some((question) => question.key === "customerAction"), false, "用户已明确说过的项不再问");
  assert.equal(buildClarifyQuestions(draft, [], { segments: [], series: [] }, ["customerAction"]).some((question) => question.key === "customerAction"), true, "confirm 的项照样问");
});

test("visibility-only campaigns drop offer questions", () => {
  let draft = createEmptyDraft();
  draft = deriveDraft(applyPatch(draft, answerToOps(parseAnswer("action", { customerAction: "只看到", occasion: "线下场" }, draft), draft)));
  assert.equal(noIcsOrders(draft), true);
  const keys = buildClarifyQuestions(draft, ["mechanism", "rates"], { segments: [], series: [] }).map((question) => question.key);
  for (const key of ["mechanism", "tier", "stacking", "markets", "channels", "rates", "paymentRestricted"]) {
    assert.equal(keys.includes(key as never), false, key);
  }
  assert.equal(validateDraft(draft, buildIcsDrafts(draft)).some((issue) => issue.ruleId === "R13"), false);
});

test("clarify answers map choices, custom membership and series without the model", () => {
  const draft = exampleDraft();
  const result = applyClarifyAnswers(
    {
      ...FULL_ANSWERS,
      membership: { custom: "中高等级" },
      channels: { choices: ["线下"], custom: "天猫旗舰店" },
      notAsked: { choice: "x" },
    },
    draft,
    ["stacking", "markets", "dates", "membership", "rates", "paymentRestricted", "channels"],
  );
  const next = deriveDraft(result.draft);
  assert.equal(next.offer.stacking.value, "否");
  assert.equal(next.audience.membership.value, "限");
  assert.equal(next.audience.membershipDescription, "中高等级");
  assert.equal(next.operations.paymentRestricted.provenance, "user");
  assert.deepEqual(missingFields(next), []);
  assert.deepEqual(result.customs.map((item) => item.text), ["已选 线下；其他：天猫旗舰店"]);
  assert.deepEqual(result.ignored, []);
});

test("change summary groups provenance-only confirmations", () => {
  const draft = exampleDraft();
  const next = applyPatch(draft, answerToOps(parseAnswer("scope", { markets: ["内地"] }, draft), draft));
  assert.deepEqual(summarizeChanges(draft, next), [{ label: "确认覆盖市场", before: "内地", after: "内地" }]);
});

test("field guard keeps direct answers and drops unsupported facts", () => {
  const guard = guardOps(
    [
      { op: "replace", path: "/offer/stacking", value: "否" },
      { op: "replace", path: "/scope/channels", value: ["线上"] },
      { op: "replace", path: "/offer/tiers/0/amountOff", value: 500 },
    ],
    { draft: exampleDraft(), userText: "不行", openFields: ["stacking"] },
  );
  assert.deepEqual(guard.ops.map((op) => op.path), ["/offer/stacking"]);
  assert.ok(guard.dropped.includes("渠道"));
});

test("trusted custom fields skip keyword evidence but dates never do", () => {
  const guard = guardOps(
    [
      { op: "replace", path: "/scope/channels", value: ["线下", "线上"] },
      { op: "replace", path: "/schedule/batches/0/startDate", value: "2026-09-25" },
    ],
    { draft: exampleDraft(), userText: "渠道：已选 线下；其他：天猫旗舰店", openFields: [], trustedFields: ["channels", "dates"] },
  );
  assert.deepEqual(guard.ops.map((op) => op.path), ["/scope/channels"]);
});

test("update_fields writes evidenced facts, drops guesses and leaves copy to write_plan", () => {
  const state = createAgentState(agentRequest());
  const result = JSON.parse(runAgentTool(state, "update_fields", {
    changes: [
      { path: "/offer/stacking", value: "否" },
      { path: "/operations/concessionRate", value: 0.12 },
      { path: "/brief/externalName", value: "随便起个名" },
    ],
  }).text);
  assert.equal(state.draft.offer.stacking.value, "否");
  assert.equal(state.draft.operations.concessionRate.value, null);
  assert.equal(state.draft.brief.externalName, "");
  assert.ok(result.dropped.some((item: string) => item.startsWith("让扣点")));
  assert.ok(result.note);
  assert.equal(result.status.missing.includes("能否叠加"), false);
});

test("tier leaves for a tier that does not exist yet become one new tier", () => {
  const state = createAgentState(agentRequest({ draft: createEmptyDraft(), trigger: { kind: "user_message", text: "满 2000 减 200" } }));
  runAgentTool(state, "update_fields", {
    changes: [
      { path: "/offer/mechanism", value: "门槛型" },
      { path: "/offer/tiers/0/thresholdAmount", value: 2000 },
      { path: "/offer/tiers/0/amountOff", value: 200 },
    ],
  });
  assert.equal(state.draft.offer.tiers.length, 1);
  assert.equal(state.draft.offer.tiers[0].thresholdAmount, 2000);
  assert.equal(state.draft.offer.tiers[0].amountOff, 200);
});

test("whole-tier writes are normalized: zeros mean empty and new tiers follow the existing ones", () => {
  const state = createAgentState(agentRequest({ draft: createEmptyDraft(), trigger: { kind: "user_message", text: "满 2000 减 200" } }));
  runAgentTool(state, "update_fields", {
    changes: [
      { path: "/offer/mechanism", value: "门槛型" },
      { op: "replace", path: "/offer/tiers/1", value: { thresholdAmount: "2000", discountRate: 0, amountOff: 200 } },
    ],
  });
  const tiers = state.draft.offer.tiers;
  assert.equal(tiers.length, 1);
  assert.deepEqual([tiers[0].thresholdAmount, tiers[0].discountRate, tiers[0].amountOff], [2000, null, 200]);
});

test("ask_user skips a new card when the open card already covers the required items", () => {
  const draft = exampleDraft();
  const open = buildClarifyQuestions(draft, [], { segments: [], series: [] }).map((question) => question.key);
  const state = createAgentState(agentRequest({ draft, openCard: open, trigger: { kind: "user_message", text: "可以" } }));
  runAgentTool(state, "ask_user", { keys: ["series"], series: ["足金手镯"] });
  assert.equal(state.card, null);
});

test("conflicting action and offer must be confirmed before a plan is written", () => {
  const state = createAgentState(agentRequest({ trigger: { kind: "user_message", text: "顾客参与互动就行" } }));
  const updated = JSON.parse(runAgentTool(state, "update_fields", { changes: [{ path: "/intent/customerAction", value: "参与互动" }] }).text);
  assert.equal(updated.status.conflicts.length, 1);
  assert.equal(runAgentTool(state, "write_plan", COPY).isError, true);
  assert.equal(state.generated, false);
  runAgentTool(state, "ask_user", { keys: [], confirm: ["customerAction", "mechanism"] });
  assert.ok(state.card?.questions.some((question) => question.key === "customerAction"));
});

test("write_plan refuses copy that breaks ICS rules and keeps the draft", () => {
  const state = createAgentState(agentRequest({ trigger: { kind: "generate_clicked" } }));
  const outcome = runAgentTool(state, "write_plan", { ...COPY, content: "满 3000 减 300 <限时>" });
  assert.equal(outcome.isError, true);
  assert.match(outcome.text, /特殊字符/);
  assert.equal(state.draft.brief.externalName, "");
  assert.equal(state.generated, false);
});

test("ask_user does not repeat a card the user has not submitted", () => {
  const draft = exampleDraft();
  const open = buildClarifyQuestions(draft, [], { segments: [], series: [] }).map((question) => question.key);
  const state = createAgentState(agentRequest({ draft, openCard: open, trigger: { kind: "user_message", text: "为什么还开不了单" } }));
  runAgentTool(state, "ask_user", { keys: [] });
  assert.equal(state.card, null);
});

test("undo only works on its own in a chat turn", () => {
  const busy = createAgentState(agentRequest());
  runAgentTool(busy, "update_fields", { changes: [{ path: "/offer/stacking", value: "否" }] });
  assert.equal(runAgentTool(busy, "undo_last_change").isError, true);
  const nothingToUndo = createAgentState(agentRequest({ canUndo: false }));
  assert.equal(runAgentTool(nothingToUndo, "undo_last_change").isError, true);
  assert.equal(nothingToUndo.undo, false);
});

test("agent prompts carry today's date, the draft state and this turn", () => {
  assert.match(buildAgentSystemPrompt("2026-09-15"), /今天是 2026-09-15/);
  const prompt = buildAgentUserPrompt(agentRequest({ openCard: ["stacking"] }));
  assert.match(prompt, /还差：能否叠加/);
  assert.match(prompt, /用户说：「不能叠加」/);
  assert.match(prompt, /用户还没提交的卡片：能否叠加/);
});

test("example session opens one clarify card without calling the agent", async () => {
  const d = deps();
  const snapshot = await createSession({ entryMode: "example" }, d);
  const card = lastAgent(snapshot);
  assert.deepEqual(card.kind === "agent_clarify" && card.questions.map((question) => question.key), MISSING_KEYS);
  assert.equal(snapshot.plan.openClarifyId, snapshot.messages.at(-1)?.id);
  assert.equal(snapshot.session.status, "collecting");
  assert.equal(d.calls(), 0);
});

test("submitting the card hands the answers to the agent, which writes the plan", async () => {
  const d = deps([PLAN]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, FULL_ANSWERS);
  const plan = lastAgent(snapshot);
  assert.equal(plan.kind, "agent_plan");
  assert.deepEqual(plan.kind === "agent_plan" && plan.missing, []);
  assert.equal(snapshot.session.status, "generated");
  assert.equal(snapshot.plan.openClarifyId, null);
  assert.equal(snapshot.latest.orders.length, 1);
  assert.equal(d.requests[0].trigger.kind, "card_submitted");
  assert.equal(d.requests[0].draft.offer.stacking.value, "否", "卡片选项先写进草稿再交给 Agent");
  await assert.rejects(() => submit(snapshot, d, {}), (error: { status?: number }) => error.status === 409);
});

test("an empty submission still generates, then asks only for what is missing", async () => {
  const d = deps([PLAN]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, {});
  const plan = lastOfKind(snapshot, "agent_plan");
  assert.deepEqual(plan?.kind === "agent_plan" && plan.missing, ["能否叠加", "覆盖市场", "起止日期", "会员限制", "让扣点与回款率", "支付方式限制"]);
  const card = lastAgent(snapshot);
  assert.deepEqual(card.kind === "agent_clarify" && card.questions.map((question) => question.key), MISSING_KEYS);
  assert.equal(snapshot.plan.openClarifyId, snapshot.messages.at(-1)?.id);
  assert.equal(snapshot.session.status, "generated");

  snapshot = await submit(snapshot, d, {});
  assert.equal(snapshot.plan.openClarifyId, null);
  assert.equal(lastAgent(snapshot).kind, "agent_text");
  assert.equal(d.calls(), 1, "什么都没补时不重复生成");
});

test("custom text in the card reaches the agent as trusted evidence", async () => {
  const d = deps([{ steps: [["update_fields", { changes: [{ path: "/scope/markets", value: ["内地", "港澳"] }] }], ["write_plan", COPY]] }]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, { markets: { choices: ["内地"], custom: "香港" }, channels: { custom: "卡片没问这项，应被忽略" } });
  assert.deepEqual(snapshot.latest.draft.scope.markets.value, ["内地", "港澳"]);
  assert.equal(snapshot.latest.draft.scope.markets.provenance, "user");
  assert.deepEqual(snapshot.latest.draft.scope.channels.value, ["线下"]);
  const trigger = d.requests[0].trigger;
  assert.deepEqual(trigger.kind === "card_submitted" && trigger.customs.map((item) => item.field), ["markets"]);
});

test("a sufficient first sentence lets the agent write the plan without a card", async () => {
  const text = "母亲节2027年5月3日到5月9日，全国线下内地黄金类满 3000 减 300，不叠加，不限会员，让扣点 0.1，回款率 0.95，支付方式不限";
  const changes = [
    { path: "/intent/occasion", value: "日历节点" },
    { path: "/intent/reason", value: "母亲节" },
    { path: "/intent/customerAction", value: "下单" },
    { path: "/offer/mechanism", value: "门槛型" },
    { op: "add", path: "/offer/tiers/0", value: { thresholdAmount: 3000, amountOff: 300 } },
    { path: "/offer/stacking", value: "否" },
    { path: "/scope/level", value: "全国" },
    { path: "/scope/markets", value: ["内地"] },
    { path: "/scope/channels", value: ["线下"] },
    { path: "/schedule/batches/0/startDate", value: "2027-05-03" },
    { path: "/schedule/batches/0/endDate", value: "2027-05-09" },
    { path: "/audience/segments", value: ["为母亲选礼的人"] },
    { path: "/products/categories", value: ["黄金类"] },
    { path: "/audience/membership", value: "不限" },
    { path: "/operations/concessionRate", value: 0.1 },
    { path: "/operations/collectionRate", value: 0.95 },
    { path: "/operations/paymentRestricted", value: false },
  ];
  const d = deps([{ steps: [["update_fields", { changes, title: "母亲节满减" }], ["write_plan", COPY]] }]);
  let snapshot = await createSession({ entryMode: "new", text }, d);
  snapshot = await interpret(snapshot, d);
  assert.deepEqual(snapshot.latest.draft.schedule.batches[0], { ...snapshot.latest.draft.schedule.batches[0], startDate: "2027-05-03", endDate: "2027-05-09" });
  assert.equal(snapshot.messages.some((message) => message.content.kind === "agent_clarify"), false);
  assert.equal(lastAgent(snapshot).kind, "agent_plan");
  assert.equal(snapshot.session.status, "generated");
  assert.equal(snapshot.plan.pendingInterpretation, false);
});

test("a new session is saved instantly and understood in a separate turn", async () => {
  const d = deps([{
    steps: [
      ["update_fields", { changes: [{ path: "/intent/occasion", value: "日历节点" }, { path: "/intent/reason", value: "国庆" }], title: "国庆活动" }],
      ["ask_user", { keys: ["segments"], segments: ["节日送礼人群"] }],
    ],
    reply: "先补几项信息，下面的卡片都可以不填。",
  }]);
  let snapshot = await createSession({ entryMode: "new", text: "帮我生成一个国庆节的营销活动" }, d);
  assert.equal(d.calls(), 0, "建会话不等 Agent");
  assert.deepEqual(snapshot.messages.map((message) => message.content.kind), ["user_text"]);
  assert.equal(snapshot.plan.pendingInterpretation, true);

  snapshot = await interpret(snapshot, d);
  const card = lastAgent(snapshot);
  assert.ok(card.kind === "agent_clarify" && card.questions.find((question) => question.key === "segments")?.options?.includes("节日送礼人群"));
  assert.equal(snapshot.plan.pendingInterpretation, false);
  assert.equal(snapshot.versions.at(-1)?.source, "理解需求");
  assert.equal(snapshot.session.title, "国庆活动");
  await assert.rejects(() => interpret(snapshot, d), (error: { status?: number }) => error.status === 409);
});

test("if the agent neither asks nor plans on the first turn, a card is still shown", async () => {
  const d = deps([{ reply: "我先看看。" }]);
  let snapshot = await createSession({ entryMode: "new", text: "帮我生成一个国庆节的营销活动" }, d);
  snapshot = await interpret(snapshot, d);
  assert.equal(lastAgent(snapshot).kind, "agent_clarify");
  assert.equal(snapshot.plan.pendingInterpretation, false);
});

test("a failed understanding stays pending and can be retried", async () => {
  const d = deps([new Error("连不上 Agent 服务"), { steps: [["ask_user", { keys: [] }]], reply: "先补几项。" }]);
  let snapshot = await createSession({ entryMode: "new", text: "帮我生成一个国庆节的营销活动" }, d);
  snapshot = await interpret(snapshot, d);
  const failed = lastAgent(snapshot);
  assert.deepEqual(failed.kind === "agent_error" && failed.retry, { type: "interpret" });
  assert.equal(snapshot.plan.pendingInterpretation, true);

  snapshot = await interpret(snapshot, d);
  assert.equal(lastAgent(snapshot).kind, "agent_clarify");
  assert.equal(snapshot.plan.pendingInterpretation, false);
});

test("agent failure after submit keeps the answers and offers retry", async () => {
  const d = deps([new Error("Agent 超时了，请重试")]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, { stacking: { choice: "否" } });
  const last = lastAgent(snapshot);
  assert.deepEqual(last.kind === "agent_error" && last.retry, { type: "generate" });
  assert.equal(snapshot.latest.draft.offer.stacking.value, "否");
  assert.equal(snapshot.plan.openClarifyId, null);
});

test("typing while the card is open updates the draft and keeps the card open", async () => {
  const d = deps([{
    steps: [["update_fields", { changes: [
      { path: "/schedule/batches/0/startDate", value: "2027-05-03" },
      { path: "/schedule/batches/0/endDate", value: "2027-05-09" },
    ] }]],
    reply: "日期记下了。",
  }]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  const cardId = snapshot.plan.openClarifyId;
  snapshot = await say(snapshot, d, "5月3日到5月9日");
  assert.equal(snapshot.latest.draft.schedule.batches[0].endDate, "2027-05-09");
  assert.equal(snapshot.plan.openClarifyId, cardId);
  assert.ok(lastOfKind(snapshot, "agent_change"));
  assert.ok(d.requests[0].openCard?.includes("dates"));
});

test("agent failure on a text turn keeps the user message and offers retry", async () => {
  const d = deps([new Error("连不上 Agent 服务")]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  const seq = snapshot.latest.seq;
  snapshot = await say(snapshot, d, "不能叠加");
  const last = lastAgent(snapshot);
  assert.deepEqual(last.kind === "agent_error" && last.retry, { type: "text", text: "不能叠加" });
  assert.equal(snapshot.latest.seq, seq);
});

test("the agent sees whether the plan is current and which card is still open", async () => {
  const d = deps([PLAN, { reply: "方案已经是最新的，还差几项，补在下面的卡片里。" }, STACKING_EDIT, { steps: [["write_plan", COPY]] }]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, {});
  const cardId = snapshot.plan.openClarifyId;

  snapshot = await say(snapshot, d, "可以");
  assert.equal(d.requests[1].planIsCurrent, true);
  assert.deepEqual(d.requests[1].openCard, MISSING_KEYS);
  assert.equal(snapshot.plan.openClarifyId, cardId);
  assert.equal(snapshot.messages.filter((message) => message.content.kind === "agent_plan").length, 1);

  snapshot = await say(snapshot, d, "不能叠加");
  assert.equal(snapshot.latest.draft.offer.stacking.value, "否");
  snapshot = await say(snapshot, d, "不用改，直接生成对应的活动吧");
  assert.equal(d.requests[3].planIsCurrent, false);
  assert.equal(snapshot.messages.at(-2)?.content.kind, "agent_plan");
  const card = lastAgent(snapshot);
  assert.equal(card.kind === "agent_clarify" && card.questions.some((question) => question.key === "stacking"), false);
});

test("an empty card after a chat edit still refreshes the plan", async () => {
  const d = deps([PLAN, STACKING_EDIT, PLAN]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, {});
  snapshot = await say(snapshot, d, "不能叠加");
  snapshot = await submit(snapshot, d, {});
  assert.equal(d.calls(), 3);
  assert.equal(d.requests[2].trigger.kind, "card_submitted");
  assert.ok(snapshot.messages.slice(-3).some((message) => message.content.kind === "agent_plan"));
});

test("a turn where the agent does nothing still gets an answer", async () => {
  const d = deps([PLAN, { reply: null }]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, {});
  snapshot = await say(snapshot, d, "嗯");
  const last = lastAgent(snapshot);
  assert.match(last.kind === "agent_text" ? last.text : "", /换个说法/);
});

test("saying undo in chat restores the previous version", async () => {
  const d = deps([PLAN, STACKING_EDIT, { steps: [["undo_last_change"]], reply: "撤销了。" }]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, {});
  const before = snapshot.latest.draft.offer.stacking;
  snapshot = await say(snapshot, d, "不能叠加");
  snapshot = await say(snapshot, d, "撤销");
  assert.deepEqual(snapshot.latest.draft.offer.stacking, before);
  const change = lastOfKind(snapshot, "agent_change");
  assert.equal(change?.kind === "agent_change" && change.title, "已撤销");
});
