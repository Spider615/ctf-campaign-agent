import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import * as client from "../app/lib/client/analytics.ts";
import { sampleDataset } from "../app/lib/analytics/sample.ts";
import { runAnalysis } from "../app/lib/analytics/engine.ts";
import { quickAnalyticsReply } from "../app/lib/analytics/dialogue.ts";
import type { AnalysisReport } from "../app/lib/analytics/types.ts";
import type { AnalyticsAnswerResult } from "../app/lib/analytics/stream.ts";
import { TurnCancelledError } from "../app/lib/cancellation.ts";
import { consumeAnalyticsStream } from "../app/lib/analytics/stream.ts";
import { reportSource } from "../app/lib/analytics/advisor.ts";
import { simulatedAnswer } from "./helpers/analysis-v2-answer.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const dataset = sampleDataset();
const report: AnalysisReport = { ...runAnalysis(dataset, { period: { start: "2026-08-01", end: "2026-09-30" }, filters: {} }), id: "simulated-report", createdAt: "2026-10-13T00:00:00Z" };
function answer() {
  const result = simulatedAnswer(); result.evidence.frames[0].mode = "snapshot";
  result.evidence.frames[0].datasetVersion = report.datasetVersion;
  result.evidence.frames[0].scope.period = { ...report.query.period };
  return result;
}
function explain() {
  const method = (client as unknown as { explainAnalyticsReport?: (report: AnalysisReport, question: string, signal?: AbortSignal) => Promise<AnalyticsAnswerResult> }).explainAnalyticsReport;
  assert.equal(typeof method, "function", "导入报告应使用严格校验的 v2 客户端入口"); return method!;
}

test("导入报告客户端发送精确 v2，读取新正文且保持原报告不变", async (t) => {
  const original = structuredClone(report); let sent: { headers?: Headers; body?: unknown } = {};
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => { sent = { headers: new Headers(options.headers), body: JSON.parse(String(options.body)) }; return Response.json({ explanation: answer() }); });
  assert.deepEqual(await explain()(report, "先核对哪些门店？"), answer());
  assert.equal(sent.headers?.get("x-analytics-answer-schema"), "analysis-answer/v2");
  assert.equal(sent.headers?.get("content-type"), "application/json"); assert.deepEqual(sent.body, { question: "先核对哪些门店？" });
  assert.deepEqual(report, original);
});

test("通用分析请求的可选头不会覆盖 JSON 编码或原取消信号", async (t) => {
  const controller = new AbortController(); let sent: RequestInit | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => { sent = options; return Response.json({ okay: true }); });
  const invoke = client.analyticsRequest as (path: string, body: unknown, signal: AbortSignal, headers: HeadersInit) => Promise<unknown>;
  assert.deepEqual(await invoke("/api/analytics/example", { sample: true }, controller.signal, new Headers({ "X-Analytics-Answer-Schema": "analysis-answer/v2" })), { okay: true });
  assert.equal(new Headers(sent?.headers).get("x-analytics-answer-schema"), "analysis-answer/v2");
  assert.equal(new Headers(sent?.headers).get("content-type"), "application/json"); assert.equal(sent?.signal, controller.signal); assert.equal(sent?.credentials, "same-origin");
});

test("报告客户端兼容 v1 返回，损坏 v2 引用不能进入界面", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ explanation: quickAnalyticsReply("你好") }));
  assert.deepEqual(await explain()(report, "你好"), quickAnalyticsReply("你好"));
  const invalid = answer(); invalid.blocks[0].nodes.push({ kind: "fact_ref", factId: "not-read" });
  t.mock.method(globalThis, "fetch", async () => Response.json({ explanation: invalid }));
  await assert.rejects(explain()(report, "继续核对"), /引用|事实|证据/);
});

test("报告 JSON 读取期间停止，迟到答案不能作为成功返回", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, headers: new Headers({ "content-type": "application/json" }), async json() { controller.abort(); return { explanation: answer() }; } }));
  await assert.rejects(explain()(report, "继续核对", controller.signal), TurnCancelledError);
});

test("报告新客户端解析 NDJSON 最终答案，并声明流以便静默等待可停止", async (t) => {
  let headers: Headers | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => { headers = new Headers(options.headers); return new Response(`\n${JSON.stringify({ type: "result", result: answer() })}\n`, { headers: { "content-type": "application/x-ndjson" } }); });
  assert.deepEqual(await explain()(report, "核对原报告"), answer()); assert.equal(headers?.get("accept"), "application/x-ndjson");
});

test("报告流保持 v1 原报告出处核验，不能按数据库对话口径读取", async () => {
  const source = reportSource(report, "overall");
  const legacy = { insightIds: [], nextDimensions: [], tools: [], skills: [], sources: [source], advice: [{ kind: "recommendation", text: "先核对当前报告的口径，再决定下一步。", evidenceIds: [source.id] }] };
  const response = new Response(`${JSON.stringify({ type: "result", result: legacy })}\n`);
  const parsed = await consumeAnalyticsStream(response, undefined, undefined, report);
  assert.ok("sources" in parsed); assert.deepEqual(parsed.sources, [source]); assert.equal(parsed.insightIds.length, 0);
});

