import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import * as stream from "../app/lib/analytics/stream.ts";
import { postHistoryStream } from "../app/lib/client/history-stream.ts";
import { quickAnalyticsReply } from "../app/lib/analytics/dialogue.ts";
import { TurnCancelledError } from "../app/lib/cancellation.ts";
import { largeSimulatedAnswer, simulatedAnswer } from "./helpers/analysis-v2-answer.ts";
import { createAgentHttpHandler } from "../agent/http-handler.ts";

const request = { mode: "database" as const, question: "先核对哪些门店？", history: [] };
const progress = { type: "phase", phase: "analyzing", at: 1 };
function byteStream(text: string) {
  const bytes = new TextEncoder().encode(text); let index = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(output) { if (index < bytes.length) output.enqueue(bytes.slice(index, ++index)); else output.close(); } }), { headers: { "content-type": "application/x-ndjson" } });
}
function networkStream(text: string) {
  const bytes = new TextEncoder().encode(text); let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(output) { if (offset < bytes.length) { output.enqueue(bytes.slice(offset, offset + 65536)); offset += 65536; } else output.close(); } }));
}
function resultChunks(answer = simulatedAnswer()) {
  const json = JSON.stringify({ type: "result", result: answer }); const middle = Math.floor(json.length / 2);
  return [{ type: "result_chunk", index: 0, delta: json.slice(0, middle) }, { type: "result_chunk", index: 1, delta: json.slice(middle) }, { type: "result_end", chunks: 2, length: json.length }];
}
const wireText = (events: unknown[]) => events.map((event) => JSON.stringify(event) + "\n").join("");

test("全量方法检查超过单条消息上限时，分块无损交付完整已核验答案", async () => {
  const answer = largeSimulatedAnswer(); const events: stream.AnalyticsProgressEvent[] = [];
  assert.ok(JSON.stringify(answer).length > 2_000_000);
  const encoded = stream.encodeAnalyticsStreamEvent({ type: "result", result: answer });
  const result = await stream.consumeAnalyticsStream(networkStream(`${JSON.stringify(progress)}\n${encoded}`), (event) => events.push(event));
  assert.deepEqual(result, answer); assert.deepEqual(events, [progress]);
  assert.ok(encoded.trimEnd().split("\n").every((line) => line.length <= 2_000_000), "每条传输消息仍有长度限制");
});

test("最终结果分块缺失、重复、乱序或缺少结束帧均不能交付", async () => {
  const [first, second, end] = resultChunks();
  for (const events of [[second, first, end], [first, first, second, end], [first, end], [first, second], [end], [first, second, { ...end, length: end.length! + 1 }], [first, second, { ...end, chunks: 3 }], [first, progress, second, end], [first, { type: "result", result: simulatedAnswer() }]]) {
    await assert.rejects(stream.consumeAnalyticsStream(networkStream(wireText(events))), /分块|完整/);
  }
});

test("结果分块只在收齐后核验，伪造引用、终态后追加和上游错误均被拒绝", async () => {
  const answer = simulatedAnswer(); answer.blocks[1].nodes.push({ kind: "fact_ref", factId: "invented" });
  await assert.rejects(stream.consumeAnalyticsStream(networkStream(wireText(resultChunks(answer)))), /invented|事实|引用/);
  await assert.rejects(stream.consumeAnalyticsStream(networkStream(wireText([...resultChunks(), progress]))), /最终结果/);
  await assert.rejects(stream.consumeAnalyticsStream(networkStream(wireText([resultChunks()[0], { type: "error", error: "上游已停止" }]))), /上游已停止/);
  for (const event of [{ type: "result_chunk", index: -1, delta: "x" }, { type: "result_chunk", index: 0, delta: "" }, { type: "result_end", chunks: 2, length: 1_000_000_000 }]) assert.throws(() => stream.decodeAnalyticsStreamLine(JSON.stringify(event)), /分块|长度|类型/);
});

test("结果分块尚未收齐时停止仍取消上游，不交付部分答案", async () => {
  const controller = new AbortController(); let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ start(output) { output.enqueue(new TextEncoder().encode(wireText([resultChunks()[0]]))); }, cancel() { cancelled = true; } }));
  const pending = stream.consumeAnalyticsStream(response, undefined, controller.signal);
  const rejected = assert.rejects(pending, TurnCancelledError);
  await new Promise<void>((resolve) => setImmediate(resolve)); controller.abort();
  await rejected; assert.equal(cancelled, true);
});

