import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createAgentHttpHandler } from "../agent/http-handler.ts";
import { createAttachmentsHttpHandler, type ConversationRunner } from "../agent/attachments/http.ts";
import type { AttachmentStore } from "../agent/attachments/store.ts";
import { createModelEdge } from "../agent/usage/model-edge.ts";
import { setUsageRecorder, turnBaseUrl } from "../agent/usage/context.ts";
import { createUsageStore, type UsageStore } from "../agent/usage/store.ts";
import { PLAN_ANSWER_V4_SCHEMA } from "../app/lib/analytics/analysis-v2-types.ts";
import { simulatedPlanAnswerV4 } from "./helpers/plan-answer.ts";
import { httpAnalyticsDatabase } from "./helpers/analytics-http.ts";
import type { AnalyticsSkillRunner } from "../agent/analytics-runner-types.ts";
import { createCampaignDraft } from "../app/lib/campaign/workspace.ts";

const OWNER = "33333333-3333-4333-8333-333333333333";
const CONVERSATION = "44444444-4444-4444-8444-444444444444";
const DAY = { from: "2000-01-01", to: "2100-01-01" };

async function listen(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "usage-http-"));
  const path = join(dir, "usage.sqlite");
  const store = createUsageStore(path);
  setUsageRecorder(store);
  const edge = createModelEdge({ upstream: "https://api.deepseek.com/anthropic", fetch: async () => Response.json({ id: `msg_${crypto.randomUUID()}`, model: "deepseek-flash", usage: { input_tokens: 10, output_tokens: 2 } }) });
  const modelBase = await edge.listen();
  t.after(async () => { setUsageRecorder(undefined); await edge.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  // 假运行器：照真实运行器的做法用 turnBaseUrl 拼地址，发一次模型请求。
  const callModel = async (source: string) => { await (await fetch(`${turnBaseUrl(modelBase, source)}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6" }) })).json(); };
  return { store, path, callModel };
}

const analyticsHeaders = { "content-type": "application/json", "x-analytics-answer-schema": PLAN_ANSWER_V4_SCHEMA, "x-ctf-visitor": OWNER, "x-ctf-conversation": CONVERSATION };
const ask = (base: string, question: string, extra: Record<string, string> = {}, path = "/analytics/database/explain") => fetch(`${base}${path}`, { method: "POST", headers: { ...analyticsHeaders, ...extra }, body: JSON.stringify({ mode: "database", question, history: [] }) });

function analyticsHandler(store: UsageStore, runner: AnalyticsSkillRunner) {
  return createAgentHttpHandler({ token: "", model: "test", channel: "deepseek", usage: store, database: httpAnalyticsDatabase(), logger: { log() {}, error() {} },
    runAgentTurn: async () => { throw new Error("不调用活动"); }, runPlanAnalyticsTurn: runner });
}

test("直接问答一轮：问题、公开回复、轨迹和请求都挂在同一轮", async (t) => {
  const { store, callModel } = await setup(t);
  const base = await listen(t, analyticsHandler(store, async (_request, _signal, emit) => {
    emit?.({ type: "trace", event: { id: "s1", tool: "analyze", title: "查数据", status: "completed", initiatedBy: "model", startedAt: Date.now(), durationMs: 5 } });
    await callModel("analysis");
    return simulatedPlanAnswerV4();
  }));
  // 执行轨迹只在流式入口有（JSON 入口不给运行器 emit）。
  const response = await ask(base, "八月销售额多少", {}, "/analytics/database/explain/stream");
  assert.equal(response.status, 200); await response.text();
  const detail = store.conversation(`analysis:${CONVERSATION}`);
  assert.equal(detail?.turns.length, 1);
  const [turn] = detail!.turns;
  assert.equal(turn.question, "八月销售额多少");
  assert.equal(turn.status, "answered");
  assert.ok(turn.reply && turn.reply.length > 0);
  assert.equal(turn.trace?.[0].title, "查数据");
  assert.equal(turn.requests.length, 1);
  assert.equal(turn.requests[0].inputTokens, 10);
  assert.equal(turn.sdkStarts, 1);
  assert.equal(turn.channel, "deepseek");
});

test("同一会话两次提问是两轮", async (t) => {
  const { store, callModel } = await setup(t);
  const base = await listen(t, analyticsHandler(store, async () => { await callModel("analysis"); return simulatedPlanAnswerV4(); }));
  await (await ask(base, "八月")).text();
  await (await ask(base, "那九月呢")).text();
  const detail = store.conversation(`analysis:${CONVERSATION}`);
  assert.deepEqual(detail?.turns.map((turn) => turn.question), ["八月", "那九月呢"]);
  assert.ok(detail?.turns.every((turn) => turn.requests.length === 1));
});

test("暂无法回答记为失败而不是部分", async (t) => {
  const { store } = await setup(t);
  const base = await listen(t, analyticsHandler(store, async () => ({ ...simulatedPlanAnswerV4(), status: "unavailable" })));
  await (await ask(base, "八月")).text();
  assert.equal(store.conversation(`analysis:${CONVERSATION}`)?.turns[0].status, "failed");
});

test("部分回答记为部分", async (t) => {
  const { store } = await setup(t);
  const base = await listen(t, analyticsHandler(store, async () => ({ ...simulatedPlanAnswerV4(), status: "partial" })));
  await (await ask(base, "八月")).text();
  assert.equal(store.conversation(`analysis:${CONVERSATION}`)?.turns[0].status, "partial");
});

test("运行器抛错记为失败且保留已发生的请求", async (t) => {
  const { store, callModel } = await setup(t);
  const base = await listen(t, analyticsHandler(store, async () => { await callModel("analysis"); throw new Error("Claude API 返回 500"); }));
  assert.equal((await ask(base, "八月")).status, 502);
  const [turn] = store.conversation(`analysis:${CONVERSATION}`)!.turns;
  assert.equal(turn.status, "failed");
  assert.equal(turn.error, "Agent 执行出错", "只存清洗后的公开错误文案");
  assert.equal(turn.requests.length, 1);
});

test("客户端断开记为取消", async (t) => {
  const { store } = await setup(t);
  let started!: () => void; const running = new Promise<void>((resolve) => { started = resolve; });
  const base = await listen(t, analyticsHandler(store, (_request, signal) => new Promise((_resolve, reject) => {
    started(); signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })));
  const client = new AbortController();
  const pending = fetch(`${base}/analytics/database/explain/stream`, { method: "POST", headers: analyticsHeaders, body: JSON.stringify({ mode: "database", question: "八月", history: [] }), signal: client.signal }).then((response) => response.text()).catch(() => undefined);
  await running; client.abort(); await pending;
  for (let i = 0; i < 100 && store.conversation(`analysis:${CONVERSATION}`)?.turns[0].status === "running"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.conversation(`analysis:${CONVERSATION}`)?.turns[0].status, "cancelled");
});

test("登记的运行：断开连接照常跑完记完成，点停止才记取消", async (t) => {
  const { store, callModel } = await setup(t);
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const base = await listen(t, analyticsHandler(store, async (_request, signal) => {
    await callModel("analysis");
    await Promise.race([gate, new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))]);
    return simulatedPlanAnswerV4();
  }));
  const start = (runId: string, conversation: string) => {
    const client = new AbortController();
    void fetch(`${base}/analytics/database/explain/stream`, { method: "POST", signal: client.signal, headers: { ...analyticsHeaders, "x-conversation": conversation, "x-ctf-conversation": conversation, "x-analytics-owner": OWNER, "x-analytics-run-id": runId }, body: JSON.stringify({ mode: "database", question: "八月", history: [] }) }).then((response) => response.text()).catch(() => undefined);
    return client;
  };
  const RUN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; const RUN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const status = (conversation: string) => store.conversation(`analysis:${conversation}`)?.turns[0]?.status;
  const wait = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); assert.ok(check()); };
  const first = start(RUN_A, "conv-a");
  await wait(() => status("conv-a") === "running");
  first.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(status("conv-a"), "running", "断开连接不算取消");
  start(RUN_B, "conv-b");
  await wait(() => status("conv-b") === "running");
  await fetch(`${base}/analytics/runs/${RUN_B}/cancel`, { method: "POST", headers: { "x-analytics-owner": OWNER } });
  await wait(() => status("conv-b") === "cancelled");
  release();
  await wait(() => status("conv-a") === "answered");
});

test("登记的运行用运行自己的停止信号记录轮次", () => {
  const source = readFileSync(new URL("../agent/http-handler.ts", import.meta.url), "utf8");
  const run = source.slice(source.indexOf("analyticsRuns.start(runId"), source.indexOf("analyticsRuns.subscribe(runId", source.indexOf("analyticsRuns.start(runId")));
  assert.match(run, /record\([\s\S]*?, signal\)/, "运行里的 record 必须传运行的 signal");
  assert.doesNotMatch(run, /requestController\.signal/);
});

test("附件问答里嵌套的分析请求算在同一轮", async (t) => {
  const { store, callModel } = await setup(t);
  const runConversation: ConversationRunner = async (_scope, body) => {
    await callModel("attachments");
    await callModel("analysis-plan");
    return { schema: "conversation-answer/v1", status: "answered", blocks: [{ text: "方案里写了预算。", sourceIds: ["s1"] }], limitations: [],
      sources: [{ id: "s1", attachmentId: body.attachmentIds[0], version: "a".repeat(64), name: "方案.docx", location: "第1段", kind: "document", excerpt: "预算300元" }] };
  };
  const files = { get: async () => ({}) } as unknown as AttachmentStore;
  const base = await listen(t, createAttachmentsHttpHandler({ store: files, runConversation, usage: store, channel: "deepseek" }));
  const response = await fetch(`${base}/attachments/answer?conversationId=${CONVERSATION}`, { method: "POST", headers: { "content-type": "application/json", "x-attachments-owner": OWNER }, body: JSON.stringify({ conversationId: CONVERSATION, question: "文件里说了什么", attachmentIds: ["55555555-5555-4555-8555-555555555555"], history: [] }) });
  assert.equal(response.status, 200, await response.clone().text());
  const detail = store.conversation(`attachments:${CONVERSATION}`);
  assert.equal(detail?.turns.length, 1);
  assert.deepEqual(detail?.turns[0].requests.map((item) => item.source).sort(), ["analysis-plan", "attachments"]);
  assert.equal(detail?.turns[0].status, "answered");
});

test("访客只存哈希", async (t) => {
  const { store, path } = await setup(t);
  const base = await listen(t, analyticsHandler(store, async () => simulatedPlanAnswerV4()));
  await (await ask(base, "八月")).text();
  const visitor = store.conversations(DAY)[0].visitor;
  assert.match(visitor ?? "", /^[0-9a-f]{12}$/);
  const files = [path, `${path}-wal`].filter((file) => { try { readFileSync(file); return true; } catch { return false; } });
  assert.ok(files.length > 0);
  for (const file of files) assert.ok(!readFileSync(file).toString("latin1").includes(OWNER));
});

test("会话编号不合法时不记会话，按单轮显示", async (t) => {
  const { store } = await setup(t);
  const base = await listen(t, analyticsHandler(store, async () => simulatedPlanAnswerV4()));
  await (await ask(base, "八月", { "x-ctf-conversation": "../../etc" })).text();
  const [row] = store.conversations(DAY);
  assert.match(row.key, /^analysis:turn:/);
});

test("活动回合按活动编号记，问题取用户原话", async (t) => {
  const { store, callModel } = await setup(t);
  const base = await listen(t, createAgentHttpHandler({ token: "", model: "test", channel: "deepseek", usage: store, logger: { log() {}, error() {} },
    runAgentTurn: async (request) => { await callModel("campaign"); return { draft: request.draft, reply: "好的，活动从哪天开始？", tools: [], dropped: [] } as never; } }));
  const body = { today: "2026-10-26", campaign: createCampaignDraft("campaign-abc", "金色星期二满减"), draft: null, history: [], trigger: { kind: "first_message", text: "金色星期二满减" },
    campaignStage: "briefing", ics1811Phase: null, openQuestions: [], proposals: [], canUndo: false };
  const response = await fetch(`${base}/turn`, { method: "POST", headers: { "content-type": "application/json", "x-ctf-visitor": OWNER, "x-ctf-conversation": "campaign-abc" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text());
  await response.text();
  const [turn] = store.conversation("campaign:campaign-abc")!.turns;
  assert.equal(turn.question, "金色星期二满减");
  assert.equal(turn.reply, "好的，活动从哪天开始？");
  assert.equal(turn.requests[0].source, "campaign");
});

test("没配用量库时入口行为不变", async (t) => {
  const base = await listen(t, createAgentHttpHandler({ token: "", model: "test", database: httpAnalyticsDatabase(), logger: { log() {}, error() {} },
    runAgentTurn: async () => { throw new Error("不调用活动"); }, runPlanAnalyticsTurn: async () => simulatedPlanAnswerV4() }));
  assert.equal((await ask(base, "八月")).status, 200);
});

test("用量记录的渠道取这一轮开始时的渠道", async (t) => {
  const { store } = await setup(t);
  let channel: "deepseek" | "juzi" = "deepseek";
  const base = await listen(t, createAgentHttpHandler({ token: "", model: "test", channel: () => channel, usage: store, database: httpAnalyticsDatabase(), logger: { log() {}, error() {} },
    runAgentTurn: async () => { throw new Error("不调用活动"); }, runPlanAnalyticsTurn: async () => { channel = "juzi"; return simulatedPlanAnswerV4(); } }));
  await (await ask(base, "八月")).text();
  await (await ask(base, "九月")).text();
  assert.deepEqual(store.conversation(`analysis:${CONVERSATION}`)?.turns.map((turn) => turn.channel), ["deepseek", "juzi"]);
});
