import test from "node:test";
import assert from "node:assert/strict";
import type { AnalysisEvidence, AnalysisFact, AnalysisFrame, AnalysisOperationResult } from "../app/lib/analytics/analysis-v2-types.ts";

// 首次执行时模块尚不存在，按公开接口报告缺少实现；不让导入错误掩盖用例。
const implementation = await import("../app/lib/analytics/analysis-v2-evidence.ts").catch(() => null);
function api() { assert.ok(implementation, "尚未实现 v2 证据核验接口"); return implementation; }

function frame(id = "frame-current", start = "2026-08-01", end = "2026-08-31"): AnalysisFrame {
  return { id, snapshotId: "snapshot-test", datasetVersion: "version-test", mode: "snapshot", provenance: "sample", scope: { period: { start, end }, population: "sales", filters: { regions: ["华东"] } }, currency: "CNY", grain: "group", controls: ["store", "category"], limitations: ["模拟数据不能当作真实经营结果"] };
}
function fact(id = "fact-current", frameId = "frame-current", value: number | null = 200.3): AnalysisFact {
  return { id, frameId, metricId: "amount", label: "销售额", value, unit: "CNY", definition: "金额逐行按分汇总后换算为元", objectIds: [], operationId: "operation-compare", limitations: [] };
}
function evidence(): AnalysisEvidence {
  return { frames: [frame(), frame("frame-reference", "2026-07-01", "2026-07-31")], facts: [fact(), fact("fact-reference", "frame-reference", 100.1), { ...fact("fact-delta", "frame-current", 100.2), metricId: "amount.delta", label: "销售额差额", derivation: { op: "subtract", args: [{ factId: "fact-current" }, { factId: "fact-reference" }] } }], objects: [
    { id: "store-a", frameId: "frame-current", dimension: "store", value: "1088", label: "门店1088" },
    { id: "store-b", frameId: "frame-current", dimension: "store", value: "2569", label: "门店2569" },
  ], methods: [{ id: "method-compare", operationId: "operation-compare", status: "completed", method: "compare", frameIds: ["frame-current", "frame-reference"], controls: ["store", "category"], checks: [{ name: "可比口径", status: "performed", result: "使用共同门店与相同货类口径" }], sampleRows: 20, groupCount: 2, limitations: [] }] };
}
function operation(): AnalysisOperationResult {
  return { ...evidence(), operationId: "operation-compare", status: "completed", method: "compare", needIds: ["need-change"], purpose: "比较同店销售额差异", limitations: [] };
}

test("注册结果不可被外部对象修改，重复内容复用且同编号篡改拒绝", () => {
  const registry = api().createEvidenceRegistry(); const input = operation(); registry.ingest(input);
  input.facts[0].value = 999; assert.equal(registry.bundle().facts[0].value, 200.3);
  const copy = registry.bundle(); copy.facts[0].value = 888; assert.equal(registry.bundle().facts[0].value, 200.3);
  registry.ingest(operation()); assert.equal(registry.bundle().facts.length, 3);
  const changed = operation(); changed.facts[0].value = 300;
  assert.throws(() => registry.ingest(changed), /编号|事实|一致|覆盖/);
  assert.equal(registry.bundle().facts[0].value, 200.3);
});

test("内部只读视图省去全量复制，同时冻结记录父链且旧视图不随新增证据改变", () => {
  const registry = api().createEvidenceRegistry(); registry.ingest(operation());
  const first = registry.view(); assert.equal(registry.view(), first);
  assert.throws(() => { first.facts[0].value = 999; }, TypeError);
  assert.throws(() => { first.facts.push(fact("forged")); }, TypeError);
  const delta = first.facts.find((entry) => entry.id === "fact-delta")!;
  assert.ok(delta.derivation && "args" in delta.derivation);
  assert.throws(() => { if (delta.derivation && "args" in delta.derivation) delta.derivation.args.push({ constant: 100 }); }, TypeError);
  const next = operation(); next.operationId = "operation-next"; next.facts = [{ ...fact("next-value"), operationId: next.operationId }]; next.methods = next.methods.map((method) => ({ ...method, id: "next-method", operationId: next.operationId }));
  registry.ingest(next); assert.notEqual(registry.view(), first); assert.equal(first.facts.length, 3); assert.equal(registry.view().facts.length, 4);
  const editableCopy = registry.bundle(); editableCopy.facts[0].value = 900; assert.equal(registry.view().facts[0].value, 200.3);
  registry.clear(); assert.equal(registry.view().facts.length, 0); assert.equal(first.facts.length, 3);
});

