import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_QUOTA_MESSAGE, modelQuotaMessage, publicAgentError } from "../app/lib/agent/service-errors.ts";

test("额度耗尽只展示中文管理员提示，不带内部预算或请求标识", () => {
  for (const detail of [
    'API Error: Request rejected (429) · {"error":{"budget":123,"currency":"CNY","message":"monthly budget exhausted; ask your admin to raise it","request_id":"private-request","type":"quota_exceeded"}}',
    '429 {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
    'Your credit balance is too low to access the API',
    'insufficient_credits',
    '模型服务月度额度已耗尽',
    '问答服务额度不足，本次回答未完成；请联系服务管理员调整额度后重试',
  ]) {
    assert.equal(modelQuotaMessage(detail), "当前服务额度不足，请及时联系管理员。");
    assert.equal(publicAgentError(detail), MODEL_QUOTA_MESSAGE);
  }
});

test("普通429限流与上下文长度错误不冒充额度耗尽", () => {
  for (const detail of [
    '429 {"error":{"type":"rate_limit_error","message":"Too many requests, retry later"}}',
    '429 Too many tokens per minute',
    '400 context_length_exceeded: maximum context length is 1000 tokens',
    'max_tokens output truncated',
    '数据库连接失败',
  ]) {
    assert.equal(modelQuotaMessage(detail), undefined);
    assert.equal(publicAgentError(detail), detail);
  }
  assert.equal(publicAgentError('Claude API: monthly budget exhausted'), MODEL_QUOTA_MESSAGE);
  assert.equal(publicAgentError('Claude Code process exited'), 'Agent 执行出错');
});
