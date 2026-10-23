# 订单数/客单价拖动联动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把洞察图谱「订单数」「客单价」两个节点从纯文字展示换成可拖动联动的滑块：拖一个，另一个按真实门店间回归关系给出建议值和波动范围，销售额跟着两者相乘实时重算。

**Architecture:** `app/lib/insight/stats.ts` 新增一个纯函数算对数线性回归（斜率、截距、残差标准差）；`drivers.ts` 用这个函数在 `full`（开满 20 天门店的月度聚合）上算出 orders↔aov 的回归系数，换算成日均口径后塞进一个新的 `InsightChart` kind（`"linked"`），挂在 `orders`、`aov` 两个节点的 `node.chart` 上；`insight-chart.tsx` 新增一个渲染组件，两个滑块各自管理「谁是最后被拖动的输入」这一份 state，依据回归系数算对方的建议值和展示用的波动范围，销售额同步重算。

**Tech Stack:** TypeScript（无数值库，手写最小二乘），React（受控 state，沿用现有 `WhatIf` 组件的写法），node:test。

**Spec:** `docs/superpowers/specs/2026-10-23-insight-orders-aov-slider-design.md`（本计划的前提，连同它取代的 `2026-10-20-insight-drivers-design.md` 一起读）

## Global Constraints

- 回归口径：门店间横截面（`full`，月度聚合），跟 `storeSplit`/`logSplit` 同一份数据，不用同店逐日的时间序列（spec §3）。
- 回归在对数尺度上做：`log(客单价) = intercept + slope × log(订单数)`（spec §3）。
- 滑块展示用日均口径（「一天 X 单」「客单 Y 元」），不展示月度总量；月度斜率换算到日均展示时斜率不变（spec §6）。
- 滑块初始基准值：全局中位数门店的日均订单数、客单价（spec §6 / 用户确认）。
- 波动范围：建议值 × `exp(±sigma)`，sigma 是对数尺度回归残差标准差（spec §4）。
- 不展示 R²、相关系数等统计量数字，只用波动范围的宽窄传达不确定性（spec §5）。
- 波动范围旁必须有一句克制说明（历史统计趋势，不是精确预测），沿用图谱「不做预测」的原则（spec §5，§7）。
- 新 chart 挂在 `orders`/`aov` 节点的 `node.chart`（目前为空），不动节点 `card.sim`/`card.chart` 和 `orders>sales`/`aov>sales` 边上现有的 `lines` 图（spec §6）。
- 不处理毛利率/销售额那组关系，即便强度相近（spec §1, §7）。
- 不做同店时间序列口径的联动（spec §7）。
- 代码注释、界面文案用中文（项目 CLAUDE.md）。
- `app/lib/insight/*`、`app/components/insight/*` 不限制 import 别名/扩展名规则（这些不在 agent 服务加载范围内，是前端组件），但仍需遵守项目整体风格：纯函数、无用的 enum/namespace 不用。

## Review Focus

- **单门店极端订单数（全局分布的 2% 分位以下或 98% 分位以上）**：拖到这种极端值时，回归外推出的客单价建议值不能是负数或 `NaN`/`Infinity`（对数尺度回归天然保证客单价为正，但滑块的 `min`/`max` 范围需要限制在样本支撑范围内，不能让用户拖出一个样本里从没见过的订单数继续外推出看似精确的建议值）。
- **只手动拖动一侧、从未碰过另一侧时**：另一侧必须显示「未拖动」的中性状态（基准值，无建议值高亮、无波动范围），不能在页面刚加载就显示一个带不确定性的数字（spec §4 最后一句）。
- **反复来回拖动两个滑块**：「谁是最后被拖动的输入」这个状态要能正确切换多次，不能卡死在第一次拖动的方向上，也不能因为浮点误差导致来回拖动后数值漂移到不收敛。
- **某一侧回归系数算出来 `sigma` 接近 0（样本高度一致）或过大（样本离散）时**：波动范围不能画成一条看不见的窄带或一个铺满整个滑块的误导性宽带；至少保证范围是有限值、不会把 UI 撑炸。
- **数据版本里 `full` 样本量很小（比如测试 fixture 只有几家店）时**：回归函数在 n 太小（比如 n < 2）时要有明确行为（不崩、不除零），`drivers.ts` 侧调用时要清楚这种情况下新 chart 该不该生成。

