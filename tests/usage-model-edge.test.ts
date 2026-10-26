import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createModelGateway } from "../agent/model-gateway.ts";
import { createModelEdge } from "../agent/usage/model-edge.ts";
import { runInUsageTurn, setUsageRecorder, turnBaseUrl } from "../agent/usage/context.ts";
import { createUsageStore, type UsageStore } from "../agent/usage/store.ts";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const SDK_BODY = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 10, stream: false, messages: [{ role: "user", content: "hi" }] });

function setup(t: TestContext): UsageStore {
  const dir = mkdtempSync(join(tmpdir(), "usage-edge-"));
  const store = createUsageStore(join(dir, "usage.sqlite"));
  setUsageRecorder(store);
  for (const id of [T1, T2]) store.startTurn({ id, entry: "analysis", channel: "deepseek", visitor: null, conversationId: id, internal: false, question: "问", startedAt: Date.now() });
  t.after(() => { setUsageRecorder(undefined); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}
const requests = (store: UsageStore, turnId: string) => store.conversation(`analysis:${turnId}`)?.turns[0].requests ?? [];
const sse = (events: Array<Record<string, unknown>>) => events.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join("");
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "等待记录收尾超时");
}

test("DeepSeek 透传请求体和 key，并记下响应编号、模型和 Token", async (t) => {
  const store = setup(t);
  const seen: Array<{ url: string; body: string; key: string | null }> = [];
  const edge = createModelEdge({ upstream: "https://api.deepseek.com/anthropic", fetch: async (input, init) => {
    seen.push({ url: String(input), body: String(init?.body ? Buffer.from(init.body as Uint8Array).toString("utf8") : ""), key: new Headers(init?.headers).get("x-api-key") });
    return Response.json({ id: "msg_1", type: "message", model: "deepseek-flash", content: [], usage: { input_tokens: 12, output_tokens: 3 } });
  } });
  const base = await edge.listen(); t.after(() => edge.close());
  const response = await fetch(`${base}/t/${T1}/analysis/v1/messages?beta=true`, { method: "POST", headers: { "x-api-key": "secret-key", "content-type": "application/json" }, body: SDK_BODY });
  assert.equal((await response.json() as { id: string }).id, "msg_1");
  assert.deepEqual(seen, [{ url: "https://api.deepseek.com/anthropic/v1/messages?beta=true", body: SDK_BODY, key: "secret-key" }]);
  await until(() => requests(store, T1)[0]?.status === "done");
  const [record] = requests(store, T1);
  assert.equal(record.channel, "deepseek");
  assert.equal(record.source, "analysis");
  assert.equal(record.sdkModel, "claude-sonnet-4-6");
  assert.equal(record.sentModel, "deepseek-flash");
  assert.equal(record.vendor, "DeepSeek");
  assert.equal(record.responseId, "msg_1");
  assert.equal(record.upstreamModel, "deepseek-flash");
  assert.equal(record.inputTokens, 12);
  assert.equal(record.outputTokens, 3);
  assert.equal(record.cacheReadTokens, null);
  assert.equal(record.cacheWriteTokens, null);
});

test("DeepSeek 流式取 message_start 与 message_delta 的最终用量", async (t) => {
  const store = setup(t);
  const stream = sse([
    { type: "message_start", message: { id: "msg_2", model: "deepseek-flash", usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 4 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ]);
  const edge = createModelEdge({ upstream: "https://api.deepseek.com/anthropic", fetch: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }) });
  const base = await edge.listen(); t.after(() => edge.close());
  const response = await fetch(`${base}/t/${T1}/analysis/v1/messages`, { method: "POST", body: SDK_BODY });
  assert.equal(await response.text(), stream);
  await until(() => requests(store, T1)[0]?.status === "done");
  const [record] = requests(store, T1);
  assert.deepEqual([record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheWriteTokens, record.responseId], [20, 7, 4, null, "msg_2"]);
});

