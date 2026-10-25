import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHistoryConversationStore, historyMessageContext, remoteThreads, type HistoryMessage, type RemoteThreads } from "../app/lib/client/history-conversation.ts";
import { readAnalyticsJson } from "../app/lib/server/analytics-access.ts";
import { parseConversationWrite } from "../app/lib/server/conversation-threads.ts";
import { planAnswerV4Text } from "../app/lib/analytics/plan/answer.ts";
import { simulatedPlanAnswer, simulatedPlanAnswerV4 } from "./helpers/plan-answer.ts";
import { storeChartEvidence } from "./helpers/analysis-v2-answer.ts";
import { resolveAnalysisVisualization } from "../app/lib/analytics/visualization.ts";
import { analyticsAnswerText, isPlanAnswerV4 } from "../app/lib/analytics/stream.ts";

const MAX_BYTES = 2 * 1024 * 1024;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const memory = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const message = (text = "长答案", status: HistoryMessage["status"] = "done"): HistoryMessage => ({ id: "answer", role: "assistant", text, status, createdAt: "2026-10-25T06:00:00Z" });
const thread = (id = "thread", text = "长答案"): Parameters<RemoteThreads["save"]>[0] => ({ id, title: "长答案", messages: [message(text)], context: [], campaignId: null, updatedAt: "2026-10-25T06:00:00Z" });
const bodyOf = (value: ReturnType<typeof thread>, scope = "analysis") => JSON.stringify({ scope, thread: value });

for (const makeAnswer of [simulatedPlanAnswer, simulatedPlanAnswerV4]) {
  test(`${makeAnswer().schema}追问只传一次相同的已保存正文，保留不同的旧摘要`, () => {
    const answer = makeAnswer(); const canonical = analyticsAnswerText(answer);
    const saved = { ...message(canonical), answer };
    assert.equal(historyMessageContext(saved), canonical.trim());
    assert.equal(historyMessageContext({ ...saved, text: `\n${canonical}\n` }), canonical.trim());
    assert.equal(historyMessageContext({ ...saved, text: "旧会话额外摘要" }), `旧会话额外摘要\n${canonical}`.trim());
    assert.equal(saved.text, canonical, "只调整追问编码，不改写服务端或复制正文");
  });
}
function sizedThread(size: number, scope = "analysis") {
  const value = thread(); value.messages[0].text = "";
  const room = size - bytes(bodyOf(value, scope));
  value.messages[0].text = "中".repeat(Math.floor(room / 3)) + "a".repeat(room % 3);
  assert.equal(bytes(bodyOf(value, scope)), size); return value;
}
function mockedFetch(t: TestContext, action: (url: string, init?: RequestInit) => Promise<Response>) {
  return t.mock.method(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) => action(String(input), init));
}
async function opened(t: TestContext, remote: RemoteThreads, local = memory()) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = createHistoryConversationStore(local, remote); const id = store.activeId(); await tick(); await tick(); return { store, id, local };
}

test("容量按完整请求的 UTF-8 字节判断，与真实 2 MiB API 边界一致", async (t) => {
  const calls: RequestInit[] = [];
  mockedFetch(t, async (_url, init) => { calls.push(init!); return new Response(null, { status: 204 }); });
  const remote = remoteThreads("analysis"); const accepted = sizedThread(MAX_BYTES); const rejected = sizedThread(MAX_BYTES + 1);
  assert.ok(bodyOf(rejected).length < MAX_BYTES, "中文请求的字符数小于容量，实际字节已超限");
  await remote.save(accepted);
  await assert.rejects(remote.save(rejected), (error: unknown) => {
    assert.equal((error as { code: string }).code, "too_large"); assert.equal((error as { retryable: boolean }).retryable, false); assert.match((error as Error).message, /2097153|2,097,153/); return true;
  });
  assert.equal(calls.length, 1, "超限前在客户端拒绝，不发送无效 PUT");
  const request = (value: ReturnType<typeof thread>) => new Request("https://example.test/api/analytics/conversations/thread", { method: "PUT", headers: { "content-type": "application/json" }, body: bodyOf(value) });
  await readAnalyticsJson(request(accepted)); await assert.rejects(readAnalyticsJson(request(rejected)), /请求过大/);
});