test("累计大结果合并保留全部事实，不因函数参数数量限制丢失门店依据", () => {
  const registry = api().createEvidenceRegistry();
  const first = operation();
  first.facts = Array.from({ length: 80000 }, (_, index) => fact(`bulk-${index}`, "frame-current", index));
  registry.ingest(first);
  const second = operation(); second.operationId = "operation-second";
  second.methods = second.methods.map((method) => ({ ...method, id: "method-second", operationId: second.operationId }));
  second.facts = Array.from({ length: 80000 }, (_, index) => ({ ...fact(`bulk-${80000 + index}`, "frame-current", 80000 + index), operationId: second.operationId }));
  registry.ingest(second);
  const stored = registry.bundle();
  assert.equal(stored.facts.length, 160000);
  assert.equal(stored.facts[0].value, 0);
  assert.equal(stored.facts[79999].value, 79999);
  assert.equal(stored.facts[80000].value, 80000);
  assert.equal(stored.facts.at(-1)!.value, 159999);
});

test("分批登记完整保留证据并与同步登记相同，重复操作仍逐项核对", async () => {
  const input = operation();
  input.facts.push(...Array.from({ length: 12000 }, (_, index) => fact(`async-${index}`, "frame-current", index % 2 ? null : index)));
  const sync = api().createEvidenceRegistry(); sync.ingest(input);
  const asyncRegistry = api().createEvidenceRegistry(); await asyncRegistry.ingestAsync(input);
  assert.deepEqual(asyncRegistry.view(), sync.view());
  input.facts[0].value = 999;
  assert.equal(asyncRegistry.view().facts[0].value, 200.3);
  const copy = sync.bundle();
  await asyncRegistry.ingestAsync({ ...operation(), ...copy });
  assert.deepEqual(asyncRegistry.view(), sync.view());
  copy.facts.at(-1)!.value = 12;
  const prior = asyncRegistry.view();
  await assert.rejects(asyncRegistry.ingestAsync({ ...operation(), ...copy }), /覆盖|内容不同/);
  assert.equal(asyncRegistry.view(), prior);
  assert.throws(() => { asyncRegistry.view().facts.at(-1)!.value = 888; }, TypeError);
});

test("大证据登记期间排队取消可执行，失败和清空均不留下部分视图", async () => {
  const registry = api().createEvidenceRegistry(); registry.ingest(operation());
  const prior = registry.view();
  const input = operation(); input.operationId = "operation-bulk-async";
  input.methods = input.methods.map((method) => ({ ...method, id: "method-bulk-async", operationId: input.operationId }));
  input.facts = Array.from({ length: 40000 }, (_, index) => ({ ...fact(`async-cancel-${index}`, "frame-current", index), operationId: input.operationId }));
  const controller = new AbortController();
  const pending = registry.ingestAsync(input, controller.signal);
  let abortObserved = false;
  setTimeout(() => { abortObserved = true; assert.equal(registry.view(), prior); controller.abort(); }, 0);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(abortObserved, true); assert.equal(registry.view(), prior);
  const malformed = structuredClone(input); malformed.facts.at(-1)!.frameId = "unknown";
  await assert.rejects(registry.ingestAsync(malformed), /不存在的数据范围/);
  assert.equal(registry.view(), prior);
  const clearing = registry.ingestAsync(input);
  registry.clear(); const empty = registry.view();
  await assert.rejects(clearing, /登记期间.*改变/);
  assert.equal(registry.view(), empty); assert.equal(empty.facts.length, 0);
  await registry.ingestAsync(input); assert.equal(registry.view().facts.length, 40000);
});

test("封存计算结果仍核验依赖和真实值，外部冻结不能伪装已解析证据", async () => {
  const { sealOwnedAnalysisOperation } = await import("../app/lib/analytics/analysis-v2-evidence.ts");
  const forged = operation(); forged.facts[2].value = 999;
  const sealed = await sealOwnedAnalysisOperation(forged);
  const registry = api().createEvidenceRegistry();
  await assert.rejects(registry.ingestAsync(sealed), /派生|真实值|重算/);
  assert.equal(registry.view().facts.length, 0);
  const ordinary = operation(); Object.freeze(ordinary.facts);
  registry.ingest(ordinary);
  ordinary.facts[0].value = 999;
  assert.equal(registry.view().facts[0].value, 200.3);
  assert.notEqual(registry.view().facts[0], ordinary.facts[0]);
  const malformed = operation(); malformed.facts[0].value = Infinity;
  await assert.rejects(sealOwnedAnalysisOperation(malformed), /有限数值/);
});

