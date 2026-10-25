# Skill 驱动智能问答实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将智能问答改为模型自主选择 Skill、按需调用只读分析工具的一次 Agent 会话，并统一问答与活动创建的过程展示。

**Architecture:** 复用已有语义层、参数化查询、确定性分析和情景计算。新运行器一次调用 SDK，开放五个业务工具和 Skill；工具执行、结果编号、图表绑定与取消由代码管理，分析顺序、判断和表达由模型决定。保留 `analysis-answer/v4` 传输与旧会话读取。一次 SDK `query()` 会包含多次模型 API 请求，提速需实测，不能按“一次 Agent”推算成“一次模型调用”。

**Tech Stack:** Node.js >=22.13、TypeScript strip-types、Claude Agent SDK、zod v4、MCP、mysql2、React、node:test。

**设计依据:** `docs/superpowers/specs/2026-10-24-skill-driven-qa-design.md`。

**复审修订:** 2026-10-25。与设计文档同步修正缓存版本、结果分页、来源展示、旧接口和身份清洗的冲突；附件外层限制与现有序列化容量单独列明，不能据此宣称所有入口已无上限。

## 实施边界与优先级

用户在本次对话确认的要求优先于 AGENTS.md 中描述旧分析架构的条目：不走固定回复、不固定六步、不强制加载业务 Skill、不核对正文数字、不设应用层总时长和轮数上限。保留只读权限和不披露底层模型、厂商的要求；事实、金额和工具计算仍沿用现有语义层。活动创建的流程与事实守卫不变，只调整过程展示。

本计划列出开发工作的先后顺序，不将这个顺序写成产品运行时业务流程。代码不得新增“某类问题必须执行某几步”的分支。错误必须向用户明确反馈，不能伪装成完成。默认单测不依赖真实模型。

2026-10-25 实施状态：任务1已完成前置核实；任务2按源修订缺失时的安全回退交付；任务3–8已实现并通过本地自动检查与代码复审。任务9的评估入口、保存保护和本地验收已实现，最终构建通过，浏览器主检查通过；两处移动端界面问题已修复并通过定向复验。新增中文额度提示的服务端、页面、旧记录与移动端回归也已通过。公司网关429后，用户明确选择“先完成本地验收，保留未测项”；最终版15题真实回放、真实模型效果及速度目标不标为通过。完整结果见 `docs/superpowers/notes/2026-10-25-skill-qa-acceptance.md`。

## 文件与依赖地图

| 单元 | 文件 | 职责 |
|---|---|---|
| 数据会话 | `agent/analytics-operation-database.ts`、`agent/analytics-database.ts` | 复用查询编译，提供并发只读执行与稳定数据身份 |
| 磁盘缓存（条件未满足，未启用） | 原拟 `agent/analytics-query-cache.ts`，本轮未新增 | 取得可靠源修订后再实现；本轮仅保留会话内缓存 |
| 工具适配 | 新增 `agent/analytics-skill-tools.ts` | 注册五个工具、分配结果编号、处理参数错误 |
| 结果呈现 | 新增 `app/lib/analytics/qa/results.ts` | 结果分组、稳定排序、分页和已读事实集合 |
| 能力目录 | 新增 `app/lib/analytics/qa/capabilities.ts` | 从旧计划提示词抽取纯目录格式化，支持按维度读全取值 |
| 图表 | 新增 `app/lib/analytics/qa/chart.ts` | 从工具结果生成现有 `ResolvedVisualization` |
| 回答 | 新增 `app/lib/analytics/qa/answer.ts` | Markdown、表格、图表占位组装为 v4 |
| Agent | 新增 `agent/analytics-skill-run-turn.ts` | 一次 SDK query、工具授权、Skill 事件、取消和审计 |
| Skill 目录 | 新增 `agent/analytics-skill-catalog.ts` | 仅校验并公开两份新 Skill |
| 业务方法 | 新增 `agent/analytics-plugin/skills/{ctf-qa,marketing-theory}/SKILL.md` | 问答指导与有来源的方法参考 |
| 过程展示 | `app/components/chat/tool-timeline.tsx` 及调用方 | 统一时间线、合并 Skill 标题 |
| 接入 | `agent/server.ts`、`agent/http-handler.ts` | v3/v4 新请求使用新运行器；旧消息继续可读 |
| 数据出处 | `app/components/analytics/plan-answer.tsx` | 无图表也能查看本次工具结果，避免误称正文已核验 |

依赖：任务 1 → 2 → 3 → 4；任务 5 可与 1–4 并行；任务 6 必须同时等待 3、4、5 完成；任务 7 依赖 6；任务 8 可独立开发；任务 9 的数据库问答验收等待 7、8；附件验收仅在其范围明确后开展，不能阻塞独立的数据库问答验证。任务 1 的 SDK 实验是独立小程序，不依赖尚未实现的新运行器。

