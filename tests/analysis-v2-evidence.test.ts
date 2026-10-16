import test from "node:test";
import assert from "node:assert/strict";
import type { AnalysisAnswer, AnalysisDataSession, AnalysisDraft, AnalysisEvidence, AnalysisFact, AnalysisFrame, AnalysisOperationResult, AnalysisTask } from "../app/lib/analytics/analysis-v2-types.ts";

// 首次执行时模块尚不存在，按公开接口报告缺少实现；不让导入错误掩盖用例。
const implementation = await import("../app/lib/analytics/analysis-v2-evidence.ts").catch(() => null);
function api() { assert.ok(implementation, "尚未实现 v2 证据核验接口"); return implementation; }

function task(): AnalysisTask {
  return { runId: "run-test", question: "比较八月与七月销售额，解释差异并给出建议", context: ["只看华东，保持同店和货类可比。"], needs: [
    { id: "need-change", userQuote: "比较八月与七月销售额", judgement: "可比销售额差异", status: "supported", conclusionIds: ["conclusion-change"] },
  ], hardScope: { period: { start: "2026-07-01", end: "2026-08-31" }, filters: { regions: ["华东"] } }, assumptions: [] };
}
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
function draft(): AnalysisDraft {
  return { status: "answered", conclusions: [{ id: "conclusion-change", needIds: ["need-change"], level: "comparison_supported", judgement: "可比销售额上升，差异仍需结合结构解释。", factIds: ["fact-delta"], objectIds: [], methodIds: ["method-compare"], limitations: ["尚未证明变化的业务原因"] }], blocks: [{ kind: "paragraph", conclusionId: "conclusion-change", nodes: [{ kind: "period_ref", frameId: "frame-current" }, { kind: "text", text: "可比销售额比前期增加" }, { kind: "fact_ref", factId: "fact-delta" }, { kind: "text", text: "，尚未证明业务原因。" }] }], questions: [], userConditions: [], trialParameters: [] };
}
function answer(): AnalysisAnswer { return { schema: "analysis-answer/v2", ...draft(), task: task(), evidence: evidence(), review: { verdict: "accept", issues: [] } }; }
function invalid(d: unknown, e = evidence(), t = task(), kind?: string) {
  const result = api().validateAnalysisDraft(t, d, e);
  assert.equal(result.valid, false);
  assert.ok(result.issues.length);
  if (kind) assert.ok(result.issues.some((issue) => issue.kind === kind), JSON.stringify(result.issues));
  assert.ok(result.issues.every((issue) => issue.requirement.trim().length > 0));
  return result;
}

test("合法事实、派生关系、对象与周期引用可以通过", () => {
  const registry = api().createEvidenceRegistry(); registry.ingest(operation());
  assert.equal(api().validateAnalysisDraft(task(), draft(), registry.bundle()).valid, true);
  const result = api().validateAnalysisAnswer(answer());
  assert.equal(result.evidence.facts.find((f) => f.id === "fact-delta")?.value, 100.2);
});

test("时间指代不是成交次数，日期对象后的单日实收不是用日期充当单数", () => {
  const e = evidence(); e.frames[0].scope.period.end = e.frames[0].scope.period.start; e.frames[1].scope.period.end = e.frames[1].scope.period.start;
  e.objects.push({ id: "day-a", frameId: "frame-current", dimension: "day", value: "2026-08-01", label: "2026-08-01" });
  const d = draft(); d.conclusions[0].objectIds = ["day-a"];
  d.blocks[0].nodes = [{ kind: "object_ref", objectId: "day-a" }, { kind: "text", text: "单日实收为" }, { kind: "fact_ref", factId: "fact-current" }, { kind: "text", text: "，比参照日期增加" }, { kind: "fact_ref", factId: "fact-delta" }];
  d.questions = ["下一次验证是否沿用同样口径？上一次、这一次、那一次均需按原范围核对。"];
  const result = api().validateAnalysisDraft(task(), d, e); assert.equal(result.valid, true, JSON.stringify(result.issues));
  d.questions = ["下一次预计提升三倍，产生两单成交。"];
  invalid(d, e, task(), "expression");
});

test("剩下或赶上等动词补语中的一次仍是数量，不能被时间指代豁免", () => {
  for (const text of ["本活动剩下一次成交机会。", "还余下一次复购机会。", "给门店留下一次试验机会。", "争取赶上一次成交机会。", "拿下一次成交。", "本活动省下一次折扣申请。", "本活动扣下一次会员权益额度。", "我们记下一次优惠使用。"] ) {
    for (const entry of ["judgement", "body", "question"] as const) {
      const d = draft();
      if (entry === "judgement") d.conclusions[0].judgement = text;
      if (entry === "body") d.blocks[0].nodes = [{ kind: "text", text }];
      if (entry === "question") d.questions = [text];
      const result = invalid(d, evidence(), task(), "expression");
      assert.ok(result.issues.some((issue) => issue.requirement.includes("一次")), `${entry}: ${text}`);
    }
  }
});

test("点名与点单不是数字，小数和半数量仍必须引用", () => {
  const d = draft(); d.conclusions[0].judgement = "优先点名可比门店，调整点单话术与重点名单";
  d.questions = ["是否能在重点名单内试验点单话术？"];
  assert.equal(api().validateAnalysisDraft(task(), d, evidence()).valid, true);
  for (const text of ["提升一点五倍", "增加点五克", "持续半天", "提升百分之五点五", "增长百分之点五", "增长百分之点一"]) {
    d.conclusions[0].judgement = text; invalid(d, evidence(), task(), "expression");
  }
});

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

test("未知节点引用给出对应事项和结论的修正问题", () => {
  const d = draft(); d.blocks[0].nodes.push({ kind: "fact_ref", factId: "made-up" });
  const checked = invalid(d, evidence(), task(), "missing_evidence");
  assert.ok(checked.issues.some((issue) => issue.conclusionIds.includes("conclusion-change") && issue.needIds.includes("need-change") && issue.requirement.includes("made-up")));
});

