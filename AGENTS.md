# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 项目

周大福「优惠开单活动」创建助手的产品 demo：运营用对话描述一个优惠活动，Agent 按《优惠开单活动创建 SOP》§9 追问人定字段（最多两轮），白话复述、确认后输出 ICS-1811「优惠开单活动新增」页面的逐项填写值。不连接任何周大福生产系统（1811/1815/1816），代码表是演示编造的。代码注释、界面文案、错误信息都用中文，新增内容保持一致。

实现依据是 `docs/superpowers/specs/2026-09-16-ics1811-sop-agent-design.md`（下称设计文档）；文中「§」指 SOP 章节，「第 X 节」指设计文档章节。

## 命令

需要 Node.js >= 22.13。测试和 Agent 服务都靠 `--experimental-strip-types` 直接跑 `.ts`，旧版 Node 会报 `bad option: --experimental-strip-types`。

```bash
npm run install:ci               # 根目录依赖
npm run install:agent            # agent/ 的独立依赖（Claude Agent SDK、zod v4）
cp .dev.vars.example .dev.vars   # 填 DEEPSEEK_API_KEY；页面和 Agent 服务读同一个文件
npm run dev:all                  # 同时起 Agent 服务（8788）和页面（5173），一个退出另一个也停
npm run dev                      # 只起页面（vinext + Cloudflare Workers + 本地 D1）
npm run dev:agent                # 只起 Agent 服务；AGENT_DEBUG=1 打印每次工具调用的参数和结果

npm test                                                     # 全部单测（node:test），不装依赖也能跑
node --test --experimental-strip-types tests/conversation.test.ts                                   # 单个文件
node --test --experimental-strip-types --test-name-pattern="short reply" tests/conversation.test.ts  # 按测试名过滤
npx tsc --noEmit                 # 页面侧类型检查（tsconfig 排除了 agent/）
npx tsc -p agent/tsconfig.json   # Agent 服务类型检查
npm run lint
npm run build
```

- 端口被占：Agent 服务读 `.dev.vars` 里的 `AGENT_PORT`，同时把 `AGENT_SERVICE_URL` 改成对应地址；页面端口被占时 Vite 自动顺延，以终端打印的地址为准。
- 只改 `agent/plugin/skills/*/SKILL.md`，下一次 Agent 回合会直接生效，不需要重启 `dev:agent`；Skill 格式不符合约定时，下一回合会明确报错，不会静默关闭业务知识。
- 改 `agent/skills.ts`、`agent/server.ts`、`app/lib/agent/` 或 `app/lib/campaign/ics1811/`，仍要重启 `dev:agent`（页面侧会热更新）。
- 没有有效 key 时 Agent 不会立刻报认证错误，而是等满单轮超时（120s）才报「Agent 超时了」。

本地 D1 首次使用前，先 `npm run build`，再应用迁移：

```bash
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_naive_ben_parker.sql
```

改表结构：改 `db/schema.ts` → `npm run db:generate` → 用上面的命令应用新 SQL → 同步改 `app/lib/server/session-store.ts`。运行时查询是手写 SQL，drizzle 只用来生成迁移。现在 `draft_version.brief_json` 存事实层草稿，`ics_orders_json` 存填写值快照。

部署时 Agent 服务单独跑在有 Node.js 和可写磁盘的环境；Workers 配 `AGENT_SERVICE_URL`，两边配同一个 `AGENT_SERVICE_TOKEN`。Agent 部署产物必须包含：

```text
agent/plugin/.claude-plugin/plugin.json
agent/plugin/skills/*/SKILL.md
```

运行时不需要打包 `docs/` 或 `references/`。发布前检查产物；有有效模型 key 时，还可选跑一次不属于默认 CI 的 `npm run test:skills:live`：

```bash
test -f agent/plugin/.claude-plugin/plugin.json
test "$(find agent/plugin/skills -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')" -ge 4
```

## 架构

两个进程共用一份领域逻辑：

- **页面和数据（Workers）**：`app/api/sessions/**` → `app/lib/server/turns.ts`（`createSession` / `runTurn`）→ `SessionStore`（`session-store.ts`，D1 实现和测试用的内存实现）。版本、消息、落库都在这一侧，一个回合一次 `db.batch`。`app/lib/server/runtime.ts` 是唯一接 `cloudflare:workers` 的地方，负责组装 `TurnDeps`。
- **Agent 服务（Node）**：`agent/server.ts` 提供兼容用的 `POST /turn` JSON 和流式 `POST /turn/stream` NDJSON，模型走 DeepSeek 的 Anthropic 兼容接口（`AGENT_MODEL`，默认 `deepseek-flash`）。服务不存数据：收当前草稿，回改好的草稿。
- 两边的协议是 `app/lib/agent/protocol.ts`（`AgentRequest` / `AgentResult`）。Workers 侧请求超时 150s，要大于 Agent 侧单轮超时 120s。

