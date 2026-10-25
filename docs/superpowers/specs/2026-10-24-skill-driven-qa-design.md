# 智能问答改为 Skill 驱动 设计

日期：2026-10-24；2026-10-25 对照代码复审，并完成独立 SDK/MySQL 前置实验，见 `docs/superpowers/notes/2026-10-25-skill-qa-preflight.md`。实施清单见 `docs/superpowers/plans/2026-10-24-skill-driven-qa.md`。取代智能问答现有的计划式运行器（`agent/analysis-plan-run-turn.ts` + `app/lib/analytics/plan/`）。活动创建（小福搭 1811）的流程这次不动，只改它的执行过程展示。

2026-10-25 实施状态：直接问答、两份Skill、五工具、自由正文与统一时间线已实现；持久缓存与多连接因可靠源修订缺失保持未启用，附件保留原合同。资源恢复后冻结`3cd32cc`完成15次真实回放，14次完整、1次部分，上游失败0次；逐题业务复核均需修订，耗时中位数188.620秒。后续`751ebf7`补普通scan展示、同会话等价原始SQL复用和Skill证据边界，3题定向复验1题通过并保留提醒、2题需修订；`a9a4954`再修复追问重复上下文，最终1203项串行检查、类型/lint/构建和7项真实浏览器闭环通过。业务效果仍未验收，不因实现或接口通过而签收。最新结果见 [真实复验](../notes/2026-10-25-native-provider-revalidation.md)，原阶段记录见 [实施与本地验收](../notes/2026-10-25-skill-qa-acceptance.md)。

## 1. 问题

本机最近 15 次智能问答的审计记录（`~/Library/Application Support/ctf-campaign-agent/analysis-runs/*.jsonl`）：

- 慢：复杂问题 170–244 秒。时间分两块：
  - 模型 6 次串行调用约 60–150 秒。其中复核计划 15–134 秒、补充计划 14–82 秒（多数交空），前三步开思考。
  - 查库 30–80 秒。`plan/execute.ts` 逐节点串行，共用一条快照连接。先前部分分组查询观察为 0.5–2.2 秒，不能推广为所有 SQL 都快；2026-10-25 四条真实聚合的暖缓存串行中位数为 19.032 秒，四路并发为 13.158 秒。串行与资源竞争都影响耗时，不能只归因于排队，也不能承诺四倍提速。
- 千篇一律：
  - 代码写死「计划 → 复核 → 执行 → 补充 → 正文 → 复核正文」六步。
  - 计划只能用 measure / contrast / decompose / scan 拼，正文模板示例、字数和图表上限、复核改写都在往同一个形状推。
- Skill 没在起作用：页面发 `analysis-answer/v4`，走计划式运行器，每步 `tools: []`、不挂插件。`ctf-marketing-advisor`、`analysis-review` 只有已不走的旧运行器会加载。

## 2. 决策（2026-10-24 与用户确认）

| # | 决策 |
|---|---|
| Q1 | 流程不写死在代码里。智能问答由模型按 Skill 自己决定查什么、查几次、怎么组织。代码要固定任何业务流程，需先经用户同意 |
| Q2 | 查数用现成的确定性分析动作当工具，不开放自由 SQL |
| Q3 | 正文数字不再由代码核对，也不固定复核步骤（用户选「全部放开」）。已告知风险：模型可能算错或写出查询里没有的数 |
| Q4 | 图表由模型调画图工具生成，图上数字来自真实查询结果 |
| Q5 | 代码固定的只有两条：① 只读安全边界，只能用本设计列出的工具，不能跑 SQL、命令、文件、网络；② 对外人设，回复不出现底层模型、厂商、框架名字 |
| Q6 | 不设时长上限和轮数上限，用户随时可以停止 |
| Q7 | 活动创建流程不动；两边的执行过程展示统一成时间线样式 |

## 3. 架构

一次问答 = 一次 Agent SDK `query()`，由其中的模型对话自主循环。一次 query 可以含多次模型 API 请求，不能把它说成只调用一次模型；总耗时仍须实测。

```text
页面 POST /api/analytics/history（v4 头，不变）
  → Workers 流式转发（不变）
  → Agent http-handler → 新运行器 agent/analytics-skill-run-turn.ts
      query({ tools: ["Skill"], plugins: [analytics-plugin], mcpServers: { analytics }, 不设 maxTurns })
      模型：自主决定是否加载 Skill、读取哪些结果、是否画图及何时提交
      各动作可选、可重复；独立查询可并发，不要求按图中顺序执行
  → 组装 PlanAnswerV4 → 流式返回
```

