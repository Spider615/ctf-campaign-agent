import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../app/lib/agent/prompt.ts";
import type { AgentRequest, AgentResult } from "../app/lib/agent/protocol.ts";
import { AGENT_TOOL_META, createAgentState, finishAgentTurn, runAgentTool, safeToolSummary, type AgentToolName } from "../app/lib/agent/tools.ts";
import { checkDraft } from "../app/lib/campaign/ics1811/checks.ts";
import { deriveFill } from "../app/lib/campaign/ics1811/derive.ts";
import { EXAMPLES } from "../app/lib/campaign/ics1811/examples.ts";
import { applyFactWrites, createEmptyDraft, type FactWrite } from "../app/lib/campaign/ics1811/facts.ts";
import type { StoredMessage } from "../app/lib/campaign/ics1811/messages.ts";
import { checkProposal } from "../app/lib/campaign/ics1811/proposals.ts";
import { buildReadback } from "../app/lib/campaign/ics1811/readback.ts";
import type { Ics1811Draft, Proposal } from "../app/lib/campaign/ics1811/types.ts";
import { createMemoryStore } from "../app/lib/server/session-store.ts";
import { createSession, parseTurnInput, runTurn, type AgentTransientEvent, type Snapshot, type TurnDeps } from "../app/lib/server/turns.ts";
import { finishTraceEvent, mergeTraceEvent, startTraceEvent, type AgentTraceEvent } from "../app/lib/tool-trace.ts";

const TODAY = "2026-09-16";
type Step = [AgentToolName, Record<string, unknown>?];
type Script = { steps?: Step[]; reply?: string | null };

// 假的 Agent 服务：按脚本调用真实的工具，模拟模型在一轮里做的事；
// 工具事件照 agent/server.ts 的做法记进轨迹（被拒记 warning），编排器靠它判断要不要补跑。
function runScript(script: Script, request: AgentRequest, onTrace?: (event: AgentTraceEvent) => void): AgentResult {
  const state = createAgentState(request);
  let at = 1_000;
  for (const [name, input] of script.steps ?? []) {
    const started = startTraceEvent({ id: `model-${at}`, tool: name, title: AGENT_TOOL_META[name].title, initiatedBy: "model", at });
    state.trace = mergeTraceEvent(state.trace, started);
    onTrace?.(started);
    const outcome = runAgentTool(state, name, input);
    const finished = finishTraceEvent(started, { status: outcome.isError ? "warning" : "completed", summary: safeToolSummary(name, outcome, state), at: at + 5 });
    state.trace = mergeTraceEvent(state.trace, finished);
    onTrace?.(finished);
    at += 10;
  }
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
    runAgent: async (request, onTrace) => {
      requests.push(structuredClone(request));
      const next = scripts.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("unexpected agent call");
      return runScript(next, request, onTrace);
    },
    calls: () => requests.length,
    requests,
  };
}

const example = (id: string) => EXAMPLES.find((item) => item.id === id)!;
const record = (writes: FactWrite[]): Script => ({ steps: [["extract_campaign_facts", { facts: writes }]], reply: "记下了。" });
const lastAgent = (snapshot: Snapshot) => [...snapshot.messages].reverse().find((message) => message.role === "assistant")!.content;
const lastOfKind = <K extends StoredMessage["kind"]>(snapshot: Snapshot, kind: K) =>
  [...snapshot.messages].reverse().find((message) => message.content.kind === kind)?.content as Extract<StoredMessage, { kind: K }> | undefined;
const countOf = (snapshot: Snapshot, kind: StoredMessage["kind"]) => snapshot.messages.filter((message) => message.content.kind === kind).length;
const kinds = (snapshot: Snapshot) => snapshot.messages.map((message) => message.content.kind);
const traceSteps = (snapshot: Snapshot) => lastOfKind(snapshot, "agent_tool_trace")?.trace.steps.map((step) => [step.tool, step.initiatedBy]) ?? [];

const turn = (snapshot: Snapshot, d: TurnDeps, body: Record<string, unknown>) => runTurn(snapshot.session.id, { ...body, expectedSeq: snapshot.latest.seq }, d);
const say = (snapshot: Snapshot, d: TurnDeps, text: string) => turn(snapshot, d, { type: "text", text });
const interpret = (snapshot: Snapshot, d: TurnDeps) => turn(snapshot, d, { type: "interpret" });
const startNew = (d: TurnDeps, id: string) => createSession({ entryMode: "new", text: example(id).first }, d);

// T2 首句后缺日期、让扣点回款率、提成口径、标语。Agent 问前三项，并提议后两项按常见做法。
const T2_ASK: Script = {
  steps: [
    ["extract_campaign_facts", { facts: example("T2").firstWrites }],
    ["analyze_campaign_state"],
    ["ask_campaign_questions", {
      questions: ["Q1", "Q5a", "Q5b"],
      proposals: [{ question: "Q5a", answer: { none: true } }, { question: "Q5b", answer: { commission: "actual_price" } }],
    }],
  ],
  reply: "铂金以旧换新 2 倍、开单 9 折记下了。活动从哪天到哪天？让扣点和回款率一般都没有，提成按实际售价算，这次也这样吗？",
};

const askedT2 = async (d: TurnDeps) => interpret(await startNew(d, "T2"), d);

test("the example session is built straight away, without the agent or any confirmation", async () => {
  const d = deps();
  const snapshot = await createSession({ entryMode: "example" }, d);
  assert.deepEqual(kinds(snapshot), ["user_text", "agent_text", "agent_fill_sheet"]);
  const reply = lastOfKind(snapshot, "agent_text")!;
  assert.deepEqual(reply.asking, [], "模型式回复要带 asking，示例里没有要问的");
  const sheet = lastOfKind(snapshot, "agent_fill_sheet")!;
  assert.match(sheet.summary ?? "", /黄金每克减15/);
  assert.ok(sheet.lines?.length, "填写值消息要说清建了什么");
  assert.equal(sheet.versionSeq, 1);
  assert.equal(sheet.sheet.info.find((row) => row.label === "活动名称")?.value, "黄金每克减15");
  assert.deepEqual([snapshot.flow.phase, snapshot.session.status, snapshot.flow.sheetSeq], ["ready", "confirmed", 1]);
  assert.equal(snapshot.session.title, "黄金每克减15");
  assert.equal(d.calls(), 0);
});

