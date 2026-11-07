# 深度剖析按时间范围重算 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 深度剖析图谱可以限定到一段日期（节日预设或自定义起止）重算，回答「这段时间里哪些因素影响了销售额、毛利、销量」。

**Architecture:** 页面 URL 带 `from` / `to`，经页面接口透传给 Agent 的 `GET /insight/graph?from=&to=`；Agent 校验范围后，除逐日查询外的聚合查询都加日期条件（参数化），逐日始终取全月。`drivers.ts` 收到 `window`，门店门槛按窗口缩放，「七夕」「星期」「新增还是挪动」在退化时标为新档位 `na`（这个范围内不适用），时间文案由数据填。图谱问答带同一范围，问的就是这张图。

**Tech Stack:** TypeScript（Node 22 `--experimental-strip-types`）、node:test、React（vinext）、mysql2（只在 Agent 侧）。

设计：`docs/superpowers/specs/2026-11-07-insight-date-range-design.md`。

## Global Constraints

- Node.js >= 22.13；命令前先 `export PATH=~/.nvm/versions/node/v22.23.1/bin:$PATH`（本机默认是 Node 18）。
- `app/lib/insight/`、`app/lib/server/`（`runtime.ts` 除外）不 import npm 包、`cloudflare:workers`、`db/*`；相对 import 写全 `.ts` 扩展名；不用 enum、namespace、构造函数参数属性。前端（`app/components/**`）照常写。
- 代码注释、界面文案、错误信息都用中文。
- 图上的数字全部由 `drivers.ts` 的模板填，不经过模型。
- **全月图不变**：不带范围时，`buildDriverGraph` 的输出除 `scope` 新增字段外必须和改动前逐字节相同（Task 2 的快照锁住）。
- 范围最短 3 天；门店门槛：全月 20 天，选了范围时 `ceil(窗口天数 × 2 / 3)`；离群店「数据不完整」门槛：全月不到 10 天，选了范围时不到 `ceil(窗口天数 / 3)` 天。
- 日期值只以 SQL 参数传入，不拼进 SQL 字符串。
- 内存图谱缓存最多 8 份（按范围），启动预热只算全月。

## 文件

- `app/lib/insight/range.ts`（新建）：范围的类型、解析、校验、节日预设、URL 读写。纯函数，Agent 和页面共用。
- `app/lib/insight/types.ts`：`InsightStrength` 加 `na`；`InsightGraph.scope` 加 `range`、`dataFrom`、`dataTo`、`festivals`、`overlap`。
- `app/lib/insight/drivers.ts`：`DriverData.window`；门槛缩放；`na` 判定；对照组；时间文案。
- `agent/insight-graph.ts`：查询带日期参数；按范围的内存缓存；`graph(range)`。
- `agent/http-handler.ts`：`/insight/graph` 解析 `from` / `to`，400；`/insight/ask` 用请求体里的 `range`。
- `app/lib/insight/ask.ts`：`InsightAskRequest.range`。
- `app/lib/insight/context.ts`：`focusContext` 写范围。
- `app/lib/server/runtime.ts`、`app/api/analytics/insight/route.ts`：透传查询串。
- `app/components/analytics/analysis-modes.tsx`、`app/components/insight/insight-workspace.tsx`、`app/components/insight/insight-range-picker.tsx`（新建）、`insight-graph-view.tsx`、`insight-side-panel.tsx`、`insight-chat.tsx`：页面。
- 测试：`tests/insight-range.test.ts`（新建）、`tests/insight-drivers.test.ts`、`tests/insight-agent.test.ts`、`tests/insight-ask.test.ts`、`tests/insight-context.test.ts`、`tests/helpers/insight-fixture.ts`。
- `CLAUDE.md`：深度剖析一节补一句。

---

### Task 1: 范围的类型、解析与校验（`range.ts`）

**Files:**
- Create: `app/lib/insight/range.ts`
- Test: `tests/insight-range.test.ts`

**Interfaces:**
- Produces:
  - `export type InsightRange = { from: string; to: string }`（`YYYYMMDD`）
  - `export type InsightFestival = { name: string; from: string; to: string }`
  - `export const MIN_RANGE_DAYS = 3`
  - `export function rangeDays(range: InsightRange): number`（含首尾）
  - `export function parseRangeParams(from: string | null, to: string | null): InsightRange | null`：两个都空 → `null`；只给一个、格式不对、日期不存在、倒序 → 抛 `Error`（中文原因）。不检查数据边界。
  - `export function checkRange(range: InsightRange, dataFrom: string, dataTo: string): void`：越界、短于 3 天抛 `Error`；覆盖整个数据范围时也合法。
  - `export function isFullRange(range: InsightRange | null, dataFrom: string, dataTo: string): boolean`：`null` 或正好等于数据起止。
  - `export function festivalsOf(days: ReadonlyArray<{ day: string; festival: string | null }>): InsightFestival[]`：按节日名分组取最早、最晚日期，按开始日期排序；名字去掉结尾的「节」。
  - `export function rangeLabel(range: InsightRange): string`：`8/23–8/29`。
  - `export function rangeSearch(range: InsightRange | null): string`：`from=20250823&to=20250829` 或 `""`。
  - `export function rangeFromSearch(search: string): InsightRange | null`：URL 里读，不合法返回 `null`（页面不因为坏链接报错）。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/insight-range.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { checkRange, festivalsOf, isFullRange, MIN_RANGE_DAYS, parseRangeParams, rangeDays, rangeFromSearch, rangeLabel, rangeSearch } from "../app/lib/insight/range.ts";

test("范围解析：都不给是全月；只给一个、格式错、日期不存在、倒序都拒绝", () => {
  assert.equal(parseRangeParams(null, null), null);
  assert.equal(parseRangeParams("", ""), null);
  assert.deepEqual(parseRangeParams("20250823", "20250829"), { from: "20250823", to: "20250829" });
  assert.throws(() => parseRangeParams("20250823", null), /起止日期要一起给/);
  assert.throws(() => parseRangeParams("2025-08-23", "20250829"), /日期格式/);
  assert.throws(() => parseRangeParams("20250231", "20250301"), /日期格式/);
  assert.throws(() => parseRangeParams("20250829", "20250823"), /开始日期不能晚于结束日期/);
});

test("范围校验：越界、短于 3 天拒绝；整段数据范围合法", () => {
  assert.equal(MIN_RANGE_DAYS, 3);
  assert.equal(rangeDays({ from: "20250823", to: "20250829" }), 7);
  assert.equal(rangeDays({ from: "20250831", to: "20250901" }), 2);
  assert.doesNotThrow(() => checkRange({ from: "20250801", to: "20250831" }, "20250801", "20250831"));
  assert.doesNotThrow(() => checkRange({ from: "20250829", to: "20250831" }, "20250801", "20250831"));
  assert.throws(() => checkRange({ from: "20250730", to: "20250805" }, "20250801", "20250831"), /超出数据范围（8\/1–8\/31）/);
  assert.throws(() => checkRange({ from: "20250830", to: "20250831" }, "20250801", "20250831"), /至少选 3 天/);
});

test("是否全月：不给范围或正好等于数据起止", () => {
  assert.equal(isFullRange(null, "20250801", "20250831"), true);
  assert.equal(isFullRange({ from: "20250801", to: "20250831" }, "20250801", "20250831"), true);
  assert.equal(isFullRange({ from: "20250802", to: "20250831" }, "20250801", "20250831"), false);
});

test("节日预设：按名字分组取起止，名字去掉「节」", () => {
  const days = [{ day: "20250822", festival: null }, { day: "20250823", festival: "七夕节" }, { day: "20250829", festival: "七夕节" }, { day: "20250830", festival: null }];
  assert.deepEqual(festivalsOf(days), [{ name: "七夕", from: "20250823", to: "20250829" }]);
  assert.deepEqual(festivalsOf([]), []);
});

test("URL：写出去再读回来一样；坏参数读成全月", () => {
  const r = { from: "20250823", to: "20250829" };
  assert.equal(rangeSearch(r), "from=20250823&to=20250829");
  assert.equal(rangeSearch(null), "");
  assert.deepEqual(rangeFromSearch(`?mode=insight&${rangeSearch(r)}`), r);
  assert.equal(rangeFromSearch("?from=20250829&to=20250823"), null);
  assert.equal(rangeFromSearch("?from=x"), null);
  assert.equal(rangeLabel(r), "8/23–8/29");
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test --experimental-strip-types tests/insight-range.test.ts`
Expected: FAIL，`Cannot find module '.../app/lib/insight/range.ts'`

- [ ] **Step 3: 实现**

```ts
// app/lib/insight/range.ts
// 深度剖析的时间范围：解析、校验、节日预设、URL 读写。纯函数，Agent 和页面共用。
// 设计见 docs/superpowers/specs/2026-11-07-insight-date-range-design.md。

export type InsightRange = { from: string; to: string };
export type InsightFestival = { name: string; from: string; to: string };
// 短于 3 天时门店、活动的比较大多没有意义，不重算。
export const MIN_RANGE_DAYS = 3;

const DAY_MS = 86400000;
const toTime = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)));
// 8 位且是真实存在的日期（20250231 不算）。
const isDay = (d: string) => {
  if (!/^\d{8}$/.test(d)) return false;
  const t = new Date(toTime(d));
  return t.getUTCFullYear() === Number(d.slice(0, 4)) && t.getUTCMonth() + 1 === Number(d.slice(4, 6)) && t.getUTCDate() === Number(d.slice(6, 8));
};
const short = (d: string) => `${Number(d.slice(4, 6))}/${Number(d.slice(6, 8))}`;

