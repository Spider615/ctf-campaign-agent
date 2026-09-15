import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../app/lib/agent/prompt.ts";
import type { AgentRequest, AgentResult } from "../app/lib/agent/protocol.ts";
import { createAgentState, finishAgentTurn, runAgentTool, type AgentToolName } from "../app/lib/agent/tools.ts";
import { dateEvidenced, numberAppearsInText } from "../app/lib/campaign/evidence.ts";
import { EXAMPLES } from "../app/lib/campaign/ics1811/examples.ts";
import { applyFactWrites, createEmptyDraft, type FactWrite } from "../app/lib/campaign/ics1811/facts.ts";
import type { StoredMessage } from "../app/lib/campaign/ics1811/messages.ts";
import { createMemoryStore } from "../app/lib/server/session-store.ts";
import { createSession, runTurn, type Snapshot, type TurnDeps } from "../app/lib/server/turns.ts";

const TODAY = "2026-09-16";
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
    today: TODAY,
    newId: () => `id-${++counter}`,
    now: () => new Date(Date.UTC(2026, 8, 16, 8, 0, tick++)).toISOString(),
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

const example = (id: string) => EXAMPLES.find((item) => item.id === id)!;
const record = (writes: FactWrite[]): Script => ({ steps: [["update_fields", { facts: writes }]], reply: "记下了。" });
const lastAgent = (snapshot: Snapshot) => [...snapshot.messages].reverse().find((message) => message.role === "assistant")!.content;
const lastOfKind = <K extends StoredMessage["kind"]>(snapshot: Snapshot, kind: K) =>
  [...snapshot.messages].reverse().find((message) => message.content.kind === kind)?.content as Extract<StoredMessage, { kind: K }> | undefined;
const cardIds = (snapshot: Snapshot) => lastOfKind(snapshot, "agent_round_card")?.questions.map((question) => question.id);

const turn = (snapshot: Snapshot, d: TurnDeps, body: Record<string, unknown>) => runTurn(snapshot.session.id, { ...body, expectedSeq: snapshot.latest.seq }, d);
const say = (snapshot: Snapshot, d: TurnDeps, text: string) => turn(snapshot, d, { type: "text", text });
const submit = (snapshot: Snapshot, d: TurnDeps, answers: Record<string, unknown>) => turn(snapshot, d, { type: "card", answers });
const confirm = (snapshot: Snapshot, d: TurnDeps) => turn(snapshot, d, { type: "confirm" });
const interpret = (snapshot: Snapshot, d: TurnDeps) => turn(snapshot, d, { type: "interpret" });
const startNew = (d: TurnDeps, id: string) => createSession({ entryMode: "new", text: example(id).first }, d);

test("number evidence matches whole numbers and only scales rates", () => {
  assert.equal(numberAppearsInText(0.12, "让扣点 12 个点", true), true);
  assert.equal(numberAppearsInText(3000, "满3,000减300"), true);
  assert.equal(numberAppearsInText(30, "满3000减300"), false);
  assert.equal(dateEvidenced("2026-05-10", "5月4号到10号"), true);
  const sentence = "满 2000 减 200，12 月 30 日到 1 月 3 日";
  assert.equal(numberAppearsInText(200, sentence), true, "分句的中文逗号不能把前后两个数字粘在一起");
});

test("the example session reads back T1 without the agent, and confirming produces the fill sheet", async () => {
  const d = deps();
  let snapshot = await createSession({ entryMode: "example" }, d);
  assert.deepEqual(snapshot.messages.map((message) => message.content.kind), ["user_text", "agent_text", "agent_readback"]);
  assert.equal(snapshot.flow.phase, "readback");
  assert.equal(snapshot.flow.canConfirm, true);
  assert.equal(snapshot.session.title, "黄金每克减15");

  snapshot = await confirm(snapshot, d);
  const sheet = lastOfKind(snapshot, "agent_fill_sheet");
  assert.ok(sheet);
  assert.equal(sheet.sheet.info.find((row) => row.label === "活动名称")?.value, "黄金每克减15");
  assert.equal(snapshot.latest.seq, 1, "确认不产生新版本");
  assert.deepEqual([snapshot.flow.phase, snapshot.session.status], ["confirmed", "confirmed"]);
  assert.equal(d.calls(), 0);
});

