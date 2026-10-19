import assert from "node:assert/strict";
import test from "node:test";
import { buildInsightCubeSql, createInsightGraphService, insightDimensionSql, parseInsightRequest, regroupOfferDepth } from "../agent/insight-graph.ts";
import type { HistoryConnection } from "../agent/analytics-database.ts";
import type { InsightCell } from "../app/lib/insight/types.ts";

const columns = new Set(["实体分店店号", "销售单号", "交易日期wid", "实际销售金额", "销售金重", "销售件数", "销售牌仔价", "零售毛利", "业务小类描述", "优惠小类", "是否重点系列描述", "城市级别", "回收金标识：1：是，0：否", "sku年龄"]);
const request = { metric: "give_per_gram" as const, offer: "克减类", category: "一般足金类" };

test("请求参数只接受目录里的值", () => {
  assert.deepEqual(parseInsightRequest(new URLSearchParams("")), request);
  assert.throws(() => parseInsightRequest(new URLSearchParams("metric=drop_table")), /目标指标/);
  assert.throws(() => parseInsightRequest(new URLSearchParams("offer=' OR 1=1")), /优惠/);
});

test("克减类用正则，具体优惠走参数，不把原文拼进 SQL", () => {
  const all = buildInsightCubeSql("sales_detail_202508", null, request, columns);
  assert.match(all.sql, /REGEXP '克\[减減\]'/);
  assert.deepEqual(all.params, ["一般足金类"]);
  const one = buildInsightCubeSql("sales_detail_202508", "`城市级别`", { ...request, offer: "H-克减50元" }, columns);
  assert.deepEqual(one.params, ["一般足金类", "H-克减50元"]);
  assert.doesNotMatch(one.sql, /H-克减50元/);
  assert.throws(() => buildInsightCubeSql("x; drop", null, request, columns), /表名/);
});

test("只有以旧换新率才关联回收订单；缺列时对应字段为 NULL", () => {
  assert.doesNotMatch(buildInsightCubeSql("t", null, request, columns).sql, /recycle_orders/);
  assert.match(buildInsightCubeSql("t", null, { ...request, metric: "trade_in_rate" }, columns).sql, /LEFT JOIN .*recycle_orders/);
  const bare = new Set([...columns].filter((c) => c !== "sku年龄" && !c.startsWith("回收金")));
  const sql = buildInsightCubeSql("t", null, { ...request, metric: "trade_in_rate" }, bare).sql;
  assert.match(sql, /NULL AS trade_in, NULL AS aged/);
});

test("维度缺来源列时不可用", () => {
  assert.equal(insightDimensionSql("cityTier", columns), "`城市级别`");
  assert.equal(insightDimensionSql("shopType", columns), null);
  assert.match(insightDimensionSql("itemWeight", columns)!, /20克以上/);
});

test("力度维度：活动按力度合并，一般開單复制到每个力度下作共同对照", () => {
  const cell = (value: string, side: "offer" | "base", amount: number): InsightCell => ({ value, side, day: "20250801", rows: 1, stores: 1, amount, grams: 1, quantity: 1, tagAmount: 0, profit: 0, orders: 1, lines: 1, tradeInOrders: null, agedAmount: 0, keySeriesAmount: 0, returnAmount: 0 });
  const out = regroupOfferDepth([cell("H-克减30元", "offer", 10), cell("周末礼献克减30", "offer", 5), cell("H-克减50元", "offer", 7), cell("一般開單", "base", 100)]);
  const thirty = out.filter((c) => c.value === "克减30元");
  assert.equal(thirty.find((c) => c.side === "offer")?.amount, 15);
  assert.equal(thirty.find((c) => c.side === "base")?.amount, 100);
  assert.equal(out.filter((c) => c.side === "base").length, 2);
});

test("同一请求只算一次；切换指标复用同一份立方", async () => {
  let connects = 0; const executed: string[] = [];
  const connection: HistoryConnection = {
    async query() { return [[], []]; },
    async execute(sql: string) {
      executed.push(sql);
      if (sql.startsWith("SHOW COLUMNS")) return [[...columns].map((Field) => ({ Field })), []];
      if (sql.includes("COUNT(*) AS n")) return [[{ n: 10, max_day: "20250831" }], []];
      return [[{ v: "全部", d: "20250801", side: "offer", row_count: 600, stores: 5, amount: 1000, grams: 1, quantity: 1, tag_amount: 1100, profit: 10, orders: 1, line_count: 1, trade_in: null, aged: 0, key_amount: 0, returns_amount: 0 }, { v: "全部", d: "20250801", side: "base", row_count: 600, stores: 5, amount: 1100, grams: 1, quantity: 1, tag_amount: 1100, profit: 10, orders: 1, line_count: 1, trade_in: null, aged: 0, key_amount: 0, returns_amount: 0 }], []];
    },
    destroy() {},
  };
  const service = createInsightGraphService({ table: "t", evidenceDir: "/tmp/insight-test-evidence", connect: async () => { connects++; return connection; }, logger: { log() {}, error() {} } });
  const [a, b] = await Promise.all([service.graph(request), service.graph(request)]);
  assert.equal(a, b);
  const cubeQueries = executed.filter((s) => s.includes("GROUP BY v, d, side")).length;
  const other = await service.graph({ ...request, metric: "margin_rate" });
  assert.equal(other.metric.id, "margin_rate");
  assert.equal(executed.filter((s) => s.includes("GROUP BY v, d, side")).length, cubeQueries);
  assert.ok(connects > 0);
});