test("keepalive 按 UTF-8 字节使用原 60000 字节安全阈值", async (t) => {
  const calls: RequestInit[] = []; mockedFetch(t, async (_url, init) => { calls.push(init!); return new Response(null, { status: 204 }); });
  for (const size of [59_999, 60_000, 75_000]) await remoteThreads("analysis").save(sizedThread(size));
  assert.deepEqual(calls.map((call) => call.keepalive), [true, false, false]);
});

test("超限保存明确失败，保留本页答案与复制文本；后台不永久重试，显式重试仍可检查", async (t) => {
  let puts = 0; mockedFetch(t, async (_url, init) => { if (init?.method === "PUT") puts++; return init?.method === "PUT" ? new Response(null, { status: 204 }) : Response.json({ threads: [] }); });
  const { store, id } = await opened(t, remoteThreads("analysis")); const text = "保留中文答案🙂".repeat(150_000);
  const notifications: unknown[] = []; const unsubscribe = store.subscribeSaveState(() => notifications.push(store.saveState(id)));
  store.update(() => [message(text)], id); t.mock.timers.tick(1000); await tick();
  const failed = store.saveState(id); assert.equal(failed.status, "failed"); assert.equal(failed.code, "too_large"); assert.match(failed.reason!, /2 MiB/);
  assert.equal(store.snapshot()[0].text, text); assert.equal(store.snapshot()[0].status, "done"); assert.equal(store.saveState(id), failed, "getter 在状态不变时稳定，供 useSyncExternalStore 使用");
  t.mock.timers.tick(120_000); await tick(); assert.equal(store.saveState(id), failed); assert.equal(puts, 0);
  await store.retrySave(id); assert.equal(puts, 0); assert.equal(store.saveState(id).status, "failed");
  assert.ok(notifications.length >= 2); unsubscribe();
});

test("超限后内容变小自动重新保存，成功清错且不删除历史", async (t) => {
  const saved: string[] = []; mockedFetch(t, async (_url, init) => { if (init?.method === "PUT") { saved.push(init.body as string); return new Response(null, { status: 204 }); } return Response.json({ threads: [] }); });
  const { store, id } = await opened(t, remoteThreads("analysis"));
  store.update(() => [message("中".repeat(MAX_BYTES))], id); t.mock.timers.tick(1000); await tick(); assert.equal(store.saveState(id).code, "too_large");
  store.update(() => [message("较小的完整答案")], id); t.mock.timers.tick(1000); await tick();
  assert.equal(store.saveState(id).status, "saved"); assert.equal(store.saveState(id).reason, undefined); assert.equal(saved.length, 1); assert.equal(store.snapshot()[0].text, "较小的完整答案");
});

test("普通网络失败保留重试与原因，一个对话失败不阻挡另一条保存", async (t) => {
  let broken = ""; let attempts = 0; const saved: string[] = [];
  const remote: RemoteThreads = { async list() { return []; }, async save(value) { if (value.id === broken && ++attempts === 1) throw new Error("网络连接中断"); saved.push(value.id); }, async remove() {} };
  const { store, id } = await opened(t, remote); broken = id;
  store.update(() => [message("第一条")], id); const second = store.newConversation(); store.update(() => [message("第二条")], second);
  t.mock.timers.tick(1000); await tick(); assert.equal(store.saveState(id).status, "failed"); assert.match(store.saveState(id).reason!, /网络连接中断/);
  assert.equal(store.saveState(second).status, "saved"); assert.equal(store.saveState().status, "saved"); assert.equal(store.activeId(), second);
  t.mock.timers.tick(4000); await tick(); assert.equal(store.saveState(id).status, "saved"); assert.equal(store.saveState(id).reason, undefined); assert.deepEqual(saved.sort(), [id, second].sort());
});

