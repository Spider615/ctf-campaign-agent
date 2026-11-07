// 洞察图谱的数据服务：从 MySQL 读几份聚合（门店日面板、门店属性、货类、逐日、计价金活动、以旧换新），交给 drivers.ts 算图谱。
// 只发 SELECT；查询结果按数据版本落盘（重启后直接读），图谱在内存里缓存一份，同时把 SQL 写进证据目录。
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildDriverGraph, type DailyRow, type DriverData, type GoldRow, type OfferGroup, type PanelRow, type PtypeRow, type StoreRow, type ThresholdRow, type TradeInRow } from "../app/lib/insight/drivers.ts";
import type { InsightGraph } from "../app/lib/insight/types.ts";
import { checkRange, festivalsOf, isFullRange, rangeLabel, type InsightRange } from "../app/lib/insight/range.ts";
import type { HistoryConnection } from "./analytics-database.ts";

export type InsightGraphService = { graph(range?: InsightRange | null): Promise<InsightGraph>; warm(): Promise<void> };
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

// 带范围时，除逐日外的查询都只看窗口内的行；逐日始终取全部日期（铺开日、平日对照要看窗口外）。日期只走参数。
const RANGE = "`交易日期wid` BETWEEN ? AND ?";
export function insightQueries(table: string, ranged = false): Record<keyof Omit<DriverData, "datasetVersion" | "period" | "rows" | "memberShare" | "window" | "dataFrom" | "dataTo"> | "scope", string> {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(table)) throw new Error("洞察数据表名不正确");
  const t = `\`${table}\``;
  // and：接在已有 WHERE 后面；where：没有 WHERE 的查询用。不带范围时都是空串，SQL 和原来逐字相同。
  const and = ranged ? ` AND ${RANGE}` : ""; const where = ranged ? ` WHERE ${RANGE}` : "";
  return {
    scope: hint(`SELECT MIN(\`交易日期wid\`) AS first_day, MAX(\`交易日期wid\`) AS last_day, COUNT(*) AS n, SUM(CASE WHEN ${SALE} AND \`是否会员销售（1：是，0：否）\` = '1' THEN \`实际销售金额\` ELSE 0 END) / SUM(CASE WHEN ${SALE} THEN \`实际销售金额\` ELSE 0 END) * 100 AS member_share FROM ${t}${where}`),
    panel: hint(`SELECT \`实体分店店号\` AS store, \`交易日期wid\` AS d, SUM(\`实际销售金额\`) AS sales, SUM(\`零售毛利\`) AS gp, SUM(\`rsv\`) / 1.13 AS rev_ex, SUM(\`销售件数\`) AS items,
      COUNT(DISTINCT \`销售单号\`) AS orders, SUM(CASE WHEN \`材料种类描述\` = '足金' THEN \`实际销售金额\` ELSE 0 END) AS gold,
      SUM(CASE WHEN \`材料种类描述\` = '足金' AND \`优惠小类\` = '一般開單' THEN \`实际销售金额\` ELSE 0 END) AS base_gold,
      SUM(CASE WHEN \`材料种类描述\` = '足金' AND \`销售金重\` >= 20 THEN \`实际销售金额\` ELSE 0 END) AS heavy_gold,
      SUM(CASE WHEN \`材料种类描述\` = '足金' THEN \`销售金重\` ELSE 0 END) AS gold_grams, SUM(CASE WHEN \`材料种类描述\` = '足金' THEN \`销售件数\` ELSE 0 END) AS gold_qty,
      MAX(CASE WHEN (${GROUP}) = 'k50' THEN 1 ELSE 0 END) AS k50, MAX(CASE WHEN (${GROUP}) = 'k30' THEN 1 ELSE 0 END) AS k30, MAX(CASE WHEN (${GROUP}) = 'gt' THEN 1 ELSE 0 END) AS gt
      FROM ${t} WHERE ${SALE} AND \`实体分店店号\` IS NOT NULL${and} GROUP BY 1, 2`),
    stores: hint(`SELECT \`实体分店店号\` AS store, ANY_VALUE(\`大区描述\`) AS big_region, ANY_VALUE(\`区域描述\`) AS region, ANY_VALUE(\`城市级别\`) AS city_tier, ANY_VALUE(\`形象级别描述\`) AS image,
      ANY_VALUE(\`铺型\`) AS shop_type, ANY_VALUE(\`分店性质\`) AS nature, ANY_VALUE(\`分店面积区间\`) AS area, ANY_VALUE(\`零售体验描述\`) AS experience, ANY_VALUE(\`店龄\`) AS age, ANY_VALUE(\`分店名称\`) AS name
      FROM ${t} WHERE ${SALE} AND \`实体分店店号\` IS NOT NULL${and} GROUP BY 1`),
    ptype: hint(`SELECT ${PTYPE} AS ptype, SUM(\`实际销售金额\`) AS sales, SUM(\`零售毛利\`) AS gp, SUM(\`rsv\`) / 1.13 AS rev_ex, SUM(\`销售件数\`) AS items, SUM(\`销售金重\`) AS grams FROM ${t} WHERE ${SALE}${and} GROUP BY 1`),
    daily: hint(`SELECT \`交易日期wid\` AS d, DAYOFWEEK(STR_TO_DATE(\`交易日期wid\`, '%Y%m%d')) - 1 AS dow, MAX(\`节庆\`) AS festival, SUM(\`实际销售金额\`) AS sales, COUNT(DISTINCT ${ORDER}) AS orders,
      SUM(CASE WHEN \`材料种类描述\` = '足金' THEN \`实际销售金额\` ELSE 0 END) AS gold,
      SUM(CASE WHEN \`材料种类描述\` = '足金' AND \`优惠小类\` = '一般開單' THEN \`实际销售金额\` ELSE 0 END) AS base_gold,
      SUM(CASE WHEN \`材料种类描述\` = '足金' AND \`优惠小类\` <> '一般開單' AND \`优惠小类\` NOT LIKE '%金色星期二%' THEN \`实际销售金额\` ELSE 0 END) AS promo_gold
      FROM ${t} WHERE ${SALE} GROUP BY 1, 2`),
    gold: hint(`SELECT \`交易日期wid\` AS d, ${GROUP} AS g, SUM(\`实际销售金额\`) AS amount, SUM(\`销售金重\`) AS grams, SUM(\`销售件数\`) AS qty,
      SUM(CASE WHEN \`销售金重\` >= 20 THEN \`实际销售金额\` ELSE 0 END) AS ge20
      FROM ${t} WHERE ${SALE} AND \`材料种类描述\` = '足金' AND \`业务小类描述\` = '一般足金类'${and} GROUP BY 1, 2`),
    threshold: hint(`SELECT FLOOR(\`销售金重\`) AS gram, SUM(CASE WHEN (${GROUP}) = 'k50' THEN \`销售件数\` ELSE 0 END) AS k50, SUM(CASE WHEN (${GROUP}) = 'base' THEN \`销售件数\` ELSE 0 END) AS base
      FROM ${t} WHERE ${SALE} AND \`材料种类描述\` = '足金' AND \`业务小类描述\` = '一般足金类' AND \`销售金重\` >= 15 AND \`销售金重\` < 25${and} GROUP BY 1`),
    tradein: `WITH o AS (SELECT /*+ MAX_EXECUTION_TIME(${QUERY_TIMEOUT_MS}) */ \`实体分店店号\` AS s, \`销售单号\` AS n, ${GROUP} AS g, SUM(\`实际销售金额\`) AS a FROM ${t} WHERE ${SALE} AND \`销售单号\` IS NOT NULL${and} GROUP BY 1, 2, 3),
      r AS (SELECT \`实体分店店号\` AS s, \`销售单号\` AS n, -SUM(\`实际销售金额\`) AS a FROM ${t} WHERE ${RECYCLE} AND \`销售单号\` IS NOT NULL${and} GROUP BY 1, 2)
      SELECT o.g AS g, COUNT(*) AS orders, COUNT(r.s) AS trade_in, SUM(o.a) AS sales, COALESCE(SUM(r.a), 0) AS recycle FROM o LEFT JOIN r ON r.s = o.s AND r.n = o.n GROUP BY 1`,
  };
}