test("篡改或漏父引用的派生值不能通过", () => {
  const wrong = evidence(); wrong.facts[2].value = 999;
  invalid(draft(), wrong, task(), "missing_evidence");
  const missing = evidence(); missing.facts[2].derivation = { op: "subtract", args: [{ factId: "fact-current" }, { factId: "absent" }] };
  invalid(draft(), missing, task(), "missing_evidence");
});

test("派生图拒绝循环、自引用和任意可执行表达式", () => {
  const cyclic = evidence(); cyclic.facts[0].derivation = { factId: "fact-delta" };
  invalid(draft(), cyclic, task(), "missing_evidence");
  const self = evidence(); self.facts[2].derivation = { factId: "fact-delta" };
  invalid(draft(), self, task(), "missing_evidence");
  const arbitrary = evidence(); (arbitrary.facts[2] as unknown as Record<string, unknown>).derivation = { op: "eval", code: "process.exit()" };
  invalid(draft(), arbitrary, task(), "missing_evidence");
});

test("缺失和零分母保持 null，真实零仍为零", () => {
  const e = evidence(); e.facts[1].value = null; e.facts[2].value = null;
  assert.equal(api().validateAnalysisDraft(task(), draft(), e).valid, true);
  e.facts[2].value = 0; invalid(draft(), e, task(), "missing_evidence");
  const ratio = evidence(); ratio.facts[1].value = 0; ratio.facts[2] = { ...ratio.facts[2], value: null, metricId: "amount.relative_change", unit: "%", derivation: { op: "divide", args: [{ factId: "fact-current" }, { factId: "fact-reference" }] } };
  assert.equal(api().validateAnalysisDraft(task(), draft(), ratio).valid, true);
  ratio.facts[2].value = 0; invalid(draft(), ratio, task(), "missing_evidence");
  const zero = evidence(); zero.facts[0].value = 0; zero.facts[1].value = 0; zero.facts[2].value = 0;
  assert.equal(api().validateAnalysisDraft(task(), draft(), zero).valid, true);
});

test("跨币种、错粒度与用户硬范围的比较不能通过", () => {
  const currency = evidence(); currency.frames[1].currency = "USD"; invalid(draft(), currency, task(), "invalid_comparison");
  const grain = evidence(); grain.frames[1].grain = "selected_order"; invalid(draft(), grain, task(), "invalid_comparison");
  const population = evidence(); population.frames[1].scope.population = "net"; invalid(draft(), population, task(), "invalid_comparison");
  const scope = evidence(); scope.frames[0].scope.filters.regions = ["华南"]; invalid(draft(), scope, task(), "missing_evidence");
  const date = evidence(); date.frames[0].scope.period.end = "2026-09-01"; invalid(draft(), date, task(), "missing_evidence");
});

test("跨人口拆解允许实际 decompose 的净额算术，不能冒充同口径比较", () => {
  const e = evidence(); e.methods[0].method = "decompose"; e.frames[1].scope.population = "returns";
  e.facts[2].derivation = { op: "add", args: [{ factId: "fact-current" }, { factId: "fact-reference" }] }; e.facts[2].value = 300.4;
  const d = draft(); d.conclusions[0].level = "observed";
  assert.equal(api().validateAnalysisDraft(task(), d, e).valid, true);
});

test("跨期可比拆解可支持算术差异，单期拆解不支持比较级别", () => {
  const e = evidence(); e.methods[0].method = "decompose";
  assert.equal(api().validateAnalysisDraft(task(), draft(), e).valid, true);
  e.frames[1].scope.period = { ...e.frames[0].scope.period };
  invalid(draft(), e, task(), "invalid_comparison");
});

test("比较结论不能使用未执行检查或无关方法", () => {
  const unavailable = evidence(); unavailable.methods[0].checks[0].status = "unavailable"; invalid(draft(), unavailable, task(), "invalid_comparison");
  const aggregate = evidence(); aggregate.methods[0].method = "aggregate"; invalid(draft(), aggregate, task(), "invalid_comparison");
  const unrelated = evidence(); unrelated.methods[0].operationId = "other-operation"; invalid(draft(), unrelated, task(), "missing_evidence");
});

test("正确表格没有回答事项时必须退回，不能只靠事实格式完整结束", () => {
  const table = draft(); table.conclusions = []; table.blocks[0].conclusionId = undefined;
  invalid(table, evidence(), task(), "task_coverage");
  const t = task(); t.needs.push({ id: "need-action", userQuote: "给出建议", judgement: "明确行动与验证", status: "open", conclusionIds: [] });
  invalid(draft(), evidence(), t, "task_coverage");
});

test("结论需在正文出现，正文事实须属于该结论证据", () => {
  const hidden = draft(); hidden.blocks[0].conclusionId = undefined; invalid(hidden, evidence(), task(), "task_coverage");
  const d = draft(); d.blocks[0].nodes.push({ kind: "fact_ref", factId: "fact-reference" });
  // 派生事实的父链是完整依据，可在同一结论中展开。
  assert.equal(api().validateAnalysisDraft(task(), d, evidence()).valid, true);
  const e = evidence(); e.facts.push({ ...fact("fact-unrelated", "frame-current", 5), metricId: "quantity", unit: "件" });
  d.blocks[0].nodes.push({ kind: "fact_ref", factId: "fact-unrelated" }); invalid(d, e, task(), "missing_evidence");
});

