# 智能洞察关系图谱 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/analysis` 里加「智能洞察 / 智能问答」两种模式。洞察模式是以可切换目标指标为中心的关系图谱：点节点看事实，点连线看依据、异常、推荐；能带上下文切到问答，也能把推荐变成一句草稿话去建活动。

**Architecture:** 图谱由 Agent 服务从 MySQL 离线算出，按「门店 × 日 × 优惠 × 维度取值」分组的立方数据在 Node 里组合，结果按 datasetVersion 缓存在内存和 evidence 目录，点击时不查库。领域计算（指标、本体、打分）是 `app/lib/insight/` 下的纯函数，测试不需要数据库。页面侧 `/api/analytics/insight` 转发到 Agent 的 `GET /insight/graph`。问答侧只做两处改动：请求的 `context` 里带一句洞察上下文；回答带出用到的维度，供「在图上看」使用。

**Tech Stack:** TypeScript（Node 22 strip-types）、mysql2（只在 agent/）、React（vinext）、node:test。图用自绘 SVG，不引新依赖。

依据：`docs/superpowers/specs/2026-10-19-insight-graph-design.md`。

## Global Constraints

- `app/lib/insight/**` 不 import npm 包，相对 import 写全 `.ts`，不用 enum、namespace、构造函数参数属性。前端组件照常用 `@/`。
- 代码注释、界面文案、错误信息用中文。
- 数据只读：只发 SELECT。表名来自 `CTF_INSIGHT_TABLE`，默认用源表 `sales_detail_202508`：问答用的投影表 `sales_analysis_202508` 没有 `回收金标识` 和 `sku年龄` 两列（2026-10-19 实测）。列名只用语义层已有的列，再加这两列。表里缺某列时，相应的指标族降级为虚线并写明原因，不报错。
- 所有数字由代码算；侧栏文字第一版用代码模板拼，不调模型。
- 推荐措辞固定为「8 月里……表现最好」，不出现「会」「将」「提升」这类预测词。
- 「按这个建活动」只把一句草稿话填进输入框，不调 `createSessionRequest`，不写事实层。
- 每个样本格子的行数 ≥ 500 才参与异常和推荐；不够的标「样本少」。
- 不 `git commit`，由控制者统一提交。

## File Structure

| 文件 | 职责 |
|---|---|
| `app/lib/insight/types.ts` | `InsightGraph`、`InsightNode`、`InsightEdge`、`InsightCell`（立方格子）、`InsightRequest` |
| `app/lib/insight/metrics.ts` | 目标指标目录（7 族）：id、族、口径、数据状态、`compute(cell 汇总)` |
| `app/lib/insight/ontology.ts` | 维度分组（品类 / 参数 / 门店 / 节日 / 人）、待采集项、指标分解树和取舍边 |
| `app/lib/insight/offer-params.ts` | 从优惠名解析克减金额、折扣（「推断」） |
| `app/lib/insight/score.ts` | 立方格子 → 节点事实、连线强度、异常、推荐、侧栏文字 |
| `app/lib/insight/context.ts` | 洞察上下文 ↔ 问答 `context` 字符串；回答 → 图上定位；推荐 → 草稿话 |
| `agent/insight-graph.ts` | 拼 SQL、跑查询、调 `score.ts`、缓存和写证据文件 |
| `agent/http-handler.ts`、`agent/server.ts` | `GET /insight/graph` |
| `app/lib/server/runtime.ts`、`app/api/analytics/insight/route.ts` | Workers 转发 |
| `app/components/insight/insight-workspace.tsx` | 顶部筛选、图、侧栏的组合 |
| `app/components/insight/insight-graph-view.tsx` | SVG 径向图 |
| `app/components/insight/insight-side-panel.tsx` | 节点、连线、指标三种侧栏 |
| `app/components/analytics/analysis-modes.tsx` | 模式开关；两个模式同时挂载 |
| `app/analysis/page.tsx` | 改用 `AnalysisModes` |
| `app/components/analytics/history-conversation.tsx` | 接收洞察上下文标签、外部填入草稿 |
| `app/components/analytics/history-message.tsx` | 回答下方的「在图上看」 |
| `tests/insight-*.test.ts` | 见各任务 |

---

### Task 1: 类型、指标目录、本体、优惠参数解析

