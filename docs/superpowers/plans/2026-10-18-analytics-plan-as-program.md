# 营销分析「计划即程序」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用「声明式分析计划 → 代码静态校验并执行 → 模型只写结论措辞 → 代码绑定数字与渲染」替换现有多轮自由分析流程。

**Architecture:** 新增 `app/lib/analytics/plan/`，纯函数，不依赖 SDK，包含计划 schema、静态校验、执行器（复用现有分析操作内核）、结论绑定、答案组装、图表推导。`agent/analysis-plan-run-turn.ts` 用 SDK 依次完成 4 步模型调用：写计划、计划复核、写结论、措辞复核，外加最多一次补充计划；总调用数不超过 6。页面新增 `PlanAnswerView`。旧流程整体删除。

**Tech Stack:** TypeScript（Node 22 strip-types），Claude Agent SDK（仅 `agent/`），zod v4（仅 `agent/`），React（页面），node:test。

设计依据：`docs/superpowers/specs/2026-10-18-analytics-playbook-orchestration-design.md`（下称「设计」）。

## Global Constraints

- `app/lib/analytics/**` 不 import npm 包、`cloudflare:workers`、`db/*`；相对 import 写全 `.ts`；不用 enum、namespace、构造函数参数属性。
- 数字只来自代码计算的证据；模型输出里不允许出现数值字面量，校验规则是去掉 `{...}` 占位后不能含阿拉伯数字。
- 模型不写 SQL；只读；可取消；不触发 1811 建单。
- 一次回合的模型调用 ≤ 6：计划 ≤ 2、补充 ≤ 1、计划复核 1、结论 1、措辞复核 1。
- 答案结构上限：headline 1 条、claims ≤ 5、actions ≤ 3、cannotConclude ≤ 5、图 ≤ 1。
- 界面文案、错误信息、注释用中文。
- 每个任务结束都要跑 `npm test`、`npx tsc --noEmit`、`npx tsc -p agent/tsconfig.json`，并全部通过；被替换的旧测试在对应任务里删除，并在提交说明里写明。
- 工作区有其他会话未提交的改动；每个任务只 `git add` 本任务列出的文件。

---

## 文件结构

新增：

| 文件 | 职责 |
|---|---|
| `app/lib/analytics/plan/types.ts` | 计划节点、计划、结论、答案的类型 |
| `app/lib/analytics/plan/validate.ts` | 计划的结构解析和静态校验，一次返回全部问题 |
| `app/lib/analytics/plan/execute.ts` | 按依赖顺序执行节点，结果写入证据注册表，返回节点结果索引 |
| `app/lib/analytics/plan/bind.ts` | 结论绑定、方向校验、数字填充、可信度计算 |
| `app/lib/analytics/plan/answer.ts` | 组装答案：限制说明、不能下的结论、图表推导、纯文本 |
| `app/lib/analytics/plan/prompt.ts` | 给模型的能力目录摘要和三段提示词（纯字符串） |
| `agent/analysis-plan-run-turn.ts` | SDK 编排，最多 6 次调用 |
| `app/components/analytics/plan-answer.tsx` | 页面渲染 |
| `tests/analysis-plan-*.test.ts` | 各模块测试 |

改动：`app/lib/analytics/semantic/model.ts`（新增每店指标）、`app/lib/analytics/analysis-v2-types.ts`（答案类型）、`app/lib/analytics/stream.ts`、`agent/server.ts`、`agent/http-handler.ts`、`agent/attachments/run-turn.ts`、`agent/attachments/tools.ts`、`app/lib/attachments/answer.ts`、`app/components/attachments/file-answer.tsx`、`app/components/analytics/history-message.tsx`、`app/components/analytics/report-view.tsx`、`app/lib/client/history-conversation.ts`、`app/lib/analytics/tool-names.ts`。

删除（Task 9）：`agent/general-analytics-run-turn.ts`、`agent/analytics-calculations.ts`、`agent/analytics-scenarios.ts`、`agent/analytics-review-support.ts`、`agent/analytics-review-cache.ts`、`agent/analytics-evidence-context.ts` 中只服务旧流程的部分、`agent/visualization-runtime.ts` 与 `agent/visualization-schema.ts` 中只服务分析的部分、`app/components/analytics/analysis-answer.tsx`、`app/lib/analytics/analysis-v2-format.ts`，以及对应的旧测试。

---

### Task 1: 语义层补每店指标

**Files:**
- Modify: `app/lib/analytics/semantic/model.ts`
- Modify: `agent/analytics-operation-database.ts`（能力目录中加入新指标）
- Test: `tests/analysis-semantic-layer.test.ts`

**Interfaces:**
- Produces: 指标 `amount_per_store`（分母 `stores`）、`profit_per_store`（分子 `profit`，分母 `stores`），`SemanticRatio.denominator` 允许 `"stores"`。

- [ ] **Step 1: 写失败测试**，追加到 `tests/analysis-semantic-layer.test.ts`：

```ts
test("每店实收 = 实收 ÷ 有成交门店数，每店毛利同理", async () => {
  const rows: Row[] = [...month, ...month.map((row) => ({ ...row, store: "B" }))];
  const base = session(rows);
  const withStores: AnalysisDataSession = { ...base, capabilities: { ...base.capabilities, metrics: analysisMetricDefinitions("CNY", ["amount", "profit", "stores", "rows", "amount_per_store", "profit_per_store"], "snapshot") } };
  const result = await createAnalysisOperations(withStores, { filters: {} }).execute({ needIds: ["need-1"], purpose: "每店", method: "aggregate", metrics: ["amount_per_store", "profit_per_store"], scope: { period: month31, population: "sales", filters: { festivals: ["七夕节"] } } });
  assert.equal(value(result.facts, "amount_per_store"), 700);
  assert.equal(value(result.facts, "profit_per_store"), 140);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test --experimental-strip-types --test-name-pattern="每店实收" tests/analysis-semantic-layer.test.ts`
Expected: FAIL，类型或运行时报错「amount_per_store」不在 `ANALYSIS_METRICS`。

- [ ] **Step 3: 实现**。在 `model.ts` 的 `ANALYSIS_METRICS` 末尾追加 `"amount_per_store", "profit_per_store"`，在 `SEMANTIC_METRICS` 追加：

```ts
  amount_per_store: { label: "每店实收", unit: "money_per_store", grain: "line", additive: false, populations: ["sales"], requires: [], definition: "实收除以范围内有成交的门店数；用于门店数量不同的分组之间比较", basis: "data", ratio: ratio([plus("amount")], "stores", { standardize: false }) },
  profit_per_store: { label: "每店毛利", unit: "money_per_store", grain: "line", additive: false, populations: ["sales"], requires: [], definition: "零售毛利除以范围内有成交的门店数；毛利口径待确认", basis: "assumption", ratio: ratio([plus("profit")], "stores", { standardize: false }) },
```

`SemanticUnit` 加入 `"money_per_store"`，`semanticUnit` 加一个分支：`if (unit === "money_per_store") return \`${currency}/店\`;`。在 `agent/analytics-operation-database.ts` 的 `availableCapabilities` 中，在 `metrics.push("amount_per_day", "amount_per_item");` 之后加 `metrics.push("amount_per_store"); if (columns.includes("零售毛利")) metrics.push("profit_per_store");`。

- [ ] **Step 4: 运行测试并通过；跑全量与两侧 tsc**