## 任务 1：验证数据身份、并发与长会话前提

**读取文件:** `scripts/container-mysql.mjs`、`agent/analytics-operation-database.ts`、`agent/model-gateway.ts`、SDK 安装版本的类型定义。

**新增记录:** `docs/superpowers/notes/2026-10-25-skill-qa-preflight.md`。只写机制和实验结论；客户问题、原始结果与日志留仓库外。

- [x] 跟踪导入和物化表路径，确认服务是否可能在查询期间更新源表，记录读到的实际机制。
- [x] 核对已安装 SDK 的实际默认轮数、上下文压缩及网关转换行为，记录版本和证据；省略 maxTurns 不等于已证明无上限。用真实 SDK 测试超过旧 12 轮，并检查默认值来源；若发现有限默认值，采用 SDK 支持的无上限配置，若无法禁用，先修订运行方案，不能默默选一个大数字冒充无限制。
- [x] 用仓库外的最小 SDK + 测试 MCP 程序验证多轮工具调用、上下文压缩和用户停止，不要求先实现新运行器。新运行器的真实复杂问题留到任务 9；假 query 不能证明 SDK 自己没有默认轮数或可以并发。
- [x] 记录当前查询耗时基线和同时运行 1、2、4 条查询的观测值，确认并发是否实际获益。
- [x] 核查持久缓存能否取得可验证的数据版本来源；本次结果为尚未取得，未通过启用前提。设计文档原有“库表、行数、起止日期”不能识别等行数更新，不能单独充当内容版本；优先采用导入产物哈希或显式数据修订号，加入语义层/查询编译版本。没有可靠版本时跨会话缓存保持关闭，任务 2 沿用一致性读取与会话内缓存，不静默使用可能过期数据。

实测结论：16 次顺序调用越过旧上限；只读工具并发、两次自动压缩和取消竞速已观察到。SQL 四路并发只省约 30.9%，未证明线性提速；真实源修订缺失、一致性条件尚未通过，持久缓存与多连接模式不得据此直接启用。详见实测记录。

## 任务 2：并发只读查询与缓存（本轮交付安全回退）

**状态：** 未取得可验证源修订，以下涉及跨会话缓存或多连接的原计划保持未启用，不新增无可靠版本保护的缓存文件。已保留单连接一致性事务与会话内计算复用，移除以行数/日期判断可复用的跨会话维度缓存。

- [x] 实现 MySQL 与导入快照的受控维度分页；覆盖601+、门店/SKU、授权范围、无效及跨版本游标。
- [x] 无效维度参数按类型返回可修正错误；真正数据库/过期会话错误保持致命语义，真实MCP适配回归通过。
- [x] 保留原币种、唯一性、SQL编译、证据与取消守卫；增加不依赖返回文案的排队等待观测。
- [x] 回归验证进程内反复打开与重启均不复用旧维度目录。本轮回退实现包含在`b1726ea`；未启用的原条件项继续保留未勾选。

**原计划的条件项（尚未实施）：**

**修改:** `agent/analytics-operation-database.ts`、`agent/analytics-database.ts`、`app/lib/analytics/analysis-v2-types.ts`、`app/lib/analytics/analysis-v2-snapshot.ts`、`app/lib/analytics/database.ts`、`.dev.vars.example`、`.env.example`。容器默认缓存路径使用持久卷内目录 `/data/analysis-cache`，与本地应用数据目录分开说明。
**新增:** `agent/analytics-query-cache.ts`、`tests/analytics-query-cache.test.ts`、`tests/analytics-concurrent-session.test.ts`。
**回归:** `tests/analysis-v2-database.test.ts`、`tests/analytics-scenario-database.test.ts`。

