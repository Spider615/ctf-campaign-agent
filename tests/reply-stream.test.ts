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