`createConversationRunner`（文件问答）的历史分析适配需单独核对：它外层已有 240 秒时限、三次历史调用上限及逐段数字核验，直接换运行器不能兑现“无上限、正文放开”。本轮默认先交付直接数据库智能问答；附件是否一起移除外层限制为实施前范围决定，未决定前保留原附件注入。新运行器使用中性的共享类型，签名兼容旧 PlanAnalyticsRunner，但不依赖旧运行器模块。

连续对话：请求里的 `history`（近期问答）和 `context`（用户前面说过、仍然有效的范围和口径）原样写进这一轮的用户提示词，由模型判断追问指的是什么、哪些范围沿用。代码不再替模型拼「沿用上一轮范围」的业务规则。权限边界仍由真实请求校验；业务筛选与数据授权不能混为一谈。当前客户端已裁剪为近 10 条历史、每条最多 4000 字及有限 context，本设计的“原样”指收到的这些内容，不代表完整历史无限保留。

不走固定回复：删掉问答入口前的两条正则捷径，所有问题都进模型，包括打招呼、致谢、问「你是谁」。
- `quickAnalyticsReply`：寒暄、致谢、能力介绍直接返回写死的回复；
- `quickMonthlySalesQuery`：「X 年 X 月销售额是多少」走单独的快速查询。

一并改掉的地方：
- 新运行器不调用这两个函数；v3/v4 新请求统一走新运行器，无版本头的新请求提示升级协议，不再运行旧模型路径；旧消息的读取不受影响；
- `agent/http-handler.ts:129`：没连数据库时给寒暄放行。改为没连数据库就统一报「历史数据库尚未启用」。

保留不动的（实施前核对过）：
- `app/lib/analytics/explain.ts:87`：这是读旧会话时校验已存的寒暄回答，删了旧消息会显示不出来，不产生新的固定回复；
- `app/lib/analytics/intent.ts:18`：只决定一句话分到智能问答还是活动创建，不产生回复，属于第 4 节的第二个子项目；
- 两个函数本身留给旧代码测试/对照，第 5 节核对读取依赖后清理，不对新问答请求开放。

简单问候怎么回、要不要查数，写进 `ctf-qa`。代价是问候也要等一次模型调用（几秒）。

洞察联动：从洞察图跳来的 `focusContext` 照常写进提示词；回答的 `evidence` 仍带 objects 和 frames，`locateAnswer` 的「在洞察图上看」不受影响。

### 3.1 工具（MCP server `analytics`）

| 工具 | 入参 | 返回 | 实现 |
|---|---|---|---|
| `inspect_dataset` | 可选 `dimension`、`cursor`、`pageSize` | 默认能力目录；指定维度时分页读全部真实取值 | 从旧计划提示词抽出共享目录函数，保留完整指标定义 |
| `analyze` | `action=query` 时传 `request`（原 method/scope/metrics/by/reference/controls/commonStores/breakdown/check/alternative/purpose）；`action=read_result` 时传 `resultId`、`cursor`；均可带 `pageSize`、`orderBy:{metric,direction?,frameId?}` | `resultId`、分组指标/样本/口径、`totalGroups`、`nextCursor` | query 复用确定性 execute；read_result 只读本轮已算结果；排序作用于全量计算结果，不重查或丢长尾 |
| `simulate_scenario` | `baselineResultId`、`adjustment`、`netVolumeChanges`、`reason` | `resultId` + 情景测算值 | `simulatePlanScenario` |
| `draw_chart` | `resultId`、`metric`、`kind`（bar / line）、`by`、`top`、`title`、可选 `frameIds` | `chartId`，或说明这份结果画不了的原因 | 新写 `app/lib/analytics/qa/chart.ts`，按 `resultId` 取数；对比结果自动画成目标、参照两组柱 |
| `submit_answer` | `body`（Markdown，`[[chart:编号]]` 放图） | 接收结果及格式/缺图提示 | 不核对正文数字；校验结构和图引用，缺图向模型提示，不伪装完整交付 |

