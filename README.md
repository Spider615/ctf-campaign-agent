# 周大福营销活动编排 Agent Demo

运营用自然语言提出活动想法，Agent 先把需求整理成 `campaign/v1` 活动 Brief，再根据事实动态选择品牌传播、成交优惠、会员触达、内容传播和门店准备等执行轨。ICS-1811 只是成交优惠活动才会创建的可选子流程；一场 Campaign 当前最多包含一张 1811 子单。

对话由 Claude Agent SDK 驱动，模型通过 DeepSeek 的 Anthropic 兼容接口运行。Harness 负责按回合读取 Skill、选择工具和组织回复；事实证据、动态路由、1811 字段换算、缺项、校验、传播守卫、工作台状态和落库都由确定性 TypeScript 代码负责。

## Demo 能力

- 一句话开始活动，先形成目标、受众、主题、渠道等 Campaign Brief；活动类型不明确时继续追问，不默认成优惠开单活动。
- 同一活动可命中多条执行轨。例如“新品发布 + 门店 9 折”会同时进入品牌传播与成交优惠轨；互不依赖的轨道可以并行准备。
- 只有检测到成交优惠时才创建一张 ICS-1811 子单。后续对话新增加交易优惠，也会动态补建子单；非交易活动仍可继续完成 Brief、执行规划和传播方案。
- 1811 人定字段不设默认值。Agent 可以对允许的字段提出具体建议，但只有用户明确同意后才记下；优惠方式和力度、标语原文、法务确认等不能由 Agent 提议。
- 1811 信息齐全且没有阻断时，生成按页面顺序排列的填写值、摘要、后续待办和自查清单。界面只标记“1811 已就绪”，不把它误报成整个活动已经上线。
- Brief 齐备后可生成完整传播方案，包括创意概念、核心信息、已确认渠道的版本、视觉方向、确定性活动事实和发布前复核提示；方案状态最高为“待审核”。
- 对话中可继续修改、提问、撤销和恢复版本；D1 保存 Campaign 父文档、消息、版本和可选 1811 产物。
- Agent 正文流式输出；Skill 加载、工具调用和编排器补跑以真实轨迹实时展示，并记录模型等待、Skill/工具执行和总耗时。每条消息显示时间，正文支持选择和复制。
- 右侧“活动工作台”包含五个顶层页签：`Brief`、`执行`、`上线检查`、`传播方案`、`1811`。没有 1811 子流程时，1811 页明确显示“不适用”。
- 页面暴露 `start_campaign_draft`、`update_campaign_fields`、`read_campaign_summary` 三个 WebMCP 工具。

## 架构

- **页面与数据**（`npm run dev`，默认端口 5173）：vinext + Cloudflare Workers + D1，负责会话、版本、受控合并、确定性重算和一次性落库。
- **Agent 服务**（`npm run dev:agent`，默认端口 8788）：`agent/server.ts` 提供兼容用的 `POST /turn` JSON 和流式 `POST /turn/stream` NDJSON；服务接收当前 Campaign 与最近对话，返回本回合经工具修改的结果，本身不存数据。
- **Campaign 领域层**：`app/lib/campaign/` 保存 `campaign/v1` 父模型、Brief 原话守卫、动态路由、执行轨、上线门禁与传播方案；`app/lib/campaign/ics1811/` 保留单一可选子流程的事实守卫、换算、代码表、校验和填写值。
- **共享协议**：`app/lib/agent/protocol.ts` 区分整体 `campaignStage` 与可空的 `ics1811Phase`。Workers 收到结果后重新计算 `CampaignWorkspace`、1811 产物与传播方案，不采信模型自报状态。
- **兼容层**：旧 `ics1811/v1` 版本会逐版本包装成 `campaign/v1`；旧 1811 leaf promo 只读兼容，新界面和新生成逻辑以父层 `communication` 为准。

SDK 内置工具只开放 `Skill`，活动读写由本地 MCP server 的 11 个确定性工具完成：

- 父层：`update_campaign_brief`、`analyze_campaign_plan`
- 1811 子流程：`extract_campaign_facts`、`accept_campaign_proposals`、`lookup_ics_reference`、`analyze_campaign_state`、`ask_campaign_questions`、`draft_campaign_copy`、`generate_ics1811_sheet`
- 跨产物：`draft_promo_copy`、`undo_campaign_change`