test("DeepSeek 回显请求里的兼容别名时，不当作上游返回的模型", async (t) => {
  const store = setup(t);
  const edge = createModelEdge({ upstream: "https://api.deepseek.com/anthropic", fetch: async () => Response.json({ id: "msg_9", model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 1 } }) });
  const base = await edge.listen(); t.after(() => edge.close());
  await (await fetch(`${base}/t/${T1}/analysis/v1/messages`, { method: "POST", body: SDK_BODY })).json();
  await until(() => requests(store, T1)[0]?.status === "done");
  const [record] = requests(store, T1);
  assert.equal(record.upstreamModel, null);
  assert.equal(record.sentModel, "deepseek-flash");
  assert.equal(store.overview({ from: "2000-01-01", to: "2100-01-01" }).models[0].model, "deepseek-flash");
});

test("流式中途断开记为不完整", async (t) => {
  const store = setup(t);
  const encoder = new TextEncoder();
  const edge = createModelEdge({ upstream: "https://api.deepseek.com/anthropic", fetch: async (_input, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sse([{ type: "message_start", message: { id: "msg_3", model: "deepseek-flash", usage: { input_tokens: 20, output_tokens: 1 } } }])));
      init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  }), { headers: { "content-type": "text/event-stream" } }) });
  const base = await edge.listen(); t.after(() => edge.close());
  const client = new AbortController();
  const response = await fetch(`${base}/t/${T1}/analysis/v1/messages`, { method: "POST", body: SDK_BODY, signal: client.signal });
  const reader = response.body!.getReader();
  await reader.read();
  client.abort();
  await until(() => requests(store, T1)[0]?.status === "incomplete");
  const [record] = requests(store, T1);
  assert.equal(record.inputTokens, 20);
  assert.equal(record.outputTokens, null);
});

test("上游报错记为错误并保留状态码", async (t) => {
  const store = setup(t);
  const edge = createModelEdge({ upstream: "https://api.deepseek.com/anthropic", fetch: async () => Response.json({ type: "error", error: { type: "rate_limit_error" } }, { status: 429 }) });
  const base = await edge.listen(); t.after(() => edge.close());
  const response = await fetch(`${base}/t/${T1}/analysis/v1/messages`, { method: "POST", body: SDK_BODY });
  assert.equal(response.status, 429);
  await response.text();
  await until(() => requests(store, T1)[0]?.status === "error");
  assert.equal(requests(store, T1)[0].httpStatus, 429);
  assert.equal(requests(store, T1)[0].inputTokens, null);
});

test("网关回退存两条请求", async (t) => {
  const store = setup(t);
  const fake: typeof fetch = async (input, init) => {
    const url = String(input);
    const model = init?.body ? (JSON.parse(String(init.body)) as { model: string }).model : undefined;
    if (url.endsWith("/models/status")) return Response.json({ poll_interval_seconds: 60, data: [
      { id: "claude-sonnet-5-5", kind: "chat", owned_by: "anthropic", status: "unavailable", recommendation: "normal" },
      { id: "claude-5-sonnet", kind: "chat", owned_by: "anthropic", status: "available", recommendation: "normal" },
    ] });
    if (model === "claude-sonnet-5-5") return Response.json({ error: { type: "model_not_found" } }, { status: 404 });
    return Response.json({ id: "c1", model: "claude-5-sonnet-20260901", choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 30, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 10 } } });
  };
  const gateway = createModelGateway({ baseUrl: "https://gw.example/models/v1", fetch: fake, log: () => {} });
  const base = await gateway.listen(); t.after(() => gateway.close());
  const response = await fetch(`${base}/t/${T1}/campaign/v1/messages`, { method: "POST", headers: { "x-api-key": "k1" }, body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(response.status, 200); await response.json();
  await until(() => requests(store, T1).length === 2 && requests(store, T1).every((item) => item.status !== "running"));
  const [first, second] = requests(store, T1);
  assert.deepEqual([first.channel, first.status, first.httpStatus, first.sentModel], ["juzi", "error", 404, "claude-sonnet-5-5"]);
  assert.deepEqual([second.status, second.sentModel, second.upstreamModel, second.vendor, second.responseId], ["done", "claude-5-sonnet", "claude-5-sonnet-20260901", "anthropic", "c1"]);
  assert.deepEqual([second.inputTokens, second.cacheReadTokens, second.outputTokens, second.cacheWriteTokens], [20, 10, 4, null]);
});