**Files:**
- Create: `app/lib/insight/types.ts`、`metrics.ts`、`ontology.ts`、`offer-params.ts`
- Test: `tests/insight-metrics.test.ts`

**Interfaces:**
```ts
// types.ts
export type InsightDimensionId = "materialGroup" | "category" | "priceBand" | "keySeries" | "offerDepth" | "itemWeight" | "storeArea" | "salesLevel" | "cityTier" | "shopType" | "region" | "storeAge" | "storeType" | "festival" | "dayType";
export type InsightGroupId = "product" | "param" | "store" | "time" | "people";
export type InsightMetricId = "lift_per_gram" | "lift_per_store_day" | "penetration" | "give_per_gram" | "discount_rate" | "margin_rate" | "grams_per_item" | "items_per_order" | "amount_per_order" | "trade_in_rate" | "aged_share" | "key_series_share" | "return_rate";
export type InsightStatus = "real" | "inferred" | "missing";  // 实线 / 实线带推断 / 虚线黄框

// 立方的一个格子：一个维度取值 × 一侧（活动 / 对照） × 一天，基础字段已汇总。
export type InsightCell = { value: string; side: "offer" | "base"; day: string; rows: number; stores: number; amount: number; grams: number; quantity: number; tagAmount: number; profit: number; orders: number; lines: number; tradeInOrders: number; agedAmount: number; keySeriesAmount: number; returnAmount: number };
export type InsightRequest = { metric: InsightMetricId; offer: string; category: string };  // offer 为 "克减类" 或具体优惠名
export type InsightFact = { label: string; value: string };
export type InsightEdge = { dimension: InsightDimensionId; status: InsightStatus; strength: number | null; weak: boolean; basis: string[]; anomalies: string[]; recommendation: string | null; draft: string | null; table: Array<{ value: string; offer: number | null; base: number | null; delta: number | null; rows: number; small: boolean }> };
export type InsightNode = { id: string; kind: "metric" | "group" | "dimension" | "missing"; label: string; group?: InsightGroupId; status: InsightStatus; facts: InsightFact[]; note?: string };
export type InsightGraph = { schema: "insight-graph/v1"; datasetVersion: string; builtAt: string; request: InsightRequest; metric: { id: InsightMetricId; label: string; unit: string; definition: string; offer: number | null; base: number | null; delta: number | null }; nodes: InsightNode[]; edges: InsightEdge[]; decomposition: Array<{ label: string; offer: number | null; base: number | null; share: number | null }>; limitations: string[] };
```

`metrics.ts` 导出 `INSIGHT_METRICS: Record<InsightMetricId, { label; family: "卖得多"|"让得少"|"赚得多"|"买得大"|"换得多"|"去库存"|"留得住"; unit; definition; status: InsightStatus; higherIsBetter: boolean; compute(sum: CellSum, side): number | null }>`，以及 `MISSING_METRICS`（新客、复购、客流、转化、ROI、用券：label + 需要采集的数据）。`CellSum` 是 `InsightCell` 去掉 value/side/day 后的累加结果，再加 `days`（去重日数）。口径：

- `lift_per_gram`：活动每克实收 − 对照每克实收，**按日对齐**，即逐日求差后按活动侧克重加权平均（在 `score.ts` 里算，`compute` 返回每克实收）。
- `give_per_gram`：对照每克实收 − 活动每克实收，同样按日对齐。
- `lift_per_store_day`：实收 ÷ 门店数 ÷ 日数。
- `penetration`：活动侧实收 ÷（活动 + 对照）实收。
- `discount_rate`：(牌价 − 实收) ÷ 牌价 × 100，状态 `inferred`。
- `margin_rate`：毛利 ÷ 实收 × 100，状态 `inferred`。
- `grams_per_item`：克重 ÷ 件数；`items_per_order`：lines ÷ orders；`amount_per_order`：实收 ÷ orders。
- `trade_in_rate`：tradeInOrders ÷ orders × 100。
- `aged_share`：agedAmount ÷ 实收 × 100；`key_series_share`：keySeriesAmount ÷ 实收 × 100；`return_rate`：returnAmount ÷ 实收 × 100。

