# 营销分析自由正文回答 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把计划式分析的回答从固定板块（主结论、关键数据表、发现、建议、不能下的结论）改为模型自由组织的 Markdown 正文；正文里的数字、表格、图都用引用指向计算结果，由代码填值和生成。

**Architecture:** 计划、校验、执行不变。新增引用解析模块 `plan/refs.ts`（解析 `{{节点.指标.角色|维度=值}}` 和 `::: table` / `::: chart` 块，查事实、格式化、记录位置），答案组装改为生成 `analysis-answer/v4` 的块列表；`submit_claims` + `submit_wording_review` 换成 `submit_answer` + `submit_answer_review`。界面按块渲染，复用 `app/lib/markdown.ts` 的安全解析。v3 答案保留原渲染。

**Tech Stack:** TypeScript（Node 22 strip-types）、React 19、Claude Agent SDK、node:test。

设计文档：`docs/superpowers/specs/2026-10-19-analytics-free-form-answer-design.md`

## Global Constraints

- `app/lib/analytics/**`、`agent/**` 不 import npm 包（agent 内可用 zod 与 SDK）；相对 import 写全 `.ts` 扩展名；不用 enum、namespace、构造函数参数属性。
- 代码注释、界面文案、错误信息用中文。
- 正文数字只能来自引用；`digitGuard` 规则沿用：业务名称（维度取值、计划筛选值、编号前缀后的简称、档位简称）和原话里的日期时长可以照写，其他数字不行。
- 引用语法：`{{节点.指标}}`、`{{节点.指标.角色}}`、`{{节点.指标|维度=取值,维度=取值}}`、`{{节点.指标.角色|维度=取值}}`。角色取 value/target/reference/delta/change/deviation/share/contribution；省略时对比节点（contrast）默认 delta，下钻扫描默认 deviation，拆解（decompose）默认 contribution，其余默认 value——与现有 `defaultRole` 一致。分组省略时取总体行（key 为空）。
- 块语法独占一行：`::: table 节点 指标[,指标] [by 维度] [top N]`、`::: chart 节点 指标 [by 维度] [top N]`。
- 正文最多 1200 个字符（引用替换后计）；表格最多 3 个、图最多 2 个；每张表最多 8 行。
- 模型调用总数 ≤ 6：计划 ≤2、计划复核 1、补充计划 1、正文 1（同一调用内允许改一次）、正文复核 1。
- 答案 schema `analysis-answer/v4`；v3（`analysis-answer/v3`）仍能解码和显示；v2 仍按现有逻辑拒绝。
- 证据只保留被引用事实及其推导来源（沿用 `citedEvidence`）。
- 不能直接 `git commit`；所有提交在全部任务完成后由控制者统一做。

---

### Task 1: 引用解析模块

**Files:**
- Create: `app/lib/analytics/plan/refs.ts`
- Test: `tests/analysis-plan-refs.test.ts`

**Interfaces:**
- Consumes: `bind.ts` 的 `digitGuard`、`formatRoleValue`、`dedupeUnits`（需导出）、`nodeLiterals`（需导出）、`defaultRole`（需导出）；`execute.ts` 的 `PlanExecution`、`NodeRow`、`NodeRole`。
- Produces:
  ```ts
  export type RefSpan = { start: number; end: number; factIds: string[] };
  export type BodyBlock =
    | { kind: "markdown"; text: string; refs: RefSpan[] }
    | { kind: "table"; title: string; columns: string[]; rows: Array<{ cells: string[]; factIds: string[] }> }
    | { kind: "chart"; node: string; metric: string; by?: string; top: number };
  export type RefIssue = { text: string; reason: string };
  export type ResolvedBody = { blocks: BodyBlock[]; issues: RefIssue[]; factIds: string[]; keyFigure?: { value: string; factId: string } };
  export function resolveBody(body: string, execution: PlanExecution, literals: readonly string[], labels: { metric(id: string): string; dimension(id: string): string }): ResolvedBody;
  ```