- [ ] 写并发测试：两个不同查询用可控 Promise 挂起，断言第二个在第一个完成前已进入执行；四条忙时第五条排队；取消后排队与执行中请求都结束，迟到连接关闭。
- [ ] 写缓存测试：同版本同查询命中，不同参数、数据修订或编译版本不命中；损坏文件当未命中；失败、取消和未完成查询不写入；相同请求并发只计算一次。
- [ ] 运行新增测试，确认失败源于缺失行为，再实现查询执行器。新并发执行器按数据源在进程内共享最多四条连接，而不是每个会话都新开四条。它是资源并发限制，不是业务流程或轮数限制；逻辑 session 的结果和取消信号仍隔离。使用连接租借，单连接仍按顺序执行，避免共享可变 `connection` 串线。
- [ ] 复用原 SQL 编译、币种核验、唯一性核验、证据落盘与取消逻辑。保留原单连接模式供旧运行器及其一致性测试使用；只有任务 1 能验证源版本不可变或有可靠版本检查时，新运行器才启用并发，其他情况沿用单连接一致性读取。标记相同 snapshotId 不等于拥有同一物理快照。
- [ ] 缓存原始确定性查询返回值，不缓存带旧 `snapshotId`、`factId` 的结果图；命中后重新生成当前会话证据，并保留命中缓存与实际计算的溯源记录。键包含数据源命名空间、不可变数据修订、语义/编译版本、查询种类和规范参数。覆盖 aggregate、orderDistribution、scenario；aggregateWithOrderIds 仅会话内缓存，不落盘订单标识集合，不进入模型上下文。
- [ ] 一并升级现有内存/磁盘维度取值缓存：旧键也只含行数与日期，新模式目录缓存必须采用可靠修订；覆盖等行数更新、进程内重复打开及重启后读盘测试，无法验证版本时不跨会话复用。
- [x] 给 AnalysisDataSession 增加受控 dimensionValues 可选能力，并在 MySQL 与导入快照提供方实现。请求含白名单维度、真实授权范围、cursor、pageSize；返回 values/nextCursor。当前 MySQL 仅预读部分维度且超过 600 值便不提供 values，门店/SKU 也不在预读名单，仅修改 capabilityBrief 不足以支持全量读取。底层按白名单表达式、参数化值与稳定排序分页，不把任意列名/SQL 开给模型。覆盖 601+ 值、门店与 SKU、授权范围及跨版本 cursor 失效。
- [ ] 使用规范化参数和可靠数据身份生成 SHA-256 文件键；临时文件加随机后缀，写完原子 rename。缓存目录来自 `CTF_ANALYSIS_CACHE_DIR`，必须位于仓库外，权限沿用私有证据策略。读写缓存失败回退查库。
- [ ] 会话关闭、失败或取消时清理该会话排队与租借连接，不销毁其他会话的任务；销毁仍在执行本会话 SQL 的连接，健康空闲连接可归还共享池。增加两个会话并行时取消一个、另一个仍完成的测试，避免连接泄漏或跨会话误取消。
- [ ] 运行：`node --test --experimental-strip-types tests/analytics-query-cache.test.ts tests/analytics-concurrent-session.test.ts tests/analysis-v2-database.test.ts tests/analytics-scenario-database.test.ts`。预期全部通过；原单连接测试仍成立。
- [ ] 单独提交本任务改动。

## 任务 3：分析与情景工具适配

**新增:** `agent/analytics-skill-tools.ts`、`app/lib/analytics/qa/results.ts`、`app/lib/analytics/qa/capabilities.ts`、`tests/analytics-skill-tools.test.ts`。
**同步修改:** `app/lib/analytics/plan/prompt.ts`，让旧调用从共享目录函数重导出，不能让新运行器依赖后续准备删除的计划提示词。
**修改:** `app/lib/analytics/tool-names.ts`（增加新工具到轨迹白名单，保留旧名字）。

工具合同：

```ts
// query 执行分析；read_result 只读当前结果下一页，不重新查库。
// 对外仍只有一个 analyze 工具；zod 校验两种形状互斥。
type AnalyzeInput =
  | { action: 'query'; request: Omit<AnalysisOperationRequest, 'needIds'>; pageSize?: number }
  | { action: 'read_result'; resultId: string; cursor?: string; pageSize?: number };
// 每页默认 100 组，返回 totalGroups、nextCursor 和真实已读事实编号。
type ScenarioInput = {
  baselineResultId: string;
  adjustment: AnalysisAdjustment;
  netVolumeChanges: string[];
  reason: string;
};
// resultId 是本轮局部编号；operationId、factId 保留用于证据与图表。
// 每次调用分配自己的 resultId；相同底层结果允许复用 operationId。
```

