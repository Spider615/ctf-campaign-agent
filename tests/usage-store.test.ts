import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createUsageStore, type ModelRequestFinish, type TurnStart, type UsageStore } from "../agent/usage/store.ts";

const DAY = { from: "2026-10-01", to: "2026-10-31" };
const at = (iso: string) => Date.parse(iso);

function withStore(run: (store: UsageStore, path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "usage-store-"));
  const path = join(dir, "usage.sqlite");
  const store = createUsageStore(path);
  try { run(store, path); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

const turn = (id: string, extra: Partial<TurnStart> = {}): TurnStart => ({ id, entry: "analysis", channel: "deepseek", visitor: "abc123def456", conversationId: "c1", internal: false, question: "八月销售额多少", startedAt: at("2026-10-20T02:00:00Z"), ...extra });
const done: ModelRequestFinish = { status: "done", httpStatus: 200, responseId: "msg", upstreamModel: "deepseek-flash", inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, finishedAt: at("2026-10-20T02:00:05Z") };

function request(store: UsageStore, id: string, turnId: string, tokens: Partial<ModelRequestFinish>, channel: "deepseek" | "juzi" = "deepseek") {
  store.startRequest({ id, turnId, source: "analysis", channel, sdkModel: "claude-sonnet-4-6", sentModel: "deepseek-flash", vendor: channel === "deepseek" ? "DeepSeek" : "anthropic", vendorBasis: "官方兼容接口", startedAt: at("2026-10-20T02:00:01Z") });
  store.finishRequest(id, { ...done, ...tokens });
}

test("一轮两次请求的 Token 按渠道按天汇总", () => withStore((store) => {
  store.startTurn(turn("t1"));
  request(store, "r1", "t1", { inputTokens: 100, outputTokens: 10 });
  request(store, "r2", "t1", { inputTokens: 200, outputTokens: 20 });
  store.finishTurn("t1", { status: "answered", reply: "约 1 亿", error: null, trace: [], finishedAt: at("2026-10-20T02:00:09Z") });
  store.startTurn(turn("t2", { channel: "juzi", conversationId: "c2" }));
  request(store, "r3", "t2", { inputTokens: 50, outputTokens: 5 }, "juzi");
  const { days, statuses } = store.overview(DAY);
  assert.deepEqual(days.map((row) => [row.day, row.channel, row.turns, row.requests, row.inputTokens, row.outputTokens]), [
    ["2026-10-20", "deepseek", 1, 2, 300, 30],
    ["2026-10-20", "juzi", 1, 1, 50, 5],
  ]);
  assert.equal(statuses.answered, 1);
  assert.equal(statuses.running, 1);
}));

test("上游没给的子项汇总为 null 而不是 0", () => withStore((store) => {
  store.startTurn(turn("t1", { channel: "juzi" }));
  request(store, "r1", "t1", { cacheWriteTokens: null }, "juzi");
  assert.equal(store.overview(DAY).days[0].cacheWriteTokens, null);
  request(store, "r2", "t1", { cacheWriteTokens: 5 }, "juzi");
  const row = store.overview(DAY).days[0];
  assert.equal(row.cacheWriteTokens, 5);
  assert.equal(row.incompleteRequests, 0);
}));

test("北京时间切天", () => withStore((store) => {
  store.startTurn(turn("t1", { startedAt: at("2026-10-25T16:30:00Z") }));
  assert.equal(store.overview(DAY).days[0].day, "2026-10-26");
  assert.equal(store.overview({ from: "2026-10-25", to: "2026-10-25" }).days.length, 0);
}));

test("重开库时未收尾的记录标为中断", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-store-"));
  const path = join(dir, "usage.sqlite");
  try {
    const first = createUsageStore(path);
    first.startTurn(turn("t1"));
    first.startRequest({ id: "r1", turnId: "t1", source: "analysis", channel: "deepseek", sdkModel: "claude-sonnet-4-6", sentModel: "deepseek-flash", vendor: "DeepSeek", vendorBasis: "官方兼容接口", startedAt: at("2026-10-20T02:00:01Z") });
    first.close();
    const second = createUsageStore(path);
    const detail = second.conversation("analysis:c1");
    second.close();
    assert.equal(detail?.turns[0].status, "interrupted");
    assert.equal(detail?.turns[0].requests[0].status, "interrupted");
    assert.equal(detail?.turns[0].requests[0].inputTokens ?? null, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("关键词和渠道筛选", () => withStore((store) => {
  store.startTurn(turn("t1", { question: "金色星期二效果怎样" }));
  store.startTurn(turn("t2", { conversationId: "c2", channel: "juzi", question: "八月毛利" }));
  assert.deepEqual(store.conversations({ ...DAY, keyword: "星期二" }).map((row) => row.key), ["analysis:c1"]);
  assert.deepEqual(store.conversations({ ...DAY, channel: "juzi" }).map((row) => row.key), ["analysis:c2"]);
  assert.deepEqual(store.overview({ ...DAY, channel: "juzi" }).days.map((row) => row.channel), ["juzi"]);
}));

test("同一会话两轮合成一行，洞察问答每次单独一行", () => withStore((store) => {
  store.startTurn(turn("t1"));
  store.startTurn(turn("t2", { question: "那九月呢", startedAt: at("2026-10-20T03:00:00Z") }));
  store.startTurn(turn("t3", { entry: "insight", conversationId: null }));
  const rows = store.conversations(DAY);
  const analysis = rows.find((row) => row.key === "analysis:c1");
  assert.equal(analysis?.turns, 2);
  assert.equal(analysis?.title, "八月销售额多少");
  assert.equal(analysis?.lastQuestion, "那九月呢");
  assert.ok(rows.some((row) => row.key === "insight:turn:t3"));
  assert.equal(store.conversation("insight:turn:t3")?.turns.length, 1);
}));

test("内部流量默认不计入", () => withStore((store) => {
  store.startTurn(turn("t1", { internal: true }));
  assert.equal(store.overview(DAY).days.length, 0);
  assert.equal(store.conversations(DAY).length, 0);
  assert.equal(store.overview({ ...DAY, includeInternal: true }).days.length, 1);
  assert.equal(store.conversations({ ...DAY, includeInternal: true })[0].internal, true);
}));

test("轮次收尾保存公开回复和轨迹，详情按时间排序", () => withStore((store, path) => {
  store.startTurn(turn("t2", { startedAt: at("2026-10-20T03:00:00Z") }));
  store.startTurn(turn("t1"));
  store.countSdkStart("t1"); store.countSdkStart("t1");
  store.finishTurn("t1", { status: "failed", reply: null, error: "这次没有得到回答，可以重试", trace: [{ title: "查数据", status: "failed", startedAt: 1, durationMs: 3 }], finishedAt: at("2026-10-20T02:00:09Z") });
  const detail = store.conversation("analysis:c1");
  assert.deepEqual(detail?.turns.map((item) => item.id), ["t1", "t2"]);
  assert.equal(detail?.turns[0].sdkStarts, 2);
  assert.equal(detail?.turns[0].error, "这次没有得到回答，可以重试");
  assert.equal(detail?.turns[0].trace?.[0].title, "查数据");
  assert.equal(store.conversation("analysis:none"), null);
  assert.ok(readFileSync(path).length > 0);
}));