规则：
- 正文按行切，`::: table` / `::: chart` 行单独成块，其余连续行合成一个 markdown 块。
- markdown 块逐个替换 `{{…}}`：节点不存在、未完成、指标或角色不存在、分组不唯一或不存在、值为空 → 记一条 issue（text 为所在句子，reason 写清原因），这个引用所在的句子（以 。！？\n 分句）从结果里删掉。
- 替换后的文字做 `dedupeUnits`；去掉引用后的文字做 `digitGuard`，不通过的句子删掉并记 issue（reason 用 `digitGuard` 返回的片段说明）。
- `refs` 记录每个替换后数字在最终文本里的 [start, end) 和 factIds；删句后位置要重新计算。
- table 块：从节点行取所列指标、按 by 维度分组（无 by 时取总体），按第一个指标降序取 top（默认 6，上限 8）；单元格用 `formatRoleValue`；对比节点时列为「分组、目标、参照、变化」（只取第一个指标）。节点或指标不存在 → issue，块丢弃。title 由代码生成：`各{维度}的{指标}` 或 `{指标}对比`。
- chart 块：只校验节点和指标存在，原样保留参数（图在 Task 2 由答案组装生成）。
- keyFigure：第一个 markdown 块的第一段（到第一个空行）恰好有一个引用时，取那个数。
- factIds：全部引用、表格单元格涉及的事实，去重。
- 正文超过 1200 字符时，在最后一个完整句子处截断，并记一条 issue「正文过长，已截断」。

测试至少覆盖：总体引用、带分组引用、默认角色、未知节点、分组不唯一、空值、写死数字被删句、业务名称数字保留、位置在删句后仍正确、table 分组降序 top、对比 table 四列、chart 参数校验、keyFigure 有一个和多个引用两种情况、超长截断。

- [ ] Step 1: 在 `bind.ts` 导出 `dedupeUnits`、`nodeLiterals`、`defaultRole`（只加 `export`，不改逻辑）。
- [ ] Step 2: 写 `tests/analysis-plan-refs.test.ts`，覆盖上面的情况，先确认失败。
- [ ] Step 3: 实现 `refs.ts`，跑 `node --test --experimental-strip-types tests/analysis-plan-refs.test.ts` 通过。
- [ ] Step 4: `npx tsc --noEmit` 通过。

### Task 2: v4 答案结构与组装

**Files:**
- Modify: `app/lib/analytics/analysis-v2-types.ts`（新增 `PLAN_ANSWER_V4_SCHEMA`、`PlanAnswerV4`）
- Modify: `app/lib/analytics/plan/answer.ts`（新增 `assemblePlanAnswerV4`、`validatePlanAnswerV4`、`planAnswerV4Text`；v3 的函数保留供旧答案显示）
- Test: `tests/analysis-plan-answer-v4.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ResolvedBody`、`BodyBlock`。
- Produces:
  ```ts
  export const PLAN_ANSWER_V4_SCHEMA = "analysis-answer/v4" as const;
  export type PlanAnswerBlock =
    | { kind: "markdown"; text: string; refs: Array<{ start: number; end: number; factIds: string[] }> }
    | { kind: "table"; title: string; columns: string[]; rows: Array<{ cells: string[]; factIds: string[] }> }
    | { kind: "chart"; chart: ResolvedVisualization };
  export type PlanAnswerV4 = {
    schema: typeof PLAN_ANSWER_V4_SCHEMA; runId: string; question: string; status: "answered" | "partial" | "unavailable";
    body: PlanAnswerBlock[]; keyFigure?: { value: string; factId: string };
    assumptions: string[]; definitions: string[];
    plan: Array<{ id: string; op: string; status: string; summary: string }>;
    review: { notes: string[] }; evidence: AnalysisEvidence; trace?: ToolTrace;
  };
  export type PlanAnswerV4Input = { runId: string; question: string; execution: PlanExecution; body: ResolvedBody; capabilities: AnalysisCapabilities; droppedNodes: Array<{ id: string; reason: string }>; reviewNotes: string[] };
  export function assemblePlanAnswerV4(input: PlanAnswerV4Input): PlanAnswerV4;
  export function validatePlanAnswerV4(value: unknown): PlanAnswerV4;
  export function planAnswerV4Text(answer: PlanAnswerV4): string;
  ```

