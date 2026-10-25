import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import { createAnalyticsSkillTools } from "../agent/analytics-skill-tools.ts";
import { createSnapshotAnalysisProvider } from "../app/lib/analytics/analysis-v2-snapshot.ts";
import { createAnalysisOperations } from "../app/lib/analytics/analysis-v2-operations.ts";
import { sampleDataset } from "../app/lib/analytics/sample.ts";

const dataset = sampleDataset();
const scope = { period: { start: "2026-08-01", end: "2026-08-31" }, population: "sales" as const, filters: {} };
const reference = { ...scope, period: { start: "2025-08-01", end: "2025-08-31" } };
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const session = await createSnapshotAnalysisProvider(dataset).open();
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
