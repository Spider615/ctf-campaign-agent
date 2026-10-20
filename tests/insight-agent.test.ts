import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInsightGraphService, insightQueries, toDriverData } from "../agent/insight-graph.ts";
import type { HistoryConnection } from "../agent/analytics-database.ts";
import { fakeResults } from "./helpers/insight-fixture.ts";

test("只发 SELECT / WITH，表名白名单，克减兼容繁体", () => {
  const q = insightQueries("sales_detail_202508");
  for (const [name, sql] of Object.entries(q)) assert.match(sql.trim(), /^(SELECT|WITH)\b/, name);
  assert.match(q.panel, /克\[减減\]/);
  assert.match(q.panel, /MAX_EXECUTION_TIME/);
  assert.throws(() => insightQueries("x; drop"), /表名/);
});

test("查询结果换成领域数据：缺值记 0，不认识的优惠组归为其他", () => {
  const data = toDriverData({ ...fakeResults(), tradein: [{ g: "weird", orders: "3", trade_in: null, sales: "10", recycle: null }] }, "v1");
  assert.equal(data.period, "2025 年 8 月");
  assert.deepEqual(data.tradein, [{ group: "other", orders: 3, tradeIn: 0, sales: 10, recycle: 0 }]);
  assert.equal(data.panel[0].sales > 0, true);
});

function fakeConnection(onCube: () => void): HistoryConnection {
  const results = fakeResults(); const queries = insightQueries("t");
  const byText = new Map(Object.entries(queries).map(([name, sql]) => [sql, results[name as keyof typeof results]]));
  return {
    async query() { return [[], []]; },
    async execute(sql: string) {
      if (sql.includes("COUNT(*) AS n, MAX")) return [[{ n: 10, max_day: "20250831" }], []];
      onCube(); return [byText.get(sql) ?? [], []];
    },
    destroy() {},
  };
}

test("同一服务只算一次；查询结果落盘，换一个实例（重启）直接读盘", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "insight-cache-"));
  let ran = 0;
  const make = () => createInsightGraphService({ table: "t", evidenceDir: join(cacheDir, "evidence"), cacheDir, connect: async () => fakeConnection(() => ran++), logger: { log() {}, error() {} } });
  try {
    const service = make();
    const [a, b] = await Promise.all([service.graph(), service.graph()]);
    assert.equal(a, b);
    const first = ran; assert.ok(first > 0);
    const again = await make().graph();
    assert.equal(ran, first);
    assert.deepEqual(again.edges, a.edges);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});
