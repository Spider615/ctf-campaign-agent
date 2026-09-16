import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage } from "../app/lib/campaign/ics1811/messages.ts";
import { highlightedFields, recentlyFilled } from "../app/lib/campaign/ics1811/recent-fill.ts";

const msg = (content: ChatMessage["content"], id = "m"): ChatMessage => ({ id, role: "assistant", createdAt: "2026-09-16T00:00:00.000Z", content });

const change = (versionSeq: number, items: Array<[string, string, string]>, id: string) =>
  msg({ v: 2, kind: "agent_change", title: "记下了", items: items.map(([label, before, after]) => ({ label, before, after })), versionSeq }, id);

test("the panel can tell which fields this turn just filled", () => {
  const messages = [
    change(2, [["活动日期", "未填", "2026-10-01 至 2026-10-07"], ["货类", "未填", "钻石类"]], "a"),
    change(3, [["优惠", "未填", "满减：满 2000 减 200"]], "b"),
    change(4, [["门店", "未填", "7590"]], "c"),
  ];
  // 只认最新版本那一轮改的，不把历史累加进来。
  assert.deepEqual(recentlyFilled(messages, 4), ["stores"]);
  assert.deepEqual(recentlyFilled(messages, 3), ["offer"]);
  assert.deepEqual(recentlyFilled(messages, 2).sort(), ["categories", "dates"]);
});

test("a version with no change message highlights nothing", () => {
  const messages = [change(2, [["门店", "未填", "7590"]], "a")];
  assert.deepEqual(recentlyFilled(messages, 5), [], "确认、撤销这类不产生改动的回合不该乱标高亮");
  assert.deepEqual(recentlyFilled([], 1), []);
});

test("a changed fact lights up every page field it feeds", () => {
  // 对照 derive.ts 里真实存在的关系，不是现编：日期填两栏，门店换算出区域再填分行。
  assert.deepEqual([...highlightedFields(["dates"])].sort(), ["endDate", "startDate"]);
  assert.deepEqual([...highlightedFields(["stores"])].sort(), ["branches", "region"]);
  assert.deepEqual([...highlightedFields(["commission"])], ["commission"]);
  assert.deepEqual([...highlightedFields(["online"])], ["channel"]);
  assert.deepEqual([...highlightedFields(["weekdays"])], ["cycle"]);
  // 品牌决定审批流，两栏一起亮。
  assert.deepEqual([...highlightedFields(["brands"])].sort(), ["approvalFlow", "brand"]);
  // 付款方式的增减都落在同一栏。
  assert.deepEqual([...highlightedFields(["paymentAdd", "paymentRemove"])], ["paymentMethods"]);
});

test("facts that only drive the detail rows light up nothing in the activity info", () => {
  // 让扣点、回款率只出现在明细里；这一版高亮只覆盖活动信息，不假装标到了明细。
  assert.deepEqual([...highlightedFields(["rates"])], []);
  assert.deepEqual([...highlightedFields([])], []);
});

test("detail rows carry the fact that drives them, so 刚填 can reach them too", async () => {
  const { EXAMPLES } = await import("../app/lib/campaign/ics1811/examples.ts");
  const { applyFactWrites, createEmptyDraft } = await import("../app/lib/campaign/ics1811/facts.ts");
  const { deriveFill } = await import("../app/lib/campaign/ics1811/derive.ts");
  const { checkDraft } = await import("../app/lib/campaign/ics1811/checks.ts");
  const { renderFillSheet } = await import("../app/lib/campaign/ics1811/fill-sheet.ts");

  const example = EXAMPLES[0];
  const draft = applyFactWrites(createEmptyDraft("d", example.first), example.firstWrites, { text: example.first, today: "2026-09-16" }).draft;
  const fill = deriveFill(draft);
  const sheet = renderFillSheet(fill, checkDraft(draft, fill, "2026-09-16"));

  const rows = sheet.details.flatMap((detail) => detail.rows);
  assert.ok(rows.length > 0, "示例活动应该有明细行");

  const keyOf = (label: string) => rows.find((row) => row.label === label)?.factKey;
  assert.equal(keyOf("货类"), "categories");
  assert.equal(keyOf("让扣点"), "rates");
  assert.equal(keyOf("回款率"), "rates");
  assert.equal(keyOf("折扣模式"), "discountEditable");

  // 活动信息行仍然走原来的 field，两条路径互不干扰。
  assert.equal(sheet.info.find((row) => row.label === "分行")?.field, "branches");

  // 用户说出来的值要带上依据，界面才能反查回原话出处。
  const branches = sheet.info.find((row) => row.label === "分行");
  assert.equal(branches?.source, "user");
  assert.ok(branches?.basis?.includes("7590"), `分行应带上用户原话作为依据：${branches?.basis}`);
  const dateRow = sheet.info.find((row) => row.label === "活动日期（开始）");
  assert.ok(dateRow?.basis, "日期也应带上依据");
});

test("labels that are not fact fields are ignored rather than guessed", () => {
  // 名称和内容走的是 copy，不是事实层；summarizeFactChanges 会把它们也列进来。
  const messages = [change(2, [["活动名称", "按模板生成", "钻石满2000减200"], ["门店", "未填", "7590"]], "a")];
  assert.deepEqual(recentlyFilled(messages, 2), ["stores"], "对不上事实 key 的标签直接丢掉，不猜");
});
