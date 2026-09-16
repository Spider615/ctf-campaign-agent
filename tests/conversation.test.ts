import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../app/lib/agent/prompt.ts";
import type { AgentRequest, AgentResult } from "../app/lib/agent/protocol.ts";
import { createAgentState, finishAgentTurn, runAgentTool, type AgentToolName } from "../app/lib/agent/tools.ts";
import { EXAMPLES } from "../app/lib/campaign/ics1811/examples.ts";
import { applyFactWrites, createEmptyDraft, type FactWrite } from "../app/lib/campaign/ics1811/facts.ts";
import type { StoredMessage } from "../app/lib/campaign/ics1811/messages.ts";
import { createMemoryStore } from "../app/lib/server/session-store.ts";
import { createSession, runTurn, type Snapshot, type TurnDeps } from "../app/lib/server/turns.ts";
import { finishTraceEvent, startTraceEvent, type AgentTraceEvent } from "../app/lib/tool-trace.ts";

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
const record = (writes: FactWrite[]): Script => ({ steps: [["extract_campaign_facts", { facts: writes }]], reply: "记下了。" });
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

test("submitting the card reads back as a sentence the user could have typed", async () => {
  const d = deps([record(example("T2").firstWrites)]);
  let snapshot = await interpret(await startNew(d, "T2"), d);
  assert.deepEqual(cardIds(snapshot), ["Q1", "Q5a", "Q5b", "Q6a"]);

  snapshot = await submit(snapshot, d, {
    Q1: { start: "2026-10-01", end: "2026-10-07" },
    Q5a: { none: true },
    Q5b: { commission: "price_times_discount" },
    Q6a: { wanted: false },
  });

  const card = lastOfKind(snapshot, "agent_round_card")!;
  const submitted = lastOfKind(snapshot, "user_card_submit")!;
  // 选项提交只是替用户省了打字，结果在对话里要长得跟用户自己打的一样：
  // 问题原话带着问号，答案紧跟在后面，顺序照卡片上的顺序。
  // 只取第一问：标题后面常跟着填写提示或追加问句，拼进去会把话截断。
  const firstAsk = (title: string) => (title.includes("？") ? `${title.split("？")[0]}？` : title);
  for (const question of card.questions) {
    assert.ok(submitted.label.includes(firstAsk(question.title)), `拼接里要有问题「${firstAsk(question.title)}」`);
  }
  assert.ok(submitted.label.startsWith(firstAsk(card.questions[0].title)), "第一段就是卡片上的第一个问题");
  // 锁住截断本身：Q5a 标题里的这句填写提示不能跟着拼进用户消息里。
  assert.doesNotMatch(submitted.label, /没有就都填 0。/);
  // 不再是「字段名：值」那种系统标签写法（原来是「让扣点和回款率：没有」）。
  assert.doesNotMatch(submitted.label, /^[^？]+：/);
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

test("a typed answer that triggers a new follow-up opens the next round, and a short reply answers it", async () => {
  const t5 = example("T5");
  const typed = t5.turns[0];
  if (typed.kind !== "text") throw new Error("T5 的第一轮应该是打字回答");
  const d = deps([record(t5.firstWrites), record(typed.writes), record([{ key: "discountEditable", quote: "可以改" }])]);
  let snapshot = await interpret(await startNew(d, "T5"), d);
  const firstCard = snapshot.flow.openCardId;

  snapshot = await say(snapshot, d, typed.text);
  const second = lastOfKind(snapshot, "agent_round_card")!;
  assert.deepEqual([second.round, second.questions.map((question) => question.id)], [2, ["Q3b"]], "卡片上没有的新追问要问出来");
  assert.notEqual(snapshot.flow.openCardId, firstCard);

  snapshot = await say(snapshot, d, "可以改。");
  assert.deepEqual(d.requests[2].openQuestions, ["Q3b"]);
  assert.equal(snapshot.latest.draft.facts.discountEditable?.value, true);
  assert.equal(snapshot.flow.phase, "readback");
});

test("a request that has not said how to discount asks for the offer instead of calling it out of scope", async () => {
  const text = "想在3319店搞个黄金活动";
  const d = deps([record([{ key: "stores", quote: "3319店", value: ["3319"] }])]);
  const snapshot = await interpret(await createSession({ entryMode: "new", text }, d), d);
  assert.equal(snapshot.flow.phase, "asking");
  assert.ok(cardIds(snapshot)?.includes("Q3"));
});

test("an activity without any priced offer is explained once, by the code", async () => {
  const d = deps([{ steps: [], reply: "抽奖这类活动 1811 录不了。" }]);
  const snapshot = await interpret(await createSession({ entryMode: "new", text: "7590门店国庆搞个抽奖活动" }, d), d);
  assert.equal(snapshot.flow.phase, "out_of_scope");
  const texts = snapshot.messages.flatMap((message) => (message.content.kind === "agent_text" ? [message.content.text] : []));
  assert.equal(texts.length, 1);
  assert.match(texts[0], /不在 1811 优惠开单范围/);
});

test("the readback separates what decides confirmation from what is just defaults", async () => {
  const snapshot = await createSession({ entryMode: "example" }, deps());
  const readback = lastOfKind(snapshot, "agent_readback")!.readback;

  // 决定「要不要确认」的几件事必须在 essentials 里。
  const essentials = readback.essentials.join("；");
  for (const probe of ["黄金每克减15", "5 月 1 日", "7590", "每克减 15"]) {
    assert.ok(essentials.includes(probe), `结论部分要包含「${probe}」：${essentials}`);
  }

  // 「按默认」这类不影响判断的，挪到 defaults，别和上面平铺在一起。
  for (const probe of ["付款方式", "活动分组", "是否凭券使用"]) {
    assert.ok(!essentials.includes(probe), `「${probe}」不该占据结论部分：${essentials}`);
    assert.ok(readback.defaults.join("；").includes(probe), `「${probe}」应收进默认项`);
  }

  // 要为「确认与否」而读的内容应当明显变少。
  // 不要求更激进：再往下砍就得藏起明细或日期，而那些正是决定确认的内容——
  // 隐藏决策内容的审批卡片只是表演，折叠该折叠的就够了。
  assert.ok(
    essentials.length <= readback.paragraph.length * 0.6,
    `为做决定要读 ${essentials.length} 字 / 整段 ${readback.paragraph.length} 字，没有真正瘦下来`,
  );
  assert.ok(readback.defaults.length >= 4, "按默认的项应该成批折叠，而不是零星几条");
  // 整段保留，复制和旧会话还要用。
  assert.ok(readback.paragraph.includes("确认无误后生成填写内容"));
});

test("复述要说清名称和内容不是用户写的，确认才是知情的", async () => {
  const { buildReadback } = await import("../app/lib/campaign/ics1811/readback.ts");
  const { deriveFill } = await import("../app/lib/campaign/ics1811/derive.ts");
  const { checkDraft } = await import("../app/lib/campaign/ics1811/checks.ts");
  const t1 = example("T1");
  const base = applyFactWrites(createEmptyDraft("c", t1.first), t1.firstWrites, { text: t1.first, today: TODAY }).draft;

  const readbackOf = (draft: typeof base) => {
    const fill = deriveFill(draft);
    return buildReadback(draft, fill, checkDraft(draft, fill, TODAY), []);
  };

  // 模板拼的：确认时用户应当知道这两段不是自己说的。
  const fromTemplate = readbackOf(base).essentials[0];
  assert.match(fromTemplate, /活动名称「黄金每克减15」/);
  assert.match(fromTemplate, /模板/, `模板生成要标明出处：${fromTemplate}`);

  // 模型起草的：标注要和模板区分开，因为二者的失败方式不同。
  const drafted = { ...base, copy: { name: "足金每克减15元", content: "一般足金类黄金每克减15元", source: "ai" as const } };
  const fromModel = readbackOf(drafted).essentials[0];
  assert.match(fromModel, /活动名称「足金每克减15元」/);
  assert.match(fromModel, /模型/, `模型起草要标明出处：${fromModel}`);
  assert.notEqual(fromTemplate.replace(/「[^」]*」/g, ""), fromModel.replace(/「[^」]*」/g, ""), "模板和模型起草的标注不能一样");

  // 用户自己改过的不该再被标成 AI 写的。
  const byUser = { ...base, copy: { name: "足金每克减15元", content: "一般足金类黄金每克减15元", source: "user" as const } };
  const fromUser = readbackOf(byUser).essentials[0];
  assert.doesNotMatch(fromUser, /模型|模板/, `用户写的不该标成 AI 产出：${fromUser}`);
});

test("readback notes name the field they are about", async () => {
  const snapshot = await createSession({ entryMode: "example" }, deps());
  const attention = lastOfKind(snapshot, "agent_readback")!.readback.attention.map((item) => item.text);
  for (const label of ["是否参与打折", "预售时间", "是否凭券使用"]) assert.ok(attention.some((text) => text.startsWith(label)), `复述提示里要写明「${label}」`);
});

test("the readback leads with a one-line summary so the card can stay small", async () => {
  const snapshot = await createSession({ entryMode: "example" }, deps());
  const readback = lastOfKind(snapshot, "agent_readback")!.readback;
  assert.ok(readback.summary, "复述要有一句话结论，卡片才能瘦下来");
  assert.ok([...readback.summary].length <= 40, `结论不能超过 40 字，现在 ${[...readback.summary].length} 字：${readback.summary}`);
  assert.ok(readback.summary.includes("黄金每克减15"), `结论里要有活动名称：${readback.summary}`);
  assert.ok(readback.paragraph.length > readback.summary.length, "完整复述仍然保留，只是默认折叠");
});

test("a change after the readback asks the new follow-up question in a new round", async () => {
  const d = deps([record([{ key: "offer", quote: "满5000减500" }])]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await say(snapshot, d, "改成满5000减500");
  assert.deepEqual(cardIds(snapshot), ["Q3c"]);
  assert.equal(lastOfKind(snapshot, "agent_round_card")?.round, 1);
  await assert.rejects(() => confirm(snapshot, d), (error: { status?: number }) => error.status === 409, "复述已过期时不能确认");
});

test("confirming in chat goes through confirm_campaign_readback", async () => {
  const d = deps([{ steps: [["confirm_campaign_readback"]], reply: "好的，填写值生成了。" }]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await say(snapshot, d, "确认，没问题");
  assert.ok(lastOfKind(snapshot, "agent_fill_sheet"));
  assert.equal(d.requests[0].readbackSeq, 1);
  assert.equal(d.requests[0].canConfirm, true);
});

test("undo in chat restores the previous version", async () => {
  const d = deps([record([{ key: "offer", quote: "每克减20元" }]), { steps: [["undo_campaign_change"]], reply: "撤销了。" }]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await say(snapshot, d, "改成每克减20元");
  assert.equal(snapshot.latest.draft.facts.offer?.value.items[0].amount, 20);
  snapshot = await say(snapshot, d, "撤销");
  assert.equal(snapshot.latest.draft.facts.offer?.value.items[0].amount, 15);
  assert.equal(lastOfKind(snapshot, "agent_change")?.title, "已撤销");
});

test("model-drafted copy is kept until the facts it describes change", async () => {
  const d = deps([
    { steps: [["draft_campaign_copy", { name: "足金每克减15元", content: "一般足金类黄金每克减15元" }]], reply: "名称改好了。" },
    record([{ key: "offer", quote: "每克减20元" }]),
  ]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await say(snapshot, d, "名称写得正式一点");
  assert.equal(snapshot.latest.fill.info.name.value, "足金每克减15元");
  snapshot = await say(snapshot, d, "改成每克减20元");
  assert.deepEqual([snapshot.latest.draft.copy, snapshot.latest.fill.info.name.value], [null, "黄金每克减20"]);
});

test("changing a fact the copy never mentions keeps the model-drafted name", async () => {
  const d = deps([
    { steps: [["draft_campaign_copy", { name: "足金每克减15元", content: "一般足金类黄金每克减15元" }]], reply: "名称改好了。" },
    record([{ key: "stores", quote: "3319门店", value: ["3319"] }]),
  ]);
  let snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await say(snapshot, d, "名称写得正式一点");
  assert.equal(snapshot.latest.fill.info.name.value, "足金每克减15元");

  // 门店不出现在名称和内容里，改门店不该把模型起草的文案抹回模板。
  snapshot = await say(snapshot, d, "改成3319门店");
  assert.equal(snapshot.latest.draft.copy?.source, "ai", "改门店后模型起草的文案要保住");
  assert.equal(snapshot.latest.fill.info.name.value, "足金每克减15元");
  assert.equal(snapshot.latest.fill.info.name.basis, "模型起草");
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

test("real tool events stream once and persist before the related Agent output", async () => {
  const d = deps([record(example("T2").firstWrites)]);
  const runAgent = d.runAgent;
  const seen: AgentTraceEvent[] = [];
  d.emitTrace = (event) => seen.push(event);
  d.runAgent = async (request, onTrace) => {
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
  ]);
  const kinds = snapshot.messages.map((message) => message.content.kind);
  const traceIndex = kinds.indexOf("agent_tool_trace");
  assert.ok(traceIndex >= 0);
  assert.ok(traceIndex < kinds.indexOf("agent_text"), "工具记录要排在相关 Agent 输出之前");
  assert.equal(snapshot.messages.filter((message) => message.content.kind === "agent_tool_trace").length, 1);
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
  assert.equal(snapshot.flow.pendingInterpretation, true);
  assert.deepEqual(lastAgent(snapshot).kind, "agent_error");
});

test("button confirmation persists deterministic confirmation and sheet tools", async () => {
  const d = deps();
  const snapshot = await confirm(await createSession({ entryMode: "example" }, d), d);
  const trace = lastOfKind(snapshot, "agent_tool_trace")?.trace;
  assert.deepEqual(trace?.steps.map((step) => [step.tool, step.initiatedBy]), [
    ["confirm_campaign_readback", "orchestrator"],
    ["generate_ics1811_sheet", "orchestrator"],
  ]);
});

test("the orchestrator supplements required rule and readback tools the model omitted", async () => {
  const t2 = example("T2");
  const d = deps([
    record(t2.firstWrites),
    { steps: [["draft_campaign_copy", { name: "足金每克减15元", content: "一般足金类黄金每克减15元" }]], reply: "名称和内容改好了。" },
  ]);

  let snapshot = await interpret(await startNew(d, "T2"), d);
  let trace = lastOfKind(snapshot, "agent_tool_trace")?.trace;
  assert.ok(trace?.steps.some((step) => step.tool === "analyze_campaign_state" && step.initiatedBy === "orchestrator"));

  snapshot = await createSession({ entryMode: "example" }, d);
  snapshot = await say(snapshot, d, "名称写得正式一点");
  trace = lastOfKind(snapshot, "agent_tool_trace")?.trace;
  assert.ok(trace?.steps.some((step) => step.tool === "build_campaign_readback" && step.initiatedBy === "orchestrator"));
});

test("tools drop quotes the user did not say, reject bad copy and only confirm a confirmable readback", () => {
  const text = "满5000减500，钻石类";
  const request: AgentRequest = {
    today: TODAY, draft: createEmptyDraft("r", text), history: [], trigger: { kind: "user_message", text },
    phase: "asking", roundsUsed: 1, openQuestions: [], readbackSeq: null, canConfirm: false, canUndo: false,
  };
  const state = createAgentState(request);
  const outcome = JSON.parse(runAgentTool(state, "extract_campaign_facts", { facts: [{ key: "offer", quote: "满3000减300" }, { key: "categories", quote: "钻石类", value: ["钻石类"] }] }).text);
  assert.equal(state.draft.facts.offer, null);
  assert.equal(outcome.dropped.length, 1);
  assert.equal(state.draft.facts.categories?.value.all[0], "钻石类");

  assert.equal(runAgentTool(state, "draft_campaign_copy", { name: "钻石类满减大促销活动名称很长", content: "钻石类" }).isError, true);
  assert.equal(runAgentTool(state, "confirm_campaign_readback").isError, true);

  const confirmable = createAgentState({ ...request, draft: applyFactWrites(createEmptyDraft("c", "确认"), [], { text: "确认", today: TODAY }).draft, trigger: { kind: "user_message", text: "确认" }, readbackSeq: 3, canConfirm: true });
  assert.equal(runAgentTool(confirmable, "confirm_campaign_readback").isError, undefined);
  // 卡片开着时系统正在问用户，模型再问会和卡片重复、打乱两轮限制，问句要删。
  const whileAsking = createAgentState({ ...request, openQuestions: ["Q6a"] });
  assert.equal(finishAgentTurn(whileAsking, "好的。还要加标语吗？").reply, "好的。");
  // 没有卡片时放它正常说话：「这样理解对吗」这类澄清是对话该有的样子，
  // 一刀切删问句正是它显得死板的来源。
  assert.equal(finishAgentTurn(confirmable, "好的。还要加标语吗？").reply, "好的。还要加标语吗？", "没有卡片时不删问句");
  // 换行是模型表达结构的方式：它分点写的「1. …」若被拼成一行，界面就解析不出列表。
  // 这条锁住的是一次真实故障——切句正则把 \n 排除在外，重新拼接时换行被静默删光。
  const multiline = finishAgentTurn(createAgentState(request), "先说几个方向：\n\n1. 满减拉客单价。\n2. 以旧换新引老客。").reply ?? "";
  assert.ok(multiline.includes("\n1. 满减"), "分点前的换行必须保留");
  assert.ok(multiline.includes("\n2. 以旧换新"), "每一点都要各占一行");

  // 上限放宽到 800 字（实测模型自然输出 420-440 字），但截断本身还在：宁可少一句，不留半句。
  const long = finishAgentTurn(createAgentState(request), `日期记下了。${"货类和优惠也都对上了".repeat(100)}。最后一句。`).reply ?? "";
  assert.equal(long, "日期记下了。", "超长回复在句末截断，不留半句");
});

test("prompts carry today, the open questions and the recorded facts", () => {
  const t2 = example("T2");
  const draft = applyFactWrites(createEmptyDraft("p", t2.first), t2.firstWrites, { text: t2.first, today: TODAY }).draft;
  assert.match(buildAgentSystemPrompt(TODAY), /今天是 2026-09-16/);
  assert.match(buildAgentSystemPrompt(TODAY), /extract_campaign_facts 后必须调用 analyze_campaign_state/);
  assert.doesNotMatch(buildAgentSystemPrompt(TODAY), /\bupdate_fields\b/);
  const prompt = buildAgentUserPrompt({
    today: TODAY, draft, history: [], trigger: { kind: "user_message", text: "下周开始" },
    phase: "asking", roundsUsed: 1, openQuestions: ["Q1"], readbackSeq: null, canConfirm: false, canUndo: true,
  });
  assert.match(prompt, /正在问用户的问题：活动从哪天到哪天？/);
  assert.doesNotMatch(buildAgentSystemPrompt(TODAY), /系统会出卡片/);
  // 模型曾承诺「帮你按区域拆成 3 张单」，没有工具能拆单，它就一直空转到 120s 超时。
  // 这两句是那次的修复，删掉会让同样的超时重新出现，所以在这里盯住。
  assert.match(buildAgentSystemPrompt(TODAY), /不能拆单/);
  assert.match(buildAgentSystemPrompt(TODAY), /一个活动只能选一个区域/);
  assert.match(prompt, /门店：7590/);
  assert.match(prompt, /用户说：「下周开始」/);
});
