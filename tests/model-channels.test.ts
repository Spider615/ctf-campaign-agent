import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createModelChannels, liveModelConfig } from "../agent/model-channels.ts";

const BOTH = { NODE_ENV: "test", AGENT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "ds-key", JUZI_MODELS_KEY: "jz-key", AGENT_MODEL: "claude-5.5-sonnet" } as const;

async function open(t: TestContext, env: NodeJS.ProcessEnv = BOTH, dir = mkdtempSync(join(tmpdir(), "model-channels-"))) {
  const statePath = join(dir, "model-channel.json");
  const channels = await createModelChannels({ env, statePath, fetch: async () => Response.json({}) });
  t.after(async () => { await channels.close(); });
  return { channels, statePath, dir };
}

test("默认按 AGENT_PROVIDER，没配 key 的渠道显示未配置且不能选", async (t) => {
  const { channels } = await open(t, { NODE_ENV: "test", AGENT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "ds-key" });
  assert.equal(channels.active(), "deepseek");
  assert.deepEqual(channels.list().map((item) => [item.channel, item.configured, item.active]), [["deepseek", true, true], ["juzi", false, false]]);
  assert.throws(() => channels.select("juzi"), /没有配置/);
  assert.equal(channels.active(), "deepseek");
});

test("切换立即生效，记下切换记录并写进状态文件，重开后保持", async (t) => {
  const { channels, statePath, dir } = await open(t);
  assert.equal(channels.current().channel, "deepseek");
  channels.select("juzi");
  assert.equal(channels.current().channel, "juzi");
  assert.equal(channels.current().model, "claude-sonnet-5-5");
  assert.equal(channels.current().apiKey, "jz-key");
  assert.deepEqual(channels.history().map((item) => [item.from, item.to]), [["deepseek", "juzi"]]);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).channel, "juzi");
  const reopened = await open(t, BOTH, dir);
  assert.equal(reopened.channels.active(), "juzi", "重启后用上次选的渠道，不回到环境变量默认值");
  assert.equal(reopened.channels.history().length, 1);
});

test("进行中的轮次固定在开始时的渠道，切换只影响之后的轮次", async (t) => {
  const { channels } = await open(t);
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = channels.pin(async (channel) => { await gate; return [channel, channels.current().channel, channels.current().apiKey]; });
  channels.select("juzi");
  const next = await channels.pin(async (channel) => channel);
  release();
  assert.deepEqual(await running, ["deepseek", "deepseek", "ds-key"]);
  assert.equal(next, "juzi");
});

test("运行器拿到的配置对象每次读当前渠道", async (t) => {
  const { channels } = await open(t);
  const config = liveModelConfig(channels, { runtimeDir: "/tmp/x" });
  assert.equal(config.model, "deepseek-flash");
  assert.equal(config.runtimeDir, "/tmp/x");
  const deepseekBase = config.modelBaseUrl;
  channels.select("juzi");
  assert.equal(config.model, "claude-sonnet-5-5");
  assert.equal(config.apiKey, "jz-key");
  assert.notEqual(config.modelBaseUrl, deepseekBase);
  assert.match(config.modelBaseUrl, /^http:\/\/127\.0\.0\.1:/);
});

test("状态文件里的渠道没配 key 或文件损坏时退回默认", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "model-channels-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "model-channel.json"), JSON.stringify({ channel: "juzi", history: [] }));
  assert.equal((await open(t, { NODE_ENV: "test", DEEPSEEK_API_KEY: "ds-key" }, dir)).channels.active(), "deepseek");
  writeFileSync(join(dir, "model-channel.json"), "{坏的");
  assert.equal((await open(t, BOTH, dir)).channels.active(), "deepseek");
});

test("运行器不在创建时固定模型名，每轮按当前渠道取", () => {
  for (const file of ["agent/analysis-plan-run-turn.ts", "agent/insight-ask.ts"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const factory = source.slice(source.indexOf("export function create"), source.indexOf("return async", source.indexOf("export function create")));
    assert.doesNotMatch(factory, /analyticsSdkModel\(config\.model\)/, `${file} 不能在创建运行器时算好模型名`);
  }
});

test("Agent 服务用渠道管理器组装运行器和用量渠道", () => {
  const server = readFileSync(new URL("../agent/server.ts", import.meta.url), "utf8");
  assert.match(server, /createModelChannels\(/);
  assert.match(server, /liveModelConfig\(channels/);
  assert.doesNotMatch(server, /modelConfigFromEnv\(/);
  assert.match(server, /channel: \(\) => channels\.active\(\)|channels,/);
});
