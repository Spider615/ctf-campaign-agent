import assert from "node:assert/strict";
import test from "node:test";
import * as formatting from "../app/lib/analytics/analysis-v2-format.ts";
import type { AnalysisAnswerNode } from "../app/lib/analytics/analysis-v2-types.ts";
import { simulatedAnswer } from "./helpers/analysis-v2-answer.ts";

function sample(unit: string, value: number | null, text: string) {
  const answer = simulatedAnswer(); answer.evidence.facts[0].unit = unit; answer.evidence.facts[0].value = value;
  answer.blocks = [{ kind: "paragraph", nodes: [{ kind: "fact_ref", factId: "amount" }, { kind: "text", text }] }];
  return answer;
}

test("邻接事实单位在复制正文中只呈现一次，保留现有精度", () => {
  for (const [unit, value, text, expected] of [
    ["家", 2, "家，合计", "2家，合计"], ["单", 19, "单、", "19单、"], ["件", 37, "件；", "37件；"],
    ["克", 0.123456789, "克。", "0.123457克。"], ["CNY", 4321.98, "元，", "4,321.98元，"],
    ["CNY/单", 17.123456, "元。", "17.12元/单。"], ["人民币/日", 17.123456, "元/日，", "17.12元/日，"],
    ["CNY/克", 17.123456789, "元/克；", "17.123457元/克；"], ["%", 1.23456, "%，", "1.23%，"],
    ["百分点", 1.23456, "个百分点。", "1.23个百分点。"], ["单", 0, "单。", "0单。"], ["CNY", -0, "元。", "0.00元。"],
  ] as const) {
    const answer = sample(unit, value, text); const original = structuredClone(answer);
    assert.equal(formatting.analysisAnswerText(answer).split("\n\n")[0], expected, `${unit} 邻接单位重复`);
    assert.deepEqual(answer, original, "展示不能更改草稿、事实值或来源");
  }
});

test("数值关系连接词前可去重，合法词与未知相邻文字保留", () => {
  for (const text of ["元降到", "元变化很小", "元增加", "元以上", "元左右"]) {
    const answer = sample("CNY", 25, text);
    assert.equal(formatting.analysisAnswerText(answer).split("\n\n")[0], `25.00元${text.slice(1)}`);
  }
  for (const [unit, text] of [["单", "单笔金额"], ["克", "克重结构"], ["元", "元旦活动"], ["元", "元数据"], ["家", "家家户户"], ["克", "克服困难"], ["元", "元未知词"], ["USD", "元，"], ["元", "元/单，"]] as const) {
    const answer = sample(unit, 25, text); const node = answer.blocks[0].nodes[0];
    assert.equal(formatting.analysisAnswerText(answer).split("\n\n")[0], formatting.formatAnalysisNode(node, answer) + text, `${text} 不能误删`);
  }
  const missing = sample("元", null, "元，暂缺");
  assert.equal(formatting.analysisAnswerText(missing).split("\n\n")[0], "暂无可计算值元，暂缺");
});

test("共享节点格式保持同索引，跨空文字接续但不跨对象或段落", () => {
  const format = (formatting as typeof formatting & { formatAnalysisNodes?: (nodes: readonly AnalysisAnswerNode[], answer: ReturnType<typeof sample>) => string[] }).formatAnalysisNodes;
  assert.equal(typeof format, "function", "缺少 UI 与复制共用的节点格式接口");
  const answer = sample("CNY/单", 17.125, "");
  const nodes: AnalysisAnswerNode[] = [{ kind: "fact_ref", factId: "amount" }, { kind: "text", text: "" }, { kind: "text", text: "元" }, { kind: "text", text: "/" }, { kind: "text", text: "单" }, { kind: "text", text: "，继续核对。" }];
  const original = structuredClone(nodes);
  assert.deepEqual(format!(nodes, answer), ["17.13元/单", "", "", "", "", "，继续核对。"]);
  assert.deepEqual(nodes, original);
  assert.deepEqual(format!([{ kind: "fact_ref", factId: "amount" }, { kind: "text", text: "" }, { kind: "text", text: " " }, { kind: "text", text: "元。" }], answer), ["17.13元/单", "", " ", "。"]);
  answer.evidence.facts[0].unit = "元";
  assert.deepEqual(format!([{ kind: "fact_ref", factId: "amount" }, { kind: "text", text: "" }, { kind: "object_ref", objectId: "store" }, { kind: "text", text: "元，" }], answer), ["17.13元", "", "模拟甲店", "元，"]);
  const dividedWord: AnalysisAnswerNode[] = [{ kind: "fact_ref", factId: "amount" }, { kind: "text", text: "元" }, { kind: "text", text: "旦活动" }];
  assert.deepEqual(format!(dividedWord, answer), ["17.13元", "元", "旦活动"]);
  answer.blocks = [{ kind: "paragraph", nodes: [{ kind: "fact_ref", factId: "amount" }] }, { kind: "paragraph", nodes: [{ kind: "text", text: "元，" }] }];
  assert.ok(formatting.analysisAnswerText(answer).startsWith("17.13元\n\n元，"));
});
