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
import type { AnalysisCapabilities, AnalysisConstraints, AnalysisDataProvider, AnalysisDataSession, PlanAnswerV4 } from "../app/lib/analytics/analysis-v2-types.ts";
import { createEvidenceRegistry } from "../app/lib/analytics/analysis-v2-evidence.ts";
import { createSnapshotAnalysisProvider } from "../app/lib/analytics/analysis-v2-snapshot.ts";
import { DEFAULT_INTENT, parsePlan, validatePlan } from "../app/lib/analytics/plan/validate.ts";
import { executePlan, type NodeRow, type PlanExecution } from "../app/lib/analytics/plan/execute.ts";
import { formatRoleValue, totalAcrossWindows } from "../app/lib/analytics/plan/bind.ts";
import { assemblePlanAnswerV4, chartLabels, planAnswerV4Text, summarize, validatePlanAnswerV4 } from "../app/lib/analytics/plan/answer.ts";
import { REF, parseRef, quoteRefValue, resolveBody, resolveRef, type ResolvedBody } from "../app/lib/analytics/plan/refs.ts";
import { DEFAULT_MIN_ROWS, type PlanIntent, type PlanNode } from "../app/lib/analytics/plan/types.ts";
import { answerPrompt, answerReviewPrompt, capabilityBrief, planPrompt, planReviewPrompt, type PreviousPlan, type ReviewRef } from "../app/lib/analytics/plan/prompt.ts";
import { PLAN_ANALYTICS_TOOL_LABELS, type PlanAnalyticsToolName } from "../app/lib/analytics/tool-names.ts";
import type { AnalyticsProgressEvent } from "../app/lib/analytics/stream.ts";
import { relayAbort, throwIfTurnCancelled, TurnCancelledError } from "../app/lib/cancellation.ts";
import { finishTraceEvent, harnessTimingSummary, mergeTraceEvent, startTraceEvent, type AgentTraceEvent, type ToolInitiator } from "../app/lib/tool-trace.ts";

export type PlanAnalyticsRunner = (request: DatabaseExplainRequest | AnalyticsExplainRequest, signal?: AbortSignal, onProgress?: (event: AnalyticsProgressEvent) => void) => Promise<PlanAnswerV4 | AnalyticsExplainResult>;
type Config = AgentRuntimeConfig & { database?: AnalyticsDatabase; auditDirectory?: string };
type Dependencies = { query: AgentQuery; provider?: AnalysisDataProvider };

// 入参只做形状和长度上限，真实校验交给 parsePlan / validatePlan / resolveBody，错误以结构化问题返回模型。
const looseNode = z.looseObject({ id: z.string().max(40).optional(), op: z.string().max(20).optional() });
// intent 只限形状和长度，取值范围由 parsePlan 校验并以中文问题返回；reason 的 200 字上限同样由 parsePlan 报。null 当作没写。
const looseIntent = z.looseObject({ kind: z.string().max(40).optional(), goal: z.string().max(40).optional(), reason: z.string().max(1000).optional() });
const planShape = { plan: z.object({ question: z.string().max(2000).optional(), intent: looseIntent.nullish(), nodes: z.array(looseNode).max(20) }) };
const reviewShape = { verdict: z.enum(["ok", "revise"]), issues: z.array(z.string().max(500)).max(10) };
// 补充计划单独计数：已执行节点不占补充名额。
const FOLLOWUP_NODES = 8;
const followupShape = { nodes: z.array(looseNode).max(FOLLOWUP_NODES) };
// 正文按 Markdown 原文提交；引用替换后的长度上限由 resolveBody 再管一道。
const MAX_BODY_INPUT = 4000;
const answerShape = { body: z.string().max(MAX_BODY_INPUT) };
const answerReviewShape = { verdict: z.enum(["ok", "rewrite"]), body: z.string().max(MAX_BODY_INPUT).optional(), notes: z.array(z.string().max(300)).max(5) };
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

