import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import type { AgentQuery } from "../agent/run-turn.ts";
import type { SDKMessage } from "../agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts";
import { createPlanAnalyticsRunner } from "../agent/analysis-plan-run-turn.ts";
import type { NodeResult } from "../app/lib/analytics/plan/execute.ts";
import { validatePlanAnswer } from "../app/lib/analytics/plan/answer.ts";
import { sampleDataset } from "../app/lib/analytics/sample.ts";
import { runAnalysis } from "../app/lib/analytics/engine.ts";
import { createSnapshotAnalysisProvider } from "../app/lib/analytics/analysis-v2-snapshot.ts";
import { capabilityBrief } from "../app/lib/analytics/plan/prompt.ts";
import { buildPlanSystemPrompt } from "../agent/analytics-system-prompt.ts";
import { semanticDimensionCatalog, ANALYSIS_DIMENSIONS } from "../app/lib/analytics/semantic/model.ts";
import type { AnalysisDataProvider, PlanAnswer } from "../app/lib/analytics/analysis-v2-types.ts";

const dataset = sampleDataset();
const period = { start: dataset.minDate, end: dataset.maxDate };
const request = { dataset, report: { ...runAnalysis(dataset, { period, filters: {} }), id: "plan", createdAt: dataset.createdAt }, question: "今年八月实收比去年八月怎么样？" };
const scope = (start: string, end: string) => ({ period: { start, end }, population: "sales", filters: {} });
const m1 = { id: "m1", op: "measure", scope: scope("2026-08-01", "2026-08-31"), metrics: ["amount"] };
const c1 = { id: "c1", op: "contrast", target: scope("2026-08-01", "2026-08-31"), reference: scope("2025-08-01", "2025-08-31"), metrics: ["amount", "quantity"] };
const claims = {
  headline: { node: "c1", metric: "amount", assert: "up", text: "今年八月实收比去年同期高 {delta}" },
  claims: [{ node: "c1", metric: "quantity", assert: "flat", text: "件数基本持平，变化 {change}" }],
  actions: [], cannotConclude: [], questions: [],
};

type Call = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Script = Partial<Record<"submit_plan" | "submit_plan_review" | "submit_followup" | "submit_claims" | "submit_wording_review", (call: Call, round: number) => Promise<void>>>;
// 假模型：按本步开放的提交工具判断步骤，经真实 InMemory MCP 调用工具。
function scripted(script: Script) {
  const steps: string[] = []; const rounds = new Map<string, number>();
  const query: AgentQuery = async function* ({ options }) {
    const server = options!.mcpServers!.analytics; assert.ok("instance" in server);
    const [transport, service] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "计划运行验收", version: "1" });
    await server.instance.connect(service); await client.connect(transport);
    const call: Call = async (name, args) => {
      const permission = await options!.canUseTool!(`mcp__analytics__${name}`, args, { signal: new AbortController().signal, toolUseID: name, requestId: name });
      assert.equal(permission?.behavior, "allow", `${name} 未授权`);
      const response = await client.callTool({ name, arguments: args });
      return JSON.parse((response.content as Array<{ text: string }>)[0].text);
    };
    try {
      const tools = (await client.listTools()).tools.map((item) => item.name);
      assert.equal(tools.length, 1, "每一步只开放一个提交工具");
      const denied = await options!.canUseTool!("mcp__analytics__other", {}, { signal: new AbortController().signal, toolUseID: "x", requestId: "x" });
      assert.equal(denied?.behavior, "deny");
      const name = tools[0] as keyof Script; steps.push(name);
      const round = (rounds.get(name) ?? 0) + 1; rounds.set(name, round);
      const defaults: Required<Script> = {
        submit_plan: async (c) => { await c("submit_plan", { plan: { question: request.question, nodes: [m1, c1] } }); },
        submit_plan_review: async (c) => { await c("submit_plan_review", { verdict: "ok", issues: [] }); },
        submit_followup: async (c) => { await c("submit_followup", { nodes: [] }); },
        submit_claims: async (c) => { await c("submit_claims", claims); },
        submit_wording_review: async (c) => { await c("submit_wording_review", { edits: [], notes: [] }); },
      };
      await (script[name] ?? defaults[name])(call, round);
      yield { type: "result", subtype: "success", is_error: false, result: "" } as SDKMessage;
    } finally { await client.close(); }
  };
  return { query, steps };
}