test("显式重试只保存指定对话，不发送其他对话仍在退避的请求", async (t) => {
  let failing = true; const calls: string[] = [];
  const remote: RemoteThreads = { async list() { return []; }, async save(value) { calls.push(value.id); if (failing) throw new Error("离线"); }, async remove() {} };
  const { store, id } = await opened(t, remote); store.update(() => [message("甲")], id); const other = store.newConversation(); store.update(() => [message("乙")], other);
  t.mock.timers.tick(1000); await tick(); assert.equal(store.saveState(id).status, "failed"); assert.equal(store.saveState(other).status, "failed");
  failing = false; await store.retrySave(id); assert.equal(store.saveState(id).status, "saved"); assert.equal(store.saveState(other).status, "failed"); assert.deepEqual(calls, [id, other, id]);
});

test("旧快照成功不能把新长答案或已取消消息标为已保存，只有最新快照成功才能清状态", async (t) => {
  const writes: Array<{ value: Parameters<RemoteThreads["save"]>[0]; done(): void }> = [];
  const remote: RemoteThreads = { async list() { return []; }, save(value) { return new Promise<void>((resolve) => writes.push({ value, done: resolve })); }, async remove() {} };
  const { store, id } = await opened(t, remote); store.update(() => [message("生成中", "running")], id); t.mock.timers.tick(1000); await tick();
  assert.equal(store.saveState(id).status, "saving"); store.update(() => [message("已停止本次回答", "cancelled")], id);
  writes[0].done(); await tick(); assert.notEqual(store.saveState(id).status, "saved"); assert.equal(writes[0].value.messages[0].status, "running", "送出的快照不能被后续本地更新改写");
  t.mock.timers.tick(1000); await tick(); assert.equal(writes.length, 2); assert.equal(writes[1].value.messages[0].status, "cancelled"); writes[1].done(); await tick();
  assert.equal(store.saveState(id).status, "saved"); assert.equal(store.snapshot()[0].status, "cancelled");
});

test("保存请求被取消或服务端拒绝时不虚报成功，保留真实失败原因", async (t) => {
  const abort = new Error("The operation was aborted"); abort.name = "AbortError";
  const remote: RemoteThreads = { async list() { return []; }, async save() { throw abort; }, async remove() {} };
  const { store, id } = await opened(t, remote); store.update(() => [message()], id); t.mock.timers.tick(1000); await tick();
  assert.equal(store.saveState(id).status, "failed"); assert.match(store.saveState(id).reason!, /取消/);
  mockedFetch(t, async () => Response.json({ error: "存储暂时不可用" }, { status: 503 })); await assert.rejects(remoteThreads("analysis").save(thread()), /存储暂时不可用/);
});

test("保存状态按 scope 隔离，服务端恢复的记录与本地未保存答案分开显示", async (t) => {
  const saved = thread("same", "已保存的历史答案");
  const remote: RemoteThreads = { async list() { return [saved]; }, async save() { throw new Error("离线"); }, async remove() {} };
  const { store } = await opened(t, remote); assert.equal(store.activeId(), "same"); assert.equal(store.saveState("same").status, "saved");
  const other = createHistoryConversationStore(memory(), { ...remote, async list() { return [thread("same", "另一范围")]; } }); other.activeId(); await tick(); const id = other.activeId(); assert.equal(id, "same"); other.update(() => [message("另一范围")], id);
  t.mock.timers.tick(1000); await tick(); assert.equal(other.saveState(id).status, "failed"); assert.equal(store.saveState("same").status, "saved");
});

