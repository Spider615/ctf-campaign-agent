import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { appendAnalysisOperationAudit, analysisOperationContentHash } from "../agent/analytics-audit.ts";
import type { AnalysisOperationResult } from "../app/lib/analytics/analysis-v2-types.ts";

const outcome: AnalysisOperationResult = { operationId: "op", method: "aggregate", status: "completed", needIds: ["need"], purpose: "完整保存", frames: [], objects: [{ id: "object", frameId: "frame", dimension: "store", value: "shop", label: "门店" }], facts: Array.from({ length: 5 }, (_, index) => ({ id: `fact-${index}`, operationId: "op", frameId: "frame", metricId: "amount", label: '中文引用"与\n换行', value: index === 0 ? null : index === 1 ? 0 : index, unit: "CNY", definition: "真实定义", objectIds: ["object"], limitations: [] })), methods: [{ id: "method", operationId: "op", method: "aggregate", status: "completed", frameIds: [], controls: [], sampleRows: 5, groupCount: 1, limitations: [], checks: [{ name: "实际执行", status: "performed", result: "完整范围" }, { name: "未取得", status: "unavailable", result: "不补零" }] }], limitations: [] };
function setup(t: { after(fn: () => void): void }) { const root = mkdtempSync(join(tmpdir(), "ctf-audit-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test("大操作证据分块无损保存，私有目录记录引用及全部数量，缺失和零保持不同", async (t) => {
  const root = setup(t); const path = join(root, "run.jsonl"); const record = { at: "now", runId: "run", kind: "operation", value: { input: { purpose: "查真实范围" }, outcome } };
  await appendAnalysisOperationAudit(path, record, undefined, 2);
  const saved = JSON.parse(readFileSync(path, "utf8")); assert.deepEqual(saved.value.input, record.value.input);
  assert.equal(saved.value.outcomeReference.factCount, outcome.facts.length);
  const proofPath = join(root, saved.value.outcomeReference.file); assert.equal(statSync(proofPath).mode & 0o777, 0o600);
  const parts = gunzipSync(readFileSync(proofPath)).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(parts.filter((part) => part.kind === "fact").map((part) => part.value), outcome.facts);
  assert.deepEqual(parts.filter((part) => part.kind === "object").map((part) => part.value), outcome.objects);
  assert.deepEqual(parts.filter((part) => part.kind === "method-check").map((part) => part.value), outcome.methods[0].checks);
  assert.equal(parts.at(-1).kind, "complete"); assert.equal(parts.at(-1).factCount, 5);
  assert.equal(parts[0].outcome.operationId, "op");
});

test("小操作保留原内联格式，取消不能留下完成引用或半份证据", async (t) => {
  const root = setup(t); const path = join(root, "run.jsonl"); const record = { at: "now", runId: "run", kind: "operation", value: { input: {}, outcome } };
  await appendAnalysisOperationAudit(path, record); assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), record);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(appendAnalysisOperationAudit(join(root, "cancel.jsonl"), record, controller.signal, 2), /停止/);
  assert.deepEqual(readdirSync(root), ["run.jsonl"]);
});

test("操作指纹按真实值和对象增量生成，重编号相同，零与缺失及实际检查变化不同", async () => {
  const original = await analysisOperationContentHash(outcome); const renamed = structuredClone(outcome);
  renamed.operationId = "new-op"; renamed.objects[0].id = "new-object"; renamed.facts.forEach((fact, index) => { fact.id = `new-${index}`; fact.operationId = "new-op"; fact.objectIds = ["new-object"]; }); renamed.methods[0].id = "new-method"; renamed.methods[0].operationId = "new-op";
  assert.equal(await analysisOperationContentHash(renamed), original);
  renamed.facts[0].value = 0; assert.notEqual(await analysisOperationContentHash(renamed), original);
  renamed.facts[0].value = null; renamed.objects[0].value = "changed-shop"; assert.notEqual(await analysisOperationContentHash(renamed), original);
  renamed.objects[0].value = "shop"; renamed.methods[0].checks[0].status = "unavailable"; assert.notEqual(await analysisOperationContentHash(renamed), original);
});

test("大证据写入及指纹遍历中可取消，不记录完成指针或留下半份文件", async (t) => {
  const root = setup(t); const large = { ...outcome, facts: Array.from({ length: 10000 }, (_, index) => ({ ...outcome.facts[1], id: `big-${index}`, label: "中文标签".repeat(1000) })) };
  const controller = new AbortController(); const saving = appendAnalysisOperationAudit(join(root, "cancel.jsonl"), { at: "now", runId: "cancel", kind: "operation", value: { input: {}, outcome: large } }, controller.signal, 2);
  setImmediate(() => controller.abort()); await assert.rejects(saving); assert.deepEqual(readdirSync(root), []);
  const hashing = new AbortController(); const pending = analysisOperationContentHash(large, hashing.signal); setImmediate(() => hashing.abort()); await assert.rejects(pending, /停止/);
});