- [x] 用真实 `createSnapshotAnalysisProvider(sampleDataset())` 与 MCP InMemoryTransport 写测试，调用 `inspect_dataset` 和五种分析方法，核对输出与真实工具结果一致。
- [x] 测试缺参、错误维度、缺参照和无效结果编号返回中文 `isError`；取消与数据会话失效继续向上传播，不伪装为可修正参数。
- [x] 实现 `inspect_dataset` 返回真实目录，不在工具前强制调用它。将现有 `capabilityBrief` 纯函数抽到共享目录文件，保留完整指标定义；新增可选 dimension/cursor/pageSize，按需读取某个维度全部真实取值。现函数对多于 60 个值只给 5 个示例，直接照搬会让模型找不到大部分活动名称。
- [x] 实现 `analyze` 调用 `createAnalysisOperations(session, constraints).execute`。保留 `controls`、`commonStores`，不能因新适配丢失同店与控制比较能力。只使用请求实际授权的 constraints，不由模型或 Skill 扩大。
- [x] 结果同时返回 scope、reference、单位、缺失状态、样本和 limitations；保留目标、参照、差额、相对变化的含义。百分数使用已有 `formatValue`，不能再次乘 100。
- [x] 结果按稳定分组键排序，每页至多 100 组且加入序列化字符预算（首版目标不超过 16000 字符，含返回包元数据），使用绑定 resultId 的 cursor 读取后续页，返回 totalGroups/nextCursor。数据不能因字符预算被静默删除，剩余内容必须可续读；最后一页为空 cursor。真实 SDK 对超过 50000 字符结果会转存文件，已实测造成模型看不到尾部。第 101 组能读取、页间不重不漏；翻页不重算、不新增实际分析 operation，不能用“改筛选”替代全量读取。总体、目标/参照和同组所需指标不因分页被拆散。
- [x] 将结果登记到 EvidenceRegistry。并发计算可以同时跑，ingestAsync 串行登记以避免视图冲突；登记包含全量合并校验，不能先称为“短队列”。记录本适配器已登记的可信封存操作与事实数组身份，同一真实操作缓存命中可跳过重复登记；不能只按 operationId 跳过不同内容校验。翻页不登记，队列失败不阻塞取消；用累计大结果与重复命中验证不会重复全量登记。
- [x] 实现 `simulate_scenario` 从已读结果寻找合法总体 amount 基线，复用 `simulatePlanScenario`，继续保持逐行/逐单到分计算与显式假设身份。只接受唯一合法总体基线，多个候选返回中文歧义而不猜测；非法或过期 resultId 拒绝。
- [x] 运行：`node --test --experimental-strip-types tests/analytics-skill-tools.test.ts tests/analysis-v2-operations.test.ts tests/analytics-scenarios.test.ts`，预期全部通过；提交。

## 任务 4：图表与自由正文的 v4 组装

**新增:** `app/lib/analytics/qa/chart.ts`、`app/lib/analytics/qa/answer.ts`、`tests/analytics-qa-chart.test.ts`、`tests/analytics-qa-answer.test.ts`。
**修改:** `app/lib/agent/reply-stream.ts`、`app/lib/analytics/plan/answer.ts`、`app/components/analytics/plan-answer.tsx`、`tests/analysis-plan-answer-v4.test.ts`、`tests/analysis-plan-ui.test.ts`。

```ts
type DrawChartInput = {
  resultId: string;
  metric: string;
  kind: 'bar' | 'line';
  by?: string;
  top?: number;
  title?: string;
  frameIds?: string[]; // 同一 metricId 多个控制层时明确选择，不能混加
};
// submit_answer({ body: '结论正文\n\n[[chart:c1]]' })
// Markdown refs: []；table 行 factIds: []；图表绑定真实 factIds。
```

- [x] 写测试覆盖按大区条形图、按日期升序走势、目标/参照双系列图、情景数值横轴、空结果、无效指标和不存在的 resultId。
- [x] 图表点直接读取事实 value，不允许模型传入点的数值。metric 使用真实 metricId；目标/参照双系列按事实框架绑定，不把总体、控制层、分层行混加；歧义时要求 frameIds。情景图保留净增比例数值轴与持平参照，不把它当日期。缺失值保持 null，top 只影响展示，图可读取本次结果的全部分组而非只读摘要第一页。
- [x] 写正文测试：数字原样保留；超过旧 800/1200 字限制的真实正文仍显示；“提升 12%”不被删；模型和厂商自述被清洗；未知 chartId 移除占位并记录实际情况。
- [x] 为新问答抽取只删除身份泄漏语句的清洗函数，禁止复用 `withoutUnderlyingModel` 的 SELF_INTRO 兜底/前缀：它会重新插入固定自我介绍，与“不要固定回复”冲突。活动现有清洗保持不变；新问答清洗后为空时，将违规信息作为工具错误退回同一次 Agent 自行改写，不另起固定复核或返回模板。最终仍为空或 SDK 失败则明确失败。
- [x] 实现按独立占位切分正文；Markdown 表格转换为现有 table 块，覆盖空单元格、转义竖线、表头分隔线、表前后正文，不执行 HTML。
- [x] submit_answer 不结束 SDK 会话；多次有效提交保留最后一版，无效提交不覆盖有效版。没有有效提交时，仅在 SDK 明确 success 且存在非 tool-use 的完整最终 assistant 文本时采用后备正文。用户取消、SDK 错误、max_tokens 截断、异常 EOF 和仅有“我去查一下”的中间消息不能冒充最终答案；同步等待已开始的工具完成或取消后再关 session。
- [x] 放宽 v4 结构上限到设计文档规定的 20000 字、12 图、50 表、每表 200 行；这属于序列化限制，超过时明确报错，不静默截断。更新旧的长度断言，其余旧答案校验继续通过。
- [x] 组装 `plan` 为实际 query/simulate 执行记录，翻页不算新分析，`review.notes=[]`。返回模型实际读过各页的事实、图表事实及完整父链，保留相关 frames/methods/objects；无图也不能丢光正文所依据的事实。部分操作 unsupported/失败后仍作答，答案标 partial 并保留实际局限；失败后修正成功不能仅按历史失败数判答案无效。
- [x] 私有审计保留完整工具结果用于回归查错。为新问答增加“本次查数结果”入口，即使 refs=[]、没有图表也能查看已读结果与范围；它不是逐句核验标记。旧 refs 数字按钮继续显示。当前 SourcePanel 在 factIds 为空时不展示数据，必须实际改组件并增加无图查数的 UI 测试，不能只在计划里写“照常可查”。
- [x] 运行：`node --test --experimental-strip-types tests/analytics-qa-chart.test.ts tests/analytics-qa-answer.test.ts tests/analysis-plan-answer-v4.test.ts tests/reply-stream.test.ts tests/insight-context.test.ts`，预期全部通过；提交。