test("a new request is understood by the agent, asks one round, then reads back after the card", async () => {
  const t2 = example("T2");
  const d = deps([record(t2.firstWrites)]);
  let snapshot = await startNew(d, "T2");
  assert.equal(snapshot.flow.pendingInterpretation, true);
  snapshot = await interpret(snapshot, d);
  assert.deepEqual(cardIds(snapshot), ["Q1", "Q5a", "Q5b", "Q6a"]);
  assert.equal(snapshot.flow.phase, "asking");
  assert.equal(snapshot.flow.openQuestions.length, 4);

  snapshot = await submit(snapshot, d, {
    Q1: { start: "2026-10-01", end: "2026-10-07" },
    Q5a: { none: true },
    Q5b: { commission: "price_times_discount" },
    Q6a: { wanted: false },
  });
  assert.equal(lastAgent(snapshot).kind, "agent_readback");
  assert.equal(snapshot.flow.canConfirm, true);
  assert.equal(d.calls(), 1, "卡片提交不调模型");

  snapshot = await confirm(snapshot, d);
  const sheet = lastOfKind(snapshot, "agent_fill_sheet")!.sheet;
  assert.equal(sheet.info.find((row) => row.label === "计折上折")?.value, "计算折上折");
  assert.ok(sheet.postActions.some((action) => action.id === "group_17"));
});

test("the second round only asks what the first answers triggered", async () => {
  const d = deps([record(example("T5").firstWrites)]);
  let snapshot = await interpret(await startNew(d, "T5"), d);
  assert.deepEqual(cardIds(snapshot), ["Q3", "Q5a", "Q5b", "Q6a"]);
  snapshot = await submit(snapshot, d, { Q3: { pattern: "discount", items: [{ discount: 0.9 }] }, Q5a: { none: true }, Q5b: { commission: "actual_price" }, Q6a: { wanted: false } });
  const second = lastOfKind(snapshot, "agent_round_card")!;
  assert.deepEqual([second.round, second.questions.map((question) => question.id)], [2, ["Q3b"]]);
  snapshot = await submit(snapshot, d, { Q3b: { editable: true } });
  assert.equal(snapshot.flow.phase, "readback");
  assert.equal(snapshot.latest.fill.details[0].mode.value, "浮动折扣模式");
});

test("a third card is never issued; empty answers end in a blocked readback that cannot be confirmed", async () => {
  const text = "7590门店钻石类打9折活动";
  const d = deps([record([{ key: "stores", quote: "7590门店", value: ["7590门店"] }, { key: "categories", quote: "钻石类", value: ["钻石类"] }, { key: "offer", quote: "打9折" }])]);
  let snapshot = await interpret(await createSession({ entryMode: "new", text }, d), d);
  assert.equal(lastOfKind(snapshot, "agent_round_card")?.round, 1);
  snapshot = await submit(snapshot, d, {});
  const second = lastOfKind(snapshot, "agent_round_card")!;
  assert.equal(second.round, 2);
  assert.ok(second.questions.every((question) => question.repeated));
  snapshot = await submit(snapshot, d, {});
  assert.equal(snapshot.messages.filter((message) => message.content.kind === "agent_round_card").length, 2);
  assert.equal(lastAgent(snapshot).kind, "agent_readback");
  assert.equal(snapshot.flow.phase, "blocked");
  await assert.rejects(() => confirm(snapshot, d), (error: { status?: number }) => error.status === 409);
});

test("typing while a card is open records the fact and keeps the card open", async () => {
  const d = deps([record(example("T2").firstWrites), record([{ key: "dates", quote: "2026年10月1日到10月7日" }])]);
  let snapshot = await interpret(await startNew(d, "T2"), d);
  const cardId = snapshot.flow.openCardId;
  snapshot = await say(snapshot, d, "2026年10月1日到10月7日");
  assert.equal(snapshot.flow.openCardId, cardId);
  assert.equal(snapshot.messages.filter((message) => message.content.kind === "agent_round_card").length, 1);
  assert.ok(lastOfKind(snapshot, "agent_change"));
  assert.equal(snapshot.flow.openQuestions.some((question) => question.id === "Q1"), false);
  assert.deepEqual(d.requests[1].openQuestions, ["Q1", "Q5a", "Q5b", "Q6a"]);
});

