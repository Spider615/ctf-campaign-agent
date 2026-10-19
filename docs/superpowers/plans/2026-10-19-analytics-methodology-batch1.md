# 营销分析方法论第一批 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让计划式分析先判断问题类型和活动目标，按类型取计划骨架；机制比较必须对齐货；数据缺维度时不拿相近数据硬凑结论（原则 A）。

**Architecture:** 不动语义层和执行层。改三处：计划提示词（问题分型、目标、骨架、原则 A）、系统提示词（去掉与原则 A 冲突的「不以无法回答概括」）、计划复核（机制比较对齐货的检查，代码判定 + 复核提示）。目标和类型由计划步骤提交，存进计划并带入正文与复核提示。

**Tech Stack:** TypeScript（Node 22 strip-types）、Claude Agent SDK、zod、node:test。

依据：飞书《营销活动分析方法论：从目标到衡量》（wiki Lu9zw0xewi8FJwk0QoFcKMUin0f，revision 8）第三、四、八、十章。

## Global Constraints

- `app/lib/analytics/**`、`agent/**` 不 import npm 包（agent 内可用 zod 与 SDK）；相对 import 写全 `.ts` 扩展名；不用 enum、namespace、构造函数参数属性。
- 代码注释、提示词、错误信息用中文。
- 模型调用总数 ≤ 6，步骤数不变。
- 问题类型取值固定为：`lookup`（查数）、`review`（复盘）、`attribution`（归因）、`mechanism`（机制比较）、`scenario`（方案测算）、`opportunity`（找机会）。
- 活动目标取值固定为：`frequency`（提高到店频次）、`basket`（提高客单）、`series`（推重点系列或新品）、`revenue`（冲业绩）、`profit`（保利润）、`acquisition`（拉新）、`none`（查数等不涉及目标）。
- 目标 → 主指标 / 护栏指标对照（照抄方法论第三章，指标 id 用语义层已有的）：
  - frequency：主 `orders_per_day`；护栏 非活动日的 `orders_per_day`（非活动日有没有被挖空）
  - basket：主 `amount_per_order`、`grams` ÷ `quantity`（件均克重，现有指标没有时用 `amount_per_item` 代替并说明）；护栏 `margin_rate`
  - series：主 重点系列占比（按 `keySeries` 分组的 `amount` 占比）；护栏 整体 `amount`
  - revenue：主 `amount_per_day`；护栏 `margin_rate`
  - profit：主 `profit`、`margin_rate`；护栏 `quantity`
  - acquisition：数据里没有新会员数，标为测不了
- 原则 A（缺数据不硬答）：问题需要的维度或指标不在能力目录里时，不用相近维度凑结论；回答给出能确定的事实、说明缺什么、补了能回答到什么程度。按能力目录判断，不写死某个维度测不了。
- 机制比较对齐货：问题类型为 mechanism 时，对比节点的目标和参照都必须固定同一组货类（`categories`）且同一组材料（`materials`），或者 `align.controls` 含 `category` 和 `material`；不满足的对比节点在计划校验里报问题（与其他校验问题一样退回模型改一次）。
- 不能直接 `git commit`；由控制者统一提交。

---

### Task 1: 计划带上问题类型和目标，机制比较对齐货的校验

**Files:**
- Modify: `app/lib/analytics/plan/types.ts`（`AnalysisPlan` 增加 `intent?: { kind; goal; reason }`）
- Modify: `app/lib/analytics/plan/validate.ts`（`parsePlan` 解析 intent；`validatePlan` 在 kind 为 mechanism 时检查对比节点的货对齐）
- Modify: `agent/analysis-plan-run-turn.ts`（`planShape` 加 intent 的 zod 形状；审计 plan 事件记 intent；把 intent 传给正文和复核提示）
- Test: `tests/analysis-plan-validate.test.ts`、`tests/analysis-plan-runtime.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PlanKind = "lookup" | "review" | "attribution" | "mechanism" | "scenario" | "opportunity";
  export type PlanGoal = "frequency" | "basket" | "series" | "revenue" | "profit" | "acquisition" | "none";
  export type PlanIntent = { kind: PlanKind; goal: PlanGoal; reason: string };
  export type AnalysisPlan = { question: string; nodes: PlanNode[]; intent?: PlanIntent };
  ```

规则：
- intent 可选：没给时按 `{ kind: "review", goal: "none", reason: "" }` 处理，不报错（兼容旧测试和模型偶尔漏写）。kind 或 goal 不在取值范围内时报问题「intent.kind 取 lookup、review…」。reason 最长 200 字。
- 货对齐检查只针对 `op: "contrast"` 的节点，且只在 kind 为 mechanism 时做。判定：`target.filters.categories` 与 `reference.filters.categories` 都非空且相同（集合相等），并且 `materials` 同理；或 `align.controls` 同时含 `category`、`material`。否则报问题，`node` 为该节点 id，message：「机制比较要先对齐货：目标和参照固定同一货类（categories）和材料（materials），或在 align.controls 里控制 category、material；不同优惠吸引的货不同，不对齐时差异主要是选择效应」。
- 补充计划（followup）的节点同样受这个检查（followup 校验时把主计划的 intent 带上）。