test("the agent asks in its own words and registers what it asks and proposes", async () => {
  const d = deps([T2_ASK]);
  let snapshot = await startNew(d, "T2");
  assert.equal(snapshot.flow.pendingInterpretation, true);
  assert.equal(snapshot.flow.phase, "interpreting");
  snapshot = await interpret(snapshot, d);

  assert.equal(countOf(snapshot, "agent_round_card"), 0, "没有追问卡片");
  assert.equal(countOf(snapshot, "agent_readback"), 0, "没有复述卡片");
  assert.equal(countOf(snapshot, "agent_fill_sheet"), 0, "还缺信息时不出填写值");
  const reply = [...snapshot.messages].reverse().find((message) => message.content.kind === "agent_text")!;
  assert.equal(snapshot.flow.replyId, reply.id);
  assert.match(reply.content.kind === "agent_text" ? reply.content.text : "", /这次也这样吗？/, "问句不删");
  assert.deepEqual(snapshot.flow.asking.map((gap) => gap.id), ["Q1", "Q5a", "Q5b"]);
  assert.deepEqual(snapshot.flow.proposals.map((item) => item.id), ["Q5a", "Q5b"]);
  assert.deepEqual(snapshot.flow.proposals.map((item) => item.text), ["让扣点和回款率：让扣点 0，回款率 0", "提成口径：按实际售价算提成"]);
  assert.deepEqual(snapshot.flow.missingIds, ["Q1", "Q5a", "Q5b", "Q6a"]);
  assert.deepEqual([snapshot.flow.phase, snapshot.session.status], ["collecting", "collecting"]);
  assert.deepEqual(traceSteps(snapshot).map(([tool]) => tool), ["extract_campaign_facts", "analyze_campaign_state", "ask_campaign_questions", "analyze_campaign_plan"]);
});

test("a bare nod records the proposals before the agent runs", async () => {
  const d = deps([T2_ASK, { steps: [], reply: "好，那活动从哪天到哪天？" }]);
  let snapshot = await askedT2(d);
  snapshot = await say(snapshot, d, "行");

  const request = d.requests[1];
  assert.deepEqual(request.proposals, [], "已经按提议记下的不再交给模型");
  assert.deepEqual(request.accepted, ["让扣点和回款率：让扣点 0，回款率 0", "提成口径：按实际售价算提成"], "告诉模型这一轮已经记下了什么");
  assert.equal(request.phase, "collecting");
  assert.deepEqual(request.openQuestions, ["Q1"], "补上的不再算在问");
  assert.deepEqual(request.draft!.facts.rates?.value, { concession: 0, collection: 0 });
  assert.equal(request.draft!.facts.commission?.value, "actual_price");

  const { rates, commission } = snapshot.latest.draft!.facts;
  assert.deepEqual([rates?.via, rates?.quote, commission?.via], ["proposal", "行", "proposal"]);
  assert.deepEqual(traceSteps(snapshot)[0], ["accept_campaign_proposals", "orchestrator"]);
  assert.ok(traceSteps(snapshot).some(([tool, by]) => tool === "analyze_campaign_state" && by === "orchestrator"), "按提议记下后要补跑规则分析");
  assert.equal(lastOfKind(snapshot, "agent_change")?.title, "改了 2 处");
  assert.deepEqual(snapshot.flow.missingIds, ["Q1", "Q6a"]);
  assert.deepEqual(snapshot.flow.proposals, []);
});

test("a nod with a correction lets the agent accept part of the proposals and record the rest from the words", async () => {
  const text = "对，不过提成按实际售价乘折扣算";
  const d = deps([
    T2_ASK,
    {
      steps: [
        ["accept_campaign_proposals", { questions: ["Q5a"], quote: "对" }],
        ["extract_campaign_facts", { facts: [{ key: "commission", quote: "提成按实际售价乘折扣算" }] }],
        ["analyze_campaign_state"],
      ],
      reply: "好，提成按乘折扣算。",
    },
  ]);
  let snapshot = await askedT2(d);
  snapshot = await say(snapshot, d, text);

  assert.equal(d.requests[1].proposals.length, 2, "不是纯点头，编排器不预先采纳");
  assert.ok(!traceSteps(snapshot).some(([tool, by]) => tool === "accept_campaign_proposals" && by === "orchestrator"));
  const { rates, commission } = snapshot.latest.draft!.facts;
  assert.deepEqual([rates?.value, rates?.via, rates?.quote], [{ concession: 0, collection: 0 }, "proposal", "对"]);
  assert.deepEqual([commission?.value, commission?.via], ["price_times_discount", "text"], "改的那项按原话记，不按提议");
});

test("accepting proposals needs a proposal, the user's own words and a clear yes", () => {
  const draft = applyFactWrites(createEmptyDraft("a", example("T2").first), example("T2").firstWrites, { text: example("T2").first, today: TODAY }).draft;
  const proposal = (checkProposal(draft, "Q5a", { none: true }) as { ok: true; proposal: Proposal }).proposal;
  const stateFor = (text: string, proposals: Proposal[]) => createAgentState({
    today: TODAY, draft, history: [], trigger: { kind: "user_message", text }, phase: "collecting", openQuestions: ["Q5a"], proposals, canUndo: false,
  });

  assert.equal(runAgentTool(stateFor("行", []), "accept_campaign_proposals", { quote: "行" }).isError, true, "上一句没有提议");
  assert.equal(runAgentTool(stateFor("嗯", [proposal]), "accept_campaign_proposals", { quote: "行" }).isError, true, "quote 不在原话里");
  for (const text of ["不对", "改成让扣点2%，回款率98%"]) {
    const state = stateFor(text, [proposal]);
    assert.equal(runAgentTool(state, "accept_campaign_proposals", { quote: text }).isError, true, `「${text}」不是同意`);
    assert.equal(state.draft!.facts.rates, null);
  }
  const ok = stateFor("对的", [proposal]);
  assert.equal(runAgentTool(ok, "accept_campaign_proposals", { quote: "对的" }).isError, undefined);
  assert.deepEqual([ok.draft!.facts.rates?.via, ok.applied], ["proposal", ["rates"]]);
});