`ontology.ts` 导出：
- `INSIGHT_GROUPS`：五组，每组含 `dimensions: InsightDimensionId[]` 和 `missing: Array<{ label; need }>`。参数组的 missing 是门槛、叠加、封顶、允许货类（需要 Discount 规则表）；人组的 missing 是会员等级、客群（需要会员 ID），以及店员（字段 `操作人code` 已有，未纳入）。
- `INSIGHT_DIMENSIONS: Record<InsightDimensionId, { label; group; sql: string; status; note? }>`：`sql` 是取值表达式。语义层已有的维度复用 `SEMANTIC_DIMENSIONS[id].source` 的列名；`offerDepth`、`itemWeight` 是新加的（见下）。草图里「加工 / 非加工」对应的 `category`，note 写成「计价类对应加工、定价类对应非加工，推断」。
- `itemWeight`：`CASE WHEN 销售件数>0 THEN CASE WHEN 销售金重/销售件数<2 THEN '<2克' WHEN <5 THEN '2-5克' WHEN <10 THEN '5-10克' WHEN <20 THEN '10-20克' ELSE '20克以上' END END`。
- `offerDepth`：不进 SQL，在 Node 里用 `offer-params.ts` 从优惠名映射，`sql` 填 `优惠小类`，`status: "inferred"`。
- `DECOMPOSITION`：订单数 × 单均行数 × 单件克重 × 每克实收 = 实收（单均行数用 lines/orders 近似件数，注明）。
- `TRADEOFFS`：`[["give_per_gram","grams_per_item"],["give_per_gram","margin_rate"],["trade_in_rate","items_per_order"]]`，作为指标层的边，状态 `inferred`。

`offer-params.ts`：`offerDepth(name: string): string | null`。`/克[减減](\d+)/` → `克减${n}元`；`/(\d{2})折/` → `${n}折`；`金色星期` → `以旧换新`；其余返回 null（归入「其他」）。

- [ ] **Step 1: 写失败测试** `tests/insight-metrics.test.ts`：
  - `offerDepth("H-克减30元") === "克减30元"`、`offerDepth("EF区八月周末克減30") === "克减30元"`、`offerDepth("H-定价类92折") === "92折"`、`offerDepth("H-金色星期二") === "以旧换新"`、`offerDepth("WAB-F类") === null`。
  - 每个 `InsightDimensionId` 都恰好属于一个组；每个 `InsightMetricId` 在 `INSIGHT_METRICS` 里都有定义，且 `family` 属于 7 族之一。
  - `compute`：手造一个 `CellSum`（amount 1000、grams 1、quantity 2、orders 2、lines 3、tradeInOrders 1、tagAmount 1100、profit 100），断言 `grams_per_item` 0.5、`items_per_order` 1.5、`trade_in_rate` 50、`discount_rate` ≈ 9.09、`margin_rate` 10；分母为 0 时返回 null。
- [ ] **Step 2:** `node --test --experimental-strip-types tests/insight-metrics.test.ts`，预期失败（模块不存在）。
- [ ] **Step 3:** 实现四个文件。
- [ ] **Step 4:** 再跑，预期全部通过；`npx tsc --noEmit` 通过。

### Task 2: 打分 `score.ts`

**Files:**
- Create: `app/lib/insight/score.ts`
- Test: `tests/insight-score.test.ts`

**Interfaces:**
```ts
export type DimensionCube = { dimension: InsightDimensionId; cells: InsightCell[] };
export function buildInsightGraph(input: { request: InsightRequest; datasetVersion: string; builtAt: string; total: InsightCell[]; cubes: DimensionCube[]; unavailable: Partial<Record<InsightDimensionId, string>>; missingMetrics?: string[] }): InsightGraph;
```

`total` 是只按 side × day 汇总的格子（value 填 "全部"）。算法：

