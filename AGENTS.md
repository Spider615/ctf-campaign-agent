# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 项目

这是周大福营销活动编排 Agent 的产品 demo。运营用对话提出活动想法，Agent 先形成 `campaign/v1` 活动 Brief，再根据事实动态选择品牌传播、成交优惠、会员触达、内容传播和门店准备等执行轨。ICS-1811 是成交优惠活动才会创建的可选叶子流程；一场 Campaign 当前只允许 0 或 1 张 1811 子单。

Harness 负责读取 Skill、选择工具和组织对话；TypeScript 负责事实证据、动态路由、状态聚合、1811 字段换算、传播守卫、上线门禁和落库。系统不连接周大福生产 1811/1815/1816、OA、CRM、投放、库存或门店系统，代码表包含演示编造项。代码注释、界面文案和错误信息都用中文，新增内容保持一致。

总体实现依据是 `docs/superpowers/specs/2026-09-17-campaign-orchestration-agent-design.md`。1811 子流程的确定性规则继续依据 `2026-09-16-ics1811-sop-agent-design.md`，其中追问轮次和复述确认已被 `2026-09-16-conversational-build-design.md` 取代；Harness、Skill、流式轨迹与耗时依据 `2026-09-17-harness-first-campaign-agent-design.md` 和相应实现。发生冲突时，父层、动态执行轨、上线门禁和传播方案以 2026-09-17 的编排设计为准。

## 命令

需要 Node.js >= 22.13。测试和 Agent 服务都靠 `--experimental-strip-types` 直接跑 `.ts`，旧版 Node 会报 `bad option: --experimental-strip-types`。

```bash
npm run install:ci               # 根目录依赖
npm run install:agent            # agent/ 的独立依赖（Claude Agent SDK、zod v4）
cp .dev.vars.example .dev.vars   # 填 DEEPSEEK_API_KEY；页面和 Agent 服务读同一个文件
npm run dev:all                  # 同时起 Agent 服务（8788）和页面（5173），一个退出另一个也停
npm run dev                      # 只起页面（vinext + Cloudflare Workers + 本地 D1）
npm run dev:agent                # 只起 Agent 服务；AGENT_DEBUG=1 打印每次工具调用的参数和结果

npm test                                                     # 全部单测（node:test），SDK 取消测试需先安装 agent/ 依赖
node --test --experimental-strip-types tests/conversation.test.ts                                   # 单个文件
node --test --experimental-strip-types --test-name-pattern="short reply" tests/conversation.test.ts  # 按测试名过滤
npx tsc --noEmit                 # 页面侧类型检查（tsconfig 排除了 agent/）
npx tsc -p agent/tsconfig.json   # Agent 服务类型检查
npm run lint
npm run build
```

- 端口被占：Agent 服务读 `.dev.vars` 里的 `AGENT_PORT`，同时把 `AGENT_SERVICE_URL` 改成对应地址；页面端口被占时 Vite 自动顺延，以终端打印的地址为准。
- 只改 `agent/plugin/skills/*/SKILL.md`，下一次 Agent 回合直接生效，不需要重启 `dev:agent`；Skill 格式或出处不符合约定时，下一回合会明确报错。
- 改 `agent/skills.ts`、`agent/server.ts`、`app/lib/agent/` 或 `app/lib/campaign/`，需要重启 `dev:agent`；页面侧仍会热更新。
- 应用没有总时限定时器；供应商或鉴权错误按真实上游错误反馈，持续挂起的回合可以主动停止。

本地 D1 首次使用前，先 `npm run build`，再应用迁移：

```bash
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_naive_ben_parker.sql
```

改表结构：改 `db/schema.ts` → `npm run db:generate` → 用上面的命令应用新 SQL → 同步改 `app/lib/server/session-store.ts`。运行时查询是手写 SQL，drizzle 只用来生成迁移。`draft_version.brief_json` 现在保存 `campaign/v1` 父文档；`ics_orders_json` 继续保存可选单一 1811 填写值快照，不需要为父层另加表。

部署时 Agent 服务单独运行在有 Node.js 和可写磁盘的环境；Workers 配 `AGENT_SERVICE_URL`，两边配相同的 `AGENT_SERVICE_TOKEN`。Agent 部署产物必须包含：

```text
agent/plugin/.claude-plugin/plugin.json
agent/plugin/skills/*/SKILL.md
```

运行时不需要打包 `docs/` 或 `references/`。发布前检查产物；有有效模型 key 时，可选跑不属于默认 CI 的 `npm run test:skills:live`：

```bash
test -f agent/plugin/.claude-plugin/plugin.json
test "$(find agent/plugin/skills -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')" -ge 6
```