- 工具入参错误（维度不存在、缺 reference 等）沿用现有中文错误，以 `isError` 返回给模型自己改，不算失败。
- `inspect_dataset` 的维度分页需要底层受控 dimensionValues 能力，MySQL 与导入快照分别实现；当前 MySQL 超过 600 值会丢弃预读 values，门店/SKU 也不预读，不能只改格式化函数就声称可读全量。取值查询仍受授权与参数化白名单约束。
- `analyze` 每页至多 100 个返回单元且含元数据不超过 16000 字符，保留可续读 cursor，不静默丢内容。实测超过 50000 字符会被 SDK 转为模型无权读取的文件提示。按稳定结果视图分页：真实比较的目标、参照与差额以 comparisonKey 保持同组；不同净量情景分别成组；无业务对象的控制中间依据不能全部挤成一个总体，歧义同名依据单列。大量方法检查也分页，完全相同检查保留出现次数。`totalGroups` 表示返回单元数，实际业务分组数见方法报告，不能拿前者回答门店或活动数量。可选 orderBy 从全量结果按真实指标排序，范围歧义要求 frameId，游标绑定排序视图；其余内容仍可继续读取，不用重查或缩小筛选替代分页。能力目录同样允许读全部活动名称。
- `submit_answer` 可以交多次，以最后一次有效提交为准，不立即终止会话。未有效提交时，只在 SDK 明确 success、无截断且存在完整最终 assistant 文本时采用后备正文；取消、错误或异常 EOF 不采用中间草稿。非法图占位向模型返回提示，最终仍有缺图时标注 partial，不静默宣称图文已齐。

### 3.2 查库提速

- 新并发执行器按数据源共享进程级最多 4 条只读连接，使用独立连接租借，逻辑会话的结果和取消隔离，不能共享可变 connection 指针。先验证数据不可变或可靠版本检查；不能证明多连接读取同一版本时，沿用单连接一致性读取。相同 snapshotId 标签不代表共享物理快照。
- `ensureSession` 对并发首次工具调用复用同一 pending Promise；结果计算可并发，EvidenceRegistry 登记串行。已登记且身份相同的可信封存结果不反复全量登记，翻页不重登记；不能仅按 operationId 绕过不同内容检查。独立真实 SDK 实验已验证只读工具可并发，正式接入 analyze 后仍需复测。裸 allowedTools 会绕过 canUseTool，计划改为业务工具由空的自动允许名单加精确回调判定；这只是权限实现，不规定业务顺序。
- 结果缓存按数据源命名空间、不可变数据修订、语义/查询编译版本、查询种类和规范参数落盘。MySQL 每次随机生成的 datasetVersion 不能当跨会话键，“库名.表名:行数:起止日期”也不能识别等行数更新，不能当内容版本。优先从导入产物哈希/可靠修订号取得版本；原维度取值缓存也一并核对更新键。验证不了时关闭跨会话缓存，保留会话内缓存。
- 缓存 `aggregate`、`orderDistribution`、`scenario` 的原始确定性结果，不复用旧 factId/snapshotId，命中后登记当前会话证据并保留缓存溯源；订单标识集合仅会话内缓存。目录 `CTF_ANALYSIS_CACHE_DIR`，本地默认 `~/Library/Application Support/ctf-campaign-agent/analysis-cache`、容器默认 `/data/analysis-cache`，均位于仓库外；取消和失败不写缓存。

### 3.3 Skill（`agent/analytics-plugin/skills/`）

运行时只提供经过校验的两份 Skill；模型按 description 自己决定加载哪几个，代码不强制。安装版本的 SDK init 发现清单仍包含旧与捆绑 Skill，因此除 skills 过滤外，每轮在独立运行目录建立只含两份 Skill 的临时 analytics 插件，关闭捆绑 Skill 并隐藏内置 doctor，结束后清理该副本；原插件和旧 Skill 继续留给附件与旧合同。真实 SDK 冒烟的发现清单已核对为两份。

- `ctf-qa`（新，主 Skill）：怎么理解问题、先看数据再决定查什么、边查边追问、什么时候该停、按问题本身组织回答（不给固定板块）、怎么配图。简单问题一两次查询就答。并入 `ctf-marketing-advisor` 里仍然成立的业务知识，比如：
  - 每克金额只在同货类、同材料内比；
  - 会员标识不等于新老会员或复购；
  - 天数不同的两段比日均；
  - 相关不写成因果；
  - 单店个案放后面。
