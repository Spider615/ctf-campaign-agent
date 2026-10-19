// 洞察图谱的数据服务：按「维度取值 × 日 × 活动/对照」从 MySQL 读立方格子，交给 score.ts 组装成图谱。
// 只发 SELECT；结果按数据版本和请求缓存在内存，同时把 SQL 和参数写进证据目录。
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SEMANTIC_DIMENSIONS } from "../app/lib/analytics/semantic/model.ts";
import { INSIGHT_DIMENSIONS } from "../app/lib/insight/ontology.ts";
import { offerDepth } from "../app/lib/insight/offer-params.ts";
import { buildInsightGraph, type DimensionCube, type PairCube } from "../app/lib/insight/score.ts";
import { INSIGHT_CATEGORY_CHOICES, INSIGHT_DIMENSION_IDS, INSIGHT_METRIC_IDS, INSIGHT_OFFER_CHOICES, type InsightCell, type InsightDimensionId, type InsightGraph, type InsightMetricId, type InsightRequest } from "../app/lib/insight/types.ts";
import type { HistoryConnection } from "./analytics-database.ts";
import { ANALYSIS_DATABASE_QUERY_TIMEOUT_MS, dimensionExpression, sourceColumns } from "./analytics-operation-database.ts";

export class InsightRequestError extends Error {}
export type InsightGraphService = { graph(request: InsightRequest): Promise<InsightGraph> };
type Config = { table: string; evidenceDir: string; connect: () => Promise<HistoryConnection>; concurrency?: number; logger?: Pick<Console, "log" | "error"> };

const RECYCLE = "回收金标识：1：是，0：否";
const BASE_OFFER = "一般開單";
const PAIR_ANCHORS = 4;     // 只给强度排前几的连线找搭配，控制查询数
const PAIR_PARTNERS = 3;    // 每条连线只和最强的几个其他维度交叉
const quoted = (name: string) => `\`${name}\``;
const CACHE_LIMIT = 20;

export function parseInsightRequest(search: URLSearchParams): InsightRequest {
  const metric = search.get("metric") ?? "give_per_gram"; const offer = search.get("offer") ?? "克减类"; const category = search.get("category") ?? "一般足金类";
  if (!(INSIGHT_METRIC_IDS as readonly string[]).includes(metric)) throw new InsightRequestError("不支持这个目标指标");
  if (!(INSIGHT_OFFER_CHOICES as readonly string[]).includes(offer)) throw new InsightRequestError("不支持这个优惠");
  if (!(INSIGHT_CATEGORY_CHOICES as readonly string[]).includes(category)) throw new InsightRequestError("不支持这个货类");
  return { metric: metric as InsightMetricId, offer, category };
}

// 维度取值的 SQL 表达式；表里缺来源列时返回 null。
export function insightDimensionSql(dimension: InsightDimensionId, columns: ReadonlySet<string>): string | null {
  const source = INSIGHT_DIMENSIONS[dimension].source;
  if (source.kind === "offer") return columns.has("优惠小类") ? quoted("优惠小类") : null;
  if (source.kind === "weight") return columns.has("销售金重") && columns.has("销售件数") ? "CASE WHEN `销售件数` > 0 AND `销售金重` > 0 THEN CASE WHEN `销售金重` / `销售件数` < 2 THEN '<2克' WHEN `销售金重` / `销售件数` < 5 THEN '2-5克' WHEN `销售金重` / `销售件数` < 10 THEN '5-10克' WHEN `销售金重` / `销售件数` < 20 THEN '10-20克' ELSE '20克以上' END END" : null;
  const semantic = SEMANTIC_DIMENSIONS[source.id].source;
  if (!semantic || sourceColumns(semantic).some((c) => !columns.has(c))) return null;
  return dimensionExpression(source.id);
}

