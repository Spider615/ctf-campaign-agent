import assert from "node:assert/strict";
import test from "node:test";
import { simulatedAnswer, simulatedDecisionQuality } from "./helpers/analysis-v2-answer.ts";
import { selectAnalysisEvidence, validateAnalysisAnswer } from "../app/lib/analytics/analysis-v2-evidence.ts";
import { analysisAnswerText } from "../app/lib/analytics/analysis-v2-format.ts";
import { analysisReviewClaims } from "../agent/analytics-review-support.ts";
import { createAnalysisReviewCache } from "../agent/analytics-review-cache.ts";
import type { Visualizations } from "../app/lib/analytics/visualization-types.ts";
import { createVisualizationRegistry } from "../agent/visualization-runtime.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import type { AgentQuery } from "../agent/run-turn.ts";
import type { SDKMessage } from "../agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts";
import { createGeneralAnalyticsRunner } from "../agent/general-analytics-run-turn.ts";
import { sampleDataset } from "../app/lib/analytics/sample.ts";
import { runAnalysis } from "../app/lib/analytics/engine.ts";

function example() {
  const answer = simulatedAnswer() as ReturnType<typeof simulatedAnswer> & { visualizations?: Visualizations };
  answer.evidence.objects.push({ ...answer.evidence.objects[0], id: "another-store", value: "another", label: "模拟乙店" });
  answer.evidence.facts.push({ ...answer.evidence.facts[0], id: "another-amount", objectIds: ["another-store"], value: 700 });
  answer.evidence.methods[0].groupCount = 2;
  answer.visualizations = { schema: "analysis-visualization/v1", items: [{ id: "plot", revision: 1, kind: "bar", renderer: "html", afterBlockIndex: 1, conclusionId: "conclusion", source: { kind: "analysis", operationId: "operation", metricId: "amount", dimension: "store" }, selection: { mode: "all" } }] };
  return answer;
}

test("最终答案保留真实图表，证据投影包含绘图完整分组及父链", () => {
  const answer = example();
  const parsed = validateAnalysisAnswer(answer) as typeof answer;
  assert.deepEqual(parsed.visualizations, answer.visualizations);
  const selected = selectAnalysisEvidence(answer, answer.evidence);
  assert.ok(selected.facts.some((fact) => fact.id === "another-amount"));
  assert.match(analysisAnswerText(parsed), /模拟乙店/);
  assert.match(analysisAnswerText(parsed), /700/);
});

test("图表来源、位置与结论引用均在最终结果重新核验", () => {
  for (const mutate of [
    (answer: ReturnType<typeof example>) => { answer.visualizations!.items[0].afterBlockIndex = 40; },
    (answer: ReturnType<typeof example>) => { answer.visualizations!.items[0].conclusionId = "unknown"; },
    (answer: ReturnType<typeof example>) => { answer.visualizations!.items[0].source = { kind: "analysis", operationId: "invented", metricId: "amount", dimension: "store" }; },
  ]) { const answer = example(); mutate(answer); assert.throws(() => validateAnalysisAnswer(answer), /图表|引用|位置/); }
});

test("独立复核必须实际读取图表；改图后不能复用旧复核", () => {
  const answer = example(); const claims = analysisReviewClaims(answer, answer.evidence);
  const chart = claims.find((claim) => claim.source === "visualization:plot");
  assert.ok(chart); assert.ok(chart.factIds.includes("another-amount")); assert.match(chart.context, /700/);
  const cache = createAnalysisReviewCache(); const meaning = { status: "supported" as const, reason: "已读" };
  const input = { draft: answer, evidence: answer.evidence, context: {}, claims };
  cache.remember(input, { verdict: "accept", issues: [], checks: [{ conclusionId: "conclusion", scope: meaning, quantitativeMeaning: meaning, capability: meaning, interpretation: meaning }], claimChecks: claims.map((claim) => ({ claimId: claim.id, status: "supported", reason: "实际核对" })) });
  assert.equal(cache.reuse(input).conclusionIds.length, 1);
  answer.visualizations!.items[0].selection = { mode: "top", limit: 1 };
  assert.equal(cache.reuse({ ...input, claims: analysisReviewClaims(answer, answer.evidence) }).conclusionIds.length, 0);
});

test("运行时图表工具分配身份并发布可验证预览，模型只提交位置，范围重开撤回", () => {
  const answer = example(); const events: unknown[] = [];
  const registry = createVisualizationRegistry({ runId: "run", enabled: true, emit: (event) => events.push(event), analysisEvidence: () => answer.evidence });
  const input = { kind: "bar" as const, renderer: "native" as const, source: answer.visualizations!.items[0].source, selection: { mode: "all" as const } };
  const created = registry.present(input);
  assert.equal(events.length, 1); assert.equal(created.chart.series[0].values[1].value, 700);
  const repeated = registry.present(input); assert.equal(repeated.visualizationId, created.visualizationId); assert.equal(events.length, 1);
  assert.equal(registry.place([{ id: created.visualizationId, afterBlockIndex: 1 }])!.items[0].source.kind, "analysis");
  assert.throws(() => registry.place([{ id: "invented", afterBlockIndex: 0 }]), /引用|不存在/);
  registry.reset("scope_changed"); assert.equal(events.length, 2);
  assert.throws(() => registry.place([{ id: created.visualizationId, afterBlockIndex: 1 }]), /引用|不存在/);
});