test("网关流式取最后一块的用量", async (t) => {
  const store = setup(t);
  const chunks = [
    { id: "c2", model: "claude-5.5-sonnet", choices: [{ delta: { content: "好" } }] },
    { id: "c2", model: "claude-5.5-sonnet", choices: [{ delta: {}, finish_reason: "stop" }] },
    { id: "c2", model: "claude-5.5-sonnet", choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } },
  ];
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  const gateway = createModelGateway({ baseUrl: "https://gw.example/models/v1", fetch: async (input) => String(input).endsWith("/models/status") ? Response.json({ data: [] }) : new Response(body, { headers: { "content-type": "text/event-stream" } }), log: () => {} });
  const base = await gateway.listen(); t.after(() => gateway.close());
  const response = await fetch(`${base}/t/${T1}/campaign/v1/messages`, { method: "POST", headers: { "x-api-key": "k1" }, body: JSON.stringify({ model: "claude-sonnet-5-5", stream: true, messages: [] }) });
  await response.text();
  await until(() => requests(store, T1)[0]?.status === "done");
  const [record] = requests(store, T1);
  assert.deepEqual([record.inputTokens, record.outputTokens, record.cacheReadTokens, record.upstreamModel, record.vendor], [9, 2, null, "claude-5.5-sonnet", null]);
});

test("网关正常请求也按模型状态记厂商", async (t) => {
  const store = setup(t);
  let statusCalls = 0;
  const fake: typeof fetch = async (input) => {
    if (String(input).endsWith("/models/status")) { statusCalls++; return Response.json({ poll_interval_seconds: 60, data: [{ id: "claude-5.5-sonnet", aliases: ["claude-sonnet-5-5"], kind: "chat", owned_by: "anthropic", status: "available" }] }); }
    return Response.json({ id: "c3", model: "claude-5.5-sonnet", choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
  };
  const gateway = createModelGateway({ baseUrl: "https://gw.example/models/v1", fetch: fake, log: () => {} });
  const base = await gateway.listen(); t.after(() => gateway.close());
  const send = async () => { await (await fetch(`${base}/t/${T1}/analysis/v1/messages`, { method: "POST", headers: { "x-api-key": "k1" }, body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }) })).json(); };
  // 第一次请求不等模型状态（后台刷新），厂商先记未确认；状态到手后的请求记上厂商。
  await send(); await until(() => statusCalls === 1); await new Promise((resolve) => setTimeout(resolve, 10));
  await send(); await send();
  await until(() => requests(store, T1).length === 3 && requests(store, T1).every((item) => item.status === "done"));
  assert.deepEqual(requests(store, T1).map((item) => item.vendor), [null, "anthropic", "anthropic"]);
  assert.equal(statusCalls, 1, "模型状态按间隔缓存");
});