// 一条立方查询。dimensionSql 为 null 时只按日和活动/对照汇总（整体）；filter 用于固定搭配的锚点取值。
export function buildInsightCubeSql(table: string, dimensionSql: string | null, request: InsightRequest, columns: ReadonlySet<string>, filter?: { sql: string; value: string }): { sql: string; params: string[] } {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(table)) throw new Error("洞察数据表名不正确");
  const params: string[] = [request.category];
  const offerCondition = request.offer === "克减类" ? "`优惠小类` REGEXP '克[减減]'" : (params.push(request.offer), "`优惠小类` = ?");
  const positive = (expr: string) => `SUM(CASE WHEN \`实际销售金额\` > 0 THEN ${expr} END)`;
  const order = "CONCAT(`实体分店店号`, '/', `销售单号`)";
  const hasRecycle = columns.has(RECYCLE);
  // 回收金行属于「金箱(足金)」货类，不在当前货类里；按订单关联才能知道这张单有没有以旧换新。只有看以旧换新率时才付这次关联的代价。
  const join = request.metric === "trade_in_rate" && hasRecycle ? ` LEFT JOIN (SELECT DISTINCT \`实体分店店号\` AS rs, \`销售单号\` AS ro FROM ${quoted(table)} WHERE ${quoted(RECYCLE)} = '1' AND \`销售单号\` IS NOT NULL) AS recycle_orders ON recycle_orders.rs = \`实体分店店号\` AND recycle_orders.ro = \`销售单号\`` : "";
  const tradeIn = join ? `COUNT(DISTINCT CASE WHEN recycle_orders.rs IS NOT NULL THEN ${order} END)` : "NULL";
  const aged = columns.has("sku年龄") ? positive("CASE WHEN `sku年龄` >= 365 THEN `实际销售金额` ELSE 0 END") : "NULL";
  const returns = `SUM(CASE WHEN \`实际销售金额\` < 0${hasRecycle ? ` AND ${quoted(RECYCLE)} <> '1'` : ""} THEN -\`实际销售金额\` END)`;
  if (filter) params.push(filter.value);
  const sql = `SELECT /*+ MAX_EXECUTION_TIME(${ANALYSIS_DATABASE_QUERY_TIMEOUT_MS}) */ ${dimensionSql ?? "'全部'"} AS v, \`交易日期wid\` AS d, CASE WHEN \`优惠小类\` = '${BASE_OFFER}' THEN 'base' ELSE 'offer' END AS side,`
    + ` COUNT(*) AS row_count, COUNT(DISTINCT \`实体分店店号\`) AS stores, ${positive("`实际销售金额`")} AS amount, ${positive("`销售金重`")} AS grams, ${positive("`销售件数`")} AS quantity,`
    + ` ${positive("`销售牌仔价`")} AS tag_amount, ${positive("`零售毛利`")} AS profit, COUNT(DISTINCT ${order}) AS orders, SUM(CASE WHEN \`销售单号\` IS NOT NULL THEN 1 ELSE 0 END) AS line_count,`
    + ` ${tradeIn} AS trade_in, ${aged} AS aged, ${positive("CASE WHEN `是否重点系列描述` = '重点系列' THEN `实际销售金额` ELSE 0 END")} AS key_amount, ${returns} AS returns_amount`
    + ` FROM ${quoted(table)}${join} WHERE \`业务小类描述\` = ? AND (\`优惠小类\` = '${BASE_OFFER}' OR ${offerCondition})${filter ? ` AND ${filter.sql} = ?` : ""}`
    + ` GROUP BY v, d, side`;
  return { sql, params };
}

const num = (value: unknown) => value === null || value === undefined ? 0 : Number(value);
const nullable = (value: unknown) => value === null || value === undefined ? null : Number(value);
function toCells(result: unknown): InsightCell[] {
  if (!Array.isArray(result)) throw new Error("洞察查询结果格式不正确");
  return result.filter((r) => r && r.v !== null && r.v !== undefined && r.v !== "").map((r) => ({
    value: String(r.v), side: r.side === "base" ? "base" : "offer", day: String(r.d),
    rows: num(r.row_count), stores: num(r.stores), amount: num(r.amount), grams: num(r.grams), quantity: num(r.quantity), tagAmount: num(r.tag_amount), profit: num(r.profit),
    orders: num(r.orders), lines: num(r.line_count), tradeInOrders: nullable(r.trade_in), agedAmount: nullable(r.aged), keySeriesAmount: num(r.key_amount), returnAmount: num(r.returns_amount),
  }));
}

