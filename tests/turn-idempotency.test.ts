import assert from "node:assert/strict";
import test from "node:test";

import { createAgentState, finishAgentTurn, updateCampaignBrief } from "../app/lib/agent/tools.ts";
import { decodeMessage, encodeMessage } from "../app/lib/campaign/ics1811/messages.ts";
import { ConflictError, createMemoryStore, type TurnWrite } from "../app/lib/server/session-store.ts";
import { createSession, parseTurnInput, runTurn, TurnError, type TurnDeps } from "../app/lib/server/turns.ts";
import { createClientTurnLease, turnRequestHash, type ClientTurnBody } from "../app/lib/turn-identity.ts";
import { reconcileSubmittedText, turnWasCommitted } from "../app/lib/client/turn-result.ts";

const TURN_ID = "11111111-1111-4111-8111-111111111111";
const NEXT_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";

const CLIENT_BODIES: ClientTurnBody[] = [
  { type: "text", text: "继续讨论" },
  { type: "edit", answers: { Q1: "值" }, origin: "panel" },
  { type: "interpret" },
  { type: "dismiss", noteId: "note-1" },
  { type: "undo", versionSeq: 2 },
  { type: "rollback", seq: 1 },
];

test("客户端回合租约在不确定结果后复用，成功后才为相同操作换新 ID", () => {
  for (const body of CLIENT_BODIES) {
    const ids = [TURN_ID, NEXT_ID];
    const lease = createClientTurnLease(() => ids.shift()!);
    const first = lease.acquire(body);
    assert.equal(first, TURN_ID);
    assert.equal(lease.acquire({ ...body, expectedSeq: 99 }), TURN_ID, `${body.type} 的版本刷新不能改变回合身份`);
    assert.equal(lease.complete(NEXT_ID), false, "迟到的其他回合不能清掉当前租约");
    assert.equal(lease.acquire(body), TURN_ID, "停止或网络不确定返回 null 后继续复用");
    assert.equal(lease.complete(first), true);
    assert.equal(lease.acquire(body), NEXT_ID, "收到成功快照或完成 409 对账后，相同操作是新的用户意图");
  }
});

test("客户端回合租约不把 ID 复用于不同受控请求", () => {
  const ids = [TURN_ID, NEXT_ID];
  const lease = createClientTurnLease(() => ids.shift()!);
  assert.equal(lease.acquire({ type: "text", text: "第一句" }), TURN_ID);
  assert.equal(lease.acquire({ type: "text", text: "第二句" }), NEXT_ID);
  assert.equal(lease.complete(TURN_ID), false, "旧请求迟到完成不能清掉新请求租约");
  assert.equal(lease.acquire({ type: "text", text: "第二句" }), NEXT_ID);
});

test("服务端请求哈希忽略传输身份和预期版本，但绑定受控操作内容", async () => {
  const first = await turnRequestHash({ type: "text", text: "继续讨论", expectedSeq: 1, clientTurnId: TURN_ID });
  const retry = await turnRequestHash({ clientTurnId: NEXT_ID, expectedSeq: 99, text: "继续讨论", type: "text" });
  const other = await turnRequestHash({ type: "text", text: "换一个问题", expectedSeq: 1, clientTurnId: TURN_ID });
  assert.equal(first, retry);
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{64}$/, "持久化凭据只暴露固定长度摘要，不保存原话");
});

test("消息编解码兼容无凭据旧数据并保留新回合凭据", () => {
  const legacy = decodeMessage("user", JSON.stringify({ v: 2, kind: "user_text", text: "旧消息" }));
  assert.equal(legacy.turn, undefined);
  const receipt = { id: TURN_ID, requestHash: "a".repeat(64) };
  const current = { v: 2 as const, kind: "user_text" as const, text: "新消息", turn: receipt };
  assert.deepEqual(decodeMessage("user", encodeMessage(current)), current);
});

test("A 已提交且 B 更晚时按 A receipt 确认，不把 A 恢复到输入框", async () => {
  const { deps } = setup();
  const initial = await createSession({ entryMode: "new", text: "你好" }, deps);
  const ids = [TURN_ID, THIRD_ID];
  const lease = createClientTurnLease(() => ids.shift()!);
  const a = { type: "text" as const, text: "回合 A" };
  const aId = lease.acquire(a);
  const afterA = await runTurn(initial.session.id, { ...a, clientTurnId: aId, expectedSeq: initial.latest.seq }, deps);
  await runTurn(initial.session.id, { type: "text", text: "回合 B", clientTurnId: NEXT_ID, expectedSeq: afterA.latest.seq }, deps);

  const retryId = lease.acquire({ ...a, expectedSeq: 99 });
  const reconciled = await runTurn(initial.session.id, { ...a, clientTurnId: retryId, expectedSeq: initial.latest.seq }, deps);
  const committed = turnWasCommitted(reconciled, retryId, a.text);
  const latestUser = reconciled.messages.findLast((message) => message.content.kind === "user_text");
  assert.equal(latestUser?.content.kind === "user_text" ? latestUser.content.text : null, "回合 B", "更晚的 B 仍是最新用户回合");
  assert.equal(committed, true, "必须扫描 A 的 receipt，不能只看最新文案 B");
  assert.equal(reconcileSubmittedText("", a.text, { committed, current: true }), "");
  assert.equal(lease.complete(retryId), true);
  assert.equal(lease.acquire(a), THIRD_ID, "A 成功后再次发送相同文案必须使用新 ID");
});

