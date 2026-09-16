import assert from "node:assert/strict";
import test from "node:test";

import { parseChatMarkdown, plainText } from "../app/lib/markdown.ts";

test("parses the bold-and-bullets shape the model actually produces", () => {
  // 取自实测回复：模型放开后会用 **小标题** 和分点组织长回答。
  const blocks = parseChatMarkdown("先说设计，我建议抓三个点：\n\n**签到怎么签到**：最好别搞纯线上打卡。\n\n1. **工费做文章**：改成克减15加工费6折\n2. **以旧换新**：五一换金需求大");

  assert.equal(blocks[0].kind, "para");
  assert.deepEqual(blocks[0].inline, [{ kind: "text", text: "先说设计，我建议抓三个点：" }]);

  assert.equal(blocks[1].kind, "para");
  assert.deepEqual(blocks[1].inline, [
    { kind: "bold", text: "签到怎么签到" },
    { kind: "text", text: "：最好别搞纯线上打卡。" },
  ]);

  const list = blocks[2];
  assert.equal(list.kind, "list");
  assert.equal(list.kind === "list" && list.ordered, true);
  assert.equal(list.kind === "list" && list.items.length, 2);
  assert.deepEqual(list.kind === "list" ? list.items[0] : null, [
    { kind: "bold", text: "工费做文章" },
    { kind: "text", text: "：改成克减15加工费6折" },
  ]);
});

test("unordered bullets group into one list", () => {
  const blocks = parseChatMarkdown("可以考虑：\n- 工费全免\n- 以旧换新\n- 跨类组合");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].kind, "list");
  assert.equal(blocks[1].kind === "list" && blocks[1].ordered, false);
  assert.equal(blocks[1].kind === "list" && blocks[1].items.length, 3);
});

test("an unclosed bold marker stays literal", () => {
  // 回复有 800 字截断，模型的话被从中间切开时会留下半个 **。
  // 贪婪匹配会把后面的正文整段吃掉，那比不渲染更糟。
  const blocks = parseChatMarkdown("这个力度我说句实在话：**克减15");
  assert.equal(blocks[0].kind, "para");
  assert.deepEqual(blocks[0].inline, [{ kind: "text", text: "这个力度我说句实在话：**克减15" }]);
});

test("a lone asterisk is not a marker", () => {
  const blocks = parseChatMarkdown("满5000减500 * 不与其他优惠同享");
  // 先断言 kind 才能把联合类型收窄到 para 分支，否则 .inline 在 list 分支上不存在。
  assert.equal(blocks[0].kind, "para");
  assert.deepEqual(blocks[0].inline, [{ kind: "text", text: "满5000减500 * 不与其他优惠同享" }]);
});

test("plainText strips the markers but keeps the structure readable", () => {
  // 复制到微信或 OA、以及要对外发的宣传文案，都不该带 ** 这类标记。
  assert.equal(plainText("**限时五天**"), "限时五天");
  assert.equal(plainText("这单**已经齐了**，就差确认。"), "这单已经齐了，就差确认。");
  // 结构不能直接丢掉：列表还原成看得懂的符号，否则复制出去会糊成一段。
  assert.equal(plainText("先说方向：\n- 满减\n- 以旧换新"), "先说方向：\n· 满减\n· 以旧换新");
  assert.equal(plainText("步骤：\n1. 先建单\n2. 再审批"), "步骤：\n1. 先建单\n2. 再审批");
});

test("plain text without markers is a single paragraph", () => {
  const blocks = parseChatMarkdown("记下了：10月1日到10月7日，闽深区7590门店。");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "para");
});