## 架构

两个进程共用同一份 Campaign 和 1811 领域逻辑：

- **页面和数据（Workers）**：`app/api/sessions/**` → `app/lib/server/turns.ts`（`createSession` / `runTurn`）→ `SessionStore`。会话、消息、版本和落库都在这一侧，一个回合一次 `db.batch`。`app/lib/server/runtime.ts` 是唯一接 `cloudflare:workers` 的地方。
- **Agent 服务（Node）**：`agent/server.ts` 提供兼容用的 `POST /turn` JSON 和流式 `POST /turn/stream` NDJSON，模型走 DeepSeek 的 Anthropic 兼容接口（`AGENT_MODEL`，默认 `deepseek-flash`）。服务不存数据，只接收当前父文档与最近对话，返回本回合经工具修改的受控字段。
- **协议**：`app/lib/agent/protocol.ts` 定义 `AgentRequest` / `AgentResult`，分别携带整体 `campaignStage` 和可空的 `ics1811Phase`。Workers 和 Agent 都不设置应用层墙钟总时限，取消从浏览器经 Workers 传递到 Agent SDK；`maxTurns = 12` 仍是逻辑循环上限。

Agent 服务通过 Claude Agent SDK 运行一轮对话。SDK 内置工具只开放 `Skill`；活动读写由本地 MCP server 的 11 个确定性工具完成。`settingSources: []` 隔离个人和项目 Claude 配置，运行时只允许校验通过的 `ics1811` 本地插件 Skill。所有模型回合必须先加载 `campaign-orchestrator`；只有交易优惠或 1811 语境才叠加 `campaign-sop`，其他专项 Skill 按意图加载。

浏览器对话使用 NDJSON 接收正文增量、Skill/工具事件和最终 Snapshot。轨迹只保存公开动作、执行方、状态、数量摘要与真实耗时，不保存隐藏思维、系统提示词、完整工具入参、密钥或内部堆栈。Workers 用本机单调时钟汇总编排器耗时，Agent 服务汇总模型等待与 Skill/工具耗时，不能跨机器直接相减墙钟。消息使用实际 `createdAt` 显示时间，正文保持可选择、可复制。

### `runTurn` 主流程

1. `expectedSeq` 必须等于最新版本 seq，否则返回 409；D1 的 `(session_id, seq)` 唯一索引是第二道防线。
2. `createSession` 创建 `campaign/v1` 父文档。初始需求命中成交优惠才创建一张 1811 子单，否则 `ics1811 = null`；后续文本首次出现交易优惠时可动态补建。当前不支持删除子单或一场 Campaign 多张 1811。
3. 只有 `interpret` 和 `text` 调模型；`edit`、`dismiss`、`undo`、`rollback` 由代码直接处理。示例会话使用 T1 夹具，不调模型。
4. Agent 先用原话工具更新 Brief/1811 事实，再运行整体活动分析。用户整句只是点头且上一句有有效 1811 提议时，编排器会在调模型前确定性采纳。模型漏跑必要的整体或 1811 分析时，Workers 真实补跑并写入同一轨迹。
5. Agent 结果只合并 `brief`、`communication` 和可选子单，父 id 与其他状态不能被模型覆盖。Workers 随后重算 `CampaignWorkspace`、1811 推导/校验/缺项、传播方案和会话状态。
6. 1811 `ready` 且本轮产物有变化时，生成 `agent_fill_sheet`；它只表示“1811 填写值已准备”，不表示整场活动已审核或上线。
7. 有 Campaign diff 才写新版本并追加 `agent_change`；真实工具轨迹作为 `agent_tool_trace` 落库。Agent 失败时写带 retry 的 `agent_error`，用户输入保留，未完成修改不落版本。

会话状态使用 `briefing | preparing | needs_confirmation | ics_ready`；`collecting | readback | confirmed` 只为旧会话显示兼容。整体阶段、子流程阶段和可上线状态不能混用。

## Campaign 父层 `app/lib/campaign/`

- `types.ts`：`CampaignDraft` 是唯一持久化业务文档，schema 为 `campaign/v1`；包含有原话证据的 `CampaignBrief`、`Ics1811Draft | null` 和 `CommunicationCreative | null`。
- `brief.ts`：`applyCampaignBriefWrites` 要求每个 quote 都是用户本轮原话的子串；文本值直接使用 quote，渠道只从同一 quote 解析为有限枚举。
- `workspace.ts`：每轮从事实重算路由、Brief 完整度、执行轨、上线门禁和 artifact 状态，不额外落库。路由可同时包含 `brand_launch`、`transaction_offer`、`member_crm`；执行视图还可出现策略、传播和门店准备轨。
- `communication.ts`：传播方案的目标、受众、主题、渠道和交易硬事实都来自父/子事实层。模型只提供创意概念、已确认渠道的文案和视觉方向；代码阻止未确认渠道、数字、权益、人群和未经法务确认的标语。最终 `CommunicationPlan` 最高为 `needs_review`。
- `request-validation.ts`：存储边界逐版本校验。`campaign/v1` 直接读取，旧 `ics1811/v1` 无损包装为父文档；更早的“营销方案 + 拆单”结构仍返回 410。

