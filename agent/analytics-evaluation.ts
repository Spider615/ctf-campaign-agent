import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createPlanAnalyticsRunner, privateAnalysisDirectory } from "./analysis-plan-run-turn.ts";
import { analyticsBenchmarks } from "../tests/fixtures/general-analytics.ts";
import { runAnalysis } from "../app/lib/analytics/engine.ts";
import { planAnswerV4Text } from "../app/lib/analytics/plan/answer.ts";
import { PLAN_ANSWER_V4_SCHEMA } from "../app/lib/analytics/analysis-v2-types.ts";
import { createSnapshotAnalysisProvider } from "../app/lib/analytics/analysis-v2-snapshot.ts";
import { modelConfigFromEnv } from "./model-gateway.ts";

const envPath = fileURLToPath(new URL("../.dev.vars", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
const gateway = await modelConfigFromEnv();
if (!gateway.apiKey) throw new Error("真实模型评估需要已配置的模型密钥");
const selected = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
const cases = selected ? analyticsBenchmarks.filter((item) => item.id === selected) : analyticsBenchmarks;
if (!cases.length) throw new Error("没有这个合成评估用例");
const output = privateAnalysisDirectory(process.env.ANALYTICS_EVAL_DIR || join(tmpdir(), `ctf-analysis-evaluation-${Date.now()}`));
mkdirSync(output, { recursive: true, mode: 0o700 });
const results: unknown[] = [];
const model = gateway.model;
const versionFiles = ["agent/analytics-evaluation.ts", "tests/fixtures/general-analytics.ts", "agent/analysis-plan-run-turn.ts", "agent/analytics-system-prompt.ts", "agent/analytics-model.ts", "app/lib/analytics/analysis-v2-types.ts", "app/lib/analytics/analysis-v2-operations.ts", "app/lib/analytics/analysis-v2-snapshot.ts", "app/lib/analytics/analysis-v2-evidence.ts", "app/lib/analytics/plan/validate.ts", "app/lib/analytics/plan/execute.ts", "app/lib/analytics/plan/bind.ts", "app/lib/analytics/plan/answer.ts", "app/lib/analytics/plan/prompt.ts", "app/lib/analytics/plan/scenario.ts"];
const readVersions = () => Object.fromEntries(versionFiles.map((path) => [path, createHash("sha256").update(readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)))).digest("hex")]));
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort()); process.once("SIGINT", () => controller.abort());
for (const item of cases) {
  if (controller.signal.aborted) break;
  let calls = 0; const started = performance.now(); const versions = readVersions();
  const responseIds = new Set<string>(); const responseUsage = new Map<string, unknown>();
  // 计划流程每一步是一次独立 SDK 会话（计划、复核、措辞等），按调用顺序记录。
  const sessions: Array<{ id: number; role: "step"; responseIds: string[] }> = [];
  const syntheticMessages: Array<{ sessionId: number; error?: string; model: string }> = [];
  const observedQuery: typeof query = (args) => {
    calls++;
    const session = { id: calls, role: "step" as const, responseIds: [] as string[] }; sessions.push(session);
    const recordResponse = (id: string, usage: unknown) => { responseIds.add(id); if (!session.responseIds.includes(id)) session.responseIds.push(id); responseUsage.set(id, { role: session.role, usage }); };
    const stream = query({ ...args, options: { ...args.options, includePartialMessages: true } });
    // 只留响应标识和计费用量；不捕获隐藏思维、系统提示或完整模型消息。
    return new Proxy(stream, { get(target, property, receiver) {
      if (property !== Symbol.asyncIterator) { const value = Reflect.get(target, property, receiver); return typeof value === "function" ? value.bind(target) : value; }
      return () => {
        const iterator = target[Symbol.asyncIterator]();
        return { async next() {
          const next = await iterator.next();
          if (!next.done) {
            const item = next.value;
            if (item.type === "stream_event" && item.event.type === "message_start" && item.event.message.model !== "<synthetic>") {
              recordResponse(item.event.message.id, item.event.message.usage);
            } else if (item.type === "assistant") {
              // SDK 的 API 错误也会包装成 assistant；只按本地 SDK 的显式错误标记判定，不猜响应编号。
              if (item.error || item.message.model === "<synthetic>") {
                syntheticMessages.push({ sessionId: session.id, error: item.error, model: item.message.model });
                responseIds.delete(item.message.id); responseUsage.delete(item.message.id);
                session.responseIds = session.responseIds.filter((id) => id !== item.message.id);
              } else recordResponse(item.message.id, item.message.usage);
            }
          }
          return next;
        }, return: iterator.return?.bind(iterator), throw: iterator.throw?.bind(iterator) };
      };
    } });
  };
  const runner = createPlanAnalyticsRunner({ model, modelBaseUrl: gateway.modelBaseUrl, apiKey: gateway.apiKey, pluginDir: fileURLToPath(new URL("./analytics-plugin", import.meta.url)), runtimeDir: join(output, "runtime"), auditDirectory: join(output, "audit") }, { query: observedQuery, ...(item.context?.length ? { provider: createSnapshotAnalysisProvider(item.dataset) } : {}) });
  try {
    // 数据版本授权来自报告或注入的同版本只读合成适配器；期望不传入模型。
    // 带持续条件的用例走实际对话 context/history 协议，不拼回本轮问题冒充上下文。
    const report = { ...runAnalysis(item.dataset, { period: { start: item.dataset.minDate, end: item.dataset.maxDate }, filters: {} }), id: `eval-${item.id}`, createdAt: new Date().toISOString() };
    const request = item.context?.length ? { mode: "database" as const, question: item.question, context: item.context, history: item.context.map((text) => ({ role: "user" as const, text })) } : { report, dataset: item.dataset, question: item.question };
    const answer = await runner(request, controller.signal, (event) => { if (event.type === "trace" && event.event.status !== "started") console.log(JSON.stringify({ id: item.id, action: event.event.title, status: event.event.status })); });
    if (!("schema" in answer) || answer.schema !== PLAN_ANSWER_V4_SCHEMA) throw new Error("分析评估未返回计划式结构化结果");
    const failures = item.check(answer);
    const endingVersions = readVersions(); const changedFiles = versionFiles.filter((path) => versions[path] !== endingVersions[path]);
    const result = { id: item.id, family: item.family, model, versions, endingVersions, changedFiles, calls, sessions, modelResponses: responseIds.size, syntheticMessages, responseUsage: Object.fromEntries(responseUsage), callCountDefinition: "calls为SDK会话数，modelResponses为已收到唯一真实模型响应数；SDK合成API错误及无响应的上游重试不计入", usageDefinition: "SDK起始块和assistant块的用量元数据可能不是最终总计，不用于费用核算", durationMs: Math.round(performance.now() - started), status: answer.status, passed: failures.length === 0, manualBusinessReview: "required", expectation: item.expectation, failures, text: planAnswerV4Text(answer), answer };
    results.push(result); writeFileSync(join(output, `${item.id}.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ id: item.id, calls, modelResponses: responseIds.size, durationMs: result.durationMs, status: answer.status, passed: result.passed, manualBusinessReview: "required", changedFiles, failures }));
  } catch (error) {
    const result = { id: item.id, family: item.family, model, versions, endingVersions: readVersions(), passed: false, calls, sessions, modelResponses: responseIds.size, syntheticMessages, callCountDefinition: "SDK合成API错误不计为真实模型响应", durationMs: Math.round(performance.now() - started), expectation: item.expectation, error: error instanceof Error ? error.message : "评估失败" };
    results.push(result); writeFileSync(join(output, `${item.id}.json`), JSON.stringify(result, null, 2), { mode: 0o600 }); console.log(JSON.stringify({ id: item.id, passed: false, calls, modelResponses: responseIds.size, durationMs: result.durationMs, error: result.error }));
  }
  writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
}
console.log(`真实模型评估记录：${output}`);
if (results.some((result) => !(result as { passed: boolean }).passed)) process.exitCode = 1;
