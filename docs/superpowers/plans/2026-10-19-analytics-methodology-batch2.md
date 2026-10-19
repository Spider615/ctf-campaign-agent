# 营销分析方法论第二批 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让复盘类问题能用「参加 / 不参加门店」做天然对照（双重差分）；量价拆解能按克重 × 每克价格拆；一般開單占比低时提示改用天然对照。

**Architecture:** 新增计划算子 `did`（双重差分），由执行层组合现有的范围读取完成：先按活动筛选取参加门店集合，再分别读取参加门店和其余门店在活动日、对照日的指标，代码算出两组变化和差中差。门店集合不进语义层维度（它依赖活动和期间，是派生的），只在执行时作为门店筛选传入。拆解已经支持按克重（`metrics` 含 grams 时以克重作数量），只需让计划能选。一般開單占比检查放在执行后：参照为一般開單的对比，代码计算它在目标范围内的占比，低于阈值时把提示写进执行结果。

**Tech Stack:** TypeScript（Node 22 strip-types）、Claude Agent SDK、node:test。

依据：飞书《营销活动分析方法论》第六章（参加门店周二 2.69 倍、不参加 1.01 倍）、第七章（金价与克重）、第九章（基线怎么选，一般開單 8 月上旬约 60%、22 日后 7%–24%）。

## Global Constraints

- `app/lib/analytics/**`、`agent/**` 不 import npm 包（agent 内可用 zod 与 SDK）；相对 import 写全 `.ts` 扩展名；不用 enum、namespace、构造函数参数属性。
- 代码注释、提示词、错误信息用中文。
- 模型调用总数 ≤ 6，步骤数不变；计划节点上限仍是 12。
- 数字只能来自执行结果的事实，事实要能登记进证据并通过 `validateAnalysisEvidence`。
- 「参加」的口径：在 did 节点给定的期间内，该门店至少有一笔符合活动筛选（`treatment` 筛选，通常是 `offers`）的销售成交。
- 一般開單低占比阈值：一般開單实收占目标范围实收的比例低于 30% 时提示。
- 语义层对账（`/tmp/ctf-sem/acc/run.ts`）改动后仍须 0 处不一致。
- 不能直接 `git commit`；由控制者统一提交。

---

### Task 1: 双重差分算子 did

**Files:**
- Modify: `app/lib/analytics/plan/types.ts`（`PlanNode` 增加 did）
- Modify: `app/lib/analytics/plan/validate.ts`（did 校验）
- Modify: `app/lib/analytics/plan/execute.ts`（did 执行）
- Modify: `app/lib/analytics/plan/answer.ts`（`summarize` 写 did 的说明；图表 `planChart` 不必支持 did）
- Modify: `app/lib/analytics/plan/refs.ts` / `bind.ts`（`defaultRole` 对 did 返回 `delta`，即差中差）
- Modify: `app/lib/analytics/plan/prompt.ts`（算子说明和示例；复盘骨架首选 did）
- Test: `tests/analysis-plan-did.test.ts`（新建）、`tests/analysis-plan-validate.test.ts`

**Interfaces:**
```ts
| { id: string; op: "did"; scope: PlanScope; treatment: Record<string, string[]>; treatmentPeriod?: { start: string; end: string }; event: Record<string, string[]>; control: Record<string, string[]>; metrics: string[] }
```
- `scope`：总范围（期间、口径、其他筛选，例如货类）。
- `treatment`：定义「参加」的筛选，例如 `{ "offers": ["H-金色星期二"] }`。
- `event`：活动日筛选，例如 `{ "days": ["2025-08-05","2025-08-12","2025-08-19","2025-08-26"] }`；`control`：对照日筛选，例如 `{ "dayTypes": ["工作日"] }` 并排除活动日（见下）。
- 指标：did 的主口径是「店日均」——每格内按（门店, 日期）汇总后，取有成交的店日的平均值，即 每格实收合计 ÷ 有成交的店日数。两组门店数、天数都不同，只有这个口径可比。计划里写 `metrics: ["amount", "orders"]` 等基础量，代码换算成店日均（metric 名加后缀 `_per_store_day`，例如 `amount_per_store_day`，单位「元/店日」「单/店日」）。不接受比率类指标（避免模型以为可以直接用 amount_per_day）。
- 店日数的取法：用 `by: ["store", "day"]` 读每格，数有成交的（门店, 日期）组合；不要用「门店数 × 天数」，那会把没成交的店日算进分母。
- 目标值（独立 SQL 已验证，期间 8/1–21，参加 = 当月有金色星期二成交的门店）：参加组周二 73,161 元/店日、周一三四 27,208，倍数 2.69；其余组 28,135 / 27,712，倍数 1.02。参加口径改为只看 8/1–21 内成交时为 3.02 / 1.06（门店集合不同），方法论文档用的是整月口径。

执行（全部在 `execute.ts` 里由现有 `operations.execute` 组合）：
1. 参加门店集合：`aggregate`，范围 = scope 叠加 treatment 筛选，`by: ["store"]`，取有成交的门店 id 列表。
2. 四个格子，各一次 `aggregate`（不叠加 treatment 筛选，看的是门店全部成交）：
   - 参加门店 × 活动日：scope + event + `stores=参加集合`
   - 参加门店 × 对照日：scope + control + `stores=参加集合`
   - 其余门店 × 活动日：scope + event，`excludeStores=参加集合`
   - 其余门店 × 对照日：scope + control，`excludeStores=参加集合`
   （`excludeStores` 目前只在 aggregate 查询里支持；如果 `operations.execute` 不接受，在 operations 增加 `excludeStores` 作为 aggregate 请求的可选参数并透传给 session.aggregate，snapshot 数据源同样支持。）