规则：
- chart 块用现有 `chartFor` / `resolveChart` 生成：`by` 给定时，measure 节点按 by 分组画条形图，drill/scan 节点画偏离图；按日期分组画折线。生成不了图的 chart 块直接去掉。每张图的 id 用 `plan-chart-${runId}-${序号}`。
- `status`：正文为空 → unavailable（此时 body 放一个 markdown 块「这次没能得出可以直接采用的结论。」，不带 refs）；有 issue 或丢弃节点 → partial；否则 answered。
- assumptions/definitions 用现有 `collectDefinitions`，输入改为所有被引用的事实。
- evidence 用现有 `citedEvidence`，输入为 body.factIds 加图表 factIds。
- `validatePlanAnswerV4`：校验每个 refs 的 start/end 在文本范围内且 factIds 都在证据里；表格行 factIds 在证据里；图表用现有 `chartOf`。
- `planAnswerV4Text`：markdown 原文、表格转成「列 | 列」文本、图表写标题；用于复制和历史上下文。

- [ ] Step 1: 写测试：组装后 refs 指向的文本就是格式化后的数字；status 三种；图表块生成与丢弃；证据裁剪；校验拒绝越界 refs 和不存在的事实；纯文本输出。
- [ ] Step 2: 实现类型与函数，测试通过，`npx tsc --noEmit` 通过。

### Task 3: 运行流程换成正文提交

**Files:**
- Modify: `agent/analysis-plan-run-turn.ts`
- Modify: `app/lib/analytics/plan/prompt.ts`（新增 `answerPrompt`、`answerReviewPrompt`；删掉 `claimsPrompt` 和 `reviewPrompt` 的 wording 分支）
- Modify: `app/lib/analytics/tool-names.ts`（`submit_claims` → `submit_answer`「撰写回答」，`submit_wording_review` → `submit_answer_review`「复核回答」）
- Modify: `tests/analysis-plan-runtime.test.ts`（脚本化假模型的默认步骤改为新工具；涉及结论的用例改为正文）
- Delete: `tests/analysis-plan-bind.test.ts` 中只针对 `bindClaims` 的用例迁移到 refs 测试（Task 1 已覆盖的删掉，`digitGuard`、`formatRoleValue`、`totalAcrossWindows` 的用例保留）

**Interfaces:**
- Consumes: Task 1 `resolveBody`；Task 2 `assemblePlanAnswerV4`、`validatePlanAnswerV4`。
- Produces: runner 返回 `PlanAnswerV4`。

规则：
- `submit_answer({ body })`：`body` 为字符串，最长 4000 字符。首次提交有 issue 时退回 `{ accepted: false, issues }`，同一调用内允许改一次；第二次按结果采用；模型没有再交时采用首次结果。
- `submit_answer_review({ verdict: "ok" | "rewrite", body?, notes })`：rewrite 时用新正文重新 `resolveBody`，新结果没有比原结果多出 issue 才采用，否则保留原正文，并把原因记进 review notes。
- 复核提示里给出：原问题、用户此前说过的话、正文（引用原样）、每个引用替换后的值和它的「依据」（节点说明 + 分组）。要求检查：答非所问、相关写成因果、文字说的方向与引用值的正负不一致、对照期写错。
- `answerPrompt` 要点（写成提示词，不是模板）：
  - 回答像营销顾问说话，按问题组织，不要固定板块；问多少就先给数，复盘先给结论再给差异，决策先给推荐再给依据和风险，找机会给几条带数据的发现。
  - 不需要建议、不需要「不能下的结论」时就不写；数据缺口只在影响答案时提一句。
  - 数字全部用 `{{…}}` 引用，语法和默认角色说明；列出可用的表格、图块语法；不能自己算比例、倍数。
  - 两段时间天数不同时比较日均类指标；单个门店、商场这类个案不放第一句。
  - 正文 600 字以内。
  - 附执行结果（`executionSummary`，每行改为直接给出可复制的引用写法，例如 `{{c1.amount_per_day.change}} = +104.14%`）。