---

## Task 1: `stats.ts` 新增对数线性回归函数

**Files:**
- Modify: `app/lib/insight/stats.ts`
- Test: `tests/insight-drivers.test.ts`（新增测试用例，沿用现有文件，不新建文件——该文件已经是 `stats.ts` 全部函数的测试落点）

**Interfaces:**
- Consumes: 无新依赖，内部只用 `Math.log`/`Math.exp`，不调用文件内其他函数。
- Produces: `logLinearFit(xs: readonly number[], ys: readonly number[]): { slope: number; intercept: number; sigma: number; r2: number }`，供 Task 2 的 `drivers.ts` 调用。`xs`/`ys` 是原始尺度的正数（订单数、客单价），函数内部自己取对数；回归式是 `log(ys) = intercept + slope * log(xs)`。n < 2 或任一数组含非正数时返回 `{ slope: 0, intercept: mean(log(ys)) 的近似或 0, sigma: 0, r2: 0 }`（保证不崩、不产生 NaN）。

- [ ] **Step 1: 写失败测试**

在 `tests/insight-drivers.test.ts` 第 3 行的 import 列表里加上 `logLinearFit`。

```ts
test("对数线性回归：还原已知斜率和截距", () => {
  const xs = [1, 2, 4, 8, 16, 32];
  const trueSlope = 0.3; const trueIntercept = Math.log(50);
  const ys = xs.map((x) => Math.exp(trueIntercept + trueSlope * Math.log(x)));
  const fit = logLinearFit(xs, ys);
  assert.ok(Math.abs(fit.slope - trueSlope) < 1e-6);
  assert.ok(Math.abs(fit.intercept - trueIntercept) < 1e-6);
  assert.ok(fit.sigma < 1e-6); // 完全拟合，残差几乎为 0
  assert.ok(fit.r2 > 0.999);
});

test("对数线性回归：加噪声后 sigma 和 r2 反映离散程度", () => {
  const xs = [1, 2, 4, 8, 16, 32, 64, 128];
  const ys = xs.map((x, i) => Math.exp(0.3 * Math.log(x) + (i % 2 === 0 ? 0.1 : -0.1)));
  const fit = logLinearFit(xs, ys);
  assert.ok(fit.sigma > 0 && fit.sigma < 1);
  assert.ok(fit.r2 >= 0 && fit.r2 <= 1);
});

test("对数线性回归：样本太少或含非正数时不崩", () => {
  assert.doesNotThrow(() => logLinearFit([1], [10]));
  assert.doesNotThrow(() => logLinearFit([], []));
  const fit = logLinearFit([1, -2], [10, 20]);
  assert.ok(Number.isFinite(fit.slope) && Number.isFinite(fit.intercept) && Number.isFinite(fit.sigma));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --experimental-strip-types --test-name-pattern="对数线性回归" tests/insight-drivers.test.ts`
Expected: FAIL，`logLinearFit is not defined` 或 import 报错

- [ ] **Step 3: 在 `app/lib/insight/stats.ts` 实现 `logLinearFit`**

