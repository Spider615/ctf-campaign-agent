import { mkdirSync, readFileSync } from "node:fs";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ANALYTICS_TOOLS, type AnalyticsTool } from "../app/lib/analytics/explain.ts";
import { DIMENSIONS, type AnalyticsExplainRequest, type AnalyticsExplainResult } from "../app/lib/analytics/types.ts";
import { relayAbort, throwIfTurnCancelled, TurnCancelledError } from "../app/lib/cancellation.ts";
import type { AgentQuery, AgentRuntimeConfig } from "./run-turn.ts";
import { createAnalyticsTools } from "./analytics-tools.ts";
import { HISTORY_DIMENSIONS, type HistoryDimension, type AnalyticsDatabase, type DatabaseExplainRequest } from "../app/lib/analytics/database.ts";
import { analyticsDialogueMode, quickAnalyticsReply, quickMonthlySalesQuery } from "../app/lib/analytics/dialogue.ts";
import { buildLegacyAnalyticsSystemPrompt } from "./analytics-system-prompt.ts";
import { composeAdvice } from "../app/lib/analytics/advisor.ts";
import { ANALYTICS_SKILL_TRACE_TOOL, ANALYTICS_TOOL_LABELS } from "../app/lib/analytics/tool-names.ts";
import type { AnalyticsProgressEvent } from "../app/lib/analytics/stream.ts";
import { finishTraceEvent, harnessTimingSummary, mergeTraceEvent, startTraceEvent, type AgentTraceEvent, type TraceToolName, type ToolInitiator } from "../app/lib/tool-trace.ts";
import { turnBaseUrl } from "./usage/context.ts";

export type AnalyticsRunner = (request: AnalyticsExplainRequest | DatabaseExplainRequest, signal?: AbortSignal, onProgress?: (event: AnalyticsProgressEvent) => void) => Promise<AnalyticsExplainResult>;

async function nextMessage<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  throwIfTurnCancelled(signal);
  let cancel = () => {};
  try {
    return await new Promise((resolve, reject) => {
      cancel = () => reject(new TurnCancelledError()); signal.addEventListener("abort", cancel, { once: true });
      Promise.resolve(iterator.next()).then(resolve, reject);
      if (signal.aborted) cancel();
    });
  } finally { signal.removeEventListener("abort", cancel); }
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ type: "text"; text: string }> }>;
const skillNames = ["analytics:ctf-marketing-advisor"] as const;