async function reportRouteScript(upstream: string) {
  const db = `const report=${JSON.stringify(report)}, dataset=${JSON.stringify(dataset)}, owner=${JSON.stringify(owner)};
    export const getDbBinding=()=>({prepare(sql){let args=[];return {bind(...values){args=values;return this;}, async first(){if(args[1]!==owner)return null; if(sql.includes('analytics_report'))return {report_json:JSON.stringify(report)}; if(sql.includes('analytics_dataset'))return {snapshot_json:JSON.stringify(dataset)}; throw Error('不支持其他读取');},async run(){throw Error('报告解释不能写入数据');}};}});`;
  const bundled = await build({ stdin: { contents: 'import { POST } from "./app/api/analytics/reports/[id]/explain/route.ts"; export default {fetch:request=>POST(request,{params:Promise.resolve({id:"simulated-report"})})};', resolveDir: process.cwd() }, bundle: true, write: false, format: "esm", platform: "browser", plugins: [{ name: "合成数据存储与服务边界", setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "env", namespace: "boundary" }));
    builder.onResolve({ filter: /db\/index\.ts$/ }, () => ({ path: "db", namespace: "boundary" }));
    builder.onLoad({ filter: /.*/, namespace: "boundary" }, ({ path }) => ({ contents: path === "env" ? `export const env={AGENT_SERVICE_URL:${JSON.stringify(upstream)}};` : db }));
  } }] });
  return bundled.outputFiles[0].text;
}
async function reportWorker(upstream: string) { return new Miniflare({ modules: true, compatibilityDate: "2026-05-15", compatibilityFlags: ["nodejs_compat", "enable_request_signal"], script: await reportRouteScript(upstream) }); }
const headers = { "content-type": "application/json", cookie: `ctf_analytics_owner=${owner}` };

test("报告流在 Node 静默等待时返回一个保活空行，取消清理且没有伪造业务事件", async (t) => {
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(await reportRouteScript("http://synthetic.invalid")).toString("base64")}`) as { default: { fetch: (request: Request) => Promise<Response> } };
  t.mock.timers.enable({ apis: ["setInterval"] }); const cleared = t.mock.method(globalThis, "clearInterval");
  let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({ start(output) { upstream = output; } })));
  const controller = new AbortController(); let response: Response | undefined; let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const pending = loaded.default.fetch(new Request("http://localhost/report", { method: "POST", headers: { ...headers, accept: "application/x-ndjson", "X-Analytics-Answer-Schema": "analysis-answer/v2" }, body: JSON.stringify({ question: "核对当前报告" }), signal: controller.signal })).then((value) => { response = value; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(response, "静默服务仍应先返回流以便代理检测浏览器断连"); await pending;
    assert.match(response.headers.get("content-type")!, /ndjson/); t.mock.timers.tick(3000);
    reader = response.body!.getReader(); assert.equal(new TextDecoder().decode((await reader.read()).value), "\n");
    let settled = false; const next = reader.read().then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(settled, false, "无人读取时不堆积保活空行");
    t.mock.timers.tick(250); await next;
  } finally { controller.abort(); upstream?.error(new TurnCancelledError()); await reader?.cancel(); reader?.releaseLock(); await pending; }
  assert.ok(cleared.mock.callCount() > 0, "停止后清理保活计时器");
});

test("真实报告 API 转发 v2，旧无头及未知头保留 v1，用户数据与访问隔离不变", { timeout: 10000 }, async () => {
  const calls: Array<{ schema: string | undefined; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part.toString("utf8");
    const schema = request.headers["x-analytics-answer-schema"] as string | undefined; calls.push({ schema, body: JSON.parse(body) });
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(schema === "analysis-answer/v2" ? answer() : quickAnalyticsReply("你好")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert.ok(address && typeof address === "object");
  const worker = await reportWorker(`http://127.0.0.1:${address.port}`);
  try {
    for (const schema of ["analysis-answer/v2", undefined, "analysis-answer/v3"]) {
      const response = await worker.dispatchFetch("http://localhost/api/analytics/reports/simulated-report/explain", { method: "POST", headers: { ...headers, ...(schema ? { "X-Analytics-Answer-Schema": schema } : {}) }, body: JSON.stringify({ question: "先核对哪些门店？" }) });
      assert.equal(response.status, 200); const body = await response.json() as { explanation: unknown };
      assert.deepEqual(body.explanation, schema === "analysis-answer/v2" ? answer() : quickAnalyticsReply("你好"));
    }
    assert.deepEqual(calls.map((call) => call.schema), ["analysis-answer/v2", undefined, undefined]);
    assert.deepEqual((calls[0].body as { report: unknown }).report, report); assert.deepEqual((calls[0].body as { dataset: unknown }).dataset, dataset);
    const denied = await worker.dispatchFetch("http://localhost/api/analytics/reports/simulated-report/explain", { method: "POST", headers: { ...headers, cookie: "ctf_analytics_owner=22222222-2222-4222-8222-222222222222", "X-Analytics-Answer-Schema": "analysis-answer/v2" }, body: JSON.stringify({ question: "继续核对" }) });
    assert.equal(denied.status, 404); assert.equal(calls.length, 3);
  } finally { await worker.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