用文件里已有的 `leastSquares([ones, x], y)` 复用一元回归（`ones` 是全 1 列，`x` 是 `log(xs)`，`y` 是 `log(ys)`），拿到 `[intercept, slope]`；`sigma` 是残差（`y - (intercept + slope*x)`）的标准差（除以 n，不是 n-1，跟文件里 `logSplit` 的 `mean` 风格一致）；`r2` 复用已有的 `rSquared([ones, x], y)`。非正数的 x/y 先过滤掉再回归；过滤后 n < 2 时按 Interfaces 里写的兜底返回。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --experimental-strip-types --test-name-pattern="对数线性回归" tests/insight-drivers.test.ts`
Expected: PASS

- [ ] **Step 5: 跑类型检查**

Run: `npx tsc -p agent/tsconfig.json && npx tsc --noEmit`
Expected: 无新增错误

- [ ] **Step 6: Commit**

```bash
git add app/lib/insight/stats.ts tests/insight-drivers.test.ts
git commit -m "feat: 洞察图谱新增对数线性回归，供订单数/客单价联动用"
```

---

## Task 2: `types.ts` 新增 `"linked"` chart kind

**Files:**
- Modify: `app/lib/insight/types.ts`

**Interfaces:**
- Consumes: 无
- Produces: `InsightChart` 新增一个 union 分支，供 Task 3（`drivers.ts` 生成数据）和 Task 4（`insight-chart.tsx` 渲染）使用。字段定下来后两边都按这个来写，不在各自任务里再改动这个类型。

字段设计（直接加进 `app/lib/insight/types.ts` 的 `InsightChart` union，紧跟在 `whatif` 分支后面）：

```ts
// linked：两个变量互相按真实回归关系联动（不是恒等式）。拖一个，另一个按 slope/intercept 给建议值 + 波动范围；
// 建议值可以被用户再次手动覆盖，覆盖后角色互换（谁最后被拖动，谁是自变量）。
// a/b：两个滑块各自的展示信息（日均口径）；fit：a 对 b 的对数线性回归系数（log(b)=intercept+slope*log(a)），sigma 是对数尺度残差标准差；
// sales：销售额展示信息，base 是 a.base * b.base。
| { kind: "linked";
    a: { label: string; unit: string; digits: number; base: number; min: number; max: number };
    b: { label: string; unit: string; digits: number; base: number; min: number; max: number };
    fit: { slope: number; intercept: number; sigma: number };
    sales: { label: string; unit: string; digits: number } }
```

- [ ] **Step 1: 在 `app/lib/insight/types.ts` 的 `InsightChart` union 里加上述 `"linked"` 分支**

照抄上面的字段设计，注释保留（解释 a/b/fit/sales 各自含义，供后续维护者看懂，不解释「为什么加这个」）。

- [ ] **Step 2: 跑类型检查确认无报错**

Run: `npx tsc --noEmit && npx tsc -p agent/tsconfig.json`
Expected: PASS（这一步只加类型，不可能有运行时测试；类型检查是唯一的验证手段）

- [ ] **Step 3: Commit**

```bash
git add app/lib/insight/types.ts
git commit -m "feat: InsightChart 新增 linked 类型，表示两变量回归联动"
```

---

## Task 3: `drivers.ts` 生成 `orders`/`aov` 节点的 `linked` chart

**Files:**
- Modify: `app/lib/insight/drivers.ts`
- Test: `tests/insight-drivers.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `logLinearFit(xs, ys)`；Task 2 的 `InsightChart` 里的 `"linked"` 分支；文件内已有的 `full`（门店月度聚合，含 `days`/`sales`/`orders`）、`median`（`stats.ts` 已有）。
- Produces: `orders`、`aov` 两个节点各自的 `chart` 字段非空，`kind: "linked"`；两个节点共享同一份回归结果（只算一次）。

- [ ] **Step 1: 写失败测试（在 `tests/insight-drivers.test.ts` 里扩展现有「图谱：节点齐全」测试附近）**

