import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMysqlAnalyticsDatabase, HISTORY_COLUMNS, type HistoryConnection } from "../agent/analytics-database.ts";
import type { AnalysisAggregateQuery } from "../app/lib/analytics/analysis-v2-types.ts";
import { createMysqlAnalysisProvider } from "../agent/analytics-operation-database.ts";

const query: AnalysisAggregateQuery = { scope: { period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales", filters: {} }, by: ["store"] };
function fixture(t: { after(fn: () => void): void }, columns: string[] = HISTORY_COLUMNS) {
  const dir = mkdtempSync(join(tmpdir(), "ctf-analysis-v2-db-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statements: string[] = []; let connections = 0; let destroyed = 0;
  const connection: HistoryConnection = {
    async query(sql) { statements.push(sql); return [sql.startsWith("SHOW COLUMNS") ? columns.map((Field) => ({ Field })) : [], []]; },
    async execute(sql) { statements.push(sql); return [sql.includes("min_day") ? [{ rows_count: 4, unique_rows: 4, min_day: "20250801", max_day: "20250831", currencies: 1, currency: "人民币", missing_currency: 0 }] : [{ d_store: "A", rows_count: 2, amount: "3.02", quantity: "2", grams: null, profit: null, orders: "1", stores: "1", tag_amount: "4.00" }], []]; },
    destroy() { destroyed++; },
  };
  const config = { host: "private-host", port: 3306, user: "private-user", password: "private-password", database: "private-database", table: "sales", evidenceDir: dir };
  const dependencies = { connect: async () => { connections++; return connection; } };
  return { config, dependencies, connection, statements, dir, connections: () => connections, destroyed: () => destroyed };
}
async function provider() {
  const adapter = await import("../agent/analytics-operation-database.ts").catch(() => null);
  assert.ok(adapter, "一致性分析会话适配器尚未实现"); return adapter;
}

test("v2 五种方法共享一个显式可重复读只读事务与版本", async (t) => {
  const f = fixture(t); const db = createMysqlAnalyticsDatabase(f.config, f.dependencies);
  assert.ok(db.openAnalysisSession, "现有数据库尚未开放 v2 会话");
  const session = await db.openAnalysisSession(); const cells = await session.aggregate(query);
  await session.aggregate({ ...query, by: ["category"] });
  assert.equal(f.connections(), 1); assert.equal(f.statements.filter((sql) => sql.startsWith("START TRANSACTION")).length, 1);
  assert.ok(f.statements.includes("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ"));
  assert.ok(f.statements.includes("SET SESSION TRANSACTION READ ONLY"));
  assert.equal(cells[0].amount, 3.02); assert.equal(cells[0].grams, null); assert.equal(cells[0].dimensions.store, "A");
  assert.ok(session.capabilities.methods.includes("scan")); assert.ok(session.capabilities.metrics.find((v) => v.id === "profit")?.definition.includes("源"));
  const content = readdirSync(f.dir).map((name) => readFileSync(join(f.dir, name), "utf8")).join("");
  assert.ok(content.includes(session.snapshotId)); assert.ok(content.includes("SELECT"));
  assert.ok(!/private-user|private-password|private-host|private-database/.test(content));
  await session.close(); assert.equal(f.destroyed(), 1);
  await assert.rejects(session.aggregate(query), /失效|关闭|快照/);
});

test("受限 SQL 编译器读取全范围、逐行按分、复合订单，取值只进参数", async () => {
  const { buildAnalysisAggregateQuery } = await provider();
  const name = "优惠' OR 1=1 --";
  const result = buildAnalysisAggregateQuery("sales", { ...query, by: ["store", "category", "order"], scope: { ...query.scope, filters: { offers: [name] } }, excludeStores: ["B"], excludeOrders: ["1:A:1"] }, HISTORY_COLUMNS);
  assert.match(result.sql, /^SELECT /); assert.ok(!/LIMIT 20|ORDER BY ABS\(amount\)/.test(result.sql)); assert.ok(!result.sql.includes(name)); assert.ok(result.params.includes(name));
  assert.match(result.sql, /SUM\(ROUND\(`实际销售金额` \* 100, 0\)\) \/ 100/);
  assert.match(result.sql, /COUNT\(DISTINCT `实体分店店号`, `销售单号`\)/);
  assert.ok(result.sql.includes("CHAR_LENGTH")); assert.ok(result.sql.includes("NOT IN"));
  assert.throws(() => buildAnalysisAggregateQuery("sales; DELETE FROM x", query, HISTORY_COLUMNS), /表名/);
  assert.throws(() => buildAnalysisAggregateQuery("sales", { ...query, by: ["secret" as "store"] }, HISTORY_COLUMNS), /维度/);
});

test("数据库真实存在货号时开放同货号控制和参数化筛选，缺字段仍拒绝", async () => {
  const { buildAnalysisAggregateQuery } = await provider();
  const input = { ...query, by: ["sku" as const, "day" as const], metrics: ["amount" as const], scope: { ...query.scope, filters: { skus: ["货号' --"] } } };
  const result = buildAnalysisAggregateQuery("sales", input, [...HISTORY_COLUMNS, "sku号"]);
  assert.match(result.sql, /`sku号`/);
  assert.ok(result.params.includes("货号' --"));
  assert.ok(!result.sql.includes("货号' --"));
  assert.throws(() => buildAnalysisAggregateQuery("sales", input, HISTORY_COLUMNS), /缺少|字段|维度/);
});

test("只查金额的分组不计算未请求的复合订单与门店去重，派生指标展开必要父指标", async () => {
  const { buildAnalysisAggregateQuery } = await provider();
  const simple = buildAnalysisAggregateQuery("sales", { ...query, by: ["cityTier"], metrics: ["amount", "rows"] }, HISTORY_COLUMNS);
  assert.ok(!simple.sql.includes("COUNT(DISTINCT")); assert.ok(!simple.requiredColumns.includes("销售单号")); assert.ok(!simple.requiredColumns.includes("销售牌仔价"));
  assert.match(simple.sql, /NULL AS orders/); assert.match(simple.sql, /SUM\(ROUND\(`实际销售金额` \* 100, 0\)\)/);
  const ratio = buildAnalysisAggregateQuery("sales", { ...query, metrics: ["amount_per_order"] }, HISTORY_COLUMNS);
  assert.ok(ratio.sql.includes("COUNT(DISTINCT `实体分店店号`, `销售单号`)")); assert.ok(ratio.requiredColumns.includes("实际销售金额")); assert.ok(ratio.requiredColumns.includes("销售单号")); assert.ok(!ratio.requiredColumns.includes("销售金重"));
  const gram = buildAnalysisAggregateQuery("sales", { ...query, metrics: ["gap_per_gram"] }, HISTORY_COLUMNS);
  for (const column of ["实际销售金额", "销售牌仔价", "销售金重"]) assert.ok(gram.requiredColumns.includes(column));
});

test("粗粒度身份数组按源行分桶，已按门店分组则不增加桶，不截取明细", async () => {
  const { buildAnalysisAggregateQuery } = await provider();
  const coarse = buildAnalysisAggregateQuery("sales", { ...query, by: ["offer"], metrics: ["amount", "orders"] }, HISTORY_COLUMNS, {}, true);
  assert.match(coarse.sql, /GROUP BY d_offer, MOD\(CRC32\(CAST\(`_import_id` AS CHAR\)\), 128\)/);
  assert.ok(coarse.requiredColumns.includes("_import_id")); assert.ok(!/LIMIT\s+\d+/.test(coarse.sql));
  const store = buildAnalysisAggregateQuery("sales", { ...query, by: ["store", "offer"], metrics: ["amount", "orders"] }, HISTORY_COLUMNS, {}, true);
  assert.ok(!store.sql.includes("CRC32(")); assert.deepEqual(coarse.params, store.params);
});

test("已测全源字段长度时订单去重使用完整短类型并保留输入排序规则，未知长度仍用原字段", async () => {
  const { buildAnalysisAggregateQuery } = await provider();
  const input = { ...query, by: [], metrics: ["orders", "stores"] as AnalysisAggregateQuery["metrics"] };
  const bounded = buildAnalysisAggregateQuery("sales", input, HISTORY_COLUMNS, { store: 5, saleNo: 24 });
  assert.match(bounded.sql, /COUNT\(DISTINCT LEFT\(`实体分店店号`, 5\), LEFT\(`销售单号`, 24\)\)/);
  assert.match(bounded.sql, /COUNT\(DISTINCT LEFT\(`实体分店店号`, 5\)\)/);
  const original = buildAnalysisAggregateQuery("sales", input, HISTORY_COLUMNS);
  assert.ok(original.sql.includes("COUNT(DISTINCT `实体分店店号`, `销售单号`)"));
  assert.throws(() => buildAnalysisAggregateQuery("sales", input, HISTORY_COLUMNS, { saleNo: 0 }), /长度/);
});

test("原生订单分布在数据库聚合完整订单后按最近秩计算，只返回摘要", async (t) => {
  const f = fixture(t); const original = f.connection.execute;
  f.connection.execute = async (sql, params) => {
    if (!sql.includes("ranked_orders")) return original(sql, params);
    f.statements.push(sql);
    assert.ok(params?.includes("特价' OR 1=1")); assert.ok(!sql.includes("特价' OR 1=1"));
    assert.match(sql, /SUM\(ROUND\(`实际销售金额` \* 100, 0\)\)/);
    assert.match(sql, /SUM\(order_count\) OVER/); assert.match(sql, /CEIL\(0\.9 \* total_orders\)/);
    assert.ok(!sql.includes("ORDER BY 1"));
    assert.ok(!/LIMIT\s+\d+/i.test(sql)); assert.ok(!sql.includes("零售毛利"));
    return [[{ sample_rows: 3, excluded_rows: 1, order_count: 2, q_amount_p50: "100", q_amount_p90: "300", q_amount_p99: "300", q_orders_p50: "1", q_orders_p90: "1", q_orders_p99: "1", q_grams_p50: null, q_grams_p90: null, q_grams_p99: null }], []];
  };
  const { createMysqlAnalysisProvider } = await provider(); const session = await createMysqlAnalysisProvider(f.config, f.dependencies).open();
  assert.ok(session.orderDistribution, "数据库尚未开放原生订单分布摘要");
  const input = { scope: { ...query.scope, filters: { offers: ["特价' OR 1=1"] } }, metrics: ["amount", "orders", "grams"] as const };
  const actual = await session.orderDistribution({ ...input, metrics: [...input.metrics] });
  assert.deepEqual(actual, { sampleRows: 3, excludedRows: 1, orderCount: 2, quantiles: { amount: { p50: 100, p90: 300, p99: 300 }, orders: { p50: 1, p90: 1, p99: 1 }, grams: { p50: null, p90: null, p99: null } } });
  await session.orderDistribution({ ...input, metrics: ["grams", "amount", "orders", "amount"] });
  assert.equal(f.statements.filter((sql) => sql.includes("ranked_orders")).length, 1); assert.equal(f.connections(), 1);
  assert.ok(readdirSync(f.dir).map((name) => readFileSync(join(f.dir, name), "utf8")).some((text) => text.includes("ranked_orders") && text.includes(session.snapshotId)));
  await session.close(); await assert.rejects(session.orderDistribution({ ...input, metrics: [...input.metrics] }), /失效|快照/);
});

test("紧凑控制分组的完整订单集合与数据库去重核对，缺标识仍保留 null，身份不一致时回退", async (t) => {
  const f = fixture(t); const original = f.connection.execute; let observed = 2;
  f.connection.execute = async (sql, params) => {
    if (sql.includes("orders_observed")) {
      f.statements.push(sql);
      assert.ok(!sql.includes("CONCAT("), "只核对订单标识是否存在，不应先拼接完整身份再判断非空");
      assert.ok(sql.includes("NULLIF(CAST(`实体分店店号` AS CHAR), '') IS NOT NULL") && sql.includes("NULLIF(CAST(`销售单号` AS CHAR), '') IS NOT NULL"));
      return [[{ orders_observed: observed }], []];
    }
    if (!sql.includes("JSON_ARRAYAGG")) return original(sql, params);
    f.statements.push(sql);
    assert.ok(!sql.includes("d_order")); assert.ok(!/LIMIT\s+\d+/i.test(sql));
    assert.ok(!sql.includes("CRC32("), "已有门店层的较小集合不应再展开分桶");
    return [[{ d_store: "A", rows_count: 2, amount: 3, order_ids: '["1:A:1","1:A:1"]', stores: 1 }, { d_store: "B", rows_count: 2, amount: 5, order_ids: ["1:B:1", null], stores: 1 }], []];
  };
  const { createMysqlAnalysisProvider } = await provider(); const session = await createMysqlAnalysisProvider(f.config, f.dependencies).open();
  assert.ok(session.aggregateWithOrderIds, "数据库尚未开放受核验的订单集合聚合");
  const cells = await session.aggregateWithOrderIds(query); assert.ok(cells);
  assert.equal(cells.length, 2); assert.equal(cells[0].orders, 1); assert.equal(cells[1].orders, null); assert.deepEqual(cells[0].orderIds, ["1:A:1"]);
  const changed = { ...query, scope: { ...query.scope, filters: { stores: ["A"] } } }; observed = 1;
  assert.equal(await session.aggregateWithOrderIds(changed), null, "全量集合与源数据库去重不一致时不得采纳");
  assert.equal(f.connections(), 1); await session.close(); await assert.rejects(session.aggregateWithOrderIds(query), /失效|快照/);
});

test("紧凑订单集合读取挂起时停止会立即销毁快照，迟到集合不进入缓存", async (t) => {
  const f = fixture(t); const { createMysqlAnalysisProvider } = await provider(); const session = await createMysqlAnalysisProvider(f.config, f.dependencies).open();
  assert.ok(session.aggregateWithOrderIds); let entered!: () => void; let finish!: (value: [unknown, unknown]) => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  f.connection.execute = async () => { entered(); return new Promise((resolve) => { finish = resolve; }); };
  const controller = new AbortController(); const pending = session.aggregateWithOrderIds(query, controller.signal); await started; controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError"); assert.equal(f.destroyed(), 1);
  finish([[{ orders_observed: 1 }], []]); await assert.rejects(session.aggregateWithOrderIds(query), /失效|快照/);
  await session.close(); assert.equal(f.destroyed(), 1);
});

test("分组字符串长度来自实际快照，SQL 不使用固定长度截断业务取值", async () => {
  const { buildAnalysisAggregateQuery } = await provider();
  const input: AnalysisAggregateQuery = { ...query, by: ["category", "material", "order"] };
  const plan = buildAnalysisAggregateQuery("sales", input, HISTORY_COLUMNS, { category: 9, material: 10, order: 42 });
  assert.match(plan.sql, /CAST\(`业务小类描述` AS CHAR\(9\)\) AS d_category/);
  assert.match(plan.sql, /CAST\(`材料种类描述` AS CHAR\(10\)\) AS d_material/);
  assert.match(plan.sql, /END AS CHAR\(42\)\) AS d_order/);
  assert.throws(() => buildAnalysisAggregateQuery("sales", input, HISTORY_COLUMNS, { category: 0 }), /长度/);
  assert.throws(() => buildAnalysisAggregateQuery("sales", input, HISTORY_COLUMNS, { category: 70000 }), /长度/);
});

test("TEXT 分组在同一只读快照测量完整长度并复用，不截取长值或更换连接", async (t) => {
  const f = fixture(t); const originalQuery = f.connection.query; const originalExecute = f.connection.execute;
  f.connection.query = async (sql) => {
    const [result, fields] = await originalQuery(sql);
    return [sql.startsWith("SHOW COLUMNS") ? (result as Array<{ Field: string }>).map((row) => ({ ...row, Type: ["业务小类描述", "材料种类描述"].includes(row.Field) ? "text" : "bigint" })) : result, fields];
  };
  f.connection.execute = async (sql, params) => {
    if (sql.includes("MAX(CHAR_LENGTH(")) { f.statements.push(sql); return [[{ w_category: 9, w_material: 70000 }], []]; }
    return originalExecute(sql, params);
  };
  const db = createMysqlAnalyticsDatabase(f.config, f.dependencies); const session = await db.openAnalysisSession!();
  const input: AnalysisAggregateQuery = { ...query, by: ["category", "material"] };
  await session.aggregate(input); await session.aggregate({ ...input, scope: { ...input.scope, population: "net" } });
  assert.equal(f.connections(), 1);
  assert.equal(f.statements.filter((sql) => sql.includes("MAX(CHAR_LENGTH(")).length, 1);
  const aggregateSql = f.statements.filter((sql) => sql.includes("GROUP BY"));
  assert.equal(aggregateSql.length, 2);
  for (const sql of aggregateSql) {
    assert.match(sql, /CAST\(`业务小类描述` AS CHAR\(9\)\) AS d_category/);
    assert.match(sql, /CAST\(`材料种类描述` AS CHAR\) AS d_material/);
    assert.ok(!sql.includes("CHAR(70000)"));
  }
  assert.ok(readdirSync(f.dir).map((name) => readFileSync(join(f.dir, name), "utf8")).some((text) => text.includes("w_category")));
  await session.close();
});

test("能力按真实投影字段产生，字段缺失不猜成本或会员身份", async (t) => {
  const f = fixture(t, HISTORY_COLUMNS.filter((v) => !["销售单号", "销售金重", "零售毛利", "材料种类描述"].includes(v)));
  const { createMysqlAnalysisProvider } = await provider(); const session = await createMysqlAnalysisProvider(f.config, f.dependencies).open();
  assert.ok(!session.capabilities.metrics.some((v) => ["orders", "profit", "grams", "amount_per_gram"].includes(v.id)));
  assert.ok(!session.capabilities.dimensions.includes("material")); assert.ok(!session.capabilities.dimensions.includes("memberSegment"));
  await assert.rejects(session.aggregate({ ...query, by: ["material"] }), /字段|能力|维度/);
  await session.close();
});

test("同连接并发工具排队执行，重复规范化查询不增加 SQL", async (t) => {
  const f = fixture(t); const { createMysqlAnalysisProvider } = await provider(); const session = await createMysqlAnalysisProvider(f.config, f.dependencies).open();
  const original = f.connection.execute; let first: (() => void) | undefined; let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { startedResolve = resolve; }); let reads = 0;
  f.connection.execute = async (...args) => { reads++; if (reads === 1) { startedResolve!(); await new Promise<void>((resolve) => { first = resolve; }); } return original(...args); };
  const a = session.aggregate(query); await started; const b = session.aggregate({ ...query, by: ["category"] });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(reads, 1); first!(); await Promise.all([a, b]); assert.equal(reads, 2);
  await session.aggregate({ ...query, by: ["store", "store"] }); assert.equal(reads, 2);
  await session.close();
});

test("停止挂起查询立即销毁整个快照，迟到结果不得复用", async (t) => {
  const f = fixture(t); const { createMysqlAnalysisProvider } = await provider(); const session = await createMysqlAnalysisProvider(f.config, f.dependencies).open();
  let entered!: () => void; let finish!: (value: [unknown, unknown]) => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  f.connection.execute = async () => { entered(); return new Promise((resolve) => { finish = resolve; }); };
  const controller = new AbortController(); const pending = session.aggregate(query, controller.signal); await started; controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError"); assert.equal(f.destroyed(), 1);
  finish([[{ amount: 999 }], []]); await assert.rejects(session.aggregate(query), /失效|快照/);
  assert.throws(() => session.assertActive?.(), /失效|快照/); await session.close(); assert.equal(f.destroyed(), 1);
});

test("数据库资源截止使快照失效，不自动换连接或混入新值", async (t) => {
  const f = fixture(t); const { createMysqlAnalysisProvider } = await provider(); let deadline = 20000;
  const session = await createMysqlAnalysisProvider(f.config, { ...f.dependencies, get queryTimeoutMs() { return deadline; } }).open();
  deadline = 15;
  f.connection.execute = async () => new Promise(() => {});
  await assert.rejects(session.aggregate(query), /超时|截止/); assert.equal(f.destroyed(), 1);
  await assert.rejects(session.aggregate({ ...query, by: ["category"] }), /失效|快照/); assert.equal(f.connections(), 1);
});

test("数据库读取和证据准备分别截止，合法阶段不因累计时长误作查询超时", async (t) => {
  const f = fixture(t); const { createMysqlAnalysisProvider } = await provider();
  let deadline = 20000; let delayed = false;
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 70));
  const session = await createMysqlAnalysisProvider(f.config, { ...f.dependencies, get queryTimeoutMs() { return deadline; }, async pruneSource() { if (delayed) await pause(); return "`sales`"; } }).open();
  const original = f.connection.execute;
  f.connection.execute = async (sql, params) => { await pause(); return original(sql, params); };
  deadline = 100; delayed = true;
  const cells = await session.aggregate(query);
  assert.equal(cells[0].amount, 3.02);
  assert.equal(f.destroyed(), 0);
  assert.equal(f.connections(), 1);
  session.assertActive?.(); await session.close();
});

