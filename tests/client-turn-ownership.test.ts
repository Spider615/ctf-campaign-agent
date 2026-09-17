import assert from "node:assert/strict";
import test from "node:test";

import { createTurnOwnership } from "../app/lib/client/turn-ownership.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("停止发生在 409 对账读取期间时不应用快照并返回 null", async () => {
  const owner = createTurnOwnership("A");
  const session = owner.visit("A");
  const controller = new AbortController();
  const turn = owner.begin(session, controller.signal)!;
  const response = deferred<string>();
  const ui = { snapshot: "原快照", stopped: true };
  const pending = owner.readCurrent(turn, () => response.promise, (next) => {
    ui.snapshot = next;
    ui.stopped = false;
  });

  controller.abort();
  response.resolve("迟到快照");

  assert.equal(await pending, null);
  assert.deepEqual(ui, { snapshot: "原快照", stopped: true });
  assert.equal(owner.begin(session), null, "取消传播期间仍持有回合锁");
  assert.equal(owner.finish(turn), true);
  assert.ok(owner.begin(session));
});

test("A→B→A 时首个 A 对账不能覆盖新 A 或释放新回合", async () => {
  const owner = createTurnOwnership("A");
  const oldSession = owner.visit("A");
  const oldTurn = owner.begin(oldSession)!;
  const response = deferred<string>();
  let applied = "新 A 快照";
  const pending = owner.readCurrent(oldTurn, () => response.promise, (next) => { applied = next; });

  owner.visit("B");
  const newSession = owner.visit("A");
  const newTurn = owner.begin(newSession)!;
  response.resolve("旧 A 快照");

  assert.equal(await pending, null);
  assert.equal(applied, "新 A 快照");
  assert.ok(newSession.generation > oldSession.generation);
  assert.equal(owner.finish(oldTurn), false);
  assert.equal(owner.isCurrent(newTurn), true);
});

test("旧 A 发送闭包在 B 和再次进入 A 后均不会发请求或改变忙碌和草稿状态", () => {
  const owner = createTurnOwnership("A");
  const capturedSession = owner.visit("A");
  let requests = 0;
  const ui = { busy: false, pending: "新草稿" };
  const staleSend = () => {
    const turn = owner.begin(capturedSession);
    if (!turn) return null;
    ui.busy = true;
    ui.pending = "旧 A 内容";
    requests++;
    return turn;
  };

  owner.visit("B");
  assert.equal(staleSend(), null);
  owner.visit("A");
  assert.equal(staleSend(), null);
  assert.equal(requests, 0);
  assert.deepEqual(ui, { busy: false, pending: "新草稿" });
});

test("当前回合可对账但同一会话的旧 token 与卸载后的请求不可应用", async () => {
  const owner = createTurnOwnership("A");
  const session = owner.visit("A");
  const first = owner.begin(session)!;
  let applied = "原快照";
  assert.equal(await owner.readCurrent(first, async () => "已保存", (next) => { applied = next; }), "已保存");
  assert.equal(applied, "已保存");
  owner.finish(first);
  const second = owner.begin(session)!;
  assert.equal(await owner.readCurrent(first, async () => "旧 token", (next) => { applied = next; }), null);
  owner.deactivate(session);
  assert.equal(owner.isCurrent(second), false);
  assert.equal(owner.begin(session), null);
  owner.activate(session);
  assert.ok(owner.begin(session), "Effect 重新挂载后允许当前会话开始新回合");
});

test("取消期间的对账错误按取消返回，当前请求的错误仍然抛出", async () => {
  const owner = createTurnOwnership("A");
  const controller = new AbortController();
  const turn = owner.begin(owner.visit("A"), controller.signal)!;
  const failure = new Error("读取失败");
  await assert.rejects(owner.readCurrent(turn, async () => { throw failure; }, () => {}), failure);
  assert.equal(await owner.readCurrent(turn, async () => {
    controller.abort();
    throw failure;
  }, () => assert.fail("不应应用")), null);
});
