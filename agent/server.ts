import { existsSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../app/lib/agent/prompt.ts";
import { isAgentRequest, type AgentRequest, type AgentResult } from "../app/lib/agent/protocol.ts";
import { AGENT_TOOL_NAMES, createAgentState, finishAgentTurn, runAgentTool, type AgentToolName } from "../app/lib/agent/tools.ts";
import { CLARIFY_ORDER, type ClarifyKey } from "../app/lib/campaign/clarify.ts";

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

const clarifyKey = z.enum(CLARIFY_ORDER as [ClarifyKey, ...ClarifyKey[]]);

async function runAgentTurn(request: AgentRequest): Promise<AgentResult> {
  const state = createAgentState(request);
  const handle = (name: AgentToolName) => async (args: Record<string, unknown>) => {
    const outcome = runAgentTool(state, name, args);
    if (DEBUG) console.log(`[tool] ${name} ${JSON.stringify(args).slice(0, 800)}\n       → ${outcome.isError ? "拒绝：" : ""}${outcome.text.slice(0, 500)}`);
    return { content: [{ type: "text" as const, text: outcome.text }], ...(outcome.isError ? { isError: true } : {}) };
  };

  // SDK 自带的文件、命令行等工具全部关掉，只挂活动工具；工具在本进程里执行，改的是这一轮的工作区。
  const campaign = createSdkMcpServer({
    name: "campaign",
    version: "1.0.0",
    tools: [
      tool("update_fields", "写入用户明确说过的活动信息；工具校验原话依据后返回最新状态", {
        changes: z.array(z.object({
          path: z.string(),
          value: z.unknown().optional(),
          op: z.enum(["replace", "add", "remove"]).optional(),
          reason: z.string().optional(),
        })),
        title: z.string().optional(),
      }, handle("update_fields")),
      tool("ask_user", "给用户出一张补充卡片，然后结束本轮，等用户提交", {
        keys: z.array(clarifyKey),
        confirm: z.array(clarifyKey).optional(),
        intro: z.string().optional(),
        segments: z.array(z.string()).optional(),
        series: z.array(z.string()).optional(),
      }, handle("ask_user")),
      tool("write_plan", "写方案文案并保存；没通过开单规则会返回原因", {
        externalName: z.string(),
        icsName: z.string(),
        content: z.string(),
        slogan: z.string(),
      }, handle("write_plan")),
      tool("undo_last_change", "撤销上一次修改", {}, handle("undo_last_change")),
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
  if (request.method !== "POST" || request.url !== "/turn") return send(response, 404, { error: "没有这个接口" });
  if (TOKEN && request.headers.authorization !== `Bearer ${TOKEN}`) return send(response, 401, { error: "Agent 服务鉴权失败" });

  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return send(response, 400, { error: "请求不是有效的 JSON" });
  }
  if (!isAgentRequest(body)) return send(response, 400, { error: "请求内容不完整" });

  const started = Date.now();
  try {
    const result = await runAgentTurn(body);
    console.log(`[agent] ${body.trigger.kind} ${Date.now() - started}ms 工具：${result.tools.join(" → ") || "无"}`);
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