// 每条查询的日期参数：tradein 两个子查询各一对，逐日不带。
export function insightParams(name: string, range: InsightRange | null): string[] {
  if (!range || name === "daily") return [];
  return name === "tradein" ? [range.from, range.to, range.from, range.to] : [range.from, range.to];
}
export class InsightRangeError extends Error {}

const num = (value: unknown) => value === null || value === undefined || value === "" ? 0 : Number(value);
const str = (value: unknown) => value === null || value === undefined ? "未知" : String(value);
const group = (value: unknown): OfferGroup => (["base", "k50", "k30", "gt"] as const).find((g) => g === value) ?? "other";
const rowsOf = (result: unknown): Array<Record<string, unknown>> => { if (!Array.isArray(result)) throw new Error("洞察查询结果格式不正确"); return result as Array<Record<string, unknown>>; };

export function toDriverData(results: Record<string, unknown>, datasetVersion: string, window: InsightRange | null = null): DriverData {
  const scope = rowsOf(results.scope)[0] ?? {};
  const first = str(scope.first_day); const last = str(scope.last_day);
  const daily = rowsOf(results.daily).map((r): DailyRow => ({ day: str(r.d), dow: num(r.dow), festival: r.festival ? String(r.festival) : null, sales: num(r.sales), orders: num(r.orders), goldSales: num(r.gold), baseGold: num(r.base_gold), promoGold: num(r.promo_gold) }));
  // 逐日始终是全部日期：数据本身的起止从这里取。
  const days = daily.map((d) => d.day).sort();
  const dataFrom = days[0] ?? first; const dataTo = days.at(-1) ?? last;
  const full = isFullRange(window, dataFrom, dataTo);
  // 窗口正好是某个节日时，范围名前面写节日名。
  const festival = window ? festivalsOf(daily).find((f) => f.from === window.from && f.to === window.to) : undefined;
  const monthly = /^\d{8}$/.test(first) && /^\d{8}$/.test(last) ? first.slice(0, 6) === last.slice(0, 6) ? `${first.slice(0, 4)} 年 ${Number(first.slice(4, 6))} 月` : `${first.slice(0, 4)}-${first.slice(4, 6)}-${first.slice(6)} 至 ${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6)}` : "未知";
  return {
    datasetVersion, rows: num(scope.n), memberShare: num(scope.member_share),
    window: full ? null : window, dataFrom, dataTo,
    period: full || !window ? monthly : `${festival ? `${festival.name} ` : ""}${rangeLabel(window)}`,
    panel: rowsOf(results.panel).map((r): PanelRow => ({ store: str(r.store), day: str(r.d), sales: num(r.sales), gp: num(r.gp), revEx: num(r.rev_ex), items: num(r.items), orders: num(r.orders), goldSales: num(r.gold), baseGold: num(r.base_gold), heavyGold: num(r.heavy_gold), goldGrams: num(r.gold_grams), goldQty: num(r.gold_qty), k50: num(r.k50), k30: num(r.k30), gt: num(r.gt) })),
    stores: rowsOf(results.stores).map((r): StoreRow => ({ store: str(r.store), bigRegion: str(r.big_region), region: str(r.region), cityTier: str(r.city_tier), image: str(r.image), shopType: str(r.shop_type), nature: str(r.nature), area: str(r.area), experience: str(r.experience), age: r.age === null || r.age === undefined || r.age === "" ? null : Number(r.age), name: r.name ? String(r.name) : "" })),
    ptype: rowsOf(results.ptype).map((r): PtypeRow => ({ ptype: (["计价金", "一口价黄金"] as const).find((p) => p === r.ptype) ?? "镶嵌及其他", sales: num(r.sales), gp: num(r.gp), revEx: num(r.rev_ex), items: num(r.items), grams: num(r.grams) })),
    daily,
    gold: rowsOf(results.gold).map((r): GoldRow => ({ day: str(r.d), group: group(r.g), amount: num(r.amount), grams: num(r.grams), qty: num(r.qty), ge20: num(r.ge20) })),
    threshold: rowsOf(results.threshold).map((r): ThresholdRow => ({ gram: num(r.gram), k50: num(r.k50), base: num(r.base) })),
    tradein: rowsOf(results.tradein).map((r): TradeInRow => ({ group: group(r.g), orders: num(r.orders), tradeIn: num(r.trade_in), sales: num(r.sales), recycle: num(r.recycle) })),
  };
}