// ---- 结果摘要（给补充计划和正文步骤）----
// 按节点分组，每行开头是可以直接照抄进正文的引用，后面是代码会填进去的值。
// 总体行和偏离最大的分组优先：每个节点各取偏离最大的若干分组，保证下钻、扫描的每个节点都出现在摘要里；
// 样本行数低于节点 minRows（默认 200）的分组不列出，避免把小样本写成结论。
const GROUPS_PER_NODE = 8;
export function executionSummary(execution: PlanExecution, capabilities?: AnalysisCapabilities): string {
  const facts = new Map(execution.evidence.facts.map((fact) => [fact.id, fact]));
  type Group = { key: Record<string, string>; rows: NodeRow[]; score: number; sample?: number };
  const lines: string[] = []; const notes: string[] = [];
  let scopeNode: PlanNode | undefined;
  const print = (node: string, group: Group) => {
    const select = Object.keys(group.key).length ? `|${Object.entries(group.key).map(([name, value]) => `${name}=${quoteRefValue(value)}`).join(",")}` : "";
    for (const row of group.rows) {
      const fact = facts.get(row.factId);
      const value = !fact || fact.value === null ? "暂无可计算值" : formatRoleValue(fact, row.role);
      // 天数不同两段的合计值引用会被删掉，这里先标出来，免得模型白写。
      const blocked = scopeNode && totalAcrossWindows(scopeNode, row.metric, row.role) ? "（两段天数不同，合计值不能引用）" : "";
      lines.push(`\`{{${node}.${row.metric}.${row.role}${select}}}\` = ${value}${row.sampleRows !== undefined ? `（样本 ${row.sampleRows} 行）` : ""}${blocked}`);
    }
  };
  for (const [id, result] of execution.results) {
    if (result.status !== "completed") { notes.push(`- ${id}（${result.node.op}）${result.status === "unsupported" ? "不支持" : "失败"}：${result.message ?? ""}，不能引用`); continue; }
    if (result.node.op === "robust") {
      for (const item of result.robust ?? []) notes.push(`- ${id} 检查 ${result.node.of} 的 ${item.metric}（${item.check}）：${item.kept === null ? "无法判断" : item.kept ? "方向保持" : "方向翻转"}（${item.detail}）。只能用文字说明结论稳不稳，不能引用`);
      continue;
    }
    if (capabilities) lines.push(`# ${id}：${summarize(result.node, capabilities)}`);
    // 下钻、扫描沿用所指对比的范围。
    scopeNode = "of" in result.node ? execution.results.get(result.node.of)?.node ?? result.node : result.node;
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
// 复核改写只能改文字：issue 不能变多，原正文引用的事实一个不能少，表格和图不能变少。
const blockCount = (body: ResolvedBody) => body.blocks.filter((block) => block.kind !== "markdown").length;
function rewriteIssue(original: ResolvedBody, rewritten: ResolvedBody): string | undefined {
  if (!rewritten.blocks.length || rewritten.issues.length > original.issues.length) return `复核改写后有 ${rewritten.issues.length} 处引用或数字没有通过，保留原正文`;
  const kept = new Set(rewritten.factIds);
  if (original.factIds.some((id) => !kept.has(id)) || blockCount(rewritten) < blockCount(original)) return "复核改写丢了数据，保留原文";
  return undefined;
}

// 复核用：正文里每个引用（去重）填进去的值和依据。
function reviewRefs(body: string, execution: PlanExecution, capabilities: AnalysisCapabilities): ReviewRef[] {
  const labels = chartLabels(capabilities);
  const seen = new Set<string>(); const refs: ReviewRef[] = [];
  for (const match of body.matchAll(REF)) {
    if (seen.has(match[0])) continue; seen.add(match[0]);
    const parsed = parseRef(match[1]); const resolved = resolveRef(match[1], execution);
    const node = typeof parsed === "string" ? undefined : execution.results.get(parsed.node)?.node;
    const group = typeof parsed === "string" ? "" : Object.entries(parsed.select).map(([name, value]) => `${labels.dimension(name)}=${value}`).join("，");
    const basis = typeof parsed === "string" ? "引用格式不对" : `${node ? summarize(node, capabilities) : `节点 ${parsed.node} 不存在`}；指标 ${labels.metric(parsed.metric)}；${group ? `分组 ${group}` : "总体"}`;
    refs.push({ ref: match[0], ...(typeof resolved === "string" ? { issue: resolved } : { value: resolved.text }), basis });
  }
  return refs;
}

export function createPlanAnalyticsRunner(config: Config, dependencies: Dependencies = { query }): PlanAnalyticsRunner {
  const sdkModel = analyticsSdkModel(config.model);
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
    // 耗时写进运行日志（只有阶段名和毫秒数，不含问题和数据），线上排查慢在哪一步。
    const turnStarted = Date.now(); let queryCount = 0;
    const logTiming = (label: string, started: number) => console.log(`[analysis ${runId.slice(0, 8)}] ${label} ${Date.now() - started}ms`);
    const timedSession = (inner: AnalysisDataSession): AnalysisDataSession => {
      const wrap = <A extends unknown[], R>(name: string, fn?: (...args: A) => Promise<R>) => fn && (async (...args: A) => { const started = Date.now(); queryCount++; try { return await fn.apply(inner, args); } finally { logTiming(`查库 ${name}`, started); } });
      return { ...inner, aggregate: wrap("aggregate", inner.aggregate)!, aggregateWithOrderIds: wrap("aggregateWithOrderIds", inner.aggregateWithOrderIds), orderDistribution: wrap("orderDistribution", inner.orderDistribution), scenario: wrap("scenario", inner.scenario), close: () => inner.close(), assertActive: inner.assertActive && (() => inner.assertActive!()) };
    };
    // 结构上限：计划 ≤2、计划复核 1、补充计划 1、正文 1、正文复核 1；正文漏交时的补交只在还有余量时发生。
    const MAX_MODEL_CALLS = 6;

    // 一步一次模型调用：只注册本步的提交工具，提交被接受后结束。
    // 返回模型在这一步直接输出的文字（不经工具）；正文步骤在模型没调用工具时拿它当提交。
    const runStep = async (options: { name: PlanAnalyticsToolName; description: string; shape: z.ZodRawShape; prompt: string; thinking: boolean; handle: (input: Record<string, unknown>) => unknown; done: () => boolean }): Promise<string> => {
      let spoken = "";
      throwIfTurnCancelled(controller.signal); modelCalls++; const stepStarted = Date.now();
      // 模型想的时候就亮出这一步，不等它调用工具；被退回后的再次提交仍在调用时才记。
      let pending: AgentTraceEvent | undefined = begin(options.name, "model");
      const submit = tool(options.name, options.description, options.shape, async (input: Record<string, unknown>) => {
        // 本步已接受后再提交一律忽略，不改状态。
        if (options.done()) return textResult({ accepted: true, note: "本步骤已完成" });
        const event = pending ?? begin(options.name, "model"); pending = undefined;
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
          // 本步没有提交时，模型说了什么、工具调用为什么没进处理函数（入参校验失败等）都记进审计，便于排查。
          if (message.type === "assistant") for (const part of message.message.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>) {
            if (part.type === "text" && part.text?.trim()) { spoken += `${spoken ? "\n\n" : ""}${part.text.trim()}`; audit("step_text", { step: options.name, text: part.text.slice(0, 2000) }); }
            if (part.type === "tool_use") audit("step_tool_use", { step: options.name, tool: part.name, input: JSON.stringify(part.input).slice(0, 2000) });
          }
          if (message.type === "user") for (const part of (message.message.content ?? []) as Array<{ type: string; is_error?: boolean; content?: unknown }>) {
            if (part.type === "tool_result" && part.is_error) audit("step_tool_error", { step: options.name, content: JSON.stringify(part.content).slice(0, 2000) });
          }
          if (message.type === "result") { if (message.subtype === "error_max_turns") break; if (message.subtype !== "success" || message.is_error) throw modelFailure(message, "分析运行未完成"); break; }
        }
      } finally {
        stepController.abort(); stop(); if (iterator.return) void iterator.return().catch(() => {});
        // 没等到提交的那一步收尾，不留一直转圈的步骤。
        if (pending && !controller.signal.aborted) end(pending, "warning", "没有调用提交工具");
        logTiming(`模型 ${options.name}${options.thinking ? "（思考）" : ""}`, stepStarted);
      }
      throwIfTurnCancelled(controller.signal);
      return spoken;
    };

    let session: AnalysisDataSession | undefined;
    try {
      emit({ type: "phase", phase: "analyzing", at: Date.now() });
      audit("question", { question: request.question, context });
      const openStarted = Date.now();
      session = timedSession(await provider.open(controller.signal)); throwIfTurnCancelled(controller.signal);
      logTiming("打开数据快照", openStarted);
      const capabilities: AnalysisCapabilities = session.capabilities;
      const constraints: AnalysisConstraints = { filters: {} };
      const brief = capabilityBrief(capabilities);
      const droppedNodes: Array<{ id: string; reason: string }> = [];

      // 计划：首次调用允许同一调用内修改一次；复核退回后的第二次调用首次提交即为最终。
      const planStep = async (issues: string[], allowRetry: boolean, previous?: PreviousPlan): Promise<PreviousPlan & { intent: PlanIntent }> => {
        let submittedRaw: unknown;
        let accepted: { nodes: PlanNode[]; dropped: Array<{ id: string; reason: string }>; intent: PlanIntent } | undefined; let attempts = 0;
        await runStep({
          name: "submit_plan", description: "提交声明式分析计划；有问题时会返回问题清单", shape: planShape, thinking: true,
          prompt: planPrompt(request.question, context, brief, issues, previous),
          done: () => Boolean(accepted),
          handle: (input) => {
            attempts++;
            const raw = input.plan as { question?: string; intent?: unknown; nodes: unknown[] };
            const oversized = JSON.stringify(raw).length > MAX_PLAN_JSON;
            // 复核退回后重提时漏写 intent（或写 null），沿用上一版的判断，不静默退回默认的复盘。
            const intent = raw.intent ?? previous?.intent;
            const parsed = oversized ? { issues: [{ message: "计划过长，请只保留回答原问题需要的节点" }] } : parsePlan({ question: raw.question ?? request.question, intent, nodes: raw.nodes });
            const validation = parsed.plan ? validatePlan(parsed.plan, capabilities, constraints) : { valid: [], dropped: [], issues: [] };
            const all = [...parsed.issues, ...validation.issues];
            if (all.length && allowRetry && attempts === 1) return { accepted: false, issues: all.map(issueText) };
            const keptIds = new Set(validation.valid.map((node) => node.id));
            const dropped = [...new Set(nodeIds(raw.nodes ?? []))].filter((id) => !keptIds.has(id)).map((id) => ({ id, reason: all.filter((issue) => issue.node === id).map((issue) => issue.message).join("；") || "节点未通过校验" }));
            accepted = { nodes: validation.valid, dropped, intent: parsed.plan?.intent ?? { ...DEFAULT_INTENT } }; submittedRaw = raw;
            return { accepted: true, nodes: validation.valid.map((node) => node.id), dropped };
          },
        });
        if (!accepted) throw new Error("分析计划没有提交，本轮无法继续");
        // 原始提交一并记下，便于复盘被丢弃节点的写法。
        audit("plan", { attempts, intent: accepted.intent, nodes: accepted.nodes, dropped: accepted.dropped, submitted: submittedRaw });
        return accepted;
      };
      let plan = await planStep([], true);

      let review: { verdict: "ok" | "revise"; issues: string[] } | undefined;
      await runStep({
        name: "submit_plan_review", description: "提交计划复核意见", shape: reviewShape, thinking: true,
        prompt: planReviewPrompt(request.question, JSON.stringify({ intent: plan.intent, nodes: plan.nodes, dropped: plan.dropped }), brief, context),
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
        const executeStarted = Date.now();
        const execution = await executePlan(nodes, session!, constraints, registry, controller.signal, prior);
        logTiming(`执行计划 ${nodes.length} 个节点`, executeStarted);
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
        prompt: `${planPrompt(request.question, context, brief, [], undefined, { followup: plan.intent })}\n\n## 本步改为：补充计划\n已执行的计划和结果如下。只有结果不足以回答原问题时，才用 submit_followup({ nodes }) 补充最多 ${FOLLOWUP_NODES} 个节点；新节点 id 不能与已有节点重复，可以用 of 引用已有节点。不需要补充时提交 { "nodes": [] }。\n\n### 已执行节点\n${JSON.stringify(plan.nodes)}\n\n### 执行结果\n${executionSummary(execution, capabilities)}`,
        done: () => Boolean(followup),
        handle: (input) => {
          followupAttempts++;
          const raw = input.nodes as unknown[];
          if (!raw.length) { followup = { nodes: [], dropped: [] }; return { accepted: true, nodes: [] }; }
          // 带上主计划的 intent：机制比较时补充的对比节点同样要对齐货。
          const parsed = parsePlan({ question: request.question, intent: plan.intent, nodes: [...plan.nodes, ...raw] }, plan.nodes.length + FOLLOWUP_NODES);
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

      // 正文：一次调用；首次提交有引用填不了值或写死数字时退回 issues，同一调用内改一次，第二次按结果采用。
      emit({ type: "phase", phase: "writing", at: Date.now() });
      // 原话里的日期、时长和业务名称可以写进正文。
      const literals = [request.question, ...context];
      const earlier = context.filter((item) => item !== request.question);
      const labels = chartLabels(capabilities);
      const resolve = (body: string) => resolveBody(body, execution, literals, labels);
      let first: { body: string; resolved: ResolvedBody } | undefined; let accepted: { body: string; resolved: ResolvedBody } | undefined; let answerAttempts = 0;
      const answerStep = (nudge: string) => runStep({
        name: "submit_answer", description: "提交回答正文（Markdown，数字写成 {{节点.指标}} 引用）；有问题时会返回问题清单", shape: answerShape, thinking: false,
        prompt: `${answerPrompt(request.question, executionSummary(execution, capabilities), earlier, plan.intent)}${nudge}`,
        done: () => Boolean(accepted),
        handle: (input) => {
          answerAttempts++;
          const body = input.body as string; const resolved = resolve(body);
          if (resolved.issues.length && answerAttempts === 1) { first = { body, resolved }; return { accepted: false, note: "以下句子或块没有通过，交付时会被删掉；请修改后重新提交完整正文", issues: resolved.issues }; }
          accepted = { body, resolved };
          return { accepted: true, ...(resolved.issues.length ? { removed: resolved.issues } : {}) };
        },
      });
      // 模型有时把正文直接说出来、不调用工具。说出来的文字只要含引用，就按正文提交处理（同样走引用校验），
      // 不浪费一次调用；什么都没留下时才再给一次机会，补交可以用掉最后一次调用，之后复核在余量不够时跳过。
      const fromText = (spoken: string) => {
        if (answerAttempts || !/\{\{[^}]+\}\}/.test(spoken)) return false;
        audit("answer_from_text", { length: spoken.length });
        const body = spoken.slice(0, MAX_BODY_INPUT); accepted = { body, resolved: resolve(body) }; return true;
      };
      if (!fromText(await answerStep("")) && !answerAttempts && modelCalls < MAX_MODEL_CALLS) {
        audit("answer_retry", { reason: "写正文步骤没有调用 submit_answer" });
        fromText(await answerStep("\n\n## 注意\n上一次没有提交。这一步只做一件事：调用 submit_answer({ body }) 提交正文，不要只输出文字。"));
      }
      // 首次被退回后模型没有再交（轮数用完或直接结束）时，按首次结果采用，删掉没通过的句子。
      accepted ??= first;
      audit("answer", { attempts: answerAttempts, first: first ? { body: first.body, issues: first.resolved.issues } : null, final: accepted ? { body: accepted.body, issues: accepted.resolved.issues } : null });

      // 正文复核：改写重新解析，没有比原结果多出 issue 才采用，否则保留原正文。
      const reviewNotes: string[] = [];
      if (accepted?.resolved.blocks.length && modelCalls < MAX_MODEL_CALLS) {
        const original = accepted;
        let review: { verdict: "ok" | "rewrite"; body?: string; notes: string[] } | undefined;
        await runStep({
          name: "submit_answer_review", description: "提交回答复核结果", shape: answerReviewShape, thinking: false,
          prompt: answerReviewPrompt(request.question, earlier, original.body, reviewRefs(original.body, execution, capabilities), plan.intent),
          done: () => Boolean(review),
          handle: (input) => { review = input as unknown as NonNullable<typeof review>; return { recorded: true }; },
        });
        reviewNotes.push(...(review?.notes ?? []).filter((note) => note.trim()));
        let adopted = false;
        if (review?.verdict === "rewrite" && review.body?.trim()) {
          const rewritten = resolve(review.body);
          const problem = rewriteIssue(original.resolved, rewritten);
          if (!problem) { accepted = { body: review.body, resolved: rewritten }; adopted = true; }
          else reviewNotes.push(problem);
        }
        audit("answer_review", { verdict: review?.verdict ?? "ok", notes: review?.notes ?? [], adopted, ...(review?.verdict === "rewrite" ? { body: review.body ?? null } : {}), ...(review ? {} : { missing: true }) });
      }

      const answer = assemblePlanAnswerV4({ runId, question: request.question, execution, body: accepted?.resolved ?? { blocks: [], issues: [], factIds: [] }, capabilities, droppedNodes, reviewNotes });
      const completed = steps.filter((step) => step.status !== "started");
      const timing = harnessTimingSummary(performance.now() - monotonic, completed.map((step) => ({ offsetMs: Math.max(0, step.startedAt - started), durationMs: step.durationMs ?? 0 })));
      const final = validatePlanAnswerV4({ ...answer, ...(completed.length ? { trace: { status: answer.status === "answered" ? "completed" : "warning", durationMs: timing.totalMs, timing, steps: completed } } : {}) });
      audit("final", { status: final.status, modelCalls, body: planAnswerV4Text(final).slice(0, 200) });
      logTiming(`全部完成，模型 ${modelCalls} 次、查库 ${queryCount} 次`, turnStarted);
      return final;
    } catch (error) {
      if (controller.signal.aborted) throw new TurnCancelledError();
      audit("failure", { message: error instanceof Error ? error.message : "运行失败", modelCalls });
      throw error;
    } finally { controller.abort(); stopRelay(); await session?.close(); }
  };
}

