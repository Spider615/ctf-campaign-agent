# 周大福优惠开单活动助手 Demo

运营用对话描述一个优惠活动，Agent 按《优惠开单活动创建 SOP》追问必须由人确定的信息（最多两轮），白话复述、确认后给出 ICS-1811「优惠开单活动新增」页面的逐项填写值。追问、复述、填写值和校验由代码完成；对话由 Claude Agent SDK 驱动，模型使用 DeepSeek。

## Demo 能力

- 一句话开始，或打开一个完整示例
- 以对话为主：缺什么就在对话里直接问，打字回答即可，「十月八号到十五号」「每克便宜20块」「没扣点也没回款率」「按售价算」这类口语都能识别；不想打字可以展开选项快速填
- 人定字段（日期、门店、优惠、货类、让扣点回款率、提成口径、结算说明函、标语）不用默认值，最多追问两轮；两轮后仍缺就在复述里列出，不能生成
- 白话复述后打字「确认」或点按钮，生成按 1811 页面顺序排列的填写值、建完后待办（例如去 ICS-1815 改活动分组）和自查清单
- 数字和日期只认用户原话；每个填写值标明来源（你说的、AI 定、默认·待确认、栏位推断）
- 1811 没有对应优惠类型的玩法（第二件半价、满送等），以及抽奖这类不带成交优惠的活动，会直接说明
- 对话里随时修改、提问、撤销；D1 保存活动、消息和版本，可以重新打开、恢复版本
- AI 工作时实时展示真实工具调用；完成后折叠保存，可展开查看每一步、执行方、结果摘要和耗时
- 资料页：代码表（标出演示编造的取值）、待确认清单（SOP 没说清的问题和设计默认值）
- 页面暴露 `start_campaign_draft`、`update_campaign_fields`、`read_campaign_summary` 三个 WebMCP 工具

## 架构

- **页面与数据**（`npm run dev`，默认端口 5173）：vinext + Cloudflare Workers + D1，负责会话、版本、追问轮次、复述、填写值与校验。
- **Agent 服务**（`npm run dev:agent`，默认端口 8788）：`agent/server.ts` 用 Claude Agent SDK 跑一轮对话，模型通过 DeepSeek 的 Anthropic 兼容接口（`deepseek-flash`）驱动。SDK 自带的文件、命令行等工具全部关闭，只挂 8 个活动工具：`extract_campaign_facts`、`lookup_ics_reference`、`analyze_campaign_state`、`draft_campaign_copy`、`build_campaign_readback`、`generate_ics1811_sheet`、`confirm_campaign_readback`、`undo_campaign_change`。工具实现在 `app/lib/agent/`，不依赖 SDK，可以直接单测。
- 浏览器对话回合使用 NDJSON 流式返回真实工具事件和最终 Snapshot；Agent 的 `/turn` JSON 接口继续保留作测试与兼容，`/turn/stream` 提供流式事件。已完成轨迹随消息落库，刷新后仍能审计。
- 需要模型的回合，Workers 把当前草稿和最近对话发给 Agent 服务；模型或编排器发起工具，工具内部仍运行确定性业务代码。Workers 在提交前重新执行 `deriveFill → checkDraft → planNext` 并生成最终复述或填写值，一次性落库。Agent 服务不存数据。
- 工具轨迹只展示公开动作、状态、数量摘要和耗时，不展示隐藏思维、系统提示词、完整工具入参、密钥或内部堆栈。
- 领域逻辑在 `app/lib/campaign/ics1811/`（纯函数），设计依据是 `docs/superpowers/specs/2026-09-16-ics1811-sop-agent-design.md`。

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

部署时，Agent 服务要单独跑在有 Node.js 和可写磁盘的环境（容器或服务器）。Workers 的环境变量里配置 `AGENT_SERVICE_URL`；两边配置同一个 `AGENT_SERVICE_TOKEN`。

## 验证

```bash
npm test
npx tsc --noEmit
npx tsc -p agent/tsconfig.json
npm run lint
npm run build
```

这是产品演示，不连接 1811/1815/1816 生产系统；代码表是演示编造的，录入时以 ICS 系统为准。