test("已封存事实数组不能替换业务对象数组绕过字段类型核验", async () => {
  const { sealOwnedAnalysisOperation } = await import("../app/lib/analytics/analysis-v2-evidence.ts");
  const input = operation(); input.facts.forEach((fact) => { fact.objectIds = []; });
  const sealed = await sealOwnedAnalysisOperation(input);
  const registry = api().createEvidenceRegistry();
  await assert.rejects(registry.ingestAsync({ ...sealed, objects: sealed.facts as unknown as AnalysisOperationResult["objects"] }), /维度|业务标识/);
  assert.equal(registry.view().facts.length, 0);
});

test("大计算结果封存期间响应取消，不向注册表提交部分证据", async () => {
  const { sealOwnedAnalysisOperation } = await import("../app/lib/analytics/analysis-v2-evidence.ts");
  const input = operation(); input.facts = Array.from({ length: 40000 }, (_, index) => fact(`seal-${index}`, "frame-current", index));
  const controller = new AbortController(); let cancelled = false;
  const pending = sealOwnedAnalysisOperation(input, controller.signal);
  setTimeout(() => { cancelled = true; controller.abort(); }, 0);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, true);
});

test("不允许静默混入新实时快照，clear 后才能注册新运行", () => {
  const registry = api().createEvidenceRegistry(); registry.ingest(operation());
  const changed = operation(); changed.operationId = "new-operation";
  for (const f of changed.frames) f.snapshotId = "new-snapshot";
  for (const f of changed.facts) f.operationId = "new-operation";
  for (const m of changed.methods) m.operationId = "new-operation";
  assert.throws(() => registry.ingest(changed), /快照|版本|编号/);
  registry.clear(); assert.deepEqual(registry.bundle(), { frames: [], facts: [], objects: [], methods: [] });
  registry.ingest(changed); assert.equal(registry.bundle().frames[0].snapshotId, "new-snapshot");
});

test("注册表独立持有解析后的证据，入参和返回副本修改不能污染原始核验图", () => {
  const outcome = operation(); const original = structuredClone(outcome);
  const registry = api().createEvidenceRegistry(); registry.ingest(outcome);
  outcome.facts[0].value = 999; outcome.facts[0].objectIds.push("额外对象"); outcome.frames[0].scope.period.start = "2020-01-01"; outcome.methods[0].checks[0].result = "伪造检查";
  const exported = registry.bundle(); assert.deepEqual(exported.facts, original.facts); assert.deepEqual(exported.frames, original.frames); assert.deepEqual(exported.methods, original.methods);
  exported.facts[0].value = 888; exported.methods[0].checks[0].status = "unavailable";
  assert.deepEqual(registry.bundle().facts, original.facts); assert.deepEqual(registry.bundle().methods, original.methods);
  assert.doesNotThrow(() => registry.ingest(original));
});

test("completed 操作必须有真实方法记录和已执行检查", () => {
  const missing = operation(); missing.methods = []; missing.facts = []; missing.frames = []; missing.objects = [];
  assert.throws(() => api().createEvidenceRegistry().ingest(missing), /方法|检查/);
  const noCheck = operation(); noCheck.methods[0].checks = [];
  assert.throws(() => api().createEvidenceRegistry().ingest(noCheck), /方法|检查/);
});

// 证据图自检：最终 v3 答案和计划执行都依赖 validateAnalysisEvidence，旧草稿校验已删除。
function rejects(e: AnalysisEvidence, pattern: RegExp) { assert.throws(() => api().validateAnalysisEvidence(e), pattern); }

test("合法事实、派生关系、对象与周期通过证据自检", () => {
  const registry = api().createEvidenceRegistry(); registry.ingest(operation());
  const checked = api().validateAnalysisEvidence(registry.bundle());
  assert.equal(checked.facts.find((f) => f.id === "fact-delta")?.value, 100.2);
});