test("asking only registers what is missing, and only proposable values that pass the code table", () => {
  const stateFor = (id: string) => {
    const item = example(id);
    const draft = applyFactWrites(createEmptyDraft(id, item.first), item.firstWrites, { text: item.first, today: TODAY }).draft;
    return createAgentState({ today: TODAY, draft, history: [], trigger: { kind: "first_message", text: item.first }, phase: "interpreting", openQuestions: [], proposals: [], canUndo: false });
  };

  // T2 已经说了门店：只问门店就是空登记，拒绝；连同日期一起问就略过门店。
  const t2 = stateFor("T2");
  assert.equal(runAgentTool(t2, "ask_campaign_questions", { questions: ["Q2"] }).isError, true);
  assert.equal(t2.asking, null);
  const partial = JSON.parse(runAgentTool(t2, "ask_campaign_questions", { questions: ["Q2", "Q1"] }).text);
  assert.deepEqual(t2.asking, ["Q1"]);
  assert.match(partial.skipped, /Q2/);

  // 标语原文只能用户给；回款率大于 1 过不了校验。
  for (const proposal of [{ question: "Q6a", answer: { wanted: true, text: "铂金焕新", legalConfirmed: true } }, { question: "Q5a", answer: { concession: 2, collection: 0.98 } }]) {
    const state = stateFor("T2");
    assert.equal(runAgentTool(state, "ask_campaign_questions", { questions: [proposal.question], proposals: [proposal] }).isError, true, JSON.stringify(proposal));
    assert.deepEqual([state.asking, state.proposals], [null, []]);
  }

  // 优惠方式是活动本身，不能提议。
  const noOffer = createAgentState({ ...stateFor("T2").request, draft: createEmptyDraft("o", "7590门店做个活动") });
  assert.equal(runAgentTool(noOffer, "ask_campaign_questions", { questions: ["Q3"], proposals: [{ question: "Q3", answer: { pattern: "discount", items: [{ discount: 0.9 }] } }] }).isError, true);
  // 门店不在代码表里不能提议。
  assert.equal(runAgentTool(noOffer, "ask_campaign_questions", { questions: ["Q2"], proposals: [{ question: "Q2", answer: { stores: ["9999"] } }] }).isError, true);

  // 标语写了但没说法务确认：法务确认只能用户说。
  const t9 = stateFor("T9");
  assert.equal(runAgentTool(t9, "ask_campaign_questions", { questions: ["Q6b"], proposals: [{ question: "Q6b", answer: { legalConfirmed: true } }] }).isError, true);
  assert.equal(runAgentTool(t9, "ask_campaign_questions", { questions: ["Q6b"] }).isError, undefined, "不带提议可以问");

  // 一次问 4 件就又成了填表：拒绝，让模型挑 3 件以内。
  const tooMany = stateFor("T2");
  assert.equal(runAgentTool(tooMany, "ask_campaign_questions", { questions: ["Q1", "Q5a", "Q5b", "Q6a"] }).isError, true);
  assert.equal(tooMany.asking, null);

  // 「五一」「国庆」提议成已经过去的日期：拒绝（实测模型在 9 月把「五一」提议成当年 5 月）。
  const pastDate = stateFor("T2");
  assert.equal(runAgentTool(pastDate, "ask_campaign_questions", { questions: ["Q1"], proposals: [{ question: "Q1", answer: { start: "2026-05-01", end: "2026-05-05" } }] }).isError, true);
  assert.equal(runAgentTool(pastDate, "ask_campaign_questions", { questions: ["Q1"], proposals: [{ question: "Q1", answer: { start: "2027-05-01", end: "2027-05-05" } }] }).isError, undefined);

  // 合法的提议登记下来，文字由代码渲染。
  const good = stateFor("T2");
  const body = JSON.parse(runAgentTool(good, "ask_campaign_questions", { questions: ["Q6a"], proposals: [{ question: "Q6a", answer: { wanted: false } }] }).text);
  assert.deepEqual(body.proposals, ["活动标语：不加"]);
  assert.deepEqual(good.proposals.map((item) => item.id), ["Q6a"]);
});

test("the turn that fills the last gap builds the campaign right away", async () => {
  const d = deps([
    T2_ASK,
    { steps: [["ask_campaign_questions", { questions: ["Q1", "Q6a"], proposals: [{ question: "Q6a", answer: { wanted: false } }] }]], reply: "好。活动哪天到哪天？标语一般不加，这次也不加？" },
    { steps: [["extract_campaign_facts", { facts: [{ key: "dates", quote: "2026年10月1日到10月7日" }, { key: "slogan", quote: "不要标语" }] }], ["analyze_campaign_state"]], reply: "齐了，活动建好了。" },
  ]);
  let snapshot = await askedT2(d);
  snapshot = await say(snapshot, d, "行");
  assert.equal(snapshot.flow.phase, "collecting");
  snapshot = await say(snapshot, d, "2026年10月1日到10月7日，不要标语");

  assert.deepEqual([snapshot.flow.phase, snapshot.session.status], ["ready", "confirmed"]);
  const sheet = lastOfKind(snapshot, "agent_fill_sheet")!;
  assert.equal(sheet.versionSeq, snapshot.latest.seq);
  assert.equal(snapshot.flow.sheetSeq, snapshot.latest.seq);
  assert.match(sheet.summary ?? "", /10月1日–10月7日/);
  assert.deepEqual(traceSteps(snapshot).at(-1), ["generate_ics1811_sheet", "orchestrator"]);
  assert.equal(lastAgent(snapshot).kind, "agent_fill_sheet", "填写值排在 Agent 的话后面");
  assert.deepEqual([snapshot.flow.asking, snapshot.flow.proposals, snapshot.flow.missing], [[], [], []]);
});