test("v2 最终答案逐字节跨 UTF8 分帧，只有真实过程提前出现", async () => {
  const answer = simulatedAnswer(); const events: stream.AnalyticsProgressEvent[] = [];
  const result = await stream.consumeAnalyticsStream(byteStream(`${JSON.stringify(progress)}\n${JSON.stringify({ type: "result", result: answer })}`), (event) => events.push(event));
  assert.deepEqual(events, [progress]); assert.deepEqual(result, answer);
});

test("v2 未知引用和未知 schema 不会落到旧解析器或进入结果", () => {
  const answer = simulatedAnswer(); answer.blocks[1].nodes.push({ kind: "fact_ref", factId: "invented" });
  assert.throws(() => stream.decodeAnalyticsStreamLine(JSON.stringify({ type: "result", result: answer })));
  assert.throws(() => stream.decodeAnalyticsStreamLine(JSON.stringify({ type: "result", result: { ...quickAnalyticsReply("你好"), schema: "analysis-answer/future" } })), /合同|版本|schema/);
});

test("旧 v1 寒暄及旧最终回答仍能解析", async () => {
  const legacy = quickAnalyticsReply("你好")!;
  const result = await stream.consumeAnalyticsStream(byteStream(`${JSON.stringify({ type: "result", result: legacy })}\n`));
  assert.deepEqual(result, legacy);
});

test("最终结果后不接受迟到过程或第二个结果，正文草稿增量被拒绝", async () => {
  const line = JSON.stringify({ type: "result", result: simulatedAnswer() });
  await assert.rejects(stream.consumeAnalyticsStream(byteStream(`${line}\n${JSON.stringify(progress)}\n`)), /最终结果/);
  assert.throws(() => stream.decodeAnalyticsStreamLine(JSON.stringify({ type: "text_delta", text: "未核验的经营判断" })), /类型/);
});

test("停止 v2 读取会取消上游 reader，迟到结果不能返回", async () => {
  const controller = new AbortController(); let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({ start(output) { output.enqueue(new TextEncoder().encode(`${JSON.stringify(progress)}\n`)); }, cancel() { cancelled = true; } }));
  const result = stream.consumeAnalyticsStream(response, () => controller.abort(), controller.signal);
  await assert.rejects(result, TurnCancelledError); assert.equal(cancelled, true);
});

test("同一网络分帧里停止后，不再递送后面的公开过程", async () => {
  const controller = new AbortController(); let delivered = 0;
  const response = new Response(`${JSON.stringify(progress)}\n${JSON.stringify({ ...progress, phase: "writing", at: 2 })}\n`);
  await assert.rejects(stream.consumeAnalyticsStream(response, () => { delivered++; controller.abort(); }, controller.signal), TurnCancelledError);
  assert.equal(delivered, 1);
});

test("JSON 回退读取期间取消，完整答案仍不能作为成功返回", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, headers: new Headers({ "content-type": "application/json" }), async json() { controller.abort(); return { explanation: simulatedAnswer() }; } }));
  await assert.rejects(postHistoryStream(request, () => {}, controller.signal), TurnCancelledError);
});

test("新版历史客户端精确发送 v2 协商头，JSON 兼容返回仍严格核验", async (t) => {
  let observed: Headers | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => { observed = new Headers(options.headers); return Response.json({ explanation: simulatedAnswer() }); });
  const result = await postHistoryStream(request, () => {});
  assert.equal(observed?.get("x-analytics-answer-schema"), "analysis-answer/v2"); assert.deepEqual(result, simulatedAnswer());
});

test("只允许精确版本声明，未知头不提升到 v2", () => {
  const normalize = (stream as unknown as { normalizeAnalyticsAnswerSchema: (value: string | null | undefined) => string | undefined }).normalizeAnalyticsAnswerSchema;
  assert.equal(typeof normalize, "function");
  assert.equal(normalize("analysis-answer/v2"), "analysis-answer/v2");
  for (const value of [null, undefined, "", "analysis-answer/v3", "ANALYSIS-ANSWER/V2", "v2", "analysis-answer/v2, analysis-answer/v1"]) assert.equal(normalize(value), undefined);
});