test("每个新快照重新验证币种和源行唯一性，混合币种拒绝计算", async (t) => {
  const f = fixture(t); const { createMysqlAnalysisProvider } = await provider();
  f.connection.execute = async () => [[{ rows_count: 4, unique_rows: 4, min_day: "20250801", max_day: "20250831", currencies: 2, currency: "人民币", missing_currency: 0 }], []];
  await assert.rejects(createMysqlAnalysisProvider(f.config, f.dependencies).open(), /币种/); assert.equal(f.destroyed(), 1);
});

test("驱动与凭据错误保持失败但对模型不泄露敏感内容", async (t) => {
  const f = fixture(t); const { createMysqlAnalysisProvider } = await provider();
  f.connection.execute = async () => { throw new Error("private-user private-password private-database"); };
  await assert.rejects(createMysqlAnalysisProvider(f.config, f.dependencies).open(), (error: unknown) => error instanceof Error && !error.message.includes("private-"));
});

test("v2的私有目录检查不改变旧v1只读入口的配置行为", async (t) => {
  const f = fixture(t); const db = createMysqlAnalyticsDatabase({ ...f.config, evidenceDir: "legacy-evidence" }, f.dependencies);
  assert.equal((await db.inspect()).available, true);
  assert.ok(db.openAnalysisSession); await assert.rejects(db.openAnalysisSession(), /配置|目录/);
});

