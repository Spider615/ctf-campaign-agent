import assert from "node:assert/strict";
import test from "node:test";
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
import { analysisAnswerText } from "../app/lib/analytics/analysis-v2-format.ts";
import { simulatedDecisionQuality } from "./helpers/analysis-v2-answer.ts";

test("真实 MCP 按已读基线执行情景，图文共同复核并保留条件测算与完整来源", async (t) => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-scenario-runtime-")); t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const dataset = sampleDataset(); const period = { start: dataset.minDate, end: dataset.maxDate };
  const request = { dataset, report: { ...runAnalysis(dataset, { period, filters: {} }), id: "scenario", createdAt: dataset.createdAt }, question: "假设每件追加少量优惠，销量不变和增加时，实收会怎样？" };
  let reviewed = false;
  const query: AgentQuery = async function* ({ options }) {
    const server = options!.mcpServers!.analytics; assert.ok("instance" in server);
    const [transport, service] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "情景运行验收", version: "1" }); await server.instance.connect(service); await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const permission = await options!.canUseTool!(`mcp__analytics__${name}`, args, { signal: new AbortController().signal, toolUseID: name, requestId: name });
      assert.equal(permission?.behavior, "allow", `${name} 未实际授权`);
      const response = await client.callTool({ name, arguments: args }); assert.notEqual(response.isError, true, JSON.stringify({ name, content: response.content })); return JSON.parse((response.content as Array<{ text: string }>)[0].text);
    };
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) {
        const support = await call("read_review_support", { conclusionId: "judgement" });
        assert.ok(support.claims.some((claim: { kind: string }) => claim.kind === "visualization"));
        assert.match(JSON.stringify(support), /成交挪动/);
        const check = { status: "supported", reason: "已核对完整规则、同范围基线、固定结构、净增与收入边界，图表明确情景身份" };
        await call("submit_review", { verdict: "accept", issues: [], decisionQuality: simulatedDecisionQuality, checks: [{ conclusionId: "judgement", scope: check, quantitativeMeaning: check, capability: check, interpretation: check }], claimChecks: support.claims.map((claim: { id: string }) => ({ claimId: claim.id, ...check })) }); reviewed = true;
      } else {
        await call("inspect_dataset"); const planned = await call("plan_analysis", { mode: "analysis", needs: [{ userQuote: request.question, judgement: "判断静态让利与净新增条件" }], assumptions: [] });
        const skill = "analytics:ctf-marketing-advisor";
        yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", id: "skill", input: { skill } }] } } as SDKMessage;
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "skill", content: "已加载" }] } } as SDKMessage;
        const baseline = await call("analyze_history", { needIds: [planned.task.needs[0].id], purpose: "核对当前销售总体", method: "aggregate", scope: { period, population: "sales", filters: {} }, metrics: ["amount"] });
        const simulation = await call("simulate_analysis", { needIds: [planned.task.needs[0].id], purpose: "精确追加优惠情景", baselineFactId: baseline.facts[0].id, adjustment: { kind: "per_item", amount: "0.005" }, netVolumeChanges: ["0", "0.01", "0.03"], reason: "仅为说明持平条件；商品及价格结构固定，净增相对不调整方案并排除成交挪动" });
        const threshold = simulation.facts.find((fact: { metricId: string }) => fact.metricId === "scenario.break_even_pct");
        const chart = await call("present_analysis_chart", { kind: "line", renderer: "native", source: { kind: "scenario", operationId: simulation.operationId, metricId: "scenario.revenue_change" }, selection: { mode: "all" } });
        const accepted = await call("submit_analysis", { draft: { status: "answered", conclusions: [{ id: "judgement", needIds: [planned.task.needs[0].id], level: "hypothesis", judgement: "销量不变时追加让利会减少实收，足够净新增成交才可能覆盖", factIds: [threshold.id], objectIds: [], methodIds: [simulation.methods[0].id], limitations: simulation.limitations }], blocks: [{ kind: "paragraph", conclusionId: "judgement", nodes: [{ kind: "text", text: "会有影响：销量不变时实收下降。商品与价格结构固定时，收入持平所需净成交量增幅为" }, { kind: "fact_ref", factId: threshold.id }, { kind: "text", text: "；条件曲线不代表需求预测。" }] }], questions: [], userConditions: [], trialParameters: [], visualizations: { schema: "analysis-visualization/v1", items: [{ id: chart.visualizationId, afterBlockIndex: 0, conclusionId: "judgement" }] } } });
        assert.equal(accepted.accepted, true, JSON.stringify(accepted));
      }
      yield { type: "result", subtype: "success", is_error: false, result: "" } as SDKMessage;
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner({ model: "test", apiKey: "test", modelBaseUrl: "https://example.invalid", runtimeDir, auditDirectory: join(runtimeDir, "audit"), pluginDir: join(process.cwd(), "agent/analytics-plugin") }, { query })(request, undefined, undefined, "analysis-visualization/v1");
  assert.ok("schema" in answer); assert.ok(reviewed); assert.equal(answer.visualizations?.items[0].source.kind, "scenario"); assert.match(analysisAnswerText(answer), /情景测算/);
});
