import assert from "node:assert/strict";
import test from "node:test";
import { modelConfigFromEnv } from "../agent/model-gateway.ts";
import { analyticsSdkModel } from "../agent/analytics-model.ts";

test("已选官方模型接口时使用对应密钥，不启动原网关转换层", async () => {
  const config = await modelConfigFromEnv({ NODE_ENV: "test", AGENT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic-provider-key", JUZI_MODELS_KEY: "other-key", DEEPSEEK_MODEL: "deepseek-flash" });
  try {
    assert.equal(config.model, "deepseek-flash");
    assert.equal(config.modelBaseUrl, "https://api.deepseek.com/anthropic");
    assert.equal(config.apiKey, "synthetic-provider-key");
    assert.equal(config.apiKeyEnvName, "DEEPSEEK_API_KEY");
    assert.equal(analyticsSdkModel(config.model, config.modelBaseUrl), "claude-sonnet-4-6");
  } finally { await config.close(); }
});

test("原网关配置保持兼容，未知服务选择明确失败", async () => {
  const config = await modelConfigFromEnv({ NODE_ENV: "test", JUZI_MODELS_KEY: "synthetic-gateway-key", AGENT_MODEL: "claude-5.5-sonnet", MODEL_GATEWAY_URL: "https://synthetic.invalid/v1" });
  try {
    assert.equal(config.model, "claude-sonnet-5-5");
    assert.match(config.modelBaseUrl, /^http:\/\/127\.0\.0\.1:/);
    assert.equal(config.apiKey, "synthetic-gateway-key");
    assert.equal(config.apiKeyEnvName, "JUZI_MODELS_KEY");
  } finally { await config.close(); }
  await assert.rejects(modelConfigFromEnv({ NODE_ENV: "test", AGENT_PROVIDER: "unsupported" }), /不支持/);
});