Run: `npm test && npx tsc --noEmit && npx tsc -p agent/tsconfig.json`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add app/lib/analytics/semantic/model.ts agent/analytics-operation-database.ts tests/analysis-semantic-layer.test.ts
git commit -m "feat: 语义层增加每店实收与每店毛利"
```

---

### Task 2: 计划类型与静态校验

**Files:**
- Create: `app/lib/analytics/plan/types.ts`
- Create: `app/lib/analytics/plan/validate.ts`
- Test: `tests/analysis-plan-validate.test.ts`

**Interfaces:**
- Consumes: `AnalysisCapabilities`、`AnalysisScope`、`AnalysisConstraints`、`normalizeAnalysisScope`（来自 `analysis-v2-*`），语义层的 `SEMANTIC_METRICS`、`SEMANTIC_DIMENSIONS`。
- Produces:

```ts
// types.ts
export type PlanScope = { period: { start: string; end: string }; population: "sales" | "net" | "returns" | "recovery" | "zero_sales"; filters: Record<string, string[]> };
export type PlanNode =
  | { id: string; op: "measure"; scope: PlanScope; metrics: string[]; by?: string[] }
  | { id: string; op: "contrast"; target: PlanScope; reference: PlanScope; metrics: string[]; by?: string[]; align?: { commonStores?: boolean; controls?: string[] } }
  | { id: string; op: "decompose"; of: string }
  | { id: string; op: "drill"; of: string; path: string[]; minRows?: number }
  | { id: string; op: "scan"; of: string; dimensions?: string[]; minRows?: number; top?: number }
  | { id: string; op: "robust"; of: string; checks: Array<"largest_store" | "largest_order" | "halves" | "alternative_window">; alternative?: { start: string; end: string } }
  | { id: string; op: "scenario"; of: string; adjustment: { kind: "per_gram" | "per_item" | "per_order"; amount: string } | { kind: "amount_rate"; rate: string } | { kind: "order_threshold"; threshold: string; amount: string }; netVolumeChanges: string[]; reason: string };
export type AnalysisPlan = { question: string; nodes: PlanNode[] };
export type PlanIssue = { node?: string; field?: string; message: string };
export type PlanValidation = { valid: PlanNode[]; dropped: Array<{ node: PlanNode; issues: PlanIssue[] }>; issues: PlanIssue[] };
// validate.ts
export function parsePlan(raw: unknown): { plan?: AnalysisPlan; issues: PlanIssue[] };
export function validatePlan(plan: AnalysisPlan, capabilities: AnalysisCapabilities, constraints: AnalysisConstraints): PlanValidation;
```

计划的上限：节点 ≤ 12，指标 ≤ 6，`by` ≤ 2，`drill.path` ≤ 3，`scan.dimensions` ≤ 30，`top` ≤ 10，`minRows` 默认 200。

- [ ] **Step 1: 写失败测试** `tests/analysis-plan-validate.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parsePlan, validatePlan } from "../app/lib/analytics/plan/validate.ts";
import { analysisMetricDefinitions } from "../app/lib/analytics/analysis-v2-operations.ts";
import type { AnalysisCapabilities } from "../app/lib/analytics/analysis-v2-types.ts";

const capabilities: AnalysisCapabilities = { mode: "database", name: "测试", coverage: { start: "2025-08-01", end: "2025-08-31" }, currency: "人民币", provenance: "imported", dimensions: ["region", "district", "store", "category", "material", "festival", "offer"], metrics: analysisMetricDefinitions("人民币", ["amount", "orders", "stores", "grams", "rows", "amount_per_day", "amount_per_order", "amount_per_gram", "discount_rate"], "database"), methods: ["aggregate", "compare", "decompose", "scan", "robustness"], limitations: [] };
const scope = (filters: Record<string, string[]> = {}) => ({ period: { start: "2025-08-01", end: "2025-08-31" }, population: "sales" as const, filters });

test("合法计划全部保留，节点引用按依赖顺序检查", () => {
  const { plan, issues } = parsePlan({ question: "七夕怎么样", nodes: [
    { id: "c1", op: "contrast", target: scope({ festivals: ["七夕节"] }), reference: scope({ festivals: ["非节庆"] }), metrics: ["amount_per_day", "discount_rate"] },
    { id: "d1", op: "drill", of: "c1", path: ["region", "district"] },
    { id: "r1", op: "robust", of: "c1", checks: ["largest_store"] },
  ] });
  assert.deepEqual(issues, []);
  const checked = validatePlan(plan!, capabilities, { filters: {} });
  assert.equal(checked.valid.length, 3); assert.deepEqual(checked.issues, []);
});

test("一次返回全部问题：未知指标、缺控制、口径不符、超范围、悬空引用、层级不成立", () => {
  const { plan } = parsePlan({ question: "q", nodes: [
    { id: "a", op: "measure", scope: scope(), metrics: ["profit_margin_guess"] },
    { id: "b", op: "measure", scope: scope(), metrics: ["amount_per_gram"], by: ["region"] },
    { id: "c", op: "measure", scope: { ...scope(), population: "net" }, metrics: ["amount_per_order"] },
    { id: "d", op: "measure", scope: { ...scope(), period: { start: "2025-07-01", end: "2025-08-31" } }, metrics: ["amount"] },
    { id: "e", op: "decompose", of: "missing" },
    { id: "f", op: "drill", of: "a", path: ["district", "region"] },
  ] });
  const checked = validatePlan(plan!, capabilities, { filters: {} });
  const messages = checked.issues.map((issue) => `${issue.node}:${issue.message}`).join("\n");
  for (const node of ["a", "b", "c", "d", "e", "f"]) assert.match(messages, new RegExp(`^${node}:`, "m"), `${node} 没有报告问题`);
  assert.equal(checked.valid.length, 0);
});

test("decompose 只能指向 contrast；依赖被丢弃的节点也一并丢弃", () => {
  const { plan } = parsePlan({ question: "q", nodes: [
    { id: "m", op: "measure", scope: scope(), metrics: ["amount"] },
    { id: "x", op: "decompose", of: "m" },
    { id: "bad", op: "contrast", target: scope(), reference: scope(), metrics: ["unknown"] },
    { id: "r", op: "robust", of: "bad", checks: ["largest_store"] },
  ] });
  const checked = validatePlan(plan!, capabilities, { filters: {} });
  assert.deepEqual(checked.valid.map((node) => node.id), ["m"]);
  assert.deepEqual(checked.dropped.map((item) => item.node.id).sort(), ["bad", "r", "x"]);
});

test("结构错误在解析阶段报告：重复 id、未知算子、超上限", () => {
  const { issues } = parsePlan({ question: "q", nodes: [{ id: "a", op: "measure", scope: scope(), metrics: ["amount"] }, { id: "a", op: "magic" }, ...Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, op: "measure", scope: scope(), metrics: ["amount"] }))] });
  const text = issues.map((issue) => issue.message).join("\n");
  assert.match(text, /重复/); assert.match(text, /算子/); assert.match(text, /最多 12/);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test --experimental-strip-types tests/analysis-plan-validate.test.ts`
Expected: FAIL，提示无法加载 `plan/validate.ts`。

- [ ] **Step 3: 实现 `types.ts`**，内容就是上面 Interfaces 中的类型，加一个文件头注释：`// 声明式分析计划：节点只能使用语义层登记的维度、指标与筛选，由代码校验和执行。`

- [ ] **Step 4: 实现 `validate.ts`**：

