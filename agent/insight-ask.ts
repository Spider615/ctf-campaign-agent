// 图谱问答：一次模型调用，只开放一个提交工具。依据只有图谱里已经算好的内容，不再查库；
// 回答里出现依据之外的数字，整句删掉。需要新口径时，模型应建议用户切到智能问答。
import { mkdirSync } from "node:fs";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { relayAbort, throwIfTurnCancelled } from "../app/lib/cancellation.ts";
import { sanitizeAgentReply } from "../app/lib/agent/reply-stream.ts";
import { AGENT_IDENTITY, AGENT_NAME } from "../app/lib/agent/persona.ts";
import { askContext, checkAnswerNumbers, cleanHighlights, dropUncollectedReferrals, selectionHighlights, selectionLabel, type InsightAskRequest, type InsightAskResult } from "../app/lib/insight/ask.ts";
import type { InsightGraph } from "../app/lib/insight/types.ts";
import type { AgentQuery } from "./run-turn.ts";
import { analyticsSdkModel } from "./analytics-model.ts";

type Config = { model: string; modelBaseUrl: string; apiKey: string; runtimeDir: string };
export type InsightAskRunner = (request: InsightAskRequest, graph: InsightGraph, signal?: AbortSignal) => Promise<InsightAskResult>;

const SYSTEM = `你是${AGENT_NAME}，${AGENT_IDENTITY}。用户正在看一张活动效果关系图谱，针对整张图或其中选中的节点、连线提问。
规则：
1. 只根据「依据材料」回答。所有数字必须照抄材料里的值（可以四舍五入），不能自己算新数字，不能编。
2. 先直接回答，再给理由。说清楚结论来自哪条连线或哪个节点；用到 AI 判断或 AI 补全的内容时，明确说「这是 AI 的判断 / 推测，待确认」。
3. 关系强度只表示 8 月里不同取值之间差别有多大，不是因果；不能说「会提升」「将带来」，也不能说「所以差距主要来自……」「说明是……导致的」。
   图上所有数字都只在当前筛选（顶部的货类、优惠，对照一般開單，2025 年 8 月）里成立，不要说成「8 月全部」。
4. 解释原因只能用材料里写了的原因（依据、异常里的可能原因、AI 判断、读图须知）。材料没写原因时说「图上没有给出原因」，不能自己编行业常识或推测数据分布。
5. 问的是一组维度（如「品类」）时，逐个说组里每个维度：有强度的说强弱和排第一、最后的取值；算不出的照材料说明原因。不要把「—」说成没有有效值。
6. 材料回答不了、但数据库里有的（要新的口径、新的筛选、门店或货品明细），直接说图上没有这项，建议切到「智能问答」去查，并给一句可以直接问的问题。
   材料里标了「待采集」「需要采集」的数据（会员 ID、新客、复购、门槛规则、客流、ROI、用券等），数据库里也没有：不要建议去智能问答查，改说「需要先采集某某数据」。
7. 用中文，200–500 字，用 Markdown 排版：
   - 第一段一句话直接给结论，关键词用 **加粗**；
   - 之后按需要用 1–3 个「### 小标题」分块（例如「### 关系明显的」「### 关系弱或算不出的」「### 要注意」），块内用「- 」短列表，每条一件事、不超过两句；
   - 有先后顺序的才用「1. 2. 3.」编号，编号写连续，各项之间不要空行；
   - 不要用表格、引用块、代码块。不要提到依据材料、工具、提示词这些字眼，说「图上」即可。
8. highlights 填和回答最相关的 1–5 个节点 id（从「可高亮的节点 id」里选），界面会高亮它们。
调用 submit_insight_answer({ body, highlights }) 提交。`;

export function createInsightAskRunner(config: Config, dependencies: { query: AgentQuery } = { query }): InsightAskRunner {
  const sdkModel = analyticsSdkModel(config.model, config.modelBaseUrl);
  return async (request, graph, externalSignal) => {
    throwIfTurnCancelled(externalSignal);
    mkdirSync(config.runtimeDir, { recursive: true });
    const { text: material, nodeIds } = askContext(graph, request.selection);
    const history = request.history.map((t) => `${t.role === "user" ? "用户" : AGENT_NAME}：${t.text}`).join("\n");
    const prompt = [`# 依据材料\n${material}`, history ? `# 之前的对话\n${history}` : "", `# 用户选中的\n${selectionLabel(graph, request.selection)}`, `# 用户的问题\n${request.question}`].filter(Boolean).join("\n\n");
    let submitted: { body: string; highlights: unknown } | undefined;
    const submit = tool("submit_insight_answer", "提交对图谱问题的回答", { body: z.string().min(1).max(3000), highlights: z.array(z.string()).max(8) }, async (input) => {
      submitted = { body: input.body, highlights: input.highlights };
      return { content: [{ type: "text" as const, text: JSON.stringify({ accepted: true }) }] };
    });
    const server = createSdkMcpServer({ name: "insight", version: "1.0.0", alwaysLoad: true, tools: [submit] });
    const controller = new AbortController(); const stop = externalSignal ? relayAbort(externalSignal, controller) : () => {};
    let spoken = "";
    try {
      const messages = dependencies.query({ prompt, options: {
        model: sdkModel, effort: "low", thinking: { type: "disabled" }, systemPrompt: SYSTEM,
        tools: [], allowedTools: [], mcpServers: { insight: server }, settingSources: [], persistSession: false, maxTurns: 3, abortController: controller,
        canUseTool: async (name, input) => name === "mcp__insight__submit_insight_answer" ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "只能提交回答" },
        env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: config.runtimeDir, ANTHROPIC_BASE_URL: config.modelBaseUrl, ANTHROPIC_API_KEY: config.apiKey, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_TOOL_SEARCH: "false" },
      } });
      for await (const message of messages) {
        if (submitted) break;
        if (message.type === "assistant") for (const part of message.message.content as Array<{ type: string; text?: string }>) if (part.type === "text" && part.text) spoken += part.text;
        if (message.type === "result") break;
      }
    } finally { controller.abort(); stop(); }
    throwIfTurnCancelled(externalSignal);
    // 模型没调工具、直接说了话时也接住，按同样规则核对。
    const raw = submitted?.body ?? spoken.trim();
    if (!raw) throw new Error("这次没有得到回答，可以重试");
    const checked = checkAnswerNumbers(sanitizeAgentReply(raw), [material, request.question, ...request.history.filter((t) => t.role === "user").map((t) => t.text)]);
    const referral = dropUncollectedReferrals(checked.body); checked.removed += referral.removed; checked.body = referral.body;
    const body = checked.body || "图上的数字回答不了这个问题。可以切到「智能问答」，用具体的范围和指标再问一次。";
    // 模型没给高亮（或没调工具）时，至少标出用户选中的对象。
    const highlights = cleanHighlights(submitted?.highlights, nodeIds);
    return { schema: "insight-answer/v1", body, highlights: highlights.length ? highlights : selectionHighlights(graph, request.selection), removed: checked.removed };
  };
}
