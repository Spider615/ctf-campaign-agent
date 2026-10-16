# 通用营销分析 Agent 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 实现问题驱动的通用分析操作、结构化事实、独立复核与纠正，以及结论优先的 v2 对话回答。

**Architecture:** 共享类型固定任务、数据会话、操作结果和正文节点的边界。确定性操作在授权快照内生成事实；主分析与独立审阅分别运行，编排器根据具体缺口继续取证或改写。新客户端协商 v2，v1 与原活动执行继续兼容。

**Tech Stack:** TypeScript、Node strip-types、现有 Claude Agent SDK、mysql2、React、Workers、node:test；不新增生产依赖。

**Spec:** `docs/superpowers/specs/2026-10-13-general-analytics-agent-design.md`。

## Global Constraints

- 用户已明确授权直接实施直到全部完成；不再要求额外方案或计划确认。
- 本次先不设置耗时和模型调用成本的硬上限；停止仍需基于任务完成或没有有效新信息。
- 2026-10-14用户更新约束：额度接近用完，尽可能停止模型调用。本轮已停止真实模型验收，后续修订只做免费检查；不得将旧版本结果或脚本化SDK回归当作新版本真实模型通过。
- 继续保留只读数据、私有证据、访问隔离、同源检查、可取消回合及 Campaign/1811 执行隔离。
- 金额按行换算为分后汇总，缺失值不填零；订单由门店与销售单号共同标识。
- 模型不提交 SQL、连接信息、任意表名、任意文件路径或可执行代码。
- 共享模块使用完整 `.ts` 相对引用，不导入 Workers 绑定、数据库包或其他 npm 包。
- v2 通过 `X-Analytics-Answer-Schema: analysis-answer/v2` 协商；旧结果与浏览器会话可读取。
- 真实评估与客户数据留在仓库之外；默认自动测试不调用付费模型。

## Review Focus

- 只读结果正确但用户问题未回答：复核必须退回，不能仅返回表格。
- 目标组与参照组的门店、品类或口径不同：执行控制并说明标准化与剩余限制。
- 快照失效或取消：不能把旧事实与新连接结果混作当前结果，迟到事件不能落入页面。
- 数字名称、用户假设、试点参数与真实数量：节点身份正确，未知引用和无依据预测拒绝。
- 旧 v1 客户端及存储记录：新版 UI/流解析仍兼容，明确查数不变成营销分析。

## 文件与接口

- `app/lib/analytics/analysis-v2-types.ts`：共享合同；`AnalysisDataSession.aggregate()` 返回代码内部聚合单元，`AnalysisDataProvider.open()` 打开授权快照。
- `app/lib/analytics/analysis-v2-evidence.ts`：`createEvidenceRegistry()`、`validateAnalysisDraft()`、`validateAnalysisAnswer()`、`analysisAnswerText()`；对象与事实引用、派生关系和完整性核验。
- `app/lib/analytics/analysis-v2-operations.ts`：`createAnalysisOperations(session, constraints)`，`execute(request)` 返回完整操作结果与事实图，内部缓存相同操作。
- `agent/analytics-operation-database.ts` 与现有数据库适配器：固定参数只读 SQL、一致性会话、取消、证据捕获。
- `agent/general-analytics-run-turn.ts`：主分析、复核、纠正、SDK 窗口衔接与私有记录。
- 流协议、API、客户端与分析组件：v2 协商、校验和行内事实表达，保留 v1。
- `tests/analysis-v2-*.test.ts`：任务、计算、协议和编排；独立实时评估脚本默认不进入 CI。

## Task 1：冻结共享合同与事实核验

- [x] 创建共享类型，固定操作、会话、事实图、正文节点和审阅接口。
- [x] 先写事实引用、派生值、纯数据草稿、试点参数和取消语义的失败用例。
- [x] 执行 `node --test --experimental-strip-types tests/analysis-v2-evidence.test.ts`，检查预期失败。
- [x] 实现证据注册、任务/草稿验证和正文解析；数字直接从真实事实与对象引用解析。
- [x] 验证合法图通过，伪造值、引用、跨口径关系和遗漏事项不能通过。

接口示例：

```ts
const registry = createEvidenceRegistry();
registry.ingest(operationResult);
const checked = validateAnalysisDraft(task, draft, registry.bundle());
assert.equal(checked.issues[0].kind, "task_coverage");
```

