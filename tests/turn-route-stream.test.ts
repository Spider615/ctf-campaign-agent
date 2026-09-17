import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

async function waitForTestSignal(signal: Promise<void>, message: string, timeoutMs = 2200): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([signal, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally {
    clearTimeout(deadline);
  }
}

test("测试上游未启动时等待有局部截止并清理计时器", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cleared = t.mock.method(globalThis, "clearTimeout");
  const started = Promise.withResolvers<void>();
  let failure: unknown;
  const pending = waitForTestSignal(started.promise, "上游未启动", 100).catch((error: unknown) => { failure = error; });
  t.mock.timers.tick(100);
  await new Promise<void>((resolve) => setImmediate(resolve));
  try { assert.match(String(failure), /上游未启动/); assert.equal(cleared.mock.callCount(), 1); }
  finally { started.resolve(); await pending; }
});

test("测试信号成功或失败后都清理局部截止计时器", async (t) => {
  const cleared = t.mock.method(globalThis, "clearTimeout");
  await waitForTestSignal(Promise.resolve(), "不会超时");
  await assert.rejects(waitForTestSignal(Promise.reject(new Error("上游失败")), "不会超时"), /上游失败/);
  assert.equal(cleared.mock.callCount(), 2);
});

async function bundleRoute(upstream: string) {
  const result = await build({
    stdin: { contents: 'import { POST } from "./app/api/sessions/[id]/turns/route.ts"; export default {fetch: (request) => POST(request, {params: Promise.resolve({id: "test"})})};', resolveDir: process.cwd() },
    bundle: true, write: false, format: "esm", platform: "browser",
    plugins: [{ name: "runtime-boundaries", setup(build) {
      build.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "env", namespace: "test" }));
      build.onResolve({ filter: /db\/index\.ts$/ }, () => ({ path: "db", namespace: "test" }));
      build.onResolve({ filter: /\/turns\.ts$/ }, () => ({ path: "turns", namespace: "test" }));
      build.onLoad({ filter: /.*/, namespace: "test" }, ({ path }) => ({ contents: path === "env"
        ? "export const env = {};"
        : path === "db" ? "export const getDbBinding = () => ({});"
        : `export class TurnError extends Error { constructor(status, message) { super(message); this.status = status; } }
           export async function runTurn(id, body, deps) {
             if (body.conflict) throw new TurnError(409, "页面已更新，请重试");
             if (body.wait) return await new Promise((_, reject) => deps.signal.addEventListener("abort", () => reject(deps.signal.reason), {once: true}));
             const response = await fetch(${JSON.stringify(upstream)}, {signal: deps.signal});
             const reader = response.body.getReader();
             while (true) { const {done} = await reader.read(); if (done) break; }
             return {session: {id}};
           }` }));
    } }],
  });
  return result.outputFiles[0].text;
}

async function routeWorker(upstream: string) {
  return new Miniflare({ modules: true, compatibilityDate: "2026-05-15", compatibilityFlags: ["nodejs_compat", "enable_request_signal"], script: await bundleRoute(upstream) });
}

test("无人读取时保活不会继续堆积空行", async (t) => {
  const { default: route } = await import(`data:text/javascript;base64,${Buffer.from(await bundleRoute("http://127.0.0.1:1")).toString("base64")}`);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const cleared = t.mock.method(globalThis, "clearInterval");
  const controller = new AbortController();
  const response = await route.fetch(new Request("http://localhost/turns", { method: "POST", headers: { accept: "application/x-ndjson" }, body: JSON.stringify({ wait: true }), signal: controller.signal }));
  t.mock.timers.tick(3000);
  const reader = response.body.getReader();
  try {
    assert.equal(new TextDecoder().decode((await reader.read()).value), "\n");
    let secondReadSettled = false;
    const second = reader.read().then(() => { secondReadSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondReadSettled, false, "没有消费者时最多排队一个保活空行");
    // 恢复读取后继续保活，仍能触发代理断连检测。
    t.mock.timers.tick(250);
    await second;
  } finally {
    controller.abort();
    await reader.cancel();
    reader.releaseLock();
    assert.ok(cleared.mock.callCount() > 0, "取消后清理保活计时器");
  }
});

test("真实 Workers 路由将 409 放进 HTTP 200 的流式错误帧", async () => {
  const worker = await routeWorker("http://127.0.0.1:1");
  try {
    const response = await worker.dispatchFetch("http://localhost/turns", { method: "POST", headers: { accept: "application/x-ndjson" }, body: JSON.stringify({ conflict: true }) });
    assert.equal(response.status, 200);
    const event = JSON.parse((await response.text()).trim());
    assert.deepEqual(event, { type: "error", status: 409, error: "页面已更新，请重试" });
  } finally { await worker.dispose(); }
});

test("静默模型等待期间浏览器断开也会在下一次工具执行前取消上游", { timeout: 10000 }, async () => {
  let delayedTool = false;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    response.write("开始\n");
    resolveStarted();
    const timer = setTimeout(() => { delayedTool = true; response.write("迟到工具\n"); }, 1800);
    response.on("close", () => { clearTimeout(timer); resolveClosed(); });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  let worker: Miniflare | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const controller = new AbortController();
  try {
    worker = await routeWorker(`http://127.0.0.1:${address.port}`);
    const response = await worker.dispatchFetch("http://localhost/turns", { method: "POST", headers: { accept: "application/x-ndjson" }, body: "{}", signal: controller.signal });
    reader = response.body!.getReader();
    await waitForTestSignal(started, "上游未启动");
    const stoppedAt = Date.now();
    controller.abort();
    await reader.read().catch(() => undefined);
    await waitForTestSignal(closed, "上游未收到取消");
    assert.equal(delayedTool, false, "浏览器停止后不能等到工具再次输出才取消");
    assert.ok(Date.now() - stoppedAt < 1000, "静默等待的取消应在一秒内到达上游");
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    await worker?.dispose();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