```ts
test("订单数/客单价：挂了 linked 图，基准值是日均口径的中位数店", () => {
  const g = fakeGraph();
  const orders = g.nodes.find((n) => n.id === "orders")!;
  const aov = g.nodes.find((n) => n.id === "aov")!;
  assert.equal(orders.chart?.kind, "linked");
  assert.equal(aov.chart?.kind, "linked");
  // 两个节点共享同一份回归系数（同一次计算）。
  const oc = orders.chart as Extract<InsightChart, { kind: "linked" }>;
  const ac = aov.chart as Extract<InsightChart, { kind: "linked" }>;
  assert.equal(oc.fit.slope, ac.fit.slope);
  assert.equal(oc.fit.intercept, ac.fit.intercept);
  // 基准值是正数、在 min/max 范围内。
  assert.ok(oc.a.base > 0 && oc.a.base >= oc.a.min && oc.a.base <= oc.a.max);
  assert.ok(oc.b.base > 0 && oc.b.base >= oc.b.min && oc.b.base <= oc.b.max);
});
```

（需要在文件顶部 import 里加 `InsightChart` 类型，照文件现有 import 风格加 `type` 关键字。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --experimental-strip-types --test-name-pattern="订单数/客单价：挂了 linked 图" tests/insight-drivers.test.ts`
Expected: FAIL，`orders.chart` 是 `undefined`

- [ ] **Step 3: 在 `drivers.ts` 里算回归、生成 chart，挂到两个节点上**

在 `storeSplit`（第 93 行附近）算完之后，加一段：用 `full`（月度聚合）算 `logLinearFit(full.map(s => s.orders), full.map(s => s.sales / s.orders))`（x 是月订单数、y 是月客单价，月度算斜率不影响日均展示，详见 spec §6）；再算全局中位数门店的日均订单数（`median(full.map(s => s.orders / s.days))`）和对应客单价（用同一家中位数店的 `sales/orders`，不是分别取订单数中位数和客单价中位数两家不同的店）；`min`/`max` 取样本里日均订单数的 2%–98% 分位（复用 `insight-chart.tsx` 的 `Scatter` 组件里已有的分位数写法思路，但这里是在 `drivers.ts` 算好传过去，不在组件里算）。把这些塞进一个 `InsightChart`（`kind: "linked"`）常量，赋给 `orders` 和 `aov` 两个节点定义（459–465 行）各自的 `chart` 字段（两个节点的 `a`/`b` 顺序一致，都是 `a: 订单数`、`b: 客单价`，不要为了「主角是谁」在两个节点里颠倒顺序，颠倒会让 Task 4 的组件逻辑需要关心「我在哪个节点里渲染」，没有必要）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test --experimental-strip-types --test-name-pattern="订单数/客单价：挂了 linked 图" tests/insight-drivers.test.ts`
Expected: PASS

- [ ] **Step 5: 跑完整 insight 测试套件确认没有破坏既有行为**

Run: `node --test --experimental-strip-types tests/insight-drivers.test.ts tests/insight-agent.test.ts tests/insight-context.test.ts tests/insight-ask.test.ts tests/insight-peers.test.ts`
Expected: PASS

- [ ] **Step 6: 跑类型检查**

