// 洞察图谱的数据服务：从 MySQL 读几份聚合（门店日面板、门店属性、货类、逐日、计价金活动、以旧换新），交给 drivers.ts 算图谱。
// 只发 SELECT；查询结果按数据版本落盘（重启后直接读），图谱在内存里缓存一份，同时把 SQL 写进证据目录。
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildDriverGraph, type DailyRow, type DriverData, type GoldRow, type OfferGroup, type PanelRow, type PtypeRow, type StoreRow, type ThresholdRow, type TradeInRow } from "../app/lib/insight/drivers.ts";
import type { InsightGraph } from "../app/lib/insight/types.ts";
import type { HistoryConnection } from "./analytics-database.ts";

export type InsightGraphService = { graph(): Promise<InsightGraph>; warm(): Promise<void> };
// cacheDir：查询结果的磁盘缓存目录，不给就只缓存在内存。
type Config = { table: string; evidenceDir: string; cacheDir?: string; connect: () => Promise<HistoryConnection>; concurrency?: number; logger?: Pick<Console, "log" | "error"> };

// 单条查询上限 3 分钟：门店日面板要扫全表，约 1 分钟。
const QUERY_TIMEOUT_MS = 180000;
const SALE = "`销售件数` > 0 AND `实际销售金额` > 0";
const RECYCLE = "`销售件数` = 0 AND `实际销售金额` < 0";
// 优惠按名称归组（AI 归类）。名称里的「克减」可能写成繁体「減」。
const GROUP = "CASE WHEN `优惠小类` = '一般開單' THEN 'base' WHEN `优惠小类` LIKE '%金色星期二%' THEN 'gt' WHEN `优惠小类` REGEXP '克[减減] *50' THEN 'k50' WHEN `优惠小类` REGEXP '克[减減] *30' THEN 'k30' ELSE 'other' END";
const PTYPE = "CASE WHEN `材料种类描述` = '足金' THEN '计价金' WHEN `材料种类描述` = '定价足金' THEN '一口价黄金' ELSE '镶嵌及其他' END";
const ORDER = "CONCAT(`实体分店店号`, '/', `销售单号`)";
const hint = (sql: string) => sql.replace(/^SELECT /, `SELECT /*+ MAX_EXECUTION_TIME(${QUERY_TIMEOUT_MS}) */ `);

