import assert from "node:assert/strict";
import test from "node:test";
import { parseBodyMarkdown, type BodyInline } from "../app/lib/analytics/plan/body-markdown.ts";

// 按原文找出数字的区间，模拟 resolveBody 给的 refs。
function refsOf(text: string, ...numbers: string[]) {
  let from = 0;
  return numbers.map((value, index) => { const start = text.indexOf(value, from); assert.ok(start >= 0, value); from = start + value.length; return { start, end: start + value.length, factIds: [`f${index}`] }; });
}
const flat = (nodes: BodyInline[]) => nodes.map((node) => node.parts.map((part) => part.kind === "ref" ? `[${part.text}|${part.factIds.join(",")}]` : part.text).join("")).join("");
const bolds = (nodes: BodyInline[]) => nodes.filter((node) => node.bold).map((node) => node.parts.map((part) => part.kind === "ref" ? `[${part.text}]` : part.text).join(""));

test("段落里一行多个数字，各自对应自己的事实", () => {
  const text = "8月有成交的活动共442个，比7月多31个，增长7.5%。";
  const [block] = parseBodyMarkdown(text, refsOf(text, "442个", "31个", "7.5%"));
  assert.equal(block.kind, "para");
  assert.equal(flat(block.inline), "8月有成交的活动共[442个|f0]，比7月多[31个|f1]，增长[7.5%|f2]。");
});

test("数字在加粗里：加粗保留，数字仍是按钮", () => {
  const text = "活动共 **442个**，其中**新开 31个**。";
  const [block] = parseBodyMarkdown(text, refsOf(text, "442个", "31个"));
  assert.ok(block.kind === "para");
  assert.deepEqual(bolds(block.inline), ["[442个]", "新开 [31个]"]);
  assert.equal(flat(block.inline), "活动共 [442个|f0]，其中新开 [31个|f1]。");
});

test("区间跨过加粗标记时以 refs 为准，按钮里不带星号，也不产生半截加粗", () => {
  const text = "活动共 **442个**，较上月持平。";
  const start = text.indexOf("**442"); const end = text.indexOf("，");
  const [block] = parseBodyMarkdown(text, [{ start, end, factIds: ["f0"] }]);
  assert.ok(block.kind === "para");
  assert.equal(flat(block.inline), "活动共 [442个|f0]，较上月持平。");
  assert.doesNotMatch(flat(block.inline), /\*/);
});

test("数字在列表项和有序列表里", () => {
  const text = "- 甲店 120万元\n- 乙店 **80万元**，丙店 60万元\n\n1. 合计 260万元";
  const blocks = parseBodyMarkdown(text, refsOf(text, "120万元", "80万元", "60万元", "260万元"));
  assert.equal(blocks.length, 2);
  const [bullets, ordered] = blocks;
  assert.ok(bullets.kind === "list" && !bullets.ordered && ordered.kind === "list" && ordered.ordered);
  assert.deepEqual(bullets.items.map(flat), ["甲店 [120万元|f0]", "乙店 [80万元|f1]，丙店 [60万元|f2]"]);
  assert.deepEqual(ordered.items.map(flat), ["合计 [260万元|f3]"]);
});

test("数字在标题里", () => {
  const text = "### 8月共442个活动\n正文说明 31个。";
  const blocks = parseBodyMarkdown(text, refsOf(text, "442个", "31个"));
  assert.ok(blocks[0].kind === "heading" && blocks[0].level === 3);
  assert.equal(flat(blocks[0].inline), "8月共[442个|f0]活动");
  assert.ok(blocks[1].kind === "para"); assert.equal(flat(blocks[1].inline), "正文说明 [31个|f1]。");
});

test("没有引用的正文和普通 Markdown 一样；HTML 原样当文字", () => {
  const text = "<script>alert(1)</script> **重点**";
  const [block] = parseBodyMarkdown(text, []);
  assert.ok(block.kind === "para");
  assert.equal(flat(block.inline), "<script>alert(1)</script> 重点"); assert.deepEqual(bolds(block.inline), ["重点"]);
});

test("正文里本来就有的私用区字符被清掉，不会冒充数字；越界、重叠的引用跳过", () => {
  const text = "共 442个";
  const [block] = parseBodyMarkdown(text, [{ start: 3, end: 7, factIds: ["f0"] }, { start: 4, end: 6, factIds: ["dup"] }, { start: 5, end: 99, factIds: ["bad"] }]);
  assert.ok(block.kind === "para"); assert.equal(flat(block.inline), "共 [442个|f0]");
});