export const rangeDays = (range: InsightRange) => Math.round((toTime(range.to) - toTime(range.from)) / DAY_MS) + 1;
export const rangeLabel = (range: InsightRange) => `${short(range.from)}–${short(range.to)}`;

export function parseRangeParams(from: string | null, to: string | null): InsightRange | null {
  const f = from?.trim() ?? ""; const t = to?.trim() ?? "";
  if (!f && !t) return null;
  if (!f || !t) throw new Error("起止日期要一起给");
  if (!isDay(f) || !isDay(t)) throw new Error("日期格式不正确，应为 8 位日期，例如 20250823");
  if (f > t) throw new Error("开始日期不能晚于结束日期");
  return { from: f, to: t };
}

export function checkRange(range: InsightRange, dataFrom: string, dataTo: string): void {
  if (range.from < dataFrom || range.to > dataTo) throw new Error(`超出数据范围（${short(dataFrom)}–${short(dataTo)}）`);
  if (rangeDays(range) < MIN_RANGE_DAYS) throw new Error(`范围太短，至少选 ${MIN_RANGE_DAYS} 天`);
}

export const isFullRange = (range: InsightRange | null, dataFrom: string, dataTo: string) => !range || (range.from === dataFrom && range.to === dataTo);

export function festivalsOf(days: ReadonlyArray<{ day: string; festival: string | null }>): InsightFestival[] {
  const by = new Map<string, InsightFestival>();
  for (const d of days) {
    if (!d.festival) continue;
    const name = d.festival.replace(/节$/, "") || d.festival;
    const f = by.get(name);
    by.set(name, f ? { name, from: d.day < f.from ? d.day : f.from, to: d.day > f.to ? d.day : f.to } : { name, from: d.day, to: d.day });
  }
  return [...by.values()].sort((a, b) => a.from.localeCompare(b.from));
}

export const rangeSearch = (range: InsightRange | null) => range ? `from=${range.from}&to=${range.to}` : "";

export function rangeFromSearch(search: string): InsightRange | null {
  const params = new URLSearchParams(search);
  try { return parseRangeParams(params.get("from"), params.get("to")); } catch { return null; }
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `node --test --experimental-strip-types tests/insight-range.test.ts`
Expected: PASS，5 个测试全过。

- [ ] **Step 5: 提交**

```bash
git add app/lib/insight/range.ts tests/insight-range.test.ts
git commit -m "feat: 深度剖析时间范围的解析、校验和节日预设"
```

---

### Task 2: 锁住全月图（快照）+ fixture 能按范围裁剪

改 `drivers.ts` 之前先锁住现在的全月输出，后面每一步都要保持它不变。

**Files:**
- Modify: `tests/helpers/insight-fixture.ts`
- Create: `tests/fixtures/insight-full-month.json`（由脚本生成）
- Modify: `tests/insight-drivers.test.ts`

**Interfaces:**
- Produces（fixture）：
  - `export function fakeResultsIn(range: { from: string; to: string } | null)`：返回和 `fakeResults()` 同形的对象；`panel`、`gold`、`stores`（只留窗口内有成交的店）按范围裁剪，`daily` 不裁剪，`scope` 的 `first_day` / `last_day` 改为范围起止。
  - `export const fakeGraphIn = (range: { from: string; to: string } | null) => InsightGraph`：`toDriverData(fakeResultsIn(range), "v-test", range)` 后 `buildDriverGraph(..., "2026-10-20T00:00:00.000Z")`。Task 3 之前 `toDriverData` 只有两个参数，这一步先只传两个，Task 3 再补第三个。

- [ ] **Step 1: 生成快照文件**

```bash
export PATH=~/.nvm/versions/node/v22.23.1/bin:$PATH
mkdir -p tests/fixtures
node --experimental-strip-types --disable-warning=ExperimentalWarning -e '
import("./tests/helpers/insight-fixture.ts").then(async (m) => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync("tests/fixtures/insight-full-month.json", JSON.stringify(m.fakeGraph(), null, 1) + "\n");
});'
wc -c tests/fixtures/insight-full-month.json
```

Expected: 文件约 100–130 KB。

- [ ] **Step 2: 在 fixture 里加按范围裁剪**

在 `tests/helpers/insight-fixture.ts` 末尾（`fakeGraph` 之后）加：

```ts
// 按范围裁剪：除逐日外的查询都只留窗口内的行，和 Agent 加了日期条件后查回来的一样；逐日始终是全月。
export function fakeResultsIn(range: { from: string; to: string } | null) {
  const all = fakeResults();
  if (!range) return all;
  const inside = (d: string) => d >= range.from && d <= range.to;
  const panel = all.panel.filter((p) => inside(p.d));
  const open = new Set(panel.map((p) => p.store));
  return { ...all, panel, gold: all.gold.filter((g) => inside(g.d)), stores: all.stores.filter((s) => open.has(s.store)),
    scope: [{ ...all.scope[0], first_day: range.from, last_day: range.to }] };
}
export const fakeGraphIn = (range: { from: string; to: string } | null) => buildDriverGraph(toDriverData(fakeResultsIn(range), "v-test"), "2026-10-20T00:00:00.000Z");
```

- [ ] **Step 3: 加快照测试**

在 `tests/insight-drivers.test.ts` 顶部 import 区加：

```ts
import { readFileSync } from "node:fs";
```

文件末尾加：

```ts
test("全月图和改动前一样（除 scope 新增字段外逐字段相同）", () => {
  const expected = JSON.parse(readFileSync(new URL("./fixtures/insight-full-month.json", import.meta.url), "utf8"));
  const actual = JSON.parse(JSON.stringify(fakeGraph()));
  const { range, dataFrom, dataTo, festivals, overlap, ...scope } = actual.scope;
  assert.deepEqual({ ...actual, scope }, expected);
});
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `node --test --experimental-strip-types tests/insight-drivers.test.ts`
Expected: PASS（此时还没改代码，快照必然一致）。

- [ ] **Step 5: 提交**

```bash
git add tests/helpers/insight-fixture.ts tests/fixtures/insight-full-month.json tests/insight-drivers.test.ts
git commit -m "test: 锁住深度剖析全月图，fixture 支持按范围裁剪"
```

---

### Task 3: 图谱按窗口计算（`drivers.ts`、`types.ts`、`toDriverData`）

**Files:**
- Modify: `app/lib/insight/types.ts:27`（`InsightStrength`）、`:120-121`（`InsightGraph.scope`）、`:125-133`（两个 Record）
- Modify: `app/lib/insight/drivers.ts`（多处，见下）
- Modify: `agent/insight-graph.ts:72-80`（`toDriverData`）
- Modify: `tests/helpers/insight-fixture.ts`（`fakeGraphIn` 传 range）
- Test: `tests/insight-drivers.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `InsightRange`、`festivalsOf`、`rangeLabel`、`rangeDays`、`isFullRange`。
- Produces:
  - `InsightStrength` 增加 `"na"`；`INSIGHT_STRENGTH_LABEL.na = "不适用"`；`INSIGHT_EDGE_SOURCE.na = "这个时间范围内算不出来"`。
  - `InsightGraph.scope`：`{ period; rows; stores; note; range: InsightRange | null; dataFrom: string; dataTo: string; festivals: InsightFestival[]; overlap: string | null }`。
  - `DriverData.window: InsightRange | null`。
  - `toDriverData(results, datasetVersion, window: InsightRange | null = null)`：`period` 在 `window` 非空时写成 `七夕 8/23–8/29`（窗口正好等于某个节日时）或 `8/23–8/29`；`dataFrom` / `dataTo` 从 `results.daily` 的最早、最晚日期取（逐日是全月）。`DriverData` 增加 `dataFrom: string; dataTo: string`。

- [ ] **Step 1: 写失败的测试**

在 `tests/insight-drivers.test.ts` import 区把 fixture 那行改成：

```ts
import { fakeGraph, fakeGraphIn } from "./helpers/insight-fixture.ts";
```

文件末尾加：

```ts
const QIXI = { from: "20250823", to: "20250829" };
const finite = (x: unknown, p = ""): string[] => typeof x === "number" ? (Number.isFinite(x) ? [] : [p])
  : typeof x === "string" ? (/NaN|Infinity|undefined/.test(x) ? [`${p}: ${x.slice(0, 60)}`] : [])
  : Array.isArray(x) ? x.flatMap((v, i) => finite(v, `${p}[${i}]`))
  : x && typeof x === "object" ? Object.entries(x).flatMap(([k, v]) => finite(v, `${p}.${k}`)) : [];

test("七夕 7 天：门店门槛 5 天，门店列有结果，文案写实际门槛和范围", () => {
  const g = fakeGraphIn(QIXI);
  assert.equal(g.scope.period, "七夕 8/23–8/29");
  assert.deepEqual(g.scope.range, QIXI);
  assert.equal(g.scope.dataFrom, "20250801"); assert.equal(g.scope.dataTo, "20250831");
  assert.deepEqual(g.scope.festivals, [{ name: "七夕", from: "20250823", to: "20250829" }]);
  const image = g.edges.find((e) => e.from === "image" && e.to === "store")!;
  assert.ok(image.score && image.score.value > 0, "商圈 → 门店本身要有分数");
  assert.doesNotMatch(image.basis, /：。/, "依据里不能是空列表");
  assert.match(g.methods.find((m) => m.title === "哪个门店属性有用")!.text, /^120 家开满 5 天的店/);
  assert.doesNotMatch(JSON.stringify(g), /8 月|一个月|开满 20 天|全月/);
});

test("七夕 7 天：七夕、星期不适用；新增还是挪动用窗口外的平日对照", () => {
  const g = fakeGraphIn(QIXI);
  for (const id of ["qixi", "weekday"] as const) {
    const node = g.nodes.find((n) => n.id === id)!; const edge = g.edges.find((e) => e.from === id)!;
    assert.equal(node.strength, "na", id); assert.equal(node.score, undefined, id);
    assert.equal(edge.strength, "na", id); assert.equal(edge.score, undefined, id);
    assert.match(edge.basis, /这个时间范围内/, id);
  }
  const shift = g.edges.find((e) => e.from === "shift")!;
  assert.notEqual(shift.strength, "na");
  // 8/1 是周五，窗口外铺开前第一个周一、三、四是 8/4。
  assert.match(shift.basis, /8\/4–8\/21 不过节的周一、三、四/);
  assert.match(g.scope.overlap ?? "", /七夕和全国克减重叠/);
});

test("窗口在铺开前（8/1–8/14）：新增还是挪动不适用，没有重叠说明；七夕不适用；星期能算", () => {
  const g = fakeGraphIn({ from: "20250801", to: "20250814" });
  assert.equal(g.edges.find((e) => e.from === "shift")!.strength, "na");
  assert.equal(g.edges.find((e) => e.from === "qixi")!.strength, "na");
  assert.notEqual(g.edges.find((e) => e.from === "weekday")!.strength, "na");
  assert.equal(g.scope.overlap, null);
});

test("跨节日边界（8/20–8/31）：七夕能算", () => {
  const g = fakeGraphIn({ from: "20250820", to: "20250831" });
  assert.notEqual(g.edges.find((e) => e.from === "qixi")!.strength, "na");
});

test("几个短范围算出来的图没有 NaN、Infinity", () => {
  for (const r of [QIXI, { from: "20250801", to: "20250803" }, { from: "20250829", to: "20250831" }, { from: "20250801", to: "20250821" }])
    assert.deepEqual(finite(fakeGraphIn(r)), [], `${r.from}–${r.to}`);
});

test("全月：range 为 null，没有不适用的线", () => {
  const g = fakeGraph();
  assert.equal(g.scope.range, null);
  assert.ok(g.edges.every((e) => e.strength !== "na"));
  assert.equal(g.scope.overlap, null);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test --experimental-strip-types tests/insight-drivers.test.ts`
Expected: 新增 6 个测试 FAIL（`period` 是 `2025-08-23 至 ...`、`range` 为 undefined 等），快照测试仍 PASS。

- [ ] **Step 3: 改 `types.ts`**

`app/lib/insight/types.ts` 第 27 行：

```ts
// na：这个时间范围内算不出来（例如范围里全是节日、每个星期几只有一天），画成灰线、不给分数。
export type InsightStrength = "strong" | "med" | "weak" | "id" | "missing" | "na";
```

文件顶部（第 2 行注释之后）加：

```ts
import type { InsightFestival, InsightRange } from "./range.ts";
```

`InsightGraph` 的 `scope` 改为：

```ts
  // range：这张图算的范围，null 为全部数据；dataFrom / dataTo：数据本身的起止；festivals：节日预设；overlap：范围里的节日和全国克减重叠时的说明。
  scope: { period: string; rows: number; stores: number; note: string; range: InsightRange | null; dataFrom: string; dataTo: string; festivals: InsightFestival[]; overlap: string | null };
```

两个 Record 各加一项：

```ts
export const INSIGHT_STRENGTH_LABEL: Record<InsightStrength, string> = { strong: "强", med: "中", weak: "弱", id: "拆解", missing: "缺数据", na: "不适用" };
```

```ts
  missing: "AI 推测，没有数据",
  na: "这个时间范围内算不出来",
```

- [ ] **Step 4: 改 `toDriverData`**

`agent/insight-graph.ts` 顶部 import 加：

```ts
import { festivalsOf, isFullRange, rangeLabel, type InsightRange } from "../app/lib/insight/range.ts";
```

`toDriverData` 改为（只改签名、`period` 和新增两项，其余字段不动）：

```ts
export function toDriverData(results: Record<string, unknown>, datasetVersion: string, window: InsightRange | null = null): DriverData {
  const scope = rowsOf(results.scope)[0] ?? {};
  const first = str(scope.first_day); const last = str(scope.last_day);
  const daily = rowsOf(results.daily).map((r): DailyRow => ({ day: str(r.d), dow: num(r.dow), festival: r.festival ? String(r.festival) : null, sales: num(r.sales), orders: num(r.orders), goldSales: num(r.gold), baseGold: num(r.base_gold), promoGold: num(r.promo_gold) }));
  const days = daily.map((d) => d.day).sort();
  const dataFrom = days[0] ?? first; const dataTo = days.at(-1) ?? last;
  const full = isFullRange(window, dataFrom, dataTo);
  const festival = window ? festivalsOf(daily).find((f) => f.from === window.from && f.to === window.to) : undefined;
  const monthly = /^\d{8}$/.test(first) && /^\d{8}$/.test(last) ? first.slice(0, 6) === last.slice(0, 6) ? `${first.slice(0, 4)} 年 ${Number(first.slice(4, 6))} 月` : `${first.slice(0, 4)}-${first.slice(4, 6)}-${first.slice(6)} 至 ${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6)}` : "未知";
  return {
    datasetVersion, rows: num(scope.n), memberShare: num(scope.member_share),
    window: full ? null : window, dataFrom, dataTo,
    period: full || !window ? monthly : `${festival ? `${festival.name} ` : ""}${rangeLabel(window)}`,
    // panel、stores、ptype、gold、threshold、tradein 六项保持原样
    daily,
  };
}
```