## 任务 5：核实理论并写两份 Skill

**新增:** `agent/analytics-plugin/skills/ctf-qa/SKILL.md`、`agent/analytics-plugin/skills/marketing-theory/SKILL.md`、`agent/analytics-skill-catalog.ts`、`tests/analytics-skill-catalog.test.ts`、`docs/research/2026-10-25-marketing-theory.md`。

- [x] 用可访问的原始论文、出版社或研究机构材料逐条核实理论来源，记录作者、标题、年份、稳定链接、支持的命题和适用限制。已形成研究索引与两份明细，逐条区分正文、摘要与仅书目/目录，不把未读正文当已核实。
- [x] 覆盖十个方向：结论表达、指标拆解、促销增量/蚕食/囤货、可比对照、条件保本、黄金行业结构、门槛凑单、折扣表述、交易/门店细分、参考价格。无法核实的首创归属、正文效应量及本品牌效果明确保留为未核实。
- [x] 每条理论同时核对“有原始字段”和“现有方法/计划工具能否执行”。五种确定性方法与拟议五个业务工具不是同一层。门槛凑单需要直方图/阈值附近分布，现 order_distribution 只有 p50/p90/p99，不能据此宣称已实现门槛效应分析；未开放的能力明确标为方法参考，本次未增加 SQL 或分析方法。公式的定义和假设已核实并以精确有理数复算；收入持平与维持原利润分开，源零售毛利不能自动当贡献毛利。促销前后、弹性和参考价格变化仍需多期或实验数据。
- [x] `ctf-qa` 写自然语言指导：按用户当前问题选择取证；问候可直接回复；简单查数快答；复杂分析自主探索；已有工具能查的先查；需要用户才知道的条件再追问；结构、图表与停止时机随问题变化。禁止固定章节、示例答案模板和强制分析清单。
- [x] `marketing-theory` 每条采用“适用问题、所需数据、怎样判断、不能推出什么”的参考说明；它是候选方法，不要求每题使用。数据缺口按运行时 capabilities 判断，区分 MySQL 与导入快照能力，避免写死永远做不了某指标。
- [x] 新 Skill frontmatter 仅 name、description；description 明确场景，单纯查数不应加载理论，创建活动不应触发这两份分析 Skill。研究记录增加人工映射：Skill 条目 → 实际命题 → 原始来源具体章节/页码 → 适用限制 → 核实结论；最终 Skill 与映射逐项核对，不能只通过 frontmatter 测试就宣称理论已验证。
- [x] 实现目录校验：插件名 analytics、两份 Skill 名称/目录一致、单一 H1、非空 description、拒绝路径越界；旧执行插件的六节与 `[S#]` 校验保持不变。
- [x] 测试有效目录通过、损坏 frontmatter 和错误插件失败、两份新 Skill 可独立识别、旧 Skill 不进入新会话允许名单。
- [x] 运行：`node --test --experimental-strip-types tests/analytics-skill-catalog.test.ts tests/skills.test.ts`，预期全部通过；提交。

## 任务 6：一次 SDK 会话的新运行器

**状态：** 本地实现与回归通过；真实SDK已观察仅两份新Skill。工具权限与只读配置已验；最终集成版的真实模型双analyze重叠保留未测，前置独立SDK并行实验不冒充此项。

**新增:** `agent/analytics-skill-run-turn.ts`、`tests/analytics-skill-runtime.test.ts`。
**复用:** `agent/analytics-model.ts`、`app/lib/cancellation.ts`、现有公开轨迹与私有审计约定。