1. **指标值**：对 side 分别累加成 `CellSum`，用 `INSIGHT_METRICS[m].compute`。`lift_per_gram`、`give_per_gram` 用 `alignedPerGramDelta(cells)`：对活动侧和对照侧都有克重的日子，逐日计算 `offerPerGram − basePerGram`，再按活动侧克重加权平均；没有同日对照的日子丢弃，丢弃的克重占比 > 20% 时在 limitations 里写明。`delta` 对这两个指标就是它本身，`offer`、`base` 填非对齐的整体值。其他指标的 `delta = offer − base`；`penetration` 只有 offer 值。
2. **每条连线**：每个取值算一遍第 1 步，得到 `table` 行。`small = rows < 500`（两侧合计）。只用非 small 行：
   - `strength`：delta 的极差 ÷ 全体 |delta| 的中位数（中位数为 0 时用极差 ÷ 1），截到 0–1 之间（÷ 3 后再截断）；非 small 行少于 2 个时为 null。`weak = strength === null || strength < 0.2`。
   - `basis`（依据）最多 3 条：①「{最高取值} 的{指标}比 {最低取值} {高/低} {差值}{单位}」；②方向一致性：再按「H-克减30元 / H-克减50元 / 其他」三个优惠（只在 offer 为克减类时）分别排序，最高取值相同时写「换成不同的克减优惠，排在最前的都是 {取值}」，否则写「不同优惠下排序不一致，关系不稳」；③样本量：「{n} 个取值样本够，{k} 个样本少未计入」。
   - `anomalies`（异常）：用 delta 的中位数 ± 2.5 × MAD（MAD 为 0 时跳过）找出离群的取值，每个写一条，内容为「{取值}：{指标} {值}，偏离中位数 {x}{单位}」，并附一句可能原因：该取值的活动侧单件克重和整体相比差异 > 30% 时写「货品结构不同（单件克重 {a} vs 整体 {b}）」；门店数 < 30 时写「只有 {n} 家店」；否则写「原因待查」。
   - `recommendation`（推荐）：按 `higherIsBetter` 取最优取值，写成「8 月里 {取值} 的{指标}表现最好（{值}{单位}）」。搭配：调用方传入的 `pairs`（见第 3 点）里，包含这个最优取值的两两组合中排第一的那个，追加「；搭配 {另一维度}={取值} 时最好（{值}{单位}，{rows} 行）」。
   - `draft`：`draftFor(request, dimension, bestValue)`，放在 `context.ts` 里。
3. **两两搭配**：`buildInsightGraph` 可选接收 `pairs: Array<{ a: [InsightDimensionId, string]; b: [InsightDimensionId, string]; cells: InsightCell[] }>`，由 Agent 侧只为每条连线的最优取值查一次（Task 3）。第一版允许 pairs 为空，这时推荐里不写搭配。
4. **节点**：中心指标节点的 facts 是活动值、对照值、差值、行数、门店数；组节点；维度节点的 facts 是取值个数、覆盖行数、前三个取值的行数占比，status 取维度的 status，`unavailable` 里的维度为 missing 并写 note；ontology 里的 missing 项和 `MISSING_METRICS` 都生成 `kind: "missing"` 的节点。
5. **分解**：`DECOMPOSITION` 四段分别算 offer / base，再算 `share`：用对数分解，`ln(offer/base)` 按各段的 `ln` 差值分摊，四段 share 之和为 1；任一段 ≤ 0 或缺失时 share 全部为 null。
6. **limitations**：固定 4 条（只有 8 月、优惠非随机分配、一般開單作对照是推断、门槛规则缺失），再加上第 1 步的丢弃说明。

- [ ] **Step 1: 写失败测试** `tests/insight-score.test.ts`，用手造格子：
  - 同日对齐：两天，第 1 天活动 1000 元 / 1 克、对照 1100 元 / 1 克；第 2 天活动 2000 元 / 2 克、对照 2100 元 / 2 克（每克 1050），断言 `give_per_gram` 的 delta 为 (100×1 + 50×2) / 3 ≈ 66.67。非对齐的整体值不一样，用来证明确实做了对齐。
  - 强度和弱关系：五个取值 delta 相同时 `weak === true`；有一个明显不同时 `strength > 0.2`。
  - 样本少：rows 300 的取值 `small === true`，不出现在 basis 的最高、最低里，也不出现在 recommendation 里。
  - 异常：七个取值中六个 delta ≈ 10、一个 delta = 80，anomalies 恰好 1 条，且包含该取值名。
  - 推荐措辞：包含「8 月里」，不包含「会」「将」「提升」。
  - `unavailable`：传 `{ offerDepth: "…" }` 时，该维度节点 status 为 `missing`，且没有对应 edge。
  - 分解：四段 share 之和 ≈ 1。