- [ ] Step 1: 写测试：intent 缺省不报错；非法 kind 报错；mechanism 下未对齐的 contrast 报问题、对齐的通过、用 controls 对齐的通过；review 下不检查；followup 节点同样检查。
- [ ] Step 2: 实现，跑 `node --test --experimental-strip-types tests/analysis-plan-validate.test.ts tests/analysis-plan-runtime.test.ts` 与 `npx tsc --noEmit`、`npx tsc -p agent/tsconfig.json`。

### Task 2: 提示词：问题分型、目标、骨架、原则 A

**Files:**
- Modify: `app/lib/analytics/plan/prompt.ts`（`planPrompt`、`planReviewPrompt`、`answerPrompt`、`answerReviewPrompt`）
- Modify: `agent/analytics-system-prompt.ts`（`buildPlanSystemPrompt`）
- Modify: `agent/analytics-plugin/skills/ctf-marketing-advisor/SKILL.md`（只在 Skill 格式规则允许的前提下补充目标与护栏、原则 A；每条带 [S#] 出处，出处可引用飞书方法论文档）
- Test: `tests/analysis-plan-runtime.test.ts`（提示词内容断言）、`tests/skills.test.ts` 若有 Skill 校验

规则（写成提示词，不写成模板）：
- `planPrompt` 开头加「先判断」一节：
  - 问题类型（六类，各给一句典型问法和骨架要点，照抄方法论第十章（二）的表）；
  - 活动目标：用户没说时从活动名和问法推断；查数类为 none；给出目标 → 主指标 / 护栏对照；计划里要同时算主指标和护栏；
  - 提交时在 plan 里写 `intent: { kind, goal, reason }`，reason 一句话说明为什么这样判断；
  - 机制比较必须对齐货（说明原因：克减 50 件均克重是克减 30 的 3 倍，不对齐时比的是吸引来的货）；
  - 原则 A：先看能力目录；问题要的维度不在目录里（例如会员等级、会员 ID、活动费用、客流）时，不用相近维度凑结论，计划只算能确定的事实（例如会员销售占比），在 intent.reason 里写明缺什么。
- `planReviewPrompt` 增加检查：intent 是否和问题一致；主指标和护栏是否都在计划里；机制比较是否对齐货；是否拿相近维度凑原问题要的维度。
- `answerPrompt`：
  - 回答开头写一句按什么目标评估（goal 为 none 时不写），例如「按冲业绩看：……」；用户可以纠正；
  - 同时报主指标和护栏指标的结果，护栏恶化时要说出来；
  - 原则 A 的表达：先直接说这个问题现有数据回答不了及原因，再给能确定的事实，最后说补什么数据能回答到什么程度；不要给基于相近维度的对比结论；
  - 把 intent 传进来（`answerPrompt(question, summary, context, intent)`），在提示里显示「本题按 {类型} 处理，目标 {目标}：{reason}」。
- `answerReviewPrompt` 增加检查：有没有写目标；护栏是否提到；有没有用相近维度凑结论（原则 A）。
- `buildPlanSystemPrompt`：删掉「不以“不能做”“无法回答”“现有数据回答不了”概括用户的业务问题」这一句，改为原则 A 的表述：缺数据时直接说明答不了的部分和原因，同时给出能确定的事实和补数据的方向；不要用相近数据凑结论。其余保持。

- [ ] Step 1: 写/改测试：planPrompt 含六类类型和目标对照；answerPrompt 在 intent 给出时含目标说明、在 goal 为 none 时不含；系统提示词不再含「不以“不能做”」。
- [ ] Step 2: 改提示词与 Skill，跑 `npm test`、两边 tsc、lint。

### Task 3: 真实模型验收

- [ ] Step 1: 重启 `dev:all`，浏览器并发跑 S1–S5 和「库里有多少活动」。
- [ ] Step 2: 对比上一轮（提交 e46783c）：每题 intent 是否合理；S2 是否对齐货类材料（看计划节点的 filters）、结论是否随之变化；S4 是否按原则 A 回答（说清答不了、给会员占比事实、说明补什么）；每题 ≤6 调用、≤8 分钟；抽查数字与独立 SQL 一致。
- [ ] Step 3: 结果写进本计划末尾。

## 验收结果（2026-10-19）

- 六题问题类型和目标判断都合理：多少活动 lookup/none，S1 review/revenue，S2 mechanism/revenue，S3 opportunity/none，S4 review，S5 attribution/revenue；每题调用 5–6 次，耗时 32–246 秒。
- S2：计划固定一般足金类、足金材料后同店比较；日均 22,442,183.62 / 57,747,640.11 元、毛利率 18.02% / 16.02%，与独立 SQL 一致。
- S1：开头写「按冲业绩看」，同时报主指标和护栏（毛利率 -0.54 个百分点），分区表带毛利率。
- S4：先说按等级答不了及原因，给会员 / 非会员数据并写明不能当等级结论，最后说明补会员等级、会员 ID 后能回答什么。
- 验收中撤回了「相近维度不能做对比」的代码拦截（用户要求放开）：原则 A 只靠提示词和复核，不拿相近维度下原问题的结论，相近维度数据可作补充。
- 已知缺口：digitGuard 只拦阿拉伯数字，「两天」「三成」这类中文数字拦不住（S4 写了「七夕两天」，实际是 7 天）。