test("篡改或漏父引用的派生值不能通过", () => {
  const wrong = evidence(); wrong.facts[2].value = 999; rejects(wrong, /实际值与父事实运算结果不一致/);
  const missing = evidence(); missing.facts[2].derivation = { op: "subtract", args: [{ factId: "fact-current" }, { factId: "absent" }] }; rejects(missing, /缺少父事实/);
});

test("派生图拒绝循环、自引用和任意可执行表达式", () => {
  const cyclic = evidence(); cyclic.facts[0].derivation = { factId: "fact-delta" }; rejects(cyclic, /循环/);
  const self = evidence(); self.facts[2].derivation = { factId: "fact-delta" }; rejects(self, /循环/);
  const arbitrary = evidence(); (arbitrary.facts[2] as unknown as Record<string, unknown>).derivation = { op: "eval", code: "process.exit()" }; rejects(arbitrary, /派生/);
});

test("缺失和零分母保持 null，真实零仍为零", () => {
  const e = evidence(); e.facts[1].value = null; e.facts[2].value = null;
  assert.doesNotThrow(() => api().validateAnalysisEvidence(e));
  e.facts[2].value = 0; rejects(e, /缺失与零不能互换/);
  const ratio = evidence(); ratio.facts[1].value = 0; ratio.facts[2] = { ...ratio.facts[2], value: null, metricId: "amount.relative_change", unit: "%", derivation: { op: "divide", args: [{ factId: "fact-current" }, { factId: "fact-reference" }] } };
  assert.doesNotThrow(() => api().validateAnalysisEvidence(ratio));
  ratio.facts[2].value = 0; rejects(ratio, /缺失与零不能互换/);
  const zero = evidence(); zero.facts[0].value = 0; zero.facts[1].value = 0; zero.facts[2].value = 0;
  assert.doesNotThrow(() => api().validateAnalysisEvidence(zero));
});

test("跨币种、错粒度与跨人口的派生不能通过，实际拆解允许跨人口净额算术", () => {
  const currency = evidence(); currency.frames[1].currency = "USD"; rejects(currency, /币种/);
  const grain = evidence(); grain.frames[1].grain = "selected_order"; rejects(grain, /粒度/);
  const population = evidence(); population.frames[1].scope.population = "net"; rejects(population, /人口口径/);
  const decomposed = evidence(); decomposed.methods[0].method = "decompose"; decomposed.frames[1].scope.population = "returns";
  decomposed.facts[2].derivation = { op: "add", args: [{ factId: "fact-current" }, { factId: "fact-reference" }] }; decomposed.facts[2].value = 300.4;
  assert.doesNotThrow(() => api().validateAnalysisEvidence(decomposed));
});

test("币种未核对或人口口径为 unknown 的派生事实被拒绝", () => {
  const currency = evidence(); currency.frames[1].currency = "未核对"; currency.frames[0].currency = "未核对";
  rejects(currency, /币种不同或尚未核对/);
  const population = evidence(); population.frames[0].scope.population = "unknown"; population.frames[1].scope.population = "unknown";
  rejects(population, /人口口径尚未核对/);
});

test("派生结果不得把金额单位改成百分比或件数，嵌套量价拆解是合法算术", () => {
  for (const unit of ["%", "件"]) { const e = evidence(); e.facts[2].unit = unit; rejects(e, /单位/); }
  const e = evidence(); e.facts.push({ ...fact("quantity-current", "frame-current", 10), metricId: "quantity", unit: "件" }, { ...fact("quantity-reference", "frame-reference", 5), metricId: "quantity", unit: "件" });
  const expr = { op: "multiply" as const, args: [{ factId: "quantity-current" }, { op: "subtract" as const, args: [{ op: "divide" as const, args: [{ factId: "fact-current" }, { factId: "quantity-current" }] }, { op: "divide" as const, args: [{ factId: "fact-reference" }, { factId: "quantity-reference" }] }] }] };
  e.facts[2].derivation = { op: "add", args: [expr] }; e.facts[2].value = 0.1; e.methods[0].method = "decompose";
  assert.doesNotThrow(() => api().validateAnalysisEvidence(e));
});

test("同框牌价减实收可派生差额，件数不能与金额相减", () => {
  const e = evidence(); e.facts[1].frameId = "frame-current"; e.facts[1].metricId = "tag_amount"; e.facts[1].value = 300.3;
  e.facts[2].derivation = { op: "subtract", args: [{ factId: "fact-reference" }, { factId: "fact-current" }] }; e.facts[2].value = 100;
  assert.doesNotThrow(() => api().validateAnalysisEvidence(e));
  e.facts[1].metricId = "quantity"; e.facts[1].unit = "件"; rejects(e, /单位/);
});

