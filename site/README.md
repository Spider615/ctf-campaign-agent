# 周大福营销活动生成 Agent Demo

这是依据设计文档实现的可交互 Web demo。它把自然语言活动需求转成结构化草稿，由代码完成拆单和 17 条确定性校验，再由 DeepSeek 生成文案与对话式修改补丁。

## Demo 能力

- 新建、复制上次、从审批退回修改、从完整示例开始
- 自然语言预填，区分用户输入、AI 理解、系统默认和待界面选择
- 实时计算 ICS 草稿数量，并覆盖“只看到、不建 ICS 单”的特殊路径
- DeepSeek `deepseek-flash` 生成传播名、开单名、活动内容和标语
- 对话式局部修改，修改前展示 diff
- D1 保存活动、消息、版本和补丁，可从最近活动重新打开并回退版本
- 页面暴露 `start_campaign_draft`、`update_campaign_fields`、`read_campaign_summary` 三个 WebMCP 工具

## 本地运行

要求 Node.js `>=22.13.0`。

```bash
npm run install:ci
cp .dev.vars.example .dev.vars
# 在 .dev.vars 中填写 DEEPSEEK_API_KEY
npm run dev
```

首次使用本地 D1 前，先构建并应用迁移：

```bash
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_naive_ben_parker.sql
```

## 验证

```bash
npm test
npx tsc --noEmit
npm run build
```

这是产品演示，不直接连接 1811/1815/1816 生产系统；区域码、审批流等不完整码表字段会明确保留为待界面选择。