test("长 v4 答案保存、清空缓存恢复、复制及追问上下文保留完整正文和事实", async (t) => {
  const saved = new Map<string, Parameters<RemoteThreads["save"]>[0]>();
  mockedFetch(t, async (url, init) => {
    if (init?.method !== "PUT") return Response.json({ threads: [...saved.values()] });
    const id = url.split("/").at(-1)!;
    const data = parseConversationWrite(id, await readAnalyticsJson(new Request(`https://example.test${url}`, init)));
    saved.set(id, data.thread as Parameters<RemoteThreads["save"]>[0]); return new Response(null, { status: 204 });
  });
  const { store, id } = await opened(t, remoteThreads("analysis")); const answer = simulatedPlanAnswerV4();
  const body = "长正文与真实查数结果需完整保存。".repeat(1000); answer.keyFigure = undefined; answer.evidence = storeChartEvidence();
  const chart = resolveAnalysisVisualization({ id: "c", revision: 1, kind: "bar", renderer: "native", afterBlockIndex: 0, source: { kind: "analysis", operationId: "operation", metricId: "amount", dimension: "store" }, selection: { mode: "all" } }, answer.evidence);
  const fact = answer.evidence.facts[0]; answer.evidence.facts.push(...Array.from({ length: 4000 }, (_, index) => ({ ...fact, id: `synthetic-read-${index}`, label: `合成已读事实${index}` })));
  answer.body = [{ kind: "markdown", text: body, refs: [] }, { kind: "table", title: "合成明细", columns: ["对象", "数值", "范围"], rows: Array.from({ length: 200 }, (_, index) => ({ cells: [`合成分组${index}`, "1234.56元", "合成数据，保留实际已读范围与全部事实。".repeat(5)], factIds: [] })) }, ...Array.from({ length: 12 }, (_, index) => ({ kind: "chart" as const, chart: { ...chart, id: `chart${index}` } }))];
  const copyText = planAnswerV4Text(answer);
  store.update(() => [{ ...message("原始问题"), id: "question", role: "user" }, { ...message(copyText), id: "v4", answer }], id); t.mock.timers.tick(1000); await tick();
  assert.equal(store.saveState(id).status, "saved");
  const written = bodyOf(saved.get(id)!); assert.ok(bytes(written) > 1_000_000); assert.ok(bytes(written) < MAX_BYTES);
  t.diagnostic(`完整保存请求 ${bytes(written)} UTF-8 字节；正文 ${body.length} 字符、200 行表、12 张图、4002 条事实。`);
  const refreshed = createHistoryConversationStore(memory(), remoteThreads("analysis")); refreshed.activeId(); await tick(); await tick();
  const restored = refreshed.snapshot().at(-1)!; assert.ok(restored.answer && isPlanAnswerV4(restored.answer)); assert.equal(restored.text, copyText);
  assert.equal(restored.answer.body.length, 14); assert.deepEqual(restored.answer.evidence, answer.evidence); assert.equal(historyMessageContext(restored), copyText);
  assert.equal(refreshed.saveState(id).status, "saved"); refreshed.update((items) => [...items, { id: "follow", role: "user", text: "沿用上次范围继续看", createdAt: "2026-10-25T06:01:00Z" }], id);
  assert.equal(refreshed.snapshot()[1].answer, restored.answer); assert.equal(refreshed.context().at(-1), "沿用上次范围继续看");
});

test("服务端 413 不永久重试，手动重试成功后清除错误", async (t) => {
  let rejected = true; let puts = 0;
  mockedFetch(t, async (_url, init) => {
    if (init?.method !== "PUT") return Response.json({ threads: [] });
    puts++; return rejected ? Response.json({ error: "服务端拒绝：请求过大" }, { status: 413 }) : new Response(null, { status: 204 });
  });
  const { store, id } = await opened(t, remoteThreads("analysis")); store.update(() => [message()], id); t.mock.timers.tick(1000); await tick();
  assert.equal(store.saveState(id).code, "too_large"); assert.match(store.saveState(id).reason!, /服务端拒绝/);
  t.mock.timers.tick(120_000); await tick(); assert.equal(puts, 1);
  rejected = false; await store.retrySave(id); assert.equal(puts, 2); assert.equal(store.saveState(id).status, "saved"); assert.equal(store.saveState(id).reason, undefined);
});

