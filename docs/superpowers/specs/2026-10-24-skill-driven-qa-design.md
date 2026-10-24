# 智能问答改为 Skill 驱动 设计

日期：2026-10-24。取代智能问答现有的计划式运行器（`agent/analysis-plan-run-turn.ts` + `app/lib/analytics/plan/`）。活动创建（小福搭 1811）的流程这次不动，只改它的执行过程展示。

## 1. 问题

本机最近 15 次智能问答的审计记录（`~/Library/Application Support/ctf-campaign-agent/analysis-runs/*.jsonl`）：

- 慢：复杂问题 170–244 秒。时间分两块：
  - 模型 6 次串行调用约 60–150 秒。其中复核计划 15–134 秒、补充计划 14–82 秒（多数交空），前三步开思考。
  - 查库 30–80 秒。`plan/execute.ts` 逐节点串行，共用一条快照连接。单条分组 SQL 实测 0.5–2.2 秒，慢在排队，不在单条。
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

一次问答 = 一次 Agent SDK `query()`，替代现在的六次串行调用：

```text
页面 POST /api/analytics/history（v4 头，不变）
  → Workers 流式转发（不变）
  → Agent http-handler → 新运行器 agent/analytics-skill-run-turn.ts
      query({ tools: ["Skill"], plugins: [analytics-plugin], mcpServers: { analytics }, 不设 maxTurns })
      模型：按 description 自选 Skill → 调分析工具（可并发）→ 画图 → submit_answer
  → 组装 PlanAnswerV4 → 流式返回
```

`createConversationRunner`（活动里的文件问答）现在把 `runPlanAnalyticsTurn` 作为 `runAnalytics` 注入，改为注入新运行器，接口签名保持 `PlanAnalyticsRunner` 不变。

连续对话：请求里的 `history`（近期问答）和 `context`（用户前面说过、仍然有效的范围和口径）原样写进这一轮的用户提示词，由模型判断追问指的是什么、哪些范围沿用。代码不再替模型拼「沿用上一轮范围」的规则。

不走固定回复：删掉问答入口前的两条正则捷径，所有问题都进模型，包括打招呼、致谢、问「你是谁」。
- `quickAnalyticsReply`：寒暄、致谢、能力介绍直接返回写死的回复；
- `quickMonthlySalesQuery`：「X 年 X 月销售额是多少」走单独的快速查询。

一并改掉的地方：
- 新运行器不调用这两个函数；
- `agent/http-handler.ts:129`：没连数据库时给寒暄放行。改为没连数据库就统一报「历史数据库尚未启用」。

保留不动的（实施前核对过）：
- `app/lib/analytics/explain.ts:87`：这是读旧会话时校验已存的寒暄回答，删了旧消息会显示不出来，不产生新的固定回复；
- `app/lib/analytics/intent.ts:18`：只决定一句话分到智能问答还是活动创建，不产生回复，属于第 4 节的第二个子项目；
- 两个函数本身留给旧运行器，第 5 节清理时一起删。

简单问候怎么回、要不要查数，写进 `ctf-qa`。代价是问候也要等一次模型调用（几秒）。

洞察联动：从洞察图跳来的 `focusContext` 照常写进提示词；回答的 `evidence` 仍带 objects 和 frames，`locateAnswer` 的「在洞察图上看」不受影响。

### 3.1 工具（MCP server `analytics`）

| 工具 | 入参 | 返回 | 实现 |
|---|---|---|---|
| `inspect_dataset` | 无 | 能力目录：维度（含 parent 层级）、指标、可选取值、日期范围、对照基线 | `session.capabilities` → `capabilityBrief` |
| `analyze` | `method`（aggregate / compare / decompose / scan / robustness）、`scope`、`metrics`、`by`、`reference`、`breakdown`、`check`、`alternative`、`purpose` | `resultId`，加上按分组列出的指标值（文字表格，带样本行数和口径） | `createAnalysisOperations(session).execute`，结果进 `createEvidenceRegistry` |
| `simulate_scenario` | `baselineResultId`、`adjustment`、`netVolumeChanges`、`reason` | `resultId` + 情景测算值 | `simulatePlanScenario` |
| `draw_chart` | `resultId`、`metric`、`kind`（bar / line）、`by`、`top`、`title` | `chartId`，或说明这份结果画不了的原因 | 新写 `app/lib/analytics/qa/chart.ts`，按 `resultId` 取数；对比结果自动画成目标、参照两组柱 |
| `submit_answer` | `body`（Markdown，`[[chart:编号]]` 放图） | 已收到 | 不做数字核对；只检查 chartId 存在，不存在的占位删掉 |

- 工具入参错误（维度不存在、缺 reference 等）沿用现有中文错误，以 `isError` 返回给模型自己改，不算失败。
- `analyze` 返回给模型的分组不截成「偏离最大 8 组」；单次返回超过 300 行时只列前 300 行，注明总行数，提示加筛选或换分组。
- `submit_answer` 可以交多次，以最后一次为准。模型没调它就结束时，取最后一段文字当正文。

### 3.2 查库提速

