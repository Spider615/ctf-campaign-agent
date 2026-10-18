import { appendFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentQuery, AgentRuntimeConfig } from "./run-turn.ts";
import { createAnalyticsRunner } from "./analytics-run-turn.ts";
import { analyticsSdkModel } from "./analytics-model.ts";
import { buildPlanSystemPrompt } from "./analytics-system-prompt.ts";
import type { AnalyticsDatabase, DatabaseExplainRequest } from "../app/lib/analytics/database.ts";
import { quickAnalyticsReply, quickMonthlySalesQuery } from "../app/lib/analytics/dialogue.ts";
import type { AnalyticsExplainRequest, AnalyticsExplainResult } from "../app/lib/analytics/types.ts";
import type { AnalysisCapabilities, AnalysisConstraints, AnalysisDataProvider, AnalysisDataSession, AnalysisFact, PlanAnswer } from "../app/lib/analytics/analysis-v2-types.ts";
import { createEvidenceRegistry } from "../app/lib/analytics/analysis-v2-evidence.ts";
import { createSnapshotAnalysisProvider } from "../app/lib/analytics/analysis-v2-snapshot.ts";
import { parsePlan, validatePlan } from "../app/lib/analytics/plan/validate.ts";
import { executePlan, type NodeRole, type NodeRow, type PlanExecution } from "../app/lib/analytics/plan/execute.ts";
import { bindClaims, displayUnit, type Binding, type BoundClaim, type Claim, type ClaimDraft } from "../app/lib/analytics/plan/bind.ts";
import { assemblePlanAnswer, summarize, validatePlanAnswer } from "../app/lib/analytics/plan/answer.ts";
import { DEFAULT_MIN_ROWS, type PlanNode } from "../app/lib/analytics/plan/types.ts";
import { capabilityBrief, claimsPrompt, planPrompt, reviewPrompt, type PreviousPlan } from "../app/lib/analytics/plan/prompt.ts";
import { PLAN_ANALYTICS_TOOL_LABELS, type PlanAnalyticsToolName } from "../app/lib/analytics/tool-names.ts";
import type { AnalyticsProgressEvent } from "../app/lib/analytics/stream.ts";
import { relayAbort, throwIfTurnCancelled, TurnCancelledError } from "../app/lib/cancellation.ts";
import { finishTraceEvent, harnessTimingSummary, mergeTraceEvent, startTraceEvent, type AgentTraceEvent, type ToolInitiator } from "../app/lib/tool-trace.ts";

export type PlanAnalyticsRunner = (request: DatabaseExplainRequest | AnalyticsExplainRequest, signal?: AbortSignal, onProgress?: (event: AnalyticsProgressEvent) => void) => Promise<PlanAnswer | AnalyticsExplainResult>;
type Config = AgentRuntimeConfig & { database?: AnalyticsDatabase; auditDirectory?: string };
type Dependencies = { query: AgentQuery; provider?: AnalysisDataProvider };

// 入参只做形状和长度上限（SDK 转换不了 z.record，用 catchall），真实校验交给 parsePlan / validatePlan / bindClaims，错误以结构化问题返回模型。
const looseNode = z.looseObject({ id: z.string().max(40).optional(), op: z.string().max(20).optional() });
const planShape = { plan: z.object({ question: z.string().max(2000).optional(), nodes: z.array(looseNode).max(20) }) };
const reviewShape = { verdict: z.enum(["ok", "revise"]), issues: z.array(z.string().max(500)).max(10) };
// 补充计划单独计数：已执行节点不占补充名额。
const FOLLOWUP_NODES = 8;
const followupShape = { nodes: z.array(looseNode).max(FOLLOWUP_NODES) };
const ROLES = ["value", "target", "reference", "delta", "change", "deviation", "share", "contribution", "check"] as const satisfies readonly NodeRole[];
const claimSchema = z.object({
  node: z.string().max(40), select: z.object({}).catchall(z.string().max(120)).optional(), metric: z.string().max(80),
  role: z.enum(ROLES).optional(), assert: z.enum(["up", "down", "flat", "higher", "lower", "largest", "smallest", "unavailable"]), text: z.string().min(1).max(300),
});
const claimsShape = {
  headline: claimSchema, claims: z.array(claimSchema).max(8),
  actions: z.array(z.object({ text: z.string().min(1).max(300), claim: z.number().int().min(0).max(20) })).max(5),
  cannotConclude: z.array(z.string().max(300)).max(8), questions: z.array(z.string().max(300)).max(5),
};
const wordingShape = {
  edits: z.array(z.object({ index: z.number().int().min(0).max(20), action: z.enum(["drop", "rewrite"]), text: z.string().max(300).optional() })).max(10),
  notes: z.array(z.string().max(300)).max(5),
};
const MAX_PLAN_JSON = 40000;
const textResult = (value: unknown, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: "text" as const, text: JSON.stringify(value) }] });