Agent 服务通过 Claude Agent SDK 运行一轮对话。SDK 内置工具只开放 `Skill`；活动读写由本地 MCP server 的 9 个确定性工具完成。`settingSources: []` 隔离个人和项目 Claude 配置，运行时只允许经过校验的 `ics1811` 本地插件 Skill。Skill 负责解释、录入指导和文案规范；事实、填写值、缺项、校验和落库仍以 TypeScript 工具结果为准。

`runTurn` 的流程：

1. `expectedSeq` 必须等于最新版本的 seq，否则 409，客户端会重新拉快照。D1 上 `(session_id, seq)` 的唯一索引是第二道防线。
2. 只有 `interpret`（新建会话后由对话页自动发起）和 `text` 调模型。`card`（选项提交）、`edit`（面板、WebMCP）、`confirm`、`dismiss`、`undo`、`rollback` 由代码直接处理。示例会话（`entryMode: "example"`）用 T1 夹具，不调模型。
3. 模型回来后代码重算 `deriveFill` → `checkDraft` → `planNext`，决定出追问、出复述，还是（确认后）出填写值。追问内容、轮次、复述、能不能确认都不由模型决定。追问开着时用户打字：问题都还在这一轮里就不出新追问；回答引出了新追问就出下一轮。
4. 有 diff 才写新版本，并追加 `agent_change`；Agent 失败时写一条带 retry 的 `agent_error`，用户输入不丢。

对话状态（第几轮、追问是否还开着、最新复述、是否已确认）全部由 `ics1811/messages.ts` 的 `flowOf` 从消息记录推出，不另存，撤销和恢复不会重置轮次。

### 领域层 `app/lib/campaign/ics1811/`（纯函数）

- `types.ts`：事实层 `Ics1811Draft`（`facts` 每项带用户原话 `quote`）是唯一存储的业务数据；`FillModel` 每轮从事实层重算，不接受写入。
- `facts.ts` 的 `applyFactWrites`：模型写入的守卫。quote 必须是用户这一轮原话的子串；数值由 `phrases.ts` 从 quote 重新换算，不用模型给的 value。`RULES` 按 FactKey 穷举。「可以」「没有」这类短回答只在对应问题正在问时（`openQuestions`）才算。
- `phrases.ts`：中文说法 → 1811 取值（日期、折扣、满减、每克减、让扣点回款率、提成口径等），`digitize` 按上下文把中文数字转成阿拉伯数字；「不知道」「待定」一律不记。
- `offer-spec.ts`：`detectPattern` 判定玩法（顺序有意义：特殊活动 → 不支持的类型 → 通用玩法），`OFFER_TYPES` 是明细优惠类型规格（支持级别 A/B/C/D）。
- `codebook.ts`：demo 唯一的代码表，每个取值标来源（截图 / 指引文字 / 导入模板 / 编造）。
- `derive.ts` 的 `deriveFill`：事实层 → 活动信息、明细、活动分组、建完后待办、提示；`outOfScope` 只给抽奖这类明确不带成交优惠的活动。
- `questions.ts`：问题目录（§9(二)，`QUESTION_TITLE`、对话里的回答示例 `QUESTION_EXAMPLE`）、`gapsOf`、`planNext`（`MAX_ROUNDS = 2`）。
- `checks.ts`：V-A / V-D / V-R 校验，分 blocker / warning。
- `readback.ts`、`fill-sheet.ts`：白话复述；按 1811 页面顺序的填写值和自查清单。
- `card.ts`：选项和面板提交的解析。`messages.ts`：消息结构 `StoredMessage`（v2）、`flowOf`、改动摘要。
- `examples.ts`：验收用例 T1–T10 夹具，测试和示例会话共用。

### Agent 工具 `app/lib/agent/`

`tools.ts` 实现 9 个工具：`extract_campaign_facts` / `accept_campaign_proposals` / `lookup_ics_reference` / `analyze_campaign_state` / `ask_campaign_questions` / `draft_campaign_copy` / `draft_promo_copy` / `generate_ics1811_sheet` / `undo_campaign_change`。工具只改这一轮的 `AgentState` 或读取确定性推导结果，不依赖 SDK。

- `extract_campaign_facts` 走 `applyFactWrites`，被拒的以 `dropped` 返回给模型。
- `ask_campaign_questions` 登记这句回复要问的题号和提议；`accept_campaign_proposals` 只按用户明确同意的提议记值。
- `lookup_ics_reference` 只查 demo 代码表；`analyze_campaign_state` 复用确定性推导、缺项和校验，两者都不写草稿。
- `draft_campaign_copy`：名称不超过 13 个字，名称和内容只允许汉字、字母、数字、小数点和百分号，数字必须来自事实层。
- `draft_promo_copy` 只在成功加载 `ics1811:promo-copy-guide` 后起草创意文案，不写活动事实或标语。
- `generate_ics1811_sheet` 齐了才成功；最终填写值仍由 Workers 重新生成。
- `finishAgentTurn` 删掉「提升 X%」这类预估，超长回复在句末截断。

改工具要同时改三处：`tools.ts`（`AGENT_TOOL_NAMES`、`runAgentTool`）、`agent/run-turn.ts`（zod 入参和 `tool(...)` 注册）、`prompt.ts`（系统提示词里的工具说明）。