- 连接池：`AnalysisDataSession` 从一条快照连接改成 4 条只读连接的池，`analyze` 并发调用时并行执行。现有数据是静态导入的（只有一份数据版本），不需要跨连接共享同一快照；数据版本号在开会话时取一次，所有结果都标这个版本。
- 结果缓存：按（数据版本，查询）落盘。MySQL 会话的 `datasetVersion` 每次打开都是随机值，不能当缓存键；会话新增 `dataKey`（库名.表名:行数:起止日期，和现有维度取值缓存同一口径）作稳定版本。缓存 `aggregate`、`orderDistribution`、`scenario` 三类查询，目录 `CTF_ANALYSIS_CACHE_DIR`，默认 `~/Library/Application Support/ctf-campaign-agent/analysis-cache`。同一查询再问时直接读盘。数据版本变了自动失效。

### 3.3 Skill（`agent/analytics-plugin/skills/`）

运行时只加载经过校验的这个插件；模型按 description 自己决定加载哪几个，代码不强制。

- `ctf-qa`（新，主 Skill）：怎么理解问题、先看数据再决定查什么、边查边追问、什么时候该停、按问题本身组织回答（不给固定板块）、怎么配图。简单问题一两次查询就答。并入 `ctf-marketing-advisor` 里仍然成立的业务知识，比如：
  - 每克金额只在同货类、同材料内比；
  - 会员标识不等于新老会员或复购；
  - 天数不同的两段比日均；
  - 相关不写成因果；
  - 单店个案放后面。
- `marketing-theory`（新）：调研出的 10 条分析思路，每条写清什么问题用、用哪些字段怎么算、数据不够时怎么说：
  - 结论先行；
  - 指标拆解树；
  - 促销增量分解；
  - 同店同期与对照；
  - 毛利口径盈亏平衡；
  - 黄金行业结构；
  - 门槛与凑单；
  - 折扣表述；
  - 门店与交易细分；
  - 参考价格侵蚀。

  另附「现有数据做不了」清单：RFM、CLV、复购、客流转化、真实 ROI、剥离金价。出处必须逐条核实后再写，调研时搜索工具不可用，现有出处凭记忆。
- 从原正文提示词（`plan/prompt.ts` 的 `answerPrompt`）沿用的回答要求，作为思路写进 `ctf-qa`，不写成固定板块：第一句直接回答问题；要方案时先给方案、缺口放最后；缺维度时先说答不了的部分和原因，再给能确定的事实，再说补什么数据；用户纠正过的口径以最新为准。
- 旧的 `ctf-marketing-advisor`、`analysis-review` 还被旧运行器和它的测试读取，第 5 节清理时再删。新运行器用 SDK 的 `skills` 选项只开放 `ctf-qa`、`marketing-theory` 两份，模型看不到旧的。

### 3.4 回答组装

`PlanAnswerV4` 结构不变，页面 `PlanAnswerV4View` 照常渲染：

- `body`：正文按 `[[chart:编号]]` 切成 markdown 块和 chart 块，markdown 块 `refs: []`。模型写的 Markdown 表格转成 table 块，用页面现有的表格样式显示（聊天 Markdown 渲染器不支持表格）。`validatePlanAnswerV4` 的上限放宽：正文 20000 字、图 12 张、表 50 张、每表 200 行。
- `plan`：改为本轮调过的每次 `analyze` / `simulate_scenario`（id、方法、状态、`purpose`），页面的「分析步骤」照常显示。
- `evidence`：全部范围和方法、图上用到的事实（连同推出它们的父事实），以及每个范围每个维度留一个对象（「在洞察图上看」只需要知道用到了哪些维度）。不放全部事实，免得一次回答带几千条事实撑爆会话存储。
- `review.notes`：空数组。`assumptions`、`definitions`：从用到的结果的口径和局限汇总。
- 人设清洗：正文经过 `reply-stream.ts` 里删模型 / 厂商名字的那一段（`withoutUnderlyingModel`）再组装。不用 `sanitizeAgentReply`：它会截到 800 字，还会删「提升 X%」，问答里真实的涨幅数据要保留。

### 3.5 执行过程展示（两边统一）

- 活动创建：`message-view.tsx`、`conversation.tsx` 把 `ToolRunCard` 换成 `ToolTimeline`。去掉工具名标签、「确定性执行 / 系统补跑」徽标和「Skill/工具 xx ms」计时。`tool-run-card.tsx`、`tool-step.tsx` 不再使用后删除。
- Skill 加载（活动的 `load_campaign_skill`、问答的 `load_analytics_skill`）不作为时间线步骤，合并成时间线顶部一行小字「参考了：活动编排方法、1811 开单流程」，名称取 Skill 标题。
- 智能问答时间线：每次工具调用一步，标题写做了什么（「按大区对比七夕和平日的日均实收」，取 `purpose`），下一行写得到了什么（组数或画图结果）。
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
- 一次 `query()` 的上下文会随查询结果增长。单次 `analyze` 返回有行数上限（3.1）；SDK 在长任务里能否自动压缩上下文、走公司网关时是否正常，实施时先用一个长问题实测。
- 3.2 的连接池前提是数据只有一份静态版本（推断，依据是导入流程和数据版本号）。实施时先确认；如果线上会在问答进行中更新数据，要改成各连接开同一时点的快照或在结果上校验版本。

## 7. 测试与验收

- 单测（`node:test`，不需要模型）：
  - 工具入参校验和错误返回；
  - `draw_chart` 按 resultId 出图；
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
- 截图验收：活动创建和智能问答的时间线各截一张，和现有浅色界面比对。