export function privateAnalysisDirectory(directory: string): string {
  const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  let parent = resolve(directory); const suffix: string[] = [];
  while (!existsSync(parent)) { suffix.unshift(basename(parent)); parent = dirname(parent); }
  const actual = resolve(realpathSync(parent), ...suffix); const path = relative(root, actual);
  if (!path || !path.startsWith(`..${sep}`) && !isAbsolute(path)) throw new Error("分析私有记录必须保存在仓库之外");
  mkdirSync(actual, { recursive: true, mode: 0o700 });
  const finalPath = realpathSync(actual); const finalRelative = relative(root, finalPath);
  if (!finalRelative || !finalRelative.startsWith(`..${sep}`) && !isAbsolute(finalRelative)) throw new Error("分析私有记录必须保存在仓库之外");
  return finalPath;
}

async function waitForTurnWork<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfTurnCancelled(signal); let cancel = () => {};
  try { return await new Promise((resolve, reject) => { cancel = () => reject(new TurnCancelledError()); signal.addEventListener("abort", cancel, { once: true }); work().then(resolve, reject); if (signal.aborted) cancel(); }); }
  finally { signal.removeEventListener("abort", cancel); }
}
const nextMessage = <T>(iterator: AsyncIterator<T>, signal: AbortSignal) => waitForTurnWork(() => Promise.resolve(iterator.next()), signal);

// ---- 结果摘要（给结论步骤）----
function formatFact(fact: AnalysisFact | undefined): string {
  if (!fact || fact.value === null) return "暂无可计算值";
  const value = Number(fact.value.toFixed(Math.abs(fact.value) < 1 ? 6 : 2));
  return `${value}${displayUnit(fact.unit)}`;
}
// 优先总体行，其余分组按差额、变化或偏离的绝对值从大到小，合计不超过上限。
// 结论阶段的数据表：按节点分组，每行给出可直接照抄的引用地址 {node, select, metric, role}。
// 总体行和偏离最大的分组优先，超过上限的分组只给数量。
// 每个节点各取偏离最大的若干分组，保证下钻、扫描的每个节点都出现在摘要里；
// 样本行数低于节点 minRows（默认 200）的分组不列出，避免把小样本写成结论。
const GROUPS_PER_NODE = 8;
export function executionSummary(execution: PlanExecution, capabilities?: AnalysisCapabilities): string {
  const facts = new Map(execution.evidence.facts.map((fact) => [fact.id, fact]));
  type Group = { key: Record<string, string>; rows: NodeRow[]; score: number; sample?: number };
  const lines: string[] = []; const notes: string[] = [];
  const print = (node: string, group: Group) => {
    const select = Object.keys(group.key).length ? `,"select":${JSON.stringify(group.key)}` : "";
    for (const row of group.rows) lines.push(`{"node":"${node}"${select},"metric":"${row.metric}","role":"${row.role}"} = ${formatFact(facts.get(row.factId))}${row.sampleRows !== undefined ? `（样本 ${row.sampleRows} 行）` : ""}`);
  };
  for (const [id, result] of execution.results) {
    if (result.status !== "completed") { notes.push(`- ${id}（${result.node.op}）${result.status === "unsupported" ? "不支持" : "失败"}：${result.message ?? ""}，不能引用`); continue; }
    if (result.node.op === "robust") {
      for (const item of result.robust ?? []) notes.push(`- ${id} 检查 ${result.node.of} 的 ${item.metric}（${item.check}）：${item.kept === null ? "无法判断" : item.kept ? "方向保持" : "方向翻转"}（${item.detail}）。只影响同节点、同指标结论的可信度标签，不能作为结论节点引用`);
      continue;
    }
    if (capabilities) lines.push(`# ${id}：${summarize(result.node, capabilities)}`);
    const groups = new Map<string, Group>();
    for (const row of result.rows) {
      const signature = JSON.stringify(Object.entries(row.key).sort());
      const group = groups.get(signature) ?? { key: row.key, rows: [], score: 0 }; groups.set(signature, group); group.rows.push(row);
      if (row.sampleRows !== undefined) group.sample = Math.max(group.sample ?? 0, row.sampleRows);
      const fact = facts.get(row.factId); const value = fact?.value;
      // 只用百分比类的变化和偏离排序，避免元和百分比混比。
      if (["change", "deviation"].includes(row.role) && typeof value === "number" && /%|百分点/.test(fact!.unit)) group.score = Math.max(group.score, Math.abs(value));
    }
    const minRows = "minRows" in result.node && typeof result.node.minRows === "number" ? result.node.minRows : DEFAULT_MIN_ROWS;
    const all = [...groups.values()];
    for (const group of all.filter((item) => !Object.keys(item.key).length)) print(id, group);
    const parts = all.filter((item) => Object.keys(item.key).length);
    const eligible = parts.filter((item) => item.sample === undefined || item.sample >= minRows).sort((a, b) => b.score - a.score);
    for (const group of eligible.slice(0, GROUPS_PER_NODE)) print(id, group);
    const small = parts.length - eligible.length; const rest = eligible.length - Math.min(eligible.length, GROUPS_PER_NODE);
    if (small || rest) lines.push(`（${id} 另有${rest ? ` ${rest} 个偏离较小的分组` : ""}${rest && small ? "、" : ""}${small ? ` ${small} 个样本不足 ${minRows} 行的分组` : ""}未列出，不能引用）`);
  }
  return [...lines, ...(notes.length ? ["", "其他节点：", ...notes] : [])].join("\n") || "没有可用的执行结果";
}

