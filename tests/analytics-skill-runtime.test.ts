import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import type { SDKMessage } from "../agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts";
import type { AgentQuery } from "../agent/run-turn.ts";
import { createAnalyticsSkillRunner } from "../agent/analytics-skill-run-turn.ts";
import { createSnapshotAnalysisProvider } from "../app/lib/analytics/analysis-v2-snapshot.ts";
import { sampleDataset } from "../app/lib/analytics/sample.ts";
import { planAnswerV4Text } from "../app/lib/analytics/plan/answer.ts";
import type { AnalysisDataProvider } from "../app/lib/analytics/analysis-v2-types.ts";
import { publicAnalyticsTrace } from "../app/lib/analytics/trace.ts";

const dataset = sampleDataset();
const request = { mode: "database" as const, question: "华南表现如何？", history: [{ role: "user" as const, text: "只看八月" }], context: ["洞察关注：大区与货类的联系", "只看华南", "更正，改看华东"] };
const scope = { period: { start: "2026-08-01", end: "2026-08-31" }, population: "sales", filters: {} };
const lookup = { action: "query", request: { method: "aggregate", scope, metrics: ["amount"], purpose: "核对所问实收" } };
const message = (value: unknown) => value as SDKMessage;
const success = (text = "") => message({ type: "result", subtype: "success", is_error: false, result: text });
function setup(t: { after(fn: () => void): void }) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-qa-runtime-")); t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return { model: "test", apiKey: "unit-private-key", modelBaseUrl: "https://example.invalid", runtimeDir, pluginDir: join(process.cwd(), "agent/analytics-plugin"), auditDirectory: join(runtimeDir, "audit") };
}
type Call = (name: string, args: Record<string, unknown>) => Promise<{ isError?: boolean; value: Record<string, unknown> }>;
function scripted(script: (call: Call) => Promise<void>, optionsCheck?: (options: Parameters<AgentQuery>[0]["options"]) => void) {
  let starts = 0;
  const query: AgentQuery = async function* ({ options }) {
    starts++; optionsCheck?.(options);
    const sdk = options!.mcpServers!.analytics; assert.ok("instance" in sdk);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "自主运行验收", version: "1" });
    await sdk.instance.connect(serverSide); await client.connect(clientSide);
    const call: Call = async (name, args) => {
      const permission = await options!.canUseTool!(`mcp__analytics__${name}`, args, { signal: new AbortController().signal, toolUseID: name, requestId: name });
      assert.equal(permission?.behavior, "allow");
      const response = await client.callTool({ name, arguments: args });
      return { isError: response.isError as boolean | undefined, value: JSON.parse((response.content as Array<{ text: string }>)[0].text) };
    };
    try { await script(call); yield success(); } finally { await client.close(); }
  };
  return { query, starts: () => starts };
}

test("一次SDK会话自主查数和提交，不设轮数时限、不强制Skill，保留原上下文", async (t) => {
  const config = setup(t); const events: string[] = [];
  const fake = scripted(async (call) => {
    assert.equal((await call("analyze", lookup)).isError, undefined);
    await call("submit_answer", { body: "历史实收提升 12% 仍需看范围。\n\n" + "按问题展开的有效正文。".repeat(110) });
  }, (options) => {
    assert.equal(options!.maxTurns, undefined);
    assert.deepEqual(options!.allowedTools, []);
    assert.deepEqual(options!.settingSources, []);
    assert.equal(options!.persistSession, false);
    assert.deepEqual(options!.skills, ["analytics:ctf-qa", "analytics:marketing-theory"]);
  });
  const answer = await createAnalyticsSkillRunner(config, { query: async function* (params) {
    const prompt = typeof params.prompt === "string" ? params.prompt : "";
    assert.ok(prompt.includes(request.history[0].text));
    request.context.forEach((text) => assert.ok(prompt.includes(text)));
    yield* fake.query(params);
  }, provider: createSnapshotAnalysisProvider(dataset) })(request, undefined, (event) => { if (event.type === "trace") { publicAnalyticsTrace(event.event); events.push(event.event.tool); } });
  assert.equal(fake.starts(), 1);
  assert.match(planAnswerV4Text(answer), /提升 12%/);
  assert.ok(planAnswerV4Text(answer).length > 800);
  assert.ok(answer.evidence.facts.length && answer.plan.length === 1);
  assert.ok(!events.includes("load_analytics_skill"));
  const audit = readdirSync(config.auditDirectory).map((name) => readFileSync(join(config.auditDirectory, name), "utf8")).join("");
  assert.doesNotMatch(audit, /unit-private-key|hidden_thinking/);
});