（把原来 `return` 里的 `daily: rowsOf(results.daily).map(...)` 那一行删掉，换成上面的 `daily`，其余字段原样保留。）

同一文件 `insightQueries` 的返回类型要跟着排除新字段，否则 `tsc` 报缺键（Task 4 只改函数体，不再改类型）：

```ts
export function insightQueries(table: string): Record<keyof Omit<DriverData, "datasetVersion" | "period" | "rows" | "memberShare" | "window" | "dataFrom" | "dataTo"> | "scope", string> {
```

`tests/helpers/insight-fixture.ts` 的 `fakeGraphIn` 改为传第三个参数：

```ts
export const fakeGraphIn = (range: { from: string; to: string } | null) => buildDriverGraph(toDriverData(fakeResultsIn(range), "v-test", range), "2026-10-20T00:00:00.000Z");
```

- [ ] **Step 5: 改 `drivers.ts` —— 类型和窗口参数**

`DriverData` 改为：

```ts
// window：这张图算的范围（null 为全部数据）；除 daily 外的数据都只含窗口内的行，daily 始终是全部日期。
export type DriverData = {
  datasetVersion: string; period: string; rows: number; memberShare: number;
  window: { from: string; to: string } | null; dataFrom: string; dataTo: string;
  panel: PanelRow[]; stores: StoreRow[]; ptype: PtypeRow[]; daily: DailyRow[]; gold: GoldRow[]; threshold: ThresholdRow[]; tradein: TradeInRow[];
};
```

顶部 import 加：

```ts
import { festivalsOf, rangeDays, rangeLabel } from "./range.ts";
```

`buildDriverGraph` 函数体第一行（`// ---------- 全国 ----------` 之前）加：

```ts
  // ---------- 范围 ----------
  // 全月保持原来的口径（门店开满 20 天、营业不到 10 天算数据不完整）；选了范围按窗口天数缩放。
  const win = data.window;
  const winDays = win ? rangeDays(win) : 0;
  const minDays = win ? Math.ceil(winDays * 2 / 3) : 20;
  const thinDays = win ? Math.ceil(winDays / 3) : 10;
  const inWin = (d: string) => !win || (d >= win.from && d <= win.to);
  // 时间说法：全月写「8 月」「一个月」，范围写「七夕 8/23–8/29」「这几天」。
  const when = win ? data.period : `${Number(data.dataFrom.slice(4, 6))} 月`;
  const span = win ? "这几天" : "一个月";
```

- [ ] **Step 6: 改 `drivers.ts` —— 门槛**

- 第 81 行 `s.days >= 20` → `s.days >= minDays`。
- 第 539 行 `peerAll.filter((s) => s.days >= 20)` → `peerAll.filter((s) => s.days >= minDays)`。
- 第 569 行 `incomplete: (x) => x.days < 10` → `incomplete: (x) => x.days < thinDays`。
- 用编辑器全局把 `drivers.ts` 里所有 `开满 20 天` 改成 `开满 ${minDays} 天`。注意：第 704、942 行在模板字符串里，直接替换；第 77、256、292、312、538 行是注释，注释写成「开满门槛天数」。