test("a nod that fills the last gaps builds the campaign in the same turn", async () => {
  const d = deps([
    T2_ASK,
    {
      steps: [
        ["extract_campaign_facts", { facts: [{ key: "dates", quote: "2026年10月1日到10月7日" }, { key: "slogan", quote: "不要标语" }] }],
        ["analyze_campaign_state"],
        ["ask_campaign_questions", { questions: ["Q5a", "Q5b"], proposals: [{ question: "Q5a", answer: { none: true } }, { question: "Q5b", answer: { commission: "actual_price" } }] }],
      ],
      reply: "日期和标语记下了。让扣点和回款率一般都没有，提成按实际售价算，这次也这样吗？",
    },
    { steps: [], reply: "齐了，活动建好了。" },
  ]);
  let snapshot = await askedT2(d);
  snapshot = await say(snapshot, d, "2026年10月1日到10月7日，不要标语");
  assert.deepEqual(snapshot.flow.proposals.map((item) => item.id), ["Q5a", "Q5b"]);
  snapshot = await say(snapshot, d, "对，就这样");

  // phase 按这一轮开始前算：点头刚好补齐时，模型拿到的仍是 collecting，靠 accepted 知道记下了什么。
  assert.equal(d.requests[2].phase, "collecting");
  assert.equal(d.requests[2].accepted?.length, 2);
  assert.deepEqual([snapshot.flow.phase, snapshot.session.status], ["ready", "confirmed"]);
  assert.equal(lastOfKind(snapshot, "agent_fill_sheet")?.versionSeq, snapshot.latest.seq);
  const steps = traceSteps(snapshot);
  assert.deepEqual(steps[0], ["accept_campaign_proposals", "orchestrator"]);
  assert.ok(steps.some(([tool, by]) => tool === "analyze_campaign_state" && by === "orchestrator"));
  assert.deepEqual(steps.at(-1), ["generate_ics1811_sheet", "orchestrator"]);
});

test("the orchestrator only skips the fill sheet step when the model's own step completed", async () => {
  const d = deps([
    { steps: [["extract_campaign_facts", { facts: [{ key: "offer", quote: "每克减20元" }] }], ["analyze_campaign_state"], ["generate_ics1811_sheet"]], reply: "改好了。" },
    record([{ key: "offer", quote: "满5000减500" }]),
    // 模型在记下之前就去生成，被拒（warning）；这一轮最终齐了，编排器要补跑。
    { steps: [["generate_ics1811_sheet"], ["extract_campaign_facts", { facts: [{ key: "thresholdRepeat", quote: "每满都减" }] }]], reply: "好。" },
  ]);
  let snapshot = await createSession({ entryMode: "example" }, d);

  snapshot = await say(snapshot, d, "改成每克减20元");
  assert.deepEqual(traceSteps(snapshot).filter(([tool]) => tool === "generate_ics1811_sheet"), [["generate_ics1811_sheet", "model"]]);
  assert.equal(lastOfKind(snapshot, "agent_fill_sheet")?.versionSeq, 2, "模型自己生成过，填写值消息照样出");

  snapshot = await say(snapshot, d, "改成满5000减500");
  snapshot = await say(snapshot, d, "每满都减");
  assert.equal(snapshot.flow.phase, "ready");
  assert.deepEqual(traceSteps(snapshot).filter(([tool]) => tool === "generate_ics1811_sheet"), [["generate_ics1811_sheet", "model"], ["generate_ics1811_sheet", "orchestrator"]]);
  const warned = lastOfKind(snapshot, "agent_tool_trace")!.trace.steps.find((step) => step.tool === "generate_ics1811_sheet" && step.initiatedBy === "model");
  assert.equal(warned?.status, "warning");
  assert.equal(lastOfKind(snapshot, "agent_fill_sheet")?.versionSeq, snapshot.latest.seq);
});

test("changing a built campaign updates the fill sheet; a change that opens a new gap waits for the answer", async () => {
  const d = deps([record([{ key: "offer", quote: "每克减20元" }]), record([{ key: "offer", quote: "满5000减500" }])]);
  let snapshot = await createSession({ entryMode: "example" }, d);

  snapshot = await say(snapshot, d, "改成每克减20元");
  assert.equal(snapshot.latest.seq, 2);
  assert.ok(lastOfKind(snapshot, "agent_change"));
  const updated = lastOfKind(snapshot, "agent_fill_sheet")!;
  assert.equal(countOf(snapshot, "agent_fill_sheet"), 2);
  assert.equal(updated.versionSeq, 2);
  assert.match(updated.lines?.join("") ?? "", /每克减 20 元/);
  assert.equal(snapshot.flow.phase, "ready");

  snapshot = await say(snapshot, d, "改成满5000减500");
  assert.equal(countOf(snapshot, "agent_fill_sheet"), 2, "引出新缺项时不出填写值");
  assert.deepEqual([snapshot.flow.phase, snapshot.session.status], ["collecting", "collecting"]);
  assert.ok(snapshot.flow.missingIds.includes("Q3c"));
  // 模型没登记也没问：代码按缺项补问一句。
  const reply = lastOfKind(snapshot, "agent_text")!;
  assert.match(reply.text, /还想跟你确认一下：买满 10000 元时，是减一次 500，还是减两次共 1000？/);
  assert.deepEqual(reply.asking, ["Q3c"]);
});