test("自由文字中的阿拉伯数、中文数量与日期不能绕过事实引用", () => {
  for (const text of ["销售额为200.30元", "增加一百元", "提升百分之十", "选择三家门店", "持续两周", "八月八日开始", "增加两倍", "预测增长十个百分点", "2026年八月"]) {
    const d = draft(); d.blocks[0].nodes.push({ kind: "text", text }); invalid(d, evidence(), task(), "expression");
  }
  const ordinary = draft(); ordinary.blocks[0].nodes.push({ kind: "text", text: "一部分差异可能来自结构，一般还需结合同比口径核对。用百分比核对变化，以百分点描述组间偏离。" });
  assert.equal(api().validateAnalysisDraft(task(), ordinary, evidence()).valid, true);
});

test("拆开中文数量节点或插入空文字不能绕过数量守卫", () => {
  const split = draft(); split.blocks[0].nodes.push({ kind: "text", text: "选择三" }, { kind: "text", text: "家门店" }); invalid(split, evidence(), task(), "expression");
  const fractional = draft(); fractional.blocks[0].nodes.push({ kind: "text", text: "销售额增加一半" }); invalid(fractional, evidence(), task(), "expression");
  const object = draft(); object.conclusions[0].objectIds = ["store-a"]; object.blocks[0].nodes = [{ kind: "object_ref", objectId: "store-a" }, { kind: "text", text: "" }, { kind: "text", text: "家店" }]; invalid(object, evidence(), task(), "expression");
});

test("数字活动名通过对象引用显示，不给自由文字新增名称白名单", () => {
  const e = evidence(); e.objects.push({ id: "offer-number", frameId: "frame-current", dimension: "offer", value: "16", label: "16周年庆" });
  const d = draft(); d.conclusions[0].objectIds.push("offer-number"); d.blocks[0].nodes.push({ kind: "object_ref", objectId: "offer-number" });
  assert.equal(api().validateAnalysisDraft(task(), d, e).valid, true);
  d.blocks[0].nodes.push({ kind: "text", text: "16周年庆可以增长" }); invalid(d, e, task(), "expression");
});

test("门店编号不能在行内伪装为试点店数", () => {
  const d = draft(); d.conclusions[0].objectIds = ["store-a"];
  d.blocks[0].nodes = [{ kind: "text", text: "建议选择" }, { kind: "object_ref", objectId: "store-a" }, { kind: "text", text: "家门店试点。" }];
  invalid(d, evidence(), task(), "expression");
});

test("用户条件只接受原问题或持续要求的真实子串，并保持假设身份", () => {
  const d = draft(); d.userConditions = [{ id: "condition-east", quote: "只看华东" }];
  d.blocks[0].nodes.push({ kind: "user_condition_ref", conditionId: "condition-east" });
  assert.equal(api().validateAnalysisDraft(task(), d, evidence()).valid, true);
  const a = { ...answer(), ...d }; assert.match(api().analysisAnswerText(a), /用户条件.*只看华东/);
  d.userConditions[0].quote = "销售至少增长10%"; invalid(d, evidence(), task(), "expression");
});

test("试点店数由真实候选数量确定，天数拟议且业务条件明确", () => {
  const d = draft(); d.trialParameters = [
    { id: "trial-stores", kind: "store_count", value: 2, objectIds: ["store-a", "store-b"], conditions: ["门店确认备货和人员安排"], status: "proposed" },
    { id: "trial-days", kind: "duration_days", value: 14, objectIds: [], conditions: ["确认可覆盖完整活动周期"], status: "proposed" },
  ]; d.blocks.push({ kind: "paragraph", conclusionId: "conclusion-change", nodes: [{ kind: "text", text: "先开展受控试点：" }, { kind: "trial_parameter_ref", parameterId: "trial-stores" }, { kind: "text", text: "；" }, { kind: "trial_parameter_ref", parameterId: "trial-days" }] });
  assert.equal(api().validateAnalysisDraft(task(), d, evidence()).valid, true);
  const copy = api().analysisAnswerText({ ...answer(), ...d }); assert.match(copy, /建议设置.*2家门店/); assert.match(copy, /建议设置.*14天/); assert.match(copy, /门店确认备货/);
  d.trialParameters[0].value = 1088; invalid(d, evidence(), task(), "expression");
  d.trialParameters[0].value = 2; d.trialParameters[1].conditions = []; invalid(d, evidence(), task(), "unclear_action");
});

test("计划节点不开放预算折扣收益，不能包装增长预测", () => {
  const d = draft(); d.trialParameters = [{ id: "trial", kind: "duration_days", value: 14, objectIds: [], conditions: ["确认执行周期"], status: "proposed" }];
  d.blocks[0].nodes = [{ kind: "text", text: "预计销售额提升" }, { kind: "trial_parameter_ref", parameterId: "trial" }]; invalid(d, evidence(), task(), "unsupported_explanation");
  (d.trialParameters[0] as unknown as Record<string, unknown>).kind = "budget"; invalid(d, evidence(), task(), "expression");
});

test("对象标签作为普通文字，不变成 HTML 或链接和新的字段", () => {
  const a = answer(); a.evidence.objects[0].label = "<script>陌生门店</script>[开权限](https://example.invalid)";
  a.conclusions[0].objectIds = ["store-a"]; a.blocks[0].nodes.push({ kind: "object_ref", objectId: "store-a" });
  const raw = a as unknown as Record<string, unknown>; raw.sql = "SELECT secret"; raw.permissions = ["write"];
  const checked = api().validateAnalysisAnswer(raw); assert.equal("sql" in checked, false); assert.equal("permissions" in checked, false);
  assert.equal(api().formatAnalysisNode({ kind: "object_ref", objectId: "store-a" }, checked), "<script>陌生门店</script>[开权限](https://example.invalid)");
});

