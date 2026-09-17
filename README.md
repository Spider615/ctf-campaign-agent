# 周大福优惠开单活动助手 Demo

运营用对话描述一个优惠活动，Agent 边聊边把活动搭起来：人定字段缺什么接着问，可以提议具体值但只有用户点头才记；信息齐全且没有阻断时，直接给出 ICS-1811「优惠开单活动新增」页面的逐项填写值，之后的修改也会同步更新。缺项、提议校验、填写值和落库以确定性 TypeScript 结果为准；对话由 Claude Agent SDK 驱动，模型使用 DeepSeek。

## Demo 能力

- 一句话开始，或打开一个完整示例
- 以对话为主：缺什么就在对话里接着问，没有固定轮数；打字回答即可，「十月八号到十五号」「每克便宜20块」「没扣点也没回款率」「按售价算」这类口语都能识别
- 人定字段（日期、门店、优惠、货类、让扣点回款率、提成口径、结算说明函、标语）不设默认值；Agent 可以对允许的字段提议具体值，用户明确同意后才记下，优惠方式和力度、标语原文、法务确认不能提议
- 信息齐全且没有阻断时直接生成按 1811 页面顺序排列的填写值、活动摘要、建完后待办（例如去 ICS-1815 改活动分组）和自查清单，不需要复述确认；后续修改会同步更新填写值
- 数字和日期只认用户原话、面板修改或用户明确同意的 Agent 提议；每个填写值标明来源（你说的、AI 定、默认·待确认、栏位推断）
- 1811 没有对应优惠类型的玩法（第二件半价、满送等），以及抽奖这类不带成交优惠的活动，会直接说明
- 对话里随时修改、提问、撤销；D1 保存活动、消息和版本，可以重新打开、恢复版本
- AI 工作时实时展示真实工具调用；完成后折叠保存，可展开查看每一步、执行方、结果摘要和耗时
- 资料页：代码表（标出演示编造的取值）、待确认清单（SOP 没说清的问题和设计默认值）
- 页面暴露 `start_campaign_draft`、`update_campaign_fields`、`read_campaign_summary` 三个 WebMCP 工具

## 架构

- **页面与数据**（`npm run dev`，默认端口 5173）：vinext + Cloudflare Workers + D1，负责会话、版本、缺项、提议、填写值与校验。
- **Agent 服务**（`npm run dev:agent`，默认端口 8788）：`agent/server.ts` 提供 `/turn` 和 `/turn/stream`，模型通过 DeepSeek 的 Anthropic 兼容接口（`deepseek-flash`）驱动，服务本身不存数据。
- 浏览器对话回合使用 NDJSON 流式返回真实工具事件和最终 Snapshot；Agent 的 `/turn` JSON 接口继续保留作测试与兼容，`/turn/stream` 提供流式事件。已完成轨迹随消息落库，刷新后仍能审计。
- 需要模型的回合，Workers 把当前草稿和最近对话发给 Agent 服务；模型或编排器发起工具，工具内部仍运行确定性业务代码。Workers 在提交前重新执行 `deriveFill → checkDraft → planNext`，信息齐全时生成活动摘要和填写值，再一次性落库。Agent 服务不存数据。
- 工具轨迹只展示公开动作、状态、数量摘要和耗时，不展示隐藏思维、系统提示词、完整工具入参、密钥或内部堆栈。
- 领域逻辑在 `app/lib/campaign/ics1811/`（纯函数），设计依据是 `docs/superpowers/specs/2026-09-16-ics1811-sop-agent-design.md`。

Agent 服务通过 Claude Agent SDK 运行一轮对话。SDK 内置工具只开放 `Skill`；活动读写由本地 MCP server 的 9 个确定性工具完成。`settingSources: []` 隔离个人和项目 Claude 配置，运行时只允许经过校验的 `ics1811` 本地插件 Skill。Skill 负责解释、录入指导和文案规范；事实、填写值、缺项、校验和落库仍以 TypeScript 工具结果为准。

9 个活动工具是 `extract_campaign_facts`、`accept_campaign_proposals`、`lookup_ics_reference`、`analyze_campaign_state`、`ask_campaign_questions`、`draft_campaign_copy`、`draft_promo_copy`、`generate_ics1811_sheet`、`undo_campaign_change`。工具实现在 `app/lib/agent/`，不依赖 SDK，可以直接单测。

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

- 只改 `agent/plugin/skills/*/SKILL.md`，下一次 Agent 回合会直接生效，不需要重启 `dev:agent`。
- 改 `agent/skills.ts`、`agent/server.ts`、`app/lib/agent/` 或 `app/lib/campaign/ics1811/`，仍要重启 `dev:agent`。
- Skill 格式不符合约定时，下一回合会明确报错，不会静默关闭业务知识。

## 部署

部署时，Agent 服务要单独跑在有 Node.js 和可写磁盘的环境（容器或服务器）。Workers 的环境变量里配置 `AGENT_SERVICE_URL`；两边配置同一个 `AGENT_SERVICE_TOKEN`。

Agent 部署产物必须包含插件清单和全部 Skill：

```text
agent/plugin/.claude-plugin/plugin.json
agent/plugin/skills/*/SKILL.md
```

运行时不需要打包 `docs/` 或 `references/`。发布前可检查产物：

```bash
test -f agent/plugin/.claude-plugin/plugin.json
test "$(find agent/plugin/skills -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')" -ge 4
```

有有效模型 key 时，可在发布前额外运行 `npm run test:skills:live`，检查真实 SDK 的 Skill 交付链路；它不是默认 CI 的一部分。

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
- 每份 Skill 只允许 `name`、`description` 两个 frontmatter 字段，正文依次包含 `适用场景`、`回答原则`、`业务知识`、`不能做什么`、`冲突处理`、`出处`。前五节每条规则都要引用 `[S#]`。
- 四个基线 Skill 不能直接删除或改名；需要调整时同步修改 `BASELINE_SKILL_NAMES` 和测试。新增且校验通过的 Skill 会自动进入精确白名单。
- Skill 只放解释和写作指导。字段映射、默认值、代码表、事实守卫、缺项、校验和落库规则继续放在 TypeScript 中。
- 修改后运行 `node --test --experimental-strip-types tests/skills.test.ts`、`npx tsc --noEmit` 和 `npx tsc -p agent/tsconfig.json`，再通过 Git diff 和代码评审合入。

`tests/skills.test.ts` 会调用 `validateSkillSources`，确认每个 `[S#]` 引用都能定位到仓库内的现有出处。

这是产品演示，不连接 1811/1815/1816 生产系统；代码表是演示编造的，录入时以 ICS 系统为准。
