import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import { createAnalyticsSkillTools } from "../agent/analytics-skill-tools.ts";
import { createSnapshotAnalysisProvider } from "../app/lib/analytics/analysis-v2-snapshot.ts";
import { analysisMetricDefinitions, createAnalysisOperations } from "../app/lib/analytics/analysis-v2-operations.ts";
import type { AnalysisAggregateCell, AnalysisAggregateQuery, AnalysisDataSession } from "../app/lib/analytics/analysis-v2-types.ts";
import { createQaResult, pageQaResult } from "../app/lib/analytics/qa/results.ts";
import { drawQaChart } from "../app/lib/analytics/qa/chart.ts";
import { assembleQaAnswer } from "../app/lib/analytics/qa/answer.ts";
import { validatePlanAnswerV4 } from "../app/lib/analytics/plan/answer.ts";
import { sampleDataset } from "../app/lib/analytics/sample.ts";

const dataset = sampleDataset();
const scope = { period: { start: "2026-08-01", end: "2026-08-31" }, population: "sales" as const, filters: {} };
const reference = { ...scope, period: { start: "2025-08-01", end: "2025-08-31" } };
async function setup(t: { after(fn: () => Promise<void>): void }, providedSession?: AnalysisDataSession) {
  const session = providedSession ?? await createSnapshotAnalysisProvider(dataset).open();
  let opens = 0;
  const submitted: string[] = [];
  const tools = createAnalyticsSkillTools({ ensureSession: async () => { opens++; return session; }, constraints: { filters: {} }, onSubmit: async (body) => { submitted.push(body); } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "自主问答工具测试", version: "1" });
  await tools.server.instance.connect(serverSide); await client.connect(clientSide);
  t.after(async () => { await client.close(); await session.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return { isError: "isError" in response ? response.isError as boolean | undefined : undefined, value: JSON.parse((response.content as Array<{ text: string }>)[0].text) };
  };
  return { session, tools, call, client, opens: () => opens, submitted };
}

test("仅五个业务工具，查数不需要预先加载Skill或目录", async (t) => {
  const { call, client, tools } = await setup(t);
  const listed = (await client.listTools()).tools;
  assert.deepEqual(listed.map((tool) => tool.name), ["inspect_dataset", "analyze", "simulate_scenario", "draw_chart", "submit_answer"]);
  assert.equal(listed.find((tool) => tool.name === "analyze")?.annotations?.readOnlyHint, true);
  const page = await call("analyze", { action: "query", request: { method: "aggregate", scope, metrics: ["amount"], by: ["region"], purpose: "直接读大区实收" } });
  assert.equal(page.isError, undefined);
  assert.ok(page.value.resultId && page.value.groups.length);
  assert.equal(tools.operations.length, 1);
  assert.ok(tools.readFactIds().size);
});

test("五种方法直接复用真实确定性计算，缺参可修正", async (t) => {
  const { session, call } = await setup(t);
  for (const method of ["aggregate", "compare", "decompose", "scan", "robustness"] as const) {
    const request = { method, scope, metrics: ["amount", "quantity"] as const, purpose: method, ...(["compare", "decompose"].includes(method) ? { reference } : {}), ...(method === "scan" ? { by: ["region"] } : {}), ...(method === "robustness" ? { check: "order_distribution" } : {}) };
    const response = await call("analyze", { action: "query", request });
    assert.equal(response.isError, undefined, JSON.stringify(response.value));
    const expected = await createAnalysisOperations(session, { filters: {} }).execute({ ...request, needIds: ["qa"], metrics: [...request.metrics] } as never);
    assert.equal(response.value.status, expected.status);
    assert.deepEqual(response.value.groups.flatMap((g: { facts: Array<{ value: number | null }> }) => g.facts.map((f) => f.value)).sort(), expected.facts.map((f) => f.value).sort());
  }
  for (const request of [{ method: "compare", scope, metrics: ["amount"], purpose: "缺参照" }, { method: "aggregate", scope, metrics: ["amount"], by: ["free_sql"], purpose: "错误维度" }]) {
    const response = await call("analyze", { action: "query", request });
    assert.equal(response.isError, true);
    assert.match(response.value.error, /参照|reference|维度|参数/);
  }
});

test("重复查询复用操作，翻页不重算或登记；情景只用已读总体基线", async (t) => {
  const { call, tools } = await setup(t);
  const request = { method: "aggregate", scope, metrics: ["amount"], purpose: "读取真实总体" };
  const first = await call("analyze", { action: "query", request });
  const again = await call("analyze", { action: "query", request });
  assert.equal(first.value.operationId, again.value.operationId);
  assert.notEqual(first.value.resultId, again.value.resultId);
  assert.equal(tools.evidence().facts.length, first.value.groups.flatMap((g: { facts: unknown[] }) => g.facts).length);
  const operations = tools.operations.length;
  await call("analyze", { action: "read_result", resultId: first.value.resultId });
  assert.equal(tools.operations.length, operations);
  const scenario = await call("simulate_scenario", { baselineResultId: first.value.resultId, adjustment: { kind: "amount_rate", rate: "0.1" }, netVolumeChanges: ["0", "0.2"], reason: "显式固定结构假设" });
  assert.equal(scenario.isError, undefined, JSON.stringify(scenario.value));
  assert.ok(scenario.value.groups.flatMap((g: { facts: Array<{ metricId: string }> }) => g.facts).some((f: { metricId: string }) => f.metricId === "scenario.revenue_after"));
  assert.equal((await call("simulate_scenario", { baselineResultId: "不存在", adjustment: { kind: "amount_rate", rate: "0.1" }, netVolumeChanges: ["0"], reason: "假设" })).isError, true);
});

test("参数错误不伪装完成；提交可多次，图只接受真实结果", async (t) => {
  const { call, tools, submitted } = await setup(t);
  assert.equal((await call("draw_chart", { resultId: "missing", metric: "amount", kind: "bar" })).isError, true);
  const result = await call("analyze", { action: "query", request: { method: "aggregate", scope, metrics: ["amount"], by: ["region"], purpose: "画图数据" } });
  const chart = await call("draw_chart", { resultId: result.value.resultId, metric: "amount", kind: "bar", by: "region" });
  assert.equal(chart.isError, undefined);
  assert.ok(tools.charts.has(chart.value.chartId));
  await call("submit_answer", { body: "先给一个判断" });
  await call("submit_answer", { body: "按实际问题自由组织的新判断" });
  assert.deepEqual(submitted, ["先给一个判断", "按实际问题自由组织的新判断"]);
});

test("二十个情景可完整续读，每个净量情景的金额与变化仍同组", async (t) => {
  const { call, tools } = await setup(t);
  const base = await call("analyze", { action: "query", request: { method: "aggregate", scope, metrics: ["amount"], purpose: "情景基线" } });
  const first = await call("simulate_scenario", { baselineResultId: base.value.resultId, adjustment: { kind: "amount_rate", rate: "0.1" }, netVolumeChanges: Array.from({ length: 20 }, (_, i) => `0.${String(i).padStart(2, "0")}`), reason: "完整比较多个显式假设，商品结构、价格与销售范围保持不变。".repeat(4) });
  assert.equal(first.isError, undefined, JSON.stringify(first.value));
  const ids: string[] = []; let page = first.value;
  while (true) {
    assert.ok(JSON.stringify(page).length <= 16000);
    ids.push(...page.groups.flatMap((group: { facts: Array<{ id: string }> }) => group.facts.map((fact) => fact.id)));
    if (!page.nextCursor) break;
    page = (await call("analyze", { action: "read_result", resultId: first.value.resultId, cursor: page.nextCursor })).value;
  }
  assert.equal(ids.length, tools.results.get(first.value.resultId)!.result.facts.length);
  assert.equal(new Set(ids).size, ids.length);
});

test("多指标扫描的重复辅助事实不阻止唯一业务指标排序", async (t) => {
  const { call, tools } = await setup(t);
  const response = await call("analyze", { action: "query", request: { method: "scan", scope, metrics: ["amount", "orders"], by: ["store"], purpose: "按实收份额读取全部门店" }, orderBy: { metric: "amount.share", direction: "desc" } });
  assert.equal(response.isError, undefined, JSON.stringify(response.value));
  const facts = tools.results.get(response.value.resultId)!.result.facts;
  const expected = facts.filter((fact) => fact.metricId === "amount.share").sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  const seen = new Set<string>(), shares: string[] = [];
  let page = response.value;
  while (true) {
    for (const group of page.groups) for (const fact of group.facts) {
      seen.add(fact.id);
      if (fact.metricId === "amount.share") { assert.notEqual(group.kind, "supporting"); shares.push(fact.id); }
    }
    if (!page.nextCursor) break;
    page = (await call("analyze", { action: "read_result", resultId: response.value.resultId, cursor: page.nextCursor })).value;
  }
  assert.equal(expected.length, 4);
  assert.deepEqual(shares, expected.map((fact) => fact.id));
  assert.deepEqual([...seen].sort(), facts.map((fact) => fact.id).sort());
});

test("同时读取原值与比率仍可按原值排序画图，分子分母证据完整保留", async (t) => {
  const { call, tools } = await setup(t);
  const response = await call("analyze", { action: "query", request: { method: "aggregate", scope, metrics: ["amount", "orders", "amount_per_order"], by: ["store"], purpose: "同时对比门店实收、订单与客单价" }, orderBy: { metric: "amount", direction: "desc" } });
  assert.equal(response.isError, undefined, JSON.stringify(response.value));
  const stored = tools.results.get(response.value.resultId)!;
  const primary = response.value.groups.filter((group: { kind?: string }) => !group.kind);
  const amounts = primary.flatMap((group: { facts: Array<{ metricId: string; value: number }> }) => group.facts.filter((fact) => fact.metricId === "amount"));
  assert.equal(amounts.length, 4);
  assert.deepEqual(amounts.map((fact: { value: number }) => fact.value), [64820, 64820, 56238, 56238]);
  assert.equal(response.value.groups.flatMap((group: { facts: unknown[] }) => group.facts).length, stored.result.facts.length);
  assert.ok(stored.result.facts.filter((fact) => fact.metricId === "amount").length > 4, "完整依据保留原值和比率父链的各个事实身份");
  const chart = await call("draw_chart", { resultId: response.value.resultId, metric: "amount", kind: "bar", by: "store" });
  assert.equal(chart.isError, undefined, JSON.stringify(chart.value));
  assert.equal(chart.value.categories, 4);
  assert.deepEqual(tools.charts.get(chart.value.chartId)!.series[0].values.map((point) => point.value).sort((a, b) => b! - a!), [64820, 64820, 56238, 56238]);
});

const scanMetrics = ["amount", "orders", "quantity", "profit", "margin_rate", "discount_rate", "amount_per_order", "stores"] as const;
function ordinaryScanSession(): AnalysisDataSession & { reads: AnalysisAggregateQuery[] } {
  // 全部为内存合成记录；同一订单横跨优惠，父组必须独立去重，不能相加子组订单数。
  const rows = [
    { offer: "A", store: "S1", order: "共同订单", amount: 100, quantity: 1, profit: 20, tag_amount: 125 },
    { offer: "B", store: "S1", order: "共同订单", amount: 200, quantity: 2, profit: 60, tag_amount: 250 },
    { offer: "B", store: "S2", order: "独立订单2", amount: 50, quantity: 1, profit: 10, tag_amount: 100 },
    { offer: "C", store: "S1", order: "独立订单3", amount: 150, quantity: 1, profit: 30, tag_amount: 150 },
  ];
  const reads: AnalysisAggregateQuery[] = [];
  return {
    snapshotId: "memory-scan", datasetVersion: "memory-scan/v1", reads,
    capabilities: { mode: "database", name: "仅内存合成扫描", currency: "CNY", provenance: "sample", coverage: scope.period, dimensions: ["offer", "store"], metrics: analysisMetricDefinitions("CNY", [...scanMetrics, "rows", "tag_amount"], "database"), methods: ["aggregate", "scan"], limitations: [] },
    async aggregate(query) {
      reads.push(structuredClone(query));
      const groups = new Map<string, typeof rows>();
      for (const row of rows) {
        const key = JSON.stringify(query.by.map((dimension) => row[dimension as keyof typeof row]));
        const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
      }
      return [...groups.values()].map((selected): AnalysisAggregateCell => ({
        dimensions: Object.fromEntries(query.by.map((dimension) => [dimension, selected[0][dimension as keyof typeof selected[0]]])),
        rows: selected.length, amount: selected.reduce((sum, row) => sum + row.amount, 0), quantity: selected.reduce((sum, row) => sum + row.quantity, 0),
        profit: selected.reduce((sum, row) => sum + row.profit, 0), tag_amount: selected.reduce((sum, row) => sum + row.tag_amount, 0), grams: null,
        orders: new Set(selected.map((row) => `${row.store}:${row.order}`)).size, stores: new Set(selected.map((row) => row.store)).size,
      }));
    },
    async close() {},
  };
}

test("普通scan八指标内存回归：原值排序画图、完整分页及v4父链不丢", async () => {
  const session = ordinaryScanSession();
  try {
    const source = await createAnalysisOperations(session, { filters: {} }).execute({ needIds: ["qa"], method: "scan", scope, by: ["offer"], metrics: [...scanMetrics], purpose: "真实八指标普通扫描" });
    assert.equal(source.status, "completed"); assert.equal(source.frames.length, 1);
    assert.deepEqual(source.frames[0].controls, []); assert.ok(source.methods.every((method) => !method.controls.length));
    assert.equal(source.facts.length, 125);
    const before = structuredClone(source), stored = createQaResult("memory-scan", source);
    for (const metric of scanMetrics) {
      let page = pageQaResult(stored, { pageSize: 2, orderBy: { metric, direction: "desc" } });
      const seen: string[] = [], ranked: Array<number | null> = [];
      while (true) {
        assert.ok(JSON.stringify(page).length <= 16000);
        for (const group of page.groups) {
          seen.push(...group.facts.map((fact) => fact.id));
          const ordered = group.kind ? undefined : group.facts.find((fact) => fact.metricId === metric);
          if (ordered) ranked.push(ordered.value);
        }
        if (!page.nextCursor) break;
        page = pageQaResult(stored, { cursor: page.nextCursor, pageSize: 2 });
      }
      assert.equal(new Set(seen).size, source.facts.length);
      assert.deepEqual([...seen].sort(), source.facts.map((fact) => fact.id).sort());
      assert.equal(ranked.length, 4); assert.deepEqual(ranked, [...ranked].sort((a, b) => b! - a!));
      if (metric === "amount") assert.deepEqual(ranked, [500, 250, 150, 100]);
      const chart = drawQaChart({ id: "chart", input: { resultId: stored.resultId, metric, kind: "bar", by: "offer" }, result: source, evidence: source });
      assert.equal(chart.categories.length, 3);
      for (const point of chart.series[0].values) {
        const actual = source.facts.find((fact) => fact.id === point.refIds[0])!;
        assert.equal(actual.metricId, metric); assert.equal(point.value, actual.value);
      }
      if (metric === "amount") assert.deepEqual(chart.series[0].values.map((point) => point.value), [250, 150, 100]);
    }
    const orders = source.facts.filter((fact) => fact.metricId === "orders");
    assert.equal(orders.find((fact) => !fact.objectIds.length)!.value, 3);
    assert.equal(["A", "B", "C"].reduce((sum, offer) => sum + orders.find((fact) => fact.objectIds.some((id) => source.objects.find((object) => object.id === id)?.value === offer))!.value!, 0), 4);
    const answer = assembleQaAnswer({ runId: "memory", question: "普通扫描", body: "根据全部已读优惠比较经营表现。", charts: new Map(), evidence: source, readFactIds: stored.readFactIds, operations: [{ id: stored.resultId, op: "scan", status: "completed", summary: source.purpose }] });
    const back = validatePlanAnswerV4(JSON.parse(JSON.stringify(answer)));
    assert.deepEqual(back.evidence.facts, source.facts);
    assert.deepEqual(session.reads.map((query) => query.by), [["offer"], []]);
    assert.deepEqual(source, before);
  } finally { await session.close(); }
});

test("普通scan八指标MCP回归：amount降序成功且翻页画图不重查", async (t) => {
  const session = ordinaryScanSession(), { call, tools } = await setup(t, session);
  const response = await call("analyze", { action: "query", request: { method: "scan", scope, metrics: [...scanMetrics], by: ["offer"], purpose: "按原始实收降序读取全部优惠" }, orderBy: { metric: "amount", direction: "desc" }, pageSize: 1 });
  assert.equal(response.isError, undefined, JSON.stringify(response.value));
  const stored = tools.results.get(response.value.resultId)!, before = structuredClone(stored.result);
  const seen: string[] = [], amounts: number[] = [];
  let page = response.value;
  while (true) {
    assert.ok(JSON.stringify(page).length <= 16000);
    for (const group of page.groups) {
      seen.push(...group.facts.map((fact: { id: string }) => fact.id));
      const amount = group.kind ? undefined : group.facts.find((fact: { metricId: string }) => fact.metricId === "amount");
      if (amount) amounts.push(amount.value);
    }
    if (!page.nextCursor) break;
    const next = await call("analyze", { action: "read_result", resultId: stored.resultId, cursor: page.nextCursor, pageSize: 2 });
    assert.equal(next.isError, undefined, JSON.stringify(next.value)); page = next.value;
  }
  assert.deepEqual(amounts, [500, 250, 150, 100]);
  assert.equal(new Set(seen).size, 125); assert.equal(seen.length, 125);
  assert.deepEqual([...seen].sort(), stored.result.facts.map((fact) => fact.id).sort());
  const chart = await call("draw_chart", { resultId: stored.resultId, metric: "amount", kind: "bar", by: "offer" });
  assert.equal(chart.isError, undefined, JSON.stringify(chart.value));
  assert.deepEqual(tools.charts.get(chart.value.chartId)!.series[0].values.map((point) => point.value), [250, 150, 100]);
  assert.deepEqual(session.reads.map((query) => query.by), [["offer"], []]);
  assert.equal(tools.operations.length, 1); assert.deepEqual(stored.result, before);
});
