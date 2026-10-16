import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, realpathSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import type { SDKMessage } from "../agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts";
import type { AgentQuery } from "../agent/run-turn.ts";
import { createGeneralAnalyticsRunner, privateAnalysisDirectory } from "../agent/general-analytics-run-turn.ts";
import { analysisEvidencePage, analysisObjectReferences, createEvidenceDelivery } from "../agent/analytics-evidence-context.ts";
import { analyticsSdkModel } from "../agent/analytics-model.ts";
import { sampleDataset } from "../app/lib/analytics/sample.ts";
import { runAnalysis } from "../app/lib/analytics/engine.ts";
import type { AnalysisDraft, AnalysisOperationResult } from "../app/lib/analytics/analysis-v2-types.ts";
import { createSnapshotAnalysisProvider } from "../app/lib/analytics/analysis-v2-snapshot.ts";
import { createAnalysisOperations } from "../app/lib/analytics/analysis-v2-operations.ts";
import { analyticsBenchmarks } from "./fixtures/general-analytics.ts";
import { simulatedDecisionQuality } from "./helpers/analysis-v2-answer.ts";

const dataset = sampleDataset();
const dates = dataset.rows.map((row) => row.date).sort();
const report = { ...runAnalysis(dataset, { period: { start: dates[0], end: dates.at(-1)! }, filters: {} }), id: "v2-runtime", createdAt: "2026-10-13" };
const request = { dataset, report, question: "销售额发生了什么变化，应该怎么做？" };
const skills = ["analytics:analysis-review", "analytics:ctf-marketing-advisor"];
function* load(names: string[] = []): Generator<SDKMessage> {
  for (const name of names) {
    yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", id: name, input: { skill: name } }] } } as SDKMessage;
    yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: name, content: "已加载" }] } } as SDKMessage;
  }
}
const result = (subtype = "success") => ({ type: "result", subtype, is_error: subtype !== "success", result: "已完成" } as SDKMessage);
function runtime(t: { after: (fn: () => void) => void }) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-general-runtime-")); t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  return { model: "test", apiKey: "test", modelBaseUrl: "https://example.invalid", runtimeDir, auditDirectory: join(runtimeDir, "private"), pluginDir: join(process.cwd(), "agent/analytics-plugin") };
}
async function connect(options: Parameters<AgentQuery>[0]["options"]) {
  const server = options!.mcpServers!.analytics; assert.ok("instance" in server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "通用分析验收", version: "1" });
  await server.instance.connect(serverTransport); await client.connect(clientTransport); return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: name === "submit_review" ? { decisionQuality: simulatedDecisionQuality, ...args } : args });
  return { response, value: JSON.parse((response.content as Array<{ text: string }>)[0].text) };
}
async function submitReview(client: Client, value: Record<string, unknown>) {
  assert.equal((await call(client, "submit_review", { ...value, checks: [], claimChecks: [] })).response.isError, true, "未逐结论核对关系不能接受草稿");
  const inspected = await call(client, "read_review_support", { conclusionId: "judgement" });
  assert.notEqual(inspected.response.isError, true); assert.equal(inspected.value.conclusionId, "judgement");
  const check = { status: "supported", reason: "已核对实际引用、范围及方法限制" };
  return call(client, "submit_review", { ...value, checks: [{ conclusionId: "judgement", scope: check, quantitativeMeaning: check, capability: check, interpretation: check }], claimChecks: inspected.value.claims.map((claim: { id: string }) => ({ claimId: claim.id, status: "supported", reason: "已核对本条公开内容的真实范围及判断边界" })) });
}
async function* prepare(client: Client) {
  await call(client, "inspect_dataset");
  const planned = await call(client, "plan_analysis", { mode: "analysis", needs: [{ userQuote: request.question, judgement: "判断销售变化及应对方向" }], assumptions: [] });
  assert.notEqual(planned.response.isError, true);
  const id = planned.value.task.needs[0].id;
  yield* load([skills[1]]);
  const data = await call(client, "analyze_history", { needIds: [id], purpose: "核对现有实收", method: "aggregate", scope: { period: report.query.period, population: "net", filters: {} }, metrics: ["amount"] });
  assert.notEqual(data.response.isError, true, JSON.stringify(data.value));
  return { id, data: data.value as AnalysisOperationResult };
}
function draft(id: string, data: AnalysisOperationResult): AnalysisDraft {
  return { status: "answered", conclusions: [{ id: "judgement", needIds: [id], level: "observed", judgement: "当前实收已经核对，应优先拆解结构后选择试验", factIds: [data.facts[0].id], methodIds: [data.methods[0].id], objectIds: [], limitations: ["不能由汇总数据证明活动因果"], action: "先核对结构后选择试验", validation: "采用可比门店试验" }], blocks: [{ kind: "paragraph", conclusionId: "judgement", nodes: [{ kind: "text", text: "当前实收为" }, { kind: "fact_ref", factId: data.facts[0].id }, { kind: "text", text: "，先核对结构后选择试验。" }] }], questions: [], userConditions: [], trialParameters: [] };
}

test("按核验缺口局部修订已有草稿，仍完整硬核验与独立复核且不重复查询", async (t) => {
  let reviews = 0; let queries = 0;
  const base = createSnapshotAnalysisProvider(dataset);
  const provider = { open: async (signal?: AbortSignal) => { const session = await base.open(signal); return { ...session, aggregate: async (...args: Parameters<typeof session.aggregate>) => { queries++; return session.aggregate(...args); } }; } };
  const query: AgentQuery = async function* ({ options, prompt }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) { reviews++; assert.doesNotMatch(prompt.toString(), /局部修订须使用已有且不重复的结论id/); await submitReview(client, { verdict: "accept", issues: [] }); }
      else {
        const { id, data } = yield* prepare(client);
        const invalidRead = await call(client, "read_analysis_evidence", { ids: ["未登记的引用"] }); assert.equal(invalidRead.response.isError, true); assert.equal(invalidRead.value.repairable, true); assert.equal(invalidRead.value.errorKind, "invalid_arguments");
        await call(client, "read_analysis_evidence", { ids: [data.facts[0].id] });
        const repairedRead = await call(client, "read_analysis_state"); assert.deepEqual(repairedRead.value.issues, []);
        const original = draft(id, data); original.conclusions[0].judgement = "实收已经提升三倍";
        original.blocks[0].nodes = [{ kind: "text", text: "下一次预计提升三倍" }];
        const rejected = await call(client, "submit_analysis", { draft: original }); assert.equal(rejected.value.accepted, false); assert.match(JSON.stringify(rejected.value.issues), /三倍/);
        const invalidChange = await call(client, "submit_analysis", { changes: { conclusions: [{ id: "不存在", judgement: "不能覆盖其他结论" }] } }); assert.equal(invalidChange.response.isError, true);
        const before = await call(client, "read_analysis_state"); assert.equal(before.value.lastDraft.conclusions[0].judgement, "实收已经提升三倍");
        const changedScope = await client.callTool({ name: "submit_analysis", arguments: { changes: { hardScope: { filters: {} } } } }); assert.equal(changedScope.isError, true);
        const repaired = await call(client, "submit_analysis", { changes: { conclusions: [{ id: "judgement", judgement: "当前实收已经核对，应优先拆解结构后选择试验" }] } }); assert.equal(repaired.value.accepted, false); assert.equal(reviews, 0);
        assert.match(JSON.stringify(repaired.value.issues), /三倍/);
        const lateInvalidChange = await call(client, "submit_analysis", { changes: { conclusions: [{ id: "不存在", judgement: "不能覆盖其他结论" }] } }); assert.equal(lateInvalidChange.response.isError, true);
        const corrected = await call(client, "submit_analysis", { changes: { blocks: [{ index: 0, block: draft(id, data).blocks[0] }] } }); assert.equal(corrected.value.accepted, true);
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query, provider })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "answered"); assert.equal(reviews, 1); assert.equal(queries, 1); assert.equal(answer.conclusions[0].judgement, "当前实收已经核对，应优先拆解结构后选择试验");
});

test("官方兼容别名保持上游模型，自定义提供商与模型不改写", () => {
  assert.equal(analyticsSdkModel("deepseek-flash", "https://api.deepseek.com/anthropic"), "claude-sonnet-4-6");
  assert.equal(analyticsSdkModel("deepseek-v4-pro", "https://api.deepseek.com/anthropic/"), "claude-opus-4-6");
  for (const url of ["https://proxy.example/anthropic", "https://api.deepseek.com", "not-a-url"]) assert.equal(analyticsSdkModel("deepseek-flash", url), "deepseek-flash");
  assert.equal(analyticsSdkModel("customer-model", "https://api.deepseek.com/anthropic"), "customer-model");
});

test("独立复核批量读实际支持包，仍逐结论及逐来源完整提交，未知和重复引用拒绝", async (t) => {
  const query: AgentQuery = async function* ({ options }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) {
        for (const conclusionIds of [["judgement", "made-up"], ["judgement", "judgement"]]) assert.equal((await call(client, "read_review_support", { conclusionIds })).response.isError, true);
        const batch = await call(client, "read_review_support", { conclusionIds: ["judgement", "action"] }); assert.notEqual(batch.response.isError, true, JSON.stringify(batch.value));
        assert.deepEqual(batch.value.conclusionIds, ["judgement", "action"]); assert.equal(batch.value.supports.length, 2);
        assert.equal(new Set(batch.value.claims.map((claim: { id: string }) => claim.id)).size, batch.value.claims.length);
        assert.ok(batch.value.supports.every((support: { cited: { facts: unknown[] } }) => support.cited.facts.length > 0));
        const check = { status: "supported", reason: "已核对各自范围与实际引用" };
        const value = { verdict: "accept", issues: [], checks: ["judgement", "action"].map((conclusionId) => ({ conclusionId, scope: check, quantitativeMeaning: check, capability: check, interpretation: check })), claimChecks: batch.value.claims.map((claim: { id: string }) => ({ claimId: claim.id, status: "supported", reason: "已核对本条内容与边界" })) };
        assert.equal((await call(client, "submit_review", { ...value, claimChecks: value.claimChecks.slice(1) })).response.isError, true);
        assert.notEqual((await call(client, "submit_review", value)).response.isError, true);
      } else {
        const { id, data } = yield* prepare(client); const original = draft(id, data);
        original.conclusions.push({ ...original.conclusions[0], id: "action" }); original.blocks.push({ ...original.blocks[0], conclusionId: "action" }); original.questions = ["未来试点营业条件是否满足？"];
        assert.equal((await call(client, "submit_analysis", { draft: original })).value.accepted, true);
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })(request); assert.ok("schema" in answer); assert.equal(answer.review.verdict, "accept");
});

