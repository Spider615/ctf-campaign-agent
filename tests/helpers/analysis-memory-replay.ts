import assert from "node:assert/strict";
import { analysisMetricDefinitions } from "../../app/lib/analytics/analysis-v2-operations.ts";
import { createEvidenceRegistry } from "../../app/lib/analytics/analysis-v2-evidence.ts";
import type { AnalysisAggregateCell, AnalysisDataSession } from "../../app/lib/analytics/analysis-v2-types.ts";

// 独立进程使用完整模拟分组，限制堆大小验证计算、登记与分页，不能靠删事实避开内存回归。
const { createAnalysisOperations } = await import(process.argv[2] ?? new URL("../../app/lib/analytics/analysis-v2-operations.ts", import.meta.url).href);
const period = { start: "2025-08-01", end: "2025-08-01" };
const cells: AnalysisAggregateCell[] = Array.from({ length: 8000 }, (_, index) => ({ dimensions: { category: "模拟货类", material: "模拟材料", store: `模拟门店${index}` }, rows: 1, amount: 100, grams: 1, quantity: 1, orders: 1, stores: 1, profit: null, tag_amount: 110, orderIds: [`模拟单号${index}`] }));
const session: AnalysisDataSession = {
  snapshotId: "memory-fixture", datasetVersion: "immutable-memory-fixture",
  capabilities: { mode: "snapshot", name: "模拟大分组", coverage: period, currency: "CNY", provenance: "sample", dimensions: ["category", "material", "store"], metrics: analysisMetricDefinitions("CNY", ["amount", "orders", "grams", "rows", "tag_amount", "gap_per_gram", "amount_per_gram"], "snapshot"), methods: ["scan"], limitations: [] },
  aggregate: async () => { throw new Error("此用例必须使用完整订单集合，不得降级或截取数据"); }, aggregateWithOrderIds: async () => cells, close: async () => {},
};
const operations = createAnalysisOperations(session, { filters: {} });
const input = { needIds: ["need-1"], purpose: "完整门店扫描", method: "scan" as const, scope: { period, population: "sales" as const, filters: {} }, metrics: ["amount", "orders", "grams", "gap_per_gram", "amount_per_gram"] as const, by: ["category", "material", "store"] as const, controls: ["category", "material"] as const, breakdown: "store" as const };
const request = { ...input, metrics: [...input.metrics], by: [...input.by], controls: [...input.controls] };
const result = await operations.execute(request);
assert.equal(result.methods[0].groupCount, 8000);
assert.equal(result.facts.length, 416015);
const registry = createEvidenceRegistry(); await registry.ingestAsync(result);
assert.equal(registry.view().facts.length, 416015);
assert.equal(registry.view().facts[0], result.facts[0]);
// 登记后的只读视图直接切片，不复制全量事实。
const page = { facts: registry.view().facts.filter((fact) => fact.operationId === result.operationId).slice(0, 12) };
assert.equal(page.facts.length, 12);
const reused = await operations.execute({ ...request, needIds: ["need-2"], purpose: "复用已有证据" });
assert.equal(reused.facts, result.facts); assert.equal(reused.cached, true);
console.log(JSON.stringify({ groups: 8000, facts: registry.view().facts.length, pageFacts: page.facts.length, modelCalls: 0, databaseCalls: 0 }));