`Snapshot.latest.communication` 是传播方案的权威视图。`Snapshot.latest.promo` 和 1811 内的 leaf promo 仅用于旧数据只读兼容；新代码不能把它重新当成父层传播产物。

## 1811 子流程 `app/lib/campaign/ics1811/`

- `types.ts`：`Ics1811Draft.facts` 保存每项值、用户原话 quote 和来源；`FillModel` 每轮重算，不接受写入。
- `facts.ts`：`applyFactWrites` 校验 quote 是本轮原话子串，数值由 `phrases.ts` 从 quote 重新换算，不采信模型给的 value。短回答只在上一句登记过对应问题时解释；带提议的题不走普通是/否兜底。
- `phrases.ts`：中文口语转日期、折扣、满减、克减、让扣点、回款率、提成等确定性值；“不知道”“待定”不记。点头识别区分纯同意与求证。
- `offer-spec.ts`：按既定优先级识别优惠玩法和支持级别。
- `codebook.ts`：demo 唯一代码表，每个取值标来源；只有这里可以包含明确标注的演示编造项。
- `derive.ts`、`checks.ts`、`questions.ts`：分别负责填写值推导、V-A/V-D/V-R 校验和确定性缺项。缺项或 blocker 时不能生成填写值。
- `proposals.ts`：只允许 `PROPOSABLE` 中的题被提议；优惠力度、标语和法务确认不能提议。原值变化后旧提议失效。
- `readback.ts`、`fill-sheet.ts`：生成 1811 摘要、逐项填写值和自查清单；不是整场活动上线结论。
- `messages.ts`：对话状态从消息记录推出，不另存；旧复述、卡片、确认消息只做读取兼容。
- `examples.ts`：验收用例 T1–T10，测试和示例会话共用。

## Agent 工具 `app/lib/agent/`

`tools.ts` 实现 11 个工具，工具只修改单轮 `AgentState` 或读取确定性推导，不依赖 SDK：

- 父层：`update_campaign_brief`、`analyze_campaign_plan`
- 1811：`extract_campaign_facts`、`accept_campaign_proposals`、`lookup_ics_reference`、`analyze_campaign_state`、`ask_campaign_questions`、`draft_campaign_copy`、`generate_ics1811_sheet`
- 跨产物：`draft_promo_copy`、`undo_campaign_change`

所有业务工具在 `campaign-orchestrator` 加载前都被拒绝；1811 专属工具还要求 `campaign-sop`。`draft_promo_copy` 另要求 `promo-copy-guide`，只写创意层，不写活动硬事实或未经确认的标语。`finishAgentTurn` 会清理“提升 X%”等无依据效果预估并限制回复长度。

改工具要同步修改 `tools.ts`（名称、处理与元信息）、`agent/run-turn.ts`（zod 参数和 MCP 注册）、`prompt.ts`（工具合同）以及相应测试。新增 Campaign Brief key 要同步类型、空值、写入守卫、协议校验和工作台标签；新增 1811 fact key 要同步 `types.ts`、`facts.ts`、`messages.ts`、`prompt.ts`，需要追问时再改 `questions.ts`。

## 维护运行时 Skills

- 业务 Skill 位于 `agent/plugin/skills/<name>/SKILL.md`，只整理仓库已有、能在 `出处` 中定位的规则。
- 每份 Skill 只允许 `name`、`description` 两个 frontmatter 字段；正文依次包含 `适用场景`、`回答原则`、`业务知识`、`不能做什么`、`冲突处理`、`出处`，前五节每条规则都引用 `[S#]`。
- `BASELINE_SKILL_NAMES` 是受管 Skill 的精确名单，不表示每份都在每回合加载。`campaign-orchestrator` 每回合必载；`campaign-sop` 仅交易/1811 条件加载；`offer-entry-guide`、`field-explainer`、`settlement-guide`、`promo-copy-guide` 按意图加载。改名或增删时同步常量和测试。
- Skill 只放有出处的解释、编排和写作指导。字段映射、默认值、代码表、事实守卫、路由、缺项、校验、传播守卫和落库必须留在 TypeScript。
- 修改后运行 `node --test --experimental-strip-types tests/skills.test.ts`、`npx tsc --noEmit`、`npx tsc -p agent/tsconfig.json`，再通过 Git diff 和代码评审合入。

