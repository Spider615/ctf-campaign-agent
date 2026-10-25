import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { query } from "@anthropic-ai/claude-agent-sdk";
import mysql from "mysql2/promise";
import { createAnalyticsSkillRunner } from "./analytics-skill-run-turn.ts";
import type { AgentQuery } from "./run-turn.ts";
import { privateAnalyticsDirectory } from "./analytics-private-records.ts";
import { createModelGateway, DEFAULT_AGENT_MODEL, DEFAULT_MODEL_GATEWAY_URL, modelConfigFromEnv } from "./model-gateway.ts";
import { sdkModelName } from "./openai-bridge.ts";
import { createMysqlAnalysisProvider } from "./analytics-operation-database.ts";
import { pruneRecoveredSource } from "./analytics-database.ts";
import { createSnapshotAnalysisProvider } from "../app/lib/analytics/analysis-v2-snapshot.ts";
import { runAnalysis } from "../app/lib/analytics/engine.ts";
import { planAnswerV4Text } from "../app/lib/analytics/plan/answer.ts";
import { analyticsBenchmarks } from "../tests/fixtures/general-analytics.ts";
import type { AnalyticsSkillRunner } from "./analytics-runner-types.ts";
import type { AnalysisDataProvider, PlanAnswerV4 } from "../app/lib/analytics/analysis-v2-types.ts";

