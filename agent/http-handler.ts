import type { IncomingMessage, ServerResponse } from "node:http";

import { isAgentRequest } from "../app/lib/agent/protocol.ts";
import { publicAgentError as publicError } from "../app/lib/agent/service-errors.ts";
import { encodeAgentStreamEvent, type AgentStreamEvent } from "../app/lib/agent/stream.ts";
import { isTurnCancelled, TurnCancelledError } from "../app/lib/cancellation.ts";
import { finishTraceEvent, harnessTimingSummary, mergeTraceEvent, type AgentTraceEvent } from "../app/lib/tool-trace.ts";
import type { AgentTurnRunner } from "./run-turn.ts";
import { isAnalyticsExplainRequest } from "../app/lib/analytics/explain.ts";
import type { AnalyticsRunner } from "./analytics-run-turn.ts";
import type { AnalyticsSkillRunner } from "./analytics-runner-types.ts";
import { isDatabaseExplainRequest, type AnalyticsDatabase } from "../app/lib/analytics/database.ts";
import { encodeAnalyticsStreamEvent, type AnalyticsStreamEvent } from "../app/lib/analytics/stream.ts";
import type { InsightGraphService } from "./insight-graph.ts";
import type { InsightAskRunner } from "./insight-ask.ts";
import { parseAskBody } from "../app/lib/insight/ask.ts";
import { ANALYTICS_RUN_ID, createAnalyticsRuns, type AnalyticsRuns } from "./analytics-runs.ts";
import { analyticsAnswerText } from "../app/lib/analytics/stream.ts";
import { recordTurn, usageIdentity } from "./usage/turns.ts";
import type { UsageChannel, UsageStore } from "./usage/store.ts";

type AgentHttpOptions = {
  runAgentTurn: AgentTurnRunner;
  runAnalyticsTurn?: AnalyticsRunner;
  // 保留注入属性名，直接问答的合同由中性类型定义，实际运行器统一返回 v4。
  runPlanAnalyticsTurn?: AnalyticsSkillRunner;
  database?: AnalyticsDatabase;
  token: string;
  model: string;
  logger?: Pick<Console, "log" | "error">;
  attachmentHandler?: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  insight?: InsightGraphService;
  insightAsk?: InsightAskRunner;
  analyticsRuns?: AnalyticsRuns;
  // 内部用量记录；没配时入口行为不变。isInternal 校验管理员凭据，判定内部流量。
  usage?: UsageStore;
  channel?: UsageChannel;
  isInternal?: (token: string | undefined) => boolean;
};

