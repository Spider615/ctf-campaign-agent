import assert from "node:assert/strict";
import test from "node:test";

import { answerToOps, parseAnswer } from "../app/lib/campaign/answers.ts";
import { applyClarifyAnswers, buildClarifyQuestions } from "../app/lib/campaign/clarify.ts";
import { dateEvidenced, numberAppearsInText } from "../app/lib/campaign/evidence.ts";
import { summarizeChanges } from "../app/lib/campaign/messages.ts";
import { applyPatch } from "../app/lib/campaign/patcher.ts";
import { buildIcsDrafts } from "../app/lib/campaign/split-orders.ts";
import { missingFields, noIcsOrders } from "../app/lib/campaign/topics.ts";
import { validateDraft } from "../app/lib/campaign/validator.ts";
import { createEmptyDraft, deriveDraft, EXAMPLE_INTERPRETATION, EXAMPLE_TEXT, mergeInterpretation } from "../app/lib/campaign/workspace-state.ts";
import { guardTextTurn } from "../app/lib/server/ai-schemas.ts";
import { parseClarification } from "../app/lib/server/clarify-schema.ts";
import { buildInterpretationPrompt, buildTextTurnSystemPrompt } from "../app/lib/server/prompts.ts";
import { createMemoryStore } from "../app/lib/server/session-store.ts";
import { createSession, runTurn, type Snapshot, type TurnDeps } from "../app/lib/server/turns.ts";

function deps(responses: Array<string | Error> = []): TurnDeps & { calls: () => number } {
  let calls = 0;
  let counter = 0;
  let tick = 0;
  return {
    store: createMemoryStore(),
    today: "2026-09-15",
    newId: () => `id-${++counter}`,
    now: () => new Date(Date.UTC(2026, 8, 15, 8, 0, tick++)).toISOString(),
    callModel: async () => {
      calls += 1;
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("unexpected model call");
      return next;
    },
    calls: () => calls,
  };
}

const COPY = JSON.stringify({ externalName: "母亲节金饰心意", icsName: "母亲节金饰礼遇", content: "华东区线下黄金类满 3000 减 300。", slogan: "把心意戴在身边" });
const lastAgent = (snapshot: Snapshot) => [...snapshot.messages].reverse().find((message) => message.role === "assistant")!.content;
const submit = (snapshot: Snapshot, d: TurnDeps, answers: Record<string, unknown>) =>
  runTurn(snapshot.session.id, { type: "clarify_submit", answers, expectedSeq: snapshot.latest.seq }, d);

test("number evidence matches whole numbers and only scales rates", () => {
  assert.equal(numberAppearsInText(0.12, "让扣点 12 个点", true), true);
  assert.equal(numberAppearsInText(0.85, "打85折", true), true);
  assert.equal(numberAppearsInText(3000, "满3,000减300"), true);
  assert.equal(numberAppearsInText(30, "满3000减300"), false);
  assert.equal(numberAppearsInText(50, "满5000减500"), false);
  assert.equal(dateEvidenced("2026-05-10", "5月4号到10号"), true);
  assert.equal(dateEvidenced("2026-10-01", "国庆全国线上满 1000 减 100"), false);
});

test("example interpretation keeps only what the sentence established", () => {
  const draft = mergeInterpretation(EXAMPLE_TEXT, EXAMPLE_INTERPRETATION);
  assert.equal(draft.intent.customerAction.provenance, "user");
  assert.equal(draft.offer.mechanism.provenance, "user");
  assert.equal(draft.scope.markets.suggested, true);
  assert.equal(draft.intent.occasion.provenance, "ai");
  assert.deepEqual(draft.unresolved, ["区域编码需在 1811 生产界面确认"]);
  assert.deepEqual(missingFields(draft), ["stacking", "markets", "dates", "membership", "rates", "paymentRestricted"]);
});