test("问候进模型且惰性数据会话完全不打开", async (t) => {
  let opens = 0;
  const query: AgentQuery = async function* () { yield message({ type: "assistant", message: { content: [{ type: "text", text: "今天想了解哪项经营表现？" }], stop_reason: "end_turn" } }); yield success("今天想了解哪项经营表现？"); };
  const answer = await createAnalyticsSkillRunner(setup(t), { query, provider: { open: async () => { opens++; throw new Error("不应打开"); } } })({ ...request, question: "你好" });
  assert.equal(opens, 0);
  assert.equal(planAnswerV4Text(answer), "今天想了解哪项经营表现？");
});

test("循环超过旧12轮且同一底层数据可复用，没有额外SDK启动", async (t) => {
  const fake = scripted(async (call) => { for (let i = 0; i < 16; i++) await call("analyze", lookup); await call("submit_answer", { body: "已完成所需核对。" }); });
  const answer = await createAnalyticsSkillRunner(setup(t), { query: fake.query, provider: createSnapshotAnalysisProvider(dataset) })(request);
  assert.equal(fake.starts(), 1); assert.equal(answer.plan.length, 16);
  assert.equal(new Set(answer.evidence.facts.map((fact) => fact.operationId)).size, 1);
});

test("首发两个工具只打开一个会话，提交等待实际查询完成", async (t) => {
  let opens = 0;
  const provider: AnalysisDataProvider = { open: async (signal) => { opens++; await new Promise((resolve) => setTimeout(resolve, 10)); return createSnapshotAnalysisProvider(dataset).open(signal); } };
  const fake = scripted(async (call) => { await Promise.all([call("inspect_dataset", {}), call("analyze", lookup)]); await call("submit_answer", { body: "根据本次实收回答。" }); });
  const answer = await createAnalyticsSkillRunner(setup(t), { query: fake.query, provider })(request);
  assert.equal(opens, 1); assert.ok(answer.evidence.facts.length);
});

test("后续错误提交不覆盖有效正文，工具错误可以在同一会话修正", async (t) => {
  const fake = scripted(async (call) => {
    assert.equal((await call("draw_chart", { resultId: "unknown", kind: "bar", metric: "amount" })).isError, true);
    await call("submit_answer", { body: "第一稿" }); await call("submit_answer", { body: "最终有效稿" });
    assert.equal((await call("submit_answer", { body: "我是 Claude，由 Anthropic 提供。" })).isError, true);
  });
  const answer = await createAnalyticsSkillRunner(setup(t), { query: fake.query, provider: createSnapshotAnalysisProvider(dataset) })(request);
  assert.equal(planAnswerV4Text(answer), "最终有效稿");
});

test("SDK失败或截断不能采用中间文本或已提交正文", async (t) => {
  for (const subtype of ["error_during_execution", "error_max_turns"]) {
    const query: AgentQuery = async function* () { yield message({ type: "assistant", message: { content: [{ type: "text", text: "我去查询一下" }], stop_reason: "max_tokens" } }); yield message({ type: "result", subtype, is_error: true, errors: ["upstream incomplete"] }); };
    await assert.rejects(createAnalyticsSkillRunner(setup(t), { query, provider: createSnapshotAnalysisProvider(dataset) })(request), /未完成|失败|截断/);
  }
});

test("停止可以中断永不返回的SDK next，不接收迟到成功", async (t) => {
  const controller = new AbortController(); let active!: () => void;
  const began = new Promise<void>((resolve) => { active = resolve; });
  const query = (() => ({ [Symbol.asyncIterator]: () => ({ next: () => { active(); return new Promise<IteratorResult<SDKMessage>>(() => {}); }, return: async () => ({ done: true as const, value: undefined }) }) })) as AgentQuery;
  const work = createAnalyticsSkillRunner(setup(t), { query, provider: createSnapshotAnalysisProvider(dataset) })(request, controller.signal);
  await began; const start = performance.now(); controller.abort();
  await assert.rejects(work, (error: Error) => error.name === "AbortError");
  assert.ok(performance.now() - start < 200);
});

test("SDK成功但没有最终正文时不采用未收尾的中间消息", async (t) => {
  const query: AgentQuery = async function* () { yield message({ type: "assistant", message: { content: [{ type: "text", text: "我去查一下" }], stop_reason: null } }); yield success(); };
  await assert.rejects(createAnalyticsSkillRunner(setup(t), { query, provider: createSnapshotAnalysisProvider(dataset) })(request), /最终正文|中间草稿/);
});

