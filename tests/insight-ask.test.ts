import assert from "node:assert/strict";
import test from "node:test";
import { askContext, checkAnswerNumbers, cleanHighlights, dropUncollectedReferrals, parseAskBody, selectionHighlights, selectionLabel } from "../app/lib/insight/ask.ts";
import { buildInsightGraph } from "../app/lib/insight/score.ts";
import { createInsightAskRunner } from "../agent/insight-ask.ts";
import type { AgentQuery } from "../agent/run-turn.ts";
import type { InsightCell } from "../app/lib/insight/types.ts";
import { Client } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";

const cell = (over: Partial<InsightCell>): InsightCell => ({ value: "全部", side: "offer", day: "20250801", rows: 1000, stores: 50, amount: 1000, grams: 1, quantity: 1, tagAmount: 1100, profit: 100, orders: 1, lines: 1, tradeInOrders: 0, agedAmount: 0, keySeriesAmount: 0, returnAmount: 0, ...over });
const pair = (value: string, give: number) => [cell({ value, amount: (1000 - give) * 10, grams: 10 }), cell({ value, side: "base", amount: 10000, grams: 10 })];
const graph = buildInsightGraph({ request: { metric: "give_per_gram", offer: "克减类", category: "一般足金类" }, datasetVersion: "v", builtAt: "x", total: pair("全部", 30),
  cubes: [{ dimension: "offerDepth", cells: [...pair("克减20元", 6), ...pair("克减30元", 24), ...pair("克减50元", 54)] }, { dimension: "cityTier", cells: [...pair("一线", 30), ...pair("二线", 31)] }] });

test("请求校验：问题必填、选中对象只接受已知形状", () => {
  assert.throws(() => parseAskBody({ question: "" }), /不能为空/);
  assert.throws(() => parseAskBody({ question: "x", selection: { kind: "edge", dimension: "drop" } }), /选中对象/);
  const ok = parseAskBody({ question: "为什么", selection: { kind: "edge", dimension: "offerDepth" }, history: [{ role: "user", text: "a" }, { role: "x", text: "b" }] });
  assert.deepEqual(ok.selection, { kind: "edge", dimension: "offerDepth" });
  assert.equal(ok.history.length, 1);
});

test("依据材料：选中连线时带上这条线的依据、异常、推荐和取值表；选中待采集项时带上 AI 推测", () => {
  const edge = askContext(graph, { kind: "edge", dimension: "offerDepth" }).text;
  assert.match(edge, /用户选中的：连线：克减力度 → 每克让利/);
  assert.match(edge, /依据：/);
  assert.match(edge, /克减50元 \|/);
  assert.match(edge, /AI 判断：/);
  const missing = askContext(graph, { kind: "node", id: "missing:param:门槛与封顶" }).text;
  assert.match(missing, /AI 推测它会影响：维度 克减力度、单件克重段/);
  assert.equal(selectionLabel(graph, null), "整张图（中心：每克让利）");
});

test("数字核对：依据里没有的数字整句删掉，四舍五入和百分数可以", () => {
  const sources = ["每克让利 35.93083，强度 0.41"];
  const out = checkAnswerNumbers("每克让利约 35.9 元。强度 41。会多卖 20% 的货。", sources);
  assert.equal(out.body, "每克让利约 35.9 元。强度 41。");
  assert.equal(out.removed, 1);
  assert.equal(checkAnswerNumbers("单件克\uFFFD重。强度 41。", sources).body, "强度 41。");
  assert.deepEqual(cleanHighlights(["dim:cityTier", "evil", 3], ["dim:cityTier"]), ["dim:cityTier"]);
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
    await client.callTool({ name: "submit_insight_answer", arguments: { body: "图上克减50元每克让利最多，比较值 54。这会带来 99% 的增长。", highlights: ["dim:offerDepth", "nope"] } });
    await client.close();
    yield { type: "result", subtype: "success", is_error: false } as never;
  };
  const run = createInsightAskRunner({ model: "m", modelBaseUrl: "https://x", apiKey: "k", runtimeDir: "/tmp/insight-ask-test" }, { query });
  const result = await run({ request: graph.request, selection: { kind: "edge", dimension: "offerDepth" }, question: "哪个力度让利最多？", history: [] }, graph);
  assert.match(prompt, /# 用户的问题\n哪个力度让利最多？/);
  assert.equal(result.body, "图上克减50元每克让利最多，比较值 54。");
  assert.deepEqual(result.highlights, ["dim:offerDepth"]);
  assert.equal(result.removed, 1);
});

test("问一组维度：逐个带上组里维度的依据；算不出强度的写明是被顶部筛选固定了", () => {
  const fixed = buildInsightGraph({ request: { metric: "give_per_gram", offer: "克减类", category: "一般足金类" }, datasetVersion: "v", builtAt: "x", total: pair("全部", 30),
    cubes: [{ dimension: "category", cells: pair("一般足金类", 30) }, { dimension: "priceBand", cells: [...pair("1k-2k", 10), ...pair("3K-5K", 40)] }] });
  const text = askContext(fixed, { kind: "node", id: "group:product" }).text;
  assert.match(text, /「品类」是一组维度/);
  assert.match(text, /### 计价 \/ 定价[\s\S]*算不出。当前筛选下只有「一般足金类」一个取值[\s\S]*顶部筛选已经固定了货类/);
  assert.match(text, /### 价位段[\s\S]*依据：/);
  assert.doesNotMatch(text, /计价 \/ 定价：—/);
});

test("模型没给高亮时，标出用户选中的对象", () => {
  assert.deepEqual(selectionHighlights(graph, { kind: "node", id: "group:product" }), ["group:product"]);
  assert.deepEqual(selectionHighlights(graph, { kind: "edge", dimension: "offerDepth" }), ["dim:offerDepth"]);
  assert.deepEqual(selectionHighlights(graph, { kind: "link", group: "param", to: "missing:param:门槛与封顶" }), ["missing:param:门槛与封顶"]);
});

test("选中待采集项：带上它推测会影响的维度的现有数据", () => {
  const text = askContext(graph, { kind: "node", id: "missing:param:门槛与封顶" }).text;
  assert.match(text, /### 现有数据：克减力度（它推测会影响的维度）[\s\S]*依据：[\s\S]*克减50元 \|/);
});

test("待采集的数据不引导去智能问答查", () => {
  const out = dropUncollectedReferrals("能回答新客占比。\n- 想看明细可以切到「智能问答」问：「各城市级别的新客占比是多少？」\n- 想看门店明细可以去「智能问答」问：「各门店每克让利？」");
  assert.equal(out.removed, 1);
  assert.match(out.body, /各门店每克让利/);
  assert.doesNotMatch(out.body, /各城市级别的新客占比/);
});
