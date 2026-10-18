import assert from "node:assert/strict";
import test from "node:test";
import { createVisualizationRegistry } from "../agent/visualization-runtime.ts";
import type { AttachmentCalculation, VisualizationFileSource, VisualizationProgressEvent } from "../app/lib/analytics/visualization-types.ts";

// 附件问答的图表夹具：一次按门店求和的完整计算，加上每个分组对应的来源摘录。
function evidence() {
  const calculation: AttachmentCalculation = {
    id: "calculation", attachmentId: "file", version: "version", tableId: "table", name: "销售表", location: "工作表1",
    operation: "sum", column: "金额（元）", groupBy: ["门店"], unit: "元", filters: [], groupCount: 2,
    groups: [{ labels: ["甲店"], value: "300", sourceId: "s0", matchedRows: 1, missingRows: 0 }, { labels: ["乙店"], value: "700", sourceId: "s1", matchedRows: 1, missingRows: 0 }],
    warnings: [],
  };
  const sources: VisualizationFileSource[] = calculation.groups.map((group) => ({ id: group.sourceId, attachmentId: "file", version: "version", name: "销售表", location: "工作表1", excerpt: `求和：${group.value}` }));
  return { calculations: [calculation], sources };
}

const request = { kind: "bar" as const, renderer: "native" as const, source: { kind: "attachment" as const, calculationIds: ["calculation"] }, selection: { mode: "all" as const } };

test("附件图表引用：编造和已撤回的图表编号不能放进最终回答，范围重开会撤回已有图表", () => {
  const events: VisualizationProgressEvent[] = [];
  const registry = createVisualizationRegistry({ runId: "run", enabled: true, emit: (event) => events.push(event), attachmentEvidence: evidence });
  const created = registry.present(request);
  assert.equal(events.length, 1); assert.deepEqual(created.chart.series[0].values.map((v) => v.value).sort(), [300, 700]);
  const repeated = registry.present(request); assert.equal(repeated.visualizationId, created.visualizationId); assert.equal(events.length, 1);
  assert.equal(registry.place([{ id: created.visualizationId, afterBlockIndex: 1 }])!.items[0].source.kind, "attachment");
  assert.throws(() => registry.place([{ id: "invented", afterBlockIndex: 0 }]), /引用|不存在/);
  registry.reset("scope_changed");
  assert.equal(events.length, 2);
  const retract = events[1]; assert.equal(retract.action, "retract");
  if (retract.action === "retract") { assert.deepEqual(retract.ids, [created.visualizationId]); assert.equal(retract.reason, "scope_changed"); assert.equal(retract.epoch, 1); }
  assert.throws(() => registry.place([{ id: created.visualizationId, afterBlockIndex: 1 }]), /引用|不存在/);
});

test("附件图表修订后旧签名不会把新图悄悄改回去", () => {
  const registry = createVisualizationRegistry({ runId: "run", enabled: true, attachmentEvidence: evidence });
  const original = registry.present(request);
  const changed = registry.present({ ...request, id: original.visualizationId, selection: { mode: "top", limit: 1 } });
  assert.equal(changed.visualizationId, original.visualizationId); assert.equal(changed.revision, 2);
  const again = registry.present(request);
  assert.notEqual(again.visualizationId, changed.visualizationId);
  assert.equal(registry.place([{ id: changed.visualizationId, afterBlockIndex: 0 }])!.items[0].revision, 2);
  assert.deepEqual(registry.place([{ id: changed.visualizationId, afterBlockIndex: 0 }])!.items[0].selection, { mode: "top", limit: 1 });
});