export function insightQueries(table: string): Record<keyof Omit<DriverData, "datasetVersion" | "period" | "rows" | "memberShare"> | "scope", string> {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(table)) throw new Error("洞察数据表名不正确");
  const t = `\`${table}\``;
  return {
    scope: hint(`SELECT MIN(\`交易日期wid\`) AS first_day, MAX(\`交易日期wid\`) AS last_day, COUNT(*) AS n, SUM(CASE WHEN ${SALE} AND \`是否会员销售（1：是，0：否）\` = '1' THEN \`实际销售金额\` ELSE 0 END) / SUM(CASE WHEN ${SALE} THEN \`实际销售金额\` ELSE 0 END) * 100 AS member_share FROM ${t}`),
    panel: hint(`SELECT \`实体分店店号\` AS store, \`交易日期wid\` AS d, SUM(\`实际销售金额\`) AS sales, SUM(\`零售毛利\`) AS gp, SUM(\`rsv\`) / 1.13 AS rev_ex, SUM(\`销售件数\`) AS items,
      COUNT(DISTINCT \`销售单号\`) AS orders, SUM(CASE WHEN \`材料种类描述\` = '足金' THEN \`实际销售金额\` ELSE 0 END) AS gold,
      SUM(CASE WHEN \`材料种类描述\` = '足金' AND \`优惠小类\` = '一般開單' THEN \`实际销售金额\` ELSE 0 END) AS base_gold,
      SUM(CASE WHEN \`材料种类描述\` = '足金' AND \`销售金重\` >= 20 THEN \`实际销售金额\` ELSE 0 END) AS heavy_gold,
      SUM(CASE WHEN \`材料种类描述\` = '足金' THEN \`销售金重\` ELSE 0 END) AS gold_grams, SUM(CASE WHEN \`材料种类描述\` = '足金' THEN \`销售件数\` ELSE 0 END) AS gold_qty,
      MAX(CASE WHEN (${GROUP}) = 'k50' THEN 1 ELSE 0 END) AS k50, MAX(CASE WHEN (${GROUP}) = 'k30' THEN 1 ELSE 0 END) AS k30, MAX(CASE WHEN (${GROUP}) = 'gt' THEN 1 ELSE 0 END) AS gt
      FROM ${t} WHERE ${SALE} AND \`实体分店店号\` IS NOT NULL GROUP BY 1, 2`),
    stores: hint(`SELECT \`实体分店店号\` AS store, ANY_VALUE(\`大区描述\`) AS big_region, ANY_VALUE(\`区域描述\`) AS region, ANY_VALUE(\`城市级别\`) AS city_tier, ANY_VALUE(\`形象级别描述\`) AS image,
      ANY_VALUE(\`铺型\`) AS shop_type, ANY_VALUE(\`分店性质\`) AS nature, ANY_VALUE(\`分店面积区间\`) AS area, ANY_VALUE(\`零售体验描述\`) AS experience, ANY_VALUE(\`店龄\`) AS age, ANY_VALUE(\`分店名称\`) AS name
      FROM ${t} WHERE ${SALE} AND \`实体分店店号\` IS NOT NULL GROUP BY 1`),
    ptype: hint(`SELECT ${PTYPE} AS ptype, SUM(\`实际销售金额\`) AS sales, SUM(\`零售毛利\`) AS gp, SUM(\`rsv\`) / 1.13 AS rev_ex, SUM(\`销售件数\`) AS items, SUM(\`销售金重\`) AS grams FROM ${t} WHERE ${SALE} GROUP BY 1`),
    daily: hint(`SELECT \`交易日期wid\` AS d, DAYOFWEEK(STR_TO_DATE(\`交易日期wid\`, '%Y%m%d')) - 1 AS dow, MAX(\`节庆\`) AS festival, SUM(\`实际销售金额\`) AS sales, COUNT(DISTINCT ${ORDER}) AS orders,
      SUM(CASE WHEN \`材料种类描述\` = '足金' THEN \`实际销售金额\` ELSE 0 END) AS gold,
      SUM(CASE WHEN \`材料种类描述\` = '足金' AND \`优惠小类\` = '一般開單' THEN \`实际销售金额\` ELSE 0 END) AS base_gold,
      SUM(CASE WHEN \`材料种类描述\` = '足金' AND \`优惠小类\` <> '一般開單' AND \`优惠小类\` NOT LIKE '%金色星期二%' THEN \`实际销售金额\` ELSE 0 END) AS promo_gold
      FROM ${t} WHERE ${SALE} GROUP BY 1, 2`),
    gold: hint(`SELECT \`交易日期wid\` AS d, ${GROUP} AS g, SUM(\`实际销售金额\`) AS amount, SUM(\`销售金重\`) AS grams, SUM(\`销售件数\`) AS qty,
      SUM(CASE WHEN \`销售金重\` >= 20 THEN \`实际销售金额\` ELSE 0 END) AS ge20
      FROM ${t} WHERE ${SALE} AND \`材料种类描述\` = '足金' AND \`业务小类描述\` = '一般足金类' GROUP BY 1, 2`),
    threshold: hint(`SELECT FLOOR(\`销售金重\`) AS gram, SUM(CASE WHEN (${GROUP}) = 'k50' THEN \`销售件数\` ELSE 0 END) AS k50, SUM(CASE WHEN (${GROUP}) = 'base' THEN \`销售件数\` ELSE 0 END) AS base
      FROM ${t} WHERE ${SALE} AND \`材料种类描述\` = '足金' AND \`业务小类描述\` = '一般足金类' AND \`销售金重\` >= 15 AND \`销售金重\` < 25 GROUP BY 1`),
    tradein: `WITH o AS (SELECT /*+ MAX_EXECUTION_TIME(${QUERY_TIMEOUT_MS}) */ \`实体分店店号\` AS s, \`销售单号\` AS n, ${GROUP} AS g, SUM(\`实际销售金额\`) AS a FROM ${t} WHERE ${SALE} AND \`销售单号\` IS NOT NULL GROUP BY 1, 2, 3),
      r AS (SELECT \`实体分店店号\` AS s, \`销售单号\` AS n, -SUM(\`实际销售金额\`) AS a FROM ${t} WHERE ${RECYCLE} AND \`销售单号\` IS NOT NULL GROUP BY 1, 2)
      SELECT o.g AS g, COUNT(*) AS orders, COUNT(r.s) AS trade_in, SUM(o.a) AS sales, COALESCE(SUM(r.a), 0) AS recycle FROM o LEFT JOIN r ON r.s = o.s AND r.n = o.n GROUP BY 1`,
  };
}

