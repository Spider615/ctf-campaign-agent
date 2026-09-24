import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import test from "node:test";

import type { AgentTurnRunner } from "../agent/run-turn.ts";
import type { AgentRequest } from "../app/lib/agent/protocol.ts";
import { TurnCancelledError } from "../app/lib/cancellation.ts";
import { createAgentState, finishAgentTurn } from "../app/lib/agent/tools.ts";
import { createCampaignDraft } from "../app/lib/campaign/workspace.ts";

const body: AgentRequest = {
  today: "2026-09-17", campaign: createCampaignDraft("campaign-1", "你好"),
  draft: null, history: [], trigger: { kind: "first_message", text: "你好" },
  campaignStage: "briefing", ics1811Phase: null, openQuestions: [], proposals: [], canUndo: false,
};

function recordOutput(response: ServerResponse, writes: string[], statuses: number[]) {
  const write = response.write;
  const end = response.end;
  const writeHead = response.writeHead;
  response.write = ((...args: unknown[]) => {
    writes.push(String(args[0]));
    return Reflect.apply(write, response, args);
  }) as typeof response.write;
  response.end = ((...args: unknown[]) => {
    if (args[0] !== undefined && typeof args[0] !== "function") writes.push(String(args[0]));
    return Reflect.apply(end, response, args);
  }) as typeof response.end;
  response.writeHead = ((...args: unknown[]) => {
    statuses.push(args[0] as number);
    return Reflect.apply(writeHead, response, args);
  }) as typeof response.writeHead;
}