- [ ] **Step 7: 改 `drivers.ts` —— 日期部分**

把第 125–147 行（`// ---------- 日期 ----------` 到 `const shiftPct = ...`）换成：

```ts
  // ---------- 日期 ----------
  // all：全部日期（铺开日、平日对照要看窗口外）；daily：窗口内的日子（图上画的、节日和星期的解释度都只看它）。
  const all = [...data.daily].sort((a, b) => a.day.localeCompare(b.day));
  const daily = all.filter((d) => inWin(d.day));
  // 全国克减铺开的日子：活动计价金超过一般開單计价金、之后一直如此的第一天。之前的周一、三、四当普通工作日。
  // 只看「从这天起每天都超过」，周末的局部活动不算铺开。按全部日期算，窗口不改变铺开日。
  const rollout = all.find((d, i) => all.slice(i).every((x) => x.promoGold > x.baseGold))?.day ?? "99999999";
  const plain = (d: DailyRow) => [1, 3, 4].includes(d.dow) && !d.festival;
  // 平常工作日：全月时是铺开前不过节的周一、三、四；选了范围时只取窗口外的（窗口里的日子是被比较的对象）。
  const ordinary = all.filter((d) => plain(d) && d.day < rollout && (!win || !inWin(d.day)));
  const ordinaryAvg = mean(ordinary.map((d) => d.sales));
  const ordinarySpan = ordinary.length ? `${day(ordinary[0].day)}–${day(ordinary.at(-1)!.day)}` : "";
  const tuesdays = daily.filter((d) => d.dow === 2 && d.day < rollout && !d.festival);
  const tueAvg = mean(tuesdays.map((d) => d.sales)); const tueGold = mean(tuesdays.map((d) => d.goldSales)); const ordGold = mean(ordinary.map((d) => d.goldSales));
  const weekendAvg = mean(daily.filter((d) => d.dow === 0 || d.dow === 6).map((d) => d.sales));
  const festDays = daily.filter((d) => d.festival);
  const peak = festDays.reduce<DailyRow | null>((a, b) => !a || b.sales > a.sales ? b : a, null);
  const festName = peak?.festival?.replace(/节$/, "") ?? "节日";
  const daySplit = logSplit(daily.map((d) => d.sales), daily.map((d) => d.orders));
  // 窗口内逐日销售额对数的差异，节日、星期各解释多少（单变量解释度）。
  const dayLog = Float64Array.from(daily, (d) => Math.log(d.sales));
  const etaFestival = etaSquared(daily.map((d) => d.festival ?? "非节日"), dayLog);
  const etaWeekday = etaSquared(daily.map((d) => String(d.dow)), dayLog);
  // 这个范围内算不出来的：节日只有一种取值（全是节日或一天都没有）；有哪个星期几只出现一天（解释度会虚高到 100）。
  const dowCount = new Map<number, number>(); for (const d of daily) dowCount.set(d.dow, (dowCount.get(d.dow) ?? 0) + 1);
  const naQixi = new Set(daily.map((d) => d.festival ?? "")).size < 2;
  const naWeekday = [...dowCount.values()].some((n) => n < 2);
  // 铺开后的周一、三、四：节日周也算进来（否则没剩几天），只去掉节日当天。选了范围时只取窗口内的。
  const after = daily.filter((d) => [1, 3, 4].includes(d.dow) && d.day >= rollout && d.day !== peak?.day);
  const naShift = !ordinary.length || !after.length;
  const shift = { baseBefore: mean(ordinary.map((d) => d.baseGold)), baseAfter: mean(after.map((d) => d.baseGold)), promoBefore: mean(ordinary.map((d) => d.promoGold)), promoAfter: mean(after.map((d) => d.promoGold)) };
  const shiftPct = shift.baseBefore > 0 ? (shift.baseAfter / shift.baseBefore - 1) * 100 : 0;
  // 范围里的节日和全国克减重叠：节日效应和活动效应分不开，页面常驻说明。
  const overlap = win && festDays.some((d) => d.day >= rollout) ? `${festName}和全国克减重叠（克减 ${day(rollout)} 起），节日效应和活动效应分不开` : null;
  const NA = (why: string) => `这个时间范围内${why}，算不出来。`;
  const naWhy = {
    qixi: NA(festDays.length ? "每天都是节日，没有不过节的日子可比" : "没有节日"),
    weekday: NA("有的星期几只有一天，分不出是星期几的差别还是那一天的事"),
    shift: NA(ordinary.length ? "没有克减铺开后的周一、三、四" : "窗口外没有克减铺开前不过节的周一、三、四可以对照"),
  };
```

注意 `win` 为 null 时：`all` 等于原 `daily`、`daily` 等于原 `daily`、`ordinary` 和原来相同，全月输出不变。

- [ ] **Step 8: 改 `drivers.ts` —— 三个节点、三条线标 `na`**

`sc` 里 `qixi`、`weekday` 两项不变（分数照算，后面按 `na` 丢掉）。

第 462–468 行 `qixi`、`weekday` 节点，第 479 行 `shift` 节点：在各自 `N({...})` 外面包一层：

```ts
  // 不适用的节点：去掉分数、效应值，档位记 na，副标题写原因。
  const naNode = (node: Omit<InsightNode, "card">, na: boolean, why: string): Omit<InsightNode, "card"> => {
    if (!na) return node;
    const { score, effect, ...rest } = node;
    return { ...rest, strength: "na", subtitle: "这个范围内不适用", paragraphs: [why] };
  };
```

（放在 `const N = ...` 那行之后。）然后三处改成 `naNode(N({ id: "qixi", ... }), naQixi, naWhy.qixi)`、`naNode(N({ id: "weekday", ... }), naWeekday, naWhy.weekday)`、`naNode(N({ id: "shift", ... }), naShift, naWhy.shift)`。

`E` 的第三个参数类型加 `"na"`：

```ts
  const E = (from: InsightNodeId, to: InsightNodeId, x: (InsightScore & { effect?: Effect; identity?: boolean }) | "id" | "missing" | "na", basis: string, more: More = {}): Omit<InsightEdge, "card"> => {
    const rest = { basis, anomalies: more.anomalies ?? [], recommendation: more.recommendation ?? null, ...(more.recommendation ? {} : { noRecommendation: more.noRecommendation ?? (x === "id" ? "这是恒等式，没有可选的取值。" : x === "missing" ? "没有数据，推荐不了。" : x === "na" ? "这个时间范围内算不出来，换一个范围再看。" : "关系太弱，按它挑门店或时间意义不大。") }) };
```

（保留原来最后那个默认文案，只在三元链里插入 `x === "na"` 一段；`if (typeof x === "string")` 分支不用改，`na` 会走它。）

第 887、891、899 行的三条线改为（保持原有参数，只在前面判断）：

```ts
    naQixi ? E("qixi", "day", "na", naWhy.qixi) : E("qixi", "day", sc.qixi, /* 原来的依据和 more 原样 */),
    naWeekday ? E("weekday", "day", "na", naWhy.weekday) : E("weekday", "day", sc.weekday, /* 原样 */),
    naShift ? E("shift", "promo", "na", naWhy.shift) : E("shift", "promo", { ...sc.shift, effect: ef.shift }, /* 原样 */),
```

（`/* 原样 */` 指把那一行原来的第四、五个参数原封不动保留。）

`shift` 线在窗口模式下依据要写明对照期：把第 899 行依据开头的 `克减铺开后，` 改为 `${win ? `${ordinarySpan} 不过节的周一、三、四对照${when}，` : "克减铺开后，"}`。

- [ ] **Step 9: 改 `drivers.ts` —— 时间文案**

把 Task 前面统计出来的硬编码换掉（行号是改动前的；用搜索定位）：

- 模板字符串里的 `8 月`（508、512、515、519、522、526、774、792、798、804、809、812、814、818、820 行）：`8 月` → `${when}`。
- 模板字符串里的 `一个月`（703、707、723、767、771、830、873、874、876、878、879、882、883 行）：`一个月` → `${span}`。
- 普通字符串里的 `一个月`（364、378、450、457、644、710、718、720、724、765、831、832、901、949 行）：把这个字符串改成模板字符串，`一个月` → `${span}`。例：`"一家店一个月卖多少（万元）"` → `` `一家店${span}卖多少（万元）` ``。第 949 行的 `"一个月数据，只是相关"` → `` win ? `${data.period}的数据，只是相关` : "一个月数据，只是相关" ``。
- 第 366 行标题 `"8/22 起全国做克减，单量和销售额一起涨"` → `` `${day(rollout)} 起全国做克减，单量和销售额一起涨` ``。
- 第 659 行 `"同类日子取平均；平常 = 8/22 前不过节的周一、三、四"` → `` `同类日子取平均；平常 = ${win ? `${ordinarySpan} ` : `${day(rollout)} 前`}不过节的周一、三、四` ``。
- 第 812 行 `整个月` → `${win ? "这几天" : "整个月"}`；第 890、891 行 `全月` → `${win ? "这几天" : "全月"}`。
- 第 464、730 行「平常工作日（${day(rollout)} 之前的周一、三、四…）」：窗口模式写对照期。`${day(rollout)} 之前的周一、三、四` → `${win ? `${ordinarySpan} 不过节` : `${day(rollout)} 之前`}的周一、三、四`。

