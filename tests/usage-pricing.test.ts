import assert from "node:assert/strict";
import test from "node:test";

import { createCostEstimator, isDeepseekPeak } from "../agent/usage/pricing.ts";

const M = 1_000_000;
const at = (iso: string) => Date.parse(iso);
// 2026-10-26 是周一；北京时间 = UTC + 8。
const MON_10 = at("2026-10-26T02:00:00Z");
const MON_1230 = at("2026-10-26T04:30:00Z");
const SAT_10 = at("2026-10-24T02:00:00Z");
const tokens = { inputTokens: M, outputTokens: M, cacheReadTokens: M, cacheWriteTokens: null };

test("DeepSeek 高峰时段：工作日 9–12、14–18 点", () => {
  assert.equal(isDeepseekPeak(MON_10), true);
  assert.equal(isDeepseekPeak(MON_1230), false);
  assert.equal(isDeepseekPeak(at("2026-10-26T06:00:00Z")), true, "14:00 起是高峰");
  assert.equal(isDeepseekPeak(at("2026-10-26T10:00:00Z")), false, "18:00 起是空闲");
  assert.equal(isDeepseekPeak(SAT_10), false, "周末全天空闲");
});

test("deepseek-flash 按官方单价估算，空闲时段半价", () => {
  const estimate = createCostEstimator({});
  assert.equal(estimate({ channel: "deepseek", model: "deepseek-flash", startedAt: MON_10, ...tokens }), 10.04);
  assert.equal(estimate({ channel: "deepseek", model: "deepseek-flash", startedAt: SAT_10, ...tokens }), 5.02);
  assert.equal(estimate({ channel: "deepseek", model: "deepseek-v4-pro", startedAt: MON_10, ...tokens }), 36.3);
});

test("上游没给的 Token 不计，全都没有时算不出", () => {
  const estimate = createCostEstimator({});
  assert.equal(estimate({ channel: "deepseek", model: "deepseek-flash", startedAt: MON_10, inputTokens: M, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }), 2);
  assert.equal(estimate({ channel: "deepseek", model: "deepseek-flash", startedAt: MON_10, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }), null);
});

test("没有单价的模型和渠道显示未定价，句子互动网关按配置的单价算", () => {
  assert.equal(createCostEstimator({})({ channel: "deepseek", model: "deepseek-unknown", startedAt: MON_10, ...tokens }), null);
  assert.equal(createCostEstimator({})({ channel: "juzi", model: "claude-sonnet-5-5", startedAt: MON_10, ...tokens }), null);
  const priced = createCostEstimator({ JUZI_INPUT_PRICE_PER_M: "20", JUZI_OUTPUT_PRICE_PER_M: "100", JUZI_CACHE_READ_PRICE_PER_M: "2" });
  assert.equal(priced({ channel: "juzi", model: "claude-sonnet-5-5", startedAt: SAT_10, ...tokens }), 122, "网关不分时段");
  const noCache = createCostEstimator({ JUZI_INPUT_PRICE_PER_M: "20", JUZI_OUTPUT_PRICE_PER_M: "100" });
  assert.equal(noCache({ channel: "juzi", model: "m", startedAt: SAT_10, ...tokens }), 140, "没配缓存单价时缓存命中按输入价算");
  assert.equal(createCostEstimator({ JUZI_INPUT_PRICE_PER_M: "abc", JUZI_OUTPUT_PRICE_PER_M: "100" })({ channel: "juzi", model: "m", startedAt: SAT_10, ...tokens }), null, "单价填错不猜");
});