const nodeIds = (nodes: unknown[]) => nodes.map((node) => (node as { id?: unknown })?.id).filter((id): id is string => typeof id === "string");
const issueText = (issue: { node?: string; field?: string; message: string }) => `${issue.node ? `${issue.node}${issue.field ? `.${issue.field}` : ""}：` : ""}${issue.message}`;
const claimOf = (bound: BoundClaim): Claim => ({ node: bound.node, ...(bound.select ? { select: bound.select } : {}), metric: bound.metric, ...(bound.role ? { role: bound.role } : {}), assert: bound.assert, text: bound.text });

export function createPlanAnalyticsRunner(config: Config, dependencies: Dependencies = { query }): PlanAnalyticsRunner {
  const sdkModel = analyticsSdkModel(config.model, config.modelBaseUrl);
  return async (request, externalSignal, onProgress) => {
    throwIfTurnCancelled(externalSignal);
    const quick = quickAnalyticsReply(request.question); if (quick) return quick;
    if ("mode" in request && quickMonthlySalesQuery(request)) return createAnalyticsRunner(config, { query: dependencies.query })(request, externalSignal, onProgress);
    mkdirSync(config.runtimeDir, { recursive: true });
    const runId = crypto.randomUUID();
    const context = "mode" in request
      ? [...new Set([...(request.context ?? []), ...request.history.filter((item) => item.role === "user").map((item) => item.text)])]
      : [`原报告范围：${JSON.stringify(request.report.query)}（用户没有明确改变时沿用）`];
    const provider = dependencies.provider ?? ("mode" in request ? { open: (signal?: AbortSignal) => { if (!config.database?.openAnalysisSession) throw new Error("当前历史数据源尚未提供一致性分析会话"); return config.database.openAnalysisSession(signal); } } : request.dataset ? createSnapshotAnalysisProvider(request.dataset) : undefined);
    if (!provider) throw new Error("本轮缺少授权数据快照，无法继续分析");
    const auditDir = privateAnalysisDirectory(config.auditDirectory ?? join(homedir(), "Library/Application Support/ctf-campaign-agent/analysis-runs"));
    const auditPath = join(auditDir, `${runId}.jsonl`);
    const controller = new AbortController(); const stopRelay = externalSignal ? relayAbort(externalSignal, controller) : () => {};
    const audit = (kind: string, value: unknown) => { if (!controller.signal.aborted) appendFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), runId, kind, value }) + "\n", { mode: 0o600 }); };
    const started = Date.now(); const monotonic = performance.now(); let steps: AgentTraceEvent[] = [];
    const now = () => started + performance.now() - monotonic;
    const emit = (event: AnalyticsProgressEvent) => { if (!controller.signal.aborted) onProgress?.(event); };
    const record = (event: AgentTraceEvent) => { if (!controller.signal.aborted) { steps = mergeTraceEvent(steps, event); emit({ type: "trace", event }); } };
    const begin = (name: PlanAnalyticsToolName, initiatedBy: ToolInitiator, title: string = PLAN_ANALYTICS_TOOL_LABELS[name]) => { const event = startTraceEvent({ id: crypto.randomUUID(), tool: name, title, initiatedBy, at: now() }); record(event); return event; };
    const end = (event: AgentTraceEvent, status: "completed" | "warning" | "failed", summary: string) => record(finishTraceEvent(event, { status, summary, at: Math.max(event.startedAt, now()) }));
    const modelFailure = (message: unknown, label: string) => {
      const value = message as { errors?: unknown; is_error?: boolean; result?: unknown };
      const detail = Array.isArray(value.errors) ? value.errors.filter((item) => typeof item === "string").join("；") : value.is_error && typeof value.result === "string" ? value.result : "上游没有完成运行";
      return new Error(`${label}：${(config.apiKey ? detail.replaceAll(config.apiKey, "[已隐藏]") : detail).slice(0, 1200)}`);
    };
    const businessDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
    const systemPrompt = buildPlanSystemPrompt(businessDate);
    let modelCalls = 0;

    // 一步一次模型调用：只注册本步的提交工具，提交被接受后结束。
    const runStep = async (options: { name: PlanAnalyticsToolName; description: string; shape: z.ZodRawShape; prompt: string; thinking: boolean; handle: (input: Record<string, unknown>) => unknown; done: () => boolean }) => {
      throwIfTurnCancelled(controller.signal); modelCalls++;
      const submit = tool(options.name, options.description, options.shape, async (input: Record<string, unknown>) => {
        // 本步已接受后再提交一律忽略，不改状态。
        if (options.done()) return textResult({ accepted: true, note: "本步骤已完成" });
        const event = begin(options.name, "model");
        try {
          throwIfTurnCancelled(controller.signal);
          const value = options.handle(input) as { accepted?: boolean };
          end(event, value?.accepted === false ? "warning" : "completed", value?.accepted === false ? "需要修正后重新提交" : "已提交");
          return textResult(value, value?.accepted === false);
        } catch (error) { if (!controller.signal.aborted) end(event, "failed", "本步尚未完成"); throw error; }
      });
      const analytics = createSdkMcpServer({ name: "analytics", version: "3.0.0", alwaysLoad: true, tools: [submit] });
      const permitted = new Set([`mcp__analytics__${options.name}`]);
      const stepController = new AbortController(); const stop = relayAbort(controller.signal, stepController);
      const messages = dependencies.query({ prompt: options.prompt, options: {
        model: sdkModel, effort: "low", thinking: options.thinking ? { type: "enabled" } : { type: "disabled" }, systemPrompt,
        tools: [], allowedTools: [], mcpServers: { analytics }, settingSources: [], persistSession: false, maxTurns: 3, abortController: stepController,
        canUseTool: async (name, input) => permitted.has(name) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "仅可使用本步骤的提交工具" },
        env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: config.runtimeDir, ANTHROPIC_BASE_URL: config.modelBaseUrl, ANTHROPIC_API_KEY: config.apiKey, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_TOOL_SEARCH: "false" },
      } });
      const iterator = messages[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await nextMessage(iterator, stepController.signal);
          if (options.done() || next.done) break;
          const message = next.value;
          if (message.type === "result") { if (message.subtype === "error_max_turns") break; if (message.subtype !== "success" || message.is_error) throw modelFailure(message, "分析运行未完成"); break; }
        }
      } finally { stepController.abort(); stop(); if (iterator.return) void iterator.return().catch(() => {}); }
      throwIfTurnCancelled(controller.signal);
    };

    let session: AnalysisDataSession | undefined;
    try {
      emit({ type: "phase", phase: "analyzing", at: Date.now() });
      audit("question", { question: request.question, context });
      session = await provider.open(controller.signal); throwIfTurnCancelled(controller.signal);
      const capabilities: AnalysisCapabilities = session.capabilities;
      const constraints: AnalysisConstraints = { filters: {} };
      const brief = capabilityBrief(capabilities);
      const droppedNodes: Array<{ id: string; reason: string }> = [];

      // 计划：首次调用允许同一调用内修改一次；复核退回后的第二次调用首次提交即为最终。
      const planStep = async (issues: string[], allowRetry: boolean, previous?: PreviousPlan): Promise<PreviousPlan> => {
        let submittedRaw: unknown;
        let accepted: { nodes: PlanNode[]; dropped: Array<{ id: string; reason: string }> } | undefined; let attempts = 0;
        await runStep({
          name: "submit_plan", description: "提交声明式分析计划；有问题时会返回问题清单", shape: planShape, thinking: true,
          prompt: planPrompt(request.question, context, brief, issues, previous),
          done: () => Boolean(accepted),
          handle: (input) => {
            attempts++;
            const raw = input.plan as { question?: string; nodes: unknown[] };
            const oversized = JSON.stringify(raw).length > MAX_PLAN_JSON;
            const parsed = oversized ? { issues: [{ message: "计划过长，请只保留回答原问题需要的节点" }] } : parsePlan({ question: raw.question ?? request.question, nodes: raw.nodes });
            const validation = parsed.plan ? validatePlan(parsed.plan, capabilities, constraints) : { valid: [], dropped: [], issues: [] };
            const all = [...parsed.issues, ...validation.issues];
            if (all.length && allowRetry && attempts === 1) return { accepted: false, issues: all.map(issueText) };
            const keptIds = new Set(validation.valid.map((node) => node.id));
            const dropped = [...new Set(nodeIds(raw.nodes ?? []))].filter((id) => !keptIds.has(id)).map((id) => ({ id, reason: all.filter((issue) => issue.node === id).map((issue) => issue.message).join("；") || "节点未通过校验" }));
            accepted = { nodes: validation.valid, dropped }; submittedRaw = raw;
            return { accepted: true, nodes: validation.valid.map((node) => node.id), dropped };
          },
        });
        if (!accepted) throw new Error("分析计划没有提交，本轮无法继续");
        // 原始提交一并记下，便于复盘被丢弃节点的写法。
        audit("plan", { attempts, nodes: accepted.nodes, dropped: accepted.dropped, submitted: submittedRaw });
        return accepted;
      };
      let plan = await planStep([], true);

      let review: { verdict: "ok" | "revise"; issues: string[] } | undefined;
      await runStep({
        name: "submit_plan_review", description: "提交计划复核意见", shape: reviewShape, thinking: true,
        prompt: reviewPrompt("plan", request.question, JSON.stringify({ nodes: plan.nodes, dropped: plan.dropped }), brief),
        done: () => Boolean(review),
        handle: (input) => { review = { verdict: input.verdict as "ok" | "revise", issues: input.issues as string[] }; return { recorded: true }; },
      });
      audit("plan_review", review ?? { verdict: "ok", issues: [], missing: true });
      // 修订轮同样允许在同一次调用内按校验问题改一次；不增加模型调用次数。
      if (review?.verdict === "revise") plan = await planStep(review.issues.length ? review.issues : ["复核认为计划需要修改"], true, plan);
      droppedNodes.push(...plan.dropped);

      // 执行：每个节点一条轨迹，节点开始前登记、执行完按状态结束。
      const runNodes = async (nodes: PlanNode[], registry: ReturnType<typeof createEvidenceRegistry>, prior?: PlanExecution["results"]) => {
        const events = new Map(nodes.map((node) => [node.id, begin("run_plan_node", "orchestrator", `${PLAN_ANALYTICS_TOOL_LABELS.run_plan_node} ${node.id}`)]));
        const execution = await executePlan(nodes, session!, constraints, registry, controller.signal, prior);
        for (const [id, event] of events) {
          const result = execution.results.get(id);
          end(event, result?.status === "completed" ? "completed" : "warning", result?.status === "completed" ? "已完成计算" : result?.message ? `未完成：${result.message.slice(0, 120)}` : "未完成");
        }
        return execution;
      };
      const registry = createEvidenceRegistry();
      let execution = await runNodes(plan.nodes, registry);
      audit("execution", [...execution.results.values()].map((result) => ({ id: result.node.id, status: result.status, rows: result.rows.length, message: result.message })));

      // 补充计划：最多一次；补充节点和已有节点一起校验，只执行补充节点及其依赖。
      let followup: PreviousPlan | undefined; let followupAttempts = 0;
      await runStep({
        name: "submit_followup", description: "提交补充节点；不需要补充时提交空数组", shape: followupShape, thinking: true,
        prompt: `${planPrompt(request.question, context, brief, [])}\n\n## 本步改为：补充计划\n已执行的计划和结果如下。只有结果不足以回答原问题时，才用 submit_followup({ nodes }) 补充最多 ${FOLLOWUP_NODES} 个节点；新节点 id 不能与已有节点重复，可以用 of 引用已有节点。不需要补充时提交 { "nodes": [] }。\n\n### 已执行节点\n${JSON.stringify(plan.nodes)}\n\n### 执行结果\n${executionSummary(execution, capabilities)}`,
        done: () => Boolean(followup),
        handle: (input) => {
          followupAttempts++;
          const raw = input.nodes as unknown[];
          if (!raw.length) { followup = { nodes: [], dropped: [] }; return { accepted: true, nodes: [] }; }
          const parsed = parsePlan({ question: request.question, nodes: [...plan.nodes, ...raw] }, plan.nodes.length + FOLLOWUP_NODES);
          const validation = parsed.plan ? validatePlan(parsed.plan, capabilities, constraints) : { valid: [], dropped: [], issues: [] };
          const existing = new Set(plan.nodes.map((node) => node.id));
          const all = [...parsed.issues, ...validation.issues];
          const offered = new Set(nodeIds(raw).filter((id) => !existing.has(id)));
          // 和计划一样，首次提交有问题时退回问题清单，同一次调用内改一次。
          const own = all.filter((issue) => !issue.node || offered.has(issue.node));
          if (own.length && followupAttempts === 1) return { accepted: false, issues: own.map(issueText) };
          const nodes = validation.valid.filter((node) => offered.has(node.id));
          const keptIds = new Set(nodes.map((node) => node.id));
          const dropped = [...new Set(nodeIds(raw))].filter((id) => !keptIds.has(id)).map((id) => ({ id, reason: existing.has(id) ? "与已有节点 id 重复" : all.filter((issue) => issue.node === id).map((issue) => issue.message).join("；") || "节点未通过校验" }));
          followup = { nodes, dropped };
          return { accepted: true, nodes: nodes.map((node) => node.id), dropped };
        },
      });
      audit("followup", followup ?? { nodes: [], dropped: [], missing: true });
      if (followup?.nodes.length) {
        // 已执行节点的结果作为 prior 传入：补充节点直接沿用其来源，不重查、不重复登记证据。
        const extra = await runNodes(followup.nodes, registry, execution.results);
        const results = new Map(execution.results);
        for (const node of followup.nodes) results.set(node.id, extra.results.get(node.id)!);
        execution = { results, evidence: registry.view() };
        audit("execution", followup.nodes.map((node) => ({ id: node.id, status: results.get(node.id)?.status, message: results.get(node.id)?.message })));
      }
      droppedNodes.push(...(followup?.dropped ?? []));

      // 结论：一次提交，代码绑定数字并把丢弃原因回给模型。
      emit({ type: "phase", phase: "writing", at: Date.now() });
      // 原话里的日期、时长和业务名称可以写进措辞。
      const literals = [request.question, ...context];
      let draft: ClaimDraft | undefined; let binding: Binding | undefined; let claimAttempts = 0;
      // 首次提交被退回后模型没有再交（轮数用完或直接结束）时，用首次提交里通过的条目，不整份丢掉。
      let firstDraft: ClaimDraft | undefined; let firstBinding: Binding | undefined;
      await runStep({
        name: "submit_claims", description: "提交绑定计划节点的结论措辞", shape: claimsShape, thinking: false,
        prompt: claimsPrompt(request.question, executionSummary(execution, capabilities)),
        done: () => Boolean(binding),
        handle: (input) => {
          claimAttempts++;
          const submitted = input as unknown as ClaimDraft; const result = bindClaims(submitted, execution, literals);
          // 首次提交有结论或建议被丢弃时，把原因退回，同一次调用内整份改一次；第二次提交按绑定结果直接采用。
          const rejected = [...result.dropped.map((item) => ({ text: item.claim.text, reason: item.reason })), ...result.droppedText.map((item) => ({ text: item.text, reason: item.reason }))];
          if (rejected.length && claimAttempts === 1) { firstDraft = submitted; firstBinding = result; return { accepted: false, note: "以下条目没有通过，请修改后重新提交整份结论（通过的条目也要一并提交）", rejected }; }
          draft = submitted; binding = result;
          return { accepted: true, headline: binding.headline?.rendered ?? null, claims: binding.claims.map((claim) => claim.rendered), dropped: binding.dropped.map((item) => ({ text: item.claim.text, reason: item.reason })), droppedText: binding.droppedText };
        },
      });
      if (!binding && firstBinding) { draft = firstDraft; binding = firstBinding; }
      binding ??= { claims: [], actions: [], dropped: [], droppedText: [], cannotConclude: [], questions: [] };
      audit("claims", { draft: draft ?? null, binding, attempts: claimAttempts });

      // 措辞复核：0 为主结论，其余为保留的结论；改写重新绑定，不通过视同删除并记入丢弃。
      const reviewNotes: string[] = [];
      const bound = [...(binding.headline ? [binding.headline] : []), ...binding.claims];
      if (bound.length) {
        let wording: { edits: Array<{ index: number; action: "drop" | "rewrite"; text?: string }>; notes: string[] } | undefined;
        await runStep({
          name: "submit_wording_review", description: "提交结论措辞复核", shape: wordingShape, thinking: false,
          prompt: reviewPrompt("wording", request.question, bound.map((claim, index) => { const node = execution.results.get(claim.node)?.node; return `${index}|${claim.rendered}|原措辞：${claim.text}|依据：${node ? summarize(node, capabilities) : claim.node}${claim.select ? `，分组 ${Object.values(claim.select).join("、")}` : ""}|${claim.assert}`; }).join("\n")),
          done: () => Boolean(wording),
          handle: (input) => { wording = input as unknown as NonNullable<typeof wording>; return { recorded: true }; },
        });
        audit("wording_review", wording ?? { edits: [], notes: [], missing: true });
        reviewNotes.push(...(wording?.notes ?? []).filter((note) => note.trim()));
        const edits = new Map((wording?.edits ?? []).filter((edit) => edit.index < bound.length).map((edit) => [edit.index, edit]));
        if (edits.size) {
          const offset = binding.headline ? 1 : 0;
          const removed: Binding["dropped"] = [];
          const revised = (claim: BoundClaim, index: number): Claim | undefined => {
            const edit = edits.get(index); if (!edit) return claimOf(claim);
            if (edit.action === "rewrite" && edit.text?.trim()) return { ...claimOf(claim), text: edit.text };
            removed.push({ claim: claimOf(claim), reason: "措辞复核删除" }); return undefined;
          };
          const headline = binding.headline ? revised(binding.headline, 0) : undefined;
          const claims: Claim[] = []; const remap = new Map<number, number>();
          binding.claims.forEach((claim, index) => { const next = revised(claim, index + offset); if (next) { remap.set(index, claims.length); claims.push(next); } });
          // 主结论被删时由首条结论顶上，草稿里放一条占位使 bindClaims 走提升逻辑。
          const placeholder: Claim = { node: "__dropped__", metric: "", assert: "unavailable", text: "已删除" };
          const actions = binding.actions.flatMap((action) => remap.has(action.claim) ? [{ text: action.text, claim: remap.get(action.claim)! }] : []);
          const rebound = bindClaims({ headline: headline ?? placeholder, claims, actions, cannotConclude: binding.cannotConclude, questions: binding.questions }, execution, literals);
          binding = { ...rebound, dropped: [...binding.dropped, ...removed, ...rebound.dropped.filter((item) => item.claim !== placeholder)], droppedText: [...binding.droppedText, ...rebound.droppedText] };
        }
      }

      const answer = assemblePlanAnswer({ runId, question: request.question, execution, binding, capabilities, droppedNodes, reviewNotes });
      const completed = steps.filter((step) => step.status !== "started");
      const timing = harnessTimingSummary(performance.now() - monotonic, completed.map((step) => ({ offsetMs: Math.max(0, step.startedAt - started), durationMs: step.durationMs ?? 0 })));
      const final = validatePlanAnswer({ ...answer, ...(completed.length ? { trace: { status: answer.status === "answered" ? "completed" : "warning", durationMs: timing.totalMs, timing, steps: completed } } : {}) });
      audit("final", { status: final.status, modelCalls, headline: final.headline?.text ?? null, claims: final.claims.map((claim) => claim.text) });
      return final;
    } catch (error) {
      if (controller.signal.aborted) throw new TurnCancelledError();
      audit("failure", { message: error instanceof Error ? error.message : "运行失败", modelCalls });
      throw error;
    } finally { controller.abort(); stopRelay(); await session?.close(); }
  };
}

