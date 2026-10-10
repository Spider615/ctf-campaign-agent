import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAnalyticsStore } from "../app/lib/server/analytics-store.ts";
import { createDataset, createReport } from "../app/lib/server/analytics-service.ts";
import { analyticsAccess, readAnalyticsJson } from "../app/lib/server/analytics-access.ts";

function store() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("drizzle").filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(`drizzle/${file}`, "utf8"));
  const db = { prepare(sql: string) {
    let args: Array<string | number | null> = [];
    return { bind(...values: Array<string | number | null>) { args = values; return this; },
      async first() { return sqlite.prepare(sql).get(...args) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...args) }; },
      async run() { sqlite.prepare(sql).run(...args); return { success: true }; },
    };
  } } as unknown as D1Database;
  return { api: createAnalyticsStore(db), sqlite };
}

test("保存和重新打开数据及报告，其他访问标识不能读取", async () => {
  const { api, sqlite } = store();
  try {
    const ds = await createDataset("owner-a", { sample: true }, api);
    assert.equal(ds.provenance, "sample");
    assert.equal((await api.listDatasets("owner-a")).length, 1);
    assert.equal((await api.listDatasets("owner-b")).length, 0);
    assert.equal(await api.loadDataset("owner-b", ds.id), null);
    const report = await createReport("owner-a", { datasetId: ds.id, query: { period: { start: "2026-08-01", end: "2026-09-30" }, comparison: { start: "2025-08-01", end: "2025-09-30" }, filters: {} } }, api);
    assert.equal((await api.loadReport("owner-a", report.id))?.datasetVersion, ds.version);
    assert.equal(await api.loadReport("owner-b", report.id), null);
    await assert.rejects(createReport("owner-b", { datasetId: ds.id, query: report.query }, api), /数据集/);
    const stored = await api.loadDataset("owner-a", ds.id);
    await assert.rejects(api.saveDataset("owner-a", { ...stored!, name: "篡改原版本" }));
    assert.equal((await api.loadDataset("owner-a", ds.id))?.name, ds.name);
    await assert.rejects(api.saveReport("owner-b", report), /数据集/);
  } finally { sqlite.close(); }
});

test("每次改变筛选生成独立报告，历史计算不会被覆盖", async () => {
  const { api, sqlite } = store();
  try {
    const ds = await createDataset("owner", { sample: true }, api);
    const query = { period: { start: "2026-08-01", end: "2026-09-30" }, filters: {} };
    const a = await createReport("owner", { datasetId: ds.id, query, question: "新老会员的差异" }, api);
    const b = await createReport("owner", { datasetId: ds.id, query: { ...query, filters: { categories: ["黄金"] } } }, api);
    assert.notEqual(a.id, b.id);
    assert.ok(a.metrics.sales > b.metrics.sales);
    assert.equal((await api.loadReport("owner", a.id))?.metrics.sales, a.metrics.sales);
    assert.equal((await api.loadReport("owner", a.id))?.question, "新老会员的差异");
  } finally { sqlite.close(); }
});

test("首次读取初始化 cookie，写入需要访问标识且拒绝跨源", async () => {
  assert.throws(() => analyticsAccess(new Request("http://localhost/api", { method: "POST" })), /初始化/);
  const access = analyticsAccess(new Request("http://localhost/api"), true);
  assert.match(access.cookie!, /HttpOnly/);
  assert.match(access.cookie!, /SameSite=Lax/);
  assert.throws(() => analyticsAccess(new Request("http://localhost/api", { method: "POST", headers: { origin: "https://other.example", cookie: `ctf_analytics_owner=${access.owner}` } })), /同源/);
  await assert.rejects(readAnalyticsJson(new Request("http://localhost/api", { method: "POST", body: "x", headers: { "content-type": "application/json" } })), /JSON/);
  await assert.rejects(readAnalyticsJson(new Request("http://localhost/api", { method: "POST", body: "x".repeat(2 * 1024 * 1024 + 1), headers: { "content-type": "application/json" } })), /过大/);
});
