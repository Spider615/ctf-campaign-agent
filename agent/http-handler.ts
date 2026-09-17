import type { IncomingMessage, ServerResponse } from "node:http";

import { isAgentRequest } from "../app/lib/agent/protocol.ts";
import { encodeAgentStreamEvent, type AgentStreamEvent } from "../app/lib/agent/stream.ts";
import { isTurnCancelled, TurnCancelledError } from "../app/lib/cancellation.ts";
import { finishTraceEvent, harnessTimingSummary, mergeTraceEvent, type AgentTraceEvent } from "../app/lib/tool-trace.ts";
import type { AgentTurnRunner } from "./run-turn.ts";

type AgentHttpOptions = {
  runAgentTurn: AgentTurnRunner;
  token: string;
  model: string;
  logger?: Pick<Console, "log" | "error">;
};

function send(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed || response.writableEnded) return;
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

export function createAgentHttpHandler({ runAgentTurn, token, model, logger = console }: AgentHttpOptions) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true, model });
    const isTurn = request.method === "POST" && request.url === "/turn";
    const isStream = request.method === "POST" && request.url === "/turn/stream";
    if (!isTurn && !isStream) return send(response, 404, { error: "没有这个接口" });
    if (token && request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: "Agent 服务鉴权失败" });

    // 读请求体之前接上取消链路，同时覆盖绑定监听前已经断开的连接。
    const requestController = new AbortController();
    const abortDisconnected = () => {
      if (!response.writableEnded && !requestController.signal.aborted) requestController.abort();
    };
    request.on("aborted", abortDisconnected);
    response.on("close", abortDisconnected);
    if (request.aborted || response.destroyed) abortDisconnected();

    try {
      if (requestController.signal.aborted) return;
      let body: unknown;
      try {
        body = await readJson(request);
      } catch (error) {
        if (requestController.signal.aborted || isTurnCancelled(error)) return;
        return send(response, 400, { error: "请求不是有效的 JSON" });
      }
      if (requestController.signal.aborted) return;
      if (!isAgentRequest(body)) return send(response, 400, { error: "请求内容不完整" });

      const started = Date.now();
      const startedMonotonic = performance.now();
      if (isStream) {
        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        });
        const writeEvent = (event: AgentStreamEvent) => {
          if (requestController.signal.aborted || response.destroyed || response.writableEnded) return false;
          response.write(encodeAgentStreamEvent(event));
          return true;
        };
        let traceEvents: AgentTraceEvent[] = [];
        const emitTrace = (event: AgentTraceEvent) => {
          if (!writeEvent({ type: "trace", event })) return;
          traceEvents = mergeTraceEvent(traceEvents, event);
        };
        try {
          const result = await runAgentTurn(body, emitTrace, writeEvent, requestController.signal);
          if (requestController.signal.aborted) throw new TurnCancelledError();
          logger.log(`[agent] ${body.trigger.kind} ${Date.now() - started}ms 工具：${result.tools.join(" → ") || "无"}${result.dropped.length ? ` 丢弃 ${result.dropped.length} 项` : ""}`);
          if (writeEvent({ type: "result", result })) response.end();
        } catch (error) {
          if (requestController.signal.aborted || isTurnCancelled(error)) return;
          // 在 Agent 进程内结束仍在执行的步骤，避免 Workers 用另一台机器的墙钟相减。
          for (const event of traceEvents.filter((item) => item.status === "started")) {
            emitTrace(finishTraceEvent(event, {
              status: "failed",
              summary: "执行中断，可以重试",
              at: Date.now(),
            }));
          }
          const message = error instanceof Error && error.message ? error.message : "Agent 执行失败";
          logger.error(`[agent] ${body.trigger.kind} 失败（${Date.now() - started}ms）：${message}`);
          const totalMs = Math.max(0, performance.now() - startedMonotonic);
          const timing = harnessTimingSummary(totalMs, traceEvents
            .filter((event) => event.status !== "started")
            .map((event) => ({
              offsetMs: Math.max(0, event.startedAt - started),
              durationMs: event.durationMs ?? 0,
            })));
          if (writeEvent({ type: "error", error: message, timing })) response.end();
        }
        return;
      }
      try {
        const result = await runAgentTurn(body, undefined, undefined, requestController.signal);
        if (requestController.signal.aborted) throw new TurnCancelledError();
        logger.log(`[agent] ${body.trigger.kind} ${Date.now() - started}ms 工具：${result.tools.join(" → ") || "无"}${result.dropped.length ? ` 丢弃 ${result.dropped.length} 项` : ""}`);
        send(response, 200, result);
      } catch (error) {
        if (requestController.signal.aborted || isTurnCancelled(error)) return;
        const message = error instanceof Error && error.message ? error.message : "Agent 执行失败";
        logger.error(`[agent] ${body.trigger.kind} 失败（${Date.now() - started}ms）：${message}`);
        send(response, 502, { error: message });
      }
    } finally {
      request.off("aborted", abortDisconnected);
      response.off("close", abortDisconnected);
    }
  };
}
