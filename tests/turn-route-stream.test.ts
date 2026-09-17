import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

async function routeWorker(upstream: string) {
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
             const response = await fetch(${JSON.stringify(upstream)}, {signal: deps.signal});
             const reader = response.body.getReader();
             while (true) { const {done} = await reader.read(); if (done) break; }
             return {session: {id}};
           }` }));
    } }],
  });
  return new Miniflare({ modules: true, compatibilityDate: "2026-05-15", compatibilityFlags: ["nodejs_compat", "enable_request_signal"], script: result.outputFiles[0].text });
}

test("真实 Workers 路由将 409 放进 HTTP 200 的流式错误帧", async () => {
  const worker = await routeWorker("http://127.0.0.1:1");
  try {
    const response = await worker.dispatchFetch("http://localhost/turns", { method: "POST", headers: { accept: "application/x-ndjson" }, body: JSON.stringify({ conflict: true }) });
    assert.equal(response.status, 200);
    const event = JSON.parse((await response.text()).trim());
    assert.deepEqual(event, { type: "error", status: 409, error: "页面已更新，请重试" });
  } finally { await worker.dispose(); }
});

test("静默模型等待期间浏览器断开也会在下一次工具执行前取消上游", async () => {
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
  const worker = await routeWorker(`http://127.0.0.1:${address.port}`);
  try {
    const controller = new AbortController();
    const response = await worker.dispatchFetch("http://localhost/turns", { method: "POST", headers: { accept: "application/x-ndjson" }, body: "{}", signal: controller.signal });
    const reader = response.body!.getReader();
    await started;
    const stoppedAt = Date.now();
    controller.abort();
    await reader.read().catch(() => undefined);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([closed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("上游未收到取消")), 2200); })]);
    } finally { clearTimeout(deadline); }
    assert.equal(delayedTool, false, "浏览器停止后不能等到工具再次输出才取消");
    assert.ok(Date.now() - stoppedAt < 1000, "静默等待的取消应在一秒内到达上游");
  } finally {
    await worker.dispose();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