test("同标签同单位但基础财务定义不同，不能直接派生比较", () => {
  const e = evidence(); e.frames[1].mode = "historical"; e.frames[1].snapshotId = "old-snapshot"; e.frames[1].datasetVersion = "old-version";
  e.facts.forEach((f) => { f.metricId = f.metricId.replace("amount", "profit"); });
  e.facts[0].definition = "源字段零售毛利直接汇总"; e.facts[1].definition = "实收减导入成本";
  rejects(e, /定义不同/);
});

test("畸形日期、无限值和重复编号不能进入证据", () => {
  const badDate = evidence(); badDate.frames[0].scope.period.start = "2026-02-30"; rejects(badDate, /日期/);
  const infinite = evidence(); infinite.facts[0].value = Infinity; rejects(infinite, /有限数值/);
  const duplicate = evidence(); duplicate.facts.push(structuredClone(duplicate.facts[0])); rejects(duplicate, /重复编号/);
  rejects({ metadata: { mode: "database" }, sources: [] } as unknown as AnalysisEvidence, /格式|数组/);
});

test("within_stratum 的实际控制值与对象或筛选不一致时退回", () => {
  const e = evidence(); e.facts[0] = { ...e.facts[0], comparisonRole: "within_stratum", comparisonControls: ["category"], comparisonValues: {} };
  rejects(e, /控制维度/);
});

test("真实计算层的五类操作结果均可注册并核对派生值", async () => {
  const { createSnapshotAnalysisProvider } = await import("../app/lib/analytics/analysis-v2-snapshot.ts");
  const { createAnalysisOperations } = await import("../app/lib/analytics/analysis-v2-operations.ts");
  const rows = [
    { date: "2026-07-01", store: "A", category: "低价", amount: 50, quantity: 5 },
    { date: "2026-07-01", store: "B", category: "高价", amount: 150, quantity: 5 },
    { date: "2026-08-01", store: "A", category: "低价", amount: 20, quantity: 2 },
    { date: "2026-08-01", store: "B", category: "高价", amount: 240, quantity: 8 },
  ].map((r, i) => ({ lineId: `line-${i}`, date: r.date, store: r.store, category: r.category, netSales: r.amount, quantity: r.quantity, orderId: `order-${i}`, region: "华东", city: null, sku: null, memberId: null, memberSegment: null, campaignId: null, cost: null, weightGrams: null }));
  const session = await createSnapshotAnalysisProvider({ schema: "analytics-dataset/v1", id: "synthetic-evidence", version: "synthetic-version", name: "模拟核验数据", provenance: "sample", currency: "CNY", createdAt: "2026-10-13T00:00:00Z", rows, rules: [], sourceFiles: [], mappings: { sales: {}, campaigns: {} }, minDate: "2026-07-01", maxDate: "2026-08-01", warnings: [] }).open();
  try {
    const operations = createAnalysisOperations(session, { filters: {} }); const registry = api().createEvidenceRegistry();
    for (const method of ["aggregate", "compare", "decompose", "scan", "robustness"] as const) {
      const result = await operations.execute({ needIds: ["need-change"], purpose: "核对真实计算与证据衔接", method, scope: { period: { start: "2026-08-01", end: "2026-08-01" }, population: "sales", filters: {} }, reference: { period: { start: "2026-07-01", end: "2026-07-01" }, population: "sales", filters: {} }, metrics: ["amount"], controls: ["category"], breakdown: "category", check: "largest_store" });
      assert.equal(result.status, "completed"); registry.ingest(result);
    }
    assert.ok(registry.bundle().facts.length > 10);
    const net = await operations.execute({ needIds: ["need-change"], purpose: "核对净销售的真实组成", method: "decompose", scope: { period: { start: "2026-08-01", end: "2026-08-01" }, population: "net", filters: {} }, reference: { period: { start: "2026-07-01", end: "2026-07-01" }, population: "net", filters: {} }, metrics: ["amount"] });
    registry.ingest(net);
    assert.ok(net.facts.some((fact) => fact.metricId === "amount.decomposed_change"));
    assert.doesNotThrow(() => api().validateAnalysisEvidence(registry.bundle()));
  } finally { await session.close(); }
});
