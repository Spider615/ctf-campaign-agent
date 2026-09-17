import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRequest } from "../app/lib/agent/protocol.ts";
import { createCampaignDraft } from "../app/lib/campaign/workspace.ts";
import { createAgentRunner, type AgentQuery } from "../agent/run-turn.ts";
import type { SDKMessage } from "../agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts";
import { Client } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";

const request: AgentRequest = {
  today: "2026-09-17",
  campaign: createCampaignDraft("campaign-1", "你好"),
  draft: null,
  history: [],
  trigger: { kind: "first_message", text: "你好" },
  campaignStage: "briefing",
  ics1811Phase: null,
  openQuestions: [],
  proposals: [],
  canUndo: false,
};

for (const alreadyAborted of [false, true]) {
  test(`external cancellation aborts the SDK query (${alreadyAborted ? "before" : "during"} query)`, { timeout: 5000 }, async (t) => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-agent-cancel-"));
    t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
    const started = Promise.withResolvers<AbortController>();
    const query: AgentQuery = async function* ({ options }) {
      const sdkController = options!.abortController!;
      started.resolve(sdkController);
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new DOMException("已停止", "AbortError"));
        if (sdkController.signal.aborted) abort();
        else sdkController.signal.addEventListener("abort", abort, { once: true });
      });
    };
    const runner = createAgentRunner({
      model: "test-model",
      modelBaseUrl: "http://127.0.0.1",
      apiKey: "test-key",
      runtimeDir,
      pluginDir: join(process.cwd(), "agent/plugin"),
    }, { query });
    const controller = new AbortController();
    if (alreadyAborted) controller.abort();
    const pending = runner(request, undefined, undefined, controller.signal);
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
    void rejected.catch(() => {});
    const sdkController = await started.promise;
    try {
      if (!alreadyAborted) {
        let settled = false;
        void pending.then(() => { settled = true; }, () => { settled = true; });
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(settled, false);
        controller.abort();
      }
      assert.equal(sdkController.signal.aborted, true);
      await rejected;
    } finally {
      sdkController.abort();
      await pending.catch(() => {});
    }
  });
}

const skillMessage = { type: "assistant", message: { content: [{ type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "ics1811:campaign-orchestrator" } }] } } as SDKMessage;
const skillResult = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "skill-1", content: "已加载" }] } } as SDKMessage;

for (const success of [true, false]) {
  test(`可取消消费保留 SDK ${success ? "成功结果" : "逻辑步数错误"}并移除监听`, async (t) => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-agent-result-"));
    t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
    let sdkSignal: AbortSignal | undefined;
    const runner = createAgentRunner({ model: "test", modelBaseUrl: "http://127.0.0.1", apiKey: "test", runtimeDir, pluginDir: join(process.cwd(), "agent/plugin") }, { query: async function* ({ options }) {
      assert.equal(options!.maxTurns, 12);
      sdkSignal = options!.abortController!.signal;
      yield skillMessage;
      yield skillResult;
      yield (success ? { type: "result", subtype: "success", is_error: false, result: "请补充活动目标。" } : { type: "result", subtype: "error_max_turns" }) as SDKMessage;
    } });
    const controller = new AbortController();
    const pending = runner(request, undefined, undefined, controller.signal);
    if (success) assert.equal((await pending).reply, "请补充活动目标。");
    else await assert.rejects(pending, /Agent 步骤太多，没在限定步数内完成/);
    assert.ok(sdkSignal);
    assert.deepEqual(getEventListeners(sdkSignal, "abort"), []);
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
  });
}

