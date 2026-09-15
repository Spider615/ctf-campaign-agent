# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

周大福营销活动生成 Agent 的产品 demo：运营用一句话描述活动，Agent 通过对话和补充卡片产出营销方案和 N 条 ICS 开单草稿。不连接任何周大福生产系统（1811/1815/1816）。代码注释、界面文案、错误信息都用中文，新增内容保持一致。

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
node --test --experimental-strip-types --test-name-pattern="visibility-only" tests/campaign-domain.test.ts  # 按测试名过滤
npx tsc --noEmit                 # 页面侧类型检查（tsconfig 排除了 agent/）
npx tsc -p agent/tsconfig.json   # Agent 服务类型检查
npm run lint
npm run build
```

本地 D1 首次使用前，先 `npm run build`，再应用迁移：

```bash
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_naive_ben_parker.sql
```

改表结构：改 `db/schema.ts` → `npm run db:generate` → 用上面的命令应用新 SQL → 同步改 `app/lib/server/session-store.ts`。运行时查询是手写 SQL，drizzle 只用来生成迁移。

部署时 Agent 服务单独跑在有 Node.js 和可写磁盘的环境；Workers 配 `AGENT_SERVICE_URL`，两边配同一个 `AGENT_SERVICE_TOKEN`。

## 架构

两个进程共用一份领域逻辑：

- **页面和数据（Workers）**：`app/api/sessions/**` → `app/lib/server/turns.ts`（`createSession` / `runTurn`）→ `SessionStore`（`session-store.ts`，D1 实现和测试用的内存实现）。版本、消息、落库都在这一侧，一个回合一次 `db.batch`。`app/lib/server/runtime.ts` 是唯一接 `cloudflare:workers` 的地方，负责组装 `TurnDeps`。
- **Agent 服务（Node）**：`agent/server.ts`，`POST /turn`。用 Claude Agent SDK 跑一轮对话，模型走 DeepSeek 的 Anthropic 兼容接口（`AGENT_MODEL`，默认 `deepseek-flash`）。SDK 内置工具全部关闭（`tools: []`、`settingSources: []`，配置目录隔离在 `agent/.claude-runtime/`），只挂 4 个活动工具。服务不存数据：收当前草稿，回改好的草稿。
- 两边的协议是 `app/lib/agent/protocol.ts`（`AgentRequest` / `AgentResult`）。Workers 侧请求超时 150s，要大于 Agent 侧单轮超时 120s。

`runTurn` 的流程：

1. `expectedSeq` 必须等于最新版本的 seq，否则 409，客户端会重新拉快照。D1 上 `(session_id, seq)` 的唯一索引是第二道防线。
2. `answer`（卡片选项、草稿面板、WebMCP）、`undo`、`rollback` 由代码直接处理，不调模型。`interpret`（新建会话后由对话页自动发起）、`text`、`clarify_submit`、`generate` 交给 Agent。示例会话（`entryMode: "example"`）用固定的 `EXAMPLE_INTERPRETATION`，也不调模型。
3. 结果统一经过 `deriveDraft` → `buildIcsDrafts` → `validateDraft`，再和上一版比 diff。有 diff 才写新版本；消息（`agent_change`、`agent_plan`、`agent_clarify` 等）按情况追加。
4. Agent 失败时写一条带 retry 的 `agent_error`，用户输入不丢。

消息是带 `kind` 的结构化 JSON（`StoredMessage`，定义在 `app/lib/campaign/messages.ts`），前端 `app/components/chat/message-view.tsx` 按 kind 渲染。

### 领域层 `app/lib/campaign/`（纯函数）

- `types.ts`：`CampaignDraft`。业务字段是 `FieldValue<T>`，带 `provenance`：`user`（用户原话）、`ai`（只用于文案、由头类型、人群）、`default`、`pending`（未填，或推断出来待确认，此时 `suggested: true`）。
- `workspace-state.ts` 的 `deriveDraft`：每次改动后都要跑，维护档位 label、`activityGroup`、`couponAllowed`、`derivedType`、`unresolved`，以及"只看到"时清空优惠。这些派生字段不要手动写，会被覆盖。
- `split-orders.ts`：ICS 单数 = 批次 × 市场 × 渠道 × 范围单元 × 优惠档位；顾客动作为"只看到"时是 0。
- `validator.ts`：R1–R17 开单规则，分 `blocker` / `warning`。
- `topics.ts`：`missingFields`（开单还缺什么）；`PATH_TABLE` 是模型可写路径的白名单，系统提示词里的路径表也由它生成。
- `clarify.ts` 管补充卡片的题目和提交解析；`answers.ts` 把选项回答转成 patch ops；`patcher.ts` 负责 patch 应用和 diff；`evidence.ts` 判定原话依据（数字、日期、关键词）。

### Agent 工具 `app/lib/agent/`

`tools.ts` 实现 `update_fields` / `ask_user` / `write_plan` / `undo_last_change`。工具只改这一轮的 `AgentState`，不依赖 SDK。

- `update_fields` 的每条改动都过 `guardOps`（`app/lib/server/ai-schemas.ts`）：路径白名单、取值类型、原话依据。被拒的以 `dropped` 返回给模型。
- `write_plan` 在草稿有 `intentConflicts`、而本轮不是用户提交卡片或点按钮时拒绝；文案过不了 `/brief` 相关规则也拒绝。
- `finishAgentTurn` 会删掉回复里"提升 X%"这类预估。

改工具要同时改三处：`tools.ts`（`AGENT_TOOL_NAMES`、`runAgentTool`）、`agent/server.ts`（zod 入参和 `tool(...)` 注册）、`prompt.ts`（系统提示词里的工具说明）。

新增模型可写的字段：`topics.ts` 的 `PATH_TABLE`（需要追问的话还有 `missingFields` 和 `clarify.ts`），以及 `ai-schemas.ts` 的 `PATH_FIELD` 和 `evidenceProvenance`。注意 `evidenceProvenance` 的 default 分支直接判为 `user`，新路径不加规则就等于不核对原话。

## 必须守住的约束

- **数字和日期只认用户原话**：优惠数字、让扣点、回款率、日期必须能在用户这一轮的文字里找到（`numberAppearsInText`、`dateEvidenced`），找不到就丢弃并追问。不要为了让模型更顺而放宽守卫。
- **不编造内部码表**：会员等级、货类、品牌、支付方式、区域编码等不输出具体码。`unresolved`（待界面选择）只由代码按 `CODE_UNRESOLVED` 生成，不接受模型写入。
- **模块边界**：`agent/server.ts` 和 `npm test` 都用 Node strip-types 直接加载 `app/lib/{campaign,agent,server}`，所以这些模块（`runtime.ts` 除外）必须：
  - 不 import `cloudflare:workers`、`db/*` 或任何 npm 包（Agent 服务只装 `agent/` 的依赖，zod 版本也和根目录不同）；
  - 相对 import 写全 `.ts` 扩展名，不用 `@/` 别名；
  - 不用 enum、namespace、构造函数参数属性。
  - 前端代码（`app/components/**`、`app/lib/client/`）不受限，照常用 `@/` 和无扩展名 import。
- **测回合流程不需要模型**：`tests/conversation.test.ts` 用内存 store 加一个按脚本调用真实工具的假 `runAgent`，新行为照这个模式补测试。

## 其他

- `components/ui/` 是原样引入的 shadcn 组件（eslint 对它放宽了规则），业务界面在 `app/components/`。
- `/codes`、`/open-questions` 是资料页，数据在 `app/lib/reference/`，依据是 `references/*.json`（PPT 字段抽取和调研结果），`tests/reference-data.test.ts` 核对两者一致。
- 页面通过 `app/lib/webmcp.ts` 暴露 WebMCP 工具（在 `app-shell.tsx` 注册），走 `answer` 回合，`origin: "tool"`。
- `.openai/hosting.json`、`build/sites-vite-plugin.ts` 和 `scripts/` 里的 `managed-linux` 分支来自 Sites/vinext 脚手架；本地没有 `.sites-runtime/` 时走 `portable` 分支。
- 设计文档在 `docs/superpowers/specs/`。接入 Agent SDK 之前的描述（如 `deps.callModel`、JSON 模式的理解和补丁提示词）已经过时，以代码为准。`app/lib/server/deepseek.ts`、`session-codec.ts`、`app/lib/campaign/demo-seeds.ts`、`prompts.ts` 的 `interpretationSystemPrompt`、`ai-schemas.ts` 的 `parseInterpretation` / `parseGeneratedCopy` / `parsePatchProposal` / `guardTextTurn` 都不在当前回合链路上，只有测试在用。