- `marketing-theory`（新）：已核实来源的 10 个候选方向，每条写清什么问题用、需要什么数据、当前工具能做什么和结论边界；表达方法、代数定义、行业口径与实证研究分别说明，不统称为已验证的营销定律：
  - 结论先行；
  - 指标拆解树；
  - 促销销量来源与净增识别边界；
  - 同店同期与对照；
  - 贡献毛利与维持原利润的条件测算；
  - 黄金行业结构；
  - 门槛与凑单；
  - 折扣表述；
  - 门店与交易细分；
  - 促销频率与参考价格。

  2026-10-25 已完成来源与实际能力对照，见 [研究索引](../../research/2026-10-25-marketing-theory.md)及其两份明细。正文、摘要、仅书目/目录分别标明；未读正文的效应量和首创归属不背书。RFM、CLV、复购、客流转化、真实 ROI、剥离金价等按数据源和运行时能力说明缺口，不能凭字段相近就硬套。门槛效应需阈值附近分布，现订单分位数接口不等于直方图。收入持平 `d/(1-d)` 与维持原利润的额外销量 `d/(m-d)` 不同，后者的 m 必须是降价前贡献毛利率，且成本与组合等假设成立；当前源零售毛利及收入情景工具不能自动提供该利润测算。两份新Skill已落地，来源核实仍不等于所有相关分析能力均已实现。
- 从原正文提示词（`plan/prompt.ts` 的 `answerPrompt`）沿用的回答要求，作为思路写进 `ctf-qa`，不写成固定板块：第一句直接回答问题；要方案时先给方案、缺口放最后；缺维度时先说答不了的部分和原因，再给能确定的事实，再说补什么数据；用户纠正过的口径以最新为准。
- 旧的 `ctf-marketing-advisor`、`analysis-review` 还被旧运行器和它的测试读取，第 5 节清理时再删。新运行器用 SDK 的 `skills` 选项只开放 `ctf-qa`、`marketing-theory` 两份，模型看不到旧的。

### 3.4 回答组装

`PlanAnswerV4` 结构不变，页面 `PlanAnswerV4View` 照常渲染：

- `body`：正文按 `[[chart:编号]]` 切成 markdown 块和 chart 块，markdown 块 `refs: []`。模型写的 Markdown 表格转成 table 块，用页面现有的表格样式显示（聊天 Markdown 渲染器不支持表格）。`validatePlanAnswerV4` 的上限放宽：正文 20000 字、图 12 张、表 50 张、每表 200 行。
- `plan`：改为本轮调过的每次 `analyze` / `simulate_scenario`（id、方法、状态、`purpose`），页面的「分析步骤」照常显示。
- `evidence`：模型实际读过各页的事实、图上用到的事实及其完整父链，配套范围/方法/对象。不能因没有图表就删光查数结果。私有审计保存完整结果，页面按已读结果展示；洞察定位只需维度的部分可以精简对象。
- `review.notes`：空数组。`assumptions`、`definitions`：从用到的结果的口径和局限汇总。
- 人设清洗：新问答仅复用识别规则，不直接用 `withoutUnderlyingModel`，因为该函数会自动插入固定 SELF_INTRO。只删除身份泄漏，清洗后为空退回当前 Agent 自行改写；不加固定自我介绍，也不新起独立复核。原活动清洗不动。所有公开图题、表格、轨迹和错误也需检查；正文真实涨幅和长文不被旧 800 字截断规则误删。
- 来源展示：新问答 refs 为空时，新增“本次查数结果”入口展示实际工具结果，旧数字按钮继续工作。当前 SourcePanel 及 v4 View 不能在无图无 refs 时自动提供来源，必须实际调整组件。此入口不表示正文已逐句核验。
- 容量：单答案结构上限不是存储保证。现 NDJSON 支持大结果分块，但会话写入请求为 2 MiB；实施须测回答、保存、刷新、追问完整闭环，按 UTF-8 字节检查。超出须明确显示保存失败并保留当前答案，不静默丢失。

### 3.5 执行过程展示（两边统一）

- 活动创建：`message-view.tsx`、`conversation.tsx` 把 `ToolRunCard` 换成 `ToolTimeline`。去掉工具名标签、「确定性执行 / 系统补跑」徽标和「Skill/工具 xx ms」计时。`tool-run-card.tsx`、`tool-step.tsx` 不再使用后删除。
- Skill 加载（活动的 `load_campaign_skill`、问答的 `load_analytics_skill`）不作为时间线步骤，合并成时间线顶部一行小字「参考了：活动编排方法、1811 开单流程」，名称取 Skill 标题。
- 智能问答时间线：每次工具调用一步，标题写做了什么（取 purpose 的公开摘要），下一行写结果。标题/摘要满足既有传输长度限制。组件接入真实整体状态，失败不能标“已完成”，创建活动有适用的状态文字。新问答不再写“正在核验”，改为“正在整理回答”。
- 服务账户额度耗尽统一显示“当前服务额度不足，请及时联系管理员。”；不展示原始英文、预算、请求标识，不误判普通429限流与上下文超长。明确的旧上游错误显示失败，不再误标完成；原消息存储不改写。
- 本轮保留当前过程事件流与最终 v4 答案；现 AnalyticsProgressEvent 没有正文 delta，不宣称已有逐字正文流式输出。
- 只改展示；活动创建的轨迹数据、落库格式不变，旧会话照常显示。

