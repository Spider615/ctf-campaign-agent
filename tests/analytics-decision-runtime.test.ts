import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import type { AgentQuery } from "../agent/run-turn.ts";
import type { SDKMessage } from "../agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts";
import type { AnalyticsDataset } from "../app/lib/analytics/types.ts";
import { runAnalysis } from "../app/lib/analytics/engine.ts";
import { createGeneralAnalyticsRunner } from "../agent/general-analytics-run-turn.ts";
import { analysisAnswerText } from "../app/lib/analytics/analysis-v2-format.ts";

test("真实 MCP 回合按已读依据计算新方案，缺少决策质量审查不得交付", async (t) => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-decision-runtime-")); t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const dataset: AnalyticsDataset = { schema: "analytics-dataset/v1", id: "decision-fixture", version: "decision-v1", name: "合成经营数据", provenance: "sample", currency: "CNY", createdAt: "2026-04-01", minDate: "2026-04-01", maxDate: "2026-04-01", rules: [], sourceFiles: [], mappings: { sales: {}, campaigns: {} }, warnings: [], rows: [{ lineId: "row", date: "2026-04-01", store: "模拟门店", category: "模拟货类", netSales: 1000, quantity: 100, orderId: "order", region: null, city: null, sku: null, memberId: null, memberSegment: null, campaignId: null, cost: 600, weightGrams: null }] };
  const period = { start: "2026-04-01", end: "2026-04-01" };
  const request = { dataset, report: { ...runAnalysis(dataset, { period, filters: {} }), id: "decision-report", createdAt: "2026-04-01" }, question: "如果销售不变而增加五十元准备成本，现有源毛利扣除这项成本后会怎样变化？" };
  let decisionReviewed = false;
  const query: AgentQuery = async function* ({ options }) {
    const server = options!.mcpServers!.analytics; assert.ok("instance" in server);
    const [transport, service] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "决策能力验收", version: "1" });
    await server.instance.connect(service); await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const permission = await options!.canUseTool!(`mcp__analytics__${name}`, args, { signal: new AbortController().signal, toolUseID: `permission-${name}`, requestId: `permission-${name}` });
      assert.equal(permission?.behavior, "allow", `${name} 未获得真实 SDK 授权`);
      const response = await client.callTool({ name, arguments: args });
      return { response, value: JSON.parse((response.content as Array<{ text: string }>)[0].text) };
    };
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) {
        const { value: support } = await call("read_review_support", { conclusionId: "judgement" });
        const check = { status: "supported" as const, reason: "已核对原问题、真实基线和额外成本假设；结果是条件测算" };
        const review = { verdict: "accept", issues: [], checks: [{ conclusionId: "judgement", scope: check, quantitativeMeaning: check, capability: check, interpretation: check }], claimChecks: support.claims.map((claim: { id: string }) => ({ claimId: claim.id, ...check })) };
        const missing = await call("submit_review", review);
        assert.equal(missing.response.isError, true, "缺少直接回答与决策价值审查，仍被接受");
        assert.match(missing.value.error, /decisionQuality|决策/);
        const decisionQuality = { directAnswer: check, evidenceFit: check, actionValue: { status: "not_applicable" as const, reason: "只问给定成本情景，无试点或行动建议" } };
        const contradicted = await call("submit_review", { ...review, decisionQuality: { ...decisionQuality, evidenceFit: { status: "revise", reason: "依据尚需补齐" } } });
        assert.equal(contradicted.response.isError, true);
        assert.notEqual((await call("submit_review", { ...review, decisionQuality })).response.isError, true);
        decisionReviewed = true;
      } else {
        await call("inspect_dataset"); const { value: planned } = await call("plan_analysis", { mode: "analysis", needs: [{ userQuote: request.question, judgement: "按给定成本情景回答变化方向与金额" }], assumptions: [] });
        const skill = "analytics:ctf-marketing-advisor";
        yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", id: "skill", input: { skill } }] } } as SDKMessage;
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "skill", content: "已加载" }] } } as SDKMessage;
        const { value: baseline } = await call("analyze_history", { needIds: [planned.task.needs[0].id], purpose: "读取既有源毛利", method: "aggregate", scope: { period, filters: {}, population: "sales" }, metrics: ["profit"] });
        const { response, value: calculated } = await call("calculate_analysis", { needIds: [planned.task.needs[0].id], purpose: "测算额外成本后的源毛利余额", frameId: baseline.frames[0].id, assumptions: [{ key: "extra_cost", label: "拟议准备成本", value: 50, unit: "CNY", reason: "按用户给定的未来成本情景，尚非已发生支出" }], calculations: [{ key: "balance", label: "源毛利扣除拟议成本后的测算余额", unit: "CNY", op: "subtract", args: [{ kind: "fact", id: baseline.facts[0].id }, { kind: "assumption", key: "extra_cost" }] }] });
        assert.notEqual(response.isError, true, JSON.stringify(calculated));
        const value = calculated.facts.find((fact: { metricId: string }) => fact.metricId === "calculation.balance"); assert.equal(value.value, 350);
        const accepted = await call("submit_analysis", { draft: { status: "answered", conclusions: [{ id: "judgement", needIds: [planned.task.needs[0].id], level: "hypothesis", judgement: "销售与其他成本不变时，新增准备成本会减少可留下的余额", factIds: [value.id], objectIds: [], methodIds: [calculated.methods[0].id], limitations: calculated.limitations }], blocks: [{ kind: "paragraph", conclusionId: "judgement", nodes: [{ kind: "text", text: "会减少。按给定成本情景，现有源毛利扣除这项成本后为" }, { kind: "fact_ref", factId: value.id }, { kind: "text", text: "；这是条件测算，不代表最终净利润。" }] }], questions: [], userConditions: [], trialParameters: [] } });
        assert.equal(accepted.value.accepted, true, JSON.stringify(accepted.value));
      }
      yield { type: "result", subtype: "success", is_error: false, result: "" } as SDKMessage;
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner({ model: "test", apiKey: "test", modelBaseUrl: "https://example.invalid", runtimeDir, auditDirectory: join(runtimeDir, "audit"), pluginDir: join(process.cwd(), "agent/analytics-plugin") }, { query })(request);
  assert.ok("schema" in answer); assert.ok(decisionReviewed); assert.match(analysisAnswerText(answer), /350/);
  assert.ok(answer.evidence.facts.some((fact) => fact.assumption));
});