`tests/skills.test.ts` 会调用 `validateSkillSources`，确认每个 `[S#]` 引用都能定位到仓库已有出处。

## 界面 `app/components/`

- 对话仍是主入口；正文真实流式输出。`chat/tool-run-card.tsx` 与 `chat/tool-step.tsx` 展示实时和已落库的真实 Skill/工具轨迹与耗时，完成后默认折叠。
- 每条消息显示实际时间；消息与工作台正文必须保留 `select-text`/可复制行为，不要用拖拽层或全局样式阻断文字选择。
- `draft/draft-panel.tsx` 是“活动工作台”，顶层固定五个页签：`Brief`、`执行`、`上线检查`、`传播方案`、`1811`。桌面和移动端复用同一组件。
- Brief 显示事实与出处；执行页展示动态轨、状态、依据和下一动作；上线检查只聚合 blocker 与人工确认项，不伪造外部系统结果；传播页显示完整 `CommunicationPlan`；1811 页复用填写值、修改、待确认、校验和版本内容，不适用时明确说明。
- 传播入口在 Brief 齐备后持续可见：未生成时“生成传播方案”，已有后“查看/继续完善”。生成走正常 text turn，轨迹和正文照常流式。
- 页面通过 `app/lib/webmcp.ts` 暴露 WebMCP 工具，在 `app-shell.tsx` 注册；修改仍走受控 `edit` 回合。

## 必须守住的约束

- **Campaign 父层优先**：会话不能再等同于 1811。没有交易优惠时 `ics1811` 必须保持 `null`；新增交易信号可动态创建唯一子单，但不得自行扩展成多单拆分。
- **Brief 有原话证据**：目标、受众、主题、渠道、时机、范围等只能来自用户本轮原话或将来显式设计的确认动作。模型不能把自己的总结反写成用户事实。
- **1811 人定字段不能默认**：日期、门店、优惠、货类、让扣点、回款率、提成口径、结算说明函、标语只来自用户原话、面板修改，或用户明确同意的允许提议。缺项只来自 `questions.ts`；缺项或阻断未清时不生成填写值。
- **数值只认原话**：不要为模型方便而放宽 `facts.ts` / `phrases.ts` 守卫。新口语在解析器补换算并加测试；“不知道”不等于“没有”。
- **传播不补硬事实**：渠道、日期、门店、优惠、数字、目标人群、权益和标语必须通过确定性事实/创意守卫；没有真实审核接口时，状态不能高于“待审核”。
- **不伪造上线**：1811 填写值就绪不等于活动通过审批、备货、投放或上线。外部准备没有证据时只能标 `needs_confirmation`。
- **代码表边界**：只有 `codebook.ts` 可以放明确标注来源的演示编造取值；录入和正式执行以真实 ICS 为准。
- **模块边界**：`agent/server.ts` 和 `npm test` 用 Node strip-types 直接加载 `app/lib/{campaign,agent,server}`，因此这些共享模块（`runtime.ts` 除外）不得 import `cloudflare:workers`、`db/*` 或 npm 包；相对 import 写全 `.ts`；不用 enum、namespace、构造函数参数属性。前端代码可使用 `@/` 和无扩展名 import。
- **回合测试不依赖模型**：用内存 store 与按脚本调用真实工具的假 `runAgent` 测流程；中文换算继续在 `tests/ics1811-guard.test.ts` 补用例，父层/传播行为分别在 Campaign 和 promo 测试中覆盖。

## 其他

- `components/ui/` 是原样引入的 shadcn 组件，业务界面在 `app/components/`。
- `/codes` 展示 `codebook.ts`；`/open-questions` 展示既有待确认资料。`app/lib/reference/code-tables.ts` 只用于测试核对，不是运行时来源。
- 旧 `ics1811/v1` 会话可逐版本包装成 `campaign/v1`；更早的“营销方案 + 拆单”结构返回 410。不要把两者统称为不可读旧结构。
- `.openai/hosting.json`、`build/sites-vite-plugin.ts` 和 `scripts/` 的 `managed-linux` 分支来自 Sites/vinext 脚手架；本地没有 `.sites-runtime/` 时走 `portable` 分支。
- `docs/superpowers/specs/` 中 2026-09-15 的两份设计描述已淘汰的旧架构，仅供追溯；不要据此恢复父层拆单或固定串行流程。
