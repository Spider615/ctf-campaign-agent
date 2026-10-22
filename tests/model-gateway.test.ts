import assert from "node:assert/strict";
import test from "node:test";

import { createStreamTranslator, sdkModelName, toAnthropicMessage, toOpenAIRequest } from "../agent/openai-bridge.ts";
import { createModelGateway } from "../agent/model-gateway.ts";

test("Anthropic 请求转 OpenAI：system、工具调用、工具结果和图片", () => {
  const body = toOpenAIRequest({
    model: "claude-sonnet-5-5", max_tokens: 100, stream: true, thinking: { type: "enabled" }, metadata: { user_id: "x" }, temperature: 1,
    output_config: { effort: "low" },
    system: [{ type: "text", text: "系统一" }, { type: "text", text: "系统二" }],
    tools: [{ name: "read", description: "读", input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "auto" },
    messages: [
      { role: "user", content: "看图" },
      { role: "assistant", content: [{ type: "text", text: "我看看" }, { type: "tool_use", id: "t1", name: "read", input: { a: 1 } }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "图如下" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] },
        { type: "text", text: "继续" },
      ] },
    ],
  }, "claude-5.5-sonnet");
  assert.equal(body.model, "claude-5.5-sonnet");
  assert.equal(body.reasoning_effort, "low");
  assert.deepEqual(body.stream_options, { include_usage: true });
  for (const key of ["thinking", "metadata", "temperature", "output_config", "system"]) assert.equal(key in body, false, key);
  assert.equal(body.tool_choice, "auto");
  assert.deepEqual(body.messages, [
    { role: "system", content: "系统一\n系统二" },
    { role: "user", content: "看图" },
    { role: "assistant", content: "我看看", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{\"a\":1}" } }] },
    { role: "tool", tool_call_id: "t1", content: [{ type: "text", text: "图如下" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
    { role: "user", content: "继续" },
  ]);
});

test("max_tokens 截到网关的输出上限", () => {
  assert.equal(toOpenAIRequest({ model: "m", max_tokens: 32000, messages: [] }, "m", 8192).max_tokens, 8192);
  assert.equal(toOpenAIRequest({ model: "m", max_tokens: 100, messages: [] }, "m", 8192).max_tokens, 100);
});

test("没有工具时不带 tool_choice，网关会拒收", () => {
  const body = toOpenAIRequest({ model: "m", tool_choice: { type: "auto" }, messages: [{ role: "user", content: "hi" }] }, "m");
  assert.equal("tool_choice" in body, false);
  assert.equal("tools" in body, false);
});

test("OpenAI 非流式响应转回 Anthropic", () => {
  const message = toAnthropicMessage({ id: "msg_1", choices: [{ finish_reason: "tool_calls", message: { content: "好", tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: "{\"a\":1}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } }, "m");
  assert.deepEqual(message.content, [{ type: "text", text: "好" }, { type: "tool_use", id: "t1", name: "read", input: { a: 1 } }]);
  assert.equal(message.stop_reason, "tool_use");
  assert.deepEqual(message.usage, { input_tokens: 6, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 });
});

const events = (sse: string) => sse.trim().split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.split("\n")[1].slice(6)) as { type: string; [key: string]: unknown });

test("流式：文字和工具调用分块，usage 在收尾带上", () => {
  const translator = createStreamTranslator("m");
  const out = [
    { id: "c1", choices: [{ delta: { role: "assistant", content: "" } }] },
    { id: "c1", choices: [{ delta: { content: "先查" } }] },
    { id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "read", arguments: "" } }] } }] },
    { id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"a\"" } }] } }] },
    { id: "c1", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] },
    { id: "c1", choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    { id: "c1", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
  ].map((chunk) => translator.push(chunk)).join("") + translator.finish();
  const list = events(out);
  assert.deepEqual(list.map((event) => event.type), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  assert.deepEqual(list[4].content_block, { type: "tool_use", id: "t1", name: "read", input: {} });
  assert.equal(list.filter((event) => (event.delta as { type?: string })?.type === "input_json_delta").map((event) => (event.delta as { partial_json: string }).partial_json).join(""), "{\"a\":1}");
  assert.deepEqual(list[8].delta, { stop_reason: "tool_use", stop_sequence: null });
  assert.equal((list[8].usage as { output_tokens: number }).output_tokens, 2);
});

test("模型名换成 SDK 认得的官方写法", () => {
  assert.equal(sdkModelName("claude-5.5-sonnet"), "claude-sonnet-5-5");
  assert.equal(sdkModelName("claude-5-fable"), "claude-fable-5");
  assert.equal(sdkModelName("claude-sonnet-5-5"), "claude-sonnet-5-5");
  assert.equal(sdkModelName("gpt-5.5"), "gpt-5.5");
});

test("转换层：带上 key 转发，404 时按状态换同厂商可用模型重试一次", async (t) => {
  const calls: Array<{ url: string; auth: string | null; model?: string }> = [];
  const fake: typeof fetch = async (input, init) => {
    const url = String(input); const headers = new Headers(init?.headers);
    const model = init?.body ? (JSON.parse(String(init.body)) as { model: string }).model : undefined;
    calls.push({ url, auth: headers.get("authorization"), model });
    if (url.endsWith("/models/status")) return Response.json({ poll_interval_seconds: 60, data: [
      { id: "claude-5.5-sonnet", aliases: ["claude-sonnet-5-5"], kind: "chat", owned_by: "anthropic", status: "unavailable", recommendation: "normal" },
      { id: "claude-old", kind: "chat", owned_by: "anthropic", status: "available", recommendation: "deprecating" },
      { id: "gpt-5.5", kind: "chat", owned_by: "openai", status: "available", recommendation: "recommended" },
      { id: "claude-5-sonnet", kind: "chat", owned_by: "anthropic", status: "degraded", recommendation: "normal" },
    ] });
    if (model === "claude-sonnet-5-5") return Response.json({ error: { type: "model_not_found" } }, { status: 404 });
    return Response.json({ id: "c1", choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  };
  const gateway = createModelGateway({ baseUrl: "https://gw.example/models/v1/", fetch: fake, log: () => {} });
  const base = await gateway.listen();
  t.after(() => gateway.close());
  const response = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "x-api-key": "k1", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
  assert.equal(response.status, 200);
  const message = await response.json() as { content: unknown; model: string };
  assert.deepEqual(message.content, [{ type: "text", text: "ok" }]);
  assert.deepEqual(calls.map((call) => [call.url, call.model]), [
    ["https://gw.example/models/v1/chat/completions", "claude-sonnet-5-5"],
    ["https://gw.example/models/v1/models/status", undefined],
    ["https://gw.example/models/v1/chat/completions", "claude-5-sonnet"],
  ]);
  assert.ok(calls.every((call) => call.auth === "Bearer k1"));
});

test("转换层：上游错误保留状态码并转成 Anthropic 错误类型", async (t) => {
  const fake: typeof fetch = async () => new Response(JSON.stringify({ error: { type: "quota_exceeded" } }), { status: 429, headers: { "retry-after": "7" } });
  const gateway = createModelGateway({ baseUrl: "https://gw.example/models/v1", fetch: fake, log: () => {} });
  const base = await gateway.listen();
  t.after(() => gateway.close());
  const response = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "x-api-key": "k1" }, body: JSON.stringify({ model: "m", messages: [] }) });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal((await response.json() as { error: { type: string } }).error.type, "rate_limit_error");
});
