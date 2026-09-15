# 周大福营销活动生成 Agent Demo

这是依据设计文档实现的可交互 Web demo。运营用一句话描述活动，Agent 通过对话和补充卡片把它变成营销方案和 ICS 开单草稿。拆单和 17 条开单规则校验由代码完成；对话由 Claude Agent SDK 驱动，模型使用 DeepSeek。

## Demo 能力

- 一句话新建活动，或从完整示例开始
- Agent 判断信息够不够：不够时出一张补充卡片（每项有选项和自定义输入，都可以不填），够了直接生成方案
- 对话里随时补充、修改、提问、撤销；发现前后矛盾（例如顾客只需互动、优惠却要下单）会先请你确认
- 区分用户输入、AI 推断、系统默认和待界面选择；优惠数字、日期只认用户原话
- 实时计算 ICS 草稿数量，并覆盖“只看到、不建 ICS 单”的特殊路径
- D1 保存活动、消息、版本和补丁，可从最近活动重新打开并回退版本
- 页面暴露 `start_campaign_draft`、`update_campaign_fields`、`read_campaign_summary` 三个 WebMCP 工具

## 架构

- **页面与数据**（`npm run dev`，端口 5173）：vinext + Cloudflare Workers + D1，负责会话、草稿版本、拆单与校验。
- **Agent 服务**（`npm run dev:agent`，端口 8788）：`agent/server.ts` 用 Claude Agent SDK 跑对话循环，模型通过 DeepSeek 的 Anthropic 兼容接口（`deepseek-flash`）驱动。SDK 自带的文件、命令行等工具全部关闭，只挂四个活动工具：写字段（校验原话依据）、出补充卡片、写方案（校验开单规则）、撤销。工具实现在 `app/lib/agent/`，不依赖 SDK，可以直接单测。
- 需要模型的回合，Workers 把当前草稿和最近对话发给 Agent 服务，拿回改好的草稿和要展示的消息，再一次性落库。Agent 服务不存数据。

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

部署时，Agent 服务要单独跑在有 Node.js 和可写磁盘的环境（容器或服务器）。Workers 的环境变量里配置 `AGENT_SERVICE_URL`；两边配置同一个 `AGENT_SERVICE_TOKEN`。

## 验证

```bash
npm test
npx tsc --noEmit
npx tsc -p agent/tsconfig.json
npm run build
```

这是产品演示，不直接连接 1811/1815/1816 生产系统；区域码、审批流等不完整码表字段会明确保留为待界面选择。