- [ ] **Step 2:** 跑测试，预期失败。
- [ ] **Step 3:** 实现 `score.ts`（文字模板放在同一个文件，用小函数拼）。
- [ ] **Step 4:** 再跑，预期通过；`npx tsc --noEmit` 通过。

### Task 3: 上下文、草稿话、回答定位 `context.ts`

**Files:**
- Create: `app/lib/insight/context.ts`
- Test: `tests/insight-context.test.ts`

**Interfaces:**
```ts
export type InsightFocus = { metric: InsightMetricId; offer: string; category: string; dimension?: InsightDimensionId; value?: string };
export function focusLabel(focus: InsightFocus): string;        // 「克减类 × 城市级别 → 每克让利」，有 value 时加「（一线城市）」
export function focusContext(focus: InsightFocus): string;      // 放进问答 context 的一句：「用户正在看洞察图谱：目标指标 每克让利，优惠 克减类，货类 一般足金类，维度 城市级别=一线城市。没有明确改变时沿用这个范围。」
export function draftFor(request: InsightRequest, dimension: InsightDimensionId, value: string): string;  // 「8 月数据里一般足金类的克减类活动在城市级别为一线城市的门店表现较好，帮我按这个思路建一个活动：」
export function locateAnswer(dimensionIds: readonly string[]): InsightDimensionId | null;  // 语义层维度 id → 图上维度，取第一个能对上的
export function parseFocus(search: string): InsightFocus | null;  // 从 URL ?metric=&offer=&category=&dim=&value= 解析并校验
export function focusSearch(focus: InsightFocus): string;
```

草稿话结尾留冒号，日期、门店、力度都不写，让用户在建活动对话里补上；这样就不会把推荐值写成人定字段的默认值。`locateAnswer` 的映射：语义层 id 和图上 id 相同的直接用；`offer` → `offerDepth`；`store`、`day`、`sku` 返回 null。

- [ ] **Step 1: 写失败测试**：`focusLabel` 和 `focusContext` 的文本；`draftFor` 不包含任何数字以外的日期格式（`/\d{1,2}月\d{1,2}日|\d{4}-\d{2}/` 不匹配）且以「：」结尾；`parseFocus` 拒绝未知 metric 或 dim，并截断超过 40 字的 value；`focusSearch` 和 `parseFocus` 能互相还原；`locateAnswer(["store","cityTier"]) === "cityTier"`、`locateAnswer(["store"]) === null`。
- [ ] **Step 2–4:** 红 → 实现 → 绿，`npx tsc --noEmit`。

### Task 4: Agent 侧查询与接口

**Files:**
- Create: `agent/insight-graph.ts`
- Modify: `agent/http-handler.ts`（新增 `GET /insight/graph?metric=&offer=&category=`）、`agent/server.ts`（组装并在后台预热默认图）
- Test: `tests/insight-agent.test.ts`（用假的 connection 记录 SQL，验证 SQL 形状和缓存；不连库）

**Interfaces:**
```ts
export type InsightGraphService = { graph(request: InsightRequest, signal?: AbortSignal): Promise<InsightGraph> };
export function createInsightGraphService(config: { table: string; evidenceDir: string; connect: () => Promise<HistoryConnection>; datasetVersion: () => Promise<string> }): InsightGraphService;
export function buildInsightCubeSql(table: string, dimension: InsightDimensionId | null, request: InsightRequest, columns: ReadonlySet<string>): { sql: string; params: string[] };
```