- [x] 创建假 `AgentQuery`，通过 MCP InMemoryTransport 调用真实注册工具。测试允许先查数、先画图失败再修正、无工具问候、多次提交、自主循环超过 12 轮；断言每个请求 SDK query 只调用一次。
- [x] 定义中性的共享 AnalyticsSkillRunner 类型供 HTTP 与附件引用，签名兼容旧 PlanAnalyticsRunner，不让新模块 import 后续要删除的运行器。返回 v4；ensureSession 使用单个共享 pending Promise 惰性打开，两个首发工具共享一个 session，取消后的迟到 session 关闭；问候不查库。
- [x] SDK 配置仅公开 Skill 与五个业务工具，`settingSources: []`、`persistSession: false`，不设置 maxTurns、总时间或业务轮数。`skills` 仅列 `analytics:ctf-qa` 与 `analytics:marketing-theory`，它们可被模型选择，无 Skill 加载前置门禁。
- [ ] 工具名称来自同一注册表，精确 canUseTool 白名单拒绝 Bash、Read、网络、自由 SQL 和其他插件 Skill；新业务工具不填入裸名 allowedTools，以免自动批准跳过回调。仅允许两份 Skill 的 SDK 目录过滤仍需独立验证，不要用 analytics 前缀放行任意工具。查询工具添加真实只读 annotations；独立实测已证明标记与 canUseTool 可以同时生效，集成时仍测两个真实 analyze 的重叠，单测 Promise.all 不代替端到端证据。
- [x] 系统提示只包含身份、权限与工具提交协议。业务指导在 Skill；history/context 保留收到的用户原话与顺序，区分当前问题、历史消息和关注上下文，最新纠正优先。现客户端只传近 10 条历史且每条最多 4000 字，context 另有上限，不能宣称模型收到整段完整历史。报告/数据库权限与业务筛选分别传入，不把整份 report.query.period 误作不可变授权范围；用既有报告改日期、继承筛选用例回归。
- [x] 记录真实 Skill tool_use 与 tool_result，只有成功加载才显示“参考了”。公开 purpose/title 摘要按现 publicAnalyticsTrace 的 120 字标题/1000 字摘要限制安全格式化，不改私有完整内容；所有用户可见标题、图题、表格、错误也检查身份泄漏，避免只清洗 Markdown。用超长 purpose 测试 Workers 和浏览器不会中断整条流；图题、表格文本、Skill 失败和错误信息也加入模型/厂商/框架泄漏测试。
- [x] SDK iterator.next 与外部 AbortSignal 竞速，停止时中断挂起请求、关闭 session、结束未完成轨迹。用一个永不返回的假 next 验证取消即时生效。
- [x] 捕获最终完整文本用于后备正文；Skill 内容、工具文本和思考内容不作为 assistant 正文展示。所有对外文本走身份清洗。增加从洞察选中关系进入问答的输入测试：focusContext 作为 context 原样进入新运行器，不能只测回答端能定位回图。
- [x] 审计记录请求、公开工具调用、耗时、结果与最终答案到仓库外，记录版本和取消；不保存隐藏思维。
- [x] 运行：`node --test --experimental-strip-types tests/analytics-skill-runtime.test.ts tests/analytics-skill-tools.test.ts`，预期全部通过；提交。

## 任务 7：服务接入与旧合同兼容

**修改:** `agent/server.ts`、`agent/http-handler.ts`、`tests/analysis-plan-http.test.ts`、`tests/analysis-v2-http.test.ts`、`tests/analytics-http-stream.test.ts`、`tests/analytics-visualization-stream.test.ts`、`AGENTS.md`、`CLAUDE.md`。
**附件接入另核对:** `agent/attachments/run-turn.ts`、`agent/attachments/tools.ts`、`app/lib/attachments/answer.ts`，范围取决于文末尚待决定的附件项。

- [x] 写 HTTP 测试并采用同一矩阵：请求 v3 → 新运行器返回 v4；请求 v4 → 新运行器返回 v4；无头、v2 或未知头 → 明确版本错误且不启动旧运行器；已保存 v1/v3/v4 消息 → 继续按现有读取兼容。前两种请求中“你好”“谢谢”“你是谁”和明确月份销售额都进入模型；流式事件及取消能穿过现有链路。
- [x] `server.ts` 将新运行器注入 v3/v4 新请求路径。旧消息读取继续兼容；无版本头新请求返回明确的版本升级错误，不再调用旧模型运行器，否则固定回复仍可从旧接口产生。旧运行器仅留作测试对照，若确需运行中的 v1 客户端兼容，再独立设计适配，不恢复固定回答。
- [x] 删除 HTTP 层对 `quickAnalyticsReply` 的问候放行分支。未配置数据服务的状态按已确认设计返回真实不可用错误；已配置但模型只问候时不执行数据库查询。
- [x] HTTP 单测补最小真实合同的 database stub，不再依赖“你好”逃过数据配置检查；保持已有版本协商与附件测试的目的。
- [x] 保留旧回复的校验与旧会话读取；不更改页面活动/分析路由正则，不更改活动创建门禁。附件若接新运行器，必须先做 recordDatabase 事实来源和外层限时兼容测试；不能仅更换注入函数就宣称混合问答已支持全部新要求。
- [x] 同步 AGENTS.md 与 CLAUDE.md 的“当前智能问答”说明，注明新入口、五工具、无固定回复、自主 Skill 与附件边界；版本头、数字校验、总时长说明必须一致。不能仅改一份而给后续维护者相反指令；执行插件章节保持原约束。
- [x] 运行：`node --test --experimental-strip-types tests/analysis-plan-http.test.ts tests/analysis-v2-http.test.ts tests/analytics-http-stream.test.ts tests/analytics-visualization-stream.test.ts tests/attachments-agent.test.ts`，预期全部通过；提交。