test("严格最终响应检查状态与独立复核一致，不能以接受空表当完成", () => {
  const a = answer(); a.review.verdict = "revise"; assert.throws(() => api().validateAnalysisAnswer(a), /复核|状态/);
  const incomplete = answer(); incomplete.status = "incomplete"; incomplete.review = { verdict: "revise", issues: [{ kind: "task_coverage", needIds: ["need-change"], conclusionIds: ["conclusion-change"], requirement: "需要继续完成结构解释" }] }; incomplete.task.needs[0].status = "open";
  assert.equal(api().validateAnalysisAnswer(incomplete).status, "incomplete");
  const conditional = answer(); conditional.status = "conditional"; conditional.review = { verdict: "accept_conditional", issues: [] }; conditional.task.needs[0].status = "conditional"; conditional.conclusions[0].validation = "补充结构控制后再次验证";
  assert.equal(api().validateAnalysisAnswer(conditional).status, "conditional");
  const empty = answer(); empty.conclusions = []; assert.throws(() => api().validateAnalysisAnswer(empty), /事项|结论|覆盖/);
});

test("最终响应保留真实来源元数据和源零售毛利口径，不把旧 metadata 补成 v2", () => {
  const a = answer(); a.evidence.frames.forEach((f) => { f.provenance = "imported"; f.mode = "database"; f.currency = "人民币"; });
  a.evidence.facts.forEach((f) => { f.unit = "人民币"; f.metricId = f.metricId.replace("amount", "profit"); f.definition = "源零售毛利直接汇总，不按成本反推毛利率"; f.limitations = ["源零售毛利尚未和财务口径对数"]; });
  const clean = api().validateAnalysisAnswer(a);
  assert.equal(clean.evidence.frames[0].provenance, "imported"); assert.equal(clean.evidence.frames[0].currency, "人民币"); assert.equal(clean.evidence.frames[0].mode, "database"); assert.match(clean.evidence.facts[0].definition, /源零售毛利/);
  assert.match(api().analysisAnswerText(clean), /源零售毛利尚未和财务口径对数/);
  assert.throws(() => api().validateAnalysisAnswer({ ...a, evidence: { metadata: { mode: "database" }, sources: [] } }), /证据|格式/);
});

test("正文解析金额百分比克与零缺失并保留周期，不泄露内部引用编号", () => {
  const a = answer(); a.evidence.facts.push({ ...fact("fact-percent", "frame-current", 1.23456), metricId: "amount.relative_change", unit: "%" }, { ...fact("fact-grams", "frame-current", 0.123456789), metricId: "grams", unit: "克" }, { ...fact("fact-zero", "frame-current", 0), unit: "CNY" }, { ...fact("fact-null", "frame-current", null), unit: "CNY" });
  assert.equal(api().formatAnalysisNode({ kind: "fact_ref", factId: "fact-current" }, a), "200.30元");
  assert.equal(api().formatAnalysisNode({ kind: "fact_ref", factId: "fact-percent" }, a), "1.23%");
  assert.equal(api().formatAnalysisNode({ kind: "fact_ref", factId: "fact-grams" }, a), "0.123457克");
  assert.equal(api().formatAnalysisNode({ kind: "fact_ref", factId: "fact-zero" }, a), "0.00元");
  assert.equal(api().formatAnalysisNode({ kind: "fact_ref", factId: "fact-null" }, a), "暂无可计算值");
  assert.equal(api().formatAnalysisNode({ kind: "period_ref", frameId: "frame-current" }, a), "2026年8月1日至2026年8月31日");
  const text = api().analysisAnswerText(a); assert.match(text, /100\.20元/); assert.match(text, /2026年8月/); assert.match(text, /模拟数据/); assert.doesNotMatch(text, /fact-delta|frame-current|analysis-answer\/v2|method-compare/);
});

test("百分点按两位呈现，历史 unknown 币种在复制中保留待核对身份", () => {
  const a = answer(); a.evidence.facts.push({ ...fact("point", "frame-current", 1.23456), metricId: "amount.relative_deviation", unit: "百分点" });
  assert.equal(api().formatAnalysisNode({ kind: "fact_ref", factId: "point" }, a), "1.23个百分点");
  a.evidence.frames[0].currency = "unknown"; a.evidence.frames[0].mode = "historical";
  const copy = api().analysisAnswerText(a); assert.match(copy, /币种未核对/); assert.doesNotMatch(copy, /unknown/);
});

test("每单和日均金额保留两位，只有每克使用更多精度", () => {
  const a = answer(); a.evidence.facts.push({ ...fact("per-order", "frame-current", 12.345678), metricId: "amount_per_order", unit: "CNY/单" }, { ...fact("daily", "frame-current", 12.345678), metricId: "amount.daily", unit: "人民币/日" }, { ...fact("per-gram", "frame-current", 12.3456789), metricId: "amount_per_gram", unit: "CNY/克" });
  assert.equal(api().formatAnalysisNode({ kind: "fact_ref", factId: "per-order" }, a), "12.35元/单");
  assert.equal(api().formatAnalysisNode({ kind: "fact_ref", factId: "daily" }, a), "12.35元/日");
  assert.equal(api().formatAnalysisNode({ kind: "fact_ref", factId: "per-gram" }, a), "12.345679元/克");
});

test("畸形日期、无限值、重复引用身份不能进入最终响应", () => {
  const badDate = answer(); badDate.evidence.frames[0].scope.period.start = "2026-02-30"; assert.throws(() => api().validateAnalysisAnswer(badDate), /日期|周期|格式/);
  const infinite = answer(); infinite.evidence.facts[0].value = Infinity; assert.throws(() => api().validateAnalysisAnswer(infinite), /事实|有限|格式/);
  const duplicate = answer(); duplicate.userConditions = [{ id: "same", quote: "华东" }, { id: "same", quote: "同店" }]; assert.throws(() => api().validateAnalysisAnswer(duplicate), /编号|重复/);
});