```ts
import { normalizeAnalysisScope } from "../analysis-v2-operations.ts";
import type { AnalysisCapabilities, AnalysisConstraints, AnalysisDimension, AnalysisScope } from "../analysis-v2-types.ts";
import { SEMANTIC_DIMENSIONS, type SemanticDimensionId } from "../semantic/model.ts";
import type { AnalysisPlan, PlanIssue, PlanNode, PlanScope, PlanValidation } from "./types.ts";

const OPS = ["measure", "contrast", "decompose", "drill", "scan", "robust", "scenario"] as const;
const CHECKS = ["largest_store", "largest_order", "halves", "alternative_window"] as const;
const LIMITS = { nodes: 12, metrics: 6, by: 2, path: 3, dimensions: 30, top: 10 } as const;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown, max: number) => Array.isArray(value) && value.length <= max && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 120) ? value as string[] : undefined;

// 结构解析：只检查形状，不查能力目录；问题全部收集后一次返回。
export function parsePlan(raw: unknown): { plan?: AnalysisPlan; issues: PlanIssue[] } {
  const issues: PlanIssue[] = [];
  if (!isObject(raw) || typeof raw.question !== "string" || !Array.isArray(raw.nodes)) return { issues: [{ message: "计划需要 question 和 nodes" }] };
  if (raw.nodes.length > LIMITS.nodes) issues.push({ message: `计划最多 ${LIMITS.nodes} 个节点` });
  const seen = new Set<string>(); const nodes: PlanNode[] = [];
  for (const item of raw.nodes.slice(0, LIMITS.nodes)) {
    if (!isObject(item) || typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(item.id)) { issues.push({ message: "节点 id 只能是 1–40 位字母数字" }); continue; }
    if (seen.has(item.id)) { issues.push({ node: item.id, message: "节点 id 重复" }); continue; }
    seen.add(item.id);
    if (!OPS.includes(item.op as typeof OPS[number])) { issues.push({ node: item.id, message: `不支持的算子 ${String(item.op)}，可用：${OPS.join("、")}` }); continue; }
    nodes.push(item as PlanNode);
  }
  return { plan: { question: raw.question, nodes }, issues };
}

function checkScope(node: string, field: string, scope: PlanScope, capabilities: AnalysisCapabilities, constraints: AnalysisConstraints, issues: PlanIssue[]): AnalysisScope | undefined {
  if (!isObject(scope)) { issues.push({ node, field, message: "范围缺失" }); return undefined; }
  try { return normalizeAnalysisScope(scope, capabilities, constraints); }
  catch (error) { issues.push({ node, field, message: error instanceof Error ? error.message : "范围不正确" }); return undefined; }
}
function checkMetrics(node: string, metrics: unknown, populations: AnalysisScope[], controls: string[], capabilities: AnalysisCapabilities, issues: PlanIssue[]) {
  const list = strings(metrics, LIMITS.metrics);
  if (!list?.length) { issues.push({ node, field: "metrics", message: `metrics 需要 1–${LIMITS.metrics} 个语义层指标` }); return; }
  const available = new Map(capabilities.metrics.map((metric) => [metric.id, metric]));
  for (const metric of list) {
    const definition = available.get(metric);
    if (!definition) { issues.push({ node, field: "metrics", message: `指标 ${metric} 不在能力目录` }); continue; }
    for (const scope of populations) if (!definition.allowedPopulations.includes(scope.population)) issues.push({ node, field: "metrics", message: `${definition.label}只适用于 ${definition.allowedPopulations.join("、")} 口径` });
    for (const dimension of definition.requiredControls) {
      const fixed = populations.every((scope) => scope.filters[SEMANTIC_DIMENSIONS[dimension as SemanticDimensionId].filter]?.length === 1);
      if (!fixed && !controls.includes(dimension)) issues.push({ node, field: "metrics", message: `${definition.label}需要固定或分组控制 ${SEMANTIC_DIMENSIONS[dimension as SemanticDimensionId].label}` });
    }
  }
}
function checkDimensions(node: string, field: string, value: unknown, max: number, capabilities: AnalysisCapabilities, issues: PlanIssue[]): AnalysisDimension[] {
  if (value === undefined) return [];
  const list = strings(value, max);
  if (!list) { issues.push({ node, field, message: `${field} 最多 ${max} 个维度` }); return []; }
  const unknown = list.filter((dimension) => !capabilities.dimensions.includes(dimension as AnalysisDimension));
  for (const dimension of unknown) issues.push({ node, field, message: `维度 ${dimension} 不在能力目录` });
  return list.filter((dimension) => !unknown.includes(dimension)) as AnalysisDimension[];
}

// 静态校验：按节点顺序检查；依赖的节点被丢弃时，依赖方也丢弃。
export function validatePlan(plan: AnalysisPlan, capabilities: AnalysisCapabilities, constraints: AnalysisConstraints): PlanValidation {
  const issues: PlanIssue[] = []; const valid: PlanNode[] = []; const dropped: PlanValidation["dropped"] = [];
  const kept = new Map<string, PlanNode>(); const declared = new Set(plan.nodes.map((node) => node.id));
  for (const node of plan.nodes) {
    const own: PlanIssue[] = [];
    const parent = "of" in node ? node.of : undefined;
    if (parent !== undefined) {
      if (!declared.has(parent)) own.push({ node: node.id, field: "of", message: `引用的节点 ${parent} 不存在` });
      else if (!kept.has(parent)) own.push({ node: node.id, field: "of", message: `引用的节点 ${parent} 未通过校验` });
    }
    const source = parent ? kept.get(parent) : undefined;
    if (node.op === "measure") {
      const scope = checkScope(node.id, "scope", node.scope, capabilities, constraints, own);
      const by = checkDimensions(node.id, "by", node.by, LIMITS.by, capabilities, own);
      if (scope) checkMetrics(node.id, node.metrics, [scope], by, capabilities, own);
    } else if (node.op === "contrast") {
      const target = checkScope(node.id, "target", node.target, capabilities, constraints, own); const reference = checkScope(node.id, "reference", node.reference, capabilities, constraints, own);
      const by = checkDimensions(node.id, "by", node.by, LIMITS.by, capabilities, own); const controls = checkDimensions(node.id, "align.controls", node.align?.controls, 4, capabilities, own);
      if (target && reference) { if (target.population !== reference.population) own.push({ node: node.id, message: "目标与参照口径必须相同" }); checkMetrics(node.id, node.metrics, [target, reference], [...by, ...controls], capabilities, own); }
    } else if (node.op === "decompose") {
      if (source && source.op !== "contrast") own.push({ node: node.id, field: "of", message: "decompose 只能拆解 contrast 节点" });
      if (source?.op === "contrast" && !source.metrics.includes("amount") && !source.metrics.includes("amount_per_day")) own.push({ node: node.id, field: "of", message: "decompose 需要被拆解的 contrast 含实收或日均实收" });
    } else if (node.op === "drill") {
      if (source && source.op !== "contrast" && source.op !== "measure") own.push({ node: node.id, field: "of", message: "drill 只能下钻 measure 或 contrast" });
      const path = checkDimensions(node.id, "path", node.path, LIMITS.path, capabilities, own);
      if (!path.length) own.push({ node: node.id, field: "path", message: "path 需要 1–3 个维度" });
      for (let i = 1; i < path.length; i++) {
        let parentDimension = SEMANTIC_DIMENSIONS[path[i] as SemanticDimensionId].parent; while (parentDimension && parentDimension !== path[i - 1]) parentDimension = SEMANTIC_DIMENSIONS[parentDimension].parent;
        if (parentDimension !== path[i - 1]) own.push({ node: node.id, field: "path", message: `${SEMANTIC_DIMENSIONS[path[i] as SemanticDimensionId].label}不是${SEMANTIC_DIMENSIONS[path[i - 1] as SemanticDimensionId].label}的下级` });
      }
    } else if (node.op === "scan") {
      if (source && source.op !== "contrast" && source.op !== "measure") own.push({ node: node.id, field: "of", message: "scan 只能展开 measure 或 contrast" });
      const dimensions = checkDimensions(node.id, "dimensions", node.dimensions, LIMITS.dimensions, capabilities, own);
      for (const dimension of dimensions) if (!SEMANTIC_DIMENSIONS[dimension as SemanticDimensionId].scan) own.push({ node: node.id, field: "dimensions", message: `${SEMANTIC_DIMENSIONS[dimension as SemanticDimensionId].label}不参与扫描` });
      if (node.top !== undefined && (!Number.isInteger(node.top) || node.top < 1 || node.top > LIMITS.top)) own.push({ node: node.id, field: "top", message: `top 取 1–${LIMITS.top}` });
    } else if (node.op === "robust") {
      if (!Array.isArray(node.checks) || !node.checks.length || node.checks.some((check) => !CHECKS.includes(check))) own.push({ node: node.id, field: "checks", message: `checks 取 ${CHECKS.join("、")}` });
      if (node.checks?.includes("alternative_window") && !node.alternative) own.push({ node: node.id, field: "alternative", message: "alternative_window 需要提供替代窗口" });
      if (node.checks?.includes("largest_order") && source && (source.op === "measure" ? source.scope.population : source.op === "contrast" ? source.target.population : "sales") !== "sales") own.push({ node: node.id, field: "checks", message: "剔除最大订单只适用于销售口径" });
    } else if (node.op === "scenario") {
      if (source && source.op !== "measure") own.push({ node: node.id, field: "of", message: "scenario 只能作用于 measure 节点" });
      if (!capabilities.scenarios?.includes(node.adjustment?.kind)) own.push({ node: node.id, field: "adjustment", message: "当前数据不支持该情景规则" });
      if (!Array.isArray(node.netVolumeChanges) || !node.netVolumeChanges.length || node.netVolumeChanges.length > 6) own.push({ node: node.id, field: "netVolumeChanges", message: "需要 1–6 个净成交量变化假设" });
      if (typeof node.reason !== "string" || !node.reason.trim()) own.push({ node: node.id, field: "reason", message: "情景需要写明假设理由" });
    }
    if (own.length) { issues.push(...own); dropped.push({ node, issues: own }); } else { valid.push(node); kept.set(node.id, node); }
  }
  return { valid, dropped, issues };
}
```

