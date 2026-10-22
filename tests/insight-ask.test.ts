import assert from "node:assert/strict";
import test from "node:test";
import { askContext, checkAnswerNumbers, cleanHighlights, dropUncollectedReferrals, parseAskBody, selectionHighlights } from "../app/lib/insight/ask.ts";
import { createInsightAskRunner } from "../agent/insight-ask.ts";
import type { AgentQuery } from "../agent/run-turn.ts";
import { Client } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import { fakeGraph } from "./helpers/insight-fixture.ts";

const graph = fakeGraph();

test("请求校验：问题必填、选中对象只接受图上有的节点和线", () => {
  assert.throws(() => parseAskBody({ question: "" }), /不能为空/);
  assert.throws(() => parseAskBody({ question: "x", selection: { kind: "edge", from: "promo", to: "drop" } }), /选中对象/);
  const ok = parseAskBody({ question: "为什么", selection: { kind: "edge", from: "promo", to: "mix" }, history: [{ role: "user", text: "a" }, { role: "x", text: "b" }] });
  assert.deepEqual(ok.selection, { kind: "edge", from: "promo", to: "mix" });
  assert.equal(ok.history.length, 1);
});

test("依据材料：选中线时带上两端节点、来源和经过它的链路；选中待采集项写明 AI 的部分", () => {
  const edge = askContext(graph, { kind: "edge", from: "promo", to: "mix" });
  assert.match(edge, /用户选中的：连线：活动和力度 → 货品结构/);
  assert.match(edge, /经过这条线的完整链路：\n- /);
  assert.match(edge, /AI 的部分：按名称把优惠小类归成/);
  assert.match(askContext(graph, { kind: "node", id: "member" }), /来源：AI 提出待采集[\s\S]*AI 的部分：新老会员是业务提的问题/);
  assert.match(askContext(graph, null), /## 所有连线/);
});

test("依据材料：AI 建议和支撑它的数据分开写，问到建议时有数据可查", () => {
  const node = askContext(graph, { kind: "node", id: "day" });
  assert.match(node, /页面上的结论：做活动、过节的日子/);
  assert.match(node, /可以怎么做（AI 建议，不是数据）：/);
  assert.match(node, /支撑这条建议的数据：\n- /);
  // 没有建议的卡片写原因，不出现「支撑这条建议的数据」。
  const member = askContext(graph, { kind: "node", id: "member" });
  assert.match(member, /可以怎么做：没有建议（需要先采集/);
});

test("数字核对：依据里没有的数字整句删掉，四舍五入和百分数可以", () => {
  const sources = ["每克让利 35.93083，强度 0.41"];
  const out = checkAnswerNumbers("每克让利约 35.9 元。强度 41。会多卖 20% 的货。", sources);
  assert.equal(out.body, "每克让利约 35.9 元。强度 41。");
  assert.equal(out.removed, 1);
  assert.equal(checkAnswerNumbers("单件克\uFFFD重。强度 41。", sources).body, "强度 41。");
  assert.deepEqual(cleanHighlights(["region", "evil", 3]), ["region"]);
});

test("问答运行：一次模型调用，只开放提交工具；编出来的数字被删掉，高亮只保留图上有的节点", async () => {
  let prompt = "";
  const query: AgentQuery = async function* ({ prompt: p, options }) {
    prompt = String(p);
    const server = options!.mcpServers!.insight; assert.ok("instance" in server);
    const denied = await options!.canUseTool!("Bash", {}, { signal: new AbortController().signal, toolUseID: "x", requestId: "x" });
    assert.equal(denied?.behavior, "deny");
    const [transport, service] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "图谱问答验收", version: "1" });
    await server.instance.connect(service); await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["submit_insight_answer"]);
    await client.callTool({ name: "submit_insight_answer", arguments: { body: "图上克减 50 每克实让 54.0 元。这会带来 8317% 的增长。", highlights: ["depth", "nope"] } });
    await client.close();
    yield { type: "result", subtype: "success", is_error: false } as never;
  };
  const run = createInsightAskRunner({ model: "m", modelBaseUrl: "https://x", apiKey: "k", runtimeDir: "/tmp/insight-ask-test" }, { query });
  const result = await run({ selection: { kind: "edge", from: "depth", to: "promo" }, question: "哪个力度让利最多？", history: [] }, graph);
  assert.match(prompt, /# 用户的问题\n哪个力度让利最多？/);
  assert.equal(result.body, "图上克减 50 每克实让 54.0 元。");
  assert.deepEqual(result.highlights, ["depth"]);
  assert.equal(result.removed, 1);
});

test("模型没给高亮时，标出用户选中的对象", () => {
  assert.deepEqual(selectionHighlights(graph, { kind: "node", id: "region" }), ["region"]);
  assert.deepEqual(selectionHighlights(graph, { kind: "edge", from: "promo", to: "mix" }), ["promo", "mix"]);
  assert.deepEqual(selectionHighlights(graph, null), ["store", "day", "promo", "mix"]);
});

test("待采集的数据不引导去智能问答查", () => {
  const out = dropUncollectedReferrals("需要补会员数据。\n- 想看明细可以切到「智能问答」问：「各城市级别的新客占比是多少？」\n- 想看门店明细可以去「智能问答」问：「各门店销售额？」");
  assert.equal(out.removed, 1);
  assert.match(out.body, /各门店销售额/);
  assert.doesNotMatch(out.body, /新客占比/);
});
