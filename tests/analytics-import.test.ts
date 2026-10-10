import assert from "node:assert/strict";
import test from "node:test";
import { importDataset, inspectFile } from "../app/lib/analytics/import.ts";

const header = "明细ID,日期,门店,货类,净销售额,件数";
const body = `${header}\na,2026-08-01,A,黄金,100.10,1`;
const load = (content: string, extra = {}) => importDataset({ name: "导入", provenance: "imported", currency: "CNY", sales: { content, format: "csv" }, ...extra });

test("处理 BOM、引号内逗号、引号转义和换行", () => {
  const ds = load(`\uFEFF${header}\na,2026-08-01,"门店,A",黄金,100.10,1`);
  assert.equal(ds.rows[0].store, "门店,A");
  assert.equal(ds.rows[0].netSales, 100.1);
  assert.equal(inspectFile('a,b\n"x""y","第一行\n第二行"', "csv").preview[0][0], 'x"y');
});

test("拒绝重复表头、重复明细 ID、非法日期、空数据和非数字金额", () => {
  assert.throws(() => load(`${header},日期\na,2026-08-01,A,黄金,1,1,2026-08-01`), /重复表头/);
  assert.throws(() => load(body + "\na,2026-08-02,B,黄金,100,1"), /重复.*明细/);
  assert.throws(() => load(body.replace("2026-08-01", "2026-02-30")), /日期/);
  assert.throws(() => load(header), /没有.*数据/);
  assert.throws(() => load(body.replace("100.10", "不是数字")), /金额/);
});

test("支持 JSON 与手工映射，不把缺少的可选字段填成零", () => {
  const ds = load(JSON.stringify([{ id: "j", day: "2026-08-01", place: "A", kind: "黄金", amount: 20, units: 1 }]), {
    sales: { format: "json", content: JSON.stringify([{ id: "j", day: "2026-08-01", place: "A", kind: "黄金", amount: 20, units: 1 }]), mapping: { lineId: "id", date: "day", store: "place", category: "kind", netSales: "amount", quantity: "units" } },
  });
  assert.equal(ds.rows[0].cost, null);
  assert.equal(ds.rows[0].memberSegment, null);
  assert.equal(ds.rows[0].netSales, 20);
});

test("同一活动允许多规则，但不复制销售明细", () => {
  const ds = load(`${body},c1`.replace(header, header + ",活动编号"), {
    campaigns: { format: "csv", content: "活动编号,活动名称,优惠机制,优惠力度\nc1,七夕,克减,40\nc1,七夕,工费折扣,0.9" },
  });
  assert.equal(ds.rows.length, 1);
  assert.equal(ds.rules.length, 2);
});
