import assert from "node:assert/strict";
import test from "node:test";

import { createBackgroundRegistry } from "../app/lib/client/background-turns.ts";

test("不同会话可以同时各跑一个回合，同一会话不能重复开始", () => {
  const turns = createBackgroundRegistry<{ text: string }>();
  const a = turns.begin("A", { text: "" });
  const b = turns.begin("B", { text: "" });
  assert.ok(a && b);
  assert.equal(turns.begin("A", { text: "" }), null);
  assert.deepEqual([...turns.activeKeys()], ["A", "B"]);
  turns.patch("A", a.token, (state) => ({ text: state.text + "进度" }));
  assert.equal(turns.get("A")?.state.text, "进度");
  assert.equal(turns.get("B")?.state.text, "");
  assert.equal(turns.end("A", a.token), true);
  assert.ok(turns.begin("A", { text: "" }), "结束后可以再开始");
});

test("没有界面订阅时回合照常推进，切回来读到的是最新进度", () => {
  const turns = createBackgroundRegistry<{ steps: number }>();
  const entry = turns.begin("A", { steps: 0 })!;
  const seen: number[] = [];
  const unsubscribe = turns.subscribe(() => seen.push(turns.get("A")?.state.steps ?? -1));
  unsubscribe(); // 切走：界面卸载
  turns.patch("A", entry.token, (state) => ({ steps: state.steps + 1 }));
  turns.patch("A", entry.token, (state) => ({ steps: state.steps + 1 }));
  assert.deepEqual(seen, []);
  assert.equal(turns.get("A")?.state.steps, 2, "切回来接着看");
  assert.equal(entry.controller.signal.aborted, false, "切走不中止请求");
});

test("停止后迟到的进度和收尾不能影响新回合", () => {
  const turns = createBackgroundRegistry<{ text: string }>();
  const old = turns.begin("A", { text: "旧" })!;
  turns.abort("A");
  assert.equal(old.controller.signal.aborted, true);
  assert.equal(turns.isLive("A", old.token), false);
  const next = turns.begin("A", { text: "新" })!;
  turns.patch("A", old.token, () => ({ text: "迟到" }));
  assert.equal(turns.end("A", old.token), false);
  assert.equal(turns.get("A")?.token, next.token);
  assert.equal(turns.get("A")?.state.text, "新");
});

test("keep 停止时保留登记直到请求自己收尾", () => {
  const turns = createBackgroundRegistry<{ stopping: boolean }>();
  const entry = turns.begin("A", { stopping: false })!;
  turns.abort("A", { keep: true, change: () => ({ stopping: true }) });
  assert.equal(turns.has("A"), true);
  assert.equal(turns.get("A")?.state.stopping, true);
  assert.equal(turns.isLive("A", entry.token), false);
  assert.equal(turns.begin("A", { stopping: false }), null, "取消传播期间仍算忙");
  assert.equal(turns.end("A", entry.token), true);
  assert.equal(turns.has("A"), false);
});

test("活跃集合在两次变化之间是同一个对象", () => {
  const turns = createBackgroundRegistry<null>();
  const empty = turns.activeKeys();
  assert.equal(turns.activeKeys(), empty);
  const entry = turns.begin("A", null)!;
  const withA = turns.activeKeys();
  assert.notEqual(withA, empty);
  assert.equal(turns.activeKeys(), withA);
  turns.end("A", entry.token);
  assert.equal(turns.activeKeys().size, 0);
});
