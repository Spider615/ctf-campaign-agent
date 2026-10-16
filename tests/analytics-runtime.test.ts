import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import type { SDKMessage } from "../agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts";
import { createAnalyticsRunner, validateAnalyticsSkills } from "../agent/analytics-run-turn.ts";
import type { AgentQuery } from "../agent/run-turn.ts";
import { createAnalyticsTools } from "../agent/analytics-tools.ts";
import { inspectHistoricalKnowledge, readHistoricalCase } from "../agent/analytics-history.ts";
import { validateAnalyticsResponse } from "../app/lib/analytics/explain.ts";
import { sampleDataset } from "../app/lib/analytics/sample.ts";
import { runAnalysis } from "../app/lib/analytics/engine.ts";
import { sourceStatement } from "../app/lib/analytics/advisor.ts";
import type { AgentTraceEvent } from "../app/lib/tool-trace.ts";

const dataset = sampleDataset();
const report = { ...runAnalysis(dataset, { period: { start: "2026-08-01", end: "2026-09-30" }, filters: {} }), id: "runtime-test", createdAt: "2026-10-13" };
const request = { dataset, report, question: "找到可验证的营销优化角度" };
const pluginDir = join(process.cwd(), "agent/analytics-plugin");
const base = "analytics:analysis-review"; const advisor = "analytics:ctf-marketing-advisor";
function* skill(name: string, failed = false): Generator<SDKMessage> {
  yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", id: name, input: { skill: name } }] } } as SDKMessage;
  yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: name, content: failed ? "失败" : "已加载", is_error: failed }] } } as SDKMessage;
}
const result = (output: unknown) => ({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(output), structured_output: output } as SDKMessage);
function runtime(t: { after: (fn: () => void) => void }) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-advisor-runtime-")); t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return { model: "test", apiKey: "test", modelBaseUrl: "https://example.invalid", runtimeDir, pluginDir };
}
async function connect(options: Parameters<AgentQuery>[0]["options"]) {
  const server = options!.mcpServers!.analytics; assert.ok("instance" in server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "营销工具验收", version: "1" });
  await server.instance.connect(serverTransport); await client.connect(clientTransport); return client;
}

test("营销回合真实 MCP 门禁、读取动作和结构化出处贯通，不调用模型", async (t) => {
  const before = structuredClone(request);
  const config = runtime(t); const advisorOnly = join(config.runtimeDir, "advisor-only");
  mkdirSync(join(advisorOnly, ".claude-plugin"), { recursive: true }); mkdirSync(join(advisorOnly, "skills/ctf-marketing-advisor"), { recursive: true });
  writeFileSync(join(advisorOnly, ".claude-plugin/plugin.json"), readFileSync(join(pluginDir, ".claude-plugin/plugin.json")));
  writeFileSync(join(advisorOnly, "skills/ctf-marketing-advisor/SKILL.md"), readFileSync(join(pluginDir, "skills/ctf-marketing-advisor/SKILL.md")));
  const query: AgentQuery = async function* ({ options }) {
    const client = await connect(options);
    try {
      assert.equal((await client.callTool({ name: "inspect_dataset", arguments: {} })).isError, true);
      assert.deepEqual(options!.skills, [advisor]);
      const denied = await options!.canUseTool!("Skill", { skill: base }, { signal: options!.abortController!.signal, toolUseID: "check", requestId: "check" });
      assert.ok(denied); assert.equal(denied.behavior, "deny");
      const allowed = await options!.canUseTool!("Skill", { skill: advisor }, { signal: options!.abortController!.signal, toolUseID: "check", requestId: "check" });
      assert.ok(allowed); assert.equal(allowed.behavior, "allow");
      yield* skill(advisor);
      yield { type: "assistant", message: { content: [{ type: "text", text: "未核验的销售增长999%，不应展示" }] } } as SDKMessage;
      for (const name of ["inspect_dataset", "discover_segments"]) assert.notEqual((await client.callTool({ name, arguments: {} })).isError, true);
      const source = await client.callTool({ name: "read_analysis_evidence", arguments: { evidenceId: "overall" } });
      assert.notEqual(source.isError, true);
      yield result({ insightIds: [], nextDimensions: ["category"], advice: [
        { kind: "observation", text: "", evidenceIds: ["report:overall"], metricLabels: ["净销售额"] },
        { kind: "hypothesis", text: "总额差异可能受货品结构影响，需要继续拆分核对", evidenceIds: ["report:overall"] },
        { kind: "recommendation", text: "先在同店同货类核对，再设置门店试验", evidenceIds: ["report:overall"] },
      ] });
    } finally { await client.close(); }
  };
  const events: Array<{ type: string; event?: AgentTraceEvent }> = [];
  const answer = await createAnalyticsRunner({ ...config, pluginDir: advisorOnly }, { query })(request, undefined, (event) => events.push(event));
  assert.deepEqual(answer.skills, [advisor]);
  assert.deepEqual(answer.tools, ["inspect_dataset", "discover_segments", "read_analysis_evidence"]);
  assert.equal(answer.sources!.length, 1); assert.equal(answer.sources![0].datasetVersion, dataset.version);
  assert.match(answer.advice![0].text, /净销售额/); assert.doesNotThrow(() => validateAnalyticsResponse(report, answer));
  assert.deepEqual(request, before);
  assert.ok(events.some((event) => event.type === "trace" && event.event?.tool === "inspect_dataset" && event.event.status === "started"));
  assert.ok(events.some((event) => event.type === "trace" && event.event?.tool === "inspect_dataset" && event.event.status === "completed"));
  assert.ok(!JSON.stringify(events).includes("999%"));
  assert.ok(answer.trace?.steps.every((event) => event.status !== "started"));
});

