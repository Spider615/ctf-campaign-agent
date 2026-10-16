import { appendFileSync, createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { setImmediate as yieldAuditWork } from "node:timers/promises";
import type { AnalysisOperationResult } from "../app/lib/analytics/analysis-v2-types.ts";
import { throwIfTurnCancelled } from "../app/lib/cancellation.ts";

type OperationAudit = { at: string; runId: string; kind: string; value: { input: unknown; outcome: AnalysisOperationResult } };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

// 按原顺序逐项散列真实值与对象描述，不构造百万事实的第二份数组或超长字符串。
export async function analysisOperationContentHash(outcome: AnalysisOperationResult, signal?: AbortSignal): Promise<string> {
  throwIfTurnCancelled(signal);
  const hash = createHash("sha256"); const objects = new Map(outcome.objects.map((object) => [object.id, object]));
  let count = 0;
  for (const fact of outcome.facts) {
    // 固定属性按规范顺序构造，避免为每条记录再排序和复制对象。
    hash.update(JSON.stringify({ metric: fact.metricId, objects: fact.objectIds.map((id) => objects.get(id)).map((object) => object ? { dimension: object.dimension, value: object.value } : null), unit: fact.unit, value: fact.value }) + "\n");
    if (++count % 2048 === 0) { await yieldAuditWork(); throwIfTurnCancelled(signal); }
  }
  hash.update("methods\n");
  for (const method of outcome.methods) { hash.update(canonical({ method: method.method, status: method.status }) + "\n"); for (const check of method.checks) { hash.update(canonical(check) + "\n"); if (++count % 2048 === 0) { await yieldAuditWork(); throwIfTurnCancelled(signal); } } hash.update("end-method\n"); }
  throwIfTurnCancelled(signal);
  return hash.digest("hex");
}

// 大证据逐条保存为压缩JSONL，保留全部帧、对象、事实和检查；目录只保存完整文件引用。
export async function appendAnalysisOperationAudit(path: string, record: OperationAudit, signal?: AbortSignal, inlineFactLimit = 20000): Promise<void> {
  throwIfTurnCancelled(signal);
  const outcome = record.value.outcome;
  if (outcome.facts.length <= inlineFactLimit) { appendFileSync(path, JSON.stringify(record) + "\n", { mode: 0o600 }); return; }
  const file = `${basename(path, ".jsonl")}.${randomUUID()}.evidence.jsonl.gz`; const proofPath = join(dirname(path), file);
  const counts = { frameCount: outcome.frames.length, factCount: outcome.facts.length, objectCount: outcome.objects.length, methodCount: outcome.methods.length, checkCount: outcome.methods.reduce((total, method) => total + method.checks.length, 0) };
  const destination = createWriteStream(proofPath, { flags: "wx", mode: 0o600 }); let opened = false;
  destination.once("open", () => { opened = true; });
  function* entries(): Generator<unknown> {
    const meta = Object.fromEntries(Object.entries(outcome).filter(([key]) => !["frames", "facts", "objects", "methods"].includes(key)));
    yield { schema: "analysis-operation-evidence/v1", at: record.at, runId: record.runId, input: record.value.input, outcome: meta, ...counts };
    for (const value of outcome.frames) yield { kind: "frame", value };
    for (const value of outcome.objects) yield { kind: "object", value };
    for (const method of outcome.methods) {
      yield { kind: "method", value: Object.fromEntries(Object.entries(method).filter(([key]) => key !== "checks")) };
      for (const [index, value] of method.checks.entries()) yield { kind: "method-check", methodId: method.id, index, value };
    }
    for (const value of outcome.facts) yield { kind: "fact", value };
    yield { kind: "complete", ...counts };
  }
  async function* chunks() {
    let pieces: string[] = []; let length = 0;
    for (const entry of entries()) {
      throwIfTurnCancelled(signal); const piece = JSON.stringify(entry) + "\n"; pieces.push(piece); length += piece.length;
      if (length >= 1024 * 1024) { yield pieces.join(""); pieces = []; length = 0; }
    }
    if (pieces.length) yield pieces.join("");
  }
  try {
    await pipeline(Readable.from(chunks(), { objectMode: false }), createGzip({ level: 1 }), destination, { signal });
    throwIfTurnCancelled(signal);
    appendFileSync(path, JSON.stringify({ at: record.at, runId: record.runId, kind: record.kind, value: { input: record.value.input, outcomeReference: { schema: "analysis-operation-evidence/v1", file, operationId: outcome.operationId, method: outcome.method, status: outcome.status, ...counts } } }) + "\n", { mode: 0o600 });
  } catch (error) { if (opened) await unlink(proofPath).catch(() => {}); throw error; }
}
