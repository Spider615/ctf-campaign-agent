import { existsSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../app/lib/agent/prompt.ts";
import { isAgentRequest, type AgentRequest, type AgentResult } from "../app/lib/agent/protocol.ts";
import { encodeAgentStreamEvent } from "../app/lib/agent/stream.ts";
import { AGENT_TOOL_META, AGENT_TOOL_NAMES, createAgentState, FACT_KEYS, finishAgentTurn, runAgentTool, safeToolSummary, type AgentToolName } from "../app/lib/agent/tools.ts";
import { QUESTION_IDS } from "../app/lib/campaign/ics1811/questions.ts";
import type { FactKey, QuestionId } from "../app/lib/campaign/ics1811/types.ts";
import { finishTraceEvent, mergeTraceEvent, startTraceEvent, type AgentTraceEvent } from "../app/lib/tool-trace.ts";

const envFile = fileURLToPath(new URL("../.dev.vars", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const HOST = process.env.AGENT_HOST || "127.0.0.1";
const PORT = Number(process.env.AGENT_PORT || 8788);
const TOKEN = process.env.AGENT_SERVICE_TOKEN || "";
const MODEL = process.env.AGENT_MODEL || "deepseek-flash";
const MODEL_BASE_URL = process.env.AGENT_MODEL_BASE_URL || "https://api.deepseek.com/anthropic";
const API_KEY = process.env.DEEPSEEK_API_KEY || "";
const TURN_TIMEOUT_MS = 120_000;
// AGENT_DEBUG=1 时打印每次工具调用的参数和结果；里面有活动内容，只在本地排查时打开。
const DEBUG = process.env.AGENT_DEBUG === "1";
// SDK 子进程的配置目录，和本机 ~/.claude 隔离：不读用户自己的设置、插件和钩子。
const RUNTIME_DIR = fileURLToPath(new URL("./.claude-runtime/", import.meta.url));

const factKey = z.enum(FACT_KEYS as [FactKey, ...FactKey[]]);
const questionId = z.enum(QUESTION_IDS as [QuestionId, ...QuestionId[]]);

export async function runAgentTurn(request: AgentRequest, onTrace?: (event: AgentTraceEvent) => void): Promise<AgentResult> {
  const state = createAgentState(request);
  const handle = (name: AgentToolName) => async (args: Record<string, unknown>) => {
    const started = startTraceEvent({
      id: crypto.randomUUID(),
      tool: name,
      title: AGENT_TOOL_META[name].title,
      initiatedBy: "model",
      at: Date.now(),
    });
    state.trace = mergeTraceEvent(state.trace, started);
    onTrace?.(started);
    const outcome = runAgentTool(state, name, args);
    const finished = finishTraceEvent(started, {
      status: outcome.isError ? "warning" : "completed",
      summary: safeToolSummary(name, outcome, state),
      at: Date.now(),
    });
    state.trace = mergeTraceEvent(state.trace, finished);
    onTrace?.(finished);
    if (DEBUG) console.log(`[tool] ${name} ${JSON.stringify(args).slice(0, 800)}\n       → ${outcome.isError ? "拒绝：" : ""}${outcome.text.slice(0, 500)}`);
    return { content: [{ type: "text" as const, text: outcome.text }], ...(outcome.isError ? { isError: true } : {}) };
  };

  // SDK 自带的文件、命令行等工具全部关掉，只挂活动工具；工具在本进程里执行，改的是这一轮的工作区。
  const campaign = createSdkMcpServer({
    name: "campaign",
    version: "2.0.0",
    tools: [
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
          // 遇到后工具调用整个失效，模型把调用当成 <｜DSML｜> 文本吐出来（A/B 实测 2/2 复现）。格式由 checkProposal 校验。
          answer: z.unknown(),
        })).optional(),
      }, handle("ask_campaign_questions")),
      tool("draft_campaign_copy", "起草活动名称（不超过 13 个字）和活动内容，只写用户说过的数字，不写标语", {
        name: z.string(),
        content: z.string(),
      }, handle("draft_campaign_copy")),
      tool("draft_promo_copy", "起草对外宣传文案的创意部分：主标题和卖点。日期、门店、优惠力度由系统按事实填充，不要写，也不要写活动标语", {
        headline: z.string(),
        highlights: z.array(z.string()),
      }, handle("draft_promo_copy")),
      tool("generate_ics1811_sheet", "活动信息齐了时查看 ICS-1811 填写值摘要；齐了系统也会自动生成", {}, handle("generate_ics1811_sheet")),
      tool("undo_campaign_change", "撤销上一次修改", {}, handle("undo_campaign_change")),
    ],
  });

  mkdirSync(RUNTIME_DIR, { recursive: true });
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TURN_TIMEOUT_MS);
  const stderr: string[] = [];
  let reply: string | null = null;
  try {
    for await (const message of query({
      prompt: buildAgentUserPrompt(request),
      options: {
        model: MODEL,
        systemPrompt: buildAgentSystemPrompt(request.today),
        tools: [],
        mcpServers: { campaign },
        allowedTools: AGENT_TOOL_NAMES.map((name) => `mcp__campaign__${name}`),
        settingSources: [],
        persistSession: false,
        maxTurns: 10,
        cwd: RUNTIME_DIR,
        abortController,
        stderr: (data) => stderr.push(data),
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          CLAUDE_CONFIG_DIR: RUNTIME_DIR,
          ANTHROPIC_BASE_URL: MODEL_BASE_URL,
          ANTHROPIC_API_KEY: API_KEY,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    })) {
      if (message.type !== "result") continue;
      if (message.subtype === "success") reply = message.result;
      else throw new Error(message.subtype === "error_max_turns" ? "Agent 步骤太多，没在限定步数内完成" : "Agent 执行出错");
    }
  } catch (error) {
    if (abortController.signal.aborted) throw new Error("Agent 超时了，请重试");
    const tail = stderr.join("").slice(-1500);
    if (tail) console.error(tail);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return finishAgentTurn(state, reply);
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 2_000_000) throw new Error("请求太大");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true, model: MODEL });
  const isTurn = request.method === "POST" && request.url === "/turn";
  const isStream = request.method === "POST" && request.url === "/turn/stream";
  if (!isTurn && !isStream) return send(response, 404, { error: "没有这个接口" });
  if (TOKEN && request.headers.authorization !== `Bearer ${TOKEN}`) return send(response, 401, { error: "Agent 服务鉴权失败" });

  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return send(response, 400, { error: "请求不是有效的 JSON" });
  }
  if (!isAgentRequest(body)) return send(response, 400, { error: "请求内容不完整" });

  const started = Date.now();
  if (isStream) {
    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    });
    try {
      const result = await runAgentTurn(body, (event) => response.write(encodeAgentStreamEvent({ type: "trace", event })));
      console.log(`[agent] ${body.trigger.kind} ${Date.now() - started}ms 工具：${result.tools.join(" → ") || "无"}${result.dropped.length ? ` 丢弃 ${result.dropped.length} 项` : ""}`);
      response.end(encodeAgentStreamEvent({ type: "result", result }));
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "Agent 执行失败";
      console.error(`[agent] ${body.trigger.kind} 失败（${Date.now() - started}ms）：${message}`);
      response.end(encodeAgentStreamEvent({ type: "error", error: message }));
    }
    return;
  }
  try {
    const result = await runAgentTurn(body);
    console.log(`[agent] ${body.trigger.kind} ${Date.now() - started}ms 工具：${result.tools.join(" → ") || "无"}${result.dropped.length ? ` 丢弃 ${result.dropped.length} 项` : ""}`);
    send(response, 200, result);
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : "Agent 执行失败";
    console.error(`[agent] ${body.trigger.kind} 失败（${Date.now() - started}ms）：${message}`);
    send(response, 502, { error: message });
  }
});

if (!API_KEY) {
  console.error("缺少 DEEPSEEK_API_KEY：在仓库根目录的 .dev.vars 里填写。");
  process.exit(1);
}
server.listen(PORT, HOST, () => console.log(`Agent 服务已启动：http://${HOST}:${PORT}（模型 ${MODEL}）`));
