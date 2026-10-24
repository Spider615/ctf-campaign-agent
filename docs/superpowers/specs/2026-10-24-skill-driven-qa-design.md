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

### 3.1 工具（MCP server `analytics`）

| 工具 | 入参 | 返回 | 实现 |
|---|---|---|---|
| `inspect_dataset` | 无 | 能力目录：维度（含 parent 层级）、指标、可选取值、日期范围、对照基线 | `session.capabilities` → `capabilityBrief` |
| `analyze` | `method`（aggregate / compare / decompose / scan / robustness）、`scope`、`metrics`、`by`、`reference`、`breakdown`、`check`、`alternative`、`purpose` | `resultId`，加上按分组列出的指标值（文字表格，带样本行数和口径） | `createAnalysisOperations(session).execute`，结果进 `createEvidenceRegistry` |
| `simulate_scenario` | `baselineResultId`、`adjustment`、`netVolumeChanges`、`reason` | `resultId` + 情景测算值 | `simulatePlanScenario` |
| `draw_chart` | `resultId`、`metric`、`kind`（bar / line / compare）、`by`、`top`、`title` | `chartId`，或说明这份结果画不了的原因 | 从 `plan/chart.ts` 的 `planChart` 改成按 `resultId` 取数 |
| `submit_answer` | `body`（Markdown，`[[chart:编号]]` 放图） | 已收到 | 不做数字核对；只检查 chartId 存在，不存在的占位删掉 |

- 工具入参错误（维度不存在、缺 reference 等）沿用现有中文错误，以 `isError` 返回给模型自己改，不算失败。
- `analyze` 返回给模型的分组不截成「偏离最大 8 组」；单次返回超过约 200 行时按第一个指标排序截断，并注明总组数和截断规则。
- `submit_answer` 只交一次。模型没调它就结束时，取最后一段文字当正文。

### 3.2 查库提速

- 连接池：`AnalysisDataSession` 从一条快照连接改成 4 条只读连接的池，`analyze` 并发调用时并行执行。现有数据是静态导入的（只有一份数据版本），不需要跨连接共享同一快照；数据版本号在开会话时取一次，所有结果都标这个版本。
- 结果缓存：按（数据版本，规范化后的请求）落盘，目录 `CTF_ANALYSIS_CACHE_DIR`，默认 `~/Library/Application Support/ctf-campaign-agent/analysis-cache`。同一查询再问时直接读盘。数据版本变了自动失效。

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
- 删除 `ctf-marketing-advisor`、`analysis-review`；`validateAnalyticsSkills` 和相关测试同步改。

### 3.4 回答组装

`PlanAnswerV4` 结构不变，页面 `PlanAnswerV4View` 照常渲染：

- `body`：正文按 `[[chart:编号]]` 切成 markdown 块和 chart 块。markdown 块 `refs: []`。不再生成 table 块，表格由模型直接写 Markdown 表格。
- `plan`：改为本轮调过的每次 `analyze` / `simulate_scenario`（id、方法、状态、`purpose`），页面的「分析步骤」照常显示。
- `evidence`：registry 里的全部结果，出处面板照常可查。
- `review.notes`：空数组。`assumptions`、`definitions`：从用到的结果的口径和局限汇总。
- 人设清洗：正文经过现有的模型 / 厂商名字清洗（`reply-stream.ts` 同一套规则）后再组装。

### 3.5 执行过程展示（两边统一）

- 活动创建：`message-view.tsx`、`conversation.tsx` 把 `ToolRunCard` 换成 `ToolTimeline`。去掉工具名标签、「确定性执行 / 系统补跑」徽标和「Skill/工具 xx ms」计时。`tool-run-card.tsx`、`tool-step.tsx` 不再使用后删除。
- Skill 加载（活动的 `load_campaign_skill`、问答的 `load_analytics_skill`）不作为时间线步骤，合并成时间线顶部一行小字「参考了：活动编排方法、1811 开单流程」，名称取 Skill 标题。
- 智能问答时间线：每次工具调用一步，标题写做了什么（「按大区对比七夕和平日的日均实收」，取 `purpose`），下一行写得到了什么（组数或画图结果）。
- 只改展示；活动创建的轨迹数据、落库格式不变，旧会话照常显示。

## 4. 不再使用的代码

新运行器验收通过后，单独一步删除（删之前和用户确认）：

- `agent/analysis-plan-run-turn.ts`；
- `app/lib/analytics/plan/` 下只服务计划式流程的部分（`prompt.ts`、`validate.ts`、`refs.ts`、计划执行）；
- 旧运行器 `agent/analytics-run-turn.ts`；
- 对应测试。

`chart.ts`、`scenario.ts`、`answer.ts` 里新流程用到的函数保留并改造。

## 5. 风险

- 数字错误（Q3 的代价）：没有代码核对后，模型自己算比例、合计时可能出错。验收时专门统计正文数字和工具结果对不上的句数。如果偏高，再和用户商量是否加回核对。
- 时长不可控（Q6 的代价）：没有上限，复杂问题可能比现在更久。靠 Skill 教「简单问题快答」，靠并发和缓存降低单次查询耗时，靠时间线让用户看到进展、随时停止。
- 一次 `query()` 的上下文会随查询结果增长。单次 `analyze` 返回有行数上限（3.1）；SDK 在长任务里能否自动压缩上下文、走公司网关时是否正常，实施时先用一个长问题实测。
- 3.2 的连接池前提是数据只有一份静态版本（推断，依据是导入流程和数据版本号）。实施时先确认；如果线上会在问答进行中更新数据，要改成各连接开同一时点的快照或在结果上校验版本。

## 6. 测试与验收

- 单测（`node:test`，不需要模型）：
  - 工具入参校验和错误返回；
  - `draw_chart` 按 resultId 出图；
  - 正文切块和 chart 占位；
  - 人设清洗；
  - 连接池并发；
  - 缓存命中与按数据版本失效；
  - 假 `query` 按脚本调真实工具跑完一整轮（沿用 `tests/conversation.test.ts` 的模式）；
  - 活动时间线的 Skill 合并行。
- Skill 校验：`tests/skills.test.ts` 同类检查覆盖新的两份 Skill（frontmatter 只有 name、description，`[S#]` 出处可定位）。
- 真实模型回归：用审计记录里最近 15 个问题跑新流程，按难度分组报告：
  - 耗时，简单问题目标 60 秒内；
  - 回答结构是否随问题变化；
  - 结论是否有数据支撑；
  - 数字和工具结果对不上的句数；
  - 加载了哪些 Skill、有没有不相关的。

  和现有流程的回答并排给用户看。
- 截图验收：活动创建和智能问答的时间线各截一张，和现有浅色界面比对。