## 任务 8：统一时间线并显示实际参考 Skill

**修改:** `app/components/chat/tool-timeline.tsx`、`app/components/chat/message-view.tsx`、`app/components/chat/conversation.tsx`、`app/components/analytics/history-message.tsx`。
**新增:** `tests/tool-timeline-ui.test.ts`。
**完成引用检查后删除:** `app/components/chat/tool-run-card.tsx`、`app/components/chat/tool-step.tsx`。

- [x] 使用现有 `tests/helpers/react-component.ts` 与 renderToStaticMarkup，测试同一轨迹的多个成功 Skill 合并成“参考了：…”；重复名称去重；失败加载不冒充成功，仍显示失败状态。
- [x] 在 `ToolTimeline` 内识别两个 Skill 事件名，标题取已有中文 Skill 名，隐藏内部工具名、确定性执行徽标与 Skill 内部耗时。真实业务工具仍一行一步。
- [x] 活动创建已保存轨迹与 liveTrace 两处改为 ToolTimeline，传真实 startedAt/durationMs；给组件增加明确的 completed/warning/failed/cancelled 总状态和适用标题，不能把失败回合标“已完成”，也不能把创建活动一律写“正在分析”。保留完成折叠、停止、文字选择与键盘展开。
- [x] 智能问答继续使用同一组件，purpose 做标题，结果摘要做次级文字。未做独立复核的新问答把“正在核验并整理回答”改成“正在整理回答”；保留仍在实际核验的附件文案。当前 AnalyticsProgressEvent 只有 trace/phase/visualization，没有正文 delta；本次沿用过程流加最终答案，不宣称已有逐字正文流式。
- [x] `rg` 确认旧组件没有其他调用方后删除两个展示文件；保留轨迹数据格式和落库逻辑。
- [x] 运行：`node --test --experimental-strip-types tests/tool-timeline-ui.test.ts tests/tool-trace.test.ts tests/analysis-plan-ui.test.ts`，预期全部通过；提交。

## 任务 9：综合验证、真实问题对照和交付

**新增:** `agent/analytics-skill-evaluation.ts`、`docs/superpowers/notes/2026-10-25-skill-qa-acceptance.md`。
**修改:** `agent/tsconfig.json`，将独立 evaluation 入口纳入类型检查；必要时在 `agent/model-gateway.ts` 加非敏感调用计数出口，区分真实上游请求与 SDK query 次数；相关传输与会话恢复测试按下列验收覆盖。
**私有产物:** 本地应用数据目录内的新旧回答、完整工具结果与逐题评分；不得提交客户数据。

