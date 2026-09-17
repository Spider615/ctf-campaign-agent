import { mkdirSync } from "node:fs";

import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../app/lib/agent/prompt.ts";
import type { AgentRequest, AgentResult } from "../app/lib/agent/protocol.ts";
import { createReplyStreamState, reduceReplyStream } from "../app/lib/agent/reply-stream.ts";
import type { AgentProgressEvent } from "../app/lib/agent/stream.ts";
import {
  AGENT_TOOL_META,
  AGENT_TOOL_NAMES,
  createAgentState,
  FACT_KEYS,
  finishAgentTurn,
  safeToolSummary,
  type AgentToolName,
} from "../app/lib/agent/tools.ts";
import { CAMPAIGN_BRIEF_KEYS } from "../app/lib/campaign/brief.ts";
import { routeCampaign } from "../app/lib/campaign/workspace.ts";
import type { CampaignBriefKey } from "../app/lib/campaign/types.ts";
import { QUESTION_IDS } from "../app/lib/campaign/ics1811/questions.ts";
import type { FactKey, QuestionId } from "../app/lib/campaign/ics1811/types.ts";
import { finishTraceEvent, harnessTimingSummary, mergeTraceEvent, startTraceEvent, type AgentTraceEvent } from "../app/lib/tool-trace.ts";
import {
  beginSkillLoad,
  createSkillLoadState,
  finishPendingSkillLoads,
  finishSkillCheckedTurn,
  finishSkillLoad,
  loadSkillCatalog,
  qualifiedSkillNames,
  requiredSkillsForTurn,
  skillOf,
} from "./skills.ts";
import { runCampaignToolWithSkillGate } from "./tool-gate.ts";

export type AgentRuntimeConfig = {
  model: string;
  modelBaseUrl: string;
  apiKey: string;
  runtimeDir: string;
  pluginDir: string;
  timeoutMs: number;
  debug?: boolean;
};

export type AgentTurnRunner = (
  request: AgentRequest,
  onTrace?: (event: AgentTraceEvent) => void,
  onProgress?: (event: Exclude<AgentProgressEvent, { type: "trace" }>) => void,
) => Promise<AgentResult>;

export type AgentQuery = (
  params: Parameters<typeof query>[0],
) => AsyncIterable<SDKMessage>;

export type AgentRuntimeDependencies = {
  query: AgentQuery;
};

const DEFAULT_AGENT_RUNTIME_DEPENDENCIES: AgentRuntimeDependencies = { query };

const factKey = z.enum(FACT_KEYS as [FactKey, ...FactKey[]]);
const campaignBriefKey = z.enum(CAMPAIGN_BRIEF_KEYS as [CampaignBriefKey, ...CampaignBriefKey[]]);
const questionId = z.enum(QUESTION_IDS as [QuestionId, ...QuestionId[]]);