test("局部修订只复用未变结论的真实复核，仍须重新读全局来源并核对整篇一致性", async (t) => {
  let reviews = 0; let operations = 0; let cachedClaimId = ""; const config = runtime(t);
  const query: AgentQuery = async function* ({ options, prompt }) {
    const client = await connect(options);
    try {
      const check = { status: "supported", reason: "已核对实际范围与方向" };
      const checked = (conclusionId: string) => ({ conclusionId, scope: check, quantitativeMeaning: check, capability: check, interpretation: check });
      const claims = (support: { claims: Array<{ id: string }> }) => support.claims.map(({ id }) => ({ claimId: id, status: "supported", reason: "已核对真实公开来源" }));
      const unique = (checks: ReturnType<typeof claims>) => [...new Map(checks.map((check) => [check.claimId, check])).values()];
      if (options!.systemPrompt!.toString().includes("独立复核员")) {
        reviews++;
        const b = (await call(client, "read_review_support", { conclusionId: "action" })).value;
        const global = (await call(client, "read_review_support", { scope: "global" })).value;
        if (reviews === 1) {
          const a = (await call(client, "read_review_support", { conclusionId: "judgement" })).value;
          cachedClaimId = a.claims.find((claim: { conclusionId?: string }) => claim.conclusionId === "judgement").id;
          const mismatch = await call(client, "submit_review", { verdict: "accept_conditional", issues: [], checks: [checked("judgement"), checked("action")], claimChecks: unique([...claims(a), ...claims(b), ...claims(global)]) }); assert.equal(mismatch.response.isError, true); assert.match(mismatch.value.error, /完成状态/);
          const firstReview = await call(client, "submit_review", { verdict: "revise", issues: [{ needIds: [b.claims[0].needIds[0]], conclusionIds: ["action"], kind: "expression", requirement: "修订建议的执行条件" }], checks: [checked("judgement"), { ...checked("action"), interpretation: { status: "revise", reason: "执行条件需说明" } }], claimChecks: unique([...claims(a), ...claims(b), ...claims(global)]) }); assert.notEqual(firstReview.response.isError, true, JSON.stringify(firstReview.value));
        } else {
          assert.match(prompt.toString(), /可复用的独立正面记录/);
          const value = { verdict: "accept", issues: [], checks: [checked("action")], claimChecks: unique([...claims(b), ...claims(global)]) };
          const missing = await call(client, "submit_review", value); assert.equal(missing.response.isError, true); assert.match(missing.value.error, /整体一致性/);
          const unclear = await call(client, "submit_review", { ...value, globalConsistency: { status: "not_applicable", reason: "不能跳过整体审阅" } }); assert.equal(unclear.response.isError, true);
          const contradicted = await call(client, "submit_review", { ...value, globalConsistency: { status: "revise", reason: "整篇目标不一致" } }); assert.equal(contradicted.response.isError, true);
          const claimWithoutFreshRead = await call(client, "submit_review", { ...value, globalConsistency: check, claimChecks: [...value.claimChecks, { claimId: cachedClaimId, status: "supported", reason: "只读全局不能覆盖结论内的主张" }] }); assert.equal(claimWithoutFreshRead.response.isError, true); assert.match(claimWithoutFreshRead.value.error, /重新读取/);
          const withoutFreshRead = await call(client, "submit_review", { ...value, checks: [checked("judgement"), checked("action")], globalConsistency: check }); assert.equal(withoutFreshRead.response.isError, true); assert.match(withoutFreshRead.value.error, /重新读取/);
          const result = await call(client, "submit_review", { ...value, globalConsistency: check }); assert.notEqual(result.response.isError, true, JSON.stringify(result.value));
        }
      } else {
        await call(client, "inspect_dataset");
        const planned = await call(client, "plan_analysis", { mode: "analysis", needs: [{ userQuote: "销售额发生了什么变化", judgement: "核对变化" }, { userQuote: "应该怎么做", judgement: "给出候选行动" }], assumptions: [] });
        assert.notEqual(planned.response.isError, true); const ids = planned.value.task.needs.map((need: { id: string }) => need.id);
        yield* load([skills[1]]);
        const data = await call(client, "analyze_history", { needIds: ids, purpose: "核对候选方向依赖的实收", method: "aggregate", scope: { period: report.query.period, population: "net", filters: {} }, metrics: ["amount"] }); operations++;
        const original = draft(ids[0], data.value);
        original.conclusions.push({ ...original.conclusions[0], id: "action", needIds: [ids[1]], judgement: "候选行动需要设置执行条件" });
        original.blocks.push({ kind: "paragraph", conclusionId: "action", nodes: [{ kind: "text", text: "候选方向需设置执行条件。" }] }); original.questions = ["未来试点需要确认哪些执行条件？"];
        const first = await call(client, "submit_analysis", { draft: original }); assert.equal(first.value.accepted, false, JSON.stringify(first.value));
        const repaired = await call(client, "submit_analysis", { changes: { conclusions: [{ id: "action", judgement: "候选行动须确认门店营业状态后试点" }], blocks: [{ index: 1, block: { ...original.blocks[1], nodes: [{ kind: "text", text: "候选行动须确认门店营业状态后试点。" }] } }] } }); assert.equal(repaired.value.accepted, true, JSON.stringify(repaired.value));
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(config, { query })(request);
  assert.ok("schema" in answer); assert.equal(answer.review.verdict, "accept"); assert.equal(reviews, 2); assert.equal(operations, 1);
  const entries = readFileSync(join(config.auditDirectory, `${answer.task.runId}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(entries.filter((entry) => entry.kind === "review").at(-1).value.reuse.conclusionIds, ["judgement"]);
});

test("复核可压缩同段正面原句，仍拒绝混合上下文、漏项、未知与负面接受", async (t) => {
  const config = runtime(t); let actualClaimCount = 0;
  const query: AgentQuery = async function* ({ options }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) {
        const support = (await call(client, "read_review_support", { conclusionId: "judgement" })).value;
        const claims = support.claims as Array<{ id: string; kind: string; contextId: string }>;
        actualClaimCount = claims.length;
        const body = claims.filter((claim) => claim.kind === "body"); assert.ok(body.length >= 3);
        assert.equal(new Set(body.map((claim) => claim.contextId)).size, 1);
        assert.ok(support.contexts.find((context: { id: string; context: string }) => context.id === body[0].contextId).context.includes("不证明未来增量"));
        const check = { status: "supported", reason: "按实际数据范围核对数值、能力与未来试验边界" };
        const value = { verdict: "accept", issues: [], checks: [{ conclusionId: "judgement", scope: check, quantitativeMeaning: check, capability: check, interpretation: check }], claimChecks: claims.filter((claim) => claim.kind !== "body").map((claim) => ({ claimId: claim.id, status: "supported", reason: "核对该原始来源" })), claimGroups: [{ claimIds: body.map((claim) => claim.id), reason: "逐句核对本段实收范围及未来试验限制；全部原句成立" }] };
        assert.equal((await call(client, "submit_review", { ...value, claimGroups: [{ ...value.claimGroups[0], claimIds: body.slice(1).map((claim) => claim.id) }] })).response.isError, true);
        assert.equal((await call(client, "submit_review", { ...value, claimGroups: [{ ...value.claimGroups[0], claimIds: [...value.claimGroups[0].claimIds, "unknown"] }] })).response.isError, true);
        assert.equal((await call(client, "submit_review", { ...value, claimChecks: [], claimGroups: [{ ...value.claimGroups[0], claimIds: claims.map((claim) => claim.id) }] })).response.isError, true);
        const failed = { ...value, claimChecks: [...value.claimChecks, { claimId: body[0].id, status: "revise", reason: "本原句没有相应依据" }], claimGroups: [{ ...value.claimGroups[0], claimIds: body.slice(1).map((claim) => claim.id) }] };
        assert.equal((await call(client, "submit_review", failed)).response.isError, true);
        assert.notEqual((await call(client, "submit_review", value)).response.isError, true);
      } else {
        const { id, data } = yield* prepare(client); const value = draft(id, data);
        value.blocks[0].nodes.push({ kind: "text", text: "该数值仅覆盖当前授权范围。不证明未来增量。" });
        assert.equal((await call(client, "submit_analysis", { draft: value })).value.accepted, true);
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(config, { query })(request); assert.ok("schema" in answer); assert.equal(answer.review.verdict, "accept");
  const file = join(config.auditDirectory, readdirSync(config.auditDirectory).find((path) => path.endsWith(".jsonl"))!);
  const record = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((row) => row.kind === "review").value;
  assert.equal(record.claimChecks.length, actualClaimCount); assert.equal(new Set(record.claimChecks.map((check: { claimId: string }) => check.claimId)).size, actualClaimCount);
});

test("续窗已有取证却未提交草稿时先形成可核验答案，不再重新扩展查询", async (t) => {
  let windows = 0; let saved: { id: string; data: AnalysisOperationResult } | undefined;
  const query: AgentQuery = async function* ({ options }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) await submitReview(client, { verdict: "accept", issues: [] });
      else if (++windows === 1) { saved = yield* prepare(client); yield result("error_max_turns"); return; }
      else {
        assert.ok(saved);
        yield* load([skills[1]]);
        const extra = await call(client, "analyze_history", { needIds: [saved.id], purpose: "先继续扩大探索", method: "aggregate", scope: { period: report.query.period, population: "net", filters: {} }, metrics: ["quantity"] });
        assert.equal(extra.value.draftRequired, true); assert.equal(extra.value.accepted, false);
        const state = await call(client, "read_analysis_state"); assert.equal(state.value.evidence.directory.length, 1);
        const roots = await call(client, "read_analysis_evidence", { operationId: saved.data.operationId }); assert.equal(roots.value.parentChainsIncluded, false);
        assert.equal((await call(client, "submit_analysis", { draft: draft(saved.id, saved.data) })).value.accepted, true);
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "answered"); assert.equal(windows, 2);
  assert.ok(answer.trace?.steps.some((step) => step.tool === "analyze_history" && step.status === "warning"));
});

test("同一窗口完成初轮取证后先提交草稿，后续核验需要的补算仍允许", async (t) => {
  let reviews = 0;
  const query: AgentQuery = async function* ({ options }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) { reviews++; await submitReview(client, { verdict: "accept", issues: [] }); }
      else {
        const { id, data } = yield* prepare(client);
        const extra = (by: string[]) => call(client, "analyze_history", { needIds: [id], purpose: "读取所需分组", method: "aggregate", scope: { period: report.query.period, population: "net", filters: {} }, metrics: ["quantity"], by });
        assert.equal((await extra(["category"])).value.status, "completed");
        assert.equal((await extra(["store"])).value.status, "completed");
        const deferred = await extra(["region"]); assert.equal(deferred.value.draftRequired, true); assert.equal(deferred.value.accepted, false);
        const value = draft(id, data); value.conclusions[0].judgement = "实收提升三倍";
        assert.equal((await call(client, "submit_analysis", { draft: value })).value.accepted, false);
        assert.equal((await extra(["region"])).value.status, "completed", "起草后必要补算仍可执行，并非回合查询上限");
        assert.equal((await call(client, "submit_analysis", { changes: { conclusions: [{ id: "judgement", judgement: "实收已核对，继续核对结构后判断" }] } })).value.accepted, true);
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "answered"); assert.equal(reviews, 1); assert.equal(answer.evidence.methods.length, 1);
});

test("起草窗口保留已有证据的计算与读取，完成草稿前不重新开放数据库探索", async (t) => {
  let windows = 0; let saved: { id: string; data: AnalysisOperationResult } | undefined;
  const query: AgentQuery = async function* ({ options, prompt }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) await submitReview(client, { verdict: "accept", issues: [] });
      else if (++windows === 1) {
        saved = yield* prepare(client);
        for (const by of [["category"], ["store"]]) await call(client, "analyze_history", { needIds: [saved.id], purpose: "完成初轮取证", method: "aggregate", scope: { period: report.query.period, population: "net", filters: {} }, metrics: ["quantity"], by });
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "initial-pass", content: "取证完成" }] } } as SDKMessage;
        assert.fail("初轮工具结果后不应继续留在探索窗口");
      } else {
        assert.ok(saved); assert.match(prompt.toString(), /起草阶段/);
        assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["calculate_analysis", "read_analysis_evidence", "submit_analysis"]);
        const permission = await options!.canUseTool!("mcp__analytics__calculate_analysis", {}, { signal: new AbortController().signal, toolUseID: "draft-calculation", requestId: "draft-calculation" });
        assert.equal(permission?.behavior, "allow");
        yield* load([skills[1]]);
        assert.equal((await call(client, "submit_analysis", { draft: draft(saved.id, saved.data) })).value.accepted, true);
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "answered"); assert.equal(windows, 2);
});

test("探索窗口交接后旧MCP连接不能迟到提交或修改新窗口状态", async (t) => {
  let windows = 0; let reviews = 0; let oldClient: Client; let saved: { id: string; data: AnalysisOperationResult };
  const query: AgentQuery = async function* ({ options }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) { reviews++; await submitReview(client, { verdict: "accept", issues: [] }); }
      else if (++windows === 1) {
        oldClient = client; saved = yield* prepare(client);
        for (const by of [["category"], ["store"]]) await call(client, "analyze_history", { needIds: [saved.id], purpose: "完成初轮取证", method: "aggregate", scope: { period: report.query.period, population: "net", filters: {} }, metrics: ["quantity"], by });
        yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "initial-pass", content: "取证完成" }] } } as SDKMessage;
      } else {
        const late = await oldClient!.callTool({ name: "submit_analysis", arguments: { draft: draft(saved!.id, saved!.data) } });
        assert.equal(late.isError, true, "旧窗口提交须拒绝，不能完成或覆盖本轮答案"); assert.equal(reviews, 0);
        yield* load([skills[1]]); assert.equal((await call(client, "submit_analysis", { draft: draft(saved!.id, saved!.data) })).value.accepted, true);
      }
      yield result();
    } finally { if (client !== oldClient!) await client.close(); }
  };
  try { const answer = await createGeneralAnalyticsRunner(runtime(t), { query })(request); assert.ok("schema" in answer); assert.equal(answer.status, "answered"); assert.equal(windows, 2); assert.equal(reviews, 1); }
  finally { await oldClient!.close(); }
});

test("v2 独立审阅退回后补证据再提交，审阅权限只读且不接数据库", async (t) => {
  let mains = 0; let reviews = 0;
  const config = runtime(t);
  const advisorOnly = join(config.runtimeDir, "advisor-only");
  mkdirSync(join(advisorOnly, ".claude-plugin"), { recursive: true }); mkdirSync(join(advisorOnly, "skills/ctf-marketing-advisor"), { recursive: true });
  writeFileSync(join(advisorOnly, ".claude-plugin/plugin.json"), readFileSync(join(config.pluginDir, ".claude-plugin/plugin.json")));
  writeFileSync(join(advisorOnly, "skills/ctf-marketing-advisor/SKILL.md"), readFileSync(join(config.pluginDir, "skills/ctf-marketing-advisor/SKILL.md")));
  const query: AgentQuery = async function* ({ options }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) {
        reviews++; const listed = await client.listTools();
        assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["compare_review_facts", "read_review_evidence", "read_review_support", "submit_review"]);
        const permission = await options!.canUseTool!("Bash", { command: "whoami" }, { signal: options!.abortController!.signal, toolUseID: "denied", requestId: "denied" });
        assert.ok(permission); assert.equal(permission.behavior, "deny");
        await submitReview(client, reviews === 1 ? { verdict: "revise", issues: [{ kind: "missing_evidence", needIds: ["need-1"], conclusionIds: ["judgement"], requirement: "补充数量，核对当前证据是否足以解释变化" }] } : { verdict: "accept", issues: [] });
      } else {
        mains++; assert.notEqual((await call(client, "inspect_dataset")).response.isError, true);
        assert.deepEqual(options!.skills, [skills[1]]);
        const denied = await options!.canUseTool!("Skill", { skill: skills[0] }, { signal: options!.abortController!.signal, toolUseID: "base", requestId: "base" });
        assert.ok(denied); assert.equal(denied.behavior, "deny");
        assert.ok((await client.listTools()).tools.every((tool) => tool._meta?.["anthropic/alwaysLoad"] === true), "分析工具必须真实开放给模型，不能延迟到被禁用的ToolSearch");
        yield* load();
        const { id, data } = yield* prepare(client);
        const first = await call(client, "submit_analysis", { draft: draft(id, data) });
        assert.equal(first.value.accepted, false);
        const extra = await call(client, "analyze_history", { needIds: [id], purpose: "补充数量检查", method: "aggregate", scope: { period: report.query.period, population: "net", filters: {} }, metrics: ["quantity"] });
        assert.notEqual(extra.response.isError, true);
        const corrected = draft(id, data); corrected.conclusions[0].factIds.push(extra.value.facts[0].id);
        assert.equal((await call(client, "submit_analysis", { draft: corrected })).value.accepted, true);
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner({ ...config, pluginDir: advisorOnly }, { query })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "answered"); assert.equal(reviews, 2); assert.equal(mains, 1);
  assert.equal(answer.task.needs[0].status, "supported"); assert.ok(answer.trace?.steps.some((event) => event.tool === "review_analysis"));
  const logs = readdirSync(config.auditDirectory).map((name) => readFileSync(join(config.auditDirectory, name), "utf8")).join("\n");
  assert.match(logs, /missing_evidence/); assert.match(logs, /补充数量检查/); assert.ok(!logs.includes("systemPrompt"));
});

test("SDK 逻辑窗口续接保留事实，每个新窗口重新加载实际 Skill", async (t) => {
  let windows = 0; let data: AnalysisOperationResult; let need = "";
  const query: AgentQuery = async function* ({ options, prompt }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) await submitReview(client, { verdict: "accept", issues: [] });
      else {
        windows++; yield* load();
        if (windows === 1) { const state = yield* prepare(client); data = state.data; need = state.id; yield result("error_max_turns"); return; }
        yield* load([skills[1]]);
        assert.match(prompt.toString(), /窗口续接/); assert.ok(prompt.toString().includes(data!.facts[0].id));
        const state = await call(client, "read_analysis_state"); assert.ok(state.value.evidence.facts.length);
        await call(client, "submit_analysis", { draft: draft(need, data!) });
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "answered"); assert.equal(windows, 2);
});

test("寒暄不调模型；模型工具缺少 Skill 时不能提交完成", async (t) => {
  let calls = 0;
  const query: AgentQuery = async function* ({ options }) {
    calls++; const client = await connect(options);
    try { await call(client, "plan_analysis", { mode: "analysis", needs: [{ userQuote: request.question, judgement: "判断变化及行动" }], assumptions: [] }); yield result(); }
    finally { await client.close(); }
  };
  const runner = createGeneralAnalyticsRunner(runtime(t), { query });
  const hello = await runner({ ...request, question: "你好" });
  assert.ok(!("schema" in hello)); assert.equal(calls, 0);
  await assert.rejects(runner(request), /Skill/);
});

test("无进展不无限续接，不将未回答问题变成数据不足的完成答案", async (t) => {
  let calls = 0;
  const query: AgentQuery = async function* () { calls++; yield* load(); yield result("error_max_turns"); };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "incomplete"); assert.equal(answer.task.needs[0].status, "open"); assert.equal(answer.review.verdict, "revise"); assert.ok(calls <= 3);
});

test("缩窄已完成汇总的指标不算新进展，不能靠重复取证无限续轮", async (t) => {
  let windows = 0;
  const query: AgentQuery = async function* ({ options }) {
    windows++; const client = await connect(options);
    try {
      if (windows > 3) throw new Error("重复已有指标仍被当成新进展");
      yield* load(windows > 1 ? [skills[1]] : []); await call(client, "inspect_dataset");
      const planned = await call(client, "plan_analysis", { mode: "analysis", needs: [{ userQuote: request.question, judgement: "核对销售变化" }], assumptions: [] });
      yield* load([skills[1]]);
      const data = await call(client, "analyze_history", { needIds: [planned.value.task.needs[0].id], purpose: "复用已有汇总", method: "aggregate", scope: { period: report.query.period, population: "sales", filters: {} }, metrics: windows === 1 ? ["amount", "quantity"] : windows === 2 ? ["amount"] : ["quantity"] });
      assert.notEqual(data.response.isError, true);
      yield result("error_max_turns");
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "incomplete");
  assert.equal(windows, 3);
  assert.equal(answer.evidence.methods.length, 1);
  assert.equal(answer.task.needs[0].status, "open");
});

test("等价计算仅改名称不延长分析窗口，重复读取结果也不算进展", async (t) => {
  let windows = 0; let data: AnalysisOperationResult; let needId = "";
  const query: AgentQuery = async function* ({ options }) {
    windows++; const client = await connect(options);
    try {
      if (windows > 3) throw new Error("重复计算改名仍被当成新进展");
      if (windows === 1) ({ id: needId, data } = yield* prepare(client));
      else yield* load([skills[1]]);
      const calculated = await call(client, "calculate_analysis", { needIds: [needId], purpose: "同样的条件计算", frameId: data.frames[0].id, assumptions: [], calculations: [{ key: `renamed_${windows}`, label: `重复计算${windows}`, unit: data.facts[0].unit, op: "multiply", args: [{ kind: "fact", id: data.facts[0].id }, { kind: "constant", value: 1 }] }] });
      assert.notEqual(calculated.response.isError, true);
      await call(client, "read_analysis_evidence", { operationId: calculated.value.operationId });
      yield result("error_max_turns");
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "incomplete"); assert.equal(windows, 3);
});

test("最终复核期间快照失效必须重开并清理旧事实，重新计算后才能回答", async (t) => {
  let openings = 0; let closed = 0; let reviews = 0; let expireFirst = false; let oldFact = "";
  const snapshot = createSnapshotAnalysisProvider(dataset);
  const provider = { open: async (signal?: AbortSignal) => {
    openings++; const first = openings === 1; const session = await snapshot.open(signal);
    return { ...session, assertActive() { if (first && expireFirst) throw Object.assign(new Error("一致性会话已失效"), { code: "ANALYSIS_SESSION_EXPIRED" }); session.assertActive?.(); }, async close() { closed++; await session.close(); } };
  } };
  const query: AgentQuery = async function* ({ options }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) { reviews++; if (reviews === 1) expireFirst = true; await submitReview(client, { verdict: "accept", issues: [] }); }
      else {
        yield* load(); const initial = yield* prepare(client); oldFact = initial.data.facts[0].id;
        const first = await call(client, "submit_analysis", { draft: draft(initial.id, initial.data) });
        assert.equal(first.response.isError, true); assert.match(first.value.error, /重新计算/);
        const state = await call(client, "read_analysis_state"); assert.equal(state.value.evidence.facts.length, 0);
        const recalculated = yield* prepare(client); assert.notEqual(recalculated.data.facts[0].id, oldFact);
        const recoveredState = await call(client, "read_analysis_state");
        assert.deepEqual(recoveredState.value.issues, [], "新快照已经登记重算结果后，不再要求下一窗口重复重开与重算");
        await call(client, "submit_analysis", { draft: draft(recalculated.id, recalculated.data) });
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query, provider })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "answered"); assert.equal(openings, 2); assert.equal(closed, 2);
  assert.ok(answer.evidence.facts.every((fact) => fact.id !== oldFact)); assert.equal(new Set(answer.evidence.frames.map((frame) => frame.snapshotId)).size, 1);
});

test("挂起主模型 next 可立即取消，不等待 iterator.return 且不产生迟到结果", async (t) => {
  const controller = new AbortController(); let calls = 0;
  const query = (() => { calls++; return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: () => new Promise(() => {}) }) }; }) as AgentQuery;
  const events: unknown[] = []; const pending = createGeneralAnalyticsRunner(runtime(t), { query })(request, controller.signal, (event) => events.push(event));
  const before = events.length; controller.abort(); const started = performance.now();
  await assert.rejects(pending, { name: "AbortError" }); assert.ok(performance.now() - started < 200); assert.equal(calls, 1); assert.equal(events.length, before);
});

test("主模型供应商错误不改写成业务能力不足或conditional完成", async (t) => {
  const query: AgentQuery = async function* () { yield* load(); throw new Error("真实上游鉴权失败"); };
  await assert.rejects(createGeneralAnalyticsRunner(runtime(t), { query })(request), /真实上游鉴权失败/);
});

test("初次业务范围理解错误可按原话纠正，但不能扩大不可变数据授权", async (t) => {
  const question = "分析八月与九月的销售变化";
  const query: AgentQuery = async function* ({ options, prompt }) {
    const client = await connect(options);
    try {
      yield* load();
      if (prompt.toString().includes("窗口续接")) yield* load([skills[1]]);
      await call(client, "inspect_dataset");
      const needs = [{ userQuote: question, judgement: "比较本期与参照期" }];
      assert.notEqual((await call(client, "plan_analysis", { mode: "analysis", needs, hardScope: { period: { start: "2026-09-01", end: report.query.period.end }, filters: {} }, scopeQuotes: ["九月"], assumptions: [] })).response.isError, true);
      yield* load([skills[1]]);
      const corrected = await call(client, "plan_analysis", { mode: "analysis", needs, hardScope: { period: report.query.period, filters: {} }, scopeQuotes: [question], assumptions: [] });
      assert.notEqual(corrected.response.isError, true); assert.deepEqual(corrected.value.task.hardScope.period, report.query.period);
      const outsideStart = new Date(Date.parse(report.query.period.start) - 86400000).toISOString().slice(0, 10);
      const outside = await call(client, "plan_analysis", { mode: "analysis", needs, hardScope: { period: { start: outsideStart, end: report.query.period.end }, filters: {} }, scopeQuotes: [question], assumptions: [] });
      assert.equal(outside.response.isError, true); assert.match(outside.value.error, /授权|覆盖/);
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })({ ...request, question });
  assert.ok("schema" in answer); assert.equal(answer.status, "incomplete"); assert.deepEqual(answer.task.hardScope.period, report.query.period);
});

test("重复数据库资源截止保持真实失败，新连接和新编号不算分析进展", async (t) => {
  let opens = 0; let calls = 0;
  const snapshot = createSnapshotAnalysisProvider(dataset);
  const provider = { open: async (signal?: AbortSignal) => { opens++; const session = await snapshot.open(signal); return { ...session, async aggregate() { throw Object.assign(new Error("数据库查询资源截止"), { code: "ANALYSIS_SESSION_EXPIRED" }); } }; } };
  const query: AgentQuery = async function* ({ options }) {
    calls++; const client = await connect(options);
    try {
      yield* load(); if (calls > 1) yield* load([skills[1]]); await call(client, "inspect_dataset");
      const planned = await call(client, "plan_analysis", { mode: "analysis", needs: [{ userQuote: request.question, judgement: "判断变化" }], assumptions: [] });
      if (calls === 1) yield* load([skills[1]]);
      await call(client, "analyze_history", { needIds: [planned.value.task.needs[0].id], purpose: "读取原问题所需实收", method: "aggregate", scope: { period: report.query.period, population: "net", filters: {} }, metrics: ["amount"] });
      yield result("error_max_turns");
    } finally { await client.close(); }
  };
  await assert.rejects(createGeneralAnalyticsRunner(runtime(t), { query, provider })(request), /数据库查询资源截止/);
  assert.equal(opens, 2); assert.equal(calls, 2);
});

test("私有记录目录拒绝仓库根、子目录、相对启动目录及外部链接回仓库", (t) => {
  const root = process.cwd(); const external = mkdtempSync(join(tmpdir(), "ctf-private-path-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  assert.throws(() => privateAnalysisDirectory(root), /仓库之外/);
  assert.throws(() => privateAnalysisDirectory(join(root, "agent")), /仓库之外/);
  symlinkSync(root, join(external, "repo-link")); assert.throws(() => privateAnalysisDirectory(join(external, "repo-link", "private")), /仓库之外/);
  process.chdir(join(root, "agent"));
  try { assert.throws(() => privateAnalysisDirectory(".."), /仓库之外/); } finally { process.chdir(root); }
  assert.equal(privateAnalysisDirectory(join(external, "allowed")), realpathSync(join(external, "allowed")));
});

test("证据分页保留派生全父链与目录，不让未知引用静默消失", () => {
  const evidence = { frames: [], methods: [], objects: [], facts: Array.from({ length: 201 }, (_, index) => ({ id: `fact-${index}`, frameId: "f", metricId: "amount", label: "模拟金额", value: index, unit: "CNY", definition: "测试", objectIds: [], operationId: "operation", limitations: [], ...(index === 200 ? { derivation: { factId: "fact-0" } } : {}) })) };
  const first = analysisEvidencePage(evidence); assert.equal(first.facts.length, 60); assert.equal(first.paging.nextOffset, 60); assert.equal(first.paging.totalFacts, 201);
  const last = analysisEvidencePage(evidence, { ids: ["fact-200"] }); assert.deepEqual(last.facts.map((fact) => fact.id), ["fact-200", "fact-0"]);
  assert.throws(() => analysisEvidencePage(evidence, { ids: ["made-up"] }), /登记引用/);
});

test("按门店或货品对象引用直接读取其已捕获指标，不必翻遍其他对象的证据页", () => {
  const base = { frameId: "frame", metricId: "amount", label: "模拟金额", value: 100, unit: "CNY", definition: "测试", operationId: "operation", limitations: [] };
  const evidence = { frames: [], methods: [], objects: [{ id: "store-a", frameId: "frame", dimension: "store" as const, value: "A", label: "A" }, { id: "store-b", frameId: "frame", dimension: "store" as const, value: "B", label: "B" }], facts: [{ ...base, id: "amount-a", objectIds: ["store-a"] }, { ...base, id: "orders-a", metricId: "orders", value: 2, objectIds: ["store-a"] }, { ...base, id: "amount-b", objectIds: ["store-b"] }] };
  const first = analysisEvidencePage(evidence, { ids: ["store-a"], limit: 1 });
  assert.deepEqual(first.facts.map((fact) => fact.id), ["amount-a"]); assert.equal(first.paging.totalFacts, 2); assert.equal(first.paging.nextOffset, 1);
  const next = analysisEvidencePage(evidence, { ids: ["store-a"], offset: 1, limit: 1 });
  assert.deepEqual(next.facts.map((fact) => fact.id), ["orders-a"]); assert.equal(next.paging.nextOffset, null);
  assert.deepEqual(analysisEvidencePage(evidence, { ids: ["amount-b"] }).facts.map((fact) => fact.id), ["amount-b"]);
});

test("混合事实与对象引用时优先交付明确事实，对象身份不能挤掉需要核对的指标", () => {
  const base = { frameId: "frame", metricId: "amount", label: "模拟金额", value: 100, unit: "CNY", definition: "测试", operationId: "operation", limitations: [], objectIds: ["store-a"] };
  const evidence = { frames: [], methods: [], objects: [{ id: "store-a", frameId: "frame", dimension: "store" as const, value: "A", label: "A" }], facts: [...Array.from({ length: 100 }, (_, index) => ({ ...base, id: `other-${index}` })), { ...base, id: "wanted" }] };
  const mixed = analysisEvidencePage(evidence, { ids: ["wanted", "store-a"], limit: 1 });
  assert.deepEqual(mixed.rootFactIds, ["wanted"]); assert.deepEqual(mixed.facts.map((fact) => fact.id), ["wanted"]); assert.equal(mixed.paging.totalFacts, 1); assert.equal(mixed.objects[0].id, "store-a");
  assert.equal(analysisEvidencePage(evidence, { ids: ["store-a"], limit: 1 }).paging.totalFacts, 101);
});

test("根摘要给出原图中的真实配对导航，不把未配对原值升级为比较", () => {
  const base = { frameId: "frame", label: "指标", unit: "CNY/克", definition: "实际定义", objectIds: [], operationId: "scan", limitations: [], comparisonRole: "standardized" as const, comparisonControls: ["category" as const, "material" as const] };
  const evidence = { frames: [], objects: [], methods: [], facts: [
    { ...base, id: "target", metricId: "gap_per_gram.standardized_target", value: 12, comparisonKey: "paired", objectIds: ["store-a"] },
    { ...base, id: "reference", metricId: "gap_per_gram.standardized_reference", value: 20, comparisonKey: "paired" },
    { ...base, id: "delta", metricId: "gap_per_gram.standardized_delta", value: -8, comparisonKey: "paired", derivation: { op: "subtract" as const, args: [{ factId: "target" }, { factId: "reference" }] } },
    { ...base, id: "relative", metricId: "gap_per_gram.relative_deviation", value: 60, unit: "%", derivation: { op: "multiply" as const, args: [{ constant: 100 }, { op: "divide" as const, args: [{ factId: "target" }, { factId: "reference" }] }] } },
    { ...base, id: "raw", metricId: "gap_per_gram", value: 30, comparisonRole: "within_stratum" as const, derivation: { op: "divide" as const, args: [{ constant: 30 }, { constant: 1 }] } },
    { ...base, id: "wrong-operation", metricId: "gap_per_gram.standardized_target", value: 999, operationId: "other", comparisonKey: "paired" },
  ] };
  const page = analysisEvidencePage(evidence, { ids: ["relative"], includeParents: false });
  assert.deepEqual(page.rootFactIds, ["relative"]); assert.equal(page.facts.length, 1);
  assert.equal(page.comparisonLinks.entries.length, 1); assert.equal(page.comparisonLinks.entries[0].operationId, "scan");
  assert.deepEqual(page.comparisonLinks.entries[0].members.map((fact) => [fact.id, fact.value]), [["target", 12], ["reference", 20], ["delta", -8]]);
  assert.deepEqual(analysisEvidencePage(evidence, { ids: ["raw"], includeParents: false }).comparisonLinks.entries, []);
});

test("有界配对导航的未交付端点是新进展，重复同一配对不延长运行", () => {
  const base = { frameId: "frame", unit: "CNY", label: "实际配对", definition: "真实定义", objectIds: [], operationId: "scan", limitations: [], comparisonRole: "standardized" as const, comparisonControls: [] };
  const evidence = { frames: [], objects: [], methods: [], facts: Array.from({ length: 24 }, (_, n) => [
    { ...base, id: `target-${n}`, metricId: "amount.standardized_target", value: n, comparisonKey: `pair-${n}` },
    { ...base, id: `reference-${n}`, metricId: "amount.standardized_reference", value: 30, comparisonKey: `pair-${n}` },
    { ...base, id: `delta-${n}`, metricId: "amount.standardized_delta", value: n - 30, comparisonKey: `pair-${n}` },
    { ...base, id: `relative-${n}`, metricId: "amount.relative_deviation", value: n / 30, derivation: { op: "divide" as const, args: [{ factId: `target-${n}` }, { factId: `reference-${n}` }] } },
  ]).flat() };
  const roots = Array.from({ length: 24 }, (_, n) => `relative-${n}`); const delivery = createEvidenceDelivery();
  const first = analysisEvidencePage(evidence, { ids: roots, includeParents: false });
  assert.equal(first.rootFactIds.length, 24); assert.equal(first.comparisonLinks.entries.length, 12); assert.equal(first.comparisonLinks.omittedKeys, 12);
  assert.equal(delivery.record(first, { ids: roots }).changed, true); assert.equal(delivery.record(first, { ids: roots }).changed, false);
  const next = analysisEvidencePage(evidence, { ids: ["relative-12"], includeParents: false });
  assert.equal(delivery.record(next, { ids: ["relative-12"] }).changed, true);
  assert.equal(delivery.record(next, { ids: ["relative-12"] }).changed, false);
});

test("操作引用可定向分页已有证据，显式事实仍优先，未知操作拒绝", () => {
  const base = { frameId: "frame", unit: "CNY", label: "金额", definition: "真实定义", objectIds: [], limitations: [], metricId: "amount" };
  const evidence = { frames: [], objects: [], methods: [], facts: [{ ...base, id: "first", operationId: "op-a", value: 12 }, { ...base, id: "second", operationId: "op-b", value: 24 }] };
  assert.deepEqual(analysisEvidencePage(evidence, { ids: ["op-b"], includeParents: false }).rootFactIds, ["second"]);
  assert.deepEqual(analysisEvidencePage(evidence, { ids: ["op-a", "second"], includeParents: false }).rootFactIds, ["second"]);
  assert.throws(() => analysisEvidencePage(evidence, { ids: ["made-up-operation"] }), /登记引用/);
  const delivery = createEvidenceDelivery(); const page = analysisEvidencePage(evidence, { ids: ["op-b"], includeParents: false, limit: 1 });
  delivery.record(page, { ids: ["op-b"] });
  assert.deepEqual(delivery.state().pages, [{ operationId: "op-b", totalFacts: 1, ranges: [[0, 1]], firstUnreadOffset: null }]);
  const mixed = createEvidenceDelivery(); mixed.record(analysisEvidencePage(evidence, { ids: ["op-a", "second"], includeParents: false }), { ids: ["op-a", "second"] });
  assert.deepEqual(mixed.state().pages, []);
  assert.throws(() => analysisEvidencePage(evidence, { ids: ["op-b"], detailOffset: 0, detailLimit: 1 }), /真实事实引用/);
});

test("证据续窗保留各操作已读事实引用，重开快照后清除旧引用", () => {
  const base = { frameId: "frame", metricId: "amount", label: "模拟金额", value: 100, unit: "CNY", definition: "测试", objectIds: [], limitations: [] };
  const evidence = { frames: [], objects: [], methods: [], facts: [{ ...base, id: "first", operationId: "one" }, { ...base, id: "second", operationId: "two" }] };
  const delivery = createEvidenceDelivery();
  delivery.record(analysisEvidencePage(evidence, { ids: ["first"] }), { ids: ["first"] });
  delivery.record(analysisEvidencePage(evidence, { ids: ["second"] }), { ids: ["second"] });
  assert.deepEqual(new Set(delivery.state().recentFactIds), new Set(["first", "second"]));
  delivery.resetPages(); assert.deepEqual(delivery.state().recentFactIds, []);
});

test("窗口交接保留各操作已读对象的真实编号，不因最近根页裁剪丢失门店身份", () => {
  const base = { frameId: "frame", metricId: "amount", label: "实收", value: 10, unit: "CNY", definition: "真实口径", limitations: [] };
  const evidence = { frames: [], methods: [], objects: [{ id: "old-store", frameId: "frame", dimension: "store" as const, value: "65709", label: "门店65709" }, { id: "recent-category", frameId: "frame", dimension: "category" as const, value: "黄金", label: "黄金" }, { id: "unread-store", frameId: "frame", dimension: "store" as const, value: "99999", label: "未读取门店" }], facts: [{ ...base, id: "old-fact", operationId: "old-operation", objectIds: ["old-store"] }, { ...base, id: "recent-fact", operationId: "recent-operation", objectIds: ["recent-category"] }, { ...base, id: "unread-fact", operationId: "unread-operation", objectIds: ["unread-store"] }] };
  assert.deepEqual(analysisObjectReferences(evidence, ["old-fact", "recent-fact", "made-up-fact"]), evidence.objects.slice(0, 2));
  assert.deepEqual(analysisObjectReferences(evidence, []), []);
});

test("续窗优先保存被选中的候选根事实，长父链不能挤掉候选引用", () => {
  const base = { frameId: "frame", metricId: "amount", label: "模拟金额", value: 100, unit: "CNY", definition: "测试", objectIds: [], operationId: "operation", limitations: [] };
  const parents = Array.from({ length: 30 }, (_, index) => ({ ...base, id: `parent-${index}` }));
  const candidate = { ...base, id: "candidate", derivation: { op: "add" as const, args: parents.map((fact) => ({ factId: fact.id })) } };
  const evidence = { frames: [], objects: [], methods: [], facts: [candidate, ...parents] };
  const delivery = createEvidenceDelivery();
  delivery.record(analysisEvidencePage(evidence, { ids: [candidate.id] }), { ids: [candidate.id] });
  assert.deepEqual(delivery.state().recentFactIds, [candidate.id]);
  const resumed = analysisEvidencePage(evidence, { ids: delivery.state().recentFactIds });
  assert.equal(resumed.facts.length, 31); assert.equal(resumed.facts[0].id, candidate.id);
});

test("证据按真实父链大小分页，重复检查只交付摘要且可读取完整检查页", () => {
  const base = { frameId: "frame", metricId: "amount", label: "模拟金额", value: 100, unit: "CNY", definition: "实际指标定义".repeat(30), objectIds: [], operationId: "operation", limitations: [] };
  const parents = Array.from({ length: 70 }, (_, group) => Array.from({ length: 30 }, (_, index) => ({ ...base, id: `parent-${group}-${index}` })));
  const roots = parents.map((facts, index) => ({ ...base, id: `root-${index}`, derivation: { op: "add" as const, args: facts.map((fact) => ({ factId: fact.id })) } }));
  const checks = Array.from({ length: 10000 }, (_, index) => ({ name: "共同控制分层", status: index === 9999 ? "unavailable" as const : "performed" as const, result: `完整组合交集${index}层` }));
  const method = { id: "method", operationId: "operation", method: "scan" as const, status: "completed" as const, frameIds: [], controls: [], checks, sampleRows: 70, groupCount: 70, limitations: [] };
  const evidence = { frames: [], objects: [], methods: [method], facts: [...roots, ...parents.flat()] };
  const first = analysisEvidencePage(evidence);
  assert.ok(JSON.stringify(first).length < 180000, "单页不应因父链与逐组重复检查膨胀到百万字符");
  assert.ok(first.paging.nextOffset !== null && first.paging.nextOffset < 60);
  assert.ok(first.methods[0].checks.some((check) => check.status === "unavailable"));
  const delivery = createEvidenceDelivery(); delivery.record(first);
  assert.equal(delivery.state().pages[0].firstUnreadOffset, first.paging.nextOffset);
  const delivered = new Set(first.facts.map((fact) => fact.id)); let offset: number | null = first.paging.nextOffset;
  while (offset !== null) { const page = analysisEvidencePage(evidence, { offset }); page.facts.forEach((fact) => delivered.add(fact.id)); offset = page.paging.nextOffset; }
  assert.equal(delivered.size, evidence.facts.length);
  const detail = analysisEvidencePage(evidence, { ids: [method.id], checkOffset: 100, checkLimit: 20 });
  assert.deepEqual(detail.methods[0].checks, checks.slice(100, 120)); assert.equal(detail.checkPaging[0].totalChecks, 10000); assert.equal(detail.checkPaging[0].nextOffset, 120);
  const summary = analysisEvidencePage(evidence, { ids: [roots[0].id], includeParents: false });
  assert.deepEqual(summary.facts.map((fact) => fact.id), [roots[0].id]);
  assert.equal(evidence.methods[0].checks.length, 10000, "交付摘要不能改动完整核验记录");
  assert.equal(analysisEvidencePage(evidence, { ids: [roots[0].id] }).facts.length, 31);
});

test("单个极大父链也按实际大小分批交付，所有父事实仍可按原根引用读完", () => {
  const base = { frameId: "frame", metricId: "amount", label: "模拟金额", value: 100, unit: "CNY", definition: "实际指标定义".repeat(30), objectIds: [], operationId: "operation", limitations: [] };
  const parents = Array.from({ length: 1000 }, (_, index) => ({ ...base, id: `parent-${index}` }));
  const root = { ...base, id: "candidate", derivation: { op: "add" as const, args: parents.map((fact) => ({ factId: fact.id })) } };
  const evidence = { frames: [], objects: [], methods: [], facts: [root, ...parents] };
  const first = analysisEvidencePage(evidence, { ids: [root.id] });
  assert.ok(JSON.stringify(first).length < 65000); assert.equal(first.parentChainsIncluded, false); assert.ok(first.detailPaging?.nextOffset);
  const delivery = createEvidenceDelivery(); delivery.record(first, { ids: [root.id] });
  const read = new Set(first.facts.map((fact) => fact.id)); let next: number | null = first.detailPaging!.nextOffset;
  while (next !== null) {
    const page = analysisEvidencePage(evidence, { ids: [root.id], detailOffset: next, detailLimit: 150 });
    assert.ok(JSON.stringify(page).length < 65000); page.facts.forEach((fact) => read.add(fact.id));
    delivery.record(page, { ids: [root.id] }); next = page.detailPaging!.nextOffset;
  }
  assert.equal(read.size, 1001); assert.deepEqual(delivery.state().recentFactIds, [root.id]);
  assert.equal(root.derivation.args.length, 1000, "传输投影不修改代码持有的完整派生关系");
});

test("已计算目录列出完整指标、分组与真实范围，分页不丢失可复用操作信息", async () => {
  const session = await createSnapshotAnalysisProvider(dataset).open();
  try {
    const calculated = await createAnalysisOperations(session, { filters: {} }).execute({ needIds: ["need-1"], purpose: "核对门店金额与件数", method: "aggregate", scope: { period: report.query.period, population: "sales", filters: {} }, metrics: ["amount", "quantity"], by: ["store"] });
    const page = analysisEvidencePage(calculated, { limit: 1 });
    assert.equal(page.facts.length, 1);
    const item = page.directory[0];
    assert.deepEqual(item.metrics, ["amount", "quantity"]);
    assert.deepEqual(item.dimensions, ["store"]);
    assert.deepEqual(item.frames, [{ id: calculated.frames[0].id, scope: { period: report.query.period, population: "sales", filters: {} }, currency: dataset.currency, grain: "group" }]);
  } finally { await session.close(); }
});

test("内部代码异常立即终止回合与后续查询，不伪装成可重试分析或业务缺口", async (t) => {
  let windows = 0; let reads = 0;
  const config = runtime(t);
  const base = createSnapshotAnalysisProvider(dataset);
  const provider = { open: async (signal?: AbortSignal) => {
    const session = await base.open(signal);
    return { ...session, async aggregate() { reads++; throw new RangeError("Maximum call stack size exceeded"); } };
  } };
  const query: AgentQuery = async function* ({ options }) {
    windows++; const client = await connect(options);
    try {
      yield* load(windows > 1 ? [skills[1]] : []); await call(client, "inspect_dataset");
      const planned = await call(client, "plan_analysis", { mode: "analysis", needs: [{ userQuote: request.question, judgement: "核对销售变化" }], assumptions: [] });
      yield* load([skills[1]]);
      const args = { needIds: [planned.value.task.needs[0].id], purpose: "核对销售", method: "aggregate", scope: { period: report.query.period, population: "sales", filters: {} }, metrics: ["amount"] };
      await Promise.all([client.callTool({ name: "analyze_history", arguments: args }), client.callTool({ name: "analyze_history", arguments: { ...args, by: ["store"] } })]);
      yield result("error_max_turns");
    }
    finally { await client.close(); }
  };
  await assert.rejects(createGeneralAnalyticsRunner(config, { query, provider })(request), { name: "RangeError", message: "Maximum call stack size exceeded" });
  assert.equal(windows, 1);
  assert.equal(reads, 1);
  const records = readdirSync(config.auditDirectory).flatMap((name) => readFileSync(join(config.auditDirectory, name), "utf8").trim().split("\n").map((line) => JSON.parse(line)));
  const failure = records.find((record) => record.kind === "validation_error");
  assert.equal(failure.value.errorKind, "internal_error");
  assert.equal(failure.value.repairable, false);
});

test("同一句原话承载多个事项时重规划保留不同身份，日期调整继承原货类筛选", async (t) => {
  const question = "分析销售变化以及应对方向，先保持黄金筛选";
  const query: AgentQuery = async function* ({ options, prompt }) {
    const client = await connect(options);
    try {
      yield* load(); if (prompt.toString().includes("窗口续接")) yield* load([skills[1]]);
      const needs = [{ userQuote: question, judgement: "解释经营变化" }, { userQuote: question, judgement: "确定应对方向" }];
      const first = await call(client, "plan_analysis", { mode: "analysis", needs, assumptions: [] });
      yield* load([skills[1]]);
      assert.equal(new Set(first.value.task.needs.map((item: { id: string }) => item.id)).size, 2);
      const corrected = await call(client, "plan_analysis", { mode: "analysis", needs: [{ ...needs[1], judgement: "给出试验方向" }, needs[0]], hardScope: { period: report.query.period, filters: {} }, scopeQuotes: [question], assumptions: [] });
      assert.notEqual(corrected.response.isError, true);
      assert.deepEqual(corrected.value.task.hardScope.filters.categories, ["黄金"]);
      assert.equal(corrected.value.task.needs[1].id, first.value.task.needs[0].id);
      assert.equal(new Set(corrected.value.task.needs.map((item: { id: string }) => item.id)).size, 2);
      const denied = await call(client, "plan_analysis", { mode: "analysis", needs, removeFilters: ["categories"], assumptions: [] });
      assert.equal(denied.response.isError, true); assert.match(denied.value.error, /原话/);
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })({ ...request, question, report: { ...report, query: { ...report.query, filters: { categories: ["黄金"] } } } });
  assert.ok("schema" in answer); assert.equal(answer.status, "incomplete");
  assert.deepEqual(answer.task.hardScope.filters.categories, ["黄金"]);
});

test("任务语义可从查数纠正为解释分析，新方法必须等真实顾问Skill加载", async (t) => {
  const question = "实收怎么变了";
  const query: AgentQuery = async function* ({ options, prompt }) {
    const client = await connect(options);
    try {
      yield* load(); if (prompt.toString().includes("窗口续接")) yield* load([skills[1]]);
      const needs = [{ userQuote: question, judgement: "判断经营变动" }];
      const lookup = await call(client, "plan_analysis", { mode: "lookup", needs, assumptions: [] });
      const args = { method: "scan", needIds: [lookup.value.task.needs[0].id], purpose: "查不同走势", scope: { period: report.query.period, population: "net", filters: {} }, metrics: ["amount"], breakdown: "store" };
      const refused = await call(client, "analyze_history", args); assert.equal(refused.response.isError, true); assert.match(refused.value.error, /查数/);
      await call(client, "plan_analysis", { mode: "analysis", needs, assumptions: [] });
      if (!prompt.toString().includes("窗口续接")) { const gated = await call(client, "analyze_history", args); assert.equal(gated.response.isError, true); assert.match(gated.value.error, /Skill/); }
      yield* load([skills[1]]);
      assert.notEqual((await call(client, "analyze_history", args)).response.isError, true);
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })({ ...request, question });
  assert.ok("schema" in answer); assert.equal(answer.task.mode, "analysis");
});

test("独立复核挂起可立即取消，原始SDK错误细节保留且密钥不出现在错误中", async (t) => {
  const controller = new AbortController(); let entered = () => {}; const ready = new Promise<void>((resolve) => { entered = resolve; });
  const query: AgentQuery = ({ options }) => options!.systemPrompt!.toString().includes("独立复核员") ? { [Symbol.asyncIterator]: () => ({ next: () => { entered(); return new Promise(() => {}); }, return: () => new Promise(() => {}) }) } : (async function* () {
    const client = await connect(options);
    try { yield* load(); const data = yield* prepare(client); await call(client, "submit_analysis", { draft: draft(data.id, data.data) }); yield result(); }
    finally { await client.close(); }
  })();
  const pending = createGeneralAnalyticsRunner(runtime(t), { query })(request, controller.signal);
  await ready; controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  const config = runtime(t); config.apiKey = "private-test-key";
  const failing: AgentQuery = async function* () { yield* load(); yield { ...result("error_during_execution"), errors: ["供应商认证拒绝 private-test-key"] } as SDKMessage; };
  await assert.rejects(createGeneralAnalyticsRunner(config, { query: failing })(request), (error: Error) => error.message.includes("供应商认证拒绝") && !error.message.includes(config.apiKey));
});

test("独立复核的逻辑窗口用尽后保留逐结论读取进展，续窗提交不会被总轮数截断", async (t) => {
  let reviewWindows = 0;
  const claims = new Map<string, { claimId: string; status: "supported"; reason: string }>();
  const ids = Array.from({ length: 12 }, (_, index) => `conclusion-${index}`);
  const query: AgentQuery = async function* ({ options, prompt }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) {
        reviewWindows++;
        if (reviewWindows === 1) {
          for (const conclusionId of ids) {
            const read = await call(client, "read_review_support", { conclusionId });
            assert.notEqual(read.response.isError, true);
            read.value.claims.forEach((claim: { id: string }) => claims.set(claim.id, { claimId: claim.id, status: "supported", reason: "已核对该项实际公开内容" }));
          }
          yield result("error_max_turns"); return;
        }
        assert.match(prompt.toString(), /复核窗口续接/);
        assert.ok(prompt.toString().includes(ids.at(-1)!));
        const check = { status: "supported", reason: "实际范围、数量关系、能力与解释均已核对" };
        assert.notEqual((await call(client, "submit_review", { verdict: "accept", issues: [], checks: ids.map((conclusionId) => ({ conclusionId, scope: check, quantitativeMeaning: check, capability: check, interpretation: check })), claimChecks: [...claims.values()] })).response.isError, true);
      } else {
        yield* load(); const prepared = yield* prepare(client); const value = draft(prepared.id, prepared.data);
        value.conclusions = ids.map((id) => ({ ...value.conclusions[0], id }));
        value.blocks = ids.map((conclusionId) => ({ ...value.blocks[0], conclusionId }));
        assert.equal((await call(client, "submit_analysis", { draft: value })).value.accepted, true);
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "answered"); assert.equal(reviewWindows, 2);
});

test("大结果的新证据分页可持续续窗，游标跨窗保留且只执行一次汇总", async (t) => {
  let windows = 0; let aggregates = 0; let outcome: AnalysisOperationResult; let needId = ""; let latestReadId: string | undefined;
  const delivered = new Set<string>();
  const base = createSnapshotAnalysisProvider(dataset);
  const provider = { open: async (signal?: AbortSignal) => {
    const session = await base.open(signal);
    return { ...session, aggregate: async () => { aggregates++; return Array.from({ length: 3000 }, (_, index) => ({ dimensions: { store: `模拟门店${index}` }, rows: 1, amount: 100, quantity: 1, grams: 1, profit: null, orders: 1, stores: 1, tag_amount: null })); } };
  } };
  const query: AgentQuery = async function* ({ options, prompt }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) await submitReview(client, { verdict: "accept", issues: [] });
      else {
        windows++; yield* load();
        if (windows === 1) {
          await call(client, "inspect_dataset");
          const plan = await call(client, "plan_analysis", { mode: "lookup", needs: [{ userQuote: request.question, judgement: "核对完整门店范围" }], assumptions: [] }); needId = plan.value.task.needs[0].id;
          const value = await call(client, "analyze_history", { needIds: [needId], purpose: "完整门店范围核对", method: "aggregate", scope: { period: report.query.period, population: "net", filters: {} }, by: ["store"], metrics: ["amount"] }); outcome = value.value; outcome.facts.forEach((fact) => delivered.add(fact.id));
        }
        const state = await call(client, "read_analysis_state");
        const cursor = state.value.delivery.pages.find((page: { operationId: string }) => page.operationId === outcome!.operationId);
        assert.ok(cursor); if (windows > 1) { assert.match(prompt.toString(), /firstUnreadOffset/); assert.ok(cursor.firstUnreadOffset >= delivered.size); assert.ok(state.value.recentEvidence.facts.some((fact: { id: string }) => fact.id === latestReadId)); assert.ok(prompt.toString().includes(latestReadId!)); }
        let offset = cursor.firstUnreadOffset;
        for (let count = 0; count < (windows === 1 ? 7 : 10) && offset !== null; count++) {
          const page = await call(client, "read_analysis_evidence", { operationId: outcome!.operationId, offset });
          latestReadId = page.value.facts.at(-1)?.id;
          page.value.facts.forEach((fact: { id: string }) => delivered.add(fact.id)); offset = page.value.paging.nextOffset;
        }
        if (offset === null) assert.equal((await call(client, "submit_analysis", { draft: draft(needId, outcome!) })).value.accepted, true);
        else { yield result("error_max_turns"); return; }
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query, provider })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "answered"); assert.equal(delivered.size, 3000); assert.equal(aggregates, 1); assert.ok(windows > 3);
});

test("分页交付的语义进展不受重编号重连影响，重叠页保留最早未读游标", async () => {
  const session = await createSnapshotAnalysisProvider(dataset).open();
  const operations = (await import("../app/lib/analytics/analysis-v2-operations.ts")).createAnalysisOperations(session, { filters: {} });
  const data = structuredClone(await operations.execute({ method: "aggregate", needIds: ["need"], purpose: "分页检查", scope: { period: report.query.period, population: "net", filters: {} }, metrics: ["amount"], by: ["store"] }));
  data.frames.forEach((frame) => { frame.mode = "database"; frame.datasetVersion = "mysql-version-first-nonce"; });
  const tracker = createEvidenceDelivery(); const first = analysisEvidencePage(data, { operationId: data.operationId, limit: 1 });
  assert.equal(tracker.record(first, { operationId: data.operationId }).changed, true);
  assert.equal(tracker.record(first, { operationId: data.operationId }).changed, false);
  const renamed = structuredClone(first); const ids = new Map([...renamed.facts, ...renamed.objects, ...renamed.frames, ...renamed.methods].map((item) => [item.id, `new-${item.id}`]));
  renamed.frames.forEach((frame) => { frame.id = ids.get(frame.id)!; frame.snapshotId = "reopened"; frame.datasetVersion = "mysql-version-second-nonce"; });
  renamed.objects.forEach((object) => { object.id = ids.get(object.id)!; object.frameId = ids.get(object.frameId)!; });
  renamed.facts.forEach((fact) => { fact.id = ids.get(fact.id)!; fact.frameId = ids.get(fact.frameId)!; fact.operationId = "new-operation"; fact.objectIds = fact.objectIds.map((id) => ids.get(id)!); });
  renamed.rootFactIds = renamed.rootFactIds.map((id) => ids.get(id)!);
  renamed.methods.forEach((method) => { method.id = ids.get(method.id)!; method.operationId = "new-operation"; method.frameIds = method.frameIds.map((id) => ids.get(id)!); });
  tracker.resetPages(); assert.equal(tracker.record(renamed, { operationId: "new-operation" }).changed, false);
  assert.equal(tracker.state().pages[0].firstUnreadOffset, 1);
  tracker.record(analysisEvidencePage(data, { operationId: data.operationId, offset: 2, limit: 1 }), { operationId: data.operationId });
  tracker.record(first, { operationId: data.operationId });
  assert.equal(tracker.state().pages.find((page) => page.operationId === data.operationId)!.firstUnreadOffset, 1);
  await session.close();
});

test("SDK success但is_error为真时保留原供应商错误，不误报Skill未加载", async (t) => {
  const config = runtime(t); config.apiKey = "private-test-key";
  const query: AgentQuery = async function* () { yield { ...result(), is_error: true, result: "API Error: 并发资源已满 private-test-key" } as SDKMessage; };
  await assert.rejects(createGeneralAnalyticsRunner(config, { query })(request), (error: Error) => error.message.includes("并发资源已满") && !error.message.includes("Skill") && !error.message.includes(config.apiKey));
});

test("可修请求条件跨窗保留repairable及警告，修正后继续且不登记为数据能力缺口", async (t) => {
  let attempts = 0; let windows = 0; let id = "";
  const base = createSnapshotAnalysisProvider(dataset);
  const provider = { open: async (signal?: AbortSignal) => {
    const session = await base.open(signal);
    return { ...session, aggregate: async (input: Parameters<typeof session.aggregate>[0], querySignal?: AbortSignal) => {
      if (++attempts === 1) throw Object.assign(new Error("分析请求条件缺少可执行参数，请补全后重试"), { code: "ANALYSIS_ARGUMENTS_INVALID" });
      return session.aggregate(input, querySignal);
    } };
  } };
  const query: AgentQuery = async function* ({ options, prompt }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) await submitReview(client, { verdict: "accept", issues: [] });
      else {
        windows++; yield* load();
        if (windows === 1) {
          await call(client, "inspect_dataset");
          const planned = await call(client, "plan_analysis", { mode: "analysis", needs: [{ userQuote: request.question, judgement: "核对经营实收" }], assumptions: [] }); id = planned.value.task.needs[0].id;
        }
        yield* load([skills[1]]);
        const input = { method: "aggregate", needIds: [id], purpose: "核对实收", scope: { period: report.query.period, population: "net", filters: {} }, metrics: ["amount"] };
        if (windows === 1) {
          const invalid = await call(client, "analyze_history", input);
          assert.equal(invalid.response.isError, true); assert.equal(invalid.value.repairable, true); assert.equal(invalid.value.errorKind, "invalid_arguments");
          const before = await call(client, "read_analysis_state"); assert.equal(before.value.evidence.methods.length, 0);
          assert.ok(before.value.issues.some((issue: { requirement: string }) => issue.requirement.includes("补全")));
          yield result("error_max_turns"); return;
        }
        assert.match(prompt.toString(), /本次调用未执行/);
        const good = await call(client, "analyze_history", input); assert.notEqual(good.response.isError, true);
        const after = await call(client, "read_analysis_state"); assert.ok(!after.value.issues.some((issue: { requirement: string }) => issue.requirement.includes("补全")));
        assert.equal((await call(client, "submit_analysis", { draft: draft(id, good.value) })).value.accepted, true);
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query, provider })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "answered"); assert.equal(windows, 2);
  assert.ok(answer.trace?.steps.some((step) => step.tool === "analyze_history" && step.status === "warning"));
  assert.ok(!answer.evidence.methods.some((method) => method.status === "unsupported"));
});

test("只按活动总额选方案被退回后，能真实补同店货类对照并按可比方向修订", async (t) => {
  const benchmark = analyticsBenchmarks.find((item) => item.id === "strategy")!;
  const scopedPeriod = { start: benchmark.dataset.minDate, end: benchmark.dataset.maxDate };
  const scopedReport = { ...runAnalysis(benchmark.dataset, { period: scopedPeriod, filters: {} }), id: "strategy-repair", createdAt: "2026-10-14" };
  let reviews = 0; let comparisons = 0;
  const query: AgentQuery = async function* ({ options, prompt }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) {
        reviews++; const support = await call(client, "read_review_support", { conclusionId: "judgement" });
        assert.ok(support.value.capabilities.metrics.some((metric: { id: string }) => metric.id === "amount_per_order"));
        const check = { status: "supported", reason: "已核对范围及声明能力" };
        const first = reviews === 1;
        const issue = { kind: "missing_evidence", needIds: ["need-1"], conclusionIds: ["judgement"], requirement: "整体活动金额受门店参与结构影响；现有订单、门店、货类能力可做同期受控比较，请补算并按可比指标给试验方向" };
        if (!first) assert.match(prompt.toString(), /within_stratum/);
        assert.notEqual((await call(client, "submit_review", { verdict: first ? "revise" : "accept", issues: first ? [issue] : [], checks: [{ conclusionId: "judgement", scope: check, capability: check, quantitativeMeaning: first ? { status: "revise", reason: "金额份额不能代替同店比较" } : check, interpretation: check }], claimChecks: support.value.claims.map((claim: { id: string }) => ({ claimId: claim.id, status: "supported", reason: "已核对对应公开内容" })) })).response.isError, true);
      } else {
        yield* load(); await call(client, "inspect_dataset");
        const plan = await call(client, "plan_analysis", { mode: "analysis", needs: [{ userQuote: benchmark.question, judgement: "比较活动并给出试验方向" }], assumptions: [] });
        yield* load([skills[1]]); const id = plan.value.task.needs[0].id;
        const raw = await call(client, "analyze_history", { method: "aggregate", needIds: [id], purpose: "先核对活动总体金额", scope: { period: scopedPeriod, population: "sales", filters: {} }, metrics: ["amount"], by: ["offer"] });
        const initial = draft(id, raw.value); initial.conclusions[0].level = "hypothesis";
        initial.conclusions[0].judgement = "先按观察金额规模选择活动方向";
        const returned = await call(client, "submit_analysis", { draft: initial }); assert.equal(returned.value.accepted, false); assert.equal(returned.value.issues[0].kind, "missing_evidence");
        const compared = await call(client, "analyze_history", { method: "compare", needIds: [id], purpose: "核对相同观察门店和货类内成交部分均额", scope: { period: scopedPeriod, population: "sales", filters: { offers: ["模拟活动乙"] } }, reference: { period: scopedPeriod, population: "sales", filters: { offers: ["模拟活动甲"] } }, metrics: ["amount_per_order"], by: ["store"], controls: ["store", "category"], commonStores: true });
        assert.notEqual(compared.response.isError, true); comparisons++;
        const comparisonEvidence = await call(client, "read_analysis_evidence", { operationId: compared.value.operationId, limit: 150, includeParents: false });
        const differences = (comparisonEvidence.value as AnalysisOperationResult).facts.filter((fact) => fact.metricId === "amount_per_order.delta" && fact.comparisonRole === "within_stratum");
        assert.deepEqual(differences.map((fact) => fact.value).sort((a, b) => a! - b!), [20, 20, 180]);
        const corrected = draft(id, compared.value);
        corrected.conclusions[0] = { ...corrected.conclusions[0], level: "comparison_supported", judgement: "目标方案在相同观察门店和货类内的成交部分均额更高，适合优先做可比试验", factIds: differences.map((fact) => fact.id), limitations: ["缺曝光、客流与随机分配证据，观察差异不能证明活动因果或未来规模收益"], action: "以相同门店货类做对照试验，再决定是否扩大", validation: "同时检查成交部分均额、订单数与参与结构，保留因果限制" };
        corrected.blocks[0].nodes = [{ kind: "text", text: "相同门店货类的成交部分均额差为" }, ...differences.map((fact) => ({ kind: "fact_ref" as const, factId: fact.id })), { kind: "text", text: "，据此优先做可比试验，不用总体金额替代方案效果。" }];
        assert.equal((await call(client, "submit_analysis", { draft: corrected })).value.accepted, true);
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })({ dataset: benchmark.dataset, report: scopedReport, question: benchmark.question });
  assert.ok("schema" in answer); assert.equal(answer.status, "answered"); assert.equal(reviews, 2); assert.equal(comparisons, 1);
  assert.ok(answer.evidence.methods.some((method) => method.method === "compare" && method.status === "completed"));
});

test("逐结论通过不能覆盖漏审正文和可计算追问，具体来源退回后改写再交付", async (t) => {
  let reviews = 0;
  const query: AgentQuery = async function* ({ options }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) {
        reviews++;
        const support = (await call(client, "read_review_support", { conclusionId: "judgement" })).value;
        const check = { status: "supported", reason: "核心金额、范围与已执行方法正确" };
        const checks = [{ conclusionId: "judgement", scope: check, quantitativeMeaning: check, capability: check, interpretation: check }];
        const claimChecks = support.claims.map((claim: { id: string; text: string; kind: string }) => ({ claimId: claim.id, status: reviews === 1 && (claim.text.includes("已排除客流") || claim.kind === "question") ? "revise" : "supported", reason: claim.text.includes("已排除客流") ? "没有客流测量，不能由成交金额排除客流" : claim.kind === "question" ? "已有订单工具可以继续检查历史大单，不应直接要求用户代算" : "已核对本条真实范围与依据" }));
        if (reviews === 1) {
          const omitted = await call(client, "submit_review", { verdict: "accept", issues: [], checks, claimChecks: claimChecks.slice(0, -1) });
          assert.equal(omitted.response.isError, true); assert.match(omitted.value.error, /完整|遗漏/);
          const skipped = await call(client, "submit_review", { verdict: "accept", issues: [], checks, claimChecks });
          assert.equal(skipped.response.isError, true); assert.match(skipped.value.error, /任一正文/);
          const issue = { kind: "unsupported_explanation", needIds: ["need-1"], conclusionIds: ["judgement"], requirement: "核心金额成立，但正文没有测量客流，不能断言排除；现有工具可完成的历史判断继续核查，不让用户代算" };
          assert.notEqual((await call(client, "submit_review", { verdict: "revise", issues: [issue], checks, claimChecks })).response.isError, true);
        } else assert.notEqual((await call(client, "submit_review", { verdict: "accept", issues: [], checks, claimChecks })).response.isError, true);
      } else {
        yield* load(); const { id, data } = yield* prepare(client);
        const value = draft(id, data);
        value.blocks[0].nodes.push({ kind: "text", text: "已排除客流。" });
        value.questions = ["请确认历史增长是否由大单带动？"];
        const first = await call(client, "submit_analysis", { draft: value });
        assert.equal(first.value.accepted, false); assert.equal(first.value.issues[0].kind, "unsupported_explanation");
        value.blocks[0].nodes.pop(); value.blocks[0].nodes.push({ kind: "text", text: "没有客流测量，机制尚未验证。" }); value.questions = [];
        assert.equal((await call(client, "submit_analysis", { draft: value })).value.accepted, true);
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "answered"); assert.equal(reviews, 2);
  assert.ok(answer.blocks.some((block) => block.nodes.some((node) => node.kind === "text" && node.text.includes("机制尚未验证"))));
});

test("无结论的未完成草稿可审阅全局来源，重复无进展保留incomplete而非抛复核运行错误", async (t) => {
  let reviews = 0;
  const query: AgentQuery = async function* ({ options, prompt }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) {
        reviews++; assert.match(prompt.toString(), /实际待发布内容目录/);
        const support = await call(client, "read_review_support", { scope: "global" });
        assert.notEqual(support.response.isError, true); assert.ok(support.value.claims.length);
        assert.ok(support.value.claims.every((claim: { needIds: string[] }) => claim.needIds.includes("need-1")));
        const issue = { kind: "missing_evidence", needIds: ["need-1"], conclusionIds: [], requirement: "必要判断还可以继续取证，当前诚实保留未完成" };
        assert.notEqual((await call(client, "submit_review", { verdict: "revise", issues: [issue], checks: [], claimChecks: support.value.claims.map((claim: { id: string }) => ({ claimId: claim.id, status: "revise", reason: "该项必要分析尚未执行" })) })).response.isError, true);
      } else {
        yield* load(); yield* prepare(client);
        const value: AnalysisDraft = { status: "incomplete", conclusions: [], blocks: [{ kind: "paragraph", nodes: [{ kind: "text", text: "必要分组分析尚未完成" }] }], questions: [], trialParameters: [], userConditions: [] };
        for (let index = 0; index < 3; index++) assert.equal((await call(client, "submit_analysis", { draft: value })).value.accepted, false);
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "incomplete"); assert.equal(reviews, 2);
  assert.equal(answer.task.needs[0].status, "open"); assert.ok(answer.evidence.facts.length);
});

test("空hardScope不要求编造原话，真实范围错误可修正且过程不标整步失败", async (t) => {
  const query: AgentQuery = async function* ({ options }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) await submitReview(client, { verdict: "accept", issues: [] });
      else {
        yield* load(); await call(client, "inspect_dataset");
        const args = { mode: "analysis", needs: [{ userQuote: request.question, judgement: "分析销售变化" }], assumptions: [], hardScope: { filters: {} } };
        const initial = await call(client, "plan_analysis", args); assert.notEqual(initial.response.isError, true, "空对象没有增加硬范围限制");
        yield* load([skills[1]]);
        const invalid = await call(client, "plan_analysis", { ...args, hardScope: { filters: { stores: ["未知门店"] } } });
        assert.equal(invalid.value.errorKind, "invalid_arguments"); assert.equal(invalid.value.repairable, true);
        const corrected = await call(client, "plan_analysis", args); assert.notEqual(corrected.response.isError, true);
        const id = corrected.value.task.needs[0].id;
        const data = await call(client, "analyze_history", { needIds: [id], purpose: "核对整体销售", method: "aggregate", scope: { period: report.query.period, population: "sales", filters: {} }, metrics: ["amount"] });
        assert.equal((await call(client, "submit_analysis", { draft: draft(id, data.value) })).value.accepted, true);
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "answered");
  const steps = answer.trace!.steps.filter((step) => step.tool === "plan_analysis");
  assert.ok(steps.some((step) => step.status === "warning")); assert.ok(!steps.some((step) => step.status === "failed"));
  assert.deepEqual(answer.task.hardScope.filters, {});
});

test("并发工具的一次旧快照失效只重开一次，后续操作使用新快照而非误计连续失败", async (t) => {
  const snapshot = createSnapshotAnalysisProvider(dataset); let opens = 0; let firstReads = 0; const releases: Array<() => void> = []; let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const provider = { async open(signal?: AbortSignal) {
    opens++; const original = await snapshot.open(signal); const first = opens === 1;
    return { ...original, async aggregate(input: Parameters<typeof original.aggregate>[0], querySignal?: AbortSignal) {
      if (first) { firstReads++; entered(); await new Promise<void>((resolve) => { releases.push(resolve); }); await original.close(); throw Object.assign(new Error("数据库查询资源截止"), { code: "ANALYSIS_SESSION_EXPIRED" }); }
      return original.aggregate(input, querySignal);
    } };
  } };
  const query: AgentQuery = async function* ({ options }) {
    const client = await connect(options);
    try {
      if (options!.systemPrompt!.toString().includes("独立复核员")) await submitReview(client, { verdict: "accept", issues: [] });
      else {
        yield* load(); await call(client, "inspect_dataset");
        const planned = await call(client, "plan_analysis", { mode: "analysis", needs: [{ userQuote: request.question, judgement: "核对当前销售" }], assumptions: [] });
        const id = planned.value.task.needs[0].id; yield* load([skills[1]]);
        const args = { needIds: [id], purpose: "核对销售分组", method: "aggregate", scope: { period: report.query.period, population: "sales", filters: {} }, metrics: ["amount"] };
        const execute = async (arguments_: Record<string, unknown>) => {
          const response = await client.callTool({ name: "analyze_history", arguments: arguments_ });
          const text = (response.content as Array<{ text: string }>)[0].text;
          let value; try { value = JSON.parse(text); } catch { value = { error: text }; }
          return { response, value };
        };
        const a = execute(args); await started;
        const b = execute({ ...args, by: ["store"] });
        const c = execute({ ...args, by: ["category"] });
        await new Promise((resolve) => setImmediate(resolve)); releases.forEach((release) => release());
        const outcomes = await Promise.all([a, b, c]);
        assert.equal(outcomes[0].response.isError, true); assert.notEqual(outcomes[1].response.isError, true); assert.notEqual(outcomes[2].response.isError, true);
        assert.equal(firstReads, 1); assert.equal(opens, 2);
        const state = await call(client, "read_analysis_state"); assert.equal(new Set(state.value.evidence.frames.map((frame: { snapshotId: string }) => frame.snapshotId)).size, 1);
        assert.equal((await call(client, "submit_analysis", { draft: draft(id, outcomes[1].value) })).value.accepted, true);
      }
      yield result();
    } finally { await client.close(); }
  };
  const answer = await createGeneralAnalyticsRunner(runtime(t), { query, provider })(request);
  assert.ok("schema" in answer); assert.equal(answer.status, "answered"); assert.equal(opens, 2);
});
