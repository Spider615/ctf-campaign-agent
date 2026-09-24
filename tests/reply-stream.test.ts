import assert from "node:assert/strict";
import test from "node:test";

import {
  createReplyStreamState,
  reduceReplyStream,
  sanitizeAgentReply,
} from "../app/lib/agent/reply-stream.ts";

test("reply sanitizer preserves questions and removes unsupported uplift claims", () => {
  assert.equal(sanitizeAgentReply("好的。还要加标语吗？"), "好的。还要加标语吗？");
  assert.equal(sanitizeAgentReply("好的。这样能提升20%的销量。接着确认门店。"), "好的。接着确认门店。");
});

test("reply stream only releases sanitized complete sentences", () => {
  let state = createReplyStreamState();
  let result = reduceReplyStream(state, {
    parentToolUseId: null,
    event: { type: "message_start" },
  });
  state = result.state;
  assert.deepEqual(result.actions, []);

  result = reduceReplyStream(state, {
    parentToolUseId: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "活动信息已经核对" } },
  });
  state = result.state;
  assert.deepEqual(result.actions, []);

  result = reduceReplyStream(state, {
    parentToolUseId: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "完成。还差结算说明函。" } },
  });
  state = result.state;
  assert.deepEqual(result.actions, [{ type: "text_delta", delta: "活动信息已经核对完成。还差结算说明函。" }]);
});

test("reply stream retracts provisional text when the same assistant message uses a tool", () => {
  let state = createReplyStreamState();
  state = reduceReplyStream(state, { parentToolUseId: null, event: { type: "message_start" } }).state;
  let result = reduceReplyStream(state, {
    parentToolUseId: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "我先核对活动规则。" } },
  });
  state = result.state;
  assert.deepEqual(result.actions, [{ type: "text_delta", delta: "我先核对活动规则。" }]);

  result = reduceReplyStream(state, {
    parentToolUseId: null,
    event: { type: "content_block_start", contentBlock: { type: "tool_use" } },
  });
  assert.deepEqual(result.actions, [{ type: "text_reset" }]);
});

test("reply stream ignores thinking and subagent output, then flushes safe final text", () => {
  let state = createReplyStreamState();
  state = reduceReplyStream(state, { parentToolUseId: null, event: { type: "message_start" } }).state;
  state = reduceReplyStream(state, {
    parentToolUseId: null,
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "private" } },
  }).state;
  state = reduceReplyStream(state, {
    parentToolUseId: "subagent-tool",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "subagent secret" } },
  }).state;
  let result = reduceReplyStream(state, {
    parentToolUseId: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "请补充活动日期" } },
  });
  state = result.state;
  assert.deepEqual(result.actions, []);

  result = reduceReplyStream(state, { parentToolUseId: null, event: { type: "message_stop" } });
  assert.deepEqual(result.actions, [{ type: "text_delta", delta: "请补充活动日期" }]);
});

test("reply stream never releases a complete unsupported uplift sentence", () => {
  let state = createReplyStreamState();
  state = reduceReplyStream(state, { parentToolUseId: null, event: { type: "message_start" } }).state;
  const result = reduceReplyStream(state, {
    parentToolUseId: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "预计能提升20%的销量。活动已建好。" } },
  });
  assert.deepEqual(result.actions, [{ type: "text_delta", delta: "活动已建好。" }]);
});

test("reply sanitizer keeps the 小福 persona and never names the underlying model", () => {
  // 线上真实出现过的回答：说漏的那句整句去掉，补上对外身份，其余照留。
  assert.equal(
    sanitizeAgentReply("我是 DeepSeek-V4-Pro 模型，由 Anthropic 的 Claude Agent SDK 驱动。在这里我的角色是周大福的营销活动运营同事，可以帮你整理活动 Brief。\n\n有什么营销活动需要一起推进吗？"),
    "我是小福，周大福专属智能营销助手Agent。在这里我的角色是周大福的营销活动运营同事，可以帮你整理活动 Brief。\n\n有什么营销活动需要一起推进吗？",
  );
  assert.equal(sanitizeAgentReply("底层用的是 deepseek。"), "我是小福，周大福专属智能营销助手Agent。");
  assert.equal(sanitizeAgentReply("I am Claude, made by Anthropic"), "我是小福，周大福专属智能营销助手Agent。");
  // 已经按人设介绍过自己，不再重复。
  assert.equal(
    sanitizeAgentReply("我是小福，周大福专属智能营销助手Agent。我不是 GPT，也不是通义千问。"),
    "我是小福，周大福专属智能营销助手Agent。",
  );
  // 顺口提到别家产品只去掉那一句，不硬塞自我介绍。
  assert.equal(sanitizeAgentReply("文案起草好了。也可以拿去 ChatGPT 里润色。"), "文案起草好了。");
  assert.equal(sanitizeAgentReply("我是小福，可以帮你把活动搭起来。"), "我是小福，可以帮你把活动搭起来。");
  // 身份名按人设原样写，模型加的空格去掉。
  assert.equal(sanitizeAgentReply("我是小福，周大福专属智能营销助手 Agent。"), "我是小福，周大福专属智能营销助手Agent。");
});

test("reply stream never releases a model name split across chunks", () => {
  let state = createReplyStreamState();
  state = reduceReplyStream(state, { parentToolUseId: null, event: { type: "message_start" } }).state;
  const actions = [];
  for (const text of ["我是 Deep", "Seek-V4 模型", "。可以帮你搭活动。"]) {
    const result = reduceReplyStream(state, { parentToolUseId: null, event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
    state = result.state;
    actions.push(...result.actions);
  }
  actions.push(...reduceReplyStream(state, { parentToolUseId: null, event: { type: "message_stop" } }).actions);
  assert.deepEqual(actions, [{ type: "text_delta", delta: "我是小福，周大福专属智能营销助手Agent。可以帮你搭活动。" }]);
});
