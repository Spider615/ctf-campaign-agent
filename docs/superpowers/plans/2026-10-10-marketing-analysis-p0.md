# 营销分析 P0 实施计划

> **For agentic workers:** 使用 superpowers:executing-plans 在本会话逐项实施，最后进行一次独立代码评审。

**Goal:** 用户能够导入销售明细和可选活动规则，选择分析范围，得到可复算的复盘、分组洞察及证据，并保存和重新打开结果。

**Architecture:** 在现有活动执行流程旁新增独立分析工作台、只读计算模块和数据导入 API。小范围 POC 快照与不可变报告保存在应用 D1，均按浏览器访问标识隔离；导入与报告有明确容量限制。Agent 只能读取计算证据并选择洞察，不能写入经营事实或生成无依据预测。

**Tech Stack:** 现有 React、vinext、Workers、D1、Node 22.23.1、Claude Agent SDK，不新增产品依赖。

**Spec:** `docs/2026-10-09-marketing-analysis-assessment.md` 的 P0。

## Global Constraints

- 使用 Node >=22.13；本机命令使用 Node 22.23.1。
- 保留既有 campaign/v1、单一可选 1811、传播及版本恢复。
- 共享领域模块不引入 Workers、数据库或第三方依赖。
- 中文界面、错误和代码注释；示例数据始终标识为模拟。
- CSV/JSON 导入最多 2000 条销售明细，输入最多 1 MiB，归一化快照最多 1.5 MiB。
- 金额为 CNY 元，按分聚合；成本、会员标签、克重缺失时，相应指标或维度明确不可用。
- 活动规则附加到销售分组，不能用规则行数复制销售记录。

## Review Focus

- 退款与相同订单的多条商品明细不能重复或丢失计数。
- CSV 引号、BOM、重复表头、非法日期和重复明细 ID 必须得到明确处理。
- 比较期为零、成本部分缺失、会员 ID 无标签时不能伪造增长率、毛利或新老会员。
- 改变筛选要产生新报告；证据明细必须来自相同数据版本与筛选。
- 数据集和报告不能被其他浏览器访问标识读取；模型不能选择不存在的证据。

## Task 1 数据解析与真实计算

**Files:** `app/lib/analytics/{types,import,engine,intent,sample}.ts`、`tests/analytics.test.ts`、`tests/analytics-import.test.ts`、`app/lib/campaign/workspace.ts`。

**Interfaces:** `inspectFile(content, format)` 返回表头及预览；`importDataset(input)` 返回受校验的 `AnalyticsDataset`；`runAnalysis(dataset, query)` 返回 `AnalysisReport`；`readEvidence(dataset, report, evidenceId)` 返回对应明细；`isAnalyticsIntent(text)` 区分历史经营分析与执行。

- [x] 先添加分析问题不创建 1811 的回归测试并观察失败。
- [x] 添加 CSV/JSON、重复 ID、日期、退款、缺项、同比、分组和证据测试并观察失败。
- [x] 实现类型、输入解析、数据质量检查、金额聚合、对照及分组差异。
- [x] 生成明确标为示例的两年销售数据，并执行相同计算路径。
- [x] 运行新测试和原 campaign-workspace 测试，记录通过数量。

## Task 2 数据持久化与 API

**Files:** `db/schema.ts`、`drizzle/`、`app/lib/server/analytics-{store,service,runtime}.ts`、`app/api/analytics/`、`tests/analytics-store.test.ts`。

**Interfaces:** store 提供按 owner 的 `listDatasets/loadDataset/saveDataset/listReports/loadReport/saveReport`；服务调用 Task 1 的计算函数。API 为 GET/POST `/api/analytics/datasets`、GET/POST `/api/analytics/reports`、GET `/api/analytics/reports/[id]`、GET `/api/analytics/reports/[id]/evidence`。

- [x] 用实际内存 SQLite 验证保存、重新打开、访问隔离和版本不变，先观察失败。
- [x] 增加 D1 表、生成迁移，实现受限请求体与同源写入检查。
- [x] 浏览器首次读取设置 HttpOnly 访问 cookie，后续请求按 owner 查询。
- [x] 验证空数据、不存在的证据、过大请求和不合法分析范围返回明确错误。