- [x] 执行 `npm test`、`npx tsc --noEmit`、`npx tsc -p agent/tsconfig.json`、`npm run lint`、`npm run build`，逐项记录真实结果，失败修复后重跑受影响检查。
- [x] 重启本机已确认的 dev:all 实例，核对实际端口与进程，保证浏览器访问的是新运行器。
- [ ] 从私有审计记录选最近 15 个真实问题，保留各题原 history/context 和旧答案，按简单查数、比较解释、复杂决策分组。不要只拿脱离上下文的问题字符串回放。
- [ ] 新评估脚本调用新运行器，分别统计 SDK query 启动次数、真实模型 API 请求次数、SQL 执行/排队/缓存耗时、总耗时、实际 Skill 与答案；并发阶段不能简单相加当墙钟耗时。运行失败单列。15 题用于冒烟和人工对照，不足以证明普遍效果或 p95；补问候、查数、范围纠正和长探索等固定回归案例。
- [ ] 核对正文中的经营数字与完整工具结果，对模型自行计算的比例用独立算式复算，统计错误句数和分母；这是验收检查，不在运行时加回数字门禁。
- [ ] 并排检查问题是否直接回答、结构是否随问题变化、建议是否有数据依据、有没有不相关 Skill、历史相关有没有写成因果。分别报告冷缓存和暖缓存，不把暖缓存速度冒充首次速度。
- [ ] 简单问题以大多数 60 秒内为目标，复杂问题允许长时间探索；报告实际分布和个例，不承诺所有问题固定几十秒。
- [ ] 真实浏览器截图活动创建与智能问答的运行中/完成/失败/停止状态，检查移动宽度、图表表格、来源、洞察定位、复制与停止。已有会话只能验证展示兼容；另用当前代码重放既有活动夹具，比较业务状态、产物与工具行为，证明活动流程未变化。
- [ ] 做完整闭环：新答案经 NDJSON → 浏览器 → 对话保存 → 页面刷新 → 复制 → 下一轮追问；覆盖无图查数、长文、多图表、停止/失败与旧会话。传输当前上限 6400 万字符，而会话写入接口当前只有 2 MiB，不能只放宽 v4 字数就宣称能保存所有大回答；按实际 UTF-8 字节校验容量，超出时明确显示保存失败并保留当前答案，不能静默丢失或伪称已保存。大结果持久化若需改存储合同另列范围决定。
- [x] 验证页面构建完成，Agent源码归档含两份新 Skill、两个插件manifest及原6份执行Skill；Docker的`COPY . .`覆盖这些文件。未构建/部署容器镜像。私有配置、客户数据或日志未进入Git。
- [x] 验收分开记录代码检查、真实 SDK/网关、真实数据库、真实模型效果、浏览器持久化五种证据。不存在来源、关键方向/算术错误、身份泄漏、活动流程变化、取消无效均列为未通过项；时间目标单独报告，不因快而抵消回答质量问题。记录未解决项和私有结果位置，提交可公开记录并提供新旧对照入口。

### 任务9实际进展与保留项

- [x] 新评估入口已实现并纳入类型检查，记录SDK启动、真实API、SQL执行/排队、结果与Skill；早期3题真实冒烟和本地额度错误有分开记录。
- [x] 真实15题私有用例已选取；原审计缺完整history/旧答案时如实记录，不补造缺失上下文。
- [ ] 最终版15题真实执行、逐题效果与数字人工核对、真实耗时分布：额度耗尽，按用户选择未测。
- [ ] 最终集成版真实模型双analyze并行、完整SDK→Workers浏览器链路：未测，前置独立实验及浏览器合成回答不替代。
- [x] 活动领域夹具回归56项通过；原活动示例桌面与360px补测通过，未发送活动模型回合。
- [x] QA浏览器主检查及保存/刷新/复制/追问闭环通过，仍保留未覆盖的普通网络重试、旧答案兼容及活动实时执行浏览器项。

## 实施前需要明确的范围

1. **附件混合问答。** 现 `agent/attachments/run-turn.ts` 自带 240 秒预算、最多三次历史分析及固定复核，并给嵌套分析传 `wrapUpAt` 的 timeout。正文仍按 `conversation-answer/v1` 逐段绑定事实。替换内部运行器不能消除外层限制。默认本轮无上限承诺只覆盖直接数据库智能问答；附件维持现有入口，是否一起改外层预算和复核需明确，不能顺手扩展到活动创建。若保持现状，验收明确写明差异且保留原附件注入；若纳入本轮，先更新附件设计与用例，之后才切换注入。
2. **来源与大结果。** 页内“本次查数结果”入口是保持可核查性的必要补全，正文不加回数字校验。20000 字、12 图等只表示单答案结构上限，未承诺任意多轮会话能塞进原 2 MiB 存储请求；容量闭环未通过前，不能宣称长答案持久化已完成。

## 旧代码清理单独进行

新流程通过验收后先列出精确删除清单，再依照用户已约定的方式确认。此次实施不提前删除旧分析运行器、旧两份分析 Skill 和旧测试。`plan/bind.ts`、`plan/body-markdown.ts`、`plan/scenario.ts`、v4 校验和旧消息显示仍被使用，不能整目录删除。

## 计划自查

| 要求 | 对应任务 |
|---|---|
| 自主流程、一次 Agent 会话、无固定回复 | 5、6、7 |
| 五工具、只读、正确金额与情景计算 | 2、3、4、6 |
| 不设总时长/轮数、可停止、上下文增长 | 1、6、9 |
| 营销理论核实与按需加载 | 5、6、9 |
| 并发与版本缓存 | 1、2、9 |
| 自由正文、真实数据画图、v4 兼容 | 4、7 |
| 连续对话、洞察 | 4、6、7、9 |
| 附件历史分析 | 实施前范围项；确认后再扩任务 7、9 |
| 两边 UI 统一，活动流程保留 | 8、9 |
| 15 题效果与速度回归 | 9 |
| 清理前单独确认 | 旧代码清理单独进行 |