test("普通自然语言查数不加载 Skill，不运行营销发现", async (t) => {
  const fields = [{ label: "成交金额", value: 1200, unit: "人民币" }];
  const source = { id: "mysql:test:0", kind: "database" as const, title: "业务小类：测试货类", provenance: "imported" as const, datasetVersion: "a".repeat(64), capturedAt: "2026-10-13T00:00:00Z", periodLabel: "2025-08-01至2025-08-31", scope: "测试", definition: "探索口径", recordId: "test", rows: [{ label: "测试货类", fields }], statements: [sourceStatement("测试货类", fields)], limitations: [] };
  const database = { inspect: async () => ({ available: true, name: "测试历史", minDate: "2025-08-01", maxDate: "2025-08-31", limitations: [] }), query: async () => [source] };
  const query: AgentQuery = async function* ({ options }) {
    assert.deepEqual(options!.skills, []); assert.deepEqual(options!.tools, []);
    const client = await connect(options);
    try {
      assert.notEqual((await client.callTool({ name: "inspect_dataset", arguments: {} })).isError, true);
      assert.notEqual((await client.callTool({ name: "query_sales_history", arguments: { query: { period: { start: "2025-08-01", end: "2025-08-31" }, by: "category" } } })).isError, true);
      yield result({ insightIds: [], nextDimensions: [], advice: [{ kind: "observation", text: "", evidenceIds: [source.id], metricLabels: ["成交金额"] }] });
    } finally { await client.close(); }
  };
  const config = runtime(t);
  const answer = await createAnalyticsRunner({ ...config, pluginDir: join(config.runtimeDir, "unused-plugin"), database }, { query })({ mode: "database", question: "你好，2025年8月各货类销售额是多少？", history: [] });
  assert.deepEqual(answer.skills, []); assert.deepEqual(answer.tools, ["inspect_dataset", "query_sales_history"]);
  assert.match(answer.advice![0].text, /成交金额为1,200元/);
});