- [ ] **Step 5: 运行测试并通过；全量与 tsc**

Run: `node --test --experimental-strip-types tests/analysis-plan-validate.test.ts && npm test && npx tsc --noEmit && npx tsc -p agent/tsconfig.json`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add app/lib/analytics/plan/types.ts app/lib/analytics/plan/validate.ts tests/analysis-plan-validate.test.ts
git commit -m "feat: 分析计划类型与静态校验"
```

---

### Task 3: 计划执行器

**Files:**
- Create: `app/lib/analytics/plan/execute.ts`
- Test: `tests/analysis-plan-execute.test.ts`

**Interfaces:**
- Consumes: `createAnalysisOperations(session, constraints).execute(request, signal)`（现有）、`createEvidenceRegistry()`（现有）、Task 2 的类型。
- Produces:

```ts
export type NodeResult = { node: PlanNode; status: "completed" | "unsupported" | "failed"; operationIds: string[]; message?: string;
  rows: Array<{ key: Record<string, string>; metric: string; factId: string; role: "value" | "target" | "reference" | "delta" | "change" | "deviation" | "share" | "contribution" | "check"; sampleRows?: number }>;
  robust?: Array<{ check: string; kept: boolean | null; detail: string }> };
export type PlanExecution = { results: Map<string, NodeResult>; evidence: AnalysisEvidence };
export async function executePlan(nodes: PlanNode[], session: AnalysisDataSession, constraints: AnalysisConstraints, registry: EvidenceRegistry, signal?: AbortSignal): Promise<PlanExecution>;
```

节点到现有分析操作的映射：

| 节点 | 调用 |
|---|---|
| measure | `method: "aggregate"`，`by` 原样传入 |
| contrast | `method: "compare"`，`scope=target`，`reference`，`by`，`controls=align.controls`，`commonStores=align.commonStores` |
| decompose | `method: "decompose"`，`scope` 和 `reference` 取自所指 contrast，`metrics: ["amount", "quantity"]` |
| drill | 对 path 每一层 i：`method: "scan"`，`by=path[0..i]`，`breakdown=path[i]`（i>0 时）；范围与参照取自所指节点（contrast 用 reference，measure 不用） |
| scan | 对每个维度单独调用 `method: "scan"`，`by=[dimension]`；未给维度时取能力目录 `dimensionCatalog` 中 `scan: true` 的全部维度 |
| robust | 每个 check：`largest_store`/`largest_order` 调 `method: "robustness"` 并带同名 check；`alternative_window` 调同名 check；`halves` 把所指范围拆成前后两半，各做一次同参数的 measure 或 contrast |
| scenario | 复用 `agent/analytics-scenarios.ts` 的情景逻辑，移入 `app/lib/analytics/plan/scenario.ts`，去掉 zod 解析，改成直接接收节点参数；基线是所指 measure 的总体 `amount` 事实 |

`rows` 由事实整理而来：按 `objectIds` 对应对象的 `dimension → value` 组成 `key`；`role` 由 `metricId` 的后缀决定：无后缀为 `value`/`target`，`.delta` 为 `delta`，`.relative_change` 为 `change`，`.relative_deviation` 为 `deviation`，`.share` 为 `share`，`.change_contribution` 或 `_contribution` 为 `contribution`；参照框架中的同名事实记为 `reference`。drill 和 scan 的 `sampleRows` 取同组 `rows` 事实。`robust.kept` 的判定：剔除后差额（或相对变化）与原值同号为 `true`，变号为 `false`，任一侧为 null 为 `null`。

- [ ] **Step 1: 写失败测试** `tests/analysis-plan-execute.test.ts`。会话用 Task 1 测试里同样形状的合成行数据，内联一个 `session(rows)` 帮助函数：行字段为 `day, festival, region, district, store, amount, quantity, grams`，`aggregate` 按 `query.by` 分组，并按 `scope.filters` 中的 `festivals`、`regions`、`districts`、`stores` 过滤；`excludeStores` 也要生效。测试内容：

```ts
test("contrast 产出目标、参照、差额、变化四类行，键为空表示总体", async () => {
  const exec = await executePlan([{ id: "c", op: "contrast", target: scope({ festivals: ["七夕节"] }), reference: scope({ festivals: ["非节庆"] }), metrics: ["amount_per_day"] }], fixture(), { filters: {} }, createEvidenceRegistry());
  const rows = exec.results.get("c")!.rows.filter((row) => row.metric === "amount_per_day");
  assert.deepEqual(rows.map((row) => row.role).sort(), ["change", "delta", "reference", "target"]);
  const delta = exec.evidence.facts.find((fact) => fact.id === rows.find((row) => row.role === "delta")!.factId)!;
  assert.equal(delta.value, 50);
});