// 开发验收入口：只记录公开动作、计数与证据，不保存SDK消息、系统提示或隐藏思维。
type Case = { id: string; source: "database" | "snapshot"; request: Parameters<AnalyticsSkillRunner>[0]; metadata?: Record<string, unknown> };
const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const effort = option("effort");
if (effort !== undefined && !["low", "medium", "high", "max"].includes(effort)) throw new Error("验收推理强度须为low、medium、high或max");
const envPath = fileURLToPath(new URL("../.dev.vars", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const provider = process.env.AGENT_PROVIDER?.trim() || "juzi";
if (!["juzi", "deepseek"].includes(provider)) throw new Error("真实问答验收的服务选择不正确");
const native = provider === "deepseek";
const selectedModel = option("model");
if (selectedModel !== undefined && (!native || !["deepseek-flash", "deepseek-v4-pro"].includes(selectedModel))) throw new Error("验收模型对照仅支持当前原生服务的已知模型");
const apiKey = (native ? process.env.DEEPSEEK_API_KEY : process.env.JUZI_MODELS_KEY)?.trim();
if (!apiKey) throw new Error("真实问答验收需要已配置的模型密钥");
const output = privateAnalyticsDirectory(option("output") || join(homedir(), `Library/Application Support/ctf-campaign-agent/skill-qa-evaluation-${Date.now()}`));
const input = option("input");
let cases: Case[];
if (input) {
  const path = resolve(input); privateAnalyticsDirectory(dirname(path));
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw) || raw.some((value) => !value || typeof value !== "object" || typeof value.id !== "string" || !["database", "snapshot"].includes(value.source) || !value.request || typeof value.request.question !== "string")) throw new Error("评估输入须为含id、source及完整request的私有用例数组");
  cases = raw as Case[];
} else {
  cases = analyticsBenchmarks.map((item) => ({ id: item.id, source: "snapshot", request: { report: { ...runAnalysis(item.dataset, { period: { start: item.dataset.minDate, end: item.dataset.maxDate }, filters: {} }), id: `skill-eval-${item.id}`, createdAt: new Date().toISOString() }, dataset: item.dataset, question: item.question }, metadata: { family: item.family, expectation: item.expectation, context: item.context } }));
  cases = cases.map((item) => {
    const benchmark = analyticsBenchmarks.find((test) => test.id === item.id)!;
    return benchmark.context?.length ? { ...item, request: { mode: "database", question: benchmark.question, history: benchmark.context.map((text) => ({ role: "user", text })), context: benchmark.context } } : item;
  });
}
const selected = option("case")?.split(","); if (selected) cases = cases.filter((item) => selected.includes(item.id));
if (!cases.length) throw new Error("没有符合条件的问答验收用例");
let current = { apiRequests: 0, apiFailures: 0, sqlQueries: 0, sqlExecutionMs: 0, sqlQueueMs: 0, sdkQueries: 0, sdkSkills: [] as string[], sdkTools: [] as string[] };
const realFetch = globalThis.fetch;
const gateway = native ? undefined : createModelGateway({ baseUrl: process.env.MODEL_GATEWAY_URL || DEFAULT_MODEL_GATEWAY_URL, maxOutputTokens: Number(process.env.MODEL_MAX_OUTPUT_TOKENS) || 8192, log: () => {}, fetch: async (url, init) => {
  const modelRequest = String(url).endsWith("/chat/completions"); if (modelRequest) current.apiRequests++;
  try { const response = await realFetch(url, init); if (modelRequest && !response.ok) current.apiFailures++; return response; }
  catch (error) { if (modelRequest) current.apiFailures++; throw error; }
} });
const nativeConfig = native ? await modelConfigFromEnv() : undefined;
const modelBaseUrl = nativeConfig?.modelBaseUrl ?? await gateway!.listen();
const model = selectedModel ?? nativeConfig?.model ?? sdkModelName(process.env.AGENT_MODEL || DEFAULT_AGENT_MODEL);
// 只在验收进程中计数原生HTTP请求；不记录请求头、提示词、响应正文或隐藏思维。
const meter = native ? createServer((incoming, response) => { void (async () => {
  const path = new URL(incoming.url ?? "/", "http://local");
  if (incoming.method !== "POST" || !["/v1/messages", "/v1/messages/count_tokens"].includes(path.pathname)) { response.writeHead(404).end(); return; }
  const modelRequest = path.pathname === "/v1/messages";
  if (modelRequest) current.apiRequests++;
  const controller = new AbortController();
  response.on("close", () => { if (!response.writableEnded) controller.abort(); });
  const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && !["host", "content-length", "connection", "transfer-encoding"].includes(name)) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  // SDK支持zstd，Node 22的计数中转不解该编码；明确协商原文，避免把压缩字节当JSON。
  headers.set("accept-encoding", "identity");
  let failureCounted = false;
  try {
    const upstream = await realFetch(modelBaseUrl.replace(/\/$/, "") + path.pathname + path.search, { method: "POST", headers, body: Buffer.concat(chunks), signal: controller.signal });
    if (upstream.headers.get("content-encoding")) console.log(JSON.stringify({ phase: "native_transport", encoding: upstream.headers.get("content-encoding"), contentType: upstream.headers.get("content-type") }));
    if (modelRequest && !upstream.ok) { current.apiFailures++; failureCounted = true; }
    const returned: Record<string, string> = {}; upstream.headers.forEach((value, name) => { if (!["content-length", "content-encoding", "connection", "transfer-encoding"].includes(name)) returned[name] = value; });
    response.writeHead(upstream.status, returned);
    if (upstream.body) { const reader = upstream.body.getReader(); try { while (true) { const part = await reader.read(); if (part.done) break; if (!response.destroyed) response.write(part.value); } } finally { reader.releaseLock(); } }
    if (!response.destroyed) response.end();
  } catch {
    if (modelRequest && !failureCounted) current.apiFailures++;
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: "验收请求连接未完成" } }));
    else response.end();
  }
})().catch(() => { if (!response.destroyed) response.destroy(); }); }) : undefined;
let sdkBaseUrl = modelBaseUrl;
if (meter) { await new Promise<void>((resolve) => meter.listen(0, "127.0.0.1", resolve)); const address = meter.address(); if (!address || typeof address === "string") throw new Error("验收请求计数服务未启动"); sdkBaseUrl = `http://127.0.0.1:${address.port}`; }
const observedQuery: AgentQuery = async function* (params) {
  current.sdkQueries++;
  const observed = { ...params, options: { ...params.options, ...(effort ? { effort: effort as "low" | "medium" | "high" | "max" } : {}), ...(native ? { env: { ...params.options?.env, ANTHROPIC_BASE_URL: sdkBaseUrl } } : {}) } };
  for await (const message of query(observed)) {
    if (message.type === "system" && message.subtype === "init") { current.sdkSkills = [...(message.skills ?? [])]; current.sdkTools = [...message.tools]; }
    yield message;
  }
};
const mysqlConfig = { host: process.env.CTF_MYSQL_HOST || "", port: Number(process.env.CTF_MYSQL_PORT || 3306), user: process.env.CTF_MYSQL_USER || "root", password: process.env.CTF_MYSQL_PASSWORD || "", database: process.env.CTF_MYSQL_DATABASE || "ctf_sales_202508", table: process.env.CTF_MYSQL_TABLE || "sales_detail_202508", evidenceDir: join(output, "mysql-evidence") };
const databaseProvider = mysqlConfig.host ? createMysqlAnalysisProvider(mysqlConfig, {
  connect: async () => {
    const connection = await mysql.createConnection({ host: mysqlConfig.host, port: mysqlConfig.port, user: mysqlConfig.user, password: mysqlConfig.password, database: mysqlConfig.database, charset: "utf8mb4", connectTimeout: 5000, multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true });
    const record = async <T>(work: () => Promise<T>) => { const start = performance.now(); current.sqlQueries++; try { return await work(); } finally { current.sqlExecutionMs += performance.now() - start; } };
    return { query: (sql: string) => record(() => connection.query(sql)), execute: (sql: string, values?: string[]) => record(() => connection.execute(sql, values)), destroy: () => connection.destroy() };
  }, pruneSource: pruneRecoveredSource, onQueueWait: (ms: number) => { current.sqlQueueMs += ms; },
}) : undefined;
const versions = () => Object.fromEntries(["agent/analytics-skill-evaluation.ts", "agent/model-gateway.ts", "agent/analytics-model.ts", "agent/analytics-skill-run-turn.ts", "agent/analytics-skill-tools.ts", "agent/analytics-operation-database.ts", "app/lib/analytics/analysis-v2-operations.ts", "app/lib/analytics/analysis-v2-types.ts", "app/lib/analytics/database.ts", "app/lib/analytics/analysis-v2-snapshot.ts", "app/lib/analytics/semantic/model.ts", "app/lib/analytics/qa/capabilities.ts", "app/lib/analytics/qa/results.ts", "app/lib/analytics/qa/chart.ts", "app/lib/analytics/qa/observations.ts", "app/lib/analytics/qa/answer.ts", "agent/analytics-plugin/skills/ctf-qa/SKILL.md", "agent/analytics-plugin/skills/marketing-theory/SKILL.md"].map((path) => [path, createHash("sha256").update(readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)))).digest("hex")]));
const controller = new AbortController(); process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
const records: Array<Record<string, unknown>> = [];
try {
  for (const item of cases) {
    if (controller.signal.aborted) break;
    current = { apiRequests: 0, apiFailures: 0, sqlQueries: 0, sqlExecutionMs: 0, sqlQueueMs: 0, sdkQueries: 0, sdkSkills: [], sdkTools: [] };
    const start = performance.now(), before = versions();
    let provider: AnalysisDataProvider | undefined;
    if (item.source === "database") { if (!databaseProvider) throw new Error("数据库用例需要现有只读数据库配置"); provider = databaseProvider; }
    else {
      const benchmark = analyticsBenchmarks.find((value) => value.id === item.id);
      const dataset = "dataset" in item.request ? item.request.dataset : benchmark?.dataset;
      if (!dataset) throw new Error("合成用例缺少授权数据快照"); provider = createSnapshotAnalysisProvider(dataset);
    }
    console.log(JSON.stringify({ id: item.id, phase: "started", source: item.source }));
    let answer: PlanAnswerV4 | undefined, error: string | undefined;
    try {
      answer = await createAnalyticsSkillRunner({ model, modelBaseUrl, apiKey, pluginDir: fileURLToPath(new URL("./analytics-plugin", import.meta.url)), runtimeDir: join(output, "runtime"), auditDirectory: join(output, "audit") }, { query: observedQuery, provider })(item.request, controller.signal, (event) => {
        if (event.type === "trace" && event.event.status !== "started") console.log(JSON.stringify({ id: item.id, tool: event.event.tool, status: event.event.status }));
      });
    } catch (caught) { error = (caught instanceof Error ? caught.message : "评估失败").replaceAll(apiKey, "[已隐藏]"); }
    const durationMs = Math.round(performance.now() - start), after = versions();
    const benchmark = item.source === "snapshot" ? analyticsBenchmarks.find((value) => value.id === item.id) : undefined;
    const record = { id: item.id, source: item.source, provider: native ? "official-native" : "company-gateway", request: item.request, metadata: item.metadata, durationMs, counters: { ...current, sqlExecutionMs: Math.round(current.sqlExecutionMs), sqlQueueMs: Math.round(current.sqlQueueMs) }, status: answer?.status ?? (controller.signal.aborted ? "cancelled" : "failed"), error, actualSkills: answer?.trace?.steps.filter((step) => step.tool === "load_analytics_skill" && step.status === "completed").map((step) => step.title) ?? [], legacyOracleNotes: answer && benchmark ? benchmark.check(answer) : undefined, manualBusinessReview: "required", before, after, changedDuringRun: Object.keys(before).filter((path) => before[path] !== after[path]), answer, text: answer ? planAnswerV4Text(answer) : undefined, measurement: { selectedModel: model, reasoningEffort: effort ?? "sdk-default", sdkQueries: "SDK启动次数", apiRequests: native ? "实际原生messages请求，含上游失败/重试；token计数请求不计入" : "实际chat/completions请求，含上游失败/重试", transport: native ? "计数中转协商identity编码，仅转发原生协议，不改业务请求或结果" : "既有网关转换", sqlExecutionMs: "真实连接query/execute耗时合计，含准备查询，不含证据落盘", sqlQueueMs: "数据库会话内真实入队等待合计；并发区间不能直接相加当总耗时", cache: "未启用跨会话缓存；旧Oracle仅作对照，不强制模型复刻原流程" } };
    records.push(record); writeFileSync(join(output, `${item.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`), JSON.stringify(record, null, 2), { mode: 0o600 });
    writeFileSync(join(output, "results.json"), JSON.stringify(records, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ id: item.id, durationMs, status: record.status, sdkQueries: current.sdkQueries, apiRequests: current.apiRequests, sqlQueries: current.sqlQueries, sqlExecutionMs: Math.round(current.sqlExecutionMs), error, manualBusinessReview: "required" }));
  }
} finally { if (meter) { meter.closeAllConnections(); await new Promise<void>((resolve) => meter.close(() => resolve())); } await gateway?.close(); await nativeConfig?.close(); }
console.log(JSON.stringify({ output, cases: records.length, failed: records.filter((item) => item.status === "failed").length }));