test("没有 A receipt 时才恢复 A，同文案的其他 receipt 不能冒充 A", async () => {
  const { deps } = setup();
  const initial = await createSession({ entryMode: "new", text: "你好" }, deps);
  const other = await runTurn(initial.session.id, {
    type: "text",
    text: "回合 A",
    clientTurnId: NEXT_ID,
    expectedSeq: initial.latest.seq,
  }, deps);
  assert.equal(turnWasCommitted(other, TURN_ID, "回合 A"), false, "其他 ID 的同文案不能冒充本回合");
  assert.equal(reconcileSubmittedText("", "回合 A", { committed: false, current: true }), "回合 A");

  const legacy = structuredClone(other);
  for (const message of legacy.messages) delete message.content.turn;
  assert.equal(turnWasCommitted(legacy, TURN_ID, "回合 A"), true, "完全没有 receipt 的旧 Snapshot 保留末句 fallback");
});

test("迟到旧 send 不能清除新租约或覆盖新草稿", () => {
  const ids = [TURN_ID, NEXT_ID, THIRD_ID];
  const lease = createClientTurnLease(() => ids.shift()!);
  const oldId = lease.acquire({ type: "text", text: "旧回合" });
  const currentId = lease.acquire({ type: "text", text: "新回合" });
  assert.equal(lease.complete(oldId), false);
  assert.equal(lease.acquire({ type: "text", text: "新回合" }), currentId);
  assert.equal(reconcileSubmittedText("新草稿", "旧回合", { committed: false, current: false }), "新草稿");
  assert.equal(reconcileSubmittedText("", "旧回合", { committed: false, current: false }), "", "新回合已清空输入时也不能被旧回合回填");
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(outcome: "success" | "error" = "success") {
  let calls = 0;
  const deps: TurnDeps = {
    today: "2026-09-17",
    store: createMemoryStore(),
    runAgent: async (request) => {
      calls++;
      if (outcome === "error") throw new Error("上游认证失败");
      return finishAgentTurn(createAgentState(request), "请继续说说这次活动。");
    },
  };
  return { deps, calls: () => calls };
}

for (const type of ["text", "interpret"] as const) {
  for (const outcome of ["success", "error"] as const) {
    test(`${type} 仅消息 ${outcome} 已提交后同回合 ID 重试不再调用 Agent`, async () => {
      const { deps, calls } = setup(outcome);
      const initial = await createSession({ entryMode: "new", text: "你好" }, deps);
      const body = { type, ...(type === "text" ? { text: "继续讨论" } : {}), clientTurnId: TURN_ID, expectedSeq: initial.latest.seq };
      const first = await runTurn(initial.session.id, body, deps);
      assert.equal(first.latest.seq, initial.latest.seq, "仅消息回合不能伪造草稿版本");
      const retry = await runTurn(initial.session.id, body, deps);
      assert.equal(calls(), 1);
      assert.deepEqual(retry, first);
      assert.equal(retry.versions.length, 1);
    });
  }
}

test("同一句文字在成功后使用新回合 ID 可以再次发送", async () => {
  const { deps, calls } = setup();
  const initial = await createSession({ entryMode: "new", text: "你好" }, deps);
  const body = { type: "text", text: "行", expectedSeq: initial.latest.seq };
  await runTurn(initial.session.id, { ...body, clientTurnId: TURN_ID }, deps);
  const next = await runTurn(initial.session.id, { ...body, clientTurnId: NEXT_ID }, deps);
  assert.equal(calls(), 2);
  assert.equal(next.messages.filter((message) => message.content.kind === "user_text" && message.content.text === "行").length, 2);
});

test("已用回合 ID 不能用于不同请求，即使版本号相同", async () => {
  const { deps, calls } = setup();
  const initial = await createSession({ entryMode: "new", text: "你好" }, deps);
  const body = { type: "text", text: "继续讨论", clientTurnId: TURN_ID, expectedSeq: initial.latest.seq };
  await runTurn(initial.session.id, body, deps);
  await assert.rejects(
    runTurn(initial.session.id, { ...body, text: "换一个问题" }, deps),
    (error: unknown) => error instanceof TurnError && error.status === 400,
  );
  assert.equal(calls(), 1);
});

for (const type of ["text", "interpret"] as const) {
  for (const outcome of ["success", "error"] as const) {
    test(`${type} 仅消息 ${outcome} 同回合 ID 并发请求最多原子提交一次`, async () => {
      const { deps } = setup(outcome);
      const initial = await createSession({ entryMode: "new", text: "你好" }, deps);
      const runAgent = deps.runAgent;
      const bothStarted = deferred();
      const release = deferred();
      let started = 0;
      deps.runAgent = async (...args) => {
        if (++started === 2) bothStarted.resolve();
        await release.promise;
        return runAgent(...args);
      };
      const base = deps.store;
      let commits = 0;
      deps.store = { ...base, commit: async (write) => { await base.commit(write); commits++; } };
      const body = { type, ...(type === "text" ? { text: "继续讨论" } : {}), clientTurnId: TURN_ID, expectedSeq: initial.latest.seq };
      const first = runTurn(initial.session.id, body, deps);
      const retry = runTurn(initial.session.id, body, deps);
      await bothStarted.promise;
      release.resolve();
      const [one, two] = await Promise.all([first, retry]);
      assert.equal(commits, 1, "消息主键冲突必须回滚整次原子提交");
      assert.deepEqual(one, two);
      assert.equal(one.latest.seq, 1);
      assert.equal(one.messages.filter((message) => message.content.kind === "user_text").length, type === "text" ? 2 : 1);
      assert.equal(one.messages.filter((message) => message.content.kind === (outcome === "success" ? "agent_text" : "agent_error")).length, 1);
    });
  }
}

test("会生成新版本的同 ID 并发请求也只提交一次并读取胜者", async () => {
  const { deps } = setup();
  const initial = await createSession({ entryMode: "new", text: "你好" }, deps);
  const bothStarted = deferred();
  const release = deferred();
  let started = 0;
  deps.runAgent = async (request) => {
    if (++started === 2) bothStarted.resolve();
    await release.promise;
    const state = createAgentState(request);
    updateCampaignBrief(state, { writes: [{ key: "theme", quote: request.trigger.text }] });
    return finishAgentTurn(state, "记下了。");
  };
  const base = deps.store;
  let commits = 0;
  deps.store = { ...base, commit: async (write) => { await base.commit(write); commits++; } };
  const body = { type: "text", text: "国庆主题", clientTurnId: TURN_ID, expectedSeq: initial.latest.seq };
  const first = runTurn(initial.session.id, body, deps);
  const retry = runTurn(initial.session.id, body, deps);
  await bothStarted.promise;
  release.resolve();
  const [one, two] = await Promise.all([first, retry]);
  assert.equal(commits, 1);
  assert.deepEqual(one, two);
  assert.equal(one.latest.seq, 2);
  assert.equal(one.messages.filter((message) => message.content.kind === "user_text" && message.content.text === "国庆主题").length, 1);
});

test("停止与仅消息提交竞态中，同 ID 重试不会重复用户原话", { timeout: 2000 }, async () => {
  const { deps } = setup();
  const initial = await createSession({ entryMode: "new", text: "你好" }, deps);
  const base = deps.store;
  const commitStarted = deferred();
  const release = deferred();
  let entered = 0;
  let committed = 0;
  deps.store = {
    ...base,
    commit: async (write) => {
      if (++entered === 1) { commitStarted.resolve(); await release.promise; }
      await base.commit(write);
      committed++;
    },
  };
  const controller = new AbortController();
  const body = { type: "text", text: "继续讨论", clientTurnId: TURN_ID, expectedSeq: 1 };
  const original = runTurn(initial.session.id, body, { ...deps, signal: controller.signal });
  await commitStarted.promise;
  controller.abort();
  const retry = await runTurn(initial.session.id, body, deps);
  release.resolve();
  const first = await original;
  assert.equal(committed, 1);
  assert.deepEqual(first, retry);
  assert.equal(first.messages.filter((message) => message.content.kind === "user_text" && message.content.text === "继续讨论").length, 1);
});

test("回合 ID 必须是标准 UUID，旧调用允许缺省", () => {
  for (const clientTurnId of ["", "x", "a".repeat(200), ` ${TURN_ID}`, "AAAAAAAA-1111-4111-8111-111111111111", null, 123, {}, "11111111-1111-1111-1111-111111111111"]) {
    assert.throws(() => parseTurnInput({ type: "interpret", expectedSeq: 1, clientTurnId }), (error: unknown) => error instanceof TurnError && error.status === 400);
  }
  assert.equal(parseTurnInput({ type: "interpret", expectedSeq: 1 }).type, "interpret");
  assert.equal(parseTurnInput({ type: "interpret", expectedSeq: 1, clientTurnId: TURN_ID }).clientTurnId, TURN_ID);
});

test("内存存储与 D1 一致：message 主键全局唯一且冲突不留半次提交", async () => {
  const { deps } = setup();
  const base = deps.store;
  let captured!: TurnWrite;
  deps.store = { ...base, commit: async (write) => { captured = write; await base.commit(write); } };
  const first = await createSession({ entryMode: "new", text: "你好" }, deps);
  const second: TurnWrite = {
    ...structuredClone(captured),
    session: { ...captured.session, id: "another-session" },
    version: null,
  };
  await assert.rejects(base.commit(second), ConflictError);
  assert.equal(await base.load("another-session"), null);
  const duplicate: TurnWrite = { ...structuredClone(captured), isNew: false, version: null, messages: [{ ...captured.messages[0], id: "within-batch" }, { ...captured.messages[0], id: "within-batch" }] };
  await assert.rejects(base.commit(duplicate), ConflictError);
  assert.equal((await base.load(first.session.id))?.messages.length, 1);
});