test("drill 沿层级逐层扫描，每层行带样本量，键包含该层及上层维度", async () => {
  const exec = await executePlan([
    { id: "c", op: "contrast", target: scope({ festivals: ["七夕节"] }), reference: scope({ festivals: ["非节庆"] }), metrics: ["amount_per_day"] },
    { id: "d", op: "drill", of: "c", path: ["region", "district"] },
  ], fixture(), { filters: {} }, createEvidenceRegistry());
  const rows = exec.results.get("d")!.rows.filter((row) => row.role === "deviation");
  assert.ok(rows.some((row) => Object.keys(row.key).join() === "region"));
  assert.ok(rows.some((row) => Object.keys(row.key).sort().join() === "district,region"));
  assert.ok(rows.every((row) => typeof row.sampleRows === "number"));
});

test("robust 剔除最大门店后方向不变记为保持，变号记为翻转", async () => {
  const exec = await executePlan([
    { id: "c", op: "contrast", target: scope({ festivals: ["七夕节"] }), reference: scope({ festivals: ["非节庆"] }), metrics: ["amount"] },
    { id: "r", op: "robust", of: "c", checks: ["largest_store", "halves"] },
  ], fixture({ dominantStore: true }), { filters: {} }, createEvidenceRegistry());
  const robust = exec.results.get("r")!.robust!;
  assert.equal(robust.find((item) => item.check === "largest_store")!.kept, false);
  assert.ok(robust.some((item) => item.check === "halves"));
});

test("节点执行失败只影响该节点及其依赖，其余节点照常产出", async () => {
  const exec = await executePlan([
    { id: "ok", op: "measure", scope: scope(), metrics: ["amount"] },
    { id: "boom", op: "robust", of: "ok", checks: ["largest_order"] },
  ], fixture({ missingOrders: true }), { filters: {} }, createEvidenceRegistry());
  assert.equal(exec.results.get("ok")!.status, "completed");
  assert.equal(exec.results.get("boom")!.status, "unsupported");
});

test("取消立即停止，不产生部分结果", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(executePlan([{ id: "m", op: "measure", scope: scope(), metrics: ["amount"] }], fixture(), { filters: {} }, createEvidenceRegistry(), controller.signal), /取消|停止|abort/i);
});
```

`fixture({ dominantStore })`：七夕节期间门店 S1 贡献 90% 增长，其余门店下降，用来让剔除最大门店后方向翻转。`fixture({ missingOrders })`：有一行缺单号。

- [ ] **Step 2: 运行，确认失败**

Run: `node --test --experimental-strip-types tests/analysis-plan-execute.test.ts`
Expected: FAIL，无法加载 `plan/execute.ts`。

- [ ] **Step 3: 实现 `execute.ts`**，按上面的映射表实现。要点：
  - 用一个 `operations = createAnalysisOperations(session, constraints)`；每个节点的每次调用都传 `needIds: ["plan"]`、`purpose: \`\${node.op} \${node.id}\``。
  - 每次调用的结果先 `await registry.ingestAsync(result, signal)`，再从 `result.facts` 整理 `rows`。
  - 节点按数组顺序执行；`of` 指向的节点失败时，该节点记 `status: "failed"`、`message: "依赖的节点未完成"`，不调用。
  - 调用抛出 `ANALYSIS_ARGUMENTS_INVALID` 时，记 `status: "unsupported"` 并写入 `message`；其他错误（取消、数据库失效）原样抛出。
  - `halves`：把 `period` 按天数对半切；奇数天前半段少一天。
  - 最后 `evidence = registry.view()`。

- [ ] **Step 4: 运行测试并通过；全量与 tsc**

Run: `node --test --experimental-strip-types tests/analysis-plan-execute.test.ts && npm test && npx tsc --noEmit && npx tsc -p agent/tsconfig.json`

- [ ] **Step 5: 提交**

```bash
git add app/lib/analytics/plan/execute.ts app/lib/analytics/plan/scenario.ts tests/analysis-plan-execute.test.ts
git commit -m "feat: 分析计划执行器"
```

---

### Task 4: 结论绑定、方向校验与可信度

**Files:**
- Create: `app/lib/analytics/plan/bind.ts`
- Test: `tests/analysis-plan-bind.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `PlanExecution`、`NodeResult`。
- Produces:

```ts
export type Claim = { node: string; select?: Record<string, string>; metric: string; role?: NodeResult["rows"][number]["role"]; assert: "up" | "down" | "flat" | "higher" | "lower" | "largest" | "smallest" | "unavailable"; text: string };
export type ClaimDraft = { headline: Claim; claims: Claim[]; actions: Array<{ text: string; claim: number }>; cannotConclude: string[]; questions: string[] };
export type BoundClaim = Claim & { factIds: string[]; rendered: string; confidence: "kept" | "flipped" | "unchecked" };
export type Binding = { headline?: BoundClaim; claims: BoundClaim[]; actions: Array<{ text: string; claim: number }>; dropped: Array<{ claim: Claim; reason: string }>; cannotConclude: string[]; questions: string[] };
export function bindClaims(draft: ClaimDraft, execution: PlanExecution, currency: string): Binding;
```

规则：
- 选行：`node`、`metric` 相同；`select` 的每个键值都与 `row.key` 相同，未给 `select` 时选 `key` 为空的总体行；`role` 默认取 contrast 的 `delta`、drill/scan 的 `deviation`、measure 的 `value`。
- 占位：`{value}` 取所选行的值；`{delta}`、`{change}`、`{target}`、`{reference}` 取同 `node`、同 `metric`、同 `key` 中对应 role 的行。
- 数字格式化复用 `formatAnalysisNode` 的规则，移到 `bind.ts` 内：金额带「元」并保留两位，超过 1 万写作「万」，超过 1 亿写作「亿」；百分比保留两位；个百分点写作「个百分点」。
- 方向：`up`/`higher` 要求 delta、change 或 deviation 大于 0；`down`/`lower` 要求小于 0；`flat` 要求 |change| < 1；`largest`/`smallest` 要求所选行在同节点、同 metric、同 role 中排序第一或最后；`unavailable` 要求值为 null。
- 文本里去掉 `{...}` 后如果还有数字，丢弃并记原因「措辞中不能直接写数字」。
- 可信度：找出所有 `of === claim.node` 的 robust 节点结果：全部 `kept: true` 为 `kept`，任一 `false` 为 `flipped`，没有 robust 节点或全为 null 为 `unchecked`。
- `actions[i].claim` 指向的结论被丢弃时，这条行动也丢弃。
- headline 被丢弃时，把第一条保留下来的 claim 提升为 headline；一条都没有时 `headline` 为 undefined。
- 上限：claims 取前 5 条，actions 取前 3 条，cannotConclude 取前 5 条。

- [ ] **Step 1: 写失败测试** `tests/analysis-plan-bind.test.ts`。直接构造 `PlanExecution`：一个 contrast 节点 `c`，总体 delta=50、change=100；一个 drill 节点 `d`，两组 deviation 分别为 +30、−20；一个 robust 节点 `r`，`of: "c"`、`kept: false`。测试：

```ts
test("数字由代码填入，方向一致才保留", () => {
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "up", text: "七夕日均实收比平日高 {delta}（{change}）" }, claims: [{ node: "c", metric: "amount_per_day", assert: "down", text: "七夕日均实收下降" }], actions: [{ text: "按七夕节奏备货", claim: 0 }], cannotConclude: [], questions: [] }, execution(), "人民币");
  assert.equal(bound.headline!.rendered, "七夕日均实收比平日高 50.00元（+100.00%）");
  assert.equal(bound.claims.length, 0); assert.match(bound.dropped[0].reason, /方向/);
  assert.equal(bound.actions.length, 0);
});