3. control 与 event 重叠时（例如 control 是工作日、event 的日期也是工作日）：对照日要排除活动日。实现方式：如果 event 用 `days`，control 读取后在代码里去掉这些日期——最简单是要求 control 也写成 `days`，由校验检查两者不相交；或在执行时用 `days` 补集。选一种并在报告里说明。
4. 事实：每格每个指标一条（role 记为 `cell`，key 为 `{ group: "参加"|"其余", period: "活动日"|"对照日" }`）；每组变化 `change`（活动日 ÷ 对照日 − 1，单位 %，key 为 `{ group }`）；倍数 `ratio`（活动日 ÷ 对照日，单位「倍」，key 为 `{ group }`）；差中差 `delta`（参加组变化 − 其余组变化，单位「个百分点」，总体行，key 为空）。派生事实用 `expression` 写出推导式，保证 `validateAnalysisEvidence` 能核对。
5. 门店数事实：两组门店数各一条（metric `stores`，role `value`，key `{ group }`），便于正文说明样本。
6. 参加门店数为 0 或其余门店数为 0 时，节点 unsupported，message 写明原因。

NodeRole 需要增加 `cell` 和 `ratio`（`execute.ts` 的类型、refs 的角色列表、提示词的角色说明同步）。

测试（用快照数据源或手写夹具）：四格数值正确；变化、倍数、差中差的推导正确；参加集合按 treatment 筛选；其余组排除参加门店；事实通过 `validateAnalysisEvidence`；合计类指标被校验拒绝；没有参加门店时 unsupported；正文引用 `{{d1.amount_per_day}}` 默认取差中差，`{{d1.amount_per_day.ratio|group=参加}}` 取倍数。

- [ ] Step 1: 写测试，确认失败。
- [ ] Step 2: 实现类型、校验、执行、默认角色、说明、提示词。
- [ ] Step 3: 用真实库验证金色星期二：scope 期间 8/1–21，treatment 用整月（did 节点可选 `treatmentPeriod`，缺省等于 scope 期间）；event 为 8/5、8/12、8/19，control 为同期的周一、三、四（days 列出）。期望参加组 2.69 倍、其余组 1.02 倍；写 /tmp 脚本跑 executePlan，结果写进报告。
- [ ] Step 4: `npm test`、两边 tsc、lint 通过。

### Task 2: 克重 × 每克价格拆解、一般開單占比提示

**Files:**
- Modify: `app/lib/analytics/plan/types.ts`（decompose 增加可选 `basis?: "quantity" | "grams"`）
- Modify: `app/lib/analytics/plan/execute.ts`（decompose 按 basis 传 metrics：grams 时 `["amount","grams"]`）
- Modify: `app/lib/analytics/plan/execute.ts` 或 `agent/analysis-plan-run-turn.ts`（一般開單占比检查）
- Modify: `app/lib/analytics/plan/prompt.ts`（decompose 说明 basis；跨期、金价相关问题用 grams；基线选择说明）
- Test: `tests/analysis-plan-execute.test.ts`、`tests/analysis-plan-runtime.test.ts`

规则：
- decompose 的 `basis` 缺省为 quantity（现状）。grams 时拆成「克重变化贡献」「每克实收变化贡献」「结构贡献」，事实 metric 名沿用现有 `amount.quantity_contribution` 等（labels 已按分母显示「克重变化贡献」），在 `summarize` 里写明按克重拆。
- 一般開單占比：对每个参照范围筛选为 `offers=["一般開單"]` 的 contrast 节点，代码另读一次目标范围（去掉 offers 筛选）中一般開單的实收占比；低于 30% 时：在执行结果摘要（`executionSummary` 的「其他节点」段）加一行「cX 的参照一般開單在目标范围只占 Y%，七夕等活动密集期大部分成交挂在优惠上，一般開單不是可比的基线，建议改用 did」，并把同样的提示加入正文提示词可见的位置。不改变节点结果，不阻断。这个占比本身登记为事实，可被引用。
- 提示词：基线选择写进计划提示——首选 did（参加 / 不参加门店 × 活动日 / 对照日），一般開單只在占比足够高时当基线；跨月、问金价时 decompose 用 grams。

- [ ] Step 1: 写测试（basis=grams 时贡献项的分母是克重；一般開單占比低于阈值时摘要出现提示行、高于阈值时不出现；占比事实能通过证据校验）。
- [ ] Step 2: 实现，`npm test`、两边 tsc、lint 通过。

### Task 3: 对账与真实模型验收

- [ ] Step 1: 跑语义层对账 `/tmp/ctf-sem/acc/run.ts`，0 处不一致。
- [ ] Step 2: 重启 `dev:all`，浏览器并发跑飞书题集第 2 题（金色星期二）、第 3 题、第 5 题、第 6 题、第 9 题和 S1。
- [ ] Step 3: 检查：第 2 题用了 did，给出参加 / 其余两组倍数和差中差，数字与独立 SQL 一致；第 5 题按克重拆；七夕相关对比若用一般開單作基线，摘要出现占比提示；每题 ≤6 次调用、≤8 分钟。
- [ ] Step 4: 结果写进本计划末尾。