## Task 3 分析工作台与入口

**Files:** `app/components/analytics/`、`app/analysis/`、`app/components/chat/empty-state.tsx`、`app/components/app-shell.tsx`、`app/layout.tsx`。

**Interfaces:** 使用 Task 2 JSON API；报告按 Task 1 的结构展示，数字只从报告读取。首页分析模式跳转 `/analysis`，执行模式保留原创建流程。

- [x] 建立导入销售及可选活动规则、字段映射和示例体验。
- [x] 提供时间、对照期、地区、品类及活动筛选，并保存每次分析报告。
- [x] 展示指标、分组对比、洞察、口径及可展开的真实明细；支持 CSV 明细导出。
- [x] 保存记录可重新打开；加载、取消、失败、重试和移动端布局均可用。

## Task 4 Agent 证据解读与完整验证

**Files:** `agent/analytics-run-turn.ts`、`agent/http-handler.ts`、`agent/server.ts`、`agent/analytics-plugin/`、分析解读 API、`tests/analytics-agent.test.ts`、README 与 AGENTS。

**Interfaces:** `AnalyticsExplainRequest` 只携带已计算报告与问题；工具只读取数据覆盖、指标、洞察和证据。`AnalyticsExplainResult` 返回已有洞察 ID 和可用维度，产品使用对应真实结果渲染。

- [x] 先验证未知证据、越界维度、取消、鉴权和上游失败行为。
- [x] 注册分析专用 Skill 与只读工具，不复用活动配置门禁或百分比正则。
- [x] 完成两套类型检查、全部单测、lint、生产构建和本地 API 验证。
- [x] 进行一次独立评审，修复影响数据正确性或使用流程的问题。

## 进度与实施决定

- 基线：373 个测试通过，0 失败。
- Task 1：领域测试与旧流程回归通过，全量 383 个测试通过，页面侧类型检查通过。
- Task 2：实际内存 SQLite 验证快照、报告保存、访问隔离和不可变性，3 个集成测试通过；迁移已生成。
- Task 3：字段映射、导入、筛选、报告记录、证据和 CSV 导出已实现，本地页面、API 与移动视口验证完成。
- Task 4：分析插件与只读工具已接通，完整检查、真实 SDK 调用及独立评审修复已完成。
- Ruling：在现有项目的 `codex/ctf-marketing-analysis-p0` 分支实施，保留先前未提交资料；不复制依赖和运行配置到新工作树。代价是改动直接出现在当前工作目录。
- Ruling：首期存储有容量限制的导入快照，避免先增加独立数据服务；后续大规模数据可替换只读数据访问层。代价是本期单次导入不超过 2000 条。
- 真实业务验证需要客户数据；模拟样本仅验证实现和交互，不用来证明周大福的活动效果。

## 最终验证

- 单元与集成回归：393 个测试全部通过，0 失败。
- 页面与 Agent 两套 TypeScript 检查通过；生产构建成功。
- 本地仅追加新分析表，原会话数据保留。
- 实际 HTTP 验证：448 条虚构明细导入，本期和比较期各 224 条；报告保存及重开一致，证据版本一致；其他浏览器标识返回 404，跨源写入返回 403。
- 浏览器验证：字段映射、文件导入、同一文件重选、报告保存与重开、关注问题刷新保留、分组表格和证据明细读取均通过。
- 真实 SDK 解读接口返回 200，选择已有洞察及合法维度，未生成新的经营数字。
- 独立评审四项 Important 已修复：缺失分组误算下降、当前执行意图误路由、空洞察选择回退、文件输入未重置。额外浏览器复现的关注问题丢失也已修复。回归先复现失败再验证通过；没有待延后的 Minor。
- 390 像素移动视口检查通过，页面没有整体横向溢出，已恢复默认视口。
- P1/P2、生产数据源与企业身份接入、真实客户业务效果验证按原阶段范围保留，未声明完成。

本地预览为 `http://localhost:5173/analysis`。线上发布尚未执行，当前验证使用明确标识的虚构样本。