const num = (value: unknown) => value === null || value === undefined || value === "" ? 0 : Number(value);
const str = (value: unknown) => value === null || value === undefined ? "未知" : String(value);
const group = (value: unknown): OfferGroup => (["base", "k50", "k30", "gt"] as const).find((g) => g === value) ?? "other";
const rowsOf = (result: unknown): Array<Record<string, unknown>> => { if (!Array.isArray(result)) throw new Error("洞察查询结果格式不正确"); return result as Array<Record<string, unknown>>; };

export function toDriverData(results: Record<string, unknown>, datasetVersion: string): DriverData {
  const scope = rowsOf(results.scope)[0] ?? {};
  const first = str(scope.first_day); const last = str(scope.last_day);
  return {
    datasetVersion, rows: num(scope.n), memberShare: num(scope.member_share),
    period: /^\d{8}$/.test(first) && /^\d{8}$/.test(last) ? first.slice(0, 6) === last.slice(0, 6) ? `${first.slice(0, 4)} 年 ${Number(first.slice(4, 6))} 月` : `${first.slice(0, 4)}-${first.slice(4, 6)}-${first.slice(6)} 至 ${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6)}` : "未知",
    panel: rowsOf(results.panel).map((r): PanelRow => ({ store: str(r.store), day: str(r.d), sales: num(r.sales), gp: num(r.gp), revEx: num(r.rev_ex), items: num(r.items), orders: num(r.orders), goldSales: num(r.gold), baseGold: num(r.base_gold), heavyGold: num(r.heavy_gold), goldGrams: num(r.gold_grams), goldQty: num(r.gold_qty), k50: num(r.k50), k30: num(r.k30), gt: num(r.gt) })),
    stores: rowsOf(results.stores).map((r): StoreRow => ({ store: str(r.store), bigRegion: str(r.big_region), region: str(r.region), cityTier: str(r.city_tier), image: str(r.image), shopType: str(r.shop_type), nature: str(r.nature), area: str(r.area), experience: str(r.experience), age: r.age === null || r.age === undefined || r.age === "" ? null : Number(r.age), name: r.name ? String(r.name) : "" })),
    ptype: rowsOf(results.ptype).map((r): PtypeRow => ({ ptype: (["计价金", "一口价黄金"] as const).find((p) => p === r.ptype) ?? "镶嵌及其他", sales: num(r.sales), gp: num(r.gp), revEx: num(r.rev_ex), items: num(r.items), grams: num(r.grams) })),
    daily: rowsOf(results.daily).map((r): DailyRow => ({ day: str(r.d), dow: num(r.dow), festival: r.festival ? String(r.festival) : null, sales: num(r.sales), orders: num(r.orders), goldSales: num(r.gold), baseGold: num(r.base_gold), promoGold: num(r.promo_gold) })),
    gold: rowsOf(results.gold).map((r): GoldRow => ({ day: str(r.d), group: group(r.g), amount: num(r.amount), grams: num(r.grams), qty: num(r.qty), ge20: num(r.ge20) })),
    threshold: rowsOf(results.threshold).map((r): ThresholdRow => ({ gram: num(r.gram), k50: num(r.k50), base: num(r.base) })),
    tradein: rowsOf(results.tradein).map((r): TradeInRow => ({ group: group(r.g), orders: num(r.orders), tradeIn: num(r.trade_in), sales: num(r.sales), recycle: num(r.recycle) })),
  };
}