`campaign-orchestrator` 是每个模型回合必须先加载的总体编排 Skill；只有交易优惠或 1811 语境才叠加 `campaign-sop`。`offer-entry-guide`、`field-explainer`、`settlement-guide`、`promo-copy-guide` 按当前意图加载。所有活动工具都受 `campaign-orchestrator` 门禁，1811 专属工具还受 `campaign-sop` 门禁。

总体设计见 `docs/superpowers/specs/2026-09-17-campaign-orchestration-agent-design.md`；1811 子流程的确定性规则继续以 `docs/superpowers/specs/2026-09-16-ics1811-sop-agent-design.md` 和现有领域代码为准。

## 本地运行

要求 Node.js `>=22.13.0`。

```bash
npm run install:ci
npm run install:agent
cp .dev.vars.example .dev.vars
# 在 .dev.vars 中填写 DEEPSEEK_API_KEY
npm run dev:all
```

首次使用本地 D1 前，先构建并应用迁移：

```bash
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_naive_ben_parker.sql
```

8788 端口被占时，在 `.dev.vars` 里加 `AGENT_PORT=8790` 和 `AGENT_SERVICE_URL=http://127.0.0.1:8790`。页面端口被占时会自动顺延，以终端打印的地址为准。

运行时 Skill 按回合加载：

- 只改 `agent/plugin/skills/*/SKILL.md`，下一次 Agent 回合直接生效，不需要重启 `dev:agent`。
- 改 `agent/skills.ts`、`agent/server.ts`、`app/lib/agent/` 或 `app/lib/campaign/`，需要重启 `dev:agent`；页面侧仍会热更新。
- Skill 格式或出处校验失败时，下一回合明确报错，不会静默关闭业务知识。

## 部署

容器部署（butler）用仓库根目录的 `Dockerfile`：一个容器里同时跑页面（wrangler 本地模式，含 D1）和 Agent 服务，入口是 `scripts/start-container.mjs`。页面对外监听 `PORT`（默认 8787），Agent 只听容器内回环地址；启动时自动应用 D1 迁移。只需要配置 `DEEPSEEK_API_KEY`，其余变量见 `.env.example`；`/data` 要设成持久目录，否则重新部署会丢会话。

也可以把 Agent 服务单独跑在有 Node.js 和可写磁盘的环境，页面放在 Workers 上。只有这种分开部署才需要：Workers 配置 `AGENT_SERVICE_URL`，两边配置相同的 `AGENT_SERVICE_TOKEN`。

部署产物必须包含：

```text
agent/plugin/.claude-plugin/plugin.json
agent/plugin/skills/*/SKILL.md
```

运行时不需要打包 `docs/` 或 `references/`。发布前可检查产物：

```bash
test -f agent/plugin/.claude-plugin/plugin.json
test "$(find agent/plugin/skills -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')" -ge 6
```

有有效模型 key 时，可额外运行 `npm run test:skills:live` 验证真实 SDK 的 Skill 交付链路；它不属于默认 CI。

## 验证

```bash
npm test
npx tsc --noEmit
npx tsc -p agent/tsconfig.json
npm run lint
npm run build
```

## 维护运行时 Skills

- 业务 Skill 位于 `agent/plugin/skills/<name>/SKILL.md`，只整理仓库已有、能在 `出处` 中定位的规则。
- 每份 Skill 只允许 `name`、`description` 两个 frontmatter 字段；正文依次包含 `适用场景`、`回答原则`、`业务知识`、`不能做什么`、`冲突处理`、`出处`，前五节每条规则都引用 `[S#]`。
- `BASELINE_SKILL_NAMES` 是受管 Skill 的精确名单，不代表全部每回合加载。`campaign-orchestrator` 每回合必载，`campaign-sop` 与其他专项 Skill 按语境加载；改名或增删时同步修改名单和测试。
- Skill 只放有出处的解释、编排和写作指导。字段映射、默认值、代码表、事实守卫、动态路由、缺项、校验、传播守卫和落库继续放在 TypeScript 中。
- 修改后运行 `node --test --experimental-strip-types tests/skills.test.ts`、两套 TypeScript 检查，并通过 Git diff 和代码评审合入。

`tests/skills.test.ts` 会调用 `validateSkillSources`，确认每个 `[S#]` 引用都能定位到仓库内的现有出处。

这是产品演示，不连接 1811、1815、1816、OA、CRM、库存、投放或门店生产系统；代码表含演示编造项，正式执行以真实系统和人工审核为准。