SQL（每个维度一条，`dimension === null` 时为 total）：
```sql
SELECT {维度表达式} AS v, 交易日期wid AS d,
  CASE WHEN 优惠小类 = '一般開單' THEN 'base' ELSE 'offer' END AS side,
  COUNT(*) rows, COUNT(DISTINCT 实体分店店号) stores,
  SUM(CASE WHEN 实际销售金额 > 0 THEN 实际销售金额 END) amount, SUM(CASE WHEN 实际销售金额 > 0 THEN 销售金重 END) grams,
  SUM(CASE WHEN 实际销售金额 > 0 THEN 销售件数 END) quantity, SUM(CASE WHEN 实际销售金额 > 0 THEN 销售牌仔价 END) tag,
  SUM(CASE WHEN 实际销售金额 > 0 THEN 零售毛利 END) profit, COUNT(DISTINCT CONCAT(实体分店店号, '/', 销售单号)) orders,
  SUM(CASE WHEN 销售单号 IS NOT NULL THEN 1 ELSE 0 END) lines,
  {回收列存在时 COUNT(DISTINCT CASE WHEN `回收金标识：1：是，0：否` = '1' THEN CONCAT(实体分店店号, '/', 销售单号) END) 否则 NULL} trade_in,
  {sku年龄列存在时 SUM(CASE WHEN 实际销售金额 > 0 AND sku年龄 >= 365 THEN 实际销售金额 END) 否则 NULL} aged,
  SUM(CASE WHEN 实际销售金额 > 0 AND 是否重点系列描述 = '重点系列' THEN 实际销售金额 END) key_amt,
  SUM(CASE WHEN 实际销售金额 < 0 AND {回收列存在时 `回收金标识：1：是，0：否` <> '1' 否则 TRUE} THEN -实际销售金额 END) returns
FROM {table}
WHERE 业务小类描述 = ? AND (优惠小类 = '一般開單' OR {offer 条件})
GROUP BY v, d, side
```

- offer 条件：`offer === "克减类"` 时为 `优惠小类 REGEXP '克[减減]'`；否则为 `优惠小类 = ?`（参数化）。`offer` 必须是 `"克减类"` 或 `inspect` 时读到的优惠名之一，`category` 必须是已知货类之一，否则返回 400。
- `offerDepth` 维度：SQL 里按 `优惠小类` 分组，Node 侧用 `offerDepth()` 映射后再合并；base 侧的取值统一记作「一般開單」，合并时把同日的 base 行复制到每个 depth 取值下，作为共同对照。
- 维度表达式复用 `agent/analytics-operation-database.ts` 里的 `dimensionExpression`，需要把它改成导出（只加 `export`，不改行为）。语义层没有的 `itemWeight` 用 ontology 的 sql。表里缺列的维度（用 `SHOW COLUMNS` 判断）放进 `unavailable`。
- 订单数是在格子内去重的，合并格子时不能直接相加。第一版的处理：`items_per_order`、`amount_per_order`、`trade_in_rate` 的 total 值直接取 total 查询，单个维度取值内跨日累加，并在 limitations 里注明「订单按日去重」。
- 并发：最多 3 条查询同时跑，每条超时 60 秒（`ANALYSIS_DATABASE_QUERY_TIMEOUT_MS`）。
- 搭配 pairs：主查询完成后，对每条非 weak 连线的最优取值 x，再查一次「固定 x，按其余维度分组」（`WHERE {dim}=x`，GROUP BY 其余各维度的取值……为控制查询数，只对强度排前 4 的连线做，每条查一次，GROUP BY 一个 `CONCAT_WS('|', 维度表达式...)`），在 Node 里拆开。
- 缓存：`Map<datasetVersion + JSON(request), Promise<InsightGraph>>`，最多 20 个；失败的 Promise 要移除。写 `insight-<datasetVersion>-<hash>.json` 到 evidenceDir（`flag: "wx"`，已存在就跳过），内容含 SQL 和参数。
- `server.ts`：在 `database` 存在时创建 service；启动后在后台跑一次 `{ metric: "give_per_gram", offer: "克减类", category: "一般足金类" }` 预热，失败只打日志。
- `datasetVersion`：用 `database.inspect()` 返回的信息里的版本或行数加最大日期；读一下 `DatabaseSummary` 类型决定取哪个字段。

- [ ] **Step 1: 写失败测试**：`buildInsightCubeSql` 对「克减类」生成 REGEXP 条件且 params 只有货类；对具体优惠，params 里有优惠名，SQL 里不出现优惠原文；缺回收列时 SQL 里出现 `NULL trade_in`；service 对同一请求只连一次库（假 connect 计数）；非法 metric 抛出 `InsightRequestError`。
- [ ] **Step 2–4:** 红 → 实现 → 绿；`npx tsc -p agent/tsconfig.json`。
- [ ] **Step 5: 真库冒烟**（需要 3308）：写一个临时脚本放在 `agent/` 下，调 service 拿默认图，打印每条连线的 strength 和推荐，以及总耗时。预期总耗时 < 60 秒，H-克减50 的单件克重明显高于一般開單（实测 18.4 vs 8.5）。用完删掉脚本。