## 4. 不在本次范围

- 活动创建的写死流程，留作第二个子项目，先不动。已识别的写死点：
  - `agent/skills.ts:72` 按正则强制加载 Skill，命中任意一个再附加 orchestrator；
  - `agent/tool-gate.ts` 的 Skill 门禁；
  - `turns.ts` 的 `replyWithQuestions` 补问、编排器补跑状态分析、点头在调模型前记下提议（D6）、齐了自动生成填写值（D5）。

  CLAUDE.md「必须守住的约束」里的事实守卫保留。
- 活动工作台右栏（酒红色、衬线标题）和左侧浅蓝风格不一致，这次不改。
- 页面入口的分流 `app/lib/analytics/intent.ts` 的 `conversationRoute`：前端用十几条正则判断一句话该进智能问答还是进活动创建。这也是写死的流程，但牵涉活动创建入口，归入第二个子项目。

## 5. 不再使用的代码

新运行器验收通过后，单独一步删除（删之前和用户确认）：

- `agent/analysis-plan-run-turn.ts`；
- `agent/analytics-plugin/skills/ctf-marketing-advisor`、`analysis-review`，连同 `validateAnalyticsSkills`；
- `app/lib/analytics/plan/` 下只服务计划式流程的部分（`prompt.ts`、`validate.ts`、`refs.ts`、计划执行）；
- 旧运行器 `agent/analytics-run-turn.ts`；
- 对应测试。

新流程会用到的 `plan/bind.ts`（数字格式）、`plan/body-markdown.ts`（页面渲染）、`plan/scenario.ts`（情景测算）、`plan/answer.ts`（v4 校验和旧答案显示）保留。

## 6. 风险

- 数字错误（Q3 的代价）：没有代码核对后，模型自己算比例、合计时可能出错。验收时专门统计正文数字和工具结果对不上的句数。如果偏高，再和用户商量是否加回核对。
- 时长不可控（Q6 的代价）：没有上限，复杂问题可能比现在更久。靠 Skill 教「简单问题快答」，靠并发和缓存降低单次查询耗时，靠时间线让用户看到进展、随时停止。
- 独立实验已观察到公司网关下两次自动压缩并成功续接，但使用了仅用于测试的较低触发阈值。此结论不保证任意复杂任务细节无损，完整结果与分页重读仍必需；产品不沿用实验的 15% 阈值。
- 并发和持久缓存依赖可靠数据版本，本次实测仍未取得可靠源修订；独立 MySQL 事务不能靠标同一版本号获得共享快照。附件外层预算及大结果存储范围按实施计划单独列明，不与直接数据库问答的要求混淆。

## 7. 测试与验收

- 单测（`node:test`，不需要模型）：
  - 工具入参校验和错误返回；
  - `draw_chart` 按 resultId 出图；
  - 全量分页读取、不重查库、首发 session 单例与登记并发；
  - 正文切块和 chart 占位；
  - 人设清洗；
  - 连接池并发；
  - 缓存命中与按数据版本失效；
  - 假 `query` 按脚本调真实工具跑完一整轮（沿用 `tests/conversation.test.ts` 的模式）；
  - 活动时间线的 Skill 合并行。
- Skill 校验：新运行器启动前检查两份 Skill 的格式（插件名 analytics、frontmatter 只有 name 和 description、有 H1 标题），格式不对直接报错、不调模型。不套用活动 Skill 的六节加 `[S#]` 格式：理论出处是书和论文，不是仓库文件。
- 真实模型回归：用审计记录里最近 15 个问题跑新流程，按难度分组报告：
  - 耗时，简单问题目标 60 秒内；
  - 回答结构是否随问题变化；
  - 结论是否有数据支撑；
  - 数字和工具结果对不上的句数；
  - 加载了哪些 Skill、有没有不相关的。

  和现有流程的回答并排给用户看。
- 截图及闭环验收：两边时间线的运行中、完成、失败/停止状态；无图查数来源；长文图表保存后刷新；旧消息读取与下一轮范围纠正。SDK query 次数与真实模型 API 次数分开统计。