test("浏览器缓存已满仍保留本页超限答案，不删除记录，也不阻挡其他对话保存", async (t) => {
  const calls: string[] = []; mockedFetch(t, async (_url, init) => { calls.push(init?.method ?? "GET"); return init?.method === "PUT" ? new Response(null, { status: 204 }) : Response.json({ threads: [] }); });
  const { store, id } = await opened(t, remoteThreads("analysis"), { getItem() { return null; }, setItem() { throw new Error("QuotaExceededError"); } });
  const text = "答案不可丢失🙂".repeat(160_000); store.update(() => [message(text)], id);
  const other = store.newConversation(); store.update(() => [message("正常大小")], other); t.mock.timers.tick(1000); await tick();
  assert.equal(store.saveState(id).status, "failed"); assert.equal(store.saveState(other).status, "saved"); assert.equal(store.selectConversation(id), true); assert.equal(store.snapshot()[0].text, text);
  assert.deepEqual(calls, ["GET", "PUT"]);
});

test("初次读回迟到时，本页已更新的答案不会被服务端旧快照覆盖", async (t) => {
  let ready!: (threads: unknown[]) => void; const local = memory(); const first = createHistoryConversationStore(local); const id = first.activeId(); first.update(() => [message("缓存")], id);
  const remote: RemoteThreads = { list() { return new Promise((resolve) => { ready = resolve; }); }, async save() {}, async remove() {} };
  t.mock.timers.enable({ apis: ["setTimeout"] }); const store = createHistoryConversationStore(local, remote); store.activeId(); store.update(() => [message("本页新答案")], id);
  ready([{ ...thread(id, "服务端旧答案"), updatedAt: "2099-01-01T00:00:00Z" }]); await tick();
  assert.equal(store.snapshot()[0].text, "本页新答案");
});

test("网关返回非 JSON 保存错误时仍显示实际 HTTP 状态，不冒充成功", async (t) => {
  mockedFetch(t, async () => new Response("Bad Gateway", { status: 502 }));
  await assert.rejects(remoteThreads("analysis").save(thread()), /502/);
});

test("离开页面前仍会尝试写回网络失败的待保存记录", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window"); const events = new Map<string, () => void>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener(name: string, handler: () => void) { events.set(name, handler); } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  let calls = 0; const remote: RemoteThreads = { async list() { return []; }, async save() { if (++calls === 1) throw new Error("短暂断网"); }, async remove() {} };
  const { store, id } = await opened(t, remote); store.update(() => [message()], id); t.mock.timers.tick(1000); await tick();
  assert.equal(store.saveState(id).status, "failed"); events.get("pagehide")!(); await tick(); assert.equal(calls, 2); assert.equal(store.saveState(id).status, "saved");
});

test("订阅默认 getter 时切换当前对话也通知，取消订阅后不再通知", async (t) => {
  let blocked = "";
  const remote: RemoteThreads = { async list() { return []; }, async save(value) { if (value.id === blocked) throw new Error("离线"); }, async remove() {} };
  const { store, id } = await opened(t, remote); blocked = id; store.update(() => [message()], id);
  const other = store.newConversation(); store.update(() => [message("另一条")], other); t.mock.timers.tick(1000); await tick();
  const observed: string[] = []; const unsubscribe = store.subscribeSaveState(() => observed.push(store.saveState().status));
  store.selectConversation(id); assert.equal(observed.at(-1), "failed"); store.selectConversation(other); assert.equal(observed.at(-1), "saved");
  unsubscribe(); const count = observed.length; store.selectConversation(id); assert.equal(observed.length, count);
});
