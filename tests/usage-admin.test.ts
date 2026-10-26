import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createAgentHttpHandler } from "../agent/http-handler.ts";
import { createAdminAuth, parseUsageQuery } from "../agent/usage/admin.ts";
import { createUsageStore } from "../agent/usage/store.ts";

const SECRET = "s".repeat(32);

test("密码正确签发凭据、错误密码返回 null", () => {
  const auth = createAdminAuth({ password: "pw-123456", secret: SECRET, now: () => 1_000 });
  assert.equal(auth.configured, true);
  const token = auth.login("pw-123456");
  assert.match(token ?? "", /^\d+\.[A-Za-z0-9_-]+$/);
  assert.equal(auth.verify(token!), true);
  assert.equal(auth.login("wrong"), null);
  assert.equal(auth.login(""), null);
  assert.match(readFileSync(new URL("../agent/usage/admin.ts", import.meta.url), "utf8"), /timingSafeEqual/);
});

test("篡改或过期的凭据被拒绝", () => {
  let now = 1_000;
  const auth = createAdminAuth({ password: "pw-123456", secret: SECRET, now: () => now });
  const token = auth.login("pw-123456")!;
  const [expires, signature] = token.split(".");
  const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");
  assert.equal(auth.verify(`${expires}.${flipped}`), false);
  assert.equal(auth.verify(`${Number(expires) + 1}.${signature}`), false, "改过期时间签名不再匹配");
  assert.equal(auth.verify(undefined), false);
  assert.equal(auth.verify("garbage"), false);
  now += 12 * 3600_000;
  assert.equal(auth.verify(token), true);
  now += 1;
  assert.equal(auth.verify(token), false);
});

test("没配密码或密钥太短时视为未配置", () => {
  assert.equal(createAdminAuth({}).configured, false);
  assert.equal(createAdminAuth({ password: "pw", secret: "short" }).configured, false);
  assert.equal(createAdminAuth({ password: "pw" }).login("pw"), null);
});

test("查询参数越界返回错误", () => {
  assert.deepEqual(parseUsageQuery(new URLSearchParams("from=2026-10-01&to=2026-10-07&channel=juzi&keyword=金&page=3&pageSize=50")),
    { from: "2026-10-01", to: "2026-10-07", channel: "juzi", keyword: "金", page: 3, pageSize: 50 });
  for (const query of ["from=2026-10-08&to=2026-10-07", "from=2026-01-01&to=2026-04-04", "from=2026-10-01&to=2026-10-02&channel=openai", "from=x&to=2026-10-02", "from=2026-10-01&to=2026-10-02&keyword=" + "金".repeat(101), "from=2026-10-01&to=2026-10-02&status=done", "from=2026-10-01&to=2026-10-02&page=0", "from=2026-10-01&to=2026-10-02&pageSize=500"])
    assert.throws(() => parseUsageQuery(new URLSearchParams(query)), /./, query);
});

