import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMysqlAnalyticsDatabase, pruneRecoveredSource, HISTORY_COLUMNS, type HistoryConnection } from "../agent/analytics-database.ts";
import { isAdvisorSource } from "../app/lib/analytics/advisor.ts";

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "ctf-mysql-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sql: string[] = []; let destroys = 0;
  const connection: HistoryConnection = {
    async query(statement) { sql.push(statement); return [statement.startsWith("SHOW") ? HISTORY_COLUMNS.map((Field) => ({ Field })) : [], []]; },
    async execute(statement) { sql.push(statement); return [statement.includes("min_day") ? [{ rows_count: 2, unique_rows: 2, min_day: "20250801", max_day: "20250831", currencies: 1, currency: "人民币", missing_currency: 0 }] : [{ label: "模拟优惠", rows_count: 2, stores: 1, orders: 1, amount: "200.30", quantity: 2, grams: null, profit: null, tag_amount: "230.00", group_count: 1 }], []]; },
    destroy() { destroys++; },
  };
  const db = createMysqlAnalyticsDatabase({ host: "127.0.0.1", port: 3306, user: "test-user", password: "test-password", database: "test_db", table: "sales", evidenceDir: dir }, { connect: async () => connection });
  return { db, dir, sql, connection, destroyed: () => destroys };
}
test("每次查询在只读一致性事务执行，关闭连接并保存脱敏证据", async (t) => {
  const f = fixture(t); const sources = await f.db.query({ period: { start: "2025-08-01", end: "2025-08-31" }, by: "offer" });
  assert.ok(f.sql.includes("SET SESSION TRANSACTION READ ONLY")); assert.ok(f.sql.includes("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY"));
  assert.ok(f.destroyed() >= 2); assert.equal(sources.length, 1); assert.ok(isAdvisorSource(sources[0]));
  assert.equal(sources[0].rows[0].fields.find((x) => x.label === "成交金额")?.value, 200.3);
  assert.equal(sources[0].rows[0].fields.find((x) => x.label === "成交金重")?.value, null);
  const content = readdirSync(f.dir).map((name) => readFileSync(join(f.dir, name), "utf8")).join("");
  assert.ok(content.includes("SELECT")); assert.ok(!content.includes("test-password")); assert.ok(!content.includes("test-user"));
});
test("混合或缺失币种不能汇总成一个营销金额", async (t) => {
  for (const missing_currency of [0, 1]) {
    const f = fixture(t); f.connection.execute = async () => [[{ rows_count: 2, unique_rows: 2, min_day: "20250801", max_day: "20250831", currencies: missing_currency ? 1 : 2, currency: "人民币", missing_currency }], []];
    await assert.rejects(f.db.inspect(), /币种/);
  }
});
test("越界日期不查数据，停止会销毁挂起连接", async (t) => {
  const f = fixture(t); await assert.rejects(f.db.query({ period: { start: "2024-08-01", end: "2024-08-31" } }), /覆盖/);
  await f.db.inspect();
  const started = Promise.withResolvers<void>(); f.connection.execute = async () => { started.resolve(); return new Promise(() => {}); };
  const controller = new AbortController(); const pending = f.db.query({ period: { start: "2025-08-01", end: "2025-08-31" } }, controller.signal);
  await started.promise; const before = f.destroyed(); controller.abort(); await assert.rejects(pending, /停止/);
  assert.ok(f.destroyed() > before);
});
test("驱动报错包含中文历史字样也不能暴露账号和库名", async (t) => {
  const f = fixture(t);
  const db = createMysqlAnalyticsDatabase({ host: "127.0.0.1", port: 3306, user: "历史只读用户", password: "private", database: "历史库", table: "sales", evidenceDir: f.dir }, { connect: async () => { throw new Error("Access denied for user '历史只读用户' to database '历史库'"); } });
  await assert.rejects(db.inspect(), (error: unknown) => error instanceof Error && !/历史只读用户|历史库|Access denied/.test(error.message));
});
test("裁剪重建视图只接受两层完整裸字段投影，算式必须保留原视图", async () => {
  const joins = [["dim_branch_scd_recovered", "_branch_snapshot_id"], ["dim_branch_scd_recovered", "_source_branch_snapshot_id"], ["dim_stock_nature_d_recovered", "_stock_snapshot_id"], ["dim_mould_master_d_recovered", "_mould_snapshot_id"], ["dim_item_master_d_recovered", "_item_snapshot_id"], ["dim_calendar_observed", "_calendar_snapshot_id"], ["dim_staff_observed", "_staff_snapshot_id"], ["dim_sku_observed", "_sku_snapshot_id"], ["dim_same_store_observed", "_same_store_snapshot_id"], ["discount_observed", "_discount_snapshot_id"], ["campaign_observed", "_campaign_snapshot_id"]];
  const outer = `CREATE VIEW \`sales_detail_202508\` AS select ${HISTORY_COLUMNS.map((c) => `\`sales_detail_202508_rejoined\`.\`${c}\` AS \`${c}\``).join(",")} from \`sales_detail_202508_rejoined\``;
  const inner = `CREATE VIEW \`sales_detail_202508_rejoined\` AS select ${HISTORY_COLUMNS.map((c) => `\`f\`.\`${c}\` AS \`${c}\``).join(",")} from \`dws_sales_daily_detail_mi_recovered\` \`f\` ${joins.map(([name, alias]) => `left join \`${name}\` \`${alias}\` on (\`${alias}\`.\`_recovered_id\` = \`f\`.\`${alias}\`)`).join(" ")}`;
  for (const kind of ["plain", "outer_formula", "inner_formula", "unneeded_alias", "needed_alias", "table_case"]) {
    const view = kind === "inner_formula" ? inner.replace("`f`.`实际销售金额` AS", "`f`.`实际销售金额` + `f`.`实际销售金额` AS") : kind === "unneeded_alias" ? inner.replace(" from ", ", `_source_branch_snapshot_id`.`分区描述` AS `源分店分区描述` from ") : kind === "needed_alias" ? inner.replace("`f`.`实际销售金额` AS", "`f`.`其他金额` AS") : kind === "table_case" ? inner.replace("`dws_sales_daily_detail_mi_recovered`", "`DWS_SALES_DAILY_DETAIL_MI_RECOVERED`") : inner;
    const connection: HistoryConnection = { async query(sql) { return [sql.startsWith("SHOW INDEX") ? [{ Column_name: "_recovered_id", Non_unique: 0 }] : [{ "Create View": sql.includes("`sales_detail_202508_rejoined`") ? view : (kind === "outer_formula" ? outer.replace("`sales_detail_202508_rejoined`.`实际销售金额` AS", "`sales_detail_202508_rejoined`.`实际销售金额` * 2 AS") : outer) }], []]; }, async execute() { throw new Error("不应查询实际数据"); }, destroy() {} };
    const relation = await pruneRecoveredSource(connection, "sales_detail_202508");
    if (kind === "plain" || kind === "unneeded_alias") {
      assert.ok(relation.includes("history_source")); assert.ok(!relation.includes("dim_staff_observed"));
      const coverage = await pruneRecoveredSource(connection, "sales_detail_202508", ["_import_id", "交易日期wid", "币种描述"]);
      assert.ok(coverage.includes("`币种描述`")); assert.ok(!coverage.includes("`优惠小类`")); assert.ok(!coverage.includes("LEFT JOIN"));
    }
    else assert.equal(relation, "`sales_detail_202508`", kind);
  }
});
test("原始物理明细表没有恢复视图时仍能沿用普通读取", async () => {
  for (const code of ["ER_WRONG_OBJECT", "ER_NO_SUCH_TABLE"]) {
    const connection: HistoryConnection = { async query() { throw Object.assign(new Error("optional metadata unavailable"), { code }); }, async execute() { return [[], []]; }, destroy() {} };
    assert.equal(await pruneRecoveredSource(connection, "sales_detail_202508"), "`sales_detail_202508`");
  }
});
