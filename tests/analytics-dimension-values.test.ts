import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMysqlAnalysisProvider } from "../agent/analytics-operation-database.ts";
import type { HistoryConnection } from "../agent/analytics-database.ts";
import { createSnapshotAnalysisProvider } from "../app/lib/analytics/analysis-v2-snapshot.ts";
import type { AnalysisDataSession, AnalysisDimension, AnalysisScope } from "../app/lib/analytics/analysis-v2-types.ts";
import type { AnalyticsDataset, SalesRow } from "../app/lib/analytics/types.ts";

const period = { start: "2025-08-01", end: "2025-08-31" };
const scope: AnalysisScope = { period, population: "sales", filters: {} };
const sourceRow = (values: Partial<SalesRow> = {}): SalesRow => ({ lineId: randomUUID(), date: "2025-08-01", store: "店001", sku: "货001", category: "金", region: "北区", netSales: 10, quantity: 1, orderId: "1", city: null, memberId: null, memberSegment: null, campaignId: null, cost: null, weightGrams: null, ...values });
const dataset = (rows: SalesRow[], version = "import-revision-1"): AnalyticsDataset => ({ schema: "analytics-dataset/v1", id: "dimension-fixture", version, name: "取值测试快照", provenance: "sample", currency: "CNY", createdAt: "2026-10-25T00:00:00Z", rows, rules: [], sourceFiles: [], mappings: { sales: {}, campaigns: {} }, minDate: period.start, maxDate: period.end, warnings: [] });
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const method = (session: AnalysisDataSession) => { assert.equal(typeof session.dimensionValues, "function", "会话应提供受控 dimensionValues 分页"); return session.dimensionValues!.bind(session); };
const hasCode = (code: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === code;

async function fixture(t: { after(fn: () => Promise<void>): void }, initial = [sourceRow()]) {
  const dir = await mkdtemp(join(tmpdir(), "ctf-dimension-paging-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { host: "private-host", port: 3306, user: "private-user", password: "private-password", database: `db_${randomUUID()}`, table: "sales", evidenceDir: join(dir, "evidence") };
  const statements: Array<{ sql: string; params?: string[] }> = []; let current = initial; let connections = 0; let destroyed = 0;
  let executePage: ((sql: string, params?: string[]) => Promise<[unknown, unknown]>) | undefined;
  const connect = async (): Promise<HistoryConnection> => { connections++; return {
    async query(sql) { statements.push({ sql }); return [sql.startsWith("SHOW COLUMNS") ? ["_import_id", "交易日期wid", "实体分店店号", "sku号", "大区描述", "实际销售金额", "销售件数", "币种描述"].map((Field) => ({ Field, Type: "varchar(128)" })) : [], []]; },
    async execute(sql, params) {
      statements.push({ sql, params });
      if (sql.includes("min_day")) return [[{ rows_count: current.length, unique_rows: current.length, min_day: "20250801", max_day: "20250831", currencies: 1, currency: "人民币", missing_currency: 0 }], []];
      if (/\bAS dimension_value\b/.test(sql)) {
        if (executePage) return executePage(sql, params);
        const field = sql.includes("`sku号`") ? "sku" : sql.includes("`大区描述` AS") ? "region" : "store";
        const selected = current.filter((row) => row.date.replaceAll("-", "") >= params![0] && row.date.replaceAll("-", "") <= params![1] && row.quantity > 0 && row.netSales > 0 && (!sql.includes("`大区描述` IN") || params!.includes(row.region!)) && (!sql.includes("`实体分店店号` IN") || params!.includes(row.store)));
        const after = sql.includes("> CAST(? AS BINARY)") ? params!.at(-1) : undefined;
        const values = [...new Set(selected.map((row) => row[field]).filter((value): value is string => typeof value === "string" && Boolean(value.trim())))].sort(compare).filter((value) => after === undefined || compare(value, after) > 0);
        return [values.slice(0, Number(/LIMIT (\d+)/.exec(sql)?.[1])).map((value) => ({ dimension_value: Buffer.from(value) })), []];
      }
      if (sql.includes("dimension_values")) return [[...new Set(current.map((row) => row.region))].filter(Boolean).map((v) => ({ d: "region", v })), []];
      if (sql.includes("MAX(CHAR_LENGTH(")) return [[{ w_store: 20, w_sku: 20 }], []];
      return [[{ rows_count: current.length, amount: "10", quantity: "1", stores: "1" }], []];
    },
    destroy() { destroyed++; },
  }; };
  return { config, dir, statements, connect, provider: createMysqlAnalysisProvider(config, { connect }), setRows: (rows: SalesRow[]) => { current = rows; }, setPage: (execute: typeof executePage) => { executePage = execute; }, connections: () => connections, destroyed: () => destroyed };
}

async function all(session: AnalysisDataSession, dimension: AnalysisDimension, selected = scope, pageSize = 100) {
  const read = method(session); const values: string[] = []; let cursor: string | undefined;
  do { const page = await read({ dimension, scope: selected, pageSize, ...(cursor ? { cursor } : {}) }); values.push(...page.values); cursor = page.nextCursor; } while (cursor);
  return values;
}

test("MySQL 受控分页读取全部 601+ 门店和 SKU，保留大小写及尾空格差异", async (t) => {
  const stores = [...Array.from({ length: 607 }, (_, i) => `店${String(i).padStart(4, "0")}`), "A", "a", "a "];
  const f = await fixture(t, stores.map((store, i) => sourceRow({ store, sku: `SKU${i}` })));
  const session = await f.provider.open(); t.after(() => session.close());
  assert.deepEqual(await all(session, "store"), [...stores].sort(compare));
  assert.equal((await all(session, "sku", scope, 73)).length, 610);
  assert.equal(f.connections(), 1); assert.equal(f.statements.filter(({ sql }) => sql.startsWith("START TRANSACTION")).length, 1);
  assert.ok(f.statements.some(({ sql }) => sql.includes("TRANSACTION ISOLATION LEVEL REPEATABLE READ")));
  assert.ok(f.statements.filter(({ sql }) => /\bAS dimension_value\b/.test(sql)).every(({ sql }) => /SELECT \/\*\+ MAX_EXECUTION_TIME\(180000\) \*\/ DISTINCT/.test(sql) && /ORDER BY dimension_value/.test(sql) && /LIMIT (?:101|74)$/.test(sql)));
  const evidence = await readdir(f.config.evidenceDir);
  assert.ok((await Promise.all(evidence.map((name) => readFile(join(f.config.evidenceDir, name), "utf8")))).some((text) => text.includes('"dimension": "store"') && text.includes(session.snapshotId)));
});

test("MySQL 分页沿用日期、口径、白名单筛选和参数化 SQL", async (t) => {
  const name = "北区' OR 1=1 --";
  const f = await fixture(t, [sourceRow({ store: "可读店", region: name }), sourceRow({ store: "他区店", region: "南区" }), sourceRow({ store: "其他日期", region: name, date: "2025-08-02" }), sourceRow({ store: "退货", region: name, quantity: -1, netSales: -5 })]);
  const session = await f.provider.open(); t.after(() => session.close()); const read = method(session);
  const selected = { ...scope, period: { start: "2025-08-01", end: "2025-08-01" }, filters: { regions: [name] } };
  assert.deepEqual((await read({ dimension: "store", scope: selected })).values, ["可读店"]);
  const page = f.statements.find(({ sql }) => /\bAS dimension_value\b/.test(sql))!;
  assert.ok(page.params?.includes(name)); assert.ok(!page.sql.includes(name)); assert.ok(page.sql.includes("`销售件数` > 0 AND `实际销售金额` > 0"));
  const count = f.statements.length;
  for (const input of [{ dimension: "password", scope }, { dimension: "store", scope: { ...scope, period: { start: "2024-01-01", end: period.end } } }, { dimension: "store", scope: { ...scope, filters: { secrets: ["x"] } } }, { dimension: "store", scope, pageSize: 101 }, { dimension: "store", scope, pageSize: 0 }, { dimension: "store", scope, pageSize: 1.5 }, { dimension: "store", scope, pageSize: null }, { dimension: "store", scope, sql: "SELECT secret" }]) {
    await assert.rejects(read(input as never), /维度|范围|筛选|分页|参数/);
  }
  assert.equal(f.statements.length, count, "非法请求不能开始 SQL");
});

test("两种数据会话的无效维度分页参数和游标可修正，已关闭会话保留失效错误码", async (t) => {
  const rows = [sourceRow({ store: "A" }), sourceRow({ store: "B" })]; const f = await fixture(t, rows);
  const sessions = [await f.provider.open(), await createSnapshotAnalysisProvider(dataset(rows)).open()];
  t.after(async () => { await Promise.all(sessions.map((session) => session.close())); });
  const firstPages = await Promise.all(sessions.map((session) => method(session)({ dimension: "store", scope, pageSize: 1 })));
  for (const [index, session] of sessions.entries()) {
    const read = method(session); const count = f.statements.length; const cursor = firstPages[index].nextCursor; assert.ok(cursor);
    for (const input of [
      { dimension: "store", scope, cursor: "bad" }, { dimension: "store", scope, cursor: 123 },
      { dimension: "store", scope, cursor: firstPages[1 - index].nextCursor }, { dimension: "sku", scope, cursor },
      { dimension: "store", scope: { ...scope, filters: { stores: ["A"] } }, cursor },
      { dimension: "secret", scope }, { dimension: "store", scope, pageSize: 0 }, { dimension: "store", scope, pageSize: 101 },
      { dimension: "store", scope, pageSize: null }, { dimension: "store", scope, sql: "SELECT secret" },
      { dimension: "store", scope: { ...scope, period: { start: "2024-01-01", end: period.end } } },
      { dimension: "store", scope: { ...scope, period: { start: "日期错误", end: period.end } } },
      { dimension: "store", scope: { ...scope, filters: { secret: ["x"] } } },
      { dimension: "store", scope: { ...scope, filters: { materials: ["金"] } } },
    ]) await assert.rejects(read(input as never), hasCode("ANALYSIS_ARGUMENTS_INVALID"));
    assert.equal(f.statements.length, count, "无效参数在查询执行前被拒绝");
    session.assertActive?.();
    assert.deepEqual((await read({ dimension: "store", scope, cursor, pageSize: 1 })).values, ["B"], "模型修正参数后可继续读取当前快照");
    await session.close(); await assert.rejects(read({ dimension: "store", scope, cursor: "bad" }), hasCode("ANALYSIS_SESSION_EXPIRED"));
  }
});

test("真实 inspect_dataset 坏游标返回可修正警告，数据库失败和快照失效仍为 fatal", async (t) => {
  const [{ Client }, { InMemoryTransport }, { createAnalyticsSkillTools }] = await Promise.all([
    import("../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"),
    import("../agent/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js"),
    import("../agent/analytics-skill-tools.ts"),
  ]);
  const f = await fixture(t); const session = await f.provider.open(); const fatal: Error[] = []; const statuses: string[] = [];
  const tools = createAnalyticsSkillTools({ ensureSession: async () => session, constraints: { filters: {} }, onSubmit: async () => {}, onFatal: (error) => { fatal.push(error); }, onEvent: (event) => { statuses.push(event.status); } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: "维度分页纠错测试", version: "1" });
  t.after(async () => { await client.close(); await session.close(); });
  await tools.server.instance.connect(serverSide); await client.connect(clientSide);
  const bad = await client.callTool({ name: "inspect_dataset", arguments: { dimension: "store", cursor: "bad" } });
  assert.equal("isError" in bad ? bad.isError : undefined, true); assert.equal(fatal.length, 0); assert.equal(statuses.at(-1), "warning");
  const corrected = await client.callTool({ name: "inspect_dataset", arguments: { dimension: "store" } });
  assert.equal("isError" in corrected ? corrected.isError : undefined, undefined);
  const output = JSON.parse((corrected.content as Array<{ text: string }>)[0].text); assert.deepEqual(output.values, ["店001"]);
  assert.equal(fatal.length, 0);

  const failure = Object.assign(new Error("维度分页参数读取失败：真实数据库故障"), { code: "ANALYSIS_DATABASE_ERROR" });
  f.setPage(async () => { throw failure; });
  await client.callTool({ name: "inspect_dataset", arguments: { dimension: "sku" } });
  assert.equal(fatal.length, 1); assert.equal(fatal[0], failure); assert.equal(statuses.at(-1), "failed");
  await client.callTool({ name: "inspect_dataset", arguments: { dimension: "store", cursor: "bad" } });
  assert.equal(fatal.length, 2); assert.ok(hasCode("ANALYSIS_SESSION_EXPIRED")(fatal[1])); assert.equal(statuses.at(-1), "failed");
});

test("游标绑定 MySQL 会话、维度与规范范围，拒绝伪造或跨版本使用", async (t) => {
  const f = await fixture(t, [sourceRow({ store: "A" }), sourceRow({ store: "B" })]); const first = await f.provider.open(); const second = await f.provider.open();
  t.after(async () => { await first.close(); await second.close(); });
  const read = method(first); const page = await read({ dimension: "store", scope, pageSize: 1 }); assert.ok(page.nextCursor);
  assert.deepEqual((await read({ dimension: "store", scope, cursor: page.nextCursor, pageSize: 1 })).values, ["B"]);
  for (const input of [{ dimension: "store", scope, cursor: "伪造游标" }, { dimension: "sku", scope, cursor: page.nextCursor }, { dimension: "store", scope: { ...scope, filters: { stores: ["A"] } }, cursor: page.nextCursor }]) await assert.rejects(read(input as never), /游标|范围|版本/);
  await assert.rejects(method(second)({ dimension: "store", scope, cursor: page.nextCursor }), /游标|范围|版本/);
  await first.close(); await assert.rejects(read({ dimension: "store", scope, cursor: page.nextCursor }), /失效|快照/);
});

test("等行数等日期更新和重建 provider 均重新读取目录，不读写旧磁盘缓存", async (t) => {
  const f = await fixture(t, [sourceRow({ region: "最新北区" })]);
  const key = `${f.config.database}.${f.config.table}:1:${period.start}:${period.end}`;
  const legacyDir = join(f.dir, "evidence-dimension-values"); await mkdir(legacyDir);
  const filename = join(legacyDir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  await writeFile(filename, JSON.stringify({ key, values: { region: ["过期磁盘值"] } }));
  const saved = await readFile(filename, "utf8");
  const first = await f.provider.open(); assert.deepEqual((await method(first)({ dimension: "region", scope })).values, ["最新北区"]); await first.close();
  f.setRows([sourceRow({ region: "最新南区" })]);
  const second = await f.provider.open(); assert.deepEqual((await method(second)({ dimension: "region", scope })).values, ["最新南区"]); await second.close();
  f.setRows([sourceRow({ region: "重建后的东区" })]);
  const third = await createMysqlAnalysisProvider(f.config, { connect: f.connect }).open(); assert.deepEqual((await method(third)({ dimension: "region", scope })).values, ["重建后的东区"]); await third.close();
  assert.equal(await readFile(filename, "utf8"), saved); assert.deepEqual(await readdir(legacyDir), [filename.split("/").at(-1)]);
});

test("打开 MySQL 会话只核对来源，取值目录按需分页而不预读全部分类", async (t) => {
  const f = await fixture(t); const session = await f.provider.open(); t.after(() => session.close());
  assert.ok(session.capabilities.dimensionCatalog?.some((item) => item.id === "region"));
  assert.equal(f.statements.filter(({ sql }) => sql.includes("dimension_values") || /\bAS dimension_value\b/.test(sql)).length, 0, "不应在模型需要取值前扫描全部分类");
  await method(session)({ dimension: "region", scope });
  assert.equal(f.statements.filter(({ sql }) => /\bAS dimension_value\b/.test(sql)).length, 1);
});

test("同会话同页并发仅执行一次，结果隔离；范围改变重新查库", async (t) => {
  const f = await fixture(t); const session = await f.provider.open(); t.after(() => session.close()); const read = method(session);
  let finish!: (result: [unknown, unknown]) => void; let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  f.setPage(async () => { entered(); return new Promise((resolve) => { finish = resolve; }); });
  const first = read({ dimension: "store", scope }); const second = read({ dimension: "store", scope }); await started;
  assert.equal(f.statements.filter(({ sql }) => /\bAS dimension_value\b/.test(sql)).length, 1);
  finish([[{ dimension_value: Buffer.from("A") }], []]); const [a, b] = await Promise.all([first, second]); a.values[0] = "篡改"; assert.deepEqual(b.values, ["A"]);
  assert.deepEqual((await read({ dimension: "store", scope })).values, ["A"]);
  f.setPage(undefined); await read({ dimension: "store", scope: { ...scope, filters: { stores: ["店001"] } } });
  assert.equal(f.statements.filter(({ sql }) => /\bAS dimension_value\b/.test(sql)).length, 2);
});

test("取消执行中与排队取值立即结束，迟到成功不能缓存或复活快照", async (t) => {
  const f = await fixture(t); const session = await f.provider.open(); const read = method(session); const controller = new AbortController();
  let finish!: (result: [unknown, unknown]) => void; let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  f.setPage(async () => { entered(); return new Promise((resolve) => { finish = resolve; }); });
  const first = read({ dimension: "store", scope }); await started;
  const queued = read({ dimension: "sku", scope }, controller.signal); controller.abort();
  await Promise.all([assert.rejects(first, (error: Error) => error.name === "AbortError"), assert.rejects(queued, (error: Error) => error.name === "AbortError")]);
  assert.equal(f.destroyed(), 1); finish([[{ dimension_value: Buffer.from("迟到值") }], []]);
  await assert.rejects(read({ dimension: "store", scope }), /失效|快照/); await session.close();
  assert.equal(f.statements.filter(({ sql }) => /\bAS dimension_value\b/.test(sql)).length, 1);
});

test("失败的取值不缓存，后续新会话可以重读", async (t) => {
  const f = await fixture(t); let attempts = 0;
  f.setPage(async () => { attempts++; throw new Error("private-password private-host"); });
  const first = await f.provider.open(); const read = method(first);
  await assert.rejects(read({ dimension: "store", scope }), (error: Error) => !error.message.includes("private-") && /读取|数据库/.test(error.message));
  await assert.rejects(read({ dimension: "store", scope }), /失效|快照/); await first.close();
  f.setPage(undefined); const second = await f.provider.open(); t.after(() => second.close());
  assert.deepEqual((await method(second)({ dimension: "store", scope })).values, ["店001"]); assert.equal(attempts, 1);
});

test("导入快照完整分页，保留授权范围、实际值与缺失边界", async (t) => {
  const expected = Array.from({ length: 613 }, (_, i) => `店${String(i).padStart(4, "0")}`);
  const rows = expected.map((store, i) => sourceRow({ store, sku: `货${i}`, region: "北区" }));
  rows.push(sourceRow({ store: "越界店", region: "南区" }), sourceRow({ store: "退货店", quantity: -1, netSales: -10 }), sourceRow({ store: "   ", sku: null }));
  const session = await createSnapshotAnalysisProvider(dataset(rows)).open(); t.after(() => session.close());
  assert.deepEqual(await all(session, "store", { ...scope, filters: { regions: ["北区"] } }, 79), expected);
  assert.equal((await all(session, "sku", { ...scope, filters: { regions: ["北区"] } })).length, 613);
  const page = await method(session)({ dimension: "store", scope, pageSize: 1 }); assert.ok(page.nextCursor);
  const other = await createSnapshotAnalysisProvider(dataset(rows, "import-revision-2")).open(); t.after(() => other.close());
  await assert.rejects(method(other)({ dimension: "store", scope, cursor: page.nextCursor }), /游标|范围|版本/);
  await assert.rejects(method(session)({ dimension: "material", scope }), /维度/);
  await assert.rejects(method(session)({ dimension: "store", scope: { ...scope, filters: { materials: ["金"] } } }), /维度|字段/);
});

test("导入快照的日期格式、原对象变更和取消不能改变分页结果", async () => {
  const source = dataset([sourceRow({ store: "A", date: "2025-08-01" }), sourceRow({ store: "B", date: "2025-08-02" })]);
  const provider = createSnapshotAnalysisProvider(source); const controller = new AbortController(); const session = await provider.open(controller.signal); const read = method(session);
  source.rows[0].store = "外部修改";
  assert.deepEqual((await read({ dimension: "day", scope })).values, ["2025-08-01", "2025-08-02"]);
  assert.deepEqual((await read({ dimension: "store", scope })).values, ["A", "B"]);
  controller.abort(); await assert.rejects(read({ dimension: "store", scope }), (error: Error) => error.name === "AbortError"); await session.close();
});