- `executionSummary` 每行输出格式改为 `` `{{节点.指标.角色|维度=值}}` = 格式化值（样本 N 行） ``，其余逻辑不变；补充计划提示里也用这一格式。
- 删除 `bindClaims` 及 `Claim`、`Binding` 等只给旧流程用的类型和函数；`digitGuard`、`formatValue`、`formatRoleValue`、`displayUnit`、`totalAcrossWindows`、`dedupeUnits` 保留。
- 审计：`answer` 事件记首次与最终正文、issues；`answer_review` 事件记复核结果；`final` 记 status、modelCalls、正文前 200 字。

- [ ] Step 1: 改 tool-names、prompt，写 `answerPrompt` / `answerReviewPrompt`。
- [ ] Step 2: 改 runner 两个步骤，返回 v4。
- [ ] Step 3: 改 runtime 测试：正常路径（调用 5 次、正文数字与证据一致）、首交 issue 退回重交、未再交采用首交、复核改写变差时保留原文、全部引用失败时 unavailable、调用上限仍 ≤6。
- [ ] Step 4: 清理 bind.ts 和 bind 测试；`npm test` 全部通过，`npx tsc --noEmit`、`npx tsc -p agent/tsconfig.json`、`npm run lint` 通过。

### Task 4: 解码、存储与界面

**Files:**
- Modify: `app/lib/analytics/stream.ts`（`isPlanAnswer` 判断 v3 或 v4；`validateAnalyticsAnswerResult` 两个版本都能解；`analyticsAnswerText` 分别调用；`normalizeAnalyticsAnswerSchema` 接受 v4）
- Modify: `app/lib/client/analytics.ts`、`app/lib/client/history-stream.ts`（请求头发 v4）
- Modify: `agent/http-handler.ts`、`app/lib/server/analytics-access.ts`（v4 正常，v3 请求头也接受——旧页面刷新前仍可用，回 v4）
- Modify: `app/components/analytics/plan-answer.tsx`（新增 `PlanAnswerV4View`；`PlanAnswerView` 保留给 v3）
- Modify: `app/components/analytics/history-message.tsx`、`report-view.tsx`（按 schema 选组件）
- Modify: `app/lib/attachments/answer.ts`、`agent/attachments/run-turn.ts`、`agent/analytics-evaluation.ts`（接受 v4）
- Test: `tests/analysis-plan-ui.test.ts`（v4 渲染）、`tests/analysis-v2-stream.test.ts` / `tests/analysis-plan-http.test.ts`（v4 解码与请求头）

界面规则：
- 有 keyFigure 时，最上面放大显示（沿用现有样式 `text-[32px]`），下面接正文。
- markdown 块用 `parseChatMarkdown` 解析；渲染文字时按 refs 把对应区间包成数字按钮：字号和正文一样、`font-semibold tabular-nums`、淡下划线，点击打开出处面板（`SourcePanel`，factIds 为该引用的事实）。区间跨越加粗标记时以 refs 为准，不渲染成嵌套。
- table 块：沿用现有关键数据表的样式；标题在表上方，小号。
- chart 块：`VisualizationCard`。
- 正文下面不再有固定的「建议」「暂时不能下的结论」。出处面板里保留口径、分析步骤。
- 不渲染 HTML，模型输出里的 HTML 按文字显示（现有 `parseChatMarkdown` 已保证）。

- [ ] Step 1: stream 与请求头：写测试（v4 解码、v3 仍解码、v2 拒绝），实现。
- [ ] Step 2: 界面：写 UI 测试（keyFigure 在最前；数字按钮存在且文本正确；表格、图按顺序出现；没有「主要发现」「建议」标题；HTML 被转义），实现。
- [ ] Step 3: 附件问答、评估脚本接受 v4；`npm test` 全部通过，两边 tsc、lint、`npm run build` 通过。

### Task 5: 真实模型验收

**Files:** 无代码改动（发现问题时回到对应任务修）。

- [ ] Step 1: 重启 `dev:all`，在浏览器隔离标签页并发跑 S1–S5，再单独问「帮我看下库里面有多少活动」和追问「每一个活动id就算是一个活动」。
- [ ] Step 2: 检查：每题 ≤6 次调用、≤8 分钟；「多少活动」第一句是 442、没有建议和不能下的结论；复盘、决策类有表格或图；抽查数字与独立 SQL 一致；旧会话里的 v3 答案仍能打开。
- [ ] Step 3: 把结果写进设计文档第 7 节。
