import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { isAgentRequest } from "../app/lib/agent/protocol.ts";
import { encodeAgentStreamEvent } from "../app/lib/agent/stream.ts";
import { finishTraceEvent, harnessTimingSummary, mergeTraceEvent, type AgentTraceEvent } from "../app/lib/tool-trace.ts";
import { createAgentRunner } from "./run-turn.ts";

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
// 业务规则所在的本地插件（agent/plugin/skills/*/SKILL.md），每轮按需加载。
const PLUGIN_DIR = fileURLToPath(new URL("./plugin/", import.meta.url));

const runAgentTurn = createAgentRunner({
  model: MODEL,
  modelBaseUrl: MODEL_BASE_URL,
  apiKey: API_KEY,
  runtimeDir: RUNTIME_DIR,
  pluginDir: PLUGIN_DIR,
  timeoutMs: TURN_TIMEOUT_MS,
  debug: DEBUG,
});

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
  const startedMonotonic = performance.now();
  if (isStream) {
    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
    });
    let traceEvents: AgentTraceEvent[] = [];
    const emitTrace = (event: AgentTraceEvent) => {
      traceEvents = mergeTraceEvent(traceEvents, event);
      response.write(encodeAgentStreamEvent({ type: "trace", event }));
    };
    try {
      const result = await runAgentTurn(
        body,
        emitTrace,
        (event) => response.write(encodeAgentStreamEvent(event)),
      );
      console.log(`[agent] ${body.trigger.kind} ${Date.now() - started}ms 工具：${result.tools.join(" → ") || "无"}${result.dropped.length ? ` 丢弃 ${result.dropped.length} 项` : ""}`);
      response.end(encodeAgentStreamEvent({ type: "result", result }));
    } catch (error) {
      // 在 Agent 进程内结束仍在执行的步骤，避免 Workers 用另一台机器的墙钟相减。
      for (const event of traceEvents.filter((item) => item.status === "started")) {
        emitTrace(finishTraceEvent(event, {
          status: "failed",
          summary: "执行中断，可以重试",
          at: Date.now(),
        }));
      }
      const message = error instanceof Error && error.message ? error.message : "Agent 执行失败";
      console.error(`[agent] ${body.trigger.kind} 失败（${Date.now() - started}ms）：${message}`);
      const totalMs = Math.max(0, performance.now() - startedMonotonic);
      const timing = harnessTimingSummary(totalMs, traceEvents
        .filter((event) => event.status !== "started")
        .map((event) => ({
          offsetMs: Math.max(0, event.startedAt - started),
          durationMs: event.durationMs ?? 0,
        })));
      response.end(encodeAgentStreamEvent({ type: "error", error: message, timing }));
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