test("措辞里写数字的结论被丢弃", () => {
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "up", text: "高了 50 元" }, claims: [], actions: [], cannotConclude: [], questions: [] }, execution(), "人民币");
  assert.equal(bound.headline, undefined); assert.match(bound.dropped[0].reason, /数字/);
});

test("select 定位分组；largest 校验排序", () => {
  const bound = bindClaims({ headline: { node: "d", select: { district: "南区/B区" }, metric: "amount_per_day", assert: "largest", text: "南区B区偏离最大，{value}" }, claims: [{ node: "d", select: { district: "东区/A区" }, metric: "amount_per_day", assert: "largest", text: "东区A区偏离最大" }], actions: [], cannotConclude: [], questions: [] }, execution(), "人民币");
  assert.ok(bound.headline); assert.equal(bound.claims.length, 0);
});

test("可信度来自指向同一节点的稳健性检查", () => {
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "up", text: "上升 {delta}" }, claims: [{ node: "d", select: { district: "南区/B区" }, metric: "amount_per_day", assert: "higher", text: "南区B区更高" }], actions: [], cannotConclude: [], questions: [] }, execution(), "人民币");
  assert.equal(bound.headline!.confidence, "flipped"); assert.equal(bound.claims[0].confidence, "unchecked");
});

test("headline 被丢弃时提升第一条有效结论", () => {
  const bound = bindClaims({ headline: { node: "c", metric: "amount_per_day", assert: "down", text: "下降" }, claims: [{ node: "c", metric: "amount_per_day", assert: "up", text: "上升 {delta}" }], actions: [], cannotConclude: [], questions: [] }, execution(), "人民币");
  assert.equal(bound.headline!.text, "上升 {delta}"); assert.equal(bound.claims.length, 0);
});
```

- [ ] **Step 2: 运行，确认失败。** Run: `node --test --experimental-strip-types tests/analysis-plan-bind.test.ts`

- [ ] **Step 3: 按规则实现 `bind.ts`。**

- [ ] **Step 4: 运行测试并通过；全量与 tsc。**

- [ ] **Step 5: 提交**

```bash
git add app/lib/analytics/plan/bind.ts tests/analysis-plan-bind.test.ts
git commit -m "feat: 结论绑定、方向校验与可信度"
```

---

### Task 5: 答案组装与图表推导

**Files:**
- Create: `app/lib/analytics/plan/answer.ts`
- Modify: `app/lib/analytics/analysis-v2-types.ts`（新增 `PLAN_ANSWER_SCHEMA` 与 `PlanAnswer` 类型）
- Test: `tests/analysis-plan-answer.test.ts`

**Interfaces:**
- Consumes: Task 3 `PlanExecution`，Task 4 `Binding`，`ResolvedVisualization`（现有类型）。
- Produces:

```ts
// analysis-v2-types.ts
export const PLAN_ANSWER_SCHEMA = "analysis-answer/v3" as const;
export type PlanAnswer = {
  schema: typeof PLAN_ANSWER_SCHEMA; runId: string; question: string; status: "answered" | "partial" | "unavailable";
  headline?: { text: string; factIds: string[]; confidence: "kept" | "flipped" | "unchecked" };
  claims: Array<{ text: string; factIds: string[]; confidence: "kept" | "flipped" | "unchecked" }>;
  actions: string[]; cannotConclude: string[]; questions: string[];
  assumptions: string[]; definitions: string[]; chart?: ResolvedVisualization;
  plan: Array<{ id: string; op: string; status: string; summary: string }>;
  review: { notes: string[] }; evidence: AnalysisEvidence; trace?: ToolTrace;
};
// answer.ts
export function assemblePlanAnswer(input: { runId: string; question: string; execution: PlanExecution; binding: Binding; capabilities: AnalysisCapabilities; droppedNodes: Array<{ id: string; reason: string }>; reviewNotes: string[] }): PlanAnswer;
export function validatePlanAnswer(value: unknown): PlanAnswer;
export function planAnswerText(answer: PlanAnswer): string;
```

规则：
- `status`：有 headline 且没有丢弃节点为 `answered`；有 headline 但有节点被丢弃或结论被丢弃为 `partial`；没有 headline 为 `unavailable`。
- `definitions`：收集本次绑定事实对应的指标和维度在能力目录中的定义（`definition`），按文本去重；依据为 `assumption` 的放进 `assumptions`，格式为「口径待确认：<label>，<definition>」。
- `cannotConclude` 合并以下来源后去重，取前 5 条：
  1. 绑定中模型写的 cannotConclude；
  2. `droppedNodes` 的原因，格式为「未执行：<原因>」；
  3. 可信度为 `flipped` 的结论，格式为「<结论原文> 在剔除检查后方向翻转，不能作为确定结论」；
  4. `assert: "unavailable"` 的结论原文。
- 图表推导（只看 headline 绑定的节点）：
  - drill 或 scan：条形图，类别为样本量 ≥ minRows 的组，按 |deviation| 降序最多取 8 组；
  - 同一问题中有 ≥ 3 个 contrast 节点、指标与 headline 相同、对齐方式不同：分层对比条形图，类别为各 contrast 节点 id 对应的对齐描述（全量、共同门店、同窗口、同店同日），值为 change；
  - measure 且 by 含 `day`：折线图；
  - 其他情况不出图。
  - 图的 `ResolvedVisualization` 由代码直接构造，`factIds` 填所用事实，`renderer: "native"`。
- `plan` 摘要：每个节点一行，summary 由代码生成，例如「对比 七夕节 与 非节庆 的 日均实收」。
- `validatePlanAnswer`：检查 schema、各数组上限、每个 `factIds` 都在 `evidence.facts` 中；用于流解码和会话恢复。
- `planAnswerText`：headline、claims、actions、cannotConclude、assumptions 按顺序拼成纯文本，供附件问答和复制使用。

- [ ] **Step 1: 写失败测试。** 覆盖：三种 status；definitions 与 assumptions 的划分和去重；cannotConclude 的四个来源与上限；三种图表推导各一例，以及不出图的一例；`validatePlanAnswer` 拒绝引用不存在事实的答案；`planAnswerText` 包含 headline 渲染文本。

- [ ] **Step 2: 运行，确认失败。**

- [ ] **Step 3: 实现。**

- [ ] **Step 4: 运行测试并通过；全量与 tsc。**

- [ ] **Step 5: 提交**

```bash
git add app/lib/analytics/plan/answer.ts app/lib/analytics/analysis-v2-types.ts tests/analysis-plan-answer.test.ts
git commit -m "feat: 计划答案组装与图表推导"
```

---

### Task 6: 编排运行器

**Files:**
- Create: `app/lib/analytics/plan/prompt.ts`
- Create: `agent/analysis-plan-run-turn.ts`
- Test: `tests/analysis-plan-runtime.test.ts`

**Interfaces:**
- Consumes: Task 2–5 的全部导出；`AgentQuery`、`AgentRuntimeConfig`（`agent/run-turn.ts`）；`analyticsSdkModel`（`agent/analytics-model.ts`）；`createEvidenceRegistry`；`relayAbort`、`throwIfTurnCancelled`；`startTraceEvent`、`finishTraceEvent`。
- Produces:

```ts
export type PlanAnalyticsRunner = (request: DatabaseExplainRequest | AnalyticsExplainRequest, signal?: AbortSignal, onProgress?: (event: AnalyticsProgressEvent) => void) => Promise<PlanAnswer | AnalyticsExplainResult>;
export function createPlanAnalyticsRunner(config: AgentRuntimeConfig & { database?: AnalyticsDatabase; auditDirectory?: string }, dependencies?: { query: AgentQuery; provider?: AnalysisDataProvider }): PlanAnalyticsRunner;
```

流程（每一步都是一次 `dependencies.query` 调用，`maxTurns: 3`；本步只开放一个提交工具，模型调用提交工具即结束本步）：

1. 打开会话，取 `capabilities`。
2. 计划：工具 `submit_plan({ plan })`。工具处理函数先 `parsePlan`，再 `validatePlan`：
   - 有问题且这是第一次：返回 `{ accepted: false, issues }`，让模型在同一次调用里修改后再提交。这里的「第二次」指同一次 SDK 调用中的第二次工具调用，`maxTurns: 3` 已经足够。
   - 第二次：接受校验后剩下的有效节点，返回 `{ accepted: true, dropped }`。
3. 计划复核：工具 `submit_plan_review({ verdict: "ok" | "revise", issues: string[] })`。为 `revise` 时，把 issues 作为新问题发给计划步骤，再调一次计划步骤，这是计划的第二次调用。
4. 执行：`executePlan`，同时发送 trace 事件，每个节点一条。
5. 补充计划（可选，最多一次）：工具 `submit_followup({ nodes })` 或 `skip_followup({})`。补充节点同样经过 `validatePlan`；不能引用尚不存在的节点。
6. 结论：工具 `submit_claims(ClaimDraft)`。处理函数调用 `bindClaims`，把绑定结果和丢弃原因返回给模型，本步结束。
7. 措辞复核：工具 `submit_wording_review({ edits: Array<{ index: number; action: "drop" } | { index: number; action: "rewrite"; text: string }>, notes: string[] })`。改写后的文本重新经过 `bindClaims` 校验；校验不通过的改写当作 drop。
8. `assemblePlanAnswer` 并返回。

`prompt.ts` 导出四个函数，返回纯字符串：

```ts
export function capabilityBrief(capabilities: AnalysisCapabilities): string;          // 维度（id、label、父级、筛选键）、指标（id、label、定义、口径）、基线、覆盖期
export function planPrompt(question: string, context: string[], brief: string, issues: string[]): string;
export function claimsPrompt(question: string, summary: string): string;              // summary 为各节点结果的精简表：节点 id、行 key、metric、role、格式化数值、样本量、robust 结果
export function reviewPrompt(kind: "plan" | "wording", question: string, payload: string): string;
```

提示词要点必须写进去：
- 算子清单和每个算子的 JSON 示例；
- 范围用语义维度的筛选键；
- 不能写数字，用占位符；
- 结论必须绑定节点；
- 缺少的数据要直接说明缺什么；
- headline 写一句对原问题的直接回答。

系统提示词沿用 `buildAnalyticsSystemPrompt` 的人设与安全要求，删除其中关于旧工具的段落。

查数快捷路径与寒暄快捷路径（`quickAnalyticsReply`、`quickMonthlySalesQuery`）保留在运行器入口。

- [ ] **Step 1: 写失败测试** `tests/analysis-plan-runtime.test.ts`，用脚本化的假 `AgentQuery`，按 `options.mcpServers.analytics` 连接 InMemory MCP，写法同 `tests/analytics-scenario-runtime.test.ts`。根据工具清单判断当前是哪一步，然后调用对应的提交工具。用例：
  1. 正常路径：计划 2 个节点 → 计划复核 ok → 跳过补充 → 结论 → 措辞复核无改动。断言：查询调用次数等于 5；答案 `status: "answered"`；headline 渲染出的数字等于证据中对应事实的值。
  2. 计划第一次提交有错：同一调用内第二次提交修正版。断言调用次数仍为 5，答案中没有被丢弃的节点。
  3. 计划复核 revise：计划步骤被调用 2 次，总调用数为 6。
  4. 补充计划：引用不存在的节点被丢弃，其余补充节点执行。
  5. 措辞复核改写成带数字的文本：该结论被删除，答案为 `partial`。
  6. 取消：在执行阶段 abort，抛出取消错误，会话被关闭。

- [ ] **Step 2: 运行，确认失败。**

- [ ] **Step 3: 实现 `prompt.ts` 和 `analysis-plan-run-turn.ts`。** 审计记录继续写到 `analysis-runs/<runId>.jsonl`，kind 依次为 `question`、`plan`、`plan_review`、`execution`、`followup`、`claims`、`wording_review`、`final`、`failure`。

- [ ] **Step 4: 运行测试并通过；全量与 tsc。**

- [ ] **Step 5: 提交**

```bash
git add app/lib/analytics/plan/prompt.ts agent/analysis-plan-run-turn.ts tests/analysis-plan-runtime.test.ts
git commit -m "feat: 计划即程序编排运行器"
```

---

### Task 7: 接入服务、流协议与附件问答

**Files:**
- Modify: `agent/server.ts`、`agent/http-handler.ts`
- Modify: `app/lib/analytics/stream.ts`、`app/lib/analytics/tool-names.ts`、`app/lib/analytics/trace.ts`
- Modify: `agent/attachments/run-turn.ts`、`agent/attachments/tools.ts`、`app/lib/attachments/answer.ts`、`app/lib/attachments/types.ts`
- Test: `tests/analysis-plan-http.test.ts`，以及修改 `tests/attachments-agent.test.ts` 中用到 `AnalysisAnswer` 的用例

**Interfaces:**
- 页面请求头 `X-Analytics-Answer-Schema` 接受 `analysis-answer/v3`；`http-handler.ts` 对 v3 使用 `runPlanAnalyticsTurn`。v2 请求头不再支持，返回 400「请刷新页面后重试」。
- `validateAnalyticsAnswerResult` 识别 v3 并调用 `validatePlanAnswer`。
- `tool-names.ts` 新增 `PLAN_ANALYTICS_TOOLS = ["submit_plan", "submit_plan_review", "run_plan_node", "submit_followup", "submit_claims", "submit_wording_review"]` 及中文标签；`ALL_ANALYTICS_TRACE_TOOLS` 改为 `[...ANALYTICS_TOOLS, ...PLAN_ANALYTICS_TOOLS]`。
- 附件问答：`runAnalytics` 改为 `PlanAnalyticsRunner`；`databaseAnswers` 改为 `PlanAnswer[]`；`recordDatabase(answer)` 改用 `answer.runId`、`answer.question`、`answer.evidence.facts`；`resolveConversationVisualization` 中 `database.visualizations` 的分支删除，因为数据库答案的图不再导入到附件回答。

- [ ] **Step 1: 写失败测试** `tests/analysis-plan-http.test.ts`：v3 请求走新运行器，用假运行器断言被调用；v2 请求返回 400；流解码接受 v3 结果并校验 factIds。修改 `tests/attachments-agent.test.ts` 中构造数据库答案的辅助函数，改为构造 `PlanAnswer`。

- [ ] **Step 2: 运行，确认失败。**

- [ ] **Step 3: 实现。**

- [ ] **Step 4: 运行测试并通过；全量与 tsc。**

- [ ] **Step 5: 提交**

```bash
git add agent/server.ts agent/http-handler.ts app/lib/analytics/stream.ts app/lib/analytics/tool-names.ts app/lib/analytics/trace.ts agent/attachments/run-turn.ts agent/attachments/tools.ts app/lib/attachments/answer.ts app/lib/attachments/types.ts tests/analysis-plan-http.test.ts tests/attachments-agent.test.ts
git commit -m "feat: 服务与附件问答接入计划答案"
```

---

### Task 8: 页面渲染

**Files:**
- Create: `app/components/analytics/plan-answer.tsx`
- Modify: `app/components/analytics/history-message.tsx`、`app/components/analytics/report-view.tsx`、`app/lib/client/history-stream.ts`、`app/lib/client/history-conversation.ts`
- Test: `tests/analysis-plan-ui.test.ts`

**Interfaces:**
- `PlanAnswerView({ answer }: { answer: PlanAnswer })`。
- 布局从上到下：
  1. headline 加粗，旁边是可信度标签：方向保持「稳健」、翻转「需谨慎」、未检查不显示；
  2. 图（如有）；
  3. claims 列表，每条带可信度标签和「出处」按钮；
  4. 「建议」列表；
  5. 「不能下的结论」列表；
  6. 「口径待确认」折叠区；
  7. 「分析步骤」折叠区（plan 摘要）；
  8. 复核待注意（如有）。
- 「出处」按钮复用现有 `AnalysisSourceData` 的展示方式，把它从 `analysis-answer.tsx` 移到 `plan-answer.tsx`，入参改为 `factIds` 与 `evidence`。
- `history-stream.ts` 请求头改为 v3。`history-conversation.ts` 恢复会话时，`schema` 为 v2 的旧答案只保留 `text`，丢弃 `answer` 字段。

- [ ] **Step 1: 写失败测试** `tests/analysis-plan-ui.test.ts`，用 `tests/helpers/react-component.ts` 渲染为静态 HTML。断言：
  - headline 与可信度标签出现；
  - claims 不超过 5 条；
  - 无图时不渲染图表容器；
  - 「口径待确认」默认折叠；
  - v2 旧答案恢复后只显示文本。

- [ ] **Step 2: 运行，确认失败。**

- [ ] **Step 3: 实现。** 样式沿用 `analysis-answer.tsx` 现有的颜色和字号类名。

- [ ] **Step 4: 运行测试并通过；全量、tsc、lint。** Run: `npm test && npx tsc --noEmit && npx tsc -p agent/tsconfig.json && npm run lint`

- [ ] **Step 5: 提交**

```bash
git add app/components/analytics/plan-answer.tsx app/components/analytics/history-message.tsx app/components/analytics/report-view.tsx app/lib/client/history-stream.ts app/lib/client/history-conversation.ts tests/analysis-plan-ui.test.ts
git commit -m "feat: 计划答案页面"
```

---

### Task 9: 删除旧流程

**Files:**
- Delete:
  - `agent/general-analytics-run-turn.ts`、`agent/analytics-calculations.ts`、`agent/analytics-scenarios.ts`、`agent/analytics-review-support.ts`、`agent/analytics-review-cache.ts`
  - `app/components/analytics/analysis-answer.tsx`、`app/lib/analytics/analysis-v2-format.ts`
  - `agent/visualization-runtime.ts`、`agent/visualization-schema.ts` 中只被分析使用的导出；附件问答仍在用的保留，用 `grep` 确认
- Modify: `app/lib/analytics/analysis-v2-evidence.ts`，删除 `validateAnalysisDraft`、`selectAnalysisEvidence`、`validateAnalysisAnswer`，以及只服务这三个函数的私有函数；保留 `createEvidenceRegistry`、`validateAnalysisEvidence`、`sealOwnedAnalysisOperation`
- Modify: `app/lib/analytics/analysis-v2-types.ts`，删除 `AnalysisDraft`、`AnalysisAnswer`、`AnalysisConclusion`、`AnalysisAnswerBlock`、`AnalysisAnswerNode`、`AnalysisReviewIssue`、`AnalysisSemanticReview`、`DraftValidation`、`AnalysisTask`、`AnalysisNeed`、`AnalysisTrialParameter`、`AnalysisUserCondition`、`ANALYSIS_ANSWER_SCHEMA`
- Modify: `agent/analytics-system-prompt.ts`，删除只服务旧工具的段落
- Modify: `agent/analytics-evaluation.ts`，改用 `createPlanAnalyticsRunner` 与 `planAnswerText`
- Delete tests: `tests/analysis-v2-runtime.test.ts`、`tests/analysis-v2-review-claims.test.ts`、`tests/analysis-v2-review-support.test.ts`、`tests/analytics-review-cache.test.ts`、`tests/analytics-calculations.test.ts`、`tests/analytics-scenario-runtime.test.ts`、`tests/analytics-decision-runtime.test.ts`、`tests/analysis-v2-format.test.ts`、`tests/analytics-visualization-runtime.test.ts`
- Modify tests: `tests/analysis-v2-evidence.test.ts`（删掉草稿与答案校验相关用例，保留注册表和证据校验）、`tests/analytics-scenarios.test.ts`（改测 `plan/scenario.ts`）、`tests/analysis-v2-ui.test.ts`（删掉或改为测 `PlanAnswerView`）、`tests/analytics-prompts.test.ts`、`tests/analytics-visualization-ui.test.ts`

- [ ] **Step 1:** 删除文件和导出后运行 `npx tsc --noEmit && npx tsc -p agent/tsconfig.json`，按报错清理剩余引用。

- [ ] **Step 2:** 运行 `npm test`，按「删除或改写」清单处理旧测试，直到全部通过。

- [ ] **Step 3:** 运行 `grep -rn "general-analytics-run-turn\|calculate_analysis\|simulate_analysis\|present_analysis_chart\|AnalysisDraft\|analysis-answer/v2" app agent tests docs/superpowers/specs/2026-10-18-*`，Expected: 只剩设计文档中的说明。

- [ ] **Step 4:** 运行 `npm run lint && npm run build`。

- [ ] **Step 5: 提交**

```bash
git add -A agent app tests   # 只在确认工作区没有其他会话的未提交改动后执行；否则逐个 git add / git rm 本任务列出的路径
git commit -m "refactor: 删除旧的多轮自由分析流程"
```

---

### Task 10: 真实模型验收

**Files:**
- Create: `scripts/analysis-plan-acceptance.mjs`（驱动 S1–S5，读取 `analysis-runs` 审计记录，输出每题的调用次数、耗时、答案，以及数字与对账脚本的比对结果）

- [ ] **Step 1:** 用 `/tmp/ctf-sem/acc/run.ts` 的独立 SQL 方法，为 S1–S5 的 headline 指标各写一条期望值查询，放进脚本。

- [ ] **Step 2:** 重启 `dev:all`，在浏览器隔离标签页并发跑 S1–S5，题目与 `/tmp/ctf-cdp/questions.json` 相同。

- [ ] **Step 3:** 验收标准：
  - 每题模型调用 ≤ 6；
  - 每题 ≤ 8 分钟；
  - 答案中每个数字都能在证据中找到，headline 数字与独立 SQL 一致；
  - S4 明确说出缺少会员等级，S5 明确说出缺少金价，并都给出最接近的可答问题；
  - 每题最多 1 张图，且图绑定 headline。

- [ ] **Step 4:** 把结果写进设计文档第 1 节的对照表（改造前、语义层后、本次）。

- [ ] **Step 5: 提交**

```bash
git add scripts/analysis-plan-acceptance.mjs docs/superpowers/specs/2026-10-18-analytics-playbook-orchestration-design.md
git commit -m "test: 计划即程序真实模型验收"
```