改完跑一次全文检查（应无输出）：

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning -e '
import("./tests/helpers/insight-fixture.ts").then((m) => { const s = JSON.stringify(m.fakeGraphIn({ from: "20250823", to: "20250829" })); for (const w of ["8 月", "一个月", "全月", "开满 20 天", "整个月"]) if (s.includes(w)) console.log(w, s.slice(s.indexOf(w) - 40, s.indexOf(w) + 20)); });'
```

- [ ] **Step 10: 改 `drivers.ts` —— 返回 scope**

最后的 `return` 里 `scope` 改为：

```ts
    scope: { period: data.period, rows: data.rows, stores: storeCount, note: win ? `${data.period}的数据，只是相关` : "一个月数据，只是相关",
      range: win, dataFrom: data.dataFrom, dataTo: data.dataTo, festivals: festivalsOf(all), overlap },
```

- [ ] **Step 11: 跑测试**

Run: `node --test --experimental-strip-types tests/insight-drivers.test.ts tests/insight-agent.test.ts tests/insight-ask.test.ts tests/insight-context.test.ts tests/insight-peers.test.ts`
Expected: 全部 PASS，包括 Task 2 的快照测试。快照失败说明全月输出变了：对比 diff 找出是哪一处改动在 `win === null` 时也生效了，改到全月不变为止，**不要重新生成快照**。

`tests/insight-agent.test.ts:20` 的 `data.period` 断言不需要改（全月仍是 `2025 年 8 月`）。

- [ ] **Step 12: 类型检查**

Run: `npx tsc --noEmit && npx tsc -p agent/tsconfig.json`
Expected: 无输出。`STRENGTH_STYLE`（`insight-graph-view.tsx:30`）是 `Record<InsightStrength, ...>`，会因为缺 `na` 报错，按下面补上（Task 6 还会再用到）：

```ts
  na: { stroke: "#cbd5e1", width: 1.1, dash: "2 5", pill: "不适用" },
```

- [ ] **Step 13: 提交**

```bash
git add app/lib/insight/types.ts app/lib/insight/drivers.ts agent/insight-graph.ts tests/helpers/insight-fixture.ts tests/insight-drivers.test.ts app/components/insight/insight-graph-view.tsx
git commit -m "feat: 图谱按时间范围计算，七夕、星期、新增还是挪动在退化时标为不适用"
```

---

### Task 4: Agent 查询带范围、按范围缓存、HTTP 校验

**Files:**
- Modify: `agent/insight-graph.ts`（`insightQueries`、`createInsightGraphService`）
- Modify: `agent/http-handler.ts:142,164-169`
- Test: `tests/insight-agent.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseRangeParams`、`checkRange`、`isFullRange`、`InsightRange`；Task 3 的 `toDriverData(results, version, window)`。
- Produces:
  - `insightQueries(table, ranged = false)`：`ranged` 为 true 时，`scope`、`panel`、`stores`、`ptype`、`gold`、`threshold`、`tradein` 七条带 `交易日期wid BETWEEN ? AND ?`（`tradein` 的两个 CTE 各带一次，共 4 个占位符），`daily` 不带。返回类型不变。
  - `export function insightParams(name: string, range: InsightRange | null): string[]`：`tradein` 返回 `[from, to, from, to]`，`daily` 或 `range` 为 null 返回 `[]`，其余 `[from, to]`。
  - `export class InsightRangeError extends Error {}`（Agent 侧用来区分 400）。
  - `InsightGraphService.graph(range?: InsightRange | null): Promise<InsightGraph>`：范围不合法抛 `InsightRangeError`；覆盖整段数据时按全月处理（同一份缓存）。
  - `/insight/graph?from=&to=`：范围错误返回 400 `{ error: 中文原因 }`。

- [ ] **Step 1: 写失败的测试**

`tests/insight-agent.test.ts` import 改为：

```ts
import { createInsightGraphService, insightParams, insightQueries, InsightRangeError, toDriverData } from "../agent/insight-graph.ts";
import { createAgentHttpHandler } from "../agent/http-handler.ts";
import { createServer } from "node:http";
import { fakeResults, fakeResultsIn } from "./helpers/insight-fixture.ts";
```

把原来的 `fakeConnection` 换成能按参数返回裁剪结果的版本：

```ts
function fakeConnection(onCube: (sql: string, params: string[]) => void): HistoryConnection {
  const plain = insightQueries("t"); const ranged = insightQueries("t", true);
  const nameOf = new Map<string, string>([...Object.entries(plain), ...Object.entries(ranged)].map(([name, sql]) => [sql, name]));
  return {
    async query() { return [[], []]; },
    async execute(sql: string, params: string[] = []) {
      if (sql.includes("COUNT(*) AS n, MAX")) return [[{ n: 10, max_day: "20250831" }], []];
      onCube(sql, params);
      const name = nameOf.get(sql) as keyof ReturnType<typeof fakeResults> | undefined;
      const results = params.length ? fakeResultsIn({ from: params[0], to: params[1] }) : fakeResults();
      return [name ? results[name] : [], []];
    },
    destroy() {},
  };
}
```

原来那个缓存测试里的 `fakeConnection(() => ran++)` 不用改（新签名多出的参数可以忽略）。文件末尾加：

```ts
test("带范围的查询：除逐日外都加日期条件，日期只走参数", () => {
  const q = insightQueries("t", true);
  for (const name of ["scope", "panel", "stores", "ptype", "gold", "threshold"] as const) assert.equal(q[name].split("BETWEEN ? AND ?").length - 1, 1, name);
  assert.equal(q.tradein.split("BETWEEN ? AND ?").length - 1, 2);
  assert.doesNotMatch(q.daily, /BETWEEN/);
  assert.doesNotMatch(Object.values(q).join("\n"), /2025\d{4}/);
  const r = { from: "20250823", to: "20250829" };
  assert.deepEqual(insightParams("panel", r), ["20250823", "20250829"]);
  assert.deepEqual(insightParams("tradein", r), ["20250823", "20250829", "20250823", "20250829"]);
  assert.deepEqual(insightParams("daily", r), []);
  assert.deepEqual(insightParams("panel", null), []);
  assert.equal(insightQueries("t").panel.includes("BETWEEN"), false, "不带范围时 SQL 和原来一样");
});