function send(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

// 把一次登记的运行写成 NDJSON：断开连接只退订，不停止运行。
function pipeRun(response: ServerResponse, subscribe: (listener: (event: AnalyticsStreamEvent) => void) => (() => void) | null) {
  response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
  response.flushHeaders();
  let unsubscribe: (() => void) | null = null; let ended = false;
  const close = () => { ended = true; unsubscribe?.(); };
  response.on("close", close);
  unsubscribe = subscribe((event) => {
    if (ended || response.destroyed || response.writableEnded) return;
    response.write(encodeAnalyticsStreamEvent(event));
    if (event.type === "result" || event.type === "error") { ended = true; response.end(); }
  });
  if (ended) unsubscribe?.();
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

export function createAgentHttpHandler({ runAgentTurn, runPlanAnalyticsTurn, database, token, model, logger = console, attachmentHandler, insight, insightAsk, analyticsRuns = createAnalyticsRuns(), usage, channel = "deepseek", isInternal }: AgentHttpOptions) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const identity = () => usageIdentity(request, isInternal);
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true, model });
    const isTurn = request.method === "POST" && request.url === "/turn";
    const isStream = request.method === "POST" && request.url === "/turn/stream";
    const isAnalytics = request.method === "POST" && request.url === "/analytics/explain";
    const isDatabase = request.method === "POST" && request.url === "/analytics/database/explain";
    const isDatabaseStream = request.method === "POST" && request.url === "/analytics/database/explain/stream";
    const isDatabaseInfo = request.method === "GET" && request.url === "/analytics/database";
    const isInsight = request.method === "GET" && /^\/insight\/graph(?:\?|$)/.test(request.url ?? "");
    const isInsightAsk = request.method === "POST" && /^\/insight\/ask(?:\?|$)/.test(request.url ?? "");
    const runRoute = /^\/analytics\/runs\/([^/?]+)\/(stream|cancel)$/.exec(request.url ?? "");
    const isRunStream = request.method === "GET" && runRoute?.[2] === "stream";
    const isRunCancel = request.method === "POST" && runRoute?.[2] === "cancel";
    const isAttachment = Boolean(attachmentHandler) && /^\/attachments(?:[/?]|$)/.test(request.url ?? "");
    if (!isTurn && !isStream && !isAnalytics && !isDatabase && !isDatabaseStream && !isDatabaseInfo && !isAttachment && !isInsight && !isInsightAsk && !isRunStream && !isRunCancel) return send(response, 404, { error: "没有这个接口" });
    if (token && request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: "Agent 服务鉴权失败" });
    // 运行只归开始它的访问标识所有，别人拿到 id 也读不到、停不了。
    const owner = typeof request.headers["x-analytics-owner"] === "string" ? request.headers["x-analytics-owner"] : "";
    if (isRunStream || isRunCancel) {
      const runId = runRoute![1];
      if (!owner || !ANALYTICS_RUN_ID.test(runId) || !analyticsRuns.has(runId, owner)) return send(response, 404, { error: "这次回答已中断，可以重试" });
      if (isRunCancel) { analyticsRuns.cancel(runId, owner); return send(response, 200, { ok: true }); }
      return pipeRun(response, (listener) => analyticsRuns.subscribe(runId, owner, listener));
    }
    if (isAttachment) return attachmentHandler!(request, response);
    if (isInsight) {
      if (!insight) return send(response, 503, { error: "历史数据库尚未启用，洞察图谱暂不可用" });
      // 图谱只有一张，算好后缓存；断开连接也让计算跑完，下次直接命中。
      try { return send(response, 200, await insight.graph()); }
      catch (error) { logger.error(`[insight] 计算失败：${error instanceof Error ? error.message : error}`); return send(response, 502, { error: "洞察图谱暂时算不出来，请稍后重试" }); }
    }
    if (isInsightAsk) {
      if (!insight || !insightAsk) return send(response, 503, { error: "历史数据库尚未启用，图谱问答暂不可用" });
      const controller = new AbortController();
      response.on("close", () => { if (!response.writableEnded) controller.abort(); });
      let body;
      try { body = parseAskBody(await readJson(request)); }
      catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : "请求不正确" }); }
      try {
        // 图谱命中缓存，问答只读已算好的内容。
        const graph = await insight.graph();
        // 洞察问答没有会话概念，每次提问单独一轮。
        return send(response, 200, await recordTurn(usage, { ...identity(), conversationId: null, entry: "insight", channel, question: body.question },
          () => insightAsk(body, graph, controller.signal), (result) => ({ status: "answered", reply: result.body }), controller.signal, publicError));
      } catch (error) {
        if (controller.signal.aborted || isTurnCancelled(error)) return;
        logger.error(`[insight] 问答失败：${error instanceof Error ? error.message : error}`);
        return send(response, 502, { error: publicError(error instanceof Error ? error.message : "这次没有得到回答，可以重试") });
      }
    }

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
        if (schema === undefined || schema === "analysis-answer/v2") return send(response, 400, { error: "页面版本已更新，请刷新页面后重试" });
        // 新请求仅接受 v3/v4，均使用 Skill 问答运行器；旧消息的读取由原校验器兼容。
        if (schema !== "analysis-answer/v3" && schema !== "analysis-answer/v4") return send(response, 400, { error: "不支持这个分析回答版本" });
        const runner = runPlanAnalyticsTurn;
        if (!(isDatabase || isDatabaseStream ? isDatabaseExplainRequest(body) : isAnalyticsExplainRequest(body))) return send(response, 400, { error: "分析请求内容不完整" });
        const analyticsRequest = body as Parameters<AnalyticsSkillRunner>[0];
        if ((isDatabase || isDatabaseStream) && !database) return send(response, 503, { error: "历史数据库尚未启用" });
        if (!runner) return send(response, 503, { error: "营销分析解读服务尚未启动" });
        const started = performance.now();
        // signal 是这一轮自己的停止信号：登记的运行用运行的信号（断开连接不算取消，只有点停止才算），其余用连接的信号。
        const record = <T,>(work: (emitTrace: (event: AgentTraceEvent) => void) => Promise<T>, signal: AbortSignal = requestController.signal) => recordTurn(usage, { ...identity(), entry: "analysis", channel, question: analyticsRequest.question }, work,
          (result) => ({ status: (result as { status?: string }).status === "answered" || (result as { status?: string }).status === undefined ? "answered" : "partial", reply: analyticsAnswerText(result as Parameters<typeof analyticsAnswerText>[0]) }),
          signal, publicError);
        const runId = request.headers["x-analytics-run-id"];
        if (isDatabaseStream && typeof runId === "string") {
          if (!owner || !ANALYTICS_RUN_ID.test(runId)) return send(response, 400, { error: "回答标识无效" });
          const fresh = analyticsRuns.start(runId, owner, async (signal, emit) => {
            try { return { type: "result", result: await record((emitTrace) => runner(analyticsRequest, signal, (event) => { if (event.type === "trace") emitTrace(event.event); emit(event); }), signal) }; }
            catch (error) {
              if (signal.aborted || isTurnCancelled(error)) return null;
              const detail = error instanceof Error ? error.message : "本次分析暂未完成";
              logger.error(`[analytics] 回答失败（${Math.round(performance.now() - started)}ms）：${publicError(detail)}`);
              return { type: "error", error: publicError(detail) };
            }
          });
          // 同一 id 重复提交（例如页面重发）时直接接上已有运行，不再跑第二次。
          if (!fresh && !analyticsRuns.has(runId, owner)) return send(response, 409, { error: "回答标识已被占用" });
          return pipeRun(response, (listener) => analyticsRuns.subscribe(runId, owner, listener));
        }
        if (isDatabaseStream) {
          response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
          response.flushHeaders();
          const emit = (event: AnalyticsStreamEvent) => { if (!requestController.signal.aborted && !response.destroyed && !response.writableEnded) response.write(encodeAnalyticsStreamEvent(event)); };
          try {
            const result = await record((emitTrace) => runner(analyticsRequest, requestController.signal, (event) => { if (event.type === "trace") emitTrace(event.event); emit(event); }));
            if (!requestController.signal.aborted) { emit({ type: "result", result }); response.end(); }
          } catch (error) {
            if (!requestController.signal.aborted && !isTurnCancelled(error)) {
              const detail = error instanceof Error ? error.message : "本次分析暂未完成";
              logger.error(`[analytics] 回答失败（${Math.round(performance.now() - started)}ms）：${publicError(detail)}`);
              emit({ type: "error", error: publicError(detail) }); response.end();
            }
          }
          return;
        }
        try {
          const result = await record(() => runner(analyticsRequest, requestController.signal, undefined));
          if (!requestController.signal.aborted) send(response, 200, result);
        } catch (error) {
          if (!requestController.signal.aborted && !isTurnCancelled(error)) send(response, 502, { error: publicError(error instanceof Error ? error.message : "AI 解读失败") });
        }
        return;
      }
      if (!isAgentRequest(body)) return send(response, 400, { error: "请求内容不完整" });

      const started = Date.now();
      const startedMonotonic = performance.now();
      const agentBody = body;
      const record = (work: (emitTrace: (event: AgentTraceEvent) => void) => ReturnType<AgentTurnRunner>) => recordTurn(usage, { ...identity(), entry: "campaign", channel, question: agentBody.trigger.text }, work,
        (result) => ({ status: "answered", reply: result.reply }), requestController.signal, publicError);
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
          const result = await record((recordTrace) => runAgentTurn(agentBody, (event) => { recordTrace(event); emitTrace(event); }, writeEvent, requestController.signal));
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
        const result = await record(() => runAgentTurn(agentBody, undefined, undefined, requestController.signal));
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