export function createInsightGraphService(config: Config): InsightGraphService {
  const logger = config.logger ?? console;
  let cached: Promise<InsightGraph> | null = null;

  // 并发上限内复用连接，按队列取查询。
  async function runAll(queries: string[]): Promise<unknown[]> {
    const results: unknown[] = new Array(queries.length); let next = 0;
    const worker = async () => {
      const connection = await config.connect();
      try { while (next < queries.length) { const index = next++; const [rows] = await connection.execute(queries[index]); results[index] = rows; } }
      finally { connection.destroy(); }
    };
    await Promise.all(Array.from({ length: Math.min(config.concurrency ?? 3, queries.length) }, worker));
    return results;
  }

  // 带磁盘缓存地跑查询：键是数据版本 + SQL，数据一变自然失效；缓存坏了就重查。
  async function cachedAll(version: string, queries: string[]): Promise<unknown[]> {
    const dir = config.cacheDir;
    if (!dir) return runAll(queries);
    const files = queries.map((q) => join(dir, `${createHash("sha256").update(JSON.stringify([version, q])).digest("hex").slice(0, 32)}.json`));
    const results = await Promise.all(files.map((file) => readFile(file, "utf8").then((text) => JSON.parse(text) as unknown, () => undefined)));
    const missing = results.flatMap((r, i) => r === undefined ? [i] : []);
    if (!missing.length) return results;
    const fresh = await runAll(missing.map((i) => queries[i]));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await Promise.all(missing.map(async (index, k) => {
      results[index] = fresh[k];
      const tmp = `${files[index]}.${process.pid}.tmp`;
      try { await writeFile(tmp, JSON.stringify(fresh[k]), { mode: 0o600 }); await rename(tmp, files[index]); }
      catch (error) { logger.error(`[insight] 缓存写入失败：${error instanceof Error ? error.message : error}`); }
    }));
    return results;
  }

  async function build(): Promise<InsightGraph> {
    const started = performance.now();
    const [stats] = await runAll([`SELECT /*+ MAX_EXECUTION_TIME(${QUERY_TIMEOUT_MS}) */ COUNT(*) AS n, MAX(\`交易日期wid\`) AS max_day FROM \`${config.table}\``]);
    const row = (stats as Array<{ n: unknown; max_day: unknown }>)[0];
    const version = `${config.table}:${num(row?.n)}:${String(row?.max_day ?? "")}`;
    const queries = insightQueries(config.table);
    const names = Object.keys(queries) as Array<keyof typeof queries>;
    const results = await cachedAll(version, names.map((k) => queries[k]));
    const graph = buildDriverGraph(toDriverData(Object.fromEntries(names.map((k, i) => [k, results[i]])), version));
    const elapsed = Math.round(performance.now() - started);
    logger.log(`[insight] 影响因素图谱算好，共 ${elapsed}ms`);
    void mkdir(config.evidenceDir, { recursive: true, mode: 0o700 })
      .then(() => writeFile(join(config.evidenceDir, `insight-drivers-${createHash("sha256").update(version).digest("hex").slice(0, 8)}.json`), JSON.stringify({ schema: "ctf-insight-evidence/v2", datasetVersion: version, builtAt: graph.builtAt, elapsedMs: elapsed, queries }, null, 2), { flag: "wx", mode: 0o600 }))
      .catch((error) => { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") logger.error(`[insight] 证据写入失败：${error instanceof Error ? error.message : error}`); });
    return graph;
  }

  function graph(): Promise<InsightGraph> {
    cached ??= build().catch((error) => { cached = null; throw error; });
    return cached;
  }

  // 启动时预热：库上还有别的预热在跑，查询可能超时；失败等一会儿再试一次。
  async function warm(): Promise<void> {
    try { await graph(); }
    catch { await new Promise((r) => setTimeout(r, 10_000)); await graph().catch((error) => logger.error(`[insight] 预热失败：${error instanceof Error ? error.message : error}`)); }
  }

  return { graph, warm };
}