test("主动关闭立即结束挂起的数据库读取，而不是等待资源截止", async (t) => {
  const f = fixture(t); const { createMysqlAnalysisProvider } = await provider(); const session = await createMysqlAnalysisProvider(f.config, f.dependencies).open();
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  f.connection.execute = async () => { entered(); return new Promise(() => {}); };
  const pending = session.aggregate(query); await started; await session.close();
  const outcome = await Promise.race([pending.then(() => "resolved", (error: unknown) => error), new Promise((resolve) => setTimeout(() => resolve("still_waiting"), 30))]);
  assert.ok(outcome instanceof Error && "code" in outcome && outcome.code === "ANALYSIS_SESSION_EXPIRED");
  void pending.catch(() => undefined);
});

test("连接函数同步失败也不会泄露私有凭据", async (t) => {
  const f = fixture(t); const { createMysqlAnalysisProvider } = await provider();
  await assert.rejects(createMysqlAnalysisProvider(f.config, { connect: () => { throw new Error("private-user private-password"); } }).open(), (error: unknown) => error instanceof Error && !error.message.includes("private-"));
});

test("维度取值只扫一遍源表，按数据版本落盘，换进程直接读盘", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ctf-dimension-values-"));
  const statements: string[] = [];
  const columns = ["_import_id", "交易日期wid", "实际销售金额", "销售件数", "币种描述", "实体分店店号", "销售单号", "大区描述", "优惠小类"];
  const connection: HistoryConnection = {
    async query(sql) { statements.push(sql); return [sql.startsWith("SHOW COLUMNS") ? columns.map((Field) => ({ Field, Type: "varchar(64)" })) : [], []]; },
    async execute(sql) {
      statements.push(sql);
      if (sql.includes("min_day")) return [[{ rows_count: 4, unique_rows: 4, min_day: "20250801", max_day: "20250831", currencies: 1, currency: "人民币", missing_currency: 0 }], []];
      if (sql.includes("dimension_values")) return [[{ d: "region", v: "北区" }, { d: "region", v: "东区" }, { d: "offer", v: "一般開單" }], []];
      return [[], []];
    },
    destroy() {},
  };
  const config = { host: "h", port: 3306, user: "u", password: "p", database: "db", table: "sales", evidenceDir: dir };
  const open = async () => { const session = await createMysqlAnalysisProvider(config, { connect: async () => connection }).open(); const catalog = session.capabilities.dimensionCatalog ?? []; await session.close(); return catalog; };
  try {
    const first = await open();
    const sql = statements.find((s) => s.includes("dimension_values"))!;
    assert.match(sql, /^WITH combos AS \(SELECT .* FROM `sales` GROUP BY c0/);
    assert.equal(sql.split("FROM `sales`").length - 1, 1, "源表只扫一遍");
    assert.deepEqual(first.find((d) => d.id === "region")?.values, ["东区", "北区"]);
    // 模拟重启：清掉进程内缓存后再开，不再发取值查询。
    const { clearDimensionValueCacheForTest } = await import("../agent/analytics-operation-database.ts");
    clearDimensionValueCacheForTest();
    statements.length = 0;
    const second = await open();
    assert.equal(statements.filter((s) => s.includes("dimension_values")).length, 0);
    assert.deepEqual(second.find((d) => d.id === "offer")?.values, ["一般開單"]);
  } finally { await rm(dir, { recursive: true, force: true }); await rm(`${dir}-dimension-values`, { recursive: true, force: true }); }
});