function setup(t: { after: (fn: () => void) => void }) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-plan-runtime-")); t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return { model: "test", apiKey: "secret-key", modelBaseUrl: "https://example.invalid", runtimeDir, auditDirectory: join(runtimeDir, "audit"), pluginDir: join(process.cwd(), "agent/analytics-plugin") };
}
const run = (config: ReturnType<typeof setup>, query: AgentQuery, provider: AnalysisDataProvider = createSnapshotAnalysisProvider(dataset), signal?: AbortSignal) =>
  createPlanAnalyticsRunner(config, { query, provider })(request, signal) as Promise<PlanAnswer>;
const money = (value: number) => new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

test("正常路径：五次调用，主结论数字与证据一致，审计按步骤记录", async (t) => {
  const config = setup(t); const { query, steps } = scripted({}); const phases: string[] = []; const traced: string[] = [];
  const answer = await createPlanAnalyticsRunner(config, { query, provider: createSnapshotAnalysisProvider(dataset) })(request, undefined, (event) => {
    if (event.type === "phase") phases.push(event.phase); if (event.type === "trace" && event.event.status !== "started") traced.push(event.event.tool);
  }) as PlanAnswer;
  assert.deepEqual(steps, ["submit_plan", "submit_plan_review", "submit_followup", "submit_claims", "submit_wording_review"]);
  assert.equal(answer.status, "answered");
  const fact = answer.evidence.facts.find((item) => item.id === answer.headline!.factIds[0])!;
  assert.equal(fact.metricId, "amount.delta");
  assert.ok(answer.headline!.text.includes(money(fact.value!)), answer.headline!.text);
  assert.equal(answer.claims.length, 1);
  assert.deepEqual(phases, ["analyzing", "writing"]);
  assert.equal(traced.filter((name) => name === "run_plan_node").length, 2);
  assert.ok(answer.trace && answer.trace.steps.length >= 7);
  const [file] = readdirSync(config.auditDirectory);
  const kinds = readFileSync(join(config.auditDirectory, file), "utf8").trim().split("\n").map((line) => JSON.parse(line).kind);
  assert.deepEqual(kinds, ["question", "plan", "plan_review", "execution", "followup", "claims", "wording_review", "final"]);
  assert.doesNotMatch(readFileSync(join(config.auditDirectory, file), "utf8"), /secret-key/);
});

test("计划第一次有错：同一调用内修正，调用数仍为五，没有丢弃节点", async (t) => {
  const config = setup(t); let first: Record<string, unknown> | undefined;
  const { query, steps } = scripted({ submit_plan: async (call) => {
    first = await call("submit_plan", { plan: { question: request.question, nodes: [m1, { ...c1, metrics: ["不存在的指标"] }] } });
    const second = await call("submit_plan", { plan: { question: request.question, nodes: [m1, c1] } });
    assert.equal(second.accepted, true);
  } });
  const answer = await run(config, query);
  assert.equal(first?.accepted, false); assert.ok((first?.issues as string[]).some((item) => item.includes("不存在的指标")));
  assert.equal(steps.length, 5);
  assert.equal(answer.status, "answered");
  assert.ok(!answer.plan.some((row) => row.status === "dropped"));
});

test("计划复核要求修改：计划步骤调用两次，总调用数为六", async (t) => {
  const config = setup(t); const prompts: string[] = [];
  const base = scripted({
    submit_plan_review: async (call) => { await call("submit_plan_review", { verdict: "revise", issues: ["需要补充件数对比"] }); },
    submit_plan: async (call, round) => { await call("submit_plan", { plan: { question: request.question, nodes: round === 1 ? [m1] : [m1, c1] } }); },
  });
  const query: AgentQuery = (params) => { prompts.push(String(params.prompt)); return base.query(params); };
  const answer = await run(config, query);
  assert.deepEqual(base.steps, ["submit_plan", "submit_plan_review", "submit_plan", "submit_followup", "submit_claims", "submit_wording_review"]);
  assert.match(prompts[2], /需要补充件数对比/);
  // 第二次计划能看到上一版计划；计划复核附带能力目录
  assert.match(prompts[2], /上一版计划/); assert.match(prompts[2], /"id":"m1"/);
  assert.match(prompts[1], /能力目录/);
  assert.equal(answer.status, "answered");
});