for (const path of ["/turn/stream", "/turn"]) {
  test(`HTTP disconnect cancels ${path} without error output or failure logs`, { timeout: 5000 }, async (t) => {
    const { createAgentHttpHandler } = await import("../agent/http-handler.ts");
    const started = Promise.withResolvers<AbortSignal>();
    const settled = Promise.withResolvers<void>();
    const handled = Promise.withResolvers<void>();
    const writes: string[] = [];
    const statuses: number[] = [];
    const errors: unknown[] = [];
    const runAgentTurn: AgentTurnRunner = async (_request, onTrace, onProgress, signal) => {
      assert.ok(signal);
      onTrace?.({ id: "pending", tool: "analyze_campaign_plan", title: "分析活动", status: "started", initiatedBy: "model", startedAt: Date.now() });
      started.resolve(signal);
      try {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        onProgress?.({ type: "text_delta", delta: "已停止后的内容" });
        throw new TurnCancelledError();
      } finally {
        settled.resolve();
      }
    };
    const handler = createAgentHttpHandler({ runAgentTurn, token: "", model: "test", logger: { log() {}, error: (...args) => errors.push(args) } });
    const server = createServer((request, response) => {
      recordOutput(response, writes, statuses);
      void handler(request, response).finally(() => handled.resolve());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = httpRequest({ host: "127.0.0.1", port: address.port, path, method: "POST" });
    client.on("error", () => {});
    t.after(() => client.destroy());
    client.end(JSON.stringify(body));
    const signal = await started.promise;
    const writesBeforeDisconnect = [...writes];
    client.destroy();
    await settled.promise;
    await handled.promise;
    assert.equal(signal.aborted, true);
    assert.deepEqual(writes, writesBeforeDisconnect);
    assert.deepEqual(errors, []);
    assert.equal(statuses.includes(502), false);
  });
}

test("partial JSON body disconnect is cancelled before the runner starts", { timeout: 5000 }, async (t) => {
  const { createAgentHttpHandler } = await import("../agent/http-handler.ts");
  const received = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const handled = Promise.withResolvers<void>();
  const writes: string[] = [];
  const statuses: number[] = [];
  const errors: unknown[] = [];
  let runnerCalls = 0;
  const handler = createAgentHttpHandler({
    runAgentTurn: async () => { runnerCalls++; throw new Error("不应开始执行"); },
    token: "", model: "test", logger: { log() {}, error: (...args) => errors.push(args) },
  });
  const server = createServer((request, response) => {
    recordOutput(response, writes, statuses);
    request.once("data", () => received.resolve());
    request.once("aborted", () => aborted.resolve());
    void handler(request, response).finally(() => handled.resolve());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = httpRequest({ host: "127.0.0.1", port: address.port, path: "/turn/stream", method: "POST", headers: { "content-length": 10000 } });
  client.on("error", () => {});
  t.after(() => client.destroy());
  client.write('{"today":');
  await received.promise;
  client.destroy();
  await aborted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await handled.promise;
  assert.equal(runnerCalls, 0);
  assert.deepEqual(writes, []);
  assert.deepEqual(statuses, []);
  assert.deepEqual(errors, []);
});

test("HTTP handler preserves validation, success and upstream failures and removes its listeners", { timeout: 5000 }, async (t) => {
  const { createAgentHttpHandler } = await import("../agent/http-handler.ts");
  const errors: unknown[] = [];
  const signals: AbortSignal[] = [];
  const listenerCounts: number[][] = [];
  const result = finishAgentTurn(createAgentState(body), "你好");
  let fail = false;
  const handler = createAgentHttpHandler({
    runAgentTurn: async (_request, onTrace, _onProgress, signal) => {
      assert.ok(signal);
      signals.push(signal);
      if (fail) {
        onTrace?.({ id: "pending", tool: "analyze_campaign_plan", title: "分析活动", status: "started", initiatedBy: "model", startedAt: Date.now() });
        throw new Error("真实上游错误");
      }
      return result;
    },
    token: "test-token", model: "test-model", logger: { log() {}, error: (...args) => errors.push(args) },
  });
  const server = createServer((request, response) => {
    void handler(request, response).then(() => {
      listenerCounts.push([
        request.listeners("aborted").filter((listener) => listener.name === "abortDisconnected").length,
        response.listeners("close").filter((listener) => listener.name === "abortDisconnected").length,
      ]);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const post = (path: string, value: string) => fetch(baseUrl + path, { method: "POST", headers: { authorization: "Bearer test-token" }, body: value });
  assert.deepEqual(await (await fetch(baseUrl + "/health")).json(), { ok: true, model: "test-model" });
  assert.equal((await fetch(baseUrl + "/missing")).status, 404);
  assert.equal((await fetch(baseUrl + "/turn", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await post("/turn", "{" )).status, 400);
  assert.equal((await post("/turn", "{}" )).status, 400);
  const jsonSuccess = await post("/turn", JSON.stringify(body));
  assert.equal(jsonSuccess.status, 200);
  assert.deepEqual(await jsonSuccess.json(), result);
  const streamSuccess = await post("/turn/stream", JSON.stringify(body));
  assert.deepEqual(JSON.parse((await streamSuccess.text()).trim()), { type: "result", result });
  fail = true;
  const jsonFailure = await post("/turn", JSON.stringify(body));
  assert.equal(jsonFailure.status, 502);
  assert.deepEqual(await jsonFailure.json(), { error: "真实上游错误" });
  const streamFailure = await post("/turn/stream", JSON.stringify(body));
  const events = (await streamFailure.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events[1].event.status, "failed");
  assert.equal(events[2].type, "error");
  assert.equal(events[2].error, "真实上游错误");
  assert.equal(errors.length, 2);
  assert.equal(signals.length, 4);
  assert.ok(signals.every((signal) => !signal.aborted));
  assert.equal(listenerCounts.length, 9);
  assert.ok(listenerCounts.every((counts) => counts.every((count) => count === 0)));
});

test("HTTP handler keeps underlying framework names out of client-facing errors", { timeout: 5000 }, async (t) => {
  const { createAgentHttpHandler } = await import("../agent/http-handler.ts");
  const errors: unknown[][] = [];
  const handler = createAgentHttpHandler({
    runAgentTurn: async () => { throw new Error("Claude Code process exited with code 1"); },
    token: "", model: "test", logger: { log() {}, error: (...args) => errors.push(args) },
  });
  const server = createServer((request, response) => void handler(request, response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const post = (path: string) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", body: JSON.stringify(body) });

  const json = await post("/turn");
  assert.equal(json.status, 502);
  assert.deepEqual(await json.json(), { error: "Agent 执行出错" });
  const events = (await (await post("/turn/stream")).text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, "error");
  assert.equal(events.at(-1).error, "Agent 执行出错");
  // 原文只进服务日志，排查时还看得到。
  assert.equal(errors.length, 2);
  assert.ok(errors.every((args) => String(args[0]).includes("Claude Code process exited with code 1")));
});
