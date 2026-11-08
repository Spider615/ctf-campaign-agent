import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInsightGraphService, insightParams, insightQueries, InsightRangeError, toDriverData } from "../agent/insight-graph.ts";
import { createAgentHttpHandler } from "../agent/http-handler.ts";
import { createServer } from "node:http";
import type { HistoryConnection } from "../agent/analytics-database.ts";
import { fakeResults, fakeResultsIn } from "./helpers/insight-fixture.ts";

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

function fakeConnection(onCube: (sql: string, params: string[]) => void): HistoryConnection {
  const plain = insightQueries("t"); const ranged = insightQueries("t", true);
  const nameOf = new Map<string, string>([...Object.entries(plain), ...Object.entries(ranged)].map(([name, sql]) => [sql, name]));
  return {
    async query() { return [[], []]; },
    async execute(sql: string, params: string[] = []) {
      if (sql.includes("AS min_day")) return [[{ n: 10, min_day: "20250801", max_day: "20250831" }], []];
      onCube(sql, params);
      const name = nameOf.get(sql) as keyof ReturnType<typeof fakeResults> | undefined;
      const results = params.length ? fakeResultsIn({ from: params[0], to: params[1] }) : fakeResults();
      return [name ? results[name] : [], []];
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

test("带范围的查询：除逐日外都加日期条件，日期只走参数", () => {
  const q = insightQueries("t", true);
  for (const name of ["scope", "panel", "stores", "ptype", "gold", "threshold"] as const) assert.equal(q[name].split("BETWEEN ? AND ?").length - 1, 1, name);
  assert.equal(q.tradein.split("BETWEEN ? AND ?").length - 1, 2);
  assert.doesNotMatch(q.daily, /BETWEEN/);
  assert.doesNotMatch(Object.values(q).join("\n"), /2025\d{4}/);
  const r = { from: "20250823", to: "20250829" };
  assert.deepEqual(insightParams("panel", r), ["20250823", "20250829"]);
  assert.deepEqual(insightParams("tradein", r), ["20250823", "20250829", "20250823", "20250829"]);
  assert.deepEqual(insightParams("daily", r), []);
  assert.deepEqual(insightParams("panel", null), []);
  assert.equal(insightQueries("t").panel.includes("BETWEEN"), false, "不带范围时 SQL 和原来一样");
});

test("按范围缓存：不同范围分开算，同范围并发只算一次；整段数据范围就是全月", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "insight-cache-"));
  const seen: string[][] = [];
  const service = createInsightGraphService({ table: "t", evidenceDir: join(cacheDir, "evidence"), cacheDir, connect: async () => fakeConnection((_, p) => seen.push(p)), logger: { log() {}, error() {} } });
  try {
    const qixi = { from: "20250823", to: "20250829" };
    const [a, b] = await Promise.all([service.graph(qixi), service.graph(qixi)]);
    assert.equal(a, b);
    assert.deepEqual(a.scope.range, qixi);
    const full = await service.graph(null);
    assert.equal(full.scope.range, null);
    assert.equal(await service.graph({ from: "20250801", to: "20250831" }), full);
    assert.ok(seen.some((p) => p[0] === "20250823"));
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test("不同范围排队计算：同一时间只跑一个，全部都能算完", async () => {
  // 门店日面板每个 build 发一次；在它的 execute 里停一会儿，看同时有几个 build 在跑。
  const panels = new Set([insightQueries("t").panel, insightQueries("t", true).panel]);
  let inFlight = 0; let max = 0;
  const base = fakeConnection(() => {});
  const connection: HistoryConnection = { ...base, async execute(sql: string, params: string[] = []) {
    if (!panels.has(sql)) return base.execute(sql, params);
    inFlight++; max = Math.max(max, inFlight);
    try { await new Promise((r) => setTimeout(r, 20)); return await base.execute(sql, params); } finally { inFlight--; }
  } } as HistoryConnection;
  const service = createInsightGraphService({ table: "t", evidenceDir: join(tmpdir(), "insight-evidence-unused"), connect: async () => connection, logger: { log() {}, error() {} } });
  const ranges = [{ from: "20250801", to: "20250810" }, { from: "20250811", to: "20250820" }, { from: "20250821", to: "20250831" }];
  const graphs = await Promise.all(ranges.map((r) => service.graph(r)));
  assert.deepEqual(graphs.map((g) => g.scope.range), ranges);
  assert.equal(max, 1);
});

test("内存缓存最多 8 份，最久没用的先淘汰；全月图不淘汰", async () => {
  // 不给 cacheDir：没有磁盘缓存，被淘汰的范围再要时会重新发查询。
  let queries = 0;
  const service = createInsightGraphService({ table: "t", evidenceDir: join(tmpdir(), "insight-evidence-unused"), connect: async () => fakeConnection(() => queries++), logger: { log() {}, error() {} } });
  const full = await service.graph(null);
  const ranges = Array.from({ length: 9 }, (_, i) => ({ from: `202508${String(i + 1).padStart(2, "0")}`, to: `202508${String(i + 5).padStart(2, "0")}` }));
  const first = await service.graph(ranges[0]);
  for (const r of ranges.slice(1)) await service.graph(r);
  const before = queries;
  assert.equal(await service.graph(null), full, "全月图一直在缓存里");
  assert.equal(queries, before);
  assert.notEqual(await service.graph(ranges[0]), first, "最早的范围被淘汰，重新计算");
  assert.ok(queries > before);
});

test("范围不合法：越界、太短抛 InsightRangeError", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "insight-cache-"));
  const service = createInsightGraphService({ table: "t", evidenceDir: join(cacheDir, "evidence"), cacheDir, connect: async () => fakeConnection(() => {}), logger: { log() {}, error() {} } });
  try {
    await assert.rejects(service.graph({ from: "20250830", to: "20250831" }), (e) => e instanceof InsightRangeError && /至少选 3 天/.test(e.message));
    await assert.rejects(service.graph({ from: "20250720", to: "20250803" }), (e) => e instanceof InsightRangeError && /超出数据范围/.test(e.message));
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test("全月基准面板按版本只载一次，范围与全月排队并发不超过三条查询", async () => {
  const panelSql = insightQueries("t").panel;
  const base = fakeConnection(() => {}); let panels = 0; let active = 0; let maximum = 0;
  const connection: HistoryConnection = { ...base, async execute(sql: string, params: string[] = []) {
    active++; maximum = Math.max(maximum, active); if (sql === panelSql) panels++;
    try { await new Promise((r) => setTimeout(r, 2)); return await base.execute(sql, params); } finally { active--; }
  } };
  const service = createInsightGraphService({ table: "t", evidenceDir: join(tmpdir(), "insight-evidence-unused"), concurrency: 99, connect: async () => connection, logger: { log() {}, error() {} } });
  const range = { from: "20250823", to: "20250829" };
  const [a, b, full] = await Promise.all([service.graph(range), service.graph(range), service.graph(null)]);
  assert.equal(a, b); assert.ok(a.comparison); assert.equal(full.comparison, undefined);
  assert.equal(panels, 1, "范围首次加载的基准被全月与其他范围复用");
  await service.graph({ from: "20250824", to: "20250830" }); assert.equal(panels, 1);
  assert.ok(maximum <= 3, `最多同时 ${maximum} 条查询`);
});

test("范围基准读取失败只移除失败缓存，重试可成功且不会自锁", async () => {
  const base = fakeConnection(() => {}); const panelSql = insightQueries("t").panel; let attempts = 0;
  const connection: HistoryConnection = { ...base, async execute(sql: string, params: string[] = []) {
    if (sql === panelSql && ++attempts === 1) throw new Error("基准暂不可读");
    return base.execute(sql, params);
  } };
  const service = createInsightGraphService({ table: "t", evidenceDir: join(tmpdir(), "insight-evidence-unused"), connect: async () => connection, logger: { log() {}, error() {} } });
  const range = { from: "20250823", to: "20250829" };
  await assert.rejects(service.graph(range), /基准暂不可读/);
  const graph = await service.graph(range); assert.equal(graph.comparison!.status, "available");
  assert.equal(await service.graph(range), graph); assert.equal(attempts, 2);
});

test("某条范围查询失败后等待其余查询收尾，再启动下一范围", async () => {
  const base = fakeConnection(() => {}); const panelSql = insightQueries("t", true).panel;
  let active = 0; let maximum = 0; let failed = false;
  const connection: HistoryConnection = { ...base, async execute(sql: string, params: string[] = []) {
    active++; maximum = Math.max(maximum, active);
    try {
      if (sql === panelSql && !failed) { failed = true; throw new Error("范围查询失败"); }
      await new Promise((r) => setTimeout(r, 2)); return await base.execute(sql, params);
    } finally { active--; }
  } };
  const service = createInsightGraphService({ table: "t", evidenceDir: join(tmpdir(), "insight-evidence-unused"), connect: async () => connection, logger: { log() {}, error() {} } });
  const results = await Promise.allSettled([service.graph({ from: "20250823", to: "20250829" }), service.graph({ from: "20250824", to: "20250830" })]);
  assert.equal(results[0].status, "rejected"); assert.equal(results[1].status, "fulfilled");
  assert.ok(maximum <= 3, `失败请求尚未收尾就启动下一个，最多 ${maximum} 条查询`);
});

test("HTTP：/insight/graph 透传范围，参数错误返回 400 和中文原因", async (t) => {
  const calls: unknown[] = [];
  const insight = { warm: async () => {}, graph: async (range?: unknown) => {
    calls.push(range ?? null);
    if (range && (range as { from: string }).from === "20250830") throw new InsightRangeError("范围太短，至少选 3 天");
    return { ok: true } as never;
  } };
  const server = createServer(createAgentHttpHandler({ runAgentTurn: (async () => { throw new Error("不该调用"); }) as never, token: "", model: "test", insight, logger: { log() {}, error() {} } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/insight/graph`)).status, 200);
  assert.equal((await fetch(`${base}/insight/graph?from=20250823&to=20250829`)).status, 200);
  assert.deepEqual(calls, [null, { from: "20250823", to: "20250829" }]);
  const bad = await fetch(`${base}/insight/graph?from=20250823`);
  assert.equal(bad.status, 400); assert.match(((await bad.json()) as { error: string }).error, /起止日期要一起给/);
  const short = await fetch(`${base}/insight/graph?from=20250830&to=20250831`);
  assert.equal(short.status, 400); assert.match(((await short.json()) as { error: string }).error, /至少选 3 天/);
});