async function start(t: TestContext, password?: string) {
  const dir = mkdtempSync(join(tmpdir(), "usage-admin-"));
  const usage = createUsageStore(join(dir, "usage.sqlite"));
  usage.startTurn({ id: "t1", entry: "analysis", channel: "deepseek", visitor: "v", conversationId: "c1", internal: false, question: "客户的问题", startedAt: Date.parse("2026-10-20T02:00:00Z") });
  const admin = createAdminAuth({ password, secret: SECRET });
  const server = createServer(createAgentHttpHandler({ token: "", model: "test", usage, admin, logger: { log() {}, error() {} }, runAgentTurn: async () => { throw new Error("不调用"); },
    insight: { graph: async () => ({}) } as never, insightAsk: async () => ({ schema: "insight-answer/v2", body: "门店铺型最强。", highlights: [], removed: 0 }) }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); usage.close(); rmSync(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  return { base: `http://127.0.0.1:${address.port}`, admin };
}

test("内部接口：未登录 401 且不含客户内容，登录后可查", async (t) => {
  const { base } = await start(t, "pw-123456");
  for (const path of ["/internal/overview?from=2026-10-01&to=2026-10-31", "/internal/conversations?from=2026-10-01&to=2026-10-31", "/internal/conversations/analysis%3Ac1"]) {
    const denied = await fetch(`${base}${path}`, { headers: { "x-ctf-admin": "1.bad" } });
    assert.equal(denied.status, 401, path);
    assert.deepEqual(await denied.json(), { error: "请先登录管理端" });
  }
  const login = await fetch(`${base}/internal/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "pw-123456" }) });
  assert.equal(login.status, 200);
  const { token, maxAge } = await login.json() as { token: string; maxAge: number };
  assert.equal(maxAge, 43200);
  const wrong = await fetch(`${base}/internal/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "x" }) });
  assert.equal(wrong.status, 401);
  const headers = { "x-ctf-admin": token };
  const list = await (await fetch(`${base}/internal/conversations?from=2026-10-01&to=2026-10-31`, { headers })).json() as { conversations: Array<{ key: string }>; total: number; page: number; pageSize: number };
  assert.deepEqual(list.conversations.map((row) => row.key), ["analysis:c1"]);
  assert.deepEqual([list.total, list.page, list.pageSize], [1, 1, 20]);
  const detail = await (await fetch(`${base}/internal/conversations/analysis%3Ac1`, { headers })).json() as { conversation: { turns: Array<{ question: string }> } };
  assert.equal(detail.conversation.turns[0].question, "客户的问题");
  assert.equal((await fetch(`${base}/internal/conversations/analysis%3Anone`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/internal/overview?from=2026-10-08&to=2026-10-01`, { headers })).status, 400);
  const overview = await (await fetch(`${base}/internal/overview?from=2026-10-01&to=2026-10-31`, { headers })).json() as { overview: { days: unknown[] } };
  assert.equal(overview.overview.days.length, 1);
});

test("没配管理员时内部接口返回 503，客户接口不受影响", async (t) => {
  const { base } = await start(t);
  const response = await fetch(`${base}/internal/overview?from=2026-10-01&to=2026-10-31`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "管理端未配置" });
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("管理员凭据让这一轮记为内部流量，伪造的不算", async (t) => {
  const { base, admin } = await start(t, "pw-123456");
  const token = admin.login("pw-123456")!;
  const ask = (credential: string, conversation: string) => fetch(`${base}/insight/ask`, { method: "POST", headers: { "content-type": "application/json", "x-ctf-admin": credential, "x-ctf-conversation": conversation }, body: JSON.stringify({ question: "哪个因素最强" }) }).then((response) => response.text());
  await ask(token, "a"); await ask("1.forged", "b");
  const headers = { "x-ctf-admin": token };
  const all = await (await fetch(`${base}/internal/conversations`, { headers })).json() as { conversations: Array<{ internal: boolean; entry: string }> };
  const insight = all.conversations.filter((row) => row.entry === "insight");
  assert.deepEqual(insight.map((row) => row.internal).sort(), [false, true]);
});

test("Workers 登录接口只接受同源 POST 并设 HttpOnly cookie", () => {
  const route = readFileSync(new URL("../app/api/internal/login/route.ts", import.meta.url), "utf8");
  assert.match(route, /assertSameOrigin\(request\)/);
  assert.match(route, /HttpOnly; SameSite=Strict/);
  const access = readFileSync(new URL("../app/lib/server/analytics-access.ts", import.meta.url), "utf8");
  assert.match(access, /export function assertSameOrigin/);
});

test("坏的会话编号和查询出错都只返回错误，不让进程崩", async (t) => {
  const { base, admin } = await start(t, "pw-123456");
  const headers = { "x-ctf-admin": admin.login("pw-123456")! };
  assert.equal((await fetch(`${base}/internal/conversations/%E0%A4%A`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("连续输错密码后暂时锁定登录", async (t) => {
  const { base } = await start(t, "pw-123456");
  const login = (password: string) => fetch(`${base}/internal/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  for (let i = 0; i < 5; i++) assert.equal((await login("x")).status, 401);
  const locked = await login("pw-123456");
  assert.equal(locked.status, 429);
  assert.deepEqual(await locked.json(), { error: "密码错误次数太多，请稍后再试" });
});

test("用量库打不开时 Agent 照常服务客户", () => {
  const server = readFileSync(new URL("../agent/server.ts", import.meta.url), "utf8");
  assert.match(server, /try \{ usage = createUsageStore\([\s\S]*?\ncatch \(error\)/);
});

test("管理端渠道接口：查看、切换立即生效，未登录和没配 key 的拒绝", async (t) => {
  const { createModelChannels } = await import("../agent/model-channels.ts");
  const dir = mkdtempSync(join(tmpdir(), "usage-admin-ch-"));
  const channels = await createModelChannels({ env: { NODE_ENV: "test", AGENT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "ds", JUZI_MODELS_KEY: "jz" }, statePath: join(dir, "model-channel.json"), fetch: async () => Response.json({}) });
  const usage = createUsageStore(join(dir, "usage.sqlite"));
  const admin = createAdminAuth({ password: "pw-123456", secret: SECRET });
  const server = createServer(createAgentHttpHandler({ token: "", model: () => channels.current().model, usage, admin, channels, logger: { log() {}, error() {} }, runAgentTurn: async () => { throw new Error("不调用"); } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); server.close(); usage.close(); await channels.close(); rmSync(dir, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "x-ctf-admin": admin.login("pw-123456")!, "content-type": "application/json" };
  assert.equal((await fetch(`${base}/internal/channel`)).status, 401);
  assert.equal((await fetch(`${base}/internal/channel`, { method: "POST", body: JSON.stringify({ channel: "juzi" }) })).status, 401);
  const before = await (await fetch(`${base}/internal/channel`, { headers })).json() as { active: string; channels: Array<{ channel: string; configured: boolean }>; history: unknown[] };
  assert.equal(before.active, "deepseek");
  assert.deepEqual(before.channels.map((item) => item.configured), [true, true]);
  assert.ok(!JSON.stringify(before).includes("\"ds\"") && !JSON.stringify(before).includes("\"jz\""), "不返回 key");
  const switched = await fetch(`${base}/internal/channel`, { method: "POST", headers, body: JSON.stringify({ channel: "juzi" }) });
  assert.equal(switched.status, 200);
  assert.equal(channels.active(), "juzi");
  assert.equal(((await (await fetch(`${base}/health`)).json()) as { model: string }).model, "claude-sonnet-5-5", "下一次读取立即是新渠道");
  const after = await (await fetch(`${base}/internal/channel`, { headers })).json() as { active: string; history: Array<{ from: string; to: string }> };
  assert.deepEqual([after.active, after.history[0].from, after.history[0].to], ["juzi", "deepseek", "juzi"]);
  assert.equal((await fetch(`${base}/internal/channel`, { method: "POST", headers, body: JSON.stringify({ channel: "openai" }) })).status, 400);
});