test("修订轮的计划有错时同一调用内可再改一次，总调用数仍为六", async (t) => {
  const config = setup(t); let revisedFirst: Record<string, unknown> | undefined;
  const base = scripted({
    submit_plan_review: async (call) => { await call("submit_plan_review", { verdict: "revise", issues: ["需要补充件数对比"] }); },
    submit_plan: async (call, round) => {
      if (round === 1) { await call("submit_plan", { plan: { question: request.question, nodes: [m1] } }); return; }
      revisedFirst = await call("submit_plan", { plan: { question: request.question, nodes: [m1, { ...c1, target: { ...c1.target, period: { start: "2099-01-01", end: "2099-01-02" } } }] } });
      await call("submit_plan", { plan: { question: request.question, nodes: [m1, c1] } });
    },
  });
  const answer = await run(config, base.query);
  assert.equal(revisedFirst?.accepted, false);
  assert.equal(base.steps.length, 6);
  assert.ok(!answer.plan.some((row) => row.status === "dropped"));
});

test("补充计划：首次有问题退回清单；再次提交时引用不存在节点的被丢弃，其余补充节点执行", async (t) => {
  const config = setup(t); let first: Record<string, unknown> | undefined; let result: Record<string, unknown> | undefined;
  const nodes = [{ id: "s1", op: "scan", of: "c1", dimensions: ["region"] }, { id: "x1", op: "decompose", of: "nope" }];
  const { query } = scripted({ submit_followup: async (call) => {
    first = await call("submit_followup", { nodes });
    result = await call("submit_followup", { nodes });
  } });
  const answer = await run(config, query);
  assert.equal(first?.accepted, false);
  assert.ok((first?.issues as string[]).some((issue) => issue.startsWith("x1")));
  assert.deepEqual(result?.nodes, ["s1"]);
  assert.equal(answer.plan.find((row) => row.id === "s1")?.status, "completed");
  assert.equal(answer.plan.find((row) => row.id === "x1")?.status, "dropped");
  assert.equal(answer.status, "partial");
});

test("补充计划沿用已执行节点：不重复执行首轮的对比", async (t) => {
  const baseline = await run(setup(t), scripted({}).query);
  const { query } = scripted({ submit_followup: async (call) => { await call("submit_followup", { nodes: [{ id: "s1", op: "scan", of: "c1", dimensions: ["region"] }] }); } });
  const answer = await run(setup(t), query);
  assert.equal(answer.plan.find((row) => row.id === "s1")?.status, "completed");
  // 答案证据只含被引用部分；补充扫描不应再跑一次 c1 的对比（执行层的完整验证见 analysis-plan-execute 测试）。
  assert.ok(answer.evidence.methods.filter((method) => method.method === "compare").length <= baseline.evidence.methods.filter((method) => method.method === "compare").length);
});

test("提交被接受后再次提交被忽略，不改变结果", async (t) => {
  const config = setup(t); let again: Record<string, unknown> | undefined;
  const { query } = scripted({ submit_plan: async (call) => {
    await call("submit_plan", { plan: { question: request.question, nodes: [m1, c1] } });
    again = await call("submit_plan", { plan: { question: request.question, nodes: [m1] } });
  } });
  const answer = await run(config, query);
  assert.deepEqual(again, { accepted: true, note: "本步骤已完成" });
  assert.ok(answer.plan.some((row) => row.id === "c1"));
  assert.equal(answer.status, "answered");
});

for (const [label, edit] of [["删除", { index: 0, action: "drop" }], ["改写成带数字", { index: 0, action: "rewrite", text: "实收高了 3 成" }]] as const) {
  test(`措辞复核${label}主结论：首条结论顶上，占位不出现`, async (t) => {
    const config = setup(t);
    const { query } = scripted({ submit_wording_review: async (call) => { await call("submit_wording_review", { edits: [edit], notes: [] }); } });
    const answer = await run(config, query);
    assert.ok(answer.headline);
    assert.equal(answer.claims.length, 0);
    assert.match(answer.headline!.text, /件数/);
    assert.equal(answer.status, "partial");
    const text = JSON.stringify(answer);
    assert.doesNotMatch(text, /__dropped__|已删除/);
    assert.ok(!answer.cannotConclude.some((item) => /已删除|__dropped__/.test(item)));
  });
}