### Task 5: Workers 转发

**Files:**
- Modify: `app/lib/server/runtime.ts`（`fetchInsightGraph(search, signal)`，仿照 `inspectHistoryDatabase`）
- Create: `app/api/analytics/insight/route.ts`

```ts
export function GET(request: Request) {
  return analyticsResponse(request, async () => fetchInsightGraph(new URL(request.url).search, request.signal));
}
```
只透传 `metric`、`offer`、`category` 三个参数（在 route 里用 `URLSearchParams` 重新拼一遍，丢掉其余参数）。Agent 返回 4xx 时把它的中文 error 原样转出；超时 90 秒。

- [ ] **Step 1:** 实现；`npx tsc --noEmit`。
- [ ] **Step 2:** 起 `npm run dev:all`，用 `curl -s 'http://127.0.0.1:5173/api/analytics/insight?metric=give_per_gram&offer=克减类&category=一般足金类' | head -c 600` 能拿到 `insight-graph/v1`。

### Task 6: 洞察界面

**Files:**
- Create: `app/components/insight/insight-workspace.tsx`、`insight-graph-view.tsx`、`insight-side-panel.tsx`

布局：顶部一行筛选（目标指标下拉，按 7 族分组，并列出没有数据的指标，选中时提示「需要采集：…」；优惠下拉，默认「克减类」，另有 H-克减30元、H-克减50元、七夕克减50、H-金色星期二、H-定价类92折；货类下拉，默认一般足金类）。下面左边是图，右边是 380px 的侧栏，宽度 < 1280px 时侧栏改成底部抽屉，复用 `WorkspacePanel` 的 Sheet 模式或直接放在图下方。

图（`insight-graph-view.tsx`）：
- 用 SVG，`viewBox` 固定 1000×700，宽度 100%。中心指标节点放在中间；五个组节点按 72° 均匀分布在半径 210 的圆上；维度节点在各组的扇区里，以半径 340 均匀排开；missing 节点排在最外圈（半径 420），用虚线描边加 `#fff8e1` 底色和 `#e0b84c` 边框。
- 连线：中心 → 组画细灰线；组 → 维度画指标连线，线宽 = 1.5 + strength × 6，weak 时用灰色 `#c5d0dc`，否则用 `#247cff`；status 为 inferred 时用实线加一个小「推」字标；missing 时画虚线（`stroke-dasharray="6 5"`）。
- 指标节点下面挂一行分解条，四段，宽度按 share 比例分配；share 为 null 时不画。
- 选中的节点或连线加粗高亮；节点、连线都是 `<g role="button" tabIndex={0} aria-label=…>`，回车和空格可以触发；连线另外加一条透明的 14px 粗线，方便点中。
- 颜色用页面已有的 token，不用 `prefers-color-scheme`（全站目前是浅色）。

侧栏（`insight-side-panel.tsx`）三种状态：
- 指标：口径、活动 / 对照 / 差值、分解四段、limitations。
- 节点：facts 列表、note；missing 节点显示「需要采集：…」。
- 连线：依据、异常、推荐三段，下面是取值表（取值、活动、对照、差值、行数，small 的行灰显并标「样本少」）。底部两个按钮：「问一问」调 `onAsk(focus)`；「按这个建活动」调 `onDraft(edge.draft)`，没有 draft 时禁用。

数据加载：`insight-workspace.tsx` 用 `analyticsRequest<InsightGraph>("/api/analytics/insight?" + …)`，切换筛选时取消上一次请求。加载中显示骨架和「第一次计算约需 30 秒，之后会很快」；失败显示错误和「重试」。选中状态和筛选写进 URL（`focusSearch`），用 `router.replace`，不产生新的历史记录。

```ts
export function InsightWorkspace(props: { focus: InsightFocus | null; highlight?: InsightDimensionId | null; onAsk: (focus: InsightFocus) => void; onDraft: (text: string) => void }): JSX.Element;
```

- [ ] **Step 1:** 实现三个组件；`npx tsc --noEmit`、`npm run lint`。
- [ ] **Step 2:** 浏览器验证（Task 8 一起做）。

### Task 7: 两种模式与问答衔接