test("chatting about a built campaign does not repeat the fill sheet", async () => {
  const d = deps([{ steps: [], reply: "每克减 15 元在黄金活动里算常见力度。" }]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await say(snapshot, d, "这个力度够吗");
  assert.equal(countOf(snapshot, "agent_fill_sheet"), 1);
  assert.equal(snapshot.latest.seq, 1);
  assert.deepEqual([snapshot.flow.phase, snapshot.session.status], ["ready", "confirmed"]);
  assert.equal(d.requests[0].phase, "ready");
});

test("when the agent records facts but forgets to ask, the code asks the next two gaps", async () => {
  const d = deps([record(example("T2").firstWrites)]);
  const snapshot = await askedT2(d);
  const reply = lastOfKind(snapshot, "agent_text")!;
  assert.equal(reply.text, "记下了。\n\n还想跟你确认一下：活动从哪天到哪天？有没有让扣点或回款率？没有就都填 0。");
  assert.deepEqual(reply.asking, ["Q1", "Q5a"]);
  assert.deepEqual(reply.proposals, []);
  assert.deepEqual(snapshot.flow.asking.map((gap) => gap.id), ["Q1", "Q5a"]);
});

test("a question the agent did not register opens nothing, so a short reply cannot land on an unasked item", async () => {
  // 原来把全部缺项都当成在问：模型只问了日期，用户回「还没」却被记成没有让扣点、不加标语（验证工作流复现过）。
  const d = deps([
    { steps: [["extract_campaign_facts", { facts: example("T2").firstWrites }]], reply: "记下了，日期定了吗？" },
    { steps: [["extract_campaign_facts", { facts: [{ key: "rates", quote: "还没" }, { key: "slogan", quote: "还没" }] }]], reply: "好。" },
  ]);
  let snapshot = await askedT2(d);
  const reply = lastOfKind(snapshot, "agent_text")!;
  assert.equal(reply.text, "记下了，日期定了吗？", "有问句就不补问");
  assert.deepEqual([reply.asking, reply.proposals], [[], []]);
  snapshot = await say(snapshot, d, "还没");
  assert.deepEqual(d.requests[1].openQuestions, []);
  assert.deepEqual([snapshot.latest.draft!.facts.rates, snapshot.latest.draft!.facts.slogan], [null, null]);
});

test("answering a side question keeps the earlier questions open but not the proposals", async () => {
  const d = deps([T2_ASK, { steps: [], reply: "让扣点是商场按销售额扣的点数，合约里会写。" }, { steps: [], reply: "不客气。" }]);
  let snapshot = await askedT2(d);
  const firstReply = snapshot.flow.replyId;
  const seq = snapshot.latest.seq;
  snapshot = await say(snapshot, d, "让扣点是什么意思");
  assert.notEqual(snapshot.flow.replyId, firstReply);
  assert.deepEqual(lastOfKind(snapshot, "agent_text")?.asking, ["Q1", "Q5a", "Q5b"]);
  // 用户对解释回一句「好的」是「知道了」，不能被预采纳成同意之前的提议。
  assert.deepEqual(snapshot.flow.proposals, []);
  assert.equal(snapshot.latest.seq, seq, "只是在聊，不产生新版本");
  snapshot = await say(snapshot, d, "好的");
  assert.deepEqual([snapshot.latest.draft!.facts.rates, snapshot.latest.draft!.facts.commission], [null, null]);
});

test("a short reply answers the question the agent registered", async () => {
  const d = deps([
    { steps: [["extract_campaign_facts", { facts: example("T2").firstWrites }], ["ask_campaign_questions", { questions: ["Q5a"] }]], reply: "有没有让扣点或回款率？" },
    { steps: [["extract_campaign_facts", { facts: [{ key: "rates", quote: "没有" }] }]], reply: "好。" },
  ]);
  let snapshot = await askedT2(d);
  snapshot = await say(snapshot, d, "没有");
  assert.deepEqual(d.requests[1].openQuestions, ["Q5a"]);
  assert.deepEqual(snapshot.latest.draft!.facts.rates?.value, { concession: 0, collection: 0 });
  assert.equal(snapshot.latest.draft!.facts.rates?.via, "text");
});

test("an explicit 1811 request that has not said how to discount asks for the offer", async () => {
  const text = "想在3319店搞个黄金优惠开单活动";
  const d = deps([record([{ key: "stores", quote: "3319店", value: ["3319"] }])]);
  const snapshot = await interpret(await createSession({ entryMode: "new", text }, d), d);
  assert.equal(snapshot.flow.phase, "collecting");
  assert.ok(snapshot.flow.missingIds.includes("Q3"));
  // 兜底补问按优先级：先问优惠和货类，不按目录顺序先问日期。
  assert.equal(snapshot.flow.missingIds[0], "Q1", "目录顺序里日期在前");
  assert.deepEqual(lastOfKind(snapshot, "agent_text")?.asking, ["Q3", "Q4"]);
  assert.match(lastOfKind(snapshot, "agent_text")?.text ?? "", /还想跟你确认一下：怎么优惠、给多少？哪些货类参加？/);
});

test("a non-transaction activity stays in the parent campaign instead of being rejected by 1811", async () => {
  const textsOf = (snapshot: Snapshot) => snapshot.messages.flatMap((message) => (message.content.kind === "agent_text" ? [message.content.text] : []));
  // 模型先接住想法、再说明录不进去：留它的话，不再叠一句意思相同的代码说明（原来一律换成代码那句，显得死板）。
  const d = deps([{ steps: [], reply: "国庆抽奖挺能聚人气的。不过抽奖不带成交优惠，1811 录不进去，得走别的系统。" }, { steps: [], reply: null }]);
  let snapshot = await interpret(await createSession({ entryMode: "new", text: "7590门店国庆搞个抽奖活动" }, d), d);
  assert.notEqual(snapshot.flow.phase, "out_of_scope");
  assert.equal(snapshot.latest.draft, null);
  assert.deepEqual(textsOf(snapshot), ["国庆抽奖挺能聚人气的。不过抽奖不带成交优惠，1811 录不进去，得走别的系统。"]);

  // 模型什么都没说时，只说明没有理解到改动，不伪造 1811 拒绝。
  snapshot = await interpret(await createSession({ entryMode: "new", text: "7590门店国庆搞个签到抽奖" }, d), d);
  assert.equal(textsOf(snapshot).length, 1);
  assert.doesNotMatch(textsOf(snapshot)[0], /不在 1811 优惠开单范围/);
});

test("the build summary separates the essentials from what is just defaults", () => {
  const t1 = example("T1");
  const draft = applyFactWrites(createEmptyDraft("s", t1.first), t1.firstWrites, { text: t1.first, today: TODAY }).draft;
  const fill = deriveFill(draft);
  const readback = buildReadback(draft, fill, checkDraft(draft, fill, TODAY), []);

  const essentials = readback.essentials.join("；");
  for (const probe of ["黄金每克减15", "5 月 1 日", "7590", "每克减 15"]) {
    assert.ok(essentials.includes(probe), `要点里要包含「${probe}」：${essentials}`);
  }
  for (const probe of ["付款方式", "活动分组", "是否凭券使用"]) {
    assert.ok(!essentials.includes(probe), `「${probe}」不该占据要点：${essentials}`);
    assert.ok(readback.defaults.join("；").includes(probe), `「${probe}」应收进默认项`);
  }
  assert.ok(essentials.length <= readback.paragraph.length * 0.6, `要点 ${essentials.length} 字 / 整段 ${readback.paragraph.length} 字，没有真正瘦下来`);
  assert.ok(readback.defaults.length >= 4, "按默认的项应该成批折叠，而不是零星几条");
  assert.doesNotMatch(readback.paragraph, /确认/, "没有确认这一步，摘要里不再说确认");

  assert.ok(readback.summary.includes("黄金每克减15"), `结论里要有活动名称：${readback.summary}`);
  assert.ok([...readback.summary].length <= 40, `结论不能超过 40 字：${readback.summary}`);
  for (const label of ["是否参与打折", "预售时间", "是否凭券使用"]) {
    assert.ok(readback.attention.some((item) => item.text.startsWith(label)), `提示里要写明「${label}」`);
  }
});

test("摘要要说清名称和内容是谁写的", () => {
  const t1 = example("T1");
  const base = applyFactWrites(createEmptyDraft("c", t1.first), t1.firstWrites, { text: t1.first, today: TODAY }).draft;
  const firstLine = (draft: Ics1811Draft) => {
    const fill = deriveFill(draft);
    return buildReadback(draft, fill, checkDraft(draft, fill, TODAY), []).essentials[0];
  };

  const fromTemplate = firstLine(base);
  assert.match(fromTemplate, /活动名称「黄金每克减15」/);
  assert.match(fromTemplate, /模板/, `模板生成要标明出处：${fromTemplate}`);

  const fromModel = firstLine({ ...base, copy: { name: "足金每克减15元", content: "一般足金类黄金每克减15元", source: "ai" } });
  assert.match(fromModel, /活动名称「足金每克减15元」/);
  assert.match(fromModel, /模型/, `模型起草要标明出处：${fromModel}`);
  assert.notEqual(fromTemplate.replace(/「[^」]*」/g, ""), fromModel.replace(/「[^」]*」/g, ""), "模板和模型起草的标注不能一样");

  const fromUser = firstLine({ ...base, copy: { name: "足金每克减15元", content: "一般足金类黄金每克减15元", source: "user" } });
  assert.doesNotMatch(fromUser, /模型|模板/, `用户写的不该标成 AI 产出：${fromUser}`);
});

test("undo in chat restores the previous version and the fill sheet follows", async () => {
  const d = deps([record([{ key: "offer", quote: "每克减20元" }]), { steps: [["undo_campaign_change"]], reply: "撤销了。" }]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await say(snapshot, d, "改成每克减20元");
  assert.equal(snapshot.latest.draft!.facts.offer?.value.items[0].amount, 20);
  snapshot = await say(snapshot, d, "撤销");
  assert.equal(snapshot.latest.draft!.facts.offer?.value.items[0].amount, 15);
  assert.equal(lastOfKind(snapshot, "agent_change")?.title, "已撤销");
  assert.equal(lastOfKind(snapshot, "agent_fill_sheet")?.versionSeq, snapshot.latest.seq);
});

test("model-drafted copy is kept until the facts it describes change", async () => {
  const d = deps([
    { steps: [["draft_campaign_copy", { name: "足金每克减15元", content: "一般足金类黄金每克减15元" }]], reply: "名称改好了。" },
    record([{ key: "offer", quote: "每克减20元" }]),
  ]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await say(snapshot, d, "名称写得正式一点");
  assert.equal(snapshot.latest.fill!.info.name.value, "足金每克减15元");
  snapshot = await say(snapshot, d, "改成每克减20元");
  assert.deepEqual([snapshot.latest.draft!.copy, snapshot.latest.fill!.info.name.value], [null, "黄金每克减20"]);
});

test("changing a fact the copy never mentions keeps the model-drafted name", async () => {
  const d = deps([
    { steps: [["draft_campaign_copy", { name: "足金每克减15元", content: "一般足金类黄金每克减15元" }]], reply: "名称改好了。" },
    record([{ key: "stores", quote: "3319门店", value: ["3319"] }]),
  ]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await say(snapshot, d, "名称写得正式一点");
  assert.equal(snapshot.latest.fill!.info.name.value, "足金每克减15元");

  // 门店不出现在名称和内容里，改门店不该把模型起草的文案抹回模板。
  snapshot = await say(snapshot, d, "改成3319门店");
  assert.equal(snapshot.latest.draft!.copy?.source, "ai", "改门店后模型起草的文案要保住");
  assert.equal(snapshot.latest.fill!.info.name.value, "足金每克减15元");
  assert.equal(snapshot.latest.fill!.info.name.basis, "模型起草");
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

test("a nod that fails in the agent keeps nothing and can be retried", async () => {
  const d = deps([T2_ASK, new Error("Agent 超时了，请重试")]);
  let snapshot = await askedT2(d);
  const seq = snapshot.latest.seq;
  snapshot = await say(snapshot, d, "行");
  assert.equal(lastAgent(snapshot).kind, "agent_error");
  assert.equal(snapshot.latest.seq, seq, "失败时按提议记下的也不落库");
  assert.equal(snapshot.latest.draft!.facts.rates, null);
  assert.deepEqual(snapshot.flow.proposals.map((item) => item.id), ["Q5a", "Q5b"], "重试时提议还在");
});

test("real tool events stream once and persist before the related Agent output", async () => {
  const d = deps([record(example("T2").firstWrites)]);
  const runAgent = d.runAgent;
  const seen: AgentTraceEvent[] = [];
  const progress: AgentTransientEvent[] = [];
  d.emitTrace = (event) => seen.push(event);
  d.emitProgress = (event) => progress.push(event);
  d.runAgent = async (request, onTrace, onProgress) => {
    onProgress?.({ type: "phase", phase: "analyzing", at: 90 });
    onProgress?.({ type: "text_delta", delta: "正在核对。" });
    onProgress?.({ type: "text_reset" });
    const started = startTraceEvent({
      id: "trace-persist",
      tool: "extract_campaign_facts",
      title: "提取活动信息",
      initiatedBy: "model",
      at: 100,
    });
    onTrace?.(started);
    const result = await runAgent(request);
    const completed = finishTraceEvent(started, { status: "completed", summary: "识别并核验 4 项信息", at: 180 });
    onTrace?.(completed);
    return { ...result, trace: { status: "completed", durationMs: 80, steps: [completed] } };
  };

  const snapshot = await interpret(await startNew(d, "T2"), d);
  assert.deepEqual(seen.map((event) => [event.tool, event.status, event.initiatedBy]), [
    ["extract_campaign_facts", "started", "model"],
    ["extract_campaign_facts", "completed", "model"],
    ["analyze_campaign_state", "started", "orchestrator"],
    ["analyze_campaign_state", "completed", "orchestrator"],
    ["analyze_campaign_plan", "started", "orchestrator"],
    ["analyze_campaign_plan", "completed", "orchestrator"],
  ]);
  assert.deepEqual(progress, [
    { type: "phase", phase: "analyzing", at: 90 },
    { type: "text_delta", delta: "正在核对。" },
    { type: "text_reset" },
  ]);
  const traceIndex = kinds(snapshot).indexOf("agent_tool_trace");
  assert.ok(traceIndex >= 0);
  assert.ok(traceIndex < kinds(snapshot).indexOf("agent_text"), "工具记录要排在相关 Agent 输出之前");
  assert.equal(countOf(snapshot, "agent_tool_trace"), 1);
  const timing = lastOfKind(snapshot, "agent_tool_trace")?.trace.timing;
  assert.ok(timing, "新轨迹要保存整轮耗时分解");
  assert.equal(timing.analysisWaitingMs + timing.skillsToolsMs, timing.totalMs);
});

test("a failed streamed tool trace stays retryable", async () => {
  const d = deps();
  d.runAgent = async (_request, onTrace) => {
    onTrace?.(startTraceEvent({
      id: "trace-failed",
      tool: "analyze_campaign_state",
      title: "运行 1811 规则分析",
      initiatedBy: "model",
      at: 100,
    }));
    throw new Error("Agent 连接中断");
  };

  const snapshot = await interpret(await startNew(d, "T2"), d);
  const trace = lastOfKind(snapshot, "agent_tool_trace");
  assert.equal(trace?.trace.status, "failed");
  assert.ok(trace?.trace.timing, "失败轨迹也要保存已发生的整轮耗时");
  assert.equal(snapshot.flow.pendingInterpretation, true);
  assert.deepEqual(lastAgent(snapshot).kind, "agent_error");
});

test("a failure after completed tools marks the whole trace failed", async () => {
  const d = deps();
  d.runAgent = async (_request, onTrace) => {
    const started = startTraceEvent({
      id: "trace-completed-before-failure",
      tool: "analyze_campaign_state",
      title: "运行 1811 规则分析",
      initiatedBy: "model",
      at: 100,
    });
    onTrace?.(started);
    onTrace?.(finishTraceEvent(started, {
      status: "completed",
      summary: "完成规则分析",
      at: 140,
    }));
    throw Object.assign(new Error("Agent 后续执行中断"), {
      timing: { totalMs: 900, analysisWaitingMs: 860, skillsToolsMs: 40 },
    });
  };

  const snapshot = await interpret(await startNew(d, "T2"), d);
  const trace = lastOfKind(snapshot, "agent_tool_trace")?.trace;
  assert.equal(trace?.status, "failed");
  assert.deepEqual(trace?.timing, {
    totalMs: 900,
    analysisWaitingMs: 860,
    skillsToolsMs: 40,
  });
});

test("a failure before the first tool still stores a failed timing trace", async () => {
  const d = deps();
  d.runAgent = async () => {
    throw Object.assign(new Error("Agent 认证失败"), {
      timing: { totalMs: 750, analysisWaitingMs: 750, skillsToolsMs: 0 },
    });
  };

  const snapshot = await interpret(await startNew(d, "T2"), d);
  const trace = lastOfKind(snapshot, "agent_tool_trace")?.trace;
  assert.equal(trace?.status, "failed");
  assert.deepEqual(trace?.steps, []);
  assert.deepEqual(trace?.timing, {
    totalMs: 750,
    analysisWaitingMs: 750,
    skillsToolsMs: 0,
  });
});

test("messages created in one turn keep their own occurrence timestamps", async () => {
  const d = deps([record(example("T2").firstWrites)]);
  const snapshot = await interpret(await startNew(d, "T2"), d);
  const messages = snapshot.messages;
  const trace = messages.find((message) => message.content.kind === "agent_tool_trace");
  const reply = messages.findLast((message) => message.content.kind === "agent_text");

  assert.ok(trace && reply);
  assert.notEqual(trace.createdAt, reply.createdAt);
  assert.ok(trace.createdAt < reply.createdAt, "工具记录发生在最终回复之前");
});

test("a failed Skill load keeps the user input and warning trace without changing the activity", async () => {
  const d = deps();
  d.runAgent = async (_request, onTrace) => {
    const started = startTraceEvent({
      id: "skill-load-warning",
      tool: "load_campaign_skill",
      title: "加载业务规则：ICS-1811 字段解释",
      initiatedBy: "model",
      at: 100,
    });
    onTrace?.(started);
    onTrace?.(finishTraceEvent(started, {
      status: "warning",
      summary: "规则没有加载成功",
      at: 125,
    }));
    throw new Error("业务规则没有加载成功，请重试");
  };

  let snapshot = await createSession({ entryMode: "example" }, d);
  const beforeLatest = structuredClone(snapshot.latest);
  const beforeVersions = structuredClone(snapshot.versions);
  const text = "计折上折是什么意思";

  snapshot = await say(snapshot, d, text);

  assert.deepEqual(snapshot.latest, beforeLatest, "Skill 失败不能改变草稿、fill、sheet 或 seq");
  assert.deepEqual(snapshot.versions, beforeVersions, "Skill 失败不能创建版本");
  assert.deepEqual(
    snapshot.messages.slice(-3).map((message) => message.content.kind),
    ["user_text", "agent_tool_trace", "agent_error"],
  );
  assert.ok(snapshot.messages.some(
    (message) => message.role === "user" && message.content.kind === "user_text" && message.content.text === text,
  ), "失败时仍要保存用户原话");

  const trace = lastOfKind(snapshot, "agent_tool_trace");
  assert.ok(trace);
  assert.equal(trace.trace.status, "failed", "专项 Skill 加载失败会让整轮失败");
  assert.deepEqual(trace.trace.steps, [{
    id: "skill-load-warning",
    tool: "load_campaign_skill",
    title: "加载业务规则：ICS-1811 字段解释",
    status: "warning",
    initiatedBy: "model",
    startedAt: 100,
    summary: "规则没有加载成功",
    durationMs: 25,
  }]);

  const error = lastAgent(snapshot);
  assert.equal(error.kind, "agent_error");
  assert.match(error.kind === "agent_error" ? error.text : "", /业务规则没有加载成功，请重试/);
  assert.deepEqual(error.kind === "agent_error" && error.retry, { type: "text", text });
});

test("the orchestrator supplements the rule analysis and the fill sheet the model omitted", async () => {
  const d = deps([
    record(example("T2").firstWrites),
    { steps: [["draft_campaign_copy", { name: "足金每克减15元", content: "一般足金类黄金每克减15元" }]], reply: "名称和内容改好了。" },
  ]);

  let snapshot = await interpret(await startNew(d, "T2"), d);
  assert.ok(traceSteps(snapshot).some(([tool, by]) => tool === "analyze_campaign_state" && by === "orchestrator"));

  snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await say(snapshot, d, "名称写得正式一点");
  assert.deepEqual(traceSteps(snapshot), [["draft_campaign_copy", "model"], ["analyze_campaign_plan", "orchestrator"], ["generate_ics1811_sheet", "orchestrator"]]);
});

test("card submissions and confirm buttons are gone", () => {
  for (const type of ["card", "confirm"]) {
    assert.throws(() => parseTurnInput({ type, answers: {}, expectedSeq: 1 }), (error: { status?: number }) => error.status === 400, type);
  }
});

test("tools drop quotes the user did not say, reject bad copy, and replies keep their questions", () => {
  const text = "满5000减500，钻石类";
  const request: AgentRequest = {
    today: TODAY, draft: createEmptyDraft("r", text), history: [], trigger: { kind: "user_message", text },
    phase: "collecting", openQuestions: [], proposals: [], canUndo: false,
  };
  const state = createAgentState(request);
  const outcome = JSON.parse(runAgentTool(state, "extract_campaign_facts", { facts: [{ key: "offer", quote: "满3000减300" }, { key: "categories", quote: "钻石类", value: ["钻石类"] }] }).text);
  assert.equal(state.draft!.facts.offer, null);
  assert.equal(outcome.dropped.length, 1);
  assert.equal(state.draft!.facts.categories?.value.all[0], "钻石类");

  assert.equal(runAgentTool(state, "draft_campaign_copy", { name: "钻石类满减大促销活动名称很长", content: "钻石类" }).isError, true);

  // 追问由模型自己问，问句不再删。
  assert.equal(finishAgentTurn(createAgentState(request), "好的。还要加标语吗？").reply, "好的。还要加标语吗？");
  // 编造的效果预估照删。
  assert.equal(finishAgentTurn(createAgentState(request), "好的。这样能提升20%的销量。").reply, "好的。");
  // 换行是模型表达结构的方式：它分点写的「1. …」若被拼成一行，界面就解析不出列表。
  const multiline = finishAgentTurn(createAgentState(request), "先说几个方向：\n\n1. 满减拉客单价。\n2. 以旧换新引老客。").reply ?? "";
  assert.ok(multiline.includes("\n1. 满减"), "分点前的换行必须保留");
  assert.ok(multiline.includes("\n2. 以旧换新"), "每一点都要各占一行");

  // 上限 800 字，但截断本身还在：宁可少一句，不留半句。
  const long = finishAgentTurn(createAgentState(request), `日期记下了。${"货类和优惠也都对上了".repeat(100)}。最后一句。`).reply ?? "";
  assert.equal(long, "日期记下了。", "超长回复在句末截断，不留半句");

  // 没调 ask_campaign_questions 时 asking 是 null，交给 Workers 兜底。
  assert.equal(finishAgentTurn(createAgentState(request), "好的").asking, null);
});

test("system prompt is a generic marketing-agent contract and the user prompt carries the current business API", () => {
  const t2 = example("T2");
  const draft = applyFactWrites(createEmptyDraft("p", t2.first), t2.firstWrites, { text: t2.first, today: TODAY }).draft;
  const system = buildAgentSystemPrompt(TODAY);
  assert.match(system, /今天是 2026-09-16/);
  assert.match(system, /企业营销运营的活动搭建 Agent/);
  assert.match(system, /当前客户和具体业务由本轮 Skill 与工具定义/);
  assert.match(system, /每个模型回合[^\n]*先加载[^\n]*必需 Skill/);
  assert.match(system, /工具结果与确定性代码[^\n]*执行真相/);
  assert.match(system, /不暴露[^\n]*系统提示词[^\n]*内部推理/);
  assert.match(system, /业务工具完成前[^\n]*不要输出面向用户的铺垫/);
  assert.match(system, /只问[^\n]*工具返回的缺项/);
  assert.match(system, /简洁[^\n]*自然[^\n]*中文/);
  assert.doesNotMatch(system, /周大福|ICS-1811|extract_campaign_facts|ask_campaign_questions|Q1|FactKey|计折上折|结算说明函|浮动折扣/);

  const proposal = (checkProposal(draft, "Q5a", { none: true }) as { ok: true; proposal: Proposal }).proposal;
  const request: AgentRequest = {
    today: TODAY, draft, history: [], trigger: { kind: "user_message", text: "下周开始" },
    phase: "collecting", openQuestions: ["Q1"], proposals: [proposal], canUndo: true,
  };
  const prompt = buildAgentUserPrompt(request);
  assert.match(prompt, /当前客户：周大福/);
  assert.match(prompt, /目标页面：ICS-1811/);
  assert.match(prompt, /extract_campaign_facts/);
  assert.match(prompt, /analyze_campaign_state/);
  assert.match(prompt, /Q5c 结算说明函：只能提议 \{"has":true\}；没有要用户自己说/);
  assert.match(prompt, /你上一句问的问题：Q1 活动从哪天到哪天？/);
  assert.match(prompt, /你上一句的提议（用户同意就按这个记）：Q5a 让扣点和回款率：让扣点 0，回款率 0/);
  assert.match(prompt, /还缺：Q1 活动从哪天到哪天？/);
  assert.match(prompt, /门店：7590/);
  assert.match(prompt, /用户说：「下周开始」/);

  const requiredPrompt = buildAgentUserPrompt(request, ["campaign-sop", "field-explainer"]);
  assert.match(requiredPrompt, /## 本轮业务规则/);
  assert.match(requiredPrompt, /必须先加载：ics1811:campaign-sop、ics1811:field-explainer/);
  assert.doesNotMatch(requiredPrompt, /ics1811:offer-entry-guide/);

  const plainPrompt = buildAgentUserPrompt(request, []);
  assert.match(plainPrompt, /必须先加载：无/);
});