test("措辞复核改写成带数字的文本：该结论被删除，答案为部分回答", async (t) => {
  const config = setup(t);
  const { query } = scripted({ submit_wording_review: async (call) => { await call("submit_wording_review", { edits: [{ index: 1, action: "rewrite", text: "件数变化了 5 件" }], notes: ["措辞已核对"] }); } });
  const answer = await run(config, query);
  assert.equal(answer.status, "partial");
  assert.equal(answer.claims.length, 0);
  assert.ok(answer.headline);
  assert.deepEqual(answer.review.notes, ["措辞已核对"]);
});

test("执行阶段取消：抛出取消错误并关闭会话", async (t) => {
  const config = setup(t); const controller = new AbortController(); let closed = false;
  const inner = createSnapshotAnalysisProvider(dataset);
  const provider: AnalysisDataProvider = { open: async (signal) => {
    const session = await inner.open(signal);
    return { ...session, capabilities: session.capabilities, aggregate: async (query, s) => { controller.abort(); return session.aggregate(query, s); }, close: async () => { closed = true; await session.close(); } };
  } };
  const { query, steps } = scripted({});
  await assert.rejects(run(config, query, provider, controller.signal), (error: Error) => error.name === "AbortError");
  assert.ok(closed);
  assert.deepEqual(steps, ["submit_plan", "submit_plan_review"]);
});

test("能力摘要：完整语义目录压缩在六千字以内", () => {
  const brief = capabilityBrief({ mode: "database", name: "测试", coverage: { start: "2025-01-01", end: "2025-12-31" }, currency: "CNY", provenance: "imported", dimensions: [...ANALYSIS_DIMENSIONS], dimensionCatalog: semanticDimensionCatalog(ANALYSIS_DIMENSIONS) as never, metrics: [], methods: [], limitations: [] });
  assert.ok(brief.length < 6000, String(brief.length));
  assert.match(brief, /district\|分区\|districts\|region\|是/);
});

test("计划回合系统提示词不含旧工具，长度在六千字以内", () => {
  const prompt = buildPlanSystemPrompt("2026-10-18");
  for (const name of ["submit_analysis", "fact_ref", "read_analysis_evidence", "calculate_analysis", "simulate_analysis", "analyze_history", "present_analysis_chart", "plan_analysis", "inspect_dataset", "period_ref", "Skill"]) assert.ok(!prompt.includes(name), name);
  assert.ok(prompt.length < 6000, String(prompt.length));
  assert.match(prompt, /小福/);
});

test("结论全部没绑上时用已算出的对比给兜底主结论，答案不为空，并带关键数据表", async (t) => {
  const config = setup(t);
  const { query } = scripted({ submit_claims: async (call) => { await call("submit_claims", { headline: { node: "c1", metric: "amount", assert: "up", text: "高了 999 元" }, claims: [], actions: [], cannotConclude: [], questions: [] }); } });
  const answer = await run(config, query);
  assert.notEqual(answer.status, "unavailable");
  assert.ok(answer.headline && answer.headline.factIds.length > 0, "应有兜底主结论");
  const facts = new Set(answer.evidence.facts.map((fact) => fact.id));
  assert.ok(answer.headline!.factIds.every((id) => facts.has(id)));
  assert.ok(answer.figures && answer.figures.rows.length > 0 && answer.figures.referenceLabel, "对比节点应生成关键数据表");
});

test("结论首次有条目被丢弃时退回原因，同一次调用内改好后采用第二份", async (t) => {
  const config = setup(t); let first: Record<string, unknown> | undefined;
  const good = { headline: { node: "c1", metric: "amount", assert: "up", text: "实收高 {delta}" }, claims: [], actions: [], cannotConclude: [], questions: [] };
  const { query, steps } = scripted({ submit_claims: async (call) => {
    first = await call("submit_claims", { ...good, headline: { ...good.headline, text: "实收高了 999 元" } });
    await call("submit_claims", good);
  } });
  const answer = await run(config, query);
  assert.equal(first?.accepted, false);
  assert.match(JSON.stringify(first?.rejected), /占位符/);
  assert.match(answer.headline!.text, /^实收高 \+/);
  assert.equal(steps.filter((step) => step === "submit_claims").length, 1, "退回重交不增加模型调用");
});

