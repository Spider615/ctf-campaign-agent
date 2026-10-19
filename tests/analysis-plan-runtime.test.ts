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
import { planAnswerV4Text, validatePlanAnswerV4 } from "../app/lib/analytics/plan/answer.ts";
import { sampleDataset } from "../app/lib/analytics/sample.ts";
import { runAnalysis } from "../app/lib/analytics/engine.ts";
import { createSnapshotAnalysisProvider } from "../app/lib/analytics/analysis-v2-snapshot.ts";
import { answerPrompt, answerReviewPrompt, capabilityBrief, planPrompt, planReviewPrompt } from "../app/lib/analytics/plan/prompt.ts";
import { buildPlanSystemPrompt } from "../agent/analytics-system-prompt.ts";
import { semanticDimensionCatalog, ANALYSIS_DIMENSIONS } from "../app/lib/analytics/semantic/model.ts";
import type { AnalysisDataProvider, PlanAnswerV4 } from "../app/lib/analytics/analysis-v2-types.ts";

const dataset = sampleDataset();
const period = { start: dataset.minDate, end: dataset.maxDate };
const request = { dataset, report: { ...runAnalysis(dataset, { period, filters: {} }), id: "plan", createdAt: dataset.createdAt }, question: "今年八月实收比去年八月怎么样？" };
const scope = (start: string, end: string) => ({ period: { start, end }, population: "sales", filters: {} });
const m1 = { id: "m1", op: "measure", scope: scope("2026-08-01", "2026-08-31"), metrics: ["amount"] };
const c1 = { id: "c1", op: "contrast", target: scope("2026-08-01", "2026-08-31"), reference: scope("2025-08-01", "2025-08-31"), metrics: ["amount", "quantity"] };
// 今年八月对去年八月同样 31 天，合计值可以直接比。
const BODY = "今年八月实收比去年同期多 {{c1.amount}}。\n\n件数变化 {{c1.quantity.change}}。";

type Call = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Script = Partial<Record<"submit_plan" | "submit_plan_review" | "submit_followup" | "submit_answer" | "submit_answer_review", (call: Call, round: number) => Promise<void | string>>>;
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
        submit_answer: async (c) => { await c("submit_answer", { body: BODY }); },
        submit_answer_review: async (c) => { await c("submit_answer_review", { verdict: "ok", notes: [] }); },
      };
      // 脚本返回字符串时，当作模型直接输出的文字（不调用工具）。
      const spoken = await (script[name] ?? defaults[name])(call, round);
      if (typeof spoken === "string") yield { type: "assistant", message: { content: [{ type: "text", text: spoken }] } } as unknown as SDKMessage;
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
  createPlanAnalyticsRunner(config, { query, provider })(request, signal) as Promise<PlanAnswerV4>;
const money = (value: number) => new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

const markdown = (answer: PlanAnswerV4) => answer.body.flatMap((block) => block.kind === "markdown" ? [block] : []);
const factOf = (answer: PlanAnswerV4, id: string) => answer.evidence.facts.find((item) => item.id === id)!;