async function historyRouteScript(upstream: string) {
  const bundled = await build({
    stdin: { contents: 'import {POST} from "./app/api/analytics/history/route.ts"; export default {fetch:POST};', resolveDir: process.cwd() },
    bundle: true, write: false, format: "esm", platform: "browser",
    plugins: [{ name: "外部运行环境", setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "env", namespace: "boundary" }));
      builder.onResolve({ filter: /db\/index\.ts$/ }, () => ({ path: "db", namespace: "boundary" }));
      builder.onLoad({ filter: /.*/, namespace: "boundary" }, ({ path }) => ({ contents: path === "env" ? `export const env={AGENT_SERVICE_URL:${JSON.stringify(upstream)}};` : "export const getDbBinding=()=>({});" }));
    } }],
  });
  return bundled.outputFiles[0].text;
}
async function historyWorker(upstream: string) { return new Miniflare({ modules: true, compatibilityDate: "2026-05-15", compatibilityFlags: ["nodejs_compat", "enable_request_signal"], script: await historyRouteScript(upstream) }); }
const routeHeaders = { "content-type": "application/json", accept: "application/x-ndjson", cookie: "ctf_analytics_owner=11111111-1111-4111-8111-111111111111" };
test("真实 Node 到 Workers 再到客户端的大答案分块完整通过两次边界核验", { timeout: 10000 }, async () => {
  const answer = largeSimulatedAnswer();
  const server = createServer(createAgentHttpHandler({ token: "", model: "test", runAgentTurn: async () => { throw new Error("不能调用执行 Agent"); }, runGeneralAnalyticsTurn: async (_request, _signal, emit) => { emit?.({ type: "phase", phase: "writing", at: 1 }); return answer; } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  const worker = await historyWorker(`http://127.0.0.1:${address.port}`);
  try {
    const response = await worker.dispatchFetch("http://localhost/api/analytics/history", { method: "POST", headers: { ...routeHeaders, "X-Analytics-Answer-Schema": "analysis-answer/v2" }, body: JSON.stringify({ ...request, question: "你好" }) });
    assert.equal(response.status, 200); const events: stream.AnalyticsProgressEvent[] = [];
    const result = await stream.consumeAnalyticsStream(new Response(response.body as ReadableStream<Uint8Array>), (event) => events.push(event));
    assert.deepEqual(result, answer); assert.deepEqual(events, [{ type: "phase", phase: "writing", at: 1 }]);
  } finally { await worker.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("图表能力与已核验预览通过真实 Node、Workers、客户端整条链路，最终关联保持不变", { timeout: 10000 }, async () => {
  const answer = simulatedAnswer();
  answer.visualizations = { schema: "analysis-visualization/v1", items: [{ id: "verified-chart", revision: 1, kind: "bar", renderer: "html", afterBlockIndex: 1, conclusionId: "conclusion", source: { kind: "analysis", operationId: "operation", metricId: "amount", dimension: "store" }, selection: { mode: "all" } }] };
  const preview: stream.AnalyticsProgressEvent = { type: "visualization", schema: "analysis-visualization/v1", runId: answer.task.runId, epoch: 0, action: "upsert", preview: { spec: answer.visualizations.items[0], evidence: answer.evidence } };
  let capability: string | undefined;
  const server = createServer(createAgentHttpHandler({ token: "", model: "test", runAgentTurn: async () => { throw new Error("不能调用执行 Agent"); }, runGeneralAnalyticsTurn: async (_request, _signal, emit, visuals) => { capability = visuals; emit?.(preview); return answer; } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  const worker = await historyWorker(`http://127.0.0.1:${address.port}`);
  try {
    const response = await worker.dispatchFetch("http://localhost/api/analytics/history", { method: "POST", headers: { ...routeHeaders, "X-Analytics-Answer-Schema": "analysis-answer/v2", "X-Analytics-Visuals": "analysis-visualization/v1" }, body: JSON.stringify({ ...request, question: "你好" }) });
    assert.equal(response.status, 200); const events: stream.AnalyticsProgressEvent[] = [];
    const final = await stream.consumeAnalyticsStream(new Response(response.body as ReadableStream<Uint8Array>), (event) => events.push(event));
    assert.equal(capability, "analysis-visualization/v1"); assert.deepEqual(events, [preview]); assert.deepEqual(final, answer);
  } finally { await worker.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

async function deadline(promise: Promise<unknown>, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 1800); })]); }
  finally { clearTimeout(timer); }
}

test("静默等待时营销流只排队一个保活空行，恢复读取与取消正确清理", async (t) => {
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(await historyRouteScript("http://synthetic.invalid")).toString("base64")}`) as { default: { fetch: (request: Request) => Promise<Response> } };
  t.mock.timers.enable({ apis: ["setInterval"] }); const clear = t.mock.method(globalThis, "clearInterval");
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>()));
  const controller = new AbortController();
  const response = await loaded.default.fetch(new Request("http://localhost/api/analytics/history", { method: "POST", headers: routeHeaders, body: JSON.stringify(request), signal: controller.signal }));
  t.mock.timers.tick(3000); const reader = response.body!.getReader();
  let first: Uint8Array | undefined;
  const pending = reader.read().then((part) => { first = part.value; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(new TextDecoder().decode(first), "\n", "静默挂起也应写入一个保活空行，用于发现代理断连");
    await pending;
    let secondSettled = false; const second = reader.read().then(() => { secondSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(secondSettled, false, "没人读取时不累积保活队列");
    t.mock.timers.tick(250); await second;
  } finally { controller.abort(); await reader.cancel(); reader.releaseLock(); }
  assert.ok(clear.mock.callCount() > 0, "取消后应清理保活计时器");
});

test("真实 Workers 只转发精确 v2 版本声明，访问隔离仍生效", { timeout: 10000 }, async () => {
  const observed: Array<string | undefined> = [];
  const server = createServer(async (req, response) => { for await (const part of req) { void part; }
    observed.push(req.headers["x-analytics-answer-schema"] as string | undefined);
    response.writeHead(200, { "content-type": "application/x-ndjson" }); response.end(`${JSON.stringify({ type: "result", result: quickAnalyticsReply("你好") })}\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  const worker = await historyWorker(`http://127.0.0.1:${address.port}`);
  try {
    for (const schema of [undefined, "analysis-answer/v2", "analysis-answer/v3"]) {
      const response = await worker.dispatchFetch("http://localhost/api/analytics/history", { method: "POST", headers: { ...routeHeaders, ...(schema ? { "X-Analytics-Answer-Schema": schema } : {}) }, body: JSON.stringify(request) });
      assert.equal(response.status, 200); assert.deepEqual(await stream.consumeAnalyticsStream(new Response(response.body as ReadableStream<Uint8Array>)), quickAnalyticsReply("你好"));
    }
    assert.deepEqual(observed, [undefined, "analysis-answer/v2", undefined]);
    const denied = await worker.dispatchFetch("http://localhost/api/analytics/history", { method: "POST", headers: { ...routeHeaders, origin: "https://other.invalid", "X-Analytics-Answer-Schema": "analysis-answer/v2" }, body: JSON.stringify(request) });
    assert.equal(denied.status, 403); assert.equal(observed.length, 3);
  } finally { await worker.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("真实 Workers 静默等待时停止仍取消外部营销服务", { timeout: 10000 }, async () => {
  const started = Promise.withResolvers<void>(); const closed = Promise.withResolvers<void>();
  const server = createServer(async (req, response) => { for await (const part of req) { void part; }
    response.writeHead(200, { "content-type": "application/x-ndjson" }); response.write(`${JSON.stringify(progress)}\n`); started.resolve();
    response.on("close", () => closed.resolve());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  const worker = await historyWorker(`http://127.0.0.1:${address.port}`); const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(new URL("/api/analytics/history", await worker.ready), { method: "POST", headers: { ...routeHeaders, "X-Analytics-Answer-Schema": "analysis-answer/v2" }, body: JSON.stringify(request), signal: controller.signal });
    reader = response.body!.getReader(); await deadline(started.promise, "外部服务未开始");
    controller.abort(); await reader.read().catch(() => undefined); await deadline(closed.promise, "静默外部服务没有收到停止");
  } finally { controller.abort(); await reader?.cancel().catch(() => undefined); reader?.releaseLock(); await worker.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