test("执行结果摘要：每个分组节点都有名额，样本不足的分组不列出", async () => {
  const { executionSummary } = await import("../agent/analysis-plan-run-turn.ts");
  const f = (id: string, value: number, unit = "%") => ({ id, frameId: "f", metricId: "amount", label: id, value, unit, definition: "", objectIds: [], operationId: "op", limitations: [] });
  const period = { start: "2025-08-01", end: "2025-08-31" }; const s = { period, population: "sales" as const, filters: {} };
  const facts = [...Array.from({ length: 12 }, (_, i) => f(`a${i}`, 50 - i)), f("b0", 1), f("b1", 99)];
  const results = new Map<string, NodeResult>([
    ["s1", { node: { id: "s1", op: "scan", of: "c1" }, status: "completed", operationIds: [], rows: Array.from({ length: 12 }, (_, i) => ({ key: { region: `R${i}` }, metric: "amount", factId: `a${i}`, role: "deviation" as const, sampleRows: 500 })) }],
    ["s2", { node: { id: "s2", op: "scan", of: "c1" }, status: "completed", operationIds: [], rows: [{ key: { category: "大样本" }, metric: "amount", factId: "b0", role: "deviation", sampleRows: 900 }, { key: { category: "小样本" }, metric: "amount", factId: "b1", role: "deviation", sampleRows: 20 }] }],
    ["c1", { node: { id: "c1", op: "contrast", target: s, reference: s, metrics: ["amount"] }, status: "completed", operationIds: [], rows: [] }],
  ]);
  const session = await createSnapshotAnalysisProvider(dataset).open();
  const text = executionSummary({ results, evidence: { frames: [], objects: [], methods: [], facts } }, session.capabilities);
  await session.close();
  assert.match(text, /"node":"s2","select":\{"category":"大样本"\}/);
  assert.doesNotMatch(text, /小样本"\}/);
  assert.match(text, /s1 另有 4 个偏离较小的分组/);
  assert.match(text, /s2 另有 1 个样本不足 200 行的分组/);
  assert.match(text, /^# s1：扫描 c1/m);
});

test("答案证据只保留被引用事实及其推导来源，且仍能通过证据校验", async (t) => {
  const config = setup(t);
  const { query } = scripted({ submit_followup: async (call) => { await call("submit_followup", { nodes: [{ id: "s1", op: "scan", of: "c1", dimensions: ["region"] }] }); } });
  const answer = await run(config, query);
  const cited = new Set([...(answer.headline?.factIds ?? []), ...answer.claims.flatMap((claim) => claim.factIds), ...(answer.figures?.rows ?? []).flatMap((row) => row.factIds), ...(answer.chart?.factIds ?? [])]);
  const ids = new Set(answer.evidence.facts.map((fact) => fact.id));
  for (const id of cited) assert.ok(ids.has(id), `引用的事实 ${id} 应保留`);
  const { analysisFactParents } = await import("../app/lib/analytics/analysis-v2-fact-links.ts");
  const reachable = new Set<string>(); const stack = [...cited];
  while (stack.length) { const id = stack.pop()!; if (reachable.has(id)) continue; reachable.add(id); const fact = answer.evidence.facts.find((item) => item.id === id); if (fact) stack.push(...analysisFactParents(fact)); }
  assert.equal(ids.size, reachable.size, "不保留未被引用的事实");
  assert.doesNotThrow(() => validatePlanAnswer(JSON.parse(JSON.stringify(answer))));
});

test("结论首次被退回后模型没有再交时，采用首次提交里通过的条目", async (t) => {
  const config = setup(t);
  const { query } = scripted({ submit_claims: async (call) => {
    await call("submit_claims", { headline: { node: "c1", metric: "amount", assert: "up", text: "实收高 {delta}" }, claims: [{ node: "c1", metric: "quantity", assert: "flat", text: "件数变化 999 件" }], actions: [], cannotConclude: [], questions: [] });
  } });
  const answer = await run(config, query);
  assert.match(answer.headline!.text, /^实收高 \+/);
  assert.equal(answer.status, "partial");
});