Run: `npx tsc --noEmit && npx tsc -p agent/tsconfig.json`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add app/lib/insight/drivers.ts tests/insight-drivers.test.ts
git commit -m "feat: 订单数/客单价节点挂上真实回归联动图"
```

---

## Task 4: `insight-chart.tsx` 渲染 `linked` 组件

**Files:**
- Modify: `app/components/insight/insight-chart.tsx`

**Interfaces:**
- Consumes: Task 2 的 `InsightChart`（`kind: "linked"` 分支，字段 `a`/`b`/`fit`/`sales`）。
- Produces: `InsightChartView` 的 `switch`/三元链里新增一个分支渲染这个 kind（跟现有 `whatif` 分支平级），无新的导出给其他文件用——这是叶子组件。

- [ ] **Step 1: 新增 `Linked` 组件（文件内，紧跟在 `WhatIf` 组件后面，约第 170 行之后）**

组件内部状态：`anchor: "a" | "b" | null`（null = 都没拖动过，显示基准值，无建议值/波动范围）、`aValue: number`、`bValue: number`（都初始化成 `chart.a.base`/`chart.b.base`）。

拖动 a 的滑块：`aValue` 设为滑块值，`anchor` 设为 `"a"`，用 `fit.slope`/`fit.intercept` 算 `bValue` 的建议值（`exp(intercept + slope * log(aValue))`），波动范围 `[建议值 * exp(-fit.sigma), 建议值 * exp(fit.sigma)]` 画在 b 滑块旁。拖动 b 时反过来：`anchor` 设为 `"b"`，反解 `aValue = exp((log(bValue) - intercept) / slope)`（`slope` 为 0 或样本太小时的兜底：若 `slope` 接近 0，不反解，`aValue` 保持不变，只显示 b 的手动值，不画 a 的波动范围——这种情况下 a 不随 b 变化是诚实的,因为回归本身说明不存在这个方向的关系）。

未拖动的那一侧（`anchor` 不是自己时）不画波动范围、不显示"建议值"高亮样式，只显示当前数值（跟 `anchor === null` 时两边都是这个状态一致）。

销售额始终 = `aValue * bValue`，按 `chart.sales` 的 `unit`/`digits` 格式化展示在两个滑块上方（参考 `WhatIf` 组件里 `result` 展示块的布局：`rounded-xl bg-[#f5f8ff]` 的卡片）。

波动范围旁的说明文字：「历史上日订单数在这个水平的门店，客单价大多落在这个区间，不是精确预测」（b 是建议方时）或对称的订单数版本（a 是建议方时）。

滑块 `min`/`max` 用 `chart.a.min/max`、`chart.b.min/max`（已经是分位数限制过的范围，组件不需要再裁剪）。

- [ ] **Step 2: 在 `InsightChartView` 的渲染分支里接上这个 kind**

在现有 `chart.kind === "whatif" ? <WhatIf chart={chart} /> : <Scatter chart={chart} />` 这一串三元表达式里，`whatif` 和 `scatter` 之间插入 `chart.kind === "linked" ? <Linked chart={chart} /> :`。

- [ ] **Step 3: 跑类型检查**

Run: `npx tsc --noEmit`
Expected: PASS（无 node:test 单测——这个文件现在没有被 node:test 测试覆盖，类型检查是前端组件现有的验证方式；若后续要加组件测试，project CLAUDE.md 的 `no-ui-test-harness` 记忆里提到有两种可行测法，可在此处套用，但本任务按文件现状不新增测试基建）

- [ ] **Step 4: 启动开发服务器，手动验证交互**

Run: `npm run dev:all`（或已在跑的话跳过），浏览器打开 `/analysis?mode=insight`，点开「订单数」或「客单价」节点，拖动滑块，确认：另一侧跟着变、波动范围显示、销售额同步变化、反复切换拖动方向不报错不漂移、拖到滑块两端（min/max）时数值合理不出现 NaN。

Expected: 交互符合 spec §4 描述；截图或口头确认后继续。

- [ ] **Step 5: Commit**

```bash
git add app/components/insight/insight-chart.tsx
git commit -m "feat: 洞察图谱渲染订单数/客单价拖动联动滑块"
```

---

## Task 5: 全量验证

**Files:** 无新文件，只跑验证命令。

- [ ] **Step 1: 跑全部单测**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 2: 跑两侧类型检查**

Run: `npx tsc --noEmit && npx tsc -p agent/tsconfig.json`
Expected: 无错误

- [ ] **Step 3: 跑 lint**

Run: `npm run lint`
Expected: 无错误

- [ ] **Step 4: 跑生产构建**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 5: Commit（如果前面步骤有修复产生新改动）**

仅在验证中发现并修复了问题时才需要这一步；如果全部一次通过，跳过。