test("中途不支持操作保留真实部分事实，但不能用于完成比较", () => {
  const outcome = operation(); outcome.status = "unsupported"; outcome.methods[0].status = "unsupported";
  const registry = api().createEvidenceRegistry(); registry.ingest(outcome);
  assert.equal(registry.bundle().facts[0].value, 200.3);
  invalid(draft(), registry.bundle(), task(), "invalid_comparison");
  const observed = draft(); observed.conclusions[0].level = "observed";
  assert.equal(api().validateAnalysisDraft(task(), observed, registry.bundle()).valid, true);
  const unavailable = { ...outcome, frames: [], facts: [], objects: [], methods: [{ ...outcome.methods[0], frameIds: [], checks: [{ name: "方法适用性", status: "unavailable" as const, result: "缺少所需材料字段" }] }] };
  const other = api().createEvidenceRegistry(); other.ingest(unavailable);
  assert.equal(other.bundle().methods[0].status, "unsupported");
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

test("相同店号出现在不同引用中，不能重复计为两个试点候选", () => {
  const e = evidence(); e.objects.push({ ...e.objects[0], id: "store-a-again", frameId: "frame-reference" });
  const d = draft(); d.trialParameters = [{ id: "duplicates", kind: "store_count", value: 2, objectIds: ["store-a", "store-a-again"], conditions: ["确认营业安排"], status: "proposed" }];
  invalid(d, e, task(), "expression");
});

test("同标签同单位但基础财务定义不同，不能直接跨来源比较", () => {
  const e = evidence(); e.frames[1].mode = "historical"; e.frames[1].snapshotId = "old-snapshot"; e.frames[1].datasetVersion = "old-version";
  e.facts.forEach((f) => { f.metricId = f.metricId.replace("amount", "profit"); });
  e.facts[0].definition = "源字段零售毛利直接汇总"; e.facts[1].definition = "实收减导入成本";
  invalid(draft(), e, task(), "invalid_comparison");
});

test("只引用两个原值也必须核对基础定义，不能绕过派生比较核验", () => {
  const e = evidence(); e.facts.pop(); e.facts[0].definition = "源字段零售毛利"; e.facts[1].definition = "实收减导入成本";
  const d = draft(); d.conclusions[0].factIds = ["fact-current", "fact-reference"]; d.blocks[0].nodes = [{ kind: "fact_ref", factId: "fact-current" }, { kind: "text", text: "与参照" }, { kind: "fact_ref", factId: "fact-reference" }];
  invalid(d, e, task(), "invalid_comparison");
});

test("派生结果不得把金额单位改成百分比或件数", () => {
  for (const unit of ["%", "件"]) { const e = evidence(); e.facts[2].unit = unit; invalid(draft(), e, task(), "invalid_comparison"); }
});

test("表达式按实际单位核对，嵌套量价拆解和单项加总是合法算术", () => {
  const e = evidence(); e.facts.push({ ...fact("quantity-current", "frame-current", 10), metricId: "quantity", unit: "件" }, { ...fact("quantity-reference", "frame-reference", 5), metricId: "quantity", unit: "件" });
  const expr = { op: "multiply" as const, args: [{ factId: "quantity-current" }, { op: "subtract" as const, args: [{ op: "divide" as const, args: [{ factId: "fact-current" }, { factId: "quantity-current" }] }, { op: "divide" as const, args: [{ factId: "fact-reference" }, { factId: "quantity-reference" }] }] }] };
  e.facts[2].derivation = { op: "add", args: [expr] }; e.facts[2].value = 0.1; e.methods[0].method = "decompose";
  assert.equal(api().validateAnalysisDraft(task(), draft(), e).valid, true);
});

test("同框牌价减实收可派生每克差额，件数不能与金额相减", () => {
  const e = evidence(); e.facts[1].frameId = "frame-current"; e.facts[1].metricId = "tag_amount"; e.facts[1].value = 300.3;
  e.facts[2].derivation = { op: "subtract", args: [{ factId: "fact-reference" }, { factId: "fact-current" }] }; e.facts[2].value = 100;
  assert.equal(api().validateAnalysisDraft(task(), draft(), e).valid, true);
  e.facts[1].metricId = "quantity"; e.facts[1].unit = "件"; invalid(draft(), e, task(), "invalid_comparison");
});

test("有条件最终回答必须给出条件的验证方式", () => {
  const a = answer(); a.status = "conditional"; a.review.verdict = "accept_conditional"; a.task.needs[0].status = "conditional";
  assert.throws(() => api().validateAnalysisAnswer(a), /验证|条件/);
});

test("历史未知口径币种粒度可保留阅读事实，但不能伪装成可比证据", () => {
  const e = evidence(); e.frames = [{ ...e.frames[0], mode: "historical", currency: "未核对", grain: "unknown", scope: { ...e.frames[0].scope, population: "unknown" } }];
  e.facts = [e.facts[0]]; e.methods[0].frameIds = ["frame-current"]; e.methods[0].method = "aggregate";
  const d = draft(); d.conclusions[0].level = "observed"; d.conclusions[0].factIds = ["fact-current"]; d.blocks[0].nodes = [{ kind: "text", text: "历史资料仅作为待核对参考：" }, { kind: "fact_ref", factId: "fact-current" }];
  assert.equal(api().validateAnalysisDraft(task(), d, e).valid, true);
  d.conclusions[0].level = "comparison_supported"; e.methods[0].method = "compare";
  invalid(d, e, task(), "invalid_comparison");
  d.conclusions[0].level = "observed"; e.facts.push({ ...e.facts[0], id: "mixed", value: 400.6, derivation: { op: "multiply", args: [{ factId: "fact-current" }, { constant: 2 }] } });
  invalid(d, e, task(), "invalid_comparison");
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
    const total = net.facts.find((fact) => fact.metricId === "amount.decomposed_change"); assert.ok(total);
    const d = draft(); d.conclusions[0].factIds = [total.id]; d.conclusions[0].methodIds = [net.methods[0].id]; d.blocks[0].nodes = [{ kind: "text", text: "净销售变化的算术贡献为" }, { kind: "fact_ref", factId: total.id }];
    const t = task(); t.hardScope.filters = {};
    const checked = api().validateAnalysisDraft(t, d, net);
    assert.equal(checked.valid, true, JSON.stringify(checked.issues));
  } finally { await session.close(); }
});

test("最终证据投影保留引用父链和方法范围，移除无关搜索事实", () => {
  const e = evidence(); const d = draft();
  e.frames.push(frame("frame-extra", "2026-07-08", "2026-07-08"));
  e.facts.push({ ...fact("unrelated", "frame-extra", 5), operationId: "operation-extra" });
  e.methods.push({ ...e.methods[0], id: "method-extra", operationId: "operation-extra", method: "aggregate", frameIds: ["frame-extra"] });
  d.conclusions[0].objectIds = ["store-a"]; d.trialParameters = [{ id: "trial", kind: "store_count", value: 1, objectIds: ["store-b"], conditions: ["确认备货"], status: "proposed" }];
  d.blocks[0].nodes.push({ kind: "trial_parameter_ref", parameterId: "trial" });
  assert.equal(typeof api().selectAnalysisEvidence, "function", "尚未实现最终证据投影");
  const projected = api().selectAnalysisEvidence(d, e);
  assert.deepEqual(projected.facts.map((f) => f.id), ["fact-current", "fact-reference", "fact-delta"]);
  assert.deepEqual(projected.frames.map((f) => f.id), ["frame-current", "frame-reference"]);
  assert.deepEqual(projected.objects.map((o) => o.id), ["store-a", "store-b"]);
  assert.deepEqual(projected.methods.map((m) => m.id), ["method-compare"]);
  assert.equal(api().validateAnalysisDraft(task(), d, projected).valid, true);
  projected.facts[0].value = 999; assert.equal(e.facts[0].value, 200.3);
});

test("未完成回答保留全部已核验证据，不因没有结论丢弃依据", () => {
  const d = draft(); d.status = "incomplete"; d.conclusions = []; d.blocks[0].conclusionId = undefined;
  assert.equal(typeof api().selectAnalysisEvidence, "function", "尚未实现最终证据投影");
  const e = evidence(); const projected = api().selectAnalysisEvidence(d, e);
  assert.deepEqual(projected, e); projected.objects[0].label = "已修改"; assert.equal(e.objects[0].label, "门店1088");
});

test("completed 操作必须有真实方法记录和已执行检查", () => {
  const missing = operation(); missing.methods = []; missing.facts = []; missing.frames = []; missing.objects = [];
  assert.throws(() => api().createEvidenceRegistry().ingest(missing), /方法|检查/);
  const noCheck = operation(); noCheck.methods[0].checks = [];
  assert.throws(() => api().createEvidenceRegistry().ingest(noCheck), /方法|检查/);
});

test("普通文本复制保留历史身份、筛选内订单定义及实际方法限制", () => {
  const a = answer(); a.evidence.frames[0].mode = "historical"; a.evidence.facts[0].definition = "订单只覆盖当前筛选内成交部分";
  a.evidence.methods[0].limitations = ["订单分布没有实际完成"]; a.conclusions = []; a.status = "incomplete";
  a.blocks = [{ kind: "paragraph", nodes: [{ kind: "fact_ref", factId: "fact-current" }] }];
  const copy = api().analysisAnswerText(a); assert.match(copy, /历史资料/); assert.match(copy, /当前筛选内成交部分/); assert.match(copy, /订单分布没有实际完成/);
});

function ratioEvidence(role?: AnalysisFact["comparisonRole"], controls?: AnalysisFact["comparisonControls"]): AnalysisEvidence {
  const e = evidence();
  e.facts.forEach((f) => { f.metricId = f.metricId.replace("amount", "amount_per_gram"); f.unit = "CNY/克"; if (role) f.comparisonRole = role; if (controls) f.comparisonControls = controls;
    if (role === "within_stratum") { f.comparisonKey = "synthetic-ratio-pair"; f.comparisonValues = { category: "模拟金饰", material: "模拟金" }; }
  });
  e.methods[0].controls = ["category", "material"]; e.frames.forEach((f) => { f.controls = ["category", "material"]; });
  return e;
}

test("真实事实级比较角色被保留，不能由方法控制记录升级原始每克比率", () => {
  const e = ratioEvidence("descriptive", []);
  invalid(draft(), e, task(), "invalid_comparison");
  const observed = draft(); observed.conclusions[0].level = "observed";
  assert.equal(api().validateAnalysisDraft(task(), observed, e).valid, true);
  const controlled = ratioEvidence("within_stratum", ["category", "material"]);
  const clean = api().validateAnalysisAnswer({ ...answer(), evidence: controlled });
  assert.equal(clean.evidence.facts[2].comparisonRole, "within_stratum");
  assert.deepEqual(clean.evidence.facts[2].comparisonControls, ["category", "material"]);
});

test("每克比率的未知角色与不完整真实控制条件不能声称受控比较", () => {
  invalid(draft(), ratioEvidence(), task(), "invalid_comparison");
  invalid(draft(), ratioEvidence("within_stratum", ["category"]), task(), "invalid_comparison");
  const bad = ratioEvidence("within_stratum", ["category", "material"]); (bad.facts[2] as unknown as Record<string, unknown>).comparisonRole = "causal_proven";
  invalid(draft(), bad, task(), "missing_evidence");
});

test("标准化结果可使用描述比率作为原料，另引用原始比率为依据则退回", () => {
  const e = ratioEvidence("descriptive", []);
  e.facts.push({ ...e.facts[0], id: "standardized-target", metricId: "amount_per_gram.standardized_target", comparisonRole: "standardized", comparisonControls: ["category", "material"], comparisonKey: "synthetic-standardized-pair", derivation: { factId: "fact-current" } }, { ...e.facts[1], id: "standardized-reference", metricId: "amount_per_gram.standardized_reference", comparisonRole: "standardized", comparisonControls: ["category", "material"], comparisonKey: "synthetic-standardized-pair", derivation: { factId: "fact-reference" } });
  e.facts[2].comparisonRole = "standardized"; e.facts[2].comparisonControls = ["category", "material"]; e.facts[2].comparisonKey = "synthetic-standardized-pair";
  e.facts[2].derivation = { op: "subtract", args: [{ factId: "standardized-target" }, { factId: "standardized-reference" }] };
  assert.equal(api().validateAnalysisDraft(task(), draft(), e).valid, true);
  const d = draft(); d.conclusions[0].factIds.push("fact-current"); invalid(d, e, task(), "invalid_comparison");
});

test("新派生名称不能掩盖父链里的未经控制比率", () => {
  const e = ratioEvidence("descriptive", []); e.facts.push({ ...fact("ratio-wrapper", "frame-current", 100.2), metricId: "arithmetic.delta", unit: "CNY/克", derivation: { factId: "fact-delta" } });
  const d = draft(); d.conclusions[0].factIds = ["ratio-wrapper"]; d.blocks[0].nodes = [{ kind: "fact_ref", factId: "ratio-wrapper" }];
  invalid(d, e, task(), "invalid_comparison");
});

test("coverage 在最终响应保留，未知重复遗漏事项和手写经营数字退回", () => {
  const a = answer(); a.coverage = [{ needId: "need-change", status: "supported", reason: "可比差异已实际计算" }];
  assert.deepEqual(api().validateAnalysisAnswer(a).coverage, [{ needId: "need-change", status: "supported", reason: "可比差异已实际计算" }]);
  const unknown = draft(); unknown.coverage = [{ needId: "unknown-need", status: "supported", reason: "已核对" }]; invalid(unknown, evidence(), task(), "task_coverage");
  const duplicate = draft(); duplicate.coverage = [{ needId: "need-change", status: "supported", reason: "已核对" }, { needId: "need-change", status: "supported", reason: "已核对" }]; invalid(duplicate, evidence(), task(), "task_coverage");
  const missing = draft(); missing.coverage = []; invalid(missing, evidence(), task(), "task_coverage");
  const number = draft(); number.coverage = [{ needId: "need-change", status: "supported", reason: "销售额增长百分之十" }]; invalid(number, evidence(), task(), "expression");
});

test("有条件回答逐项保留 supported 和 conditional，最终任务状态不能偷换", () => {
  const a = answer(); a.status = "conditional"; a.review.verdict = "accept_conditional";
  a.task.needs.push({ id: "need-action", userQuote: "给出建议", judgement: "行动条件与验证", status: "conditional", conclusionIds: ["conclusion-action"] });
  a.conclusions.push({ id: "conclusion-action", needIds: ["need-action"], level: "hypothesis", judgement: "候选活动仍需确认备货", factIds: ["fact-delta"], objectIds: [], methodIds: ["method-compare"], limitations: ["备货尚未确认"], action: "先确认备货条件", validation: "确认补货能力后安排受控试点" });
  a.blocks.push({ kind: "paragraph", conclusionId: "conclusion-action", nodes: [{ kind: "text", text: "候选活动先确认备货，再通过受控试点核对。" }] });
  a.coverage = [{ needId: "need-change", status: "supported", reason: "可比差异已实际计算" }, { needId: "need-action", status: "conditional", reason: "备货尚需业务确认" }];
  const clean = api().validateAnalysisAnswer(a); assert.equal(clean.coverage?.[0].status, "supported"); assert.equal(clean.coverage?.[1].status, "conditional");
  a.task.needs[0].status = "conditional"; assert.throws(() => api().validateAnalysisAnswer(a), /状态|coverage|覆盖/);
});

test("未完成事项 coverage open 可以保留事实，但不能被整体接受状态掩盖", () => {
  const a = answer(); a.coverage = [{ needId: "need-change", status: "open", reason: "仍需实际完成结构核对" }];
  assert.throws(() => api().validateAnalysisAnswer(a), /事项|状态|覆盖/);
  a.status = "incomplete"; a.task.needs[0].status = "open"; a.review = { verdict: "revise", issues: [{ kind: "task_coverage", needIds: ["need-change"], conclusionIds: ["conclusion-change"], requirement: "继续完成结构核对" }] };
  assert.equal(api().validateAnalysisAnswer(a).coverage?.[0].status, "open");
});

async function realRatioComparison() {
  const { analysisMetricDefinitions, createAnalysisOperations } = await import("../app/lib/analytics/analysis-v2-operations.ts");
  const cells = (target: boolean) => [
    { dimensions: { store: "模拟店", category: "贵类", material: "材料甲" }, rows: 1, amount: target ? 9000 : 1100, grams: target ? 90 : 10, quantity: 1, orders: 1, stores: 1, profit: null, tag_amount: null },
    { dimensions: { store: "模拟店", category: "低类", material: "材料乙" }, rows: 1, amount: target ? 100 : 990, grams: target ? 10 : 90, quantity: 1, orders: 1, stores: 1, profit: null, tag_amount: null },
  ];
  const session: AnalysisDataSession = { snapshotId: "synthetic-pairs", datasetVersion: "synthetic-pairs-version", capabilities: { mode: "snapshot", name: "模拟实际配对", coverage: { start: "2026-08-01", end: "2026-09-01" }, currency: "CNY", provenance: "sample", dimensions: ["store", "category", "material"], metrics: analysisMetricDefinitions("CNY", ["amount", "grams", "amount_per_gram"], "snapshot"), methods: ["compare"], limitations: [] }, aggregate: async (query) => cells(query.scope.period.start === "2026-09-01"), close: async () => {} };
  return createAnalysisOperations(session, { filters: {} }).execute({ needIds: ["need-change"], purpose: "核对同层实际配对", method: "compare", scope: { period: { start: "2026-09-01", end: "2026-09-01" }, population: "sales", filters: {} }, reference: { period: { start: "2026-08-01", end: "2026-08-01" }, population: "sales", filters: {} }, metrics: ["amount_per_gram"], by: ["category", "material"], controls: ["category", "material"] });
}
function ratioTask(): AnalysisTask {
  return { ...task(), question: "核对分层每克实收差异", context: [], hardScope: { period: { start: "2026-08-01", end: "2026-09-01" }, filters: {} }, needs: [{ ...task().needs[0], userQuote: "核对分层每克实收差异", judgement: "同层与标准化每克实收差异" }] };
}
function comparisonDraft(result: AnalysisOperationResult, factIds: string[]): AnalysisDraft {
  const d = draft(); d.conclusions[0].factIds = factIds; d.conclusions[0].methodIds = result.methods.map((method) => method.id);
  d.conclusions[0].objectIds = [...new Set(result.facts.filter((fact) => factIds.includes(fact.id)).flatMap((fact) => fact.objectIds))];
  d.blocks[0].nodes = factIds.map((factId) => ({ kind: "fact_ref" as const, factId })); return d;
}

test("不同真实控制值的两个 within_stratum 原值不能混配为比较", async () => {
  const result = await realRatioComparison();
  const targetHigh = result.facts.find((f) => f.metricId === "amount_per_gram" && f.value === 100); const referenceLow = result.facts.find((f) => f.metricId === "amount_per_gram" && f.value === 11);
  assert.ok(targetHigh && referenceLow); assert.equal(targetHigh.comparisonRole, "within_stratum"); assert.equal(referenceLow.comparisonRole, "within_stratum");
  invalid(comparisonDraft(result, [targetHigh.id, referenceLow.id]), result, ratioTask(), "invalid_comparison");
  const observed = comparisonDraft(result, [targetHigh.id, referenceLow.id]); observed.conclusions[0].level = "observed";
  assert.equal(api().validateAnalysisDraft(ratioTask(), observed, result).valid, true);
});

test("一次代码配对共享身份和实际值，多个正确分层比较可共同支持结论", async () => {
  const result = await realRatioComparison();
  const targetHigh = result.facts.find((f) => f.metricId === "amount_per_gram" && f.value === 100); const referenceHigh = result.facts.find((f) => f.metricId === "amount_per_gram" && f.value === 110);
  const deltas = result.facts.filter((f) => f.metricId === "amount_per_gram.delta" && f.comparisonRole === "within_stratum"); assert.equal(deltas.length, 2); assert.ok(targetHigh && referenceHigh);
  assert.ok(targetHigh.comparisonKey); assert.equal(targetHigh.comparisonKey, referenceHigh.comparisonKey);
  assert.deepEqual(targetHigh.comparisonValues, { category: "贵类", material: "材料甲" }); assert.deepEqual(referenceHigh.comparisonValues, targetHigh.comparisonValues);
  assert.equal(new Set(deltas.map((f) => f.comparisonKey)).size, 2); assert.ok(deltas.every((f) => f.value! < 0));
  assert.equal(api().validateAnalysisDraft(ratioTask(), comparisonDraft(result, deltas.map((f) => f.id)), result).valid, true);
  const standardized = result.facts.find((f) => f.metricId === "amount_per_gram.standardized_delta"); assert.ok(standardized);
  assert.ok(standardized.comparisonKey); assert.notEqual(standardized.comparisonKey, targetHigh.comparisonKey);
  assert.equal(api().validateAnalysisDraft(ratioTask(), comparisonDraft(result, [standardized.id]), result).valid, true);
});

test("配对比率篡改实际控制值或配对身份，数学正确仍须退回", async () => {
  const result = structuredClone(await realRatioComparison()); const delta = result.facts.find((f) => f.metricId === "amount_per_gram.delta" && f.comparisonRole === "within_stratum"); assert.ok(delta && delta.derivation && "op" in delta.derivation && "factId" in delta.derivation.args[1]);
  const baselineId = delta.derivation.args[1].factId; const baseline = result.facts.find((f) => f.id === baselineId); assert.ok(baseline);
  const d = comparisonDraft(result, [delta.id]); baseline.comparisonValues = { category: "错误分层", material: "材料乙" };
  invalid(d, result, ratioTask(), "invalid_comparison");
  const clean = structuredClone(await realRatioComparison()); const related = clean.facts.find((f) => f.metricId === "amount_per_gram.delta" && f.comparisonRole === "within_stratum"); assert.ok(related);
  related.comparisonKey = "made-up-pair"; invalid(comparisonDraft(clean, [related.id]), clean, ratioTask(), "invalid_comparison");
});

test("对象后接通用指标构词合法，数字编号作店数或金额仍拒绝", () => {
  for (const text of ["件数从", "件数减半与退货同现的原因", "克重为", "单量从", "人数变化", "订单均额为", "门店数变化"]) {
    const d = draft(); d.conclusions[0].objectIds = ["store-a"]; d.blocks[0].nodes = [{ kind: "object_ref", objectId: "store-a" }, { kind: "text", text }, { kind: "fact_ref", factId: "fact-delta" }];
    assert.equal(api().validateAnalysisDraft(task(), d, evidence()).valid, true, text);
  }
  for (const text of ["家门店试点", "元收入", "件商品", "克黄金", "单成交", "人参与"]) {
    const d = draft(); d.conclusions[0].objectIds = ["store-a"]; d.blocks[0].nodes = [{ kind: "text", text: "建议选择" }, { kind: "object_ref", objectId: "store-a" }, { kind: "text", text }]; invalid(d, evidence(), task(), "expression");
  }
});