test("有问题的营销条目不导致查询回合失败，也不增加模型调用", async (t) => {
  let calls = 0;
  const query: AgentQuery = async function* ({ options }) {
    calls++; const client = await connect(options);
    try {
      yield* skill(advisor);
      for (const name of ["inspect_dataset", "discover_segments"]) await client.callTool({ name, arguments: {} });
      await client.callTool({ name: "read_analysis_evidence", arguments: { evidenceId: "overall" } });
      yield result({ insightIds: [], nextDimensions: [], advice: [
        { kind: "observation", text: "", evidenceIds: ["report:overall"], metricLabels: ["净销售额"] },
        { kind: "recommendation", text: "先在同店同货类验证", evidenceIds: ["report:overall"] },
        { kind: "hypothesis", text: "销售将提升20%", evidenceIds: ["report:overall"] },
      ] });
    } finally { await client.close(); }
  };
  const answer = await createAnalyticsRunner(runtime(t), { query })(request);
  assert.equal(calls, 1); assert.equal(answer.partial, true);
  assert.equal(answer.trace!.status, "warning"); assert.equal(answer.advice!.length, 2);
  assert.ok(answer.trace!.steps.every((event) => event.status === "completed"));
  assert.equal(answer.advice![1].text, "先在同店同货类验证"); assert.ok(!JSON.stringify(answer).includes("20%"));
  assert.equal(validateAnalyticsResponse(report, answer).partial, true);
});

for (const scenario of ["missing", "failed"] as const) test(`营销顾问 Skill ${scenario} 时拒绝营销回答`, async (t) => {
  const query: AgentQuery = async function* () {
    if (scenario === "failed") yield* skill(advisor, true);
    yield result({ insightIds: [], nextDimensions: [], advice: [] });
  };
  await assert.rejects(createAnalyticsRunner(runtime(t), { query })(request), /Skill|加载顺序/);
});

test("营销 Skill 自包含无编写出处，缺文件时在启动模型前拒绝", (t) => {
  assert.doesNotThrow(() => validateAnalyticsSkills(pluginDir));
  const body = readFileSync(join(pluginDir, "skills/ctf-marketing-advisor/SKILL.md"), "utf8");
  assert.ok(!/^## 出处$/m.test(body)); assert.ok(!/\[S\d+\]/.test(body));
  const empty = mkdtempSync(join(tmpdir(), "ctf-advisor-plugin-")); t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.throws(() => validateAnalyticsSkills(empty));
});

for (const databaseMode of [false, true]) test(`旧版${databaseMode ? "数据库对话" : "导入报告"}使用对应来源协议，完成真实证据引用`, async (t) => {
  const fields = [{ label: "成交金额", value: 1200, unit: "人民币" }];
  const source = { id: "mysql:protocol:0", kind: "database" as const, title: "测试货类", provenance: "sample" as const, datasetVersion: "protocol-fixture", periodLabel: "2025-08-01至2025-08-31", scope: "仅测试数据", definition: "测试成交口径", recordId: "protocol-fixture", rows: [{ label: "测试货类", fields }], statements: [sourceStatement("测试货类", fields)], limitations: [] };
  const database = { inspect: async () => ({ available: true, name: "测试历史", limitations: [] }), query: async () => [source] };
  const insightIds = databaseMode ? [] : report.insights.slice(0, 1).map((insight) => insight.id);
  const nextDimensions = databaseMode ? [] : report.availableDimensions.slice(0, 1);
  if (!databaseMode) assert.ok(insightIds.length + nextDimensions.length > 0);
  const query: AgentQuery = async function* ({ options }) {
    const prompt = options!.systemPrompt!.toString();
    assert.match(prompt, /旧版分析协议/);
    assert.match(prompt, databaseMode ? /模式：数据库对话/ : /模式：导入报告解读/);
    assert.doesNotMatch(prompt, /submit_analysis|fact_ref|trial_parameter_ref/);
    const client = await connect(options);
    try {
      yield* skill(advisor);
      for (const name of ["inspect_dataset", "discover_segments"]) assert.notEqual((await client.callTool({ name, arguments: {} })).isError, true);
      const read = await client.callTool({ name: databaseMode ? "query_sales_history" : "read_analysis_evidence", arguments: databaseMode ? { query: { period: { start: "2025-08-01", end: "2025-08-31" } } } : { evidenceId: "overall" } });
      assert.notEqual(read.isError, true);
      yield result({ insightIds, nextDimensions, advice: [{ kind: "observation", text: "", evidenceIds: [databaseMode ? source.id : "report:overall"] }] });
    } finally { await client.close(); }
  };
  const runner = createAnalyticsRunner({ ...runtime(t), database }, { query });
  const answer = await runner(databaseMode ? { mode: "database", question: request.question, history: [] } : request);
  assert.deepEqual(answer.insightIds, insightIds); assert.deepEqual(answer.nextDimensions, nextDimensions);
  assert.equal(answer.advice![0].evidenceIds[0], databaseMode ? source.id : "report:overall");
});

function historyFixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "ctf-advisor-history-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "evidence"));
  const catalog = { schema: "ctf-observations/v1", source_snapshot: "fixture/v1", metric_status: "探索口径，尚未对数", provenance: "sample", cases: [{ id: "KTEST", title: "示例力度比较", period: ["2025-08-01", "2025-08-07"], population: "仅测试门店", status: "待验证", evidence: ["Q9001"], limits: ["相关性不证明因果"] }] };
  const evidence = { source_snapshot: "fixture/v1", query_id: "Q9001", period: "2025-08-01至2025-08-31数据覆盖", note: "示例测试：订单重构后的克重比较", rows: [{ offer_name: "模拟候选", orders: 6, median_g: 2.5, amount: 1200, unsupported_field: "不适配" }] };
  writeFileSync(join(dir, "observations-202508.json"), JSON.stringify(catalog)); writeFileSync(join(dir, "evidence/Q9001.json"), JSON.stringify(evidence));
  return { dir, catalog, evidence };
}