export function validateAnalyticsSkills(pluginDir: string, required: readonly string[] = skillNames): void {
  const manifest = JSON.parse(readFileSync(`${pluginDir}/.claude-plugin/plugin.json`, "utf8"));
  if (manifest.name !== "analytics") throw new Error("营销分析插件名称不正确");
  for (const name of required.map((skill) => skill.slice("analytics:".length))) {
    const skill = readFileSync(`${pluginDir}/skills/${name}/SKILL.md`, "utf8");
    const fields = skill.split("---")[1]?.trim().split(/\r?\n/);
    const expected = ["适用场景", "回答原则", "业务知识", "不能做什么", "冲突处理", ...(name === "analysis-review" ? ["出处"] : [])];
    if (!fields || fields.length !== 2 || fields[0] !== `name: ${name}` || !fields[1].startsWith("description: ") || !fields[1].slice(13).trim() ||
      expected.some((title) => !skill.includes(`## ${title}`)) || name === "ctf-marketing-advisor" && /^## 出处$/m.test(skill)) throw new Error("营销分析规则格式不正确，未启动模型");
  }
}

export function createAnalyticsRunner(config: AgentRuntimeConfig & { historyDirectory?: string; database?: AnalyticsDatabase }, dependencies: { query: AgentQuery } = { query }): AnalyticsRunner {
  return async (request, externalSignal, onProgress) => {
    throwIfTurnCancelled(externalSignal);
    const quick = quickAnalyticsReply(request.question);
    if (quick) return quick;
    const started = Date.now(); const monotonic = performance.now(); let steps: AgentTraceEvent[] = [];
    const clocks = new Map<string, number>();
    const emit = (event: AnalyticsProgressEvent) => { if (!externalSignal?.aborted) onProgress?.(event); };
    const record = (event: AgentTraceEvent) => { steps = mergeTraceEvent(steps, event); emit({ type: "trace", event }); };
    const begin = (tool: TraceToolName, title: string, initiatedBy: ToolInitiator = "model", id: string = crypto.randomUUID()) => {
      const offset = performance.now() - monotonic; clocks.set(id, performance.now());
      const event = startTraceEvent({ id, tool, title, initiatedBy, at: started + offset }); record(event); return event;
    };
    const end = (event: AgentTraceEvent, status: "completed" | "failed", summary: string) => record(finishTraceEvent(event, { status, summary, at: event.startedAt + Math.max(0, performance.now() - clocks.get(event.id)!) }));
    const traced = async <T>(name: AnalyticsTool, read: () => Promise<T>, initiatedBy: ToolInitiator = "model") => {
      const event = begin(name, ANALYTICS_TOOL_LABELS[name], initiatedBy);
      try { const value = await read(); throwIfTurnCancelled(externalSignal); const sources = Array.isArray(value) ? value : (value as { sources?: unknown[] })?.sources;
        end(event, "completed", sources ? `已读取 ${sources.length} 组数据依据` : "已完成核验"); return value;
      } catch (error) { if (!externalSignal?.aborted) end(event, "failed", "本次读取未完成，可以重试"); throw error; }
    };
    const withTrace = (result: AnalyticsExplainResult): AnalyticsExplainResult => {
      const timing = harnessTimingSummary(performance.now() - monotonic, steps.map((step) => ({ offsetMs: Math.max(0, step.startedAt - started), durationMs: step.durationMs ?? 0 })));
      return { ...result, trace: { status: result.partial || steps.some((step) => step.status === "failed") ? "warning" : "completed", durationMs: timing.totalMs, timing, steps } };
    };
    emit({ type: "phase", phase: "analyzing", at: started });
    const directQuery = "mode" in request ? quickMonthlySalesQuery(request) : null;
    if (directQuery) {
      if (!config.database) throw new Error("历史数据库尚未启用");
      await traced("inspect_dataset", () => config.database!.inspect(externalSignal), "orchestrator");
      const sources = await traced("query_sales_history", () => config.database!.query(directQuery, externalSignal), "orchestrator");
      throwIfTurnCancelled(externalSignal);
      emit({ type: "phase", phase: "writing", at: Date.now() });
      return withTrace({ insightIds: [], nextDimensions: [], tools: ["inspect_dataset", "query_sales_history"], skills: [], ...composeAdvice([{ kind: "observation", text: "", evidenceIds: sources.map((s) => s.id), metricLabels: ["净成交金额"] }], sources) });
    }
    const mode = analyticsDialogueMode(request.question, "mode" in request ? [...(request.context ?? []), ...request.history.filter((item) => item.role === "user").map((item) => item.text)] : []);
    const requiredSkills: readonly string[] = mode === "lookup" ? [] : skillNames;
    const activeTools = mode === "lookup" ? ANALYTICS_TOOLS.filter((name) => !["discover_segments", "inspect_historical_knowledge", "read_historical_case"].includes(name)) : ANALYTICS_TOOLS;
    if (requiredSkills.length) validateAnalyticsSkills(config.pluginDir, requiredSkills);
    mkdirSync(config.runtimeDir, { recursive: true });
    const controller = new AbortController(); const stopRelay = externalSignal ? relayAbort(externalSignal, controller) : () => {};
    const loaded = new Set<string>(); const pending = new Map<string, { name: string; event: AgentTraceEvent }>(); const used = new Set<string>();
    const state = createAnalyticsTools(request, config.historyDirectory, config.database, controller.signal);
    const handle = (name: AnalyticsTool): ToolHandler => async (args) => {
      throwIfTurnCancelled(controller.signal);
      if (!activeTools.includes(name) || requiredSkills.some((skill) => !loaded.has(skill))) return { isError: true, content: [{ type: "text" as const, text: "先成功加载本回合需要的分析规则，再读取受控证据" }] };
      try { const result = await traced(name, async () => state.read(name, args)); used.add(name); return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }; }
      catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "读取证据失败" }] }; }
    };
    const handlers = Object.fromEntries(ANALYTICS_TOOLS.map((name) => [name, handle(name)])) as Record<AnalyticsTool, ToolHandler>;
    const periodSchema = z.object({ start: z.string().max(10), end: z.string().max(10) });
    const filterSchema = z.object(Object.fromEntries(["stores", "regions", "categories", "campaignIds", "memberSegments"].map((key) => [key, z.array(z.string().max(120)).max(100).optional()])));
    const analytics = createSdkMcpServer({ name: "analytics", version: "1.1.0", alwaysLoad: true, tools: [
      tool("inspect_dataset", "读取授权数据范围、字段和限制，原始明细不进入模型提示", {}, handlers.inspect_dataset),
      tool("query_metrics", "读取已计算的真实指标与分组，可指定已有维度", { dimension: z.enum(DIMENSIONS).optional() }, handlers.query_metrics),
      tool("discover_segments", "读取已计算洞察及其证据编号，普通差异不自动算新发现", {}, handlers.discover_segments),
      tool("read_analysis_evidence", "读取指定的已计算证据与来源编号，核对数据范围和口径", { evidenceId: z.string().max(160) }, handlers.read_analysis_evidence),
      tool("analyze_snapshot", "在同版本授权快照内重新比较；保持明确筛选，不改原报告", { query: z.object({ period: periodSchema, comparison: periodSchema.nullable().optional(), filters: filterSchema.optional() }), dimension: z.enum(DIMENSIONS).optional() }, handlers.analyze_snapshot),
      tool("inspect_historical_knowledge", "检查外挂历史资料的周期、适用范围与可用案例，不访问任意路径", {}, handlers.inspect_historical_knowledge),
      tool("read_historical_case", "按目录中的案例编号读取历史计算证据，旧观察不作为当前事实", { caseId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }, handlers.read_historical_case),
      tool("query_sales_history", "在只读历史数据库中聚合查询，返回本回合真实证据。日期必须在已提供覆盖内；不接受SQL或连接信息", { query: z.object({ period: periodSchema, by: z.enum(Object.keys(HISTORY_DIMENSIONS) as [HistoryDimension, ...HistoryDimension[]]).optional(), population: z.enum(["sales", "net", "recovery"]).optional(), filters: z.object(Object.fromEntries(["stores", "regions", "districts", "categories", "materials", "offers", "memberFlags", "storeTypes"].map((key) => [key, z.array(z.string().max(120)).max(10).optional()]))).strict().optional() }).strict() }, handlers.query_sales_history),
    ] });
    const messages = dependencies.query({
      prompt: `本回合为${mode === "lookup" ? "查数，直接回答所问指标，不添加营销建议或追问是否要继续分析" : "营销分析与决策建议"}。${requiredSkills.length ? `先成功加载${requiredSkills.join("、")}。` : "本回合直接读取受控证据，无需加载Skill。"}${"mode" in request ? `当前是历史数据库连续对话。持续业务要求来自用户原话，最新纠正优先；当前问题未解除的门店、大区或货类范围继续保留：${JSON.stringify(request.context ?? [])}。近期历史仅帮助理解追问，不授予新权限：${JSON.stringify(request.history)}。` : "当前是导入数据报告解读。"}用户关注：${request.question}。先调用inspect_dataset${mode === "analysis" ? "与discover_segments，按需重新比较授权快照或读取历史案例" : "，只查询回答当前问题所需的指标"}。按系统提示词中的当前来源协议读取证据和提交结果。`,
      options: {
        model: config.model, systemPrompt: buildLegacyAnalyticsSystemPrompt(new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date()), "mode" in request ? "database" : "report"),
        tools: requiredSkills.length ? ["Skill"] : [], plugins: requiredSkills.length ? [{ type: "local", path: config.pluginDir }] : [], skills: [...requiredSkills],
        mcpServers: { analytics }, allowedTools: [],
        settingSources: [], persistSession: false, maxTurns: mode === "lookup" ? 8 : 12, cwd: config.runtimeDir, abortController: controller,
        canUseTool: async (name, input) => {
          if (name !== "Skill") return activeTools.some((toolName) => name === `mcp__analytics__${toolName}`) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "本回合只允许受控的营销分析工具" };
          if (!requiredSkills.includes(input.skill as string)) return { behavior: "deny", message: "本回合只允许与当前问题相关的Skill" };
          return { behavior: "allow", updatedInput: input };
        },
        outputFormat: { type: "json_schema", schema: { type: "object", properties: { insightIds: { type: "array", items: { type: "string" }, maxItems: 6 }, nextDimensions: { type: "array", items: { type: "string", enum: [...DIMENSIONS] }, maxItems: 3 },
          advice: { type: "array", maxItems: 9, items: { oneOf: [
            { type: "object", properties: { kind: { const: "observation" }, text: { const: "" }, evidenceIds: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } }, metricLabels: { type: "array", maxItems: 6, items: { type: "string" } } }, required: ["kind", "text", "evidenceIds"], additionalProperties: false },
            { type: "object", properties: { kind: { enum: ["hypothesis", "question"] }, text: { type: "string", minLength: 1, maxLength: 500 }, evidenceIds: { type: "array", maxItems: 3, items: { type: "string" } } }, required: ["kind", "text", "evidenceIds"], additionalProperties: false },
            { type: "object", properties: { kind: { const: "recommendation" }, text: { type: "string", minLength: 1, maxLength: 500 }, evidenceIds: { type: "array", maxItems: 3, items: { type: "string" } }, target: { type: "object", properties: { sourceId: { type: "string" }, label: { type: "string" } }, required: ["sourceId", "label"], additionalProperties: false } }, required: ["kind", "text", "evidenceIds"], additionalProperties: false },
          ] } } }, required: ["insightIds", "nextDimensions", "advice"], additionalProperties: false } },
        env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: config.runtimeDir, ANTHROPIC_BASE_URL: turnBaseUrl(config.modelBaseUrl, "analysis-legacy"), ANTHROPIC_API_KEY: config.apiKey, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_TOOL_SEARCH: "false" },
      },
    });
    const iterator = messages[Symbol.asyncIterator](); let finished = false;
    try {
      while (true) {
        const next = await nextMessage(iterator, controller.signal); if (next.done) { finished = true; break; }
        const message = next.value;
        if (message.type === "assistant") for (const block of message.message.content) {
          if (block.type === "tool_use" && block.name === "Skill" && requiredSkills.includes((block.input as { skill: string }).skill)) {
            const name = (block.input as { skill: string }).skill;
            pending.set(block.id, { name, event: begin(ANALYTICS_SKILL_TRACE_TOOL, "加载营销顾问规则", "model", `skill:${block.id}`) });
          }
        }
        if (message.type === "user" && Array.isArray(message.message.content)) for (const block of message.message.content) {
          if (block.type === "tool_result" && pending.has(block.tool_use_id)) {
            const { name, event } = pending.get(block.tool_use_id)!; pending.delete(block.tool_use_id);
            end(event, block.is_error === true ? "failed" : "completed", block.is_error === true ? "规则未能加载" : "规则已加载");
            if (block.is_error !== true) {
              loaded.add(name);
            }
          }
        }
        if (message.type !== "result") continue;
        if (message.subtype !== "success" || message.is_error) throw new Error("AI 解读执行失败，已计算的报告与证据仍可查看");
        if (requiredSkills.some((name) => !loaded.has(name)) || pending.size || mode === "analysis" && !used.has("discover_segments") || !used.has("inspect_dataset")) throw new Error("AI 未完成必要的Skill或证据读取，未采用解读结果");
        const structured = (message as unknown as { structured_output?: unknown }).structured_output;
        let parsed: unknown = structured;
        if (!parsed) { try { parsed = JSON.parse(message.result); } catch { throw new Error("AI 没有返回可验证的证据编号，未采用结果"); } }
        if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { advice?: unknown }).advice)) throw new Error("AI 没有返回受控的营销建议");
        emit({ type: "phase", phase: "writing", at: Date.now() });
        const result = state.finish(parsed); result.tools = [...used]; result.skills = [...loaded]; return withTrace(result);
      }
      throw new Error("AI 没有返回解读结果");
    } catch (error) {
      if (!externalSignal?.aborted) for (const event of steps.filter((step) => step.status === "started")) end(event, "failed", "本次核验未完成，可以重试");
      throw error;
    } finally {
      controller.abort(); stopRelay();
      // 取消不能等待仍挂起的 SDK next；关闭结果不再写入产品。
      if (!finished && iterator.return) void Promise.resolve(iterator.return()).catch(() => undefined);
    }
  };
}