test("按范围缓存：不同范围分开算，同范围并发只算一次；整段数据范围就是全月", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "insight-cache-"));
  const seen: string[][] = [];
  const service = createInsightGraphService({ table: "t", evidenceDir: join(cacheDir, "evidence"), cacheDir, connect: async () => fakeConnection((_, p) => seen.push(p)), logger: { log() {}, error() {} } });
  try {
    const qixi = { from: "20250823", to: "20250829" };
    const [a, b] = await Promise.all([service.graph(qixi), service.graph(qixi)]);
    assert.equal(a, b);
    assert.deepEqual(a.scope.range, qixi);
    const full = await service.graph(null);
    assert.equal(full.scope.range, null);
    assert.equal(await service.graph({ from: "20250801", to: "20250831" }), full);
    assert.ok(seen.some((p) => p[0] === "20250823"));
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test("范围不合法：越界、太短抛 InsightRangeError", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "insight-cache-"));
  const service = createInsightGraphService({ table: "t", evidenceDir: join(cacheDir, "evidence"), cacheDir, connect: async () => fakeConnection(() => {}), logger: { log() {}, error() {} } });
  try {
    await assert.rejects(service.graph({ from: "20250830", to: "20250831" }), (e) => e instanceof InsightRangeError && /至少选 3 天/.test(e.message));
    await assert.rejects(service.graph({ from: "20250720", to: "20250803" }), (e) => e instanceof InsightRangeError && /超出数据范围/.test(e.message));
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test("HTTP：/insight/graph 透传范围，参数错误返回 400 和中文原因", async (t) => {
  const calls: unknown[] = [];
  const insight = { warm: async () => {}, graph: async (range?: unknown) => {
    calls.push(range ?? null);
    if (range && (range as { from: string }).from === "20250830") throw new InsightRangeError("范围太短，至少选 3 天");
    return { ok: true } as never;
  } };
  const server = createServer(createAgentHttpHandler({ runAgentTurn: (async () => { throw new Error("不该调用"); }) as never, token: "", model: "test", insight, logger: { log() {}, error() {} } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/insight/graph`)).status, 200);
  assert.equal((await fetch(`${base}/insight/graph?from=20250823&to=20250829`)).status, 200);
  assert.deepEqual(calls, [null, { from: "20250823", to: "20250829" }]);
  const bad = await fetch(`${base}/insight/graph?from=20250823`);
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /起止日期要一起给/);
  const short = await fetch(`${base}/insight/graph?from=20250830&to=20250831`);
  assert.equal(short.status, 400); assert.match((await short.json()).error, /至少选 3 天/);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test --experimental-strip-types tests/insight-agent.test.ts`
Expected: FAIL，`insightParams` / `InsightRangeError` 未导出。

- [ ] **Step 3: 改 `insightQueries`**

`agent/insight-graph.ts`：

```ts
// 带范围时，除逐日外的查询都只看窗口内的行；逐日始终取全部日期（铺开日、平日对照要看窗口外）。日期只走参数。
const RANGE = "`交易日期wid` BETWEEN ? AND ?";
export function insightQueries(table: string, ranged = false): Record<keyof Omit<DriverData, "datasetVersion" | "period" | "rows" | "memberShare" | "window" | "dataFrom" | "dataTo"> | "scope", string> {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(table)) throw new Error("洞察数据表名不正确");
  const t = `\`${table}\``;
  // and：接在已有 WHERE 后面；where：没有 WHERE 的查询用。不带范围时都是空串，SQL 和原来逐字相同。
  const and = ranged ? ` AND ${RANGE}` : ""; const where = ranged ? ` WHERE ${RANGE}` : "";
```

然后在各条 SQL 里接上：

- `scope`：`FROM ${t}` → `FROM ${t}${where}`。
- `panel`：`WHERE ${SALE} AND \`实体分店店号\` IS NOT NULL GROUP BY 1, 2` → `WHERE ${SALE} AND \`实体分店店号\` IS NOT NULL${and} GROUP BY 1, 2`。
- `stores`：`IS NOT NULL GROUP BY 1` → `IS NOT NULL${and} GROUP BY 1`。
- `ptype`：`WHERE ${SALE} GROUP BY 1` → `WHERE ${SALE}${and} GROUP BY 1`。
- `daily`：不改。
- `gold`：`= '一般足金类' GROUP BY 1, 2` → `= '一般足金类'${and} GROUP BY 1, 2`。
- `threshold`：`\`销售金重\` < 25 GROUP BY 1` → `\`销售金重\` < 25${and} GROUP BY 1`。
- `tradein`：两个 CTE 的 `\`销售单号\` IS NOT NULL GROUP BY` 各改为 `\`销售单号\` IS NOT NULL${and} GROUP BY`。

函数后面加：

```ts
// 每条查询的日期参数：tradein 两个子查询各一对，逐日不带。
export function insightParams(name: string, range: InsightRange | null): string[] {
  if (!range || name === "daily") return [];
  return name === "tradein" ? [range.from, range.to, range.from, range.to] : [range.from, range.to];
}
export class InsightRangeError extends Error {}
```

- [ ] **Step 4: 改 `createInsightGraphService`**

类型：

```ts
export type InsightGraphService = { graph(range?: InsightRange | null): Promise<InsightGraph>; warm(): Promise<void> };
```

`runAll` 接受参数：

```ts
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
```

`cachedAll` 的入参同样换成 `Array<{ sql: string; params: string[] }>`，缓存键改为：

```ts
    const files = queries.map((q) => join(dir, `${createHash("sha256").update(JSON.stringify(q.params.length ? [version, q.sql, q.params] : [version, q.sql])).digest("hex").slice(0, 32)}.json`));
```

（不带参数时键和原来一样，已有的磁盘缓存继续命中。）`runAll(missing.map((i) => queries[i]))` 不用改。

`build` 拆成「取版本」和「按范围算」：

```ts
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

  // 按范围缓存，最多 8 份，超出淘汰最久没用的；全月用键 "all"。
  const CACHE_LIMIT = 8;
  const cache = new Map<string, Promise<InsightGraph>>();
  async function graph(range: InsightRange | null = null): Promise<InsightGraph> {
    const { version, dataFrom, dataTo } = await versionOf();
    if (range) { try { checkRange(range, dataFrom, dataTo); } catch (error) { throw new InsightRangeError(error instanceof Error ? error.message : "范围不正确"); } }
    const window = isFullRange(range, dataFrom, dataTo) ? null : range;
    const key = window ? `${window.from}-${window.to}` : "all";
    let hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
    hit = build(window, version).catch((error) => { cache.delete(key); throw error; });
    cache.set(key, hit);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return hit;
  }
```

删掉原来的 `let cached` 和旧 `graph()`。`warm()` 里的 `graph()` 调用不用改（默认全月）。import 补 `checkRange`：

```ts
import { checkRange, festivalsOf, isFullRange, rangeLabel, type InsightRange } from "../app/lib/insight/range.ts";
```

**原缓存测试的版本查询识别**：`fakeConnection` 里判断版本查询用的是 `sql.includes("COUNT(*) AS n, MAX")`，新 SQL 是 `COUNT(*) AS n, MIN(...) AS min_day, MAX(...)`，要把判断改成 `sql.includes("AS min_day")`，并返回 `[[{ n: 10, min_day: "20250801", max_day: "20250831" }], []]`。

- [ ] **Step 5: 改 HTTP**

`agent/http-handler.ts` 顶部 import：

```ts
import { InsightRangeError, type InsightGraphService } from "./insight-graph.ts";
import { parseRangeParams } from "../app/lib/insight/range.ts";
```

（原来的 `import type { InsightGraphService }` 那行删掉。）第 164–169 行改为：

```ts
    if (isInsight) {
      if (!insight) return send(response, 503, { error: "历史数据库尚未启用，洞察图谱暂不可用" });
      const params = new URL(request.url ?? "/", "http://agent").searchParams;
      let range;
      try { range = parseRangeParams(params.get("from"), params.get("to")); }
      catch (error) { return send(response, 400, { error: error instanceof Error ? error.message : "范围不正确" }); }
      // 每个范围算好后缓存；断开连接也让计算跑完，下次直接命中。
      try { return send(response, 200, await insight.graph(range)); }
      catch (error) {
        if (error instanceof InsightRangeError) return send(response, 400, { error: error.message });
        logger.error(`[insight] 计算失败：${error instanceof Error ? error.message : error}`); return send(response, 502, { error: "洞察图谱暂时算不出来，请稍后重试" });
      }
    }
```

- [ ] **Step 6: 跑测试**

Run: `node --test --experimental-strip-types tests/insight-agent.test.ts tests/insight-drivers.test.ts`
Expected: 全部 PASS。

- [ ] **Step 7: 类型检查**

Run: `npx tsc -p agent/tsconfig.json && npx tsc --noEmit`
Expected: 无输出。

- [ ] **Step 8: 提交**

```bash
git add agent/insight-graph.ts agent/http-handler.ts tests/insight-agent.test.ts
git commit -m "feat: Agent 图谱接口按时间范围查询和缓存，范围不合法返回 400"
```

---

### Task 5: 问答和页面接口带范围

**Files:**
- Modify: `app/lib/insight/ask.ts:8,23-29`
- Modify: `agent/http-handler.ts:179`
- Modify: `app/lib/insight/context.ts:7,34-48`
- Modify: `app/lib/server/runtime.ts:72-77`
- Modify: `app/api/analytics/insight/route.ts`
- Test: `tests/insight-ask.test.ts`、`tests/insight-context.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `parseRangeParams`、`InsightRange`、`rangeLabel`；Task 4 的 `graph(range)`。
- Produces:
  - `InsightAskRequest.range: InsightRange | null`；请求体字段 `range: { from, to } | null`。
  - `InsightFocus` 增加可选 `period?: string`（图谱的 `scope.period`，非全月时才有）；`focusOf` 在 `graph.scope.range` 非空时带上；`focusContext` 用它替换写死的「2025 年 8 月全国」。
  - `fetchInsightGraph(search: string, signal?)`：`search` 是 `?from=..&to=..` 或 `""`。

- [ ] **Step 1: 写失败的测试**

`tests/insight-ask.test.ts` 第一个测试里加：

```ts
  assert.equal(parseAskBody({ question: "x" }).range, null);
  assert.deepEqual(parseAskBody({ question: "x", range: { from: "20250823", to: "20250829" } }).range, { from: "20250823", to: "20250829" });
  assert.throws(() => parseAskBody({ question: "x", range: { from: "20250829", to: "20250823" } }), /开始日期不能晚于结束日期/);
```

`tests/insight-context.test.ts` 末尾加：

```ts
test("选了范围时问答上下文写明范围，全月照旧", async () => {
  const { fakeGraphIn } = await import("./helpers/insight-fixture.ts");
  const qixi = focusOf(fakeGraphIn({ from: "20250823", to: "20250829" }), { kind: "node", id: "region" })!;
  assert.equal(qixi.period, "七夕 8/23–8/29");
  assert.match(focusContext(qixi), /七夕 8\/23–8\/29 全国/);
  assert.doesNotMatch(focusContext(qixi), /2025 年 8 月/);
  const full = focusOf(fakeGraph(), { kind: "node", id: "region" })!;
  assert.equal(full.period, undefined);
  assert.match(focusContext(full), /2025 年 8 月全国/);
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `node --test --experimental-strip-types tests/insight-ask.test.ts tests/insight-context.test.ts`
Expected: FAIL（`range` 为 undefined、`period` 为 undefined）。

- [ ] **Step 3: 实现**

`app/lib/insight/ask.ts`：

```ts
import { parseRangeParams, type InsightRange } from "./range.ts";
```

```ts
export type InsightAskRequest = { selection: InsightSelection | null; question: string; history: InsightAskTurn[]; range: InsightRange | null };
```

`parseAskBody` 的 `return` 前加：

```ts
  // 问的是哪个范围的图：和页面上正在看的一样。
  const range = isObject(value.range) ? parseRangeParams(typeof value.range.from === "string" ? value.range.from : null, typeof value.range.to === "string" ? value.range.to : null) : null;
  return { question, history, selection: parseSelection(value.selection), range };
```

`agent/http-handler.ts` 第 179 行：

```ts
        const graph = await insight.graph(body.range);
```

并把这段 `catch` 改成先识别范围错误：

```ts
      } catch (error) {
        if (controller.signal.aborted || isTurnCancelled(error)) return;
        if (error instanceof InsightRangeError) return send(response, 400, { error: error.message });
```

`app/lib/insight/context.ts`：

```ts
export type InsightFocus = ({ kind: "node"; id: InsightNodeId; label: string } | { kind: "edge"; from: InsightNodeId; to: InsightNodeId; label: string; basis: string }) & { say?: string; todo?: string | null; period?: string };
```

`focusOf` 里两个 `return` 都展开 `...(graph.scope.range ? { period: graph.scope.period } : {})`：

```ts
  const when = graph.scope.range ? { period: graph.scope.period } : {};
  if (selection.kind === "node") { const node = findNode(graph, selection.id); return node ? { kind: "node", id: node.id, label: node.label, ...when, ...(node.card ? { say: plain(node.card.say), todo: node.card.todo } : {}) } : null; }
  const edge = findEdge(graph, selection.from, selection.to); const from = findNode(graph, selection.from); const to = findNode(graph, selection.to);
  return edge && from && to ? { kind: "edge", from: edge.from, to: edge.to, label: `${from.label} → ${to.label}`, basis: edge.basis, ...when, ...(edge.card ? { say: plain(edge.card.say), todo: edge.card.todo } : {}) } : null;
```

`focusContext` 里 `2025 年 8 月全国` → `${focus.period ?? "2025 年 8 月"}全国`。

`app/lib/server/runtime.ts`：

```ts
// 每个范围 Agent 算一次、查询结果落盘；search 是 ?from=&to= 或空串，原样转给 Agent 校验。
export async function fetchInsightGraph(search: string, signal?: AbortSignal): Promise<Response> {
  const base = (env.AGENT_SERVICE_URL || DEFAULT_AGENT_URL).replace(/\/+$/, "");
  const response = await fetch(`${base}/insight/graph${search}`, { headers: agentHeaders(), signal });
```

`app/api/analytics/insight/route.ts`：

```ts
import { parseRangeParams, rangeSearch } from "../../../lib/insight/range.ts";

// 洞察图谱只读 Agent 侧算好的聚合结果，不读写分析存储。范围在这里先挡掉格式错误，再交给 Agent 按数据起止校验。
export function GET(request: Request) {
  return analyticsResponse(request, async () => {
    const params = new URL(request.url).searchParams;
    const range = parseRangeParams(params.get("from"), params.get("to"));
    const search = rangeSearch(range);
    return fetchInsightGraph(search ? `?${search}` : "", request.signal);
  }, { bootstrap: true });
}
```

（`analyticsResponse` 遇到普通 `Error` 返回 400 + `error`，见 `app/lib/server/analytics-runtime.ts:17`。）

- [ ] **Step 4: 跑测试**

Run: `node --test --experimental-strip-types tests/insight-ask.test.ts tests/insight-context.test.ts tests/insight-agent.test.ts tests/unified-conversation.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 类型检查并提交**

```bash
npx tsc --noEmit && npx tsc -p agent/tsconfig.json
git add app/lib/insight/ask.ts app/lib/insight/context.ts agent/http-handler.ts app/lib/server/runtime.ts app/api/analytics/insight/route.ts tests/insight-ask.test.ts tests/insight-context.test.ts
git commit -m "feat: 图谱问答和页面接口带上时间范围"
```

---

### Task 6: 页面：范围控件、URL、提示行、不适用样式

前端没有组件测试，靠类型检查、lint 和 Task 7 的真实页面验收。

**Files:**
- Create: `app/components/insight/insight-range-picker.tsx`
- Modify: `app/components/analytics/analysis-modes.tsx:28-34,44,52-58,78`
- Modify: `app/components/insight/insight-workspace.tsx`
- Modify: `app/components/insight/insight-graph-view.tsx:95-100,122,273`
- Modify: `app/components/insight/insight-side-panel.tsx:14`
- Modify: `app/components/insight/insight-chat.tsx:26-28,51`

**Interfaces:**
- Consumes: Task 1 的 `rangeFromSearch`、`rangeSearch`、`rangeLabel`、`InsightRange`、`InsightFestival`、`MIN_RANGE_DAYS`、`rangeDays`；Task 3 的 `scope.range/dataFrom/dataTo/festivals/overlap`、`na`。
- Produces: `InsightRangePicker({ graph, range, onChange })`；`InsightWorkspace` 新增 props `range: InsightRange | null; onRange: (range: InsightRange | null) => void`；`InsightChat` 新增 prop `range: InsightRange | null`。

- [ ] **Step 1: URL 读写范围（`analysis-modes.tsx`）**

import 加：

```ts
import { rangeFromSearch, rangeSearch, type InsightRange } from "../../lib/insight/range";
```

`writeUrl` 改为带范围：

```ts
function writeUrl(mode: AnalysisMode, selection: InsightSelection | null, range: InsightRange | null) {
  // 问答模式也带上洞察的选中状态和范围，切回洞察时都还在。
  const rest = [selectionSearch(selection), rangeSearch(range)].filter(Boolean).join("&");
  const search = `mode=${mode}${rest ? `&${rest}` : ""}`;
  window.history.replaceState(window.history.state, "", `/analysis?${search}`);
  for (const listener of locationListeners) listener();
}
```

组件里：

```ts
  const selection = parseSelection(search);
  const range = rangeFromSearch(search);
```

```ts
  const switchTo = (next: AnalysisMode) => writeUrl(next, selection, range);
  const changeSelection = (next: InsightSelection | null) => writeUrl("insight", next, range);
  // 换范围时清掉选中：节点可能在新范围里不适用，旧的结论也对不上了。
  const changeRange = (next: InsightRange | null) => writeUrl("insight", null, next);
```

```ts
  const locate = (id: InsightNodeId) => writeUrl("insight", { kind: "node", id }, range);
```

第 78 行：

```tsx
      {visitedInsight ? <InsightWorkspace selection={selection} onSelect={changeSelection} range={range} onRange={changeRange} onAskQa={askQa} /> : null}
```

- [ ] **Step 2: 范围控件（新建 `insight-range-picker.tsx`）**

```tsx
"use client";

import { CalendarRange } from "lucide-react";
import { useState } from "react";
import { MIN_RANGE_DAYS, rangeDays, rangeLabel, type InsightRange } from "../../lib/insight/range";
import type { InsightGraph } from "../../lib/insight/types";

// 范围选择：全部数据、节日预设（来自图谱的 scope.festivals）、自定义起止。改了就写进 URL，由工作台重新请求。
const toInput = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const fromInput = (v: string) => v.replaceAll("-", "");

export function InsightRangePicker({ graph, range, onChange }: { graph: InsightGraph; range: InsightRange | null; onChange: (range: InsightRange | null) => void }) {
  const { dataFrom, dataTo, festivals } = graph.scope;
  const preset = !range ? "all" : festivals.find((f) => f.from === range.from && f.to === range.to)?.name ?? "custom";
  const [custom, setCustom] = useState(preset === "custom");
  const [from, setFrom] = useState(range?.from ?? dataFrom); const [to, setTo] = useState(range?.to ?? dataTo);
  const draft = { from, to }; const tooShort = from > to || rangeDays(draft) < MIN_RANGE_DAYS;
  const choose = (value: string) => {
    if (value === "custom") { setCustom(true); return; }
    setCustom(false);
    const f = festivals.find((x) => x.name === value);
    onChange(f ? { from: f.from, to: f.to } : null);
  };
  const field = "min-h-8 rounded-lg border border-[#d9e2ee] bg-white px-2 text-[12.5px] text-[#0f172a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return <div className="flex flex-wrap items-center gap-2">
    <CalendarRange aria-hidden="true" className="size-4 text-[#64748b]" />
    <label className="sr-only" htmlFor="insight-range">时间范围</label>
    <select id="insight-range" value={custom ? "custom" : preset} onChange={(e) => choose(e.target.value)} className={field}>
      <option value="all">全部（{rangeLabel({ from: dataFrom, to: dataTo })}）</option>
      {festivals.map((f) => <option key={f.name} value={f.name}>{f.name}（{rangeLabel(f)}）</option>)}
      <option value="custom">自定义</option>
    </select>
    {custom ? <>
      <input type="date" aria-label="开始日期" value={toInput(from)} min={toInput(dataFrom)} max={toInput(dataTo)} onChange={(e) => setFrom(fromInput(e.target.value))} className={field} />
      <span className="text-[12px] text-[#94a3b8]">至</span>
      <input type="date" aria-label="结束日期" value={toInput(to)} min={toInput(dataFrom)} max={toInput(dataTo)} onChange={(e) => setTo(fromInput(e.target.value))} className={field} />
      <button type="button" disabled={tooShort} onClick={() => onChange(draft)} className="min-h-8 rounded-lg bg-[#2f6bff] px-3 text-[12.5px] font-medium text-white disabled:bg-[#cbd5e1]">看这段</button>
      {tooShort ? <span className="text-[12px] text-[#a43f37]">至少选 {MIN_RANGE_DAYS} 天</span> : null}
    </> : null}
  </div>;
}
```

- [ ] **Step 3: 工作台按范围请求（`insight-workspace.tsx`）**

import 加：

```ts
import { rangeSearch, type InsightRange } from "../../lib/insight/range";
import { InsightRangePicker } from "./insight-range-picker";
```

props 和请求：

```tsx
export function InsightWorkspace({ selection, onSelect, range, onRange, onAskQa }: {
  selection: InsightSelection | null; onSelect: (selection: InsightSelection | null) => void;
  range: InsightRange | null; onRange: (range: InsightRange | null) => void;
  onAskQa: (question: string, focus: InsightFocus | null) => void;
}) {
  const [graph, setGraph] = useState<InsightGraph | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [marked, setMarked] = useState<InsightNodeId[]>([]);
  const [panel, setPanel] = useState<"detail" | "chat">("detail");
  const search = rangeSearch(range);

  // 换范围时保留旧图、顶部提示正在算；第一次算一个新范围要扫全表，之后命中缓存。
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    analyticsRequest<InsightGraph>(`/api/analytics/insight${search ? `?${search}` : ""}`, undefined, controller.signal)
      .then((result) => { if (!controller.signal.aborted) { setGraph(result); setError(""); setLoading(false); } })
      .catch((caught) => { if (!controller.signal.aborted) { setError(caught instanceof Error ? caught.message : "洞察图谱暂时算不出来"); setLoading(false); } });
    return () => controller.abort();
  }, [attempt, search]);
```

注意 `setLoading(true)` 在 effect 里同步调用，如果 lint 的 `react-hooks/set-state-in-effect` 报错，改成在 `onRange` 外层包一层：工作台里定义 `const changeRange = (next: InsightRange | null) => { setLoading(true); onRange(next); };`，effect 里去掉 `setLoading(true)`，`InsightRangePicker` 的 `onChange` 用 `changeRange`；首次加载走原来的 `!graph` 分支，不需要 `loading`。

原来 `if (error && !graph)` 分支不变。新增：有旧图、新范围出错时，在图上方显示错误而不是整页替换（见 Step 4 的 `rangeBar`）。

- [ ] **Step 4: 提示行和控件位置**

在 `return` 的第一个 `<div className="grid shrink-0 gap-3 sm:grid-cols-3">`（指标卡）之前加：

```tsx
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <InsightRangePicker key={`${graph.scope.range?.from ?? "all"}-${graph.scope.range?.to ?? ""}`} graph={graph} range={range} onChange={onRange} />
      {loading ? <span role="status" className="inline-flex items-center gap-1.5 text-[12px] text-[#64748b]"><span className="size-3 animate-spin rounded-full border-2 border-[#c7ddff] border-t-[#247cff] motion-reduce:animate-none" />正在算这段时间的影响因素，第一次约 1 分钟</span> : null}
      {error ? <span role="alert" className="text-[12px] text-[#a43f37]">{error}<button type="button" onClick={() => { setError(""); setAttempt((n) => n + 1); }} className="ml-2 underline">重试</button></span> : null}
      {graph.scope.range && !loading ? <span className="text-[12px] text-[#64748b]">{graph.scope.period} · {graph.scope.stores.toLocaleString("zh-CN")} 家店{graph.scope.overlap ? <> · <span className="text-[#a16207]">{graph.scope.overlap}</span></> : null}</span> : null}
    </div>
```

（`key` 让控件在图换了范围后用新范围重置内部的自定义起止。）

- [ ] **Step 5: 不适用的样式**

`insight-graph-view.tsx`：

- 第 99 行节点样式链里，在 `missing` 那一段之前加：`: n.strength === "na" ? "border-dashed border-[#e2e8f0] bg-[#f8fafc] text-[#94a3b8]"`。
- 第 122 行图例末尾加：`{line("na", "不适用")}`（只在图里有 `na` 时显示）：

```tsx
{graph.edges.some((e) => e.strength === "na") ? line("na", "不适用") : null}
```

- 第 273 行档位小标的颜色链里，`missing` 之后加 `: n.strength === "na" ? "bg-[#f1f5f9] text-[#94a3b8]"`。

`insight-side-panel.tsx:14` 的 `tone` 链：`missing` 之后加 `: edge.strength === "na" ? "bg-[#f1f5f9] text-[#94a3b8]"`。

（`STRENGTH_STYLE.na` 已在 Task 3 Step 12 加上。）

- [ ] **Step 6: 图谱问答带范围（`insight-chat.tsx`）**

props 加 `range: InsightRange | null`；第 51 行请求体加 `range`：

```ts
      const result = await analyticsRequest<InsightAskResult>("/api/analytics/insight/ask", { question, selection, history, range }, controller.signal);
```

`insight-workspace.tsx` 里 `<InsightChat ... />` 加 `range={graph.scope.range}`（用图实际的范围，不用 URL 的，避免新图还没回来时问到旧图）。换范围后旧对话的回答对应旧图：给 `InsightChat` 加 `key={rangeSearch(graph.scope.range)}`，换范围就清空问答。

- [ ] **Step 7: 检查**

Run: `npx tsc --noEmit && npm run lint`
Expected: 无错误。

- [ ] **Step 8: 提交**

```bash
git add app/components/analytics/analysis-modes.tsx app/components/insight/
git commit -m "feat: 深度剖析页面加时间范围选择、范围说明和不适用样式"
```

---

### Task 7: 全量检查、真实数据验收、文档

**Files:**
- Modify: `CLAUDE.md`（「深度剖析」一节）

- [ ] **Step 1: 全量测试和检查**

```bash
export PATH=~/.nvm/versions/node/v22.23.1/bin:$PATH
npm test 2>&1 | tail -8
npx tsc --noEmit && npx tsc -p agent/tsconfig.json && npm run lint
```

Expected: `# fail 0`；类型检查和 lint 无错误。

- [ ] **Step 2: 重启服务**

`agent/insight-graph.ts`、`agent/http-handler.ts` 改了，要重启 `dev:agent`。停掉正在跑的 `npm run dev:all`，再起：

```bash
npm run dev:all > /tmp/ctf-dev.log 2>&1 &
until grep -q "影响因素图谱算好" /tmp/ctf-dev.log; do sleep 2; done; tail -5 /tmp/ctf-dev.log
```

- [ ] **Step 3: 接口验收（真实数据）**

Agent 端口看 `.dev.vars` 的 `AGENT_PORT`（本机 8792）：

```bash
P=$(grep '^AGENT_PORT=' .dev.vars | cut -d= -f2)
time curl -s --noproxy '*' "http://127.0.0.1:$P/insight/graph?from=20250823&to=20250829" -o /tmp/qixi.json -w '%{http_code}\n'
node -e 'const g=require("/tmp/qixi.json"); console.log(g.scope); console.log(g.edges.filter(e=>["qixi","weekday","shift","image"].includes(e.from)).map(e=>[e.from,e.strength,e.score?.value?.toFixed(1),e.basis.slice(0,60)]))'
curl -s --noproxy '*' "http://127.0.0.1:$P/insight/graph?from=20250830&to=20250831" -w '\n%{http_code}\n'
time curl -s --noproxy '*' "http://127.0.0.1:$P/insight/graph?from=20250823&to=20250829" -o /dev/null -w '%{http_code}\n'
```

Expected：第一次 200，记下耗时；`scope.period` 为「七夕 8/23–8/29」、`stores` 约 5,500–5,800、`overlap` 有说明；`qixi`、`weekday` 为 `na`，`shift` 不是 `na` 且依据写 `8/4–8/21` 的对照；`image` 有分数。短范围返回 400 和「至少选 3 天」。第二次请求命中缓存，耗时应在 1 秒以内。

- [ ] **Step 4: 页面验收**

用浏览器打开 `http://localhost:5173/analysis?mode=insight&from=20250823&to=20250829`，确认：控件选中「七夕（8/23–8/29）」、提示行显示范围和重叠说明、七夕和星期两个节点置灰且标「不适用」、点开写明原因；切回「全部」后图和改动前一样；在「问这张图」里问「七夕期间哪个因素影响最大」，回答里的范围是七夕。截图存到 `/tmp/insight-qixi.png`（本机可用 `/tmp/insight-shot/shot.mjs`，没有就用 Chrome 手动截）。

- [ ] **Step 5: 更新 CLAUDE.md**

「深度剖析」一节第一条（模式和 URL 那条）末尾补：

```markdown
图谱可以按时间范围重算（`?from=YYYYMMDD&to=YYYYMMDD`，设计 `docs/superpowers/specs/2026-11-07-insight-date-range-design.md`）：除逐日外的查询加日期参数，逐日始终取全部日期（铺开日、平日对照看窗口外）；门店门槛按窗口缩放（全月 20 天，范围内 ceil(天数×2/3)）；七夕、星期、新增还是挪动在范围内算不出来时标 `na`（不适用）。全月输出由 `tests/fixtures/insight-full-month.json` 锁住，改 `drivers.ts` 不能让它变，除非有意改全月图并重新生成。范围工具在 `app/lib/insight/range.ts`。
```

- [ ] **Step 6: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 补深度剖析时间范围说明"
```