test("正常路径：五次调用，正文数字与证据一致，审计按步骤记录", async (t) => {
  const config = setup(t); const { query, steps } = scripted({}); const phases: string[] = []; const traced: string[] = [];
  const answer = await createPlanAnalyticsRunner(config, { query, provider: createSnapshotAnalysisProvider(dataset) })(request, undefined, (event) => {
    if (event.type === "phase") phases.push(event.phase); if (event.type === "trace" && event.event.status !== "started") traced.push(event.event.tool);
  }) as PlanAnswerV4;
  assert.deepEqual(steps, ["submit_plan", "submit_plan_review", "submit_followup", "submit_answer", "submit_answer_review"]);
  assert.equal(answer.schema, "analysis-answer/v4");
  assert.equal(answer.status, "answered");
  // 空行分段不拆块：两段在同一个 markdown 块里，各有一个引用。
  const [first] = markdown(answer);
  assert.equal(first.refs.length, 2);
  const delta = factOf(answer, first.refs[0].factIds[0]);
  assert.equal(delta.metricId, "amount.delta");
  // 引用区间里的文字就是证据里那个数，正负号和单位由代码写。
  assert.equal(first.text.slice(first.refs[0].start, first.refs[0].end), `${delta.value! > 0 ? "+" : ""}${money(delta.value!)}元`);
  assert.deepEqual(answer.keyFigure, { value: first.text.slice(first.refs[0].start, first.refs[0].end), factId: delta.id });
  assert.equal(factOf(answer, first.refs[1].factIds[0]).metricId, "quantity.relative_change");
  assert.doesNotMatch(planAnswerV4Text(answer), /\{\{/);
  assert.deepEqual(phases, ["analyzing", "writing"]);
  assert.equal(traced.filter((name) => name === "run_plan_node").length, 2);
  assert.ok(traced.includes("submit_answer") && traced.includes("submit_answer_review"));
  assert.ok(answer.trace && answer.trace.steps.length >= 7);
  const [file] = readdirSync(config.auditDirectory);
  const records = readFileSync(join(config.auditDirectory, file), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.kind), ["question", "plan", "plan_review", "execution", "followup", "answer", "answer_review", "final"]);
  assert.equal(records.find((record) => record.kind === "answer").value.final.body, BODY);
  const final = records.at(-1).value;
  assert.equal(final.modelCalls, 5); assert.equal(final.status, "answered"); assert.ok(final.body.length <= 200 && final.body.startsWith("今年八月实收"));
  assert.doesNotMatch(readFileSync(join(config.auditDirectory, file), "utf8"), /secret-key/);
});

test("每一步在模型调用工具之前就出现在轨迹里", async (t) => {
  const config = setup(t); const events: Array<{ tool: string; status: string }> = []; let before: Array<{ tool: string; status: string }> = [];
  const { query } = scripted({ submit_plan: async (c) => { before = [...events]; await c("submit_plan", { plan: { question: request.question, nodes: [m1, c1] } }); } });
  await createPlanAnalyticsRunner(config, { query, provider: createSnapshotAnalysisProvider(dataset) })(request, undefined, (event) => { if (event.type === "trace") events.push({ tool: event.event.tool, status: event.event.status }); });
  assert.deepEqual(before, [{ tool: "submit_plan", status: "started" }]);
  assert.equal(events.filter((item) => item.tool === "submit_plan" && item.status === "started").length, 1);
});

test("模型没调用提交工具时，提前亮出的步骤会收尾", async (t) => {
  const config = setup(t); const traced: Array<{ tool: string; status: string }> = [];
  const { query } = scripted({ submit_answer: async () => BODY });
  const answer = await createPlanAnalyticsRunner(config, { query, provider: createSnapshotAnalysisProvider(dataset) })(request, undefined, (event) => { if (event.type === "trace") traced.push({ tool: event.event.tool, status: event.event.status }); }) as PlanAnswerV4;
  assert.equal(answer.status, "answered");
  assert.ok(answer.trace!.steps.every((step) => step.status !== "started"));
  assert.ok(traced.some((item) => item.tool === "submit_answer" && item.status === "warning"));
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
  assert.deepEqual(base.steps, ["submit_plan", "submit_plan_review", "submit_plan", "submit_followup", "submit_answer", "submit_answer_review"]);
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

test("正文首次有句子没通过：退回 issues，同一次调用内改好后采用第二份", async (t) => {
  const config = setup(t); let first: Record<string, unknown> | undefined; let second: Record<string, unknown> | undefined;
  const { query, steps } = scripted({ submit_answer: async (call) => {
    first = await call("submit_answer", { body: "实收高了 999 元。\n\n件数变化 {{c1.quantity.change}}。" });
    second = await call("submit_answer", { body: BODY });
  } });
  const answer = await run(config, query);
  assert.equal(first?.accepted, false);
  assert.match(JSON.stringify(first?.issues), /999/);
  assert.equal(second?.accepted, true);
  assert.equal(steps.filter((step) => step === "submit_answer").length, 1, "退回重交不增加模型调用");
  assert.match(markdown(answer)[0].text, /^今年八月实收比去年同期多 \+/);
  assert.equal(answer.status, "answered");
});

test("正文首次被退回后模型没有再交：采用首次结果，没通过的句子删掉，答案为部分回答", async (t) => {
  const config = setup(t);
  const { query } = scripted({ submit_answer: async (call) => { await call("submit_answer", { body: "今年八月实收比去年同期多 {{c1.amount}}。件数变化了 999 件。" }); } });
  const answer = await run(config, query);
  assert.equal(answer.status, "partial");
  const text = planAnswerV4Text(answer);
  assert.match(text, /^今年八月实收比去年同期多 \+/); assert.doesNotMatch(text, /999/);
});

test("复核改写成功时采用新正文，复核说明进 review", async (t) => {
  const config = setup(t); const prompts: string[] = [];
  const base = scripted({ submit_answer_review: async (call) => { await call("submit_answer_review", { verdict: "rewrite", body: "和去年八月比，今年八月实收多 {{c1.amount}}，变化 {{c1.amount.change}}。\n\n件数变化 {{c1.quantity.change}}。", notes: ["改成中性说法"] }); } });
  const query: AgentQuery = (params) => { prompts.push(String(params.prompt)); return base.query(params); };
  const answer = await run(config, query);
  assert.match(markdown(answer)[0].text, /^和去年八月比，今年八月实收多 \+[\d,.]+元，变化 [+-]/);
  assert.deepEqual(answer.review.notes, ["改成中性说法"]);
  // 复核提示里有引用原文、填进去的值和依据。
  const review = prompts.at(-1)!;
  assert.match(review, /\{\{c1\.amount\}\}/); assert.match(review, /\{\{c1\.amount\}\} → \+[\d,.]+元｜依据：对比 /); assert.match(review, /指标 实收金额；总体/);
});

test("复核改写变差时保留原正文，并把原因记进复核说明", async (t) => {
  const config = setup(t);
  const { query } = scripted({ submit_answer_review: async (call) => { await call("submit_answer_review", { verdict: "rewrite", body: "实收涨了三成，高了 999 元。", notes: [] }); } });
  const answer = await run(config, query);
  assert.match(markdown(answer)[0].text, /^今年八月实收比去年同期多 \+/);
  assert.equal(answer.status, "answered");
  assert.ok(answer.review.notes.some((note) => /保留原正文/.test(note)), JSON.stringify(answer.review.notes));
  const [file] = readdirSync(config.auditDirectory);
  const review = readFileSync(join(config.auditDirectory, file), "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((record) => record.kind === "answer_review");
  assert.equal(review.value.adopted, false); assert.equal(review.value.verdict, "rewrite");
});

test("复核改写删掉全部引用和表格块：判定丢了数据，保留原文", async (t) => {
  const config = setup(t);
  const body = `${BODY}\n\n::: table c1 amount`;
  const { query } = scripted({
    submit_answer: async (call) => { await call("submit_answer", { body }); },
    submit_answer_review: async (call) => { await call("submit_answer_review", { verdict: "rewrite", body: "今年八月卖得不错。", notes: [] }); },
  });
  const answer = await run(config, query);
  assert.ok(answer.body.some((block) => block.kind === "table"));
  assert.match(markdown(answer)[0].text, /^今年八月实收比去年同期多 \+/);
  assert.ok(answer.review.notes.includes("复核改写丢了数据，保留原文"), JSON.stringify(answer.review.notes));
});

test("全部引用都填不了值时答案为 unavailable，不调用复核", async (t) => {
  const config = setup(t);
  const { query, steps } = scripted({ submit_answer: async (call) => {
    await call("submit_answer", { body: "实收变化 {{c9.amount}}。" });
    await call("submit_answer", { body: "实收变化 {{c1.不存在}}。" });
  } });
  const answer = await run(config, query);
  assert.equal(answer.status, "unavailable");
  assert.equal(answer.body.length, 1); assert.equal(answer.body[0].kind, "markdown");
  assert.equal(steps.includes("submit_answer_review"), false);
  assert.doesNotThrow(() => validatePlanAnswerV4(JSON.parse(JSON.stringify(answer))));
});

test("计划复核修改加补充计划，模型调用总数不超过六", async (t) => {
  const config = setup(t);
  const base = scripted({
    submit_plan_review: async (call) => { await call("submit_plan_review", { verdict: "revise", issues: ["需要补充件数对比"] }); },
    submit_followup: async (call) => { await call("submit_followup", { nodes: [{ id: "s1", op: "scan", of: "c1", dimensions: ["region"] }] }); },
    submit_answer: async (call) => { await call("submit_answer", { body: "实收高了 999 元。" }); await call("submit_answer", { body: BODY }); },
    submit_answer_review: async (call) => { await call("submit_answer_review", { verdict: "rewrite", body: BODY, notes: [] }); },
  });
  await run(config, base.query);
  assert.equal(base.steps.length, 6);
  const [file] = readdirSync(config.auditDirectory);
  const final = readFileSync(join(config.auditDirectory, file), "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
  assert.equal(final.kind, "final"); assert.ok(final.value.modelCalls <= 6);
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
  assert.match(text, /^`\{\{s2\.amount\.deviation\|category=大样本\}\}` = \+1\.00%（样本 900 行）$/m);
  assert.doesNotMatch(text, /小样本/);
  assert.match(text, /s1 另有 4 个偏离较小的分组/);
  assert.match(text, /s2 另有 1 个样本不足 200 行的分组/);
  assert.match(text, /^# s1：扫描 c1/m);
});

test("答案证据只保留被引用事实及其推导来源，且仍能通过证据校验", async (t) => {
  const config = setup(t);
  const { query } = scripted({ submit_followup: async (call) => { await call("submit_followup", { nodes: [{ id: "s1", op: "scan", of: "c1", dimensions: ["region"] }] }); } });
  const answer = await run(config, query);
  const cited = new Set(answer.body.flatMap((block) => block.kind === "markdown" ? block.refs.flatMap((ref) => ref.factIds) : block.kind === "table" ? block.rows.flatMap((row) => row.factIds) : block.chart.factIds));
  const ids = new Set(answer.evidence.facts.map((fact) => fact.id));
  for (const id of cited) assert.ok(ids.has(id), `引用的事实 ${id} 应保留`);
  const { analysisFactParents } = await import("../app/lib/analytics/analysis-v2-fact-links.ts");
  const reachable = new Set<string>(); const stack = [...cited];
  while (stack.length) { const id = stack.pop()!; if (reachable.has(id)) continue; reachable.add(id); const fact = answer.evidence.facts.find((item) => item.id === id); if (fact) stack.push(...analysisFactParents(fact)); }
  assert.equal(ids.size, reachable.size, "不保留未被引用的事实");
  assert.doesNotThrow(() => validatePlanAnswerV4(JSON.parse(JSON.stringify(answer))));
});

test("写正文步骤一次都没提交时补交一次；总调用数不超过 6", async (t) => {
  const config = setup(t);
  const { query, steps } = scripted({ submit_answer: async (call, round) => { if (round === 2) await call("submit_answer", { body: BODY }); } });
  const answer = await run(config, query) as PlanAnswerV4;
  assert.deepEqual(steps.filter((step) => step === "submit_answer").length, 2);
  assert.ok(steps.length <= 6);
  assert.equal(answer.status, "answered");
});

test("计划被退回过一次时调用已用满，漏交正文不再补交，也不做复核", async (t) => {
  const config = setup(t);
  const { query, steps } = scripted({
    submit_plan_review: async (c) => { await c("submit_plan_review", { verdict: "revise", issues: ["补一个对比"] }); },
    submit_answer: async (call, round) => { if (round === 2) await call("submit_answer", { body: BODY }); },
  });
  await run(config, query);
  // 计划 2 + 复核 1 + 补充 1 + 正文 1 = 5，还剩 1 次：用于补交正文，之后不再复核。
  assert.deepEqual(steps, ["submit_plan", "submit_plan_review", "submit_plan", "submit_followup", "submit_answer", "submit_answer"]);
});

test("模型把正文直接说出来、没调用工具时，按正文提交处理，不再多花一次调用", async (t) => {
  const config = setup(t);
  const { query, steps } = scripted({ submit_answer: async () => BODY });
  const answer = await run(config, query) as PlanAnswerV4;
  assert.equal(steps.filter((step) => step === "submit_answer").length, 1);
  assert.equal(answer.status, "answered");
  assert.ok(markdown(answer)[0].refs.length > 0);
});

test("模型只说了不含引用的话时，仍补交一次", async (t) => {
  const config = setup(t);
  const { query, steps } = scripted({ submit_answer: async (call, round) => { if (round === 2) { await call("submit_answer", { body: BODY }); return; } return "好的，我来整理一下。"; } });
  await run(config, query);
  assert.equal(steps.filter((step) => step === "submit_answer").length, 2);
});

test("补交那次模型仍只说出含引用的正文时，同样按正文采用", async (t) => {
  const config = setup(t);
  const { query, steps } = scripted({ submit_answer: async (_call, round) => round === 1 ? "好的。" : BODY });
  const answer = await run(config, query) as PlanAnswerV4;
  assert.equal(steps.filter((step) => step === "submit_answer").length, 2);
  assert.ok(markdown(answer)[0].refs.length > 0);
});

// 问题类型与活动目标：机制比较的对比节点要对齐货，补充计划同样检查；intent 记进审计。
const MECHANISM = { kind: "mechanism", goal: "basket", reason: "比较两种优惠对客单的作用" };
// 示例数据的能力目录没有材料维度，只要求对齐货类：控制 category 即可通过。
const alignedC1 = { ...c1, align: { controls: ["category"] } };
const auditRecords = (config: ReturnType<typeof setup>) => {
  const [file] = readdirSync(config.auditDirectory);
  return readFileSync(join(config.auditDirectory, file), "utf8").trim().split("\n").map((line) => JSON.parse(line));
};

test("机制比较计划没对齐货：首次退回问题，改成控制货类后通过，审计 plan 记下 intent", async (t) => {
  const config = setup(t); let first: Record<string, unknown> | undefined; let second: Record<string, unknown> | undefined;
  const { query, steps } = scripted({ submit_plan: async (call) => {
    first = await call("submit_plan", { plan: { question: request.question, intent: MECHANISM, nodes: [m1, c1] } });
    second = await call("submit_plan", { plan: { question: request.question, intent: MECHANISM, nodes: [m1, alignedC1] } });
  } });
  const answer = await run(config, query);
  assert.equal(first?.accepted, false);
  assert.ok((first?.issues as string[]).some((issue) => issue.startsWith("c1") && issue.includes("机制比较要先对齐货")));
  assert.ok((first?.issues as string[]).some((issue) => issue.includes("控制 category；") && !issue.includes("material")));
  assert.equal(second?.accepted, true); assert.deepEqual(second?.nodes, ["m1", "c1"]);
  assert.equal(steps.length, 5); assert.equal(answer.status, "answered");
  assert.equal(answer.plan.find((row) => row.id === "c1")?.status, "completed");
  assert.deepEqual(auditRecords(config).find((record) => record.kind === "plan").value.intent, MECHANISM);
});

test("计划没写 intent 时审计记默认值，对比节点不做货对齐检查", async (t) => {
  const config = setup(t);
  const answer = await run(config, scripted({}).query);
  assert.equal(answer.status, "answered");
  assert.deepEqual(auditRecords(config).find((record) => record.kind === "plan").value.intent, { kind: "review", goal: "none", reason: "" });
});

test("intent 取值不对：首次退回问题清单", async (t) => {
  const config = setup(t); let first: Record<string, unknown> | undefined;
  const { query } = scripted({ submit_plan: async (call) => {
    first = await call("submit_plan", { plan: { question: request.question, intent: { kind: "guess", goal: "none", reason: "" }, nodes: [m1, c1] } });
    await call("submit_plan", { plan: { question: request.question, intent: { kind: "review", goal: "none", reason: "" }, nodes: [m1, c1] } });
  } });
  await run(config, query);
  assert.equal(first?.accepted, false);
  assert.ok((first?.issues as string[]).some((issue) => issue.includes("intent.kind 取 lookup、review")));
});

test("补充计划沿用主计划的 intent：机制比较下没对齐货的补充对比被退回，再交仍不对齐就丢弃", async (t) => {
  const config = setup(t); let first: Record<string, unknown> | undefined; let result: Record<string, unknown> | undefined;
  const loose = { ...c1, id: "c2" };
  const { query } = scripted({
    submit_plan: async (call) => { await call("submit_plan", { plan: { question: request.question, intent: MECHANISM, nodes: [m1, alignedC1] } }); },
    submit_followup: async (call) => {
      first = await call("submit_followup", { nodes: [loose] });
      result = await call("submit_followup", { nodes: [loose] });
    },
  });
  const answer = await run(config, query);
  assert.equal(first?.accepted, false);
  assert.ok((first?.issues as string[]).some((issue) => issue.startsWith("c2") && issue.includes("机制比较要先对齐货")));
  assert.deepEqual(result?.nodes, []);
  assert.equal(answer.plan.find((row) => row.id === "c2")?.status, "dropped");
});

// 提示词：问题分型、目标对照、原则 A；intent 传给正文和复核。
test("计划提示词含六类问题类型、目标对照和原则 A；复核提示检查 intent、护栏、对齐货和相近维度", () => {
  const prompt = planPrompt("七夕活动效果怎么样", [], "目录", []);
  for (const kind of ["lookup", "review", "attribution", "mechanism", "scenario", "opportunity"]) assert.match(prompt, new RegExp(`\\| ${kind} \\|`));
  for (const ask of ["8 月卖了多少", "七夕活动效果怎么样", "为什么华南跌了", "克减和满减哪个好", "每克再减 10 元会怎样", "下次活动往哪推"]) assert.ok(prompt.includes(ask), ask);
  for (const line of ["frequency（提高到店频次）：主指标 日均订单 orders_per_day", "revenue（冲业绩）：主指标 日均实收 amount_per_day；护栏 毛利率 margin_rate", "acquisition（拉新）"]) assert.ok(prompt.includes(line), line);
  assert.match(prompt, /intent: \{ kind, goal, reason \}/);
  assert.match(prompt, /克减 50 的件均克重是克减 30 的 3 倍/);
  assert.match(prompt, /缺数据不硬答（原则 A）/);
  assert.match(prompt, /节点上限仍是 12/);
  assert.match(prompt, /本流程不能中途追问/);
  assert.match(prompt, /会员分组（memberSegment）不等于会员等级/);
  assert.match(prompt, /"offers":\["一般開單"\]/); assert.match(prompt, /"festivals":\["非节庆"\]/);
  assert.doesNotMatch(prompt, /grams ÷ quantity/); assert.match(prompt, /不要自己相除/);
  const review = planReviewPrompt("q", "{}");
  for (const item of ["intent 是否和问题一致", "主指标和护栏是否都在计划里", "机制比较是否对齐货", "原则 A"]) assert.ok(review.includes(item), item);
});

test("补充计划提示去掉「先判断」节，沿用主计划的类型和目标", () => {
  const prompt = planPrompt("q", [], "目录", [], undefined, { followup: { kind: "mechanism", goal: "basket", reason: "" } });
  assert.match(prompt, /沿用主计划的问题类型和目标：mechanism\/basket/);
  assert.doesNotMatch(prompt, /### 先判断|intent: \{ kind, goal, reason \}|submit_plan\(/);
  assert.match(prompt, /### 算子与示例/); assert.match(prompt, /### 能力目录\n目录/);
});

test("复核退回重提时带上上一版 intent", () => {
  const prompt = planPrompt("q", [], "目录", ["改"], { nodes: [], dropped: [], intent: { kind: "mechanism", goal: "basket", reason: "比两种优惠" } });
  assert.match(prompt, /上一版 intent：\{"kind":"mechanism","goal":"basket"/);
});

test("正文提示词：goal 不为 none 时写目标说明和护栏要求，none 时不写；原则 A 有会员等级示例", () => {
  const withGoal = answerPrompt("七夕卖得怎么样", "结果", [], { kind: "review", goal: "revenue", reason: "七夕是冲业绩的节点" });
  assert.match(withGoal, /本题按复盘处理，目标 冲业绩（主指标日均实收，护栏毛利率）：七夕是冲业绩的节点/);
  assert.match(withGoal, /以「按冲业绩看：」开头/);
  assert.doesNotMatch(withGoal, /三个例子/); assert.match(withGoal, /四个例子/);
  const acquisition = answerPrompt("q", "结果", [], { kind: "review", goal: "acquisition", reason: "" });
  assert.doesNotMatch(acquisition, /### 目标和护栏|以「按拉新看：」开头/); assert.match(acquisition, /新会员数测不了/);
  assert.match(withGoal, /护栏恶化时/);
  const lookup = answerPrompt("8 月卖了多少", "结果", [], { kind: "lookup", goal: "none", reason: "" });
  assert.match(lookup, /本题按查数处理，不涉及活动目标/);
  assert.doesNotMatch(lookup, /### 目标和护栏|按.{1,10}看（主指标/);
  assert.doesNotMatch(answerPrompt("q", "结果"), /### 本题判断|### 目标和护栏/);
  assert.match(lookup, /七夕对不同等级会员影响有什么不同/);
  assert.match(lookup, /不是模板/);
  assert.doesNotMatch(lookup, /先用最接近的现有数据回答/);
});

test("正文复核提示：有目标时检查目标和护栏，始终检查相近维度凑结论", () => {
  const withGoal = answerReviewPrompt("q", [], "正文", [], { kind: "review", goal: "profit", reason: "" });
  assert.match(withGoal, /没写目标/); assert.match(withGoal, /护栏没提/); assert.match(withGoal, /拿相近维度凑结论（原则 A）/);
  const none = answerReviewPrompt("q", [], "正文", []);
  assert.doesNotMatch(none, /没写目标|护栏没提/); assert.match(none, /原则 A/);
});

test("计划系统提示词换成原则 A，不再要求避免说答不了", () => {
  const prompt = buildPlanSystemPrompt("2026-10-18");
  assert.doesNotMatch(prompt, /不以“不能做”/);
  assert.match(prompt, /缺数据不硬答/);
  assert.match(prompt, /不要用相近数据凑出原问题的结论/);
});

test("复核退回后重提的计划漏写 intent 时沿用上一版；intent 为 null 当作没写", async (t) => {
  const config = setup(t); const prompts: string[] = [];
  const base = scripted({
    submit_plan_review: async (call) => { await call("submit_plan_review", { verdict: "revise", issues: ["需要补充件数对比"] }); },
    submit_plan: async (call, round) => {
      const result = await call("submit_plan", { plan: round === 1 ? { question: request.question, intent: MECHANISM, nodes: [m1, alignedC1] } : { question: request.question, intent: null, nodes: [m1, alignedC1] } });
      assert.equal(result.accepted, true);
    },
  });
  const query: AgentQuery = (params) => { prompts.push(String(params.prompt)); return base.query(params); };
  await run(config, query);
  const plans = auditRecords(config).filter((record) => record.kind === "plan");
  assert.equal(plans.length, 2);
  assert.deepEqual(plans[1].value.intent, MECHANISM);
  // 正文和复核提示拿到的是计划判断的类型
  assert.ok(prompts.some((item) => item.includes("## 本步：写回答") && item.includes("本题按机制比较处理，目标 提高客单")));
  assert.ok(prompts.some((item) => item.includes("## 本步：复核回答") && item.includes("本题按机制比较处理")));
  assert.ok(prompts.some((item) => item.includes("## 本步改为：补充计划") && item.includes("沿用主计划的问题类型和目标：mechanism/basket") && !item.includes("### 先判断")));
});

test("计划复核提示：按原则 A 只算事实的计划，不要求补相近维度的对比", async () => {
  const { planReviewPrompt } = await import("../app/lib/analytics/plan/prompt.ts");
  const text = planReviewPrompt("七夕对不同等级会员影响", "{}");
  assert.match(text, /不要以「回答不了原问题」为由退回/);
});