**Files:**
- Create: `app/components/analytics/analysis-modes.tsx`
- Modify: `app/analysis/page.tsx`、`app/components/analytics/history-conversation.tsx`、`app/components/analytics/history-message.tsx`、`app/components/app-shell.tsx`

`analysis-modes.tsx`：
- 读取 `?mode=insight|qa`。没有 mode 时，如果当前对话有消息（`historyConversation` 有 messages）就进问答，否则进洞察。
- 顶部是一个分段开关「智能洞察 / 智能问答」（`role="tablist"`，两个 `role="tab"`，支持左右方向键切换）。
- 两个面板都渲染，用 `hidden` 属性切换，所以切换后状态都保留。
- `onAsk(focus)`：设置 `insightFocus` 状态，切到问答。
- `onDraft(text)`：切到问答，通过 `draft` 属性把文字填进输入框；这里填的是建活动的话，`conversationRoute` 会把它路由到 execution，这和现有的「从分析转去执行」走同一条路径。
- 问答里点「在图上看」时调 `onLocate(dimension)`，切到洞察并高亮对应维度。

`history-conversation.tsx` 增加三个可选属性：
```ts
{ insightFocus?: InsightFocus | null; onClearFocus?: () => void; draft?: { text: string; nonce: number } | null; onLocate?: (dimension: InsightDimensionId) => void }
```
- `insightFocus` 存在时，在 Composer 上方显示一枚标签：「正在看：{focusLabel}」加一个 ✕（`aria-label="移除洞察上下文"`）。`analyze()` 拼 `context` 时，在末尾追加 `focusContext(focus)`，问题原文不改。标签在发送一次后保留，用户手动删掉后才消失。
- `draft` 的 nonce 变化时 `setInput(draft.text)`，并把焦点放到输入框。
- 把 `onLocate` 传给 `HistoryMessageView`。

`history-message.tsx`：对 `isPlanAnswerV4(message.answer)` 的回答，从 `answer.evidence.frames` 和 `answer.evidence.objects` 里收集用到的维度（frames 的 `controls`、objects 的 `dimension`），交给 `locateAnswer`；结果不为 null 且传了 `onLocate` 时，在回答末尾显示一个文字按钮「在洞察图上看 {维度名}」。不用改计划输出的结构，证据里已经有这些信息。

`app/analysis/page.tsx`：`export default function AnalysisPage() { return <AnalysisModes />; }`。`/analysis/[id]` 是导入报告的旧入口，不改。

`app-shell.tsx`：侧栏里的「新对话」和点击历史对话时，跳转改为 `/analysis?mode=qa`。

- [ ] **Step 1:** 实现；`npx tsc --noEmit`、`npm run lint`、`npm test`（确认现有测试不受影响）。

### Task 8: 浏览器验收

用 `npm run dev:all` 起服务（先切 Node 22），打开 `http://127.0.0.1:5173/analysis`。

- [ ] 默认进洞察，图在 60 秒内出来；中心是「每克让利」，五个组都有，参数组和人组有黄框虚线节点。
- [ ] 点「单件克重段」的连线：依据里有数字，推荐以「8 月里」开头，取值表里 small 的行是灰色的。
- [ ] 切到「以旧换新率」：如果投影表没有回收列，这一族显示为虚线，并写明原因；如果有，H-金色星期二接近 100%。
- [ ] 点「问一问」：切到问答，标签显示正确；问「为什么」，回答的范围沿用了标签里的货类和优惠。
- [ ] 回答下方出现「在洞察图上看」，点了切回洞察并高亮对应维度。
- [ ] 点「按这个建活动」：切到问答，输入框里是草稿话，没有自动发送。
- [ ] 两种模式来回切，选中的连线和输到一半的问题都还在；刷新页面后模式和选中状态也还在。
- [ ] 窗口缩到 390px 宽：侧栏移到图下方，页面没有横向滚动。
- [ ] 截图交给用户确认。

### Task 9: 收尾

- [ ] `npm test`、`npx tsc --noEmit`、`npx tsc -p agent/tsconfig.json`、`npm run lint`、`npm run build` 全部通过。
- [ ] 更新 CLAUDE.md：在「架构」里加一段洞察图谱（数据流、`app/lib/insight/` 的职责、改指标或维度要动哪几处）。
- [ ] 交给控制者提交。
