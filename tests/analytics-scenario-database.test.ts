import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_COLUMNS } from "../agent/analytics-database.ts";

const scope = { period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales" as const, filters: { offers: ["标签' OR 1=1 --"] } };

test("情景 SQL 固定参数化逐行舍入与封顶，按单规则先聚合完整复合身份", async () => {
  const adapter = await import("../agent/analytics-operation-database.ts");
  assert.equal(typeof adapter.buildAnalysisScenarioQuery, "function", "数据库尚无完整情景编译器");
  const row = adapter.buildAnalysisScenarioQuery("sales", { scope, adjustment: { kind: "per_gram", amount: "0.005" } }, HISTORY_COLUMNS);
  assert.ok(!row.sql.includes(scope.filters.offers[0])); assert.ok(row.params.includes(scope.filters.offers[0])); assert.ok(row.params.includes("0.005"));
  assert.match(row.sql, /LEAST\(/); assert.match(row.sql, /ROUND\(/); assert.match(row.sql, /SUM\(/); assert.ok(!/LIMIT|JSON_ARRAYAGG|DELETE|UPDATE/i.test(row.sql));
  const order = adapter.buildAnalysisScenarioQuery("sales", { scope, adjustment: { kind: "order_threshold", threshold: "100", amount: "20" } }, HISTORY_COLUMNS, { store: 8, saleNo: 32 });
  assert.match(order.sql, /GROUP BY LEFT\(`实体分店店号`, 8\), LEFT\(`销售单号`, 32\)/); assert.match(order.sql, /scenario_units/); assert.ok(order.params.includes("100"));
  assert.throws(() => adapter.buildAnalysisScenarioQuery("sales; DROP TABLE x", { scope, adjustment: { kind: "per_item", amount: "2" } }, HISTORY_COLUMNS), /表名/);
  assert.throws(() => adapter.buildAnalysisScenarioQuery("sales", { scope, adjustment: { kind: "per_gram", amount: "2" } }, HISTORY_COLUMNS.filter((column) => column !== "销售金重")), /缺少|字段/);
  assert.throws(() => adapter.buildAnalysisScenarioQuery("sales", { scope, adjustment: { kind: "amount_rate", rate: "2" } }, HISTORY_COLUMNS), /比例/);
});

test("数据库情景共享只读快照、保存完整证据、复用缓存并拒绝失效引用", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ctf-scenario-db-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statements: string[] = []; let scenarioReads = 0; let destroyed = 0;
  const adapter = await import("../agent/analytics-operation-database.ts");
  const session = await adapter.createMysqlAnalysisProvider({ host: "private", port: 3306, user: "private", password: "secret", database: "private", table: "sales", evidenceDir: dir }, { connect: async () => ({
    async query(sql) { statements.push(sql); return [sql.startsWith("SHOW COLUMNS") ? HISTORY_COLUMNS.map((Field) => ({ Field })) : [], []]; },
    async execute(sql) {
      statements.push(sql);
      if (sql.includes("min_day")) return [[{ rows_count: 2, unique_rows: 2, min_day: "20250801", max_day: "20250831", currencies: 1, currency: "人民币", missing_currency: 0 }], []];
      if (sql.includes("loss_cents")) { scenarioReads++; return [[{ sample_rows: 2, amount_cents: "10100", loss_cents: "300", units: "11", missing_units: 0, nonpositive_units: 0, eligible_units: 2 }], []]; }
      return [[{ amount: "101", rows_count: 2 }], []];
    }, destroy() { destroyed++; },
  }) }).open();
  assert.ok(session.scenario, "数据库会话未开放情景");
  const query = { scope, adjustment: { kind: "per_gram" as const, amount: "2" } };
  const first = await session.scenario(query); first.lossCents = 999;
  assert.equal((await session.scenario(query)).lossCents, 300); assert.equal(scenarioReads, 1);
  assert.equal(statements.filter((sql) => sql.startsWith("START TRANSACTION")).length, 1);
  const proof = readdirSync(dir).map((file) => readFileSync(join(dir, file), "utf8")).join("");
  assert.match(proof, /loss_cents/); assert.match(proof, /snapshotId/); assert.ok(!proof.includes("secret"));
  await session.close(); await assert.rejects(session.scenario(query), /失效|快照/); assert.equal(destroyed, 1);
});
