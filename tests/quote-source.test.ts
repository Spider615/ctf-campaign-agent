import assert from "node:assert/strict";
import test from "node:test";

import type { ChatMessage } from "../app/lib/campaign/ics1811/messages.ts";
import { findQuoteSource } from "../app/lib/campaign/ics1811/quote-source.ts";

const said = (id: string, text: string): ChatMessage => ({
  id,
  role: "user",
  createdAt: "2026-09-16T00:00:00.000Z",
  content: { v: 2, kind: "user_text", text },
});

const agentSaid = (id: string, text: string): ChatMessage => ({
  id,
  role: "assistant",
  createdAt: "2026-09-16T00:00:00.000Z",
  content: { v: 2, kind: "agent_text", text },
});

test("能从对话里找回这个值是哪句话说的", () => {
  const messages = [
    said("m1", "我想在今年10月1号开一个国庆营销活动"),
    agentSaid("m2", "「10月1号」只说了开始、没说哪天结束。"),
    said("m3", "10月1日到10月7日，7590门店"),
  ];
  assert.equal(findQuoteSource(messages, "7590门店"), "m3");
  assert.equal(findQuoteSource(messages, "10月1日到10月7日"), "m3");
});

test("找不到就返回 null，不乱指一条", () => {
  const messages = [said("m1", "钻石类打9折")];
  assert.equal(findQuoteSource(messages, "7590门店"), null);
  assert.equal(findQuoteSource([], "任何话"), null);
  assert.equal(findQuoteSource(messages, ""), null, "空 quote 不该匹配到任何消息");
});

test("只认用户说的话，不把模型复述当来源", () => {
  // 模型的回复里会重复用户的原话，但「这个值是谁说的」只能指向用户那条。
  const messages = [
    said("m1", "7590门店"),
    agentSaid("m2", "门店 7590 记下了。7590门店"),
  ];
  assert.equal(findQuoteSource(messages, "7590门店"), "m1");
});

test("同一句话说过多次时指向最近的一条", () => {
  const messages = [said("m1", "钻石类打9折"), said("m2", "还是钻石类打9折吧")];
  assert.equal(findQuoteSource(messages, "钻石类打9折"), "m2");
});

test("标点和空格的差异不该让来源丢失", () => {
  // facts.ts 的 quote 守卫用 compactQuote 规范化后比对，这里必须用同一套，
  // 否则界面会出现「事实记下了、却找不到出处」的矛盾。
  const messages = [said("m1", "活动日期：2026-10-01 至 2026-10-07，7590 门店。")];
  assert.equal(findQuoteSource(messages, "2026-10-01至2026-10-07"), "m1");
  assert.equal(findQuoteSource(messages, "7590门店"), "m1");
});