test("a change after the readback asks the new follow-up question in a new round", async () => {
  const d = deps([record([{ key: "offer", quote: "满5000减500" }])]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await say(snapshot, d, "改成满5000减500");
  assert.deepEqual(cardIds(snapshot), ["Q3c"]);
  assert.equal(lastOfKind(snapshot, "agent_round_card")?.round, 1);
  await assert.rejects(() => confirm(snapshot, d), (error: { status?: number }) => error.status === 409, "复述已过期时不能确认");
});

test("confirming in chat goes through confirm_readback", async () => {
  const d = deps([{ steps: [["confirm_readback"]], reply: "好的，填写值生成了。" }]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await say(snapshot, d, "确认，没问题");
  assert.ok(lastOfKind(snapshot, "agent_fill_sheet"));
  assert.equal(d.requests[0].readbackSeq, 1);
  assert.equal(d.requests[0].canConfirm, true);
});

test("undo in chat restores the previous version", async () => {
  const d = deps([record([{ key: "offer", quote: "每克减20元" }]), { steps: [["undo_last_change"]], reply: "撤销了。" }]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await say(snapshot, d, "改成每克减20元");
  assert.equal(snapshot.latest.draft.facts.offer?.value.items[0].amount, 20);
  snapshot = await say(snapshot, d, "撤销");
  assert.equal(snapshot.latest.draft.facts.offer?.value.items[0].amount, 15);
  assert.equal(lastOfKind(snapshot, "agent_change")?.title, "已撤销");
});

test("model-drafted copy is kept until the facts it describes change", async () => {
  const d = deps([
    { steps: [["draft_copy", { name: "足金每克减15元", content: "一般足金类黄金每克减15元" }]], reply: "名称改好了。" },
    record([{ key: "offer", quote: "每克减20元" }]),
  ]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await say(snapshot, d, "名称写得正式一点");
  assert.equal(snapshot.latest.fill.info.name.value, "足金每克减15元");
  snapshot = await say(snapshot, d, "改成每克减20元");
  assert.deepEqual([snapshot.latest.draft.copy, snapshot.latest.fill.info.name.value], [null, "黄金每克减20"]);
});

test("agent failures keep the request retryable", async () => {
  const d = deps([new Error("连不上 Agent 服务"), record(example("T2").firstWrites), new Error("Agent 超时了，请重试")]);
  let snapshot = await interpret(await startNew(d, "T2"), d);
  const failed = lastAgent(snapshot);
  assert.deepEqual(failed.kind === "agent_error" && failed.retry, { type: "interpret" });
  assert.equal(snapshot.flow.pendingInterpretation, true);
  snapshot = await interpret(snapshot, d);
  assert.equal(snapshot.flow.pendingInterpretation, false);

  const seq = snapshot.latest.seq;
  snapshot = await say(snapshot, d, "2026年10月1日到10月7日");
  const textFailed = lastAgent(snapshot);
  assert.deepEqual(textFailed.kind === "agent_error" && textFailed.retry, { type: "text", text: "2026年10月1日到10月7日" });
  assert.equal(snapshot.latest.seq, seq);
});

test("tools drop quotes the user did not say, reject bad copy and only confirm a confirmable readback", () => {
  const text = "满5000减500，钻石类";
  const request: AgentRequest = {
    today: TODAY, draft: createEmptyDraft("r", text), history: [], trigger: { kind: "user_message", text },
    phase: "asking", roundsUsed: 1, openQuestions: [], readbackSeq: null, canConfirm: false, canUndo: false,
  };
  const state = createAgentState(request);
  const outcome = JSON.parse(runAgentTool(state, "update_fields", { facts: [{ key: "offer", quote: "满3000减300" }, { key: "categories", quote: "钻石类", value: ["钻石类"] }] }).text);
  assert.equal(state.draft.facts.offer, null);
  assert.equal(outcome.dropped.length, 1);
  assert.equal(state.draft.facts.categories?.value.all[0], "钻石类");

  assert.equal(runAgentTool(state, "draft_copy", { name: "钻石类满减大促销活动名称很长", content: "钻石类" }).isError, true);
  assert.equal(runAgentTool(state, "confirm_readback").isError, true);

  const confirmable = createAgentState({ ...request, draft: applyFactWrites(createEmptyDraft("c", "确认"), [], { text: "确认", today: TODAY }).draft, trigger: { kind: "user_message", text: "确认" }, readbackSeq: 3, canConfirm: true });
  assert.equal(runAgentTool(confirmable, "confirm_readback").isError, undefined);
  assert.equal(finishAgentTurn(confirmable, "好的。还要加标语吗？").reply, "好的。");
});

test("prompts carry today, the open questions and the recorded facts", () => {
  const t2 = example("T2");
  const draft = applyFactWrites(createEmptyDraft("p", t2.first), t2.firstWrites, { text: t2.first, today: TODAY }).draft;
  assert.match(buildAgentSystemPrompt(TODAY), /今天是 2026-09-16/);
  const prompt = buildAgentUserPrompt({
    today: TODAY, draft, history: [], trigger: { kind: "user_message", text: "下周开始" },
    phase: "asking", roundsUsed: 1, openQuestions: ["Q1"], readbackSeq: null, canConfirm: false, canUndo: true,
  });
  assert.match(prompt, /卡片上正在问：活动从哪天到哪天？/);
  assert.match(prompt, /门店：7590/);
  assert.match(prompt, /用户说：「下周开始」/);
});
