import assert from "node:assert/strict";
import test from "node:test";
import { offerDepth } from "../app/lib/insight/offer-params.ts";
import { INSIGHT_FAMILIES, INSIGHT_METRICS, sumCells } from "../app/lib/insight/metrics.ts";
import { INSIGHT_DIMENSIONS, INSIGHT_GROUPS } from "../app/lib/insight/ontology.ts";
import { INSIGHT_DIMENSION_IDS, INSIGHT_METRIC_IDS, type CellSum, type InsightCell } from "../app/lib/insight/types.ts";

test("从优惠名解析力度", () => {
  assert.equal(offerDepth("H-克减30元"), "克减30元");
  assert.equal(offerDepth("EF区八月周末克減30"), "克减30元");
  assert.equal(offerDepth("H-定价类92折"), "92折");
  assert.equal(offerDepth("H-金色星期二"), "以旧换新");
  assert.equal(offerDepth("WAB-F类"), null);
});

test("每个维度属于一个已知分组，每个指标属于七族之一", () => {
  for (const id of INSIGHT_DIMENSION_IDS) assert.ok(INSIGHT_GROUPS[INSIGHT_DIMENSIONS[id].group], id);
  for (const id of INSIGHT_METRIC_IDS) assert.ok(INSIGHT_FAMILIES.includes(INSIGHT_METRICS[id].family), id);
});

test("单侧指标按汇总值计算，分母为零返回 null", () => {
  const sum: CellSum = { rows: 10, stores: 1, amount: 1000, grams: 1, quantity: 2, tagAmount: 1100, profit: 100, orders: 2, lines: 3, tradeInOrders: 1, agedAmount: 250, keySeriesAmount: 500, returnAmount: 10, days: 1 };
  assert.equal(INSIGHT_METRICS.grams_per_item.compute(sum), 0.5);
  assert.equal(INSIGHT_METRICS.items_per_order.compute(sum), 1.5);
  assert.equal(INSIGHT_METRICS.trade_in_rate.compute(sum), 50);
  assert.ok(Math.abs(INSIGHT_METRICS.discount_rate.compute(sum)! - 9.0909) < 0.001);
  assert.equal(INSIGHT_METRICS.margin_rate.compute(sum), 10);
  assert.equal(INSIGHT_METRICS.aged_share.compute(sum), 25);
  assert.equal(INSIGHT_METRICS.grams_per_item.compute({ ...sum, quantity: 0 }), null);
  assert.equal(INSIGHT_METRICS.trade_in_rate.compute({ ...sum, tradeInOrders: null }), null);
});

test("累加格子：日数去重，门店数换算成日均，缺列保持 null", () => {
  const cell = (day: string, over: Partial<InsightCell> = {}): InsightCell => ({ value: "x", side: "offer", day, rows: 1, stores: 10, amount: 100, grams: 1, quantity: 1, tagAmount: 110, profit: 10, orders: 1, lines: 1, tradeInOrders: 0, agedAmount: 0, keySeriesAmount: 0, returnAmount: 0, ...over });
  const sum = sumCells([cell("20250801"), cell("20250801"), cell("20250802", { agedAmount: null })]);
  assert.equal(sum.days, 2);
  assert.equal(sum.stores, 15);
  assert.equal(sum.amount, 300);
  assert.equal(sum.agedAmount, null);
  assert.equal(sum.tradeInOrders, 0);
});

test("每个维度和指标都标了来源；AI 判断的写明判断内容，数据来源的写明字段", async () => {
  const { INSIGHT_METRIC_SOURCES } = await import("../app/lib/insight/metrics.ts");
  const sources = [...INSIGHT_DIMENSION_IDS.map((id) => INSIGHT_DIMENSIONS[id].origin), ...INSIGHT_METRIC_IDS.map((id) => INSIGHT_METRIC_SOURCES[id])];
  for (const source of sources) {
    assert.ok(source.columns.length > 0, source.how);
    if (source.kind === "inferred") assert.ok(source.judgement, source.how);
  }
  // 原样取字段是原始字段；分段、映射是数据计算；名称解析和含义对应是 AI 判断。
  assert.equal(INSIGHT_DIMENSIONS.cityTier.origin.kind, "field");
  assert.deepEqual(INSIGHT_DIMENSIONS.cityTier.origin.columns, ["城市级别"]);
  assert.equal(INSIGHT_DIMENSIONS.itemWeight.origin.kind, "derived");
  assert.equal(INSIGHT_DIMENSIONS.storeAge.origin.kind, "inferred");
  assert.equal(INSIGHT_DIMENSIONS.offerDepth.origin.kind, "inferred");
  assert.equal(INSIGHT_DIMENSIONS.category.origin.kind, "inferred");
  assert.equal(INSIGHT_METRIC_SOURCES.margin_rate.kind, "inferred");
  // 待采集项都写了 AI 推测的影响范围，供点击时高亮。
  for (const group of Object.values(INSIGHT_GROUPS)) for (const item of group.missing) assert.ok(item.affects.dimensions.length + item.affects.metrics.length > 0, item.label);
});