test("上游连接断开时请求记为不完整，不留在执行中", async (t) => {
  const store = setup(t);
  const encoder = new TextEncoder();
  let mode: "before" | "during" = "before";
  const edge = createModelEdge({ upstream: "https://api.deepseek.com/anthropic", fetch: async () => {
    if (mode === "before") throw new TypeError("fetch failed");
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(sse([{ type: "message_start", message: { id: "msg_r", model: "deepseek-flash", usage: { input_tokens: 9 } } }])));
      setTimeout(() => controller.error(new TypeError("terminated")), 10);
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const base = await edge.listen(); t.after(() => edge.close());
  assert.equal((await fetch(`${base}/t/${T1}/analysis/v1/messages`, { method: "POST", body: SDK_BODY })).status, 502);
  mode = "during";
  await (await fetch(`${base}/t/${T1}/analysis/v1/messages`, { method: "POST", body: SDK_BODY })).text().catch(() => "");
  await until(() => requests(store, T1).length === 2 && requests(store, T1).every((item) => item.status !== "running"));
  assert.deepEqual(requests(store, T1).map((item) => [item.status, item.inputTokens]), [["incomplete", null], ["incomplete", 9]]);
});

test("DeepSeek 返回的真实模型名与请求同名时照样记", async (t) => {
  const store = setup(t);
  const edge = createModelEdge({ upstream: "https://api.deepseek.com/anthropic", fetch: async () => Response.json({ id: "m", model: "deepseek-flash", usage: { input_tokens: 1, output_tokens: 1 } }) });
  const base = await edge.listen(); t.after(() => edge.close());
  await (await fetch(`${base}/t/${T1}/campaign/v1/messages`, { method: "POST", body: JSON.stringify({ model: "deepseek-flash" }) })).json();
  await until(() => requests(store, T1)[0]?.status === "done");
  assert.equal(requests(store, T1)[0].upstreamModel, "deepseek-flash");
});

test("网关：模型状态读不到时不拖慢请求，也不重复去读", async (t) => {
  const store = setup(t);
  let statusCalls = 0;
  const fake: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/models/status")) {
      statusCalls++;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError"))));
    }
    return Response.json({ id: "c", model: "m", choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  };
  const gateway = createModelGateway({ baseUrl: "https://gw.example/models/v1", fetch: fake, log: () => {} });
  const base = await gateway.listen(); t.after(() => gateway.close());
  const started = performance.now();
  for (let i = 0; i < 2; i++) await (await fetch(`${base}/t/${T1}/analysis/v1/messages`, { method: "POST", headers: { "x-api-key": "k1" }, body: JSON.stringify({ model: "m", messages: [] }) })).json();
  assert.ok(performance.now() - started < 1000, "记录用量不能等模型状态");
  assert.ok(statusCalls <= 1);
  await until(() => requests(store, T1).length === 2 && requests(store, T1).every((item) => item.status === "done"));
});

test("网关：上游连接断开时记为不完整；流式没等到用量块也算不完整", async (t) => {
  const store = setup(t);
  let mode: "throw" | "nousage" = "throw";
  const fake: typeof fetch = async (input) => {
    if (String(input).endsWith("/models/status")) return Response.json({ data: [] });
    if (mode === "throw") throw new TypeError("fetch failed");
    return new Response(`data: ${JSON.stringify({ id: "c", choices: [{ delta: { content: "好" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  const gateway = createModelGateway({ baseUrl: "https://gw.example/models/v1", fetch: fake, log: () => {} });
  const base = await gateway.listen(); t.after(() => gateway.close());
  await (await fetch(`${base}/t/${T1}/analysis/v1/messages`, { method: "POST", headers: { "x-api-key": "k1" }, body: JSON.stringify({ model: "m", messages: [] }) })).text();
  mode = "nousage";
  await (await fetch(`${base}/t/${T1}/analysis/v1/messages`, { method: "POST", headers: { "x-api-key": "k1" }, body: JSON.stringify({ model: "m", stream: true, messages: [] }) })).text();
  await until(() => requests(store, T1).length === 2 && requests(store, T1).every((item) => item.status !== "running"));
  assert.deepEqual(requests(store, T1).map((item) => item.status), ["incomplete", "incomplete"]);
});

test("并发两轮的请求各归各的", async (t) => {
  const store = setup(t);
  const edge = createModelEdge({ upstream: "https://api.deepseek.com/anthropic", fetch: async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json({ id: `msg_${Math.random()}`, model: "deepseek-flash", usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const base = await edge.listen(); t.after(() => edge.close());
  const ask = (turnId: string) => runInUsageTurn(turnId, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const response = await fetch(`${turnBaseUrl(base, "analysis")}/v1/messages`, { method: "POST", body: SDK_BODY });
    await response.json();
  });
  await Promise.all([ask(T1), ask(T2), ask(T1)]);
  await until(() => requests(store, T1).length === 2 && requests(store, T2).length === 1);
  assert.ok([...requests(store, T1), ...requests(store, T2)].every((item) => item.status === "done"));
  assert.equal(store.conversation(`analysis:${T1}`)?.turns[0].sdkStarts, 2);
});

test("没有轮次编号的请求照常转发但不记录", async (t) => {
  const store = setup(t);
  const edge = createModelEdge({ upstream: "https://api.deepseek.com/anthropic", fetch: async (input) => Response.json({ url: String(input) }) });
  const base = await edge.listen(); t.after(() => edge.close());
  assert.equal(turnBaseUrl(base, "analysis"), base, "不在轮次里时不改地址");
  const response = await fetch(`${base}/v1/messages`, { method: "POST", body: SDK_BODY });
  assert.deepEqual(await response.json(), { url: "https://api.deepseek.com/anthropic/v1/messages" });
  assert.equal(requests(store, T1).length, 0);
});
