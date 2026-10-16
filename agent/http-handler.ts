import { visualizationCapability } from "../app/lib/analytics/visualization.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

import { isAgentRequest } from "../app/lib/agent/protocol.ts";
import { mentionsUnderlyingModel } from "../app/lib/agent/reply-stream.ts";
import { encodeAgentStreamEvent, type AgentStreamEvent } from "../app/lib/agent/stream.ts";
import { isTurnCancelled, TurnCancelledError } from "../app/lib/cancellation.ts";
import { finishTraceEvent, harnessTimingSummary, mergeTraceEvent, type AgentTraceEvent } from "../app/lib/tool-trace.ts";
import type { AgentTurnRunner } from "./run-turn.ts";
import { isAnalyticsExplainRequest } from "../app/lib/analytics/explain.ts";
import type { AnalyticsRunner } from "./analytics-run-turn.ts";
import type { GeneralAnalyticsRunner } from "./general-analytics-run-turn.ts";
import { isDatabaseExplainRequest, type AnalyticsDatabase } from "../app/lib/analytics/database.ts";
import { quickAnalyticsReply } from "../app/lib/analytics/dialogue.ts";
import { encodeAnalyticsStreamEvent, type AnalyticsStreamEvent } from "../app/lib/analytics/stream.ts";

type AgentHttpOptions = {
  runAgentTurn: AgentTurnRunner;
  runAnalyticsTurn?: AnalyticsRunner;
  runGeneralAnalyticsTurn?: GeneralAnalyticsRunner;
  database?: AnalyticsDatabase;
  token: string;
  model: string;
  logger?: Pick<Console, "log" | "error">;
  attachmentHandler?: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
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

// 报错原文会显示在对话里。SDK 进程出错时带着底层框架的名字（如 Claude Code），对外换成通用说法，原文只进日志。
function publicError(message: string): string {
  return mentionsUnderlyingModel(message) ? "Agent 执行出错" : message;
}

export function createAgentHttpHandler({ runAgentTurn, runAnalyticsTurn, runGeneralAnalyticsTurn, database, token, model, logger = console, attachmentHandler }: AgentHttpOptions) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true, model });
    const isTurn = request.method === "POST" && request.url === "/turn";
    const isStream = request.method === "POST" && request.url === "/turn/stream";
    const isAnalytics = request.method === "POST" && request.url === "/analytics/explain";
    const isDatabase = request.method === "POST" && request.url === "/analytics/database/explain";
    const isDatabaseStream = request.method === "POST" && request.url === "/analytics/database/explain/stream";
    const isDatabaseInfo = request.method === "GET" && request.url === "/analytics/database";
    const isAttachment = Boolean(attachmentHandler) && /^\/attachments(?:[/?]|$)/.test(request.url ?? "");
    if (!isTurn && !isStream && !isAnalytics && !isDatabase && !isDatabaseStream && !isDatabaseInfo && !isAttachment) return send(response, 404, { error: "没有这个接口" });
    if (token && request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: "Agent 服务鉴权失败" });
    if (isAttachment) return attachmentHandler!(request, response);

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
      if (isDatabaseInfo) {
        try { return send(response, 200, database ? await database.inspect(requestController.signal) : { available: false, name: "周大福历史经营数据", limitations: ["历史数据库尚未配置"] }); }
        catch (error) { if (!requestController.signal.aborted) return send(response, 502, { error: publicError(error instanceof Error ? error.message : "历史数据库暂不可用") }); return; }
      }
      let body: unknown;
      try {
        body = await readJson(request);
      } catch (error) {
        if (requestController.signal.aborted || isTurnCancelled(error)) return;
        return send(response, 400, { error: "请求不是有效的 JSON" });
      }
      if (requestController.signal.aborted) return;
      if (isAnalytics || isDatabase || isDatabaseStream) {
        const schema = request.headers["x-analytics-answer-schema"];
        if (schema !== undefined && schema !== "analysis-answer/v2") return send(response, 400, { error: "不支持这个分析回答版本" });
        const runner = schema === "analysis-answer/v2" ? runGeneralAnalyticsTurn : runAnalyticsTurn;
        if (!(isDatabase || isDatabaseStream ? isDatabaseExplainRequest(body) : isAnalyticsExplainRequest(body))) return send(response, 400, { error: "分析请求内容不完整" });
        const analyticsRequest = body as Parameters<AnalyticsRunner>[0];
        if ((isDatabase || isDatabaseStream) && !database && !quickAnalyticsReply(analyticsRequest.question)) return send(response, 503, { error: "历史数据库尚未启用" });
        if (!runner) return send(response, 503, { error: "营销分析解读服务尚未启动" });
        const started = performance.now();
        if (isDatabaseStream) {
          response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
          response.flushHeaders();
          const emit = (event: AnalyticsStreamEvent) => { if (!requestController.signal.aborted && !response.destroyed && !response.writableEnded) response.write(encodeAnalyticsStreamEvent(event)); };
          try {
            const result = await runner(analyticsRequest, requestController.signal, emit, visualizationCapability(typeof request.headers["x-analytics-visuals"] === "string" ? request.headers["x-analytics-visuals"] : undefined));
            if (!requestController.signal.aborted) { emit({ type: "result", result }); response.end(); }
          } catch (error) {
            if (!requestController.signal.aborted && !isTurnCancelled(error)) {
              const detail = error instanceof Error ? error.message : "本次分析暂未完成";
              logger.error(`[analytics] 回答失败（${Math.round(performance.now() - started)}ms）：${publicError(detail)}`);
              emit({ type: "error", error: /格式|候选|模型不能|证据生成/.test(detail) ? "这次回答未通过数据核验，你的问题已保留，可以重试。" : publicError(detail) }); response.end();
            }
          }
          return;
        }
        try {
          const result = await runner(analyticsRequest, requestController.signal, undefined, visualizationCapability(typeof request.headers["x-analytics-visuals"] === "string" ? request.headers["x-analytics-visuals"] : undefined));
          if (!requestController.signal.aborted) send(response, 200, result);
        } catch (error) {
          if (!requestController.signal.aborted && !isTurnCancelled(error)) send(response, 502, { error: publicError(error instanceof Error ? error.message : "AI 解读失败") });
        }
        return;
      }
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
          if (writeEvent({ type: "error", error: publicError(message), timing })) response.end();
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
        send(response, 502, { error: publicError(message) });
      }
    } finally {
      request.off("aborted", abortDisconnected);
      response.off("close", abortDisconnected);
    }
  };
}