// 力度维度：活动行按优惠名映射成力度再合并；一般開單作为每个力度的共同对照，按日复制到各取值下。
export function regroupOfferDepth(cells: readonly InsightCell[]): InsightCell[] {
  const merged = new Map<string, InsightCell>();
  for (const cell of cells.filter((c) => c.side === "offer")) {
    const value = offerDepth(cell.value) ?? "其他";
    const key = `${value}\u0000${cell.day}`; const prev = merged.get(key);
    if (!prev) { merged.set(key, { ...cell, value }); continue; }
    for (const field of ["rows", "stores", "amount", "grams", "quantity", "tagAmount", "profit", "orders", "lines", "keySeriesAmount", "returnAmount"] as const) prev[field] += cell[field];
    prev.tradeInOrders = prev.tradeInOrders === null || cell.tradeInOrders === null ? null : prev.tradeInOrders + cell.tradeInOrders;
    prev.agedAmount = prev.agedAmount === null || cell.agedAmount === null ? null : prev.agedAmount + cell.agedAmount;
  }
  const values = new Set([...merged.values()].map((c) => c.value));
  const base = cells.filter((c) => c.side === "base");
  return [...merged.values(), ...[...values].flatMap((value) => base.map((c) => ({ ...c, value })))];
}

export function createInsightGraphService(config: Config): InsightGraphService {
  const logger = config.logger ?? console;
  const cache = new Map<string, Promise<InsightGraph>>();
  let meta: Promise<{ columns: Set<string>; version: string }> | null = null;

  // 并发上限内复用连接，按队列取查询。
  async function runAll(queries: Array<{ sql: string; params: string[] }>): Promise<unknown[]> {
    const results: unknown[] = new Array(queries.length); let next = 0;
    const worker = async () => {
      const connection = await config.connect();
      try { while (next < queries.length) { const index = next++; const [rows] = await connection.execute(queries[index].sql, queries[index].params); results[index] = rows; } }
      finally { connection.destroy(); }
    };
    await Promise.all(Array.from({ length: Math.min(config.concurrency ?? 3, queries.length) }, worker));
    return results;
  }

  const loadMeta = () => meta ??= (async () => {
    const [columns, stats] = await runAll([{ sql: `SHOW COLUMNS FROM ${quoted(config.table)}`, params: [] }, { sql: `SELECT /*+ MAX_EXECUTION_TIME(20000) */ COUNT(*) AS n, MAX(\`交易日期wid\`) AS max_day FROM ${quoted(config.table)}`, params: [] }]);
    const names = new Set((columns as Array<{ Field: string }>).map((c) => c.Field));
    const row = (stats as Array<{ n: unknown; max_day: unknown }>)[0];
    return { columns: names, version: `${config.table}:${num(row?.n)}:${String(row?.max_day ?? "")}` };
  })().catch((error) => { meta = null; throw error; });

  // 立方只取决于优惠、货类，以及是否要关联回收订单（只有以旧换新率需要）；切换其他指标直接复用。
  type Cubes = { version: string; total: InsightCell[]; cubes: DimensionCube[]; dims: Array<{ id: InsightDimensionId; sql: string }>; columns: Set<string>; unavailable: Partial<Record<InsightDimensionId, string>>; queries: Array<{ sql: string; params: string[] }> };
  const cubeCache = new Map<string, Promise<Cubes>>();
  const loadCubes = (request: InsightRequest): Promise<Cubes> => {
    const tradeIn = request.metric === "trade_in_rate";
    const key = JSON.stringify([request.offer, request.category, tradeIn]);
    const hit = cubeCache.get(key); if (hit) return hit;
    const pending = (async () => {
      const { columns, version } = await loadMeta();
      const unavailable: Partial<Record<InsightDimensionId, string>> = {};
      const dims = INSIGHT_DIMENSION_IDS.flatMap((id) => { const sql = insightDimensionSql(id, columns); if (!sql) unavailable[id] = "数据表缺少这个维度的来源列"; return sql ? [{ id, sql }] : []; });
      const queries = [buildInsightCubeSql(config.table, null, request, columns), ...dims.map((d) => buildInsightCubeSql(config.table, d.sql, request, columns))];
      const results = await runAll(queries);
      const cubes: DimensionCube[] = dims.map((d, i) => ({ dimension: d.id, cells: d.id === "offerDepth" ? regroupOfferDepth(toCells(results[i + 1])) : toCells(results[i + 1]) }));
      return { version, total: toCells(results[0]), cubes, dims, columns, unavailable, queries };
    })().catch((error) => { cubeCache.delete(key); throw error; });
    cubeCache.set(key, pending);
    if (cubeCache.size > CACHE_LIMIT) cubeCache.delete(cubeCache.keys().next().value!);
    return pending;
  };

  async function build(request: InsightRequest): Promise<InsightGraph> {
    const started = performance.now();
    const { version, total, cubes, dims, columns, unavailable, queries } = await loadCubes(request);
    const unavailableMetrics: Partial<Record<InsightMetricId, string>> = {};
    if (!columns.has(RECYCLE)) unavailableMetrics.trade_in_rate = "数据表没有回收金标识列，算不出以旧换新率";
    if (!columns.has("sku年龄")) unavailableMetrics.aged_share = "数据表没有 sku 年龄列，算不出老货动销占比";

    // 先不带搭配算一遍，挑出强连线的最优取值，再查这些取值和其他强维度的交叉。
    const draft = buildInsightGraph({ request, datasetVersion: version, builtAt: new Date().toISOString(), total, cubes, unavailable, unavailableMetrics });
    const strong = draft.edges.filter((e) => !e.weak && e.best && e.dimension !== "offerDepth").sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0));
    const pairSpecs = strong.slice(0, PAIR_ANCHORS).flatMap((anchor) => strong.filter((o) => o.dimension !== anchor.dimension).slice(0, PAIR_PARTNERS).map((other) => ({ anchor, other })));
    const sqlOf = new Map(dims.map((d) => [d.id, d.sql]));
    const pairQueries = pairSpecs.map(({ anchor, other }) => buildInsightCubeSql(config.table, sqlOf.get(other.dimension)!, request, columns, { sql: sqlOf.get(anchor.dimension)!, value: anchor.best! }));
    const pairResults = pairQueries.length ? await runAll(pairQueries) : [];
    const pairs: PairCube[] = pairSpecs.map(({ anchor, other }, i) => ({ anchor: anchor.dimension, anchorValue: anchor.best!, other: other.dimension, cells: toCells(pairResults[i]) }));
    const graph = pairs.length ? buildInsightGraph({ request, datasetVersion: version, builtAt: draft.builtAt, total, cubes, pairs, unavailable, unavailableMetrics }) : draft;

    const elapsed = Math.round(performance.now() - started);
    logger.log(`[insight] ${request.metric}/${request.offer}/${request.category} 搭配查询 ${pairQueries.length} 条，共 ${elapsed}ms`);
    const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 12);
    void mkdir(config.evidenceDir, { recursive: true, mode: 0o700 })
      .then(() => writeFile(join(config.evidenceDir, `insight-${hash}-${createHash("sha256").update(version).digest("hex").slice(0, 8)}.json`), JSON.stringify({ schema: "ctf-insight-evidence/v1", request, datasetVersion: version, builtAt: graph.builtAt, elapsedMs: elapsed, queries: [...queries, ...pairQueries] }, null, 2), { flag: "wx", mode: 0o600 }))
      .catch((error) => { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") logger.error(`[insight] 证据写入失败：${error instanceof Error ? error.message : error}`); });
    return graph;
  }

  return {
    graph(request) {
      const key = JSON.stringify(request);
      const hit = cache.get(key); if (hit) return hit;
      const pending = build(request).catch((error) => { cache.delete(key); throw error; });
      cache.set(key, pending);
      if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      return pending;
    },
  };
}