for (const message of [skillMessage, skillResult, { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "迟到正文。" } } } as SDKMessage]) {
  test(`取消后丢弃 SDK 迟到的 ${message.type}，不转发、不记录并关闭迭代器`, { timeout: 5000 }, async (t) => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-agent-late-"));
    t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<IteratorResult<SDKMessage>>();
    let closed = false;
    let pulls = 0;
    const preceding = message.type === "user" ? [skillMessage] : message.type === "stream_event"
      ? [{ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } } as SDKMessage] : [];
    const query: AgentQuery = () => ({ [Symbol.asyncIterator]: () => ({
      next() {
        pulls++;
        if (pulls <= preceding.length) return Promise.resolve({ done: false as const, value: preceding[pulls - 1] });
        started.resolve();
        return pulls === preceding.length + 1 ? late.promise : Promise.resolve({ done: true as const, value: undefined });
      },
      async return() { closed = true; return { done: true, value: undefined }; },
    }) });
    const logs: unknown[] = [];
    t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args); });
    t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
    const runner = createAgentRunner({ model: "test", modelBaseUrl: "http://127.0.0.1", apiKey: "test", runtimeDir, pluginDir: join(process.cwd(), "agent/plugin"), debug: true }, { query });
    const controller = new AbortController();
    const seen: unknown[] = [];
    const pending = runner(request, (event) => seen.push(event), (event) => seen.push(event), controller.signal);
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
    await started.promise;
    seen.length = 0;
    logs.length = 0;
    controller.abort();
    // SDK 可能忽略取消，之后仍交出已经缓冲的消息。
    late.resolve({ done: false, value: message });
    await rejected;
    assert.deepEqual(seen, []);
    assert.deepEqual(logs, []);
    assert.equal(pulls, preceding.length + 1);
    assert.equal(closed, true);
  });
}

test("SDK 不结束 next 时 runner 仍立即取消，并请求关闭迭代器", { timeout: 5000 }, async (t) => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-agent-stalled-"));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const started = Promise.withResolvers<void>();
  const late = Promise.withResolvers<IteratorResult<SDKMessage>>();
  let closed = false;
  const runner = createAgentRunner({ model: "test", modelBaseUrl: "http://127.0.0.1", apiKey: "test", runtimeDir, pluginDir: join(process.cwd(), "agent/plugin") }, { query: () => ({ [Symbol.asyncIterator]: () => ({
    next() { started.resolve(); return late.promise; },
    async return() { closed = true; return { done: true, value: undefined }; },
  }) }) });
  const controller = new AbortController();
  const pending = runner(request, undefined, undefined, controller.signal);
  let settled = false;
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError").then(() => { settled = true; });
  await started.promise;
  controller.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.equal(settled, true, "取消不等待 SDK 的下一个消息");
    assert.equal(closed, true);
  } finally {
    late.resolve({ done: true, value: undefined });
    await rejected;
  }
});

test("取消后即使 SDK 继续调用 MCP 工具也不能执行领域写入或记录参数", { timeout: 5000 }, async (t) => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-agent-tool-"));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const ready = Promise.withResolvers<Client>();
  const release = Promise.withResolvers<void>();
  const query: AgentQuery = async function* ({ options }) {
    yield skillMessage;
    yield skillResult;
    const campaign = options!.mcpServers!.campaign;
    assert.ok("instance" in campaign);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "取消测试", version: "1" });
    await campaign.instance.connect(serverTransport);
    await client.connect(clientTransport);
    ready.resolve(client);
    await release.promise;
  };
  const runner = createAgentRunner({ model: "test", modelBaseUrl: "http://127.0.0.1", apiKey: "test", runtimeDir, pluginDir: join(process.cwd(), "agent/plugin"), debug: true }, { query });
  const controller = new AbortController();
  const seen: unknown[] = [];
  const logs: unknown[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args); });
  const pending = runner(request, (event) => seen.push(event), (event) => seen.push(event), controller.signal);
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  const client = await ready.promise;
  controller.abort();
  seen.length = 0;
  logs.length = 0;
  try {
    const argumentsByName: Record<string, Record<string, unknown>> = {
      update_campaign_brief: { writes: [{ key: "objective", quote: "你好" }] },
      extract_campaign_facts: { facts: [] },
      accept_campaign_proposals: { quote: "你好" },
      lookup_ics_reference: { query: "你好" },
      ask_campaign_questions: { questions: [] },
      draft_campaign_copy: { name: "你好", content: "你好" },
      draft_promo_copy: { concept: { headline: "你好", subheadline: "你好", coreMessage: "你好" }, channelOutputs: [], visualDirection: "你好" },
    };
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    for (const { name } of tools) {
      const result = await client.callTool({ name, arguments: argumentsByName[name] ?? {} });
      assert.equal(result.isError, true, `${name} 取消后不能返回成功的领域结果`);
      assert.match(JSON.stringify(result.content), /已停止生成/);
    }
    assert.deepEqual(seen, []);
    assert.deepEqual(logs, []);
  } finally {
    release.resolve();
    await client.close();
    await rejected;
  }
});