新增事实 key：`types.ts` 的 `Facts`、`facts.ts` 的 `emptyFacts` 和 `RULES`、`messages.ts` 的 `FACT_LABEL`、`prompt.ts` 的 `FACT_GUIDE`（后三个是按 FactKey 穷举的 Record，漏了类型检查不过）；`factText` 有默认分支，需要友好展示时补 case；需要追问的还要改 `questions.ts`。

## 维护运行时 Skills

- 业务 Skill 位于 `agent/plugin/skills/<name>/SKILL.md`，只整理仓库已有、能在 `出处` 中定位的规则。
- 每份 Skill 只允许 `name`、`description` 两个 frontmatter 字段，正文依次包含 `适用场景`、`回答原则`、`业务知识`、`不能做什么`、`冲突处理`、`出处`。前五节每条规则都要引用 `[S#]`。
- 四个基线 Skill 不能直接删除或改名；需要调整时同步修改 `BASELINE_SKILL_NAMES` 和测试。新增且校验通过的 Skill 会自动进入精确白名单。
- Skill 只放解释和写作指导。字段映射、默认值、代码表、事实守卫、缺项、校验和落库规则继续放在 TypeScript 中。
- 修改后运行 `node --test --experimental-strip-types tests/skills.test.ts`、`npx tsc --noEmit` 和 `npx tsc -p agent/tsconfig.json`，再通过 Git diff 和代码评审合入。

`tests/skills.test.ts` 会调用 `validateSkillSources`，确认每个 `[S#]` 引用都能定位到仓库内的现有出处。

### 界面 `app/components/`

- 以对话为主：`chat/clarify-card.tsx` 把这一轮的问题写在对话里，附一句能照抄的回答示例；`chat/question-controls.tsx` 的选项默认收起，只是快捷方式。
- `chat/readback-card.tsx` 是复述和确认按钮；`draft/draft-panel.tsx` 是右侧填写值面板（填写值、修改、待确认、校验、版本）。
- 页面通过 `app/lib/webmcp.ts` 暴露 WebMCP 工具（在 `app-shell.tsx` 注册），只能改名称、内容和日期，走 `edit` 回合，`origin: "tool"`。

## 必须守住的约束

- **人定字段不能默认**：日期、门店、优惠、货类、让扣点回款率、提成口径、结算说明函、标语只来自用户回答（打字或选项）。问题只来自 `questions.ts` 的目录，每轮把当时的全部缺项一起问，最多两轮；两轮后仍缺就在复述里列出，不能确认。
- **数值只认原话**：quote 不在用户这一轮的话里就丢弃。不要为了让模型更顺而放宽 `facts.ts` / `phrases.ts` 的守卫；新说法在 `phrases.ts` 补换算并加用例。「不知道」不等于「没有」，让扣点不能因此填 0。
- **代码表只在 `codebook.ts` 编造**，并标明来源；标语只能是用户给的、法务确认过的原文，模型不写。
- **模块边界**：`agent/server.ts` 和 `npm test` 都用 Node strip-types 直接加载 `app/lib/{campaign,agent,server}`，所以这些模块（`runtime.ts` 除外）必须：
  - 不 import `cloudflare:workers`、`db/*` 或任何 npm 包（Agent 服务只装 `agent/` 的依赖，zod 版本也和根目录不同）；
  - 相对 import 写全 `.ts` 扩展名，不用 `@/` 别名；
  - 不用 enum、namespace、构造函数参数属性。
  - 前端代码（`app/components/**`、`app/lib/client/`、`app/**/page.tsx`）不受限，照常用 `@/` 和无扩展名 import。
- **测回合流程不需要模型**：`tests/conversation.test.ts` 用内存 store 加一个按脚本调用真实工具的假 `runAgent`，新行为照这个模式补测试；中文说法的换算在 `tests/ics1811-guard.test.ts` 补用例。

## 其他

- `components/ui/` 是原样引入的 shadcn 组件（eslint 对它放宽了规则），业务界面在 `app/components/`。
- `/codes` 展示 `codebook.ts`；`/open-questions` 展示设计文档第 13 节（数据在 `app/lib/reference/open-questions.ts`）。`app/lib/reference/code-tables.ts` 是早期从 PPT 截图抽取的码表，页面不再用，只用于 `tests/ics1811-codebook.test.ts` 核对 codebook 的真实取值，`tests/reference-data.test.ts` 核对它和 `references/*.json` 一致。
- 读到旧结构（不是 `ics1811/v1`）的会话返回 410，界面提示新建。
- `.openai/hosting.json`、`build/sites-vite-plugin.ts` 和 `scripts/` 里的 `managed-linux` 分支来自 Sites/vinext 脚手架；本地没有 `.sites-runtime/` 时走 `portable` 分支。
- `docs/superpowers/specs/` 里 2026-09-15 的两份设计文档描述的是旧的「营销方案 + 拆单」架构，已被设计文档取代，仅供追溯。