export function createInsightGraphService(config: Config): InsightGraphService {
  const logger = config.logger ?? console;

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

  // 带磁盘缓存地跑查询：键是数据版本 + SQL（+ 日期参数），数据一变自然失效；缓存坏了就重查。
  // 不带参数时键和原来一样，已有的磁盘缓存继续命中。
  async function cachedAll(version: string, queries: Array<{ sql: string; params: string[] }>): Promise<unknown[]> {
    const dir = config.cacheDir;
    if (!dir) return runAll(queries);
    const files = queries.map((q) => join(dir, `${createHash("sha256").update(JSON.stringify(q.params.length ? [version, q.sql, q.params] : [version, q.sql])).digest("hex").slice(0, 32)}.json`));
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

  // 数据版本和起止日期：只查一次，范围校验要用起止日期。
  let meta: Promise<{ version: string; dataFrom: string; dataTo: string }> | null = null;
  function versionOf() {
    meta ??= runAll([{ sql: `SELECT /*+ MAX_EXECUTION_TIME(${QUERY_TIMEOUT_MS}) */ COUNT(*) AS n, MIN(\`交易日期wid\`) AS min_day, MAX(\`交易日期wid\`) AS max_day FROM \`${config.table}\``, params: [] }])
      .then(([stats]) => { const row = (stats as Array<{ n: unknown; min_day: unknown; max_day: unknown }>)[0];
        return { version: `${config.table}:${num(row?.n)}:${String(row?.max_day ?? "")}`, dataFrom: String(row?.min_day ?? ""), dataTo: String(row?.max_day ?? "") }; })
      .catch((error) => { meta = null; throw error; });
    return meta;
  }

  async function build(range: InsightRange | null, version: string): Promise<InsightGraph> {
    const started = performance.now();
    const queries = insightQueries(config.table, Boolean(range));
    const names = Object.keys(queries) as Array<keyof typeof queries>;
    const results = await cachedAll(version, names.map((k) => ({ sql: queries[k], params: insightParams(k, range) })));
    const graph = buildDriverGraph(toDriverData(Object.fromEntries(names.map((k, i) => [k, results[i]])), version, range));
    const elapsed = Math.round(performance.now() - started);
    logger.log(`[insight] 影响因素图谱算好${range ? `（${range.from}–${range.to}）` : ""}，共 ${elapsed}ms`);
    // 证据文件只写全月那份，和原来一样。
    if (!range) void mkdir(config.evidenceDir, { recursive: true, mode: 0o700 })
      .then(() => writeFile(join(config.evidenceDir, `insight-drivers-${createHash("sha256").update(version).digest("hex").slice(0, 8)}.json`), JSON.stringify({ schema: "ctf-insight-evidence/v2", datasetVersion: version, builtAt: graph.builtAt, elapsedMs: elapsed, queries }, null, 2), { flag: "wx", mode: 0o600 }))
      .catch((error) => { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") logger.error(`[insight] 证据写入失败：${error instanceof Error ? error.message : error}`); });
    return graph;
  }

  // 按范围缓存，最多 8 份，超出淘汰最久没用的；全月用键 "all"，预热过的全月图不淘汰（问答、首页都靠它）。
  // 等到版本之后同步查缓存、同步放入，中间没有 await，同范围并发只会算一次。
  const CACHE_LIMIT = 8;
  const cache = new Map<string, Promise<InsightGraph>>();
  async function graph(range: InsightRange | null = null): Promise<InsightGraph> {
    const { version, dataFrom, dataTo } = await versionOf();
    if (range) { try { checkRange(range, dataFrom, dataTo); } catch (error) { throw new InsightRangeError(error instanceof Error ? error.message : "范围不正确"); } }
    const window = isFullRange(range, dataFrom, dataTo) ? null : range;
    const key = window ? `${window.from}-${window.to}` : "all";
    const existing = cache.get(key);
    if (existing) { cache.delete(key); cache.set(key, existing); return existing; }
    // 失败时只删自己这一份：期间被淘汰、又重新发起的同一范围不能被误删。
    const hit: Promise<InsightGraph> = build(window, version).catch((error) => { if (cache.get(key) === hit) cache.delete(key); throw error; });
    cache.set(key, hit);
    while (cache.size > CACHE_LIMIT) { const oldest = [...cache.keys()].find((k) => k !== "all"); if (!oldest) break; cache.delete(oldest); }
    return hit;
  }

  // 启动时预热：库上还有别的预热在跑，查询可能超时；失败等一会儿再试一次。只预热全月。
  async function warm(): Promise<void> {
    try { await graph(); }
    catch { await new Promise((r) => setTimeout(r, 10_000)); await graph().catch((error) => logger.error(`[insight] 预热失败：${error instanceof Error ? error.message : error}`)); }
  }

  return { graph, warm };
}