test("运行时插件物理上仅含两份Skill，结束后清理，权限拒绝其余工具", async (t) => {
  let projected = "";
  const query: AgentQuery = async function* ({ options }) {
    projected = options!.plugins![0].path;
    assert.deepEqual(readdirSync(join(projected, "skills")).sort(), ["ctf-qa", "marketing-theory"]);
    for (const [name, input] of [["Bash", { command: "echo nope" }], ["Read", { file_path: "/etc/passwd" }], ["Skill", { skill: "analytics:analysis-review" }], ["mcp__analytics__free_sql", {}]] as const) {
      const permitted = await options!.canUseTool!(name, input, { signal: new AbortController().signal, toolUseID: name, requestId: name }); assert.equal(permitted?.behavior, "deny");
    }
    yield success("可以继续提问。");
  };
  await createAnalyticsSkillRunner(setup(t), { query, provider: createSnapshotAnalysisProvider(dataset) })(request);
  assert.ok(projected && !existsSync(projected));
});

test("Skill只有真实加载成功才记录完成，长目的和身份错误不破坏公开轨迹", async (t) => {
  const config = setup(t); const trace: string[] = [];
  const inner = scripted(async (call) => { await call("analyze", { ...lookup, request: { ...lookup.request, purpose: "这是一个很长的查数目的".repeat(80) } }); await call("submit_answer", { body: "根据实际结果回答。" }); });
  const query: AgentQuery = async function* (args) {
    yield message({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", id: "ok", input: { skill: "analytics:ctf-qa" } }] } });
    yield message({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ok", content: "已读取", is_error: false }] } });
    yield message({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", id: "bad", input: { skill: "analytics:marketing-theory" } }] } });
    yield message({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bad", content: "Claude failure", is_error: true }] } });
    yield* inner.query(args);
  };
  const answer = await createAnalyticsSkillRunner(config, { query, provider: createSnapshotAnalysisProvider(dataset) })(request, undefined, (event) => { if (event.type === "trace") { publicAnalyticsTrace(event.event); trace.push(event.event.title); } });
  const skills = answer.trace!.steps.filter((step) => step.tool === "load_analytics_skill");
  assert.deepEqual(skills.map((step) => step.status), ["completed", "failed"]);
  assert.ok(trace.every((title) => title.length <= 120 && !/Claude/.test(title)));
});

test("缺图提交被拒绝后，应采用完整最终正文，不能让旧缺图稿覆盖", async (t) => {
  const fake = scripted(async (call) => { assert.equal((await call("submit_answer", { body: "未完成的第一稿。\n\n[[chart:unknown]]" })).isError, true); });
  const query: AgentQuery = async function* (args) { yield* fake.query(args); yield message({ type: "assistant", message: { content: [{ type: "text", text: "修正后的完整最终正文。" }], stop_reason: "end_turn" } }); yield success("修正后的完整最终正文。"); };
  const answer = await createAnalyticsSkillRunner(setup(t), { query, provider: createSnapshotAnalysisProvider(dataset) })(request);
  assert.equal(planAnswerV4Text(answer), "修正后的完整最终正文。");
  assert.equal(answer.status, "answered");
});

test("会话resolve后、赋值前的取消也回收实际连接", async (t) => {
  const controller = new AbortController(); let release!: (session: Awaited<ReturnType<AnalysisDataProvider["open"]>>) => void; let started!: () => void; let closes = 0;
  const opening = new Promise<Awaited<ReturnType<AnalysisDataProvider["open"]>>>((resolve) => { release = resolve; });
  const began = new Promise<void>((resolve) => { started = resolve; });
  const opened = await createSnapshotAnalysisProvider(dataset).open(); const originalClose = opened.close;
  opened.close = async () => { closes++; await originalClose(); };
  const fake = scripted(async (call) => { await call("inspect_dataset", {}); });
  const work = createAnalyticsSkillRunner(setup(t), { query: fake.query, provider: { open: () => { started(); return opening; } } })(request, controller.signal);
  await began; release(opened); queueMicrotask(() => controller.abort());
  await assert.rejects(work, (error: Error) => error.name === "AbortError");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(closes >= 1, "已打开但尚未赋给session的连接也必须关闭");
});

test("上游额度错误如实用中文反馈，不伪装为数字核验失败或完成", async (t) => {
  const query: AgentQuery = async function* () { yield message({ type: "result", subtype: "error_during_execution", is_error: true, errors: ['API Error: Request rejected (429) · {"error":{"type":"quota_exceeded","message":"monthly budget exhausted"}}'] }); };
  await assert.rejects(createAnalyticsSkillRunner(setup(t), { query, provider: createSnapshotAnalysisProvider(dataset) })(request), { message: "当前服务额度不足，请及时联系管理员。" });
});