export function createAgentRunner(
  config: AgentRuntimeConfig,
  dependencies: AgentRuntimeDependencies = DEFAULT_AGENT_RUNTIME_DEPENDENCIES,
): AgentTurnRunner {
  return async (request, onTrace, onProgress) => {
    const turnStartedAt = Date.now();
    const turnStartedMonotonic = performance.now();
    const catalog = loadSkillCatalog(config.pluginDir);
    const state = createAgentState(request);
    const routing = routeCampaign(state.campaign);
    const requiredSkills = requiredSkillsForTurn(request, {
      hasIcs1811: Boolean(state.draft),
      tracks: routing.tracks,
    });
    const skillLoads = createSkillLoadState();
    let replyStream = createReplyStreamState();
    let publicPhase: "analyzing" | "writing" | null = null;
    const setPublicPhase = (phase: "analyzing" | "writing") => {
      if (phase === publicPhase) return;
      publicPhase = phase;
      onProgress?.({ type: "phase", phase, at: Date.now() });
    };
    setPublicPhase("analyzing");
    const recordSkill = (event: AgentTraceEvent) => {
      state.trace = mergeTraceEvent(state.trace, event);
      onTrace?.(event);
    };

    const handle = (name: AgentToolName) => async (args: Record<string, unknown>) => {
      setPublicPhase("analyzing");
      const started = startTraceEvent({
        id: crypto.randomUUID(),
        tool: name,
        title: AGENT_TOOL_META[name].title,
        initiatedBy: "model",
        at: Date.now(),
      });
      state.trace = mergeTraceEvent(state.trace, started);
      onTrace?.(started);
      const outcome = runCampaignToolWithSkillGate(
        state,
        name,
        args,
        skillLoads.loadedSkills,
      );
      const finished = finishTraceEvent(started, {
        status: outcome.isError ? "warning" : "completed",
        summary: safeToolSummary(name, outcome, state),
        at: Date.now(),
      });
      state.trace = mergeTraceEvent(state.trace, finished);
      onTrace?.(finished);
      if (config.debug) {
        console.log(`[tool] ${name} ${JSON.stringify(args).slice(0, 800)}\n       → ${outcome.isError ? "拒绝：" : ""}${outcome.text.slice(0, 500)}`);
      }
      return {
        content: [{ type: "text" as const, text: outcome.text }],
        ...(outcome.isError ? { isError: true } : {}),
      };
    };

    // SDK 只开放 Skill；活动读写仍由这些确定性工具完成。
    const campaign = createSdkMcpServer({
      name: "campaign",
      version: "2.0.0",
      tools: [
        tool("update_campaign_brief", "按用户这一轮的原话整理活动 Brief，不得猜测或补写用户没说的信息", {
          writes: z.array(z.object({
            key: campaignBriefKey,
            value: z.unknown().optional(),
            quote: z.string(),
          })),
        }, handle("update_campaign_brief")),
        tool("analyze_campaign_plan", "运行确定性的活动 Brief、执行轨、产物与上线准备分析，返回整体活动状态", {}, handle("analyze_campaign_plan")),
        tool("extract_campaign_facts", "记下用户这一轮明确说过的活动信息，每项附原话片段；工具核对后返回还缺什么", {
          facts: z.array(z.object({
            key: factKey,
            value: z.unknown().optional(),
            quote: z.string(),
          })),
        }, handle("extract_campaign_facts")),
        tool("accept_campaign_proposals", "用户同意你上一句的提议时，按提议记下；quote 取用户表示同意的原话，只同意其中几项时列出题号", {
          quote: z.string(),
          questions: z.array(questionId).optional(),
        }, handle("accept_campaign_proposals")),
        tool("lookup_ics_reference", "查询 ICS 演示代码表，不修改草稿", {
          query: z.string().min(1).max(120),
        }, handle("lookup_ics_reference")),
        tool("analyze_campaign_state", "运行确定性的 1811 字段推导、缺项和校验，返回还缺的题号和是否已经齐了", {}, handle("analyze_campaign_state")),
        tool("ask_campaign_questions", "登记这句回复要问用户的问题（题号），可附带提议的具体值；登记后在回复里用自己的话问", {
          questions: z.array(questionId),
          proposals: z.array(z.object({
            question: questionId,
            // 不能写 z.record：它生成的 JSON Schema 带 propertyNames，DeepSeek 的 Anthropic 兼容接口
            // 遇到后工具调用整个失效。answer 的具体格式由确定性 checkProposal 校验。
            answer: z.unknown(),
          })).optional(),
        }, handle("ask_campaign_questions")),
        tool("draft_campaign_copy", "起草活动名称（不超过 13 个字）和活动内容，只写用户说过的数字，不写标语", {
          name: z.string(),
          content: z.string(),
        }, handle("draft_campaign_copy")),
        tool("draft_promo_copy", "起草对外宣传文案的创意部分：主标题和卖点。日期、门店、优惠力度由系统按事实填充，不要写，也不要写活动标语；必须先加载 ics1811:promo-copy-guide", {
          headline: z.string(),
          highlights: z.array(z.string()),
        }, handle("draft_promo_copy")),
        tool("generate_ics1811_sheet", "活动信息齐了时查看 ICS-1811 填写值摘要；齐了系统也会自动生成", {}, handle("generate_ics1811_sheet")),
        tool("undo_campaign_change", "撤销上一次修改", {}, handle("undo_campaign_change")),
      ],
    });

    mkdirSync(config.runtimeDir, { recursive: true });
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), config.timeoutMs);
    const stderr: string[] = [];
    let reply: string | null = null;

    try {
      for await (const message of dependencies.query({
        prompt: buildAgentUserPrompt(request, requiredSkills),
        options: {
          model: config.model,
          systemPrompt: buildAgentSystemPrompt(request.today),
          tools: ["Skill"],
          plugins: [{ type: "local" as const, path: config.pluginDir }],
          skills: qualifiedSkillNames(catalog),
          mcpServers: { campaign },
          allowedTools: AGENT_TOOL_NAMES.map((name) => `mcp__campaign__${name}`),
          settingSources: [],
          persistSession: false,
          maxTurns: 12,
          includePartialMessages: true,
          cwd: config.runtimeDir,
          abortController,
          stderr: (data) => stderr.push(data),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            CLAUDE_CONFIG_DIR: config.runtimeDir,
            ANTHROPIC_BASE_URL: config.modelBaseUrl,
            ANTHROPIC_API_KEY: config.apiKey,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          },
        },
      })) {
        if (message.type === "stream_event") {
          const reduced = reduceReplyStream(replyStream, {
            parentToolUseId: message.parent_tool_use_id,
            event: message.event,
          });
          replyStream = reduced.state;
          for (const action of reduced.actions) {
            if (action.type === "text_delta") setPublicPhase("writing");
            if (action.type === "text_reset") setPublicPhase("analyzing");
            onProgress?.(action);
          }
        }
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type !== "tool_use" || block.name !== "Skill") continue;
            const requested = (block.input as { skill?: unknown }).skill;
            recordSkill(beginSkillLoad(catalog, skillLoads, {
              id: block.id,
              requested,
              at: Date.now(),
            }));
            if (config.debug) {
              const skill = skillOf(catalog, requested);
              console.log(`[skill] ${skill ? `${skill.qualifiedName}（${skill.title}）` : "未知规则"}`);
            }
          }
        }
        if (message.type === "user" && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type !== "tool_result") continue;
            const event = finishSkillLoad(skillLoads, {
              toolUseId: block.tool_use_id,
              isError: block.is_error === true,
              at: Date.now(),
            });
            if (event) recordSkill(event);
          }
        }
        if (message.type !== "result") continue;
        // SDK 的 success 结果仍可能用 is_error 标记 API 错误，不能把错误文本当正常回复落库。
        if (message.subtype === "success" && message.is_error !== true) reply = message.result;
        else {
          throw new Error(
            message.subtype === "error_max_turns"
              ? "Agent 步骤太多，没在限定步数内完成"
              : "Agent 执行出错",
          );
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) throw new Error("Agent 超时了，请重试");
      const tail = stderr.join("").slice(-1500);
      if (tail) console.error(tail);
      throw error;
    } finally {
      for (const event of finishPendingSkillLoads(skillLoads, Date.now())) recordSkill(event);
      clearTimeout(timer);
    }

    const result = finishSkillCheckedTurn(
      requiredSkills,
      skillLoads,
      () => finishAgentTurn(state, reply),
    );
    if (result.trace) {
      result.trace.timing = harnessTimingSummary(
        Math.max(0, performance.now() - turnStartedMonotonic),
        result.trace.steps.map((step) => ({
          offsetMs: Math.max(0, step.startedAt - turnStartedAt),
          durationMs: step.durationMs ?? 0,
        })),
      );
    }
    return result;
  };
}