test("外挂历史来源保留实际窗口、口径和版本，不会冒充本回合数据", (t) => {
  const { dir } = historyFixture(t); assert.equal(inspectHistoricalKnowledge(dir).available, true);
  const tools = createAnalyticsTools(request, dir); const value = tools.read("read_historical_case", { caseId: "KTEST" }) as { sources: Array<{ id: string }> };
  const answer = tools.finish({ insightIds: [], nextDimensions: [], advice: [{ kind: "observation", text: "", evidenceIds: [value.sources[0].id], metricLabels: ["整单一般足金金重中位数"] }] });
  const source = answer.sources![0]; assert.equal(source.provenance, "sample"); assert.equal(source.datasetVersion, "fixture/v1");
  assert.equal(source.periodLabel, "2025-08-01至2025-08-07"); assert.ok(source.limitations.some((l) => l.includes("不是本回合")));
  assert.doesNotThrow(() => validateAnalyticsResponse(report, answer)); assert.equal(source.rows[0].fields.length, 3);
});

test("未启用历史资料仍能读取当前数据；异常历史版本和越界文件不可读取", (t) => {
  assert.equal(inspectHistoricalKnowledge().available, false);
  assert.doesNotThrow(() => createAnalyticsTools(request).read("read_analysis_evidence", { evidenceId: "overall" }));
  assert.throws(() => readHistoricalCase(undefined, "KTEST"), /尚未启用/);
  const { dir, catalog, evidence } = historyFixture(t);
  assert.throws(() => readHistoricalCase(dir, "../other"), /没有这个/);
  writeFileSync(join(dir, "evidence/Q9001.json"), JSON.stringify({ ...evidence, source_snapshot: "wrong/v1" }));
  assert.throws(() => readHistoricalCase(dir, "KTEST"), /版本/);
  const outside = mkdtempSync(join(tmpdir(), "ctf-advisor-outside-")); t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "data.json"), JSON.stringify(evidence)); rmSync(join(dir, "evidence/Q9001.json")); symlinkSync(join(outside, "data.json"), join(dir, "evidence/Q9001.json"));
  assert.throws(() => readHistoricalCase(dir, "KTEST"), /历史知识文件/);
  catalog.cases[0].evidence = ["../../secret"];
  writeFileSync(join(dir, "observations-202508.json"), JSON.stringify(catalog));
  assert.throws(() => readHistoricalCase(dir, "KTEST"), /条目/);
});