test("clarify questions keep required gaps even when the model says nothing is missing", () => {
  const draft = mergeInterpretation(EXAMPLE_TEXT, EXAMPLE_INTERPRETATION);
  const keys = buildClarifyQuestions(draft, [], { segments: [], series: [] }).map((question) => question.key);
  assert.deepEqual(keys, ["stacking", "markets", "dates", "membership", "rates", "paymentRestricted"]);

  const withModel = buildClarifyQuestions(draft, ["series", "customerAction", "segments"], { segments: ["为母亲选礼的人"], series: ["足金手镯"] });
  const seriesQuestion = withModel.find((question) => question.key === "series");
  assert.deepEqual(seriesQuestion?.options, ["足金手镯"]);
  assert.equal(withModel.some((question) => question.key === "customerAction"), false, "用户已明确说过的项不再问");
  assert.ok(withModel.find((question) => question.key === "segments")?.options?.includes("为母亲选礼的人"));
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
  const draft = mergeInterpretation(EXAMPLE_TEXT, EXAMPLE_INTERPRETATION);
  const result = applyClarifyAnswers(
    {
      stacking: { choice: "否" },
      markets: { choices: ["内地"] },
      dates: { startDate: "2027-05-03", endDate: "2027-05-09" },
      membership: { custom: "中高等级" },
      rates: { concessionRate: 0.12, collectionRate: 0.98 },
      paymentRestricted: { choice: "false" },
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

test("clarification parsing keeps only safe model options", () => {
  const parsed = parseClarification(
    JSON.stringify({ summary: "国庆", fields: {}, unresolved: [], sufficient: true, ask: ["dates", 3], options: { segments: ["25-35岁女性", "家庭赠礼客群"], series: ["足金手镯"] } }),
    "国庆做个活动",
  );
  assert.equal(parsed.sufficient, true);
  assert.deepEqual(parsed.ask, ["dates"]);
  assert.deepEqual(parsed.options.segments, ["家庭赠礼客群"]);
});

test("free-text guard keeps direct answers and drops unsupported facts", () => {
  const draft = mergeInterpretation(EXAMPLE_TEXT, EXAMPLE_INTERPRETATION);
  const guard = guardTextTurn(
    JSON.stringify({
      ops: [
        { op: "replace", path: "/offer/stacking", value: "否" },
        { op: "replace", path: "/scope/channels", value: ["线上"] },
        { op: "replace", path: "/offer/tiers/0/amountOff", value: 500 },
      ],
    }),
    { draft, userText: "不行", openFields: ["stacking"] },
  );
  assert.deepEqual(guard.ops.map((op) => op.path), ["/offer/stacking"]);
  assert.ok(guard.dropped.includes("渠道"));
});

test("trusted custom fields skip keyword evidence but dates never do", () => {
  const draft = mergeInterpretation(EXAMPLE_TEXT, EXAMPLE_INTERPRETATION);
  const guard = guardTextTurn(
    JSON.stringify({
      ops: [
        { op: "replace", path: "/scope/channels", value: ["线下", "线上"] },
        { op: "replace", path: "/schedule/batches/0/startDate", value: "2026-09-25" },
      ],
    }),
    { draft, userText: "渠道：已选 线下；其他：天猫旗舰店", openFields: [], trustedFields: ["channels", "dates"] },
  );
  assert.deepEqual(guard.ops.map((op) => op.path), ["/scope/channels"]);
});

test("prompts carry today's date and ask for clarification hints", () => {
  assert.match(buildInterpretationPrompt("2026-09-15"), /今天是 2026-09-15/);
  assert.match(buildInterpretationPrompt("2026-09-15"), /sufficient/);
  assert.match(buildTextTurnSystemPrompt({ today: "2026-09-15", openFields: [] }), /今天是 2026-09-15/);
});

test("change summary groups provenance-only confirmations", () => {
  const draft = mergeInterpretation(EXAMPLE_TEXT, EXAMPLE_INTERPRETATION);
  const next = applyPatch(draft, answerToOps(parseAnswer("scope", { markets: ["内地"] }, draft), draft));
  assert.deepEqual(summarizeChanges(draft, next), [{ label: "确认覆盖市场", before: "内地", after: "内地" }]);
});

test("example session opens one clarify card without calling the model", async () => {
  const d = deps();
  const snapshot = await createSession({ entryMode: "example" }, d);
  const card = lastAgent(snapshot);
  assert.equal(card.kind, "agent_clarify");
  assert.deepEqual(card.kind === "agent_clarify" && card.questions.map((question) => question.key), ["stacking", "markets", "dates", "membership", "rates", "paymentRestricted"]);
  assert.equal(snapshot.plan.openClarifyId, snapshot.messages.at(-1)?.id);
  assert.equal(snapshot.session.status, "collecting");
  assert.equal(d.calls(), 0);
});

test("submitting the card generates the plan in one model call", async () => {
  const d = deps([COPY]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, {
    stacking: { choice: "否" },
    markets: { choices: ["内地"] },
    dates: { startDate: "2027-05-03", endDate: "2027-05-09" },
    membership: { choice: "不限" },
    rates: { concessionRate: 0.12, collectionRate: 0.98 },
    paymentRestricted: { choice: "false" },
  });
  const plan = lastAgent(snapshot);
  assert.equal(plan.kind, "agent_plan");
  assert.deepEqual(plan.kind === "agent_plan" && plan.missing, []);
  assert.equal(snapshot.session.status, "generated");
  assert.equal(snapshot.plan.openClarifyId, null);
  assert.equal(snapshot.latest.orders.length, 1);
  assert.equal(snapshot.messages.at(-2)?.content.kind, "user_clarify_submit");
  assert.equal(d.calls(), 1);
  await assert.rejects(() => submit(snapshot, d, {}), (error: { status?: number }) => error.status === 409);
});

test("an empty submission still generates, then asks only for what is missing", async () => {
  const d = deps([COPY]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, {});
  const plan = snapshot.messages.find((message) => message.content.kind === "agent_plan")?.content;
  assert.deepEqual(plan?.kind === "agent_plan" && plan.missing, ["能否叠加", "覆盖市场", "起止日期", "会员限制", "让扣点与回款率", "支付方式限制"]);
  const card = lastAgent(snapshot);
  assert.equal(card.kind, "agent_clarify");
  assert.deepEqual(card.kind === "agent_clarify" && card.questions.map((question) => question.key), ["stacking", "markets", "dates", "membership", "rates", "paymentRestricted"]);
  assert.equal(snapshot.plan.openClarifyId, snapshot.messages.at(-1)?.id);
  assert.equal(snapshot.session.status, "generated");

  snapshot = await submit(snapshot, d, {});
  assert.equal(snapshot.plan.openClarifyId, null);
  assert.equal(lastAgent(snapshot).kind, "agent_text");
  assert.equal(d.calls(), 1, "什么都没补时不重复生成");
});

test("custom text in the card is parsed by the model before generating", async () => {
  // 示例里渠道已经说过，卡片问的是市场；「其他」里写香港，由模型落到固定取值「港澳」。
  const parse = JSON.stringify({ ops: [{ op: "replace", path: "/scope/markets", value: ["内地", "港澳"] }] });
  const d = deps([parse, COPY]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, { markets: { choices: ["内地"], custom: "香港" }, channels: { custom: "卡片没问这项，应被忽略" } });
  assert.deepEqual(snapshot.latest.draft.scope.markets.value, ["内地", "港澳"]);
  assert.equal(snapshot.latest.draft.scope.markets.provenance, "user");
  assert.deepEqual(snapshot.latest.draft.scope.channels.value, ["线下"]);
  assert.ok(snapshot.messages.some((message) => message.content.kind === "agent_plan"));
  assert.equal(d.calls(), 2);
});

const say = (snapshot: Snapshot, d: TurnDeps, text: string) =>
  runTurn(snapshot.session.id, { type: "text", text, expectedSeq: snapshot.latest.seq }, d);
const agentTexts = (snapshot: Snapshot, from: number) =>
  snapshot.messages.slice(from).flatMap((message) => (message.content.kind === "agent_text" ? [message.content.text] : []));
const STACKING_EDIT = JSON.stringify({ intent: "edit", ops: [{ op: "replace", path: "/offer/stacking", value: "否" }] });

test("saying ok after a plan with gaps explains what is missing instead of regenerating", async () => {
  const d = deps([COPY, JSON.stringify({ intent: "confirm", ops: [] })]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, {});
  const cardId = snapshot.plan.openClarifyId;
  const from = snapshot.messages.length;
  snapshot = await say(snapshot, d, "可以");
  assert.equal(d.calls(), 2, "文案已是最新，不重复生成");
  assert.match(agentTexts(snapshot, from).join(""), /还差：能否叠加、覆盖市场/);
  assert.equal(snapshot.plan.openClarifyId, cardId, "沿用已打开的缺项卡片");
});

test("asking to generate after a change regenerates and asks only for the rest", async () => {
  const d = deps([COPY, STACKING_EDIT, JSON.stringify({ intent: "generate" }), COPY]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, {});
  snapshot = await say(snapshot, d, "不能叠加");
  assert.equal(snapshot.latest.draft.offer.stacking.value, "否");
  snapshot = await say(snapshot, d, "不用改，直接生成对应的活动吧");
  assert.equal(d.calls(), 4);
  assert.equal(snapshot.messages.at(-2)?.content.kind, "agent_plan");
  const card = lastAgent(snapshot);
  assert.equal(card.kind, "agent_clarify");
  assert.equal(card.kind === "agent_clarify" && card.questions.some((question) => question.key === "stacking"), false);
});

test("submitting an empty card after a chat edit still refreshes the plan", async () => {
  const d = deps([COPY, STACKING_EDIT, COPY]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, {});
  snapshot = await say(snapshot, d, "不能叠加");
  snapshot = await submit(snapshot, d, {});
  assert.equal(d.calls(), 3);
  assert.ok(snapshot.messages.slice(-2).some((message) => message.content.kind === "agent_plan"));
});

test("an unclear message gets the next step instead of a canned reply", async () => {
  const d = deps([COPY, JSON.stringify({ intent: "other", ops: [] })]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, {});
  const from = snapshot.messages.length;
  snapshot = await say(snapshot, d, "嗯");
  const text = agentTexts(snapshot, from).join("");
  assert.match(text, /现在还差：能否叠加/);
  assert.doesNotMatch(text, /没对上/);
});

test("saying undo in chat restores the previous version", async () => {
  const d = deps([COPY, STACKING_EDIT, JSON.stringify({ intent: "undo" })]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, {});
  const before = snapshot.latest.draft.offer.stacking;
  snapshot = await say(snapshot, d, "不能叠加");
  snapshot = await say(snapshot, d, "撤销");
  assert.deepEqual(snapshot.latest.draft.offer.stacking, before);
  const change = lastAgent(snapshot);
  assert.equal(change.kind === "agent_change" && change.title, "已撤销");
});

test("a sufficient first sentence skips the card and generates directly", async () => {
  const text = "母亲节2027年5月3日到5月9日，全国线下内地黄金类满 3000 减 300，不叠加，不限会员，让扣点 0.1，回款率 0.95，支付方式不限";
  const clarification = JSON.stringify({
    summary: "母亲节满减",
    fields: {
      occasion: "日历节点", reason: "母亲节", customerAction: "下单", productCategories: ["黄金类"], offerMechanism: "门槛型",
      thresholdAmount: 3000, amountOff: 300, scopeLevel: "全国", markets: ["内地"], channels: ["线下"], stacking: "否",
      membership: "不限", concessionRate: 0.1, collectionRate: 0.95, paymentRestricted: false, audience: ["家庭赠礼客群"],
      startDate: "2027-05-03", endDate: "2027-05-09",
    },
    unresolved: [],
    sufficient: true,
    ask: [],
    options: {},
  });
  const d = deps([clarification, COPY]);
  let snapshot = await createSession({ entryMode: "new", text }, d);
  snapshot = await runTurn(snapshot.session.id, { type: "interpret", expectedSeq: snapshot.latest.seq }, d);
  assert.equal(snapshot.messages.some((message) => message.content.kind === "agent_clarify"), false);
  assert.equal(lastAgent(snapshot).kind, "agent_plan");
  assert.equal(snapshot.session.status, "generated");
  assert.equal(snapshot.plan.pendingInterpretation, false);
  assert.equal(d.calls(), 2);
});

test("a new session is saved instantly and understood in a separate turn", async () => {
  const clarification = JSON.stringify({ summary: "国庆活动", fields: { occasion: "日历节点", reason: "国庆" }, unresolved: [], sufficient: false, ask: [], options: { segments: ["节日送礼人群"] } });
  const d = deps([clarification]);
  let snapshot = await createSession({ entryMode: "new", text: "帮我生成一个国庆节的营销活动" }, d);
  assert.equal(d.calls(), 0, "建会话不等模型");
  assert.deepEqual(snapshot.messages.map((message) => message.content.kind), ["user_text"]);
  assert.equal(snapshot.plan.pendingInterpretation, true);

  snapshot = await runTurn(snapshot.session.id, { type: "interpret", expectedSeq: snapshot.latest.seq }, d);
  assert.equal(lastAgent(snapshot).kind, "agent_clarify");
  assert.equal(snapshot.plan.pendingInterpretation, false);
  assert.equal(snapshot.versions.at(-1)?.source, "理解需求");
  assert.equal(snapshot.session.title, "国庆活动");
  await assert.rejects(
    () => runTurn(snapshot.session.id, { type: "interpret", expectedSeq: snapshot.latest.seq }, d),
    (error: { status?: number }) => error.status === 409,
  );
});

test("a failed understanding stays pending and can be retried", async () => {
  const clarification = JSON.stringify({ summary: "国庆活动", fields: { reason: "国庆" }, unresolved: [], sufficient: false, ask: [], options: {} });
  const d = deps([new Error("模型服务暂时不可用（网络错误）"), clarification]);
  let snapshot = await createSession({ entryMode: "new", text: "帮我生成一个国庆节的营销活动" }, d);
  snapshot = await runTurn(snapshot.session.id, { type: "interpret", expectedSeq: snapshot.latest.seq }, d);
  const failed = lastAgent(snapshot);
  assert.deepEqual(failed.kind === "agent_error" && failed.retry, { type: "interpret" });
  assert.equal(snapshot.plan.pendingInterpretation, true);

  snapshot = await runTurn(snapshot.session.id, { type: "interpret", expectedSeq: snapshot.latest.seq }, d);
  assert.equal(lastAgent(snapshot).kind, "agent_clarify");
  assert.equal(snapshot.plan.pendingInterpretation, false);
});

test("generation failure after submit keeps the answers and offers retry", async () => {
  const d = deps([new Error("模型服务暂时不可用（网络错误）")]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await submit(snapshot, d, { stacking: { choice: "否" } });
  const last = lastAgent(snapshot);
  assert.equal(last.kind, "agent_error");
  assert.deepEqual(last.kind === "agent_error" && last.retry, { type: "generate" });
  assert.equal(snapshot.latest.draft.offer.stacking.value, "否");
  assert.equal(snapshot.plan.openClarifyId, null);
});

test("typing while the card is open updates the draft and keeps the card open", async () => {
  const ops = JSON.stringify({ ops: [
    { op: "replace", path: "/schedule/batches/0/startDate", value: "2027-05-03" },
    { op: "replace", path: "/schedule/batches/0/endDate", value: "2027-05-09" },
  ] });
  const d = deps([ops]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  const cardId = snapshot.plan.openClarifyId;
  snapshot = await runTurn(snapshot.session.id, { type: "text", text: "5月3日到5月9日", expectedSeq: snapshot.latest.seq }, d);
  assert.equal(snapshot.latest.draft.schedule.batches[0].endDate, "2027-05-09");
  assert.equal(snapshot.plan.openClarifyId, cardId);
  assert.equal(lastAgent(snapshot).kind, "agent_change");
});

test("model failure on a text turn keeps the user message and offers retry", async () => {
  const d = deps([new Error("模型服务暂时不可用（网络错误）")]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  const seq = snapshot.latest.seq;
  snapshot = await runTurn(snapshot.session.id, { type: "text", text: "不能叠加", expectedSeq: seq }, d);
  const last = lastAgent(snapshot);
  assert.equal(last.kind, "agent_error");
  assert.deepEqual(last.kind === "agent_error" && last.retry, { type: "text", text: "不能叠加" });
  assert.equal(snapshot.latest.seq, seq);
});