test("修订图表后旧签名不会把新图悄悄改回去", () => {
  const answer = example(); const registry = createVisualizationRegistry({ runId: "run", enabled: true, analysisEvidence: () => answer.evidence });
  const request = { kind: "bar" as const, renderer: "native" as const, source: answer.visualizations!.items[0].source, selection: { mode: "all" as const } };
  const original = registry.present(request);
  const changed = registry.present({ ...request, id: original.visualizationId, selection: { mode: "top", limit: 1 } });
  assert.equal(changed.visualizationId, original.visualizationId);
  assert.notEqual(registry.present(request).visualizationId, changed.visualizationId);
});

test("真实分析 MCP 回合生成预览，图表与正文一起被独立复核后交付", async (t) => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-chart-runtime-")); t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const dataset = sampleDataset(); const dates = dataset.rows.map((row) => row.date).sort();
  const period = { start: dates[0], end: dates.at(-1)! };
  const request = { dataset, report: { ...runAnalysis(dataset, { period, filters: {} }), id: "chart-report", createdAt: "2026-10-16" }, question: "比较门店销售金额，用图表回答" };
  const events: unknown[] = []; let chartReviewed = false;
  const query: AgentQuery = async function* ({ options }) {
    const server = options!.mcpServers!.analytics; assert.ok("instance" in server);
    const [transport, service] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "图表验收", version: "1" });
    await server.instance.connect(service); await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const permission = await options!.canUseTool!(`mcp__analytics__${name}`, args, { signal: new AbortController().signal, toolUseID: `permission-${name}`, requestId: `permission-${name}` });
      assert.equal(permission?.behavior, "allow", `${name} 已注册却未被 SDK 授权`);
      const result = await client.callTool({ name, arguments: args }); const value = JSON.parse((result.content as Array<{ text: string }>)[0].text); assert.notEqual(result.isError, true, JSON.stringify({ name, value })); return value;
    };
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) {
        const support = await call("read_review_support", { conclusionId: "judgement" });
        chartReviewed = support.claims.some((claim: { source: string }) => claim.source.startsWith("visualization:"));
        const check = { status: "supported", reason: "已检查真实图文、完整分组与范围" };
        await call("submit_review", { verdict: "accept", issues: [], decisionQuality: simulatedDecisionQuality, checks: [{ conclusionId: "judgement", scope: check, quantitativeMeaning: check, capability: check, interpretation: check }], claimChecks: support.claims.map((claim: { id: string }) => ({ claimId: claim.id, ...check })) });
      } else {
        await call("inspect_dataset"); const planned = await call("plan_analysis", { mode: "analysis", needs: [{ userQuote: request.question, judgement: "比较门店销售" }], assumptions: [] });
        const skill = "analytics:ctf-marketing-advisor";
        yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", id: "skill", input: { skill } }] } } as SDKMessage;
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "skill", content: "已加载" }] } } as SDKMessage;
        const data = await call("analyze_history", { needIds: [planned.task.needs[0].id], purpose: "核对各门店金额", method: "aggregate", scope: { period, filters: {}, population: "net" }, metrics: ["amount"], by: ["store"] });
        const chart = await call("present_analysis_chart", { kind: "bar", renderer: "html", source: { kind: "analysis", operationId: data.methods[0].operationId, metricId: "amount", dimension: "store" }, selection: { mode: "all" } });
        const accepted = await call("submit_analysis", { draft: { status: "answered", conclusions: [{ id: "judgement", needIds: [planned.task.needs[0].id], level: "observed", judgement: "各店金额已按同口径核对", factIds: [data.facts[0].id], objectIds: [], methodIds: [data.methods[0].id], limitations: [] }], blocks: [{ kind: "paragraph", conclusionId: "judgement", nodes: [{ kind: "text", text: "各店金额见图，金额差异不代表活动因果。" }] }], questions: [], userConditions: [], trialParameters: [], visualizations: { schema: "analysis-visualization/v1", items: [{ id: chart.visualizationId, afterBlockIndex: 0, conclusionId: "judgement" }] } } });
        assert.equal(accepted.accepted, true, JSON.stringify(accepted));
      }
      yield { type: "result", subtype: "success", is_error: false, result: "" } as SDKMessage;
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner({ model: "test", apiKey: "test", modelBaseUrl: "https://example.invalid", runtimeDir, auditDirectory: join(runtimeDir, "audit"), pluginDir: join(process.cwd(), "agent/analytics-plugin") }, { query })(request, undefined, (event) => events.push(event), "analysis-visualization/v1");
  assert.ok("schema" in answer); assert.equal(answer.visualizations?.items.length, 1); assert.ok(chartReviewed);
  assert.ok(events.some((event) => (event as { type: string }).type === "visualization"));
});