## Task 2：通用计算与只读会话

- [x] 为汇总、可比对照、数量/价格/结构拆解、分组偏离、最大店/大单/分布/替代窗口先写失败用例。
- [x] 实现快照适配器及固定字段的 MySQL 会话；显式可重复读且只读，关闭/取消立即终止连接。
- [x] 实现五种操作、元数据、派生链路与规范化缓存；不以销售额前列列表代替扫描。
- [x] 测试大店结构反转、零分母、缺订单号、跨币种、快照变化以及源视图投影限制。
- [x] 执行 `node --test --experimental-strip-types tests/analysis-v2-operations.test.ts tests/analysis-v2-database.test.ts`。

接口示例：

```ts
const session = await provider.open(signal);
const operations = createAnalysisOperations(session, hardScope);
const outcome = await operations.execute({ needIds: ["need-1"], method: "compare", purpose: "核对可比差异", scope, reference, metrics: ["amount"], controls: ["store", "category"] });
assert.equal(outcome.status, "completed");
await session.close();
```

## Task 3：分析与独立复核循环

- [x] 用真实 MCP 和脚本化 SDK 先验证 Skill 门禁、计划、操作、提交、语义退回和纠正行为。
- [x] 实现任务与业务硬约束，注册计划/取证/读取/提交工具；审阅仅能读取本轮证据。
- [x] 实现独立审阅，读取原始问题而非只读主 Agent 的任务草案；允许修订任务理解。
- [x] 对未完成事项继续计算，对表达问题改写；重复无进展时给具体条件或未完成状态。
- [x] 实现 SDK 窗口用尽后的显式状态恢复；保留原始上游错误和完整取消链。
- [x] 保存脱敏私有记录，保留草稿、审阅缺口和最终结果，不保存隐藏思维。
- [x] 执行 `node --test --experimental-strip-types tests/analysis-v2-runtime.test.ts`。
- [x] 根据实际验收漏审，增加完整公开内容来源目录与逐项复核、无结论全局读取；补标题绕过、可计算追问与诚实未完成回归。

## Task 4：协议与结论优先的界面

- [x] 对 v1/v2 协商、分帧、取消、数据完整性和旧会话先补失败用例。
- [x] 转发版本头，新客户端发送 v2，旧调用保持 v1；更新 Node 服务与 Workers 联动。
- [x] 新回答在段落中解析事实、对象、周期与出处；图表/明细作为可展开依据。
- [x] 保留复制、真实时间、过程折叠、来源关闭、刷新恢复与移动端布局。
- [x] 执行协议/界面测试，并以隔离浏览器验证实际页面；不调用生产活动系统。
- [x] 页面与复制共用事实节点格式化，消除邻接重复单位；只读回放确认原事实与草稿不变。

## Task 5：业务评估、复核与启用

- [x] 为设计中的八个问题族建立合成数据与人工期望，不按回答长度、查询数或固定文案评分。
- [ ] 使用真实模型分别完成分析与独立复核，记录结果和实际耗时/调用数；同义问法、名称和范围变化不增加业务分支。
- [x] 执行 `npm test`、页面与 Agent 类型检查、lint、build，检查两个插件与 Skill 的部署产物。
- [x] 独立复核新代码和逐项完成证据，修复已发现的代码 Critical/Important 问题；不把免费代码复核当作真实模型业务验收。
- [ ] 重启本地服务，真实页面使用 v2；仅在全部设计要求证据充分时标记目标完成。

## 执行记录

使用现有 `codex/ctf-marketing-analysis-p0` 工作区保留已经运行的未提交产品基础。共享接口先固定，再分配互不重叠的操作/数据库、证据核验和客户端模块并行工作；主执行器负责运行时与集成。进度、裁决与验收证据记录在本计划独占的 `.superpowers/sdd/` 工作目录，跨上下文继续同一目标。

2026-10-14充值后旧冻结版本七族回放已结束或明确中止。人工可接受历史lookup与本轮drivers；其余结果发现Important或未完成，已据此收紧通用复核并修复展示。最新版本613项免费测试、两侧类型与lint通过；真实模型质量验收按用户最新成本约束延期，Task 5对应项保持未勾选。
