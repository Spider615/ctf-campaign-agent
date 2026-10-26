# 内部管理端（用量与执行记录）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 内部同学登录后能按渠道看到每天的 Token 用量，搜到每个会话，看到客户的提问、公开回复、执行过程和每次模型请求的真实渠道、模型与 Token。

**Architecture:** 记录全部落在 Agent 服务（Node）：本机回环上的「模型出口」按路径里的轮次编号把每次上游请求记到 SQLite（`node:sqlite`，仓库外私有目录）；`http-handler.ts` 在四个入口建立和收尾轮次。页面侧（Workers）只把访客、会话、管理员凭据转发给 Agent，并提供 `/internal/*` 页面；管理员密码和签名密钥只在 Agent 环境里。

**Tech Stack:** Node 22.13+ `node:sqlite`、`node:async_hooks` 的 `AsyncLocalStorage`、`node:crypto` HMAC；vinext 页面；`node:test`。

**Spec:** `docs/superpowers/specs/2026-10-25-internal-usage-observability-design.md`

## 本计划不做（等第 9 节待确认项回复后另立计划）

- DeepSeek 日账单同步与对账、句子互动渠道费用。页面费用一栏固定显示「来源未接入」，不显示 0。
- 内部记录的删除与保留管理。

## Global Constraints

- 界面文案、错误信息、代码注释用中文。
- 两个渠道（`deepseek` / `juzi`）的 Token 分开统计，任何页面和接口都不返回跨渠道合计。
- 上游没给的 Token 子项存 `NULL`，页面显示「未提供」，不显示 0；未收尾的请求显示「不完整」。
- 不保存隐藏思考、系统提示词、完整工具入参、密钥、模型网关 key；访客标识只存 `sha256(owner)` 前 12 位。
- 记录目录必须在仓库外：复用 `agent/analytics-private-records.ts` 的 `privateAnalyticsDirectory`。默认 `~/Library/Application Support/ctf-campaign-agent/usage/usage.sqlite`，环境变量 `USAGE_DB_PATH`，容器 `/data/usage/usage.sqlite`。
- 日期筛选按北京时间（`Asia/Shanghai`）切天。
- `app/lib/**` 新模块遵守 CLAUDE.md 的模块边界（不 import npm 包，相对 import 写 `.ts`）。
- 评测脚本直接调运行器、不经过 `http-handler.ts`，因此不产生记录；不得为它们加记录。
- 对外人设规则不变：管理端是内部页面，可以显示真实厂商和模型名，客户页面仍不能。

## Review Focus

- 同一 Agent 进程里两个会话并发提问：每次模型请求必须记到发起它的那一轮，不能串号。（任务 2 测试 `并发两轮的请求各归各的`）
- 流式响应中途断开或用户停止：请求记录状态为 `incomplete`，已收到的 Token 保留，不补 0。（任务 2 测试 `流式中途断开记为不完整`）
- 句子互动网关 404 后换模型重试：存两条请求，第二条模型是换后的模型。（任务 2 测试 `网关回退存两条请求`）
- Agent 进程重启：上次 `running` 的轮次和请求变为 `interrupted`。（任务 1 测试 `重开库时未收尾的记录标为中断`）
- 未登录或签名过期、篡改的凭据访问 `/internal/*` 接口返回 401，响应体里没有任何客户内容。（任务 5 测试 `篡改或过期的凭据被拒绝`）

---

### Task 1: 用量库 `agent/usage/store.ts`

**Files:**
- Create: `agent/usage/store.ts`
- Test: `tests/usage-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type UsageChannel = "deepseek" | "juzi";
  export type UsageEntry = "analysis" | "attachments" | "campaign" | "insight";
  export type TurnStatus = "running" | "answered" | "partial" | "failed" | "cancelled" | "interrupted";
  export type RequestStatus = "running" | "done" | "error" | "incomplete" | "interrupted";
  export type TurnStart = { id: string; entry: UsageEntry; channel: UsageChannel; visitor: string | null; conversationId: string | null; internal: boolean; question: string; startedAt: number };
  export type TurnFinish = { status: Exclude<TurnStatus, "running" | "interrupted">; reply: string | null; error: string | null; trace: Array<{ title: string; status: string; summary?: string; startedAt: number; durationMs?: number }>; finishedAt: number };
  export type ModelRequestStart = { id: string; turnId: string; source: string; channel: UsageChannel; sdkModel: string; sentModel: string; vendor: string | null; vendorBasis: string; startedAt: number };
  export type ModelRequestFinish = { status: Exclude<RequestStatus, "running" | "interrupted">; httpStatus: number | null; responseId: string | null; upstreamModel: string | null; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; finishedAt: number };
  export type UsageFilter = { from: string; to: string; entry?: UsageEntry; channel?: UsageChannel; model?: string; status?: TurnStatus; keyword?: string; includeInternal?: boolean };
  export type UsageStore = {
    startTurn(turn: TurnStart): void; finishTurn(id: string, result: TurnFinish): void; countSdkStart(turnId: string): void;
    startRequest(request: ModelRequestStart): void; finishRequest(id: string, result: ModelRequestFinish): void;
    overview(filter: UsageFilter): UsageOverview; conversations(filter: UsageFilter & { offset?: number }): UsageConversationRow[]; conversation(key: string): UsageConversationDetail | null;
    close(): void;
  };
  export function createUsageStore(path: string): UsageStore;
  ```
  `UsageOverview = { days: Array<{ day: string; channel: UsageChannel; turns: number; requests: number; inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null; incompleteRequests: number }>; statuses: Record<TurnStatus, number>; models: Array<{ channel: UsageChannel; vendor: string | null; model: string; requests: number; inputTokens: number | null; outputTokens: number | null }>; durations: { turnsMs: { p50: number | null; p90: number | null } } }`。
  `UsageConversationRow = { key: string; entry: UsageEntry; visitor: string | null; title: string; lastQuestion: string; turns: number; channels: UsageChannel[]; inputTokens: number | null; outputTokens: number | null; durationMs: number; lastAt: number; internal: boolean }`。
  `UsageConversationDetail = { key: string; entry: UsageEntry; visitor: string | null; turns: Array<TurnStart & Partial<TurnFinish> & { status: TurnStatus; sdkStarts: number; requests: Array<ModelRequestStart & Partial<ModelRequestFinish> & { status: RequestStatus }> }> }`。
  会话 `key`：有 `conversationId` 时为 `${entry}:${conversationId}`，没有时（洞察问答）为 `${entry}:turn:${turnId}`。

- [ ] **Step 1: 写失败测试** `tests/usage-store.test.ts`，用临时目录建库：
  - `一轮两次请求的 Token 按渠道按天汇总`：一轮 deepseek、两次请求 input 100/200、output 10/20，另一轮 juzi input 50。`overview` 的 `days` 有两行（deepseek input 300、juzi input 50），不存在合计行。
  - `上游没给的子项汇总为 null 而不是 0`：juzi 请求 `cacheWriteTokens: null`，该渠道当天 `cacheWriteTokens === null`；一条为 null 一条为 5 时结果为 5，且 `incompleteRequests` 不受影响。
  - `北京时间切天`：`startedAt` 为 `2026-10-25T16:30:00Z` 的轮次落在 `2026-10-26`。
  - `重开库时未收尾的记录标为中断`：开始一轮和一次请求不收尾，`close` 后重新 `createUsageStore` 同一路径，详情里轮次 `interrupted`、请求 `interrupted`、Token 仍为 `null`。
  - `关键词和渠道筛选`、`内部流量默认不计入`：`internal: true` 的轮次在 `includeInternal` 未设时不出现在 `overview` 和 `conversations` 里。
- [ ] **Step 2:** `node --test --experimental-strip-types tests/usage-store.test.ts`，预期因模块不存在失败。
- [ ] **Step 3: 实现。** `DatabaseSync` 打开后设 `PRAGMA journal_mode=WAL`；建 `usage_turn`、`usage_request` 两表（列与上面类型一一对应，`trace_json` 存 `TurnFinish.trace`）。按天汇总用 `startedAt + 8h` 换算日期字符串，不依赖 SQLite 时区。Token 汇总用 `SUM`（全 NULL 时 SQLite 本身返回 NULL，符合约束）。p50/p90 在 JS 里对已收尾轮次的耗时排序取值。打开时执行两条 `UPDATE ... SET status='interrupted' WHERE status='running'`。所有 SQL 参数化。
- [ ] **Step 4:** 重跑测试，预期 PASS；`npx tsc -p agent/tsconfig.json` 通过。
- [ ] **Step 5:** `git commit -m "feat: 内部用量库按渠道按天记录轮次与模型请求"`

### Task 2: 模型出口与轮次上下文

**Files:**
- Create: `agent/usage/context.ts`、`agent/usage/model-edge.ts`
- Modify: `agent/model-gateway.ts`（`handle` 抽出供出口调用、`modelConfigFromEnv` 两个渠道都返回出口地址）
- Test: `tests/usage-model-edge.test.ts`；`tests/model-provider-config.test.ts`、`tests/model-gateway.test.ts` 按新地址更新

**Interfaces:**
- Consumes: Task 1 的 `UsageStore`、`ModelRequestStart/Finish`。
- Produces:
  ```ts
  // context.ts
  export type UsageTurnContext = { turnId: string };
  export function runInUsageTurn<T>(turnId: string, work: () => Promise<T>): Promise<T>;
  // 运行器拼 ANTHROPIC_BASE_URL 时调用；不在轮次里时原样返回 base（评测脚本走这里）。在轮次里返回 `${base}/t/${turnId}/${source}` 并记一次 SDK 启动。
  export function turnBaseUrl(base: string, source: string): string;
  export function setUsageRecorder(store: UsageStore | undefined): void;
  // model-edge.ts
  export function createModelEdge(options: { channel: "deepseek"; upstream: string; requestedModel: string; store?: UsageStore; fetch?: typeof fetch } | { channel: "juzi"; gateway: ReturnType<typeof createModelGateway>; store?: UsageStore }): { listen(): Promise<string>; close(): Promise<void> };
  ```
  `modelConfigFromEnv` 的返回增加 `channel: UsageChannel` 和 `attachStore(store: UsageStore): void`，`modelBaseUrl` 两个渠道都是 `http://127.0.0.1:<port>`。`analyticsSdkModel` 按渠道判断（`channel === "deepseek"`），不再比较 URL。

- [ ] **Step 1: 写失败测试** `tests/usage-model-edge.test.ts`，用本机假上游：
  - `DeepSeek 透传请求体和 key，并记下响应编号、模型和 Token`：假上游收到的 body 与 SDK 发出的逐字节相同，`x-api-key` 原样到达，路径前缀 `/t/<id>/<source>` 已去掉；非流式响应 `{ id: "msg_1", model: "deepseek-flash", usage: { input_tokens: 12, output_tokens: 3 } }` 记为 `done`、`upstreamModel: "deepseek-flash"`、`cacheReadTokens: null`、`vendor: "DeepSeek"`。
  - `DeepSeek 流式取 message_start 与 message_delta 的最终用量`：SSE 里 `message_start.usage.input_tokens=20`、`message_delta.usage.output_tokens=7`，记为 input 20、output 7，SDK 收到的 SSE 与上游逐字节一致。
  - `流式中途断开记为不完整`：上游发完 `message_start` 后客户端断开，记录 `incomplete`，input 20，output `null`。
  - `网关回退存两条请求`：juzi 渠道上游第一次 404、`/models/status` 给出同厂商可用模型，存两条：第一条 `error`/404/原模型，第二条 `done`/换后模型、`vendor` 取 `owned_by`、`cacheWriteTokens: null`。
  - `并发两轮的请求各归各的`：两个 `runInUsageTurn` 并发，各自用 `turnBaseUrl` 发请求，记录的 `turnId` 正确。
  - `没有轮次编号的请求照常转发但不记录`：路径不带 `/t/` 时转发成功，库里无记录。
  - 更新 `model-provider-config.test.ts`：DeepSeek 渠道 `modelBaseUrl` 匹配 `^http://127\.0\.0\.1:`，`channel === "deepseek"`，`analyticsSdkModel` 仍得到 `claude-sonnet-4-6`。
- [ ] **Step 2:** 运行这三个测试文件，预期失败。
- [ ] **Step 3: 实现。** 出口只听 `127.0.0.1`、端口随机、`unref`。路径 `^/t/([0-9a-f-]{36})/([a-z0-9-]{1,40})(/.*)$` 取轮次和来源，余下路径转发；不匹配时整条路径转发、不记录。只记录 `POST /v1/messages`。DeepSeek：上游为 `https://api.deepseek.com/anthropic`，用 `fetch` 透传方法、body、除 `host`/`content-length` 外的请求头，响应边写给 SDK 边按行解析 SSE；`sentModel` 为请求体 `model` 经官方映射（`claude-opus*`→`deepseek-v4-pro`，其余 `claude-*`→`deepseek-flash`）的结果，`vendorBasis: "官方兼容接口"`。juzi：把 `model-gateway.ts` 的 `handle` 改为接收可选回调 `onUpstream(model, status, body | stream usage)`，出口在回调里写记录；网关的 `usageOf` 不再给缓存写入填 0 的值也不能进库（记录用原始 OpenAI usage：`prompt_tokens - cached` 为 input、`cached_tokens` 为 cacheRead、cacheWrite 恒为 `null`）。
- [ ] **Step 4:** 运行 `npm test`，预期全部 PASS；`npx tsc -p agent/tsconfig.json` 通过。
- [ ] **Step 5:** `git commit -m "feat: 模型出口按轮次记录两个渠道的每次上游请求"`

### Task 3: 入口建轮次、运行器接出口

**Files:**
- Modify: `agent/run-turn.ts:285`、`agent/analytics-skill-run-turn.ts:125`、`agent/analysis-plan-run-turn.ts:210`、`agent/analytics-run-turn.ts:125`、`agent/insight-ask.ts:60`、`agent/attachments/run-turn.ts:52,129`（`ANTHROPIC_BASE_URL` 与图片请求地址改用 `turnBaseUrl(config.modelBaseUrl, "<source>")`，来源分别为 `campaign`、`analysis`、`analysis-plan`、`analysis-legacy`、`insight`、`attachments-vision`、`attachments`）
- Create: `agent/usage/turns.ts`
- Modify: `agent/http-handler.ts`、`agent/attachments/http.ts`、`agent/server.ts`
- Test: `tests/usage-http.test.ts`

**Interfaces:**
- Consumes: Task 1 `UsageStore`；Task 2 `runInUsageTurn`、`turnBaseUrl`、`modelConfigFromEnv().channel/attachStore`。
- Produces: `export function recordTurn<T>(store: UsageStore | undefined, start: Omit<TurnStart, "id" | "startedAt">, work: (emitTrace: (event: AgentTraceEvent) => void) => Promise<T>, outcome: (result: T) => Pick<TurnFinish, "status" | "reply">, signal: AbortSignal): Promise<T>`。身份请求头（Task 4 由 Workers 发出）：`x-ctf-visitor`（owner 原值，Agent 端做哈希）、`x-ctf-conversation`（UUID 或活动 id）、`x-ctf-internal: 1`。
  入口与 `outcome`：直接问答 `analysis`，回复用 `analyticsAnswerText`，v4 `status` 为 `partial`/`unavailable` 时记 `partial`；附件 `attachments`，`conversationId` 取请求体；活动 `campaign`，问题取 `trigger.text`，回复取 `result.reply`，`conversationId` 取头；洞察 `insight`，回复取 `body`，无会话编号。抛错记 `failed`（`error` 存 `publicError` 后的公开文案），取消记 `cancelled`。

- [ ] **Step 1: 写失败测试** `tests/usage-http.test.ts`，用假运行器在 `turnBaseUrl` 上发一次请求到假出口（复用 Task 2 测试的假上游写法）：
  - `直接问答一轮：问题、公开回复、轨迹和请求都挂在同一轮`；`同一会话两次提问是两轮`（`conversation(key).turns.length === 2`）。
  - `运行器抛错记为失败且保留已发生的请求`；`客户端断开记为取消`。
  - `附件问答里嵌套的分析请求算在同一轮`：附件运行器内部再调一次分析运行器，只有一轮、两个来源的请求。
  - `访客只存哈希`：库文件内容里搜不到 owner 原值。
  - `没配用量库时入口行为不变`：`store` 为 `undefined` 时原有 `agent-http-cancellation.test.ts` 用例全部通过。
- [ ] **Step 2:** 运行，预期失败。
- [ ] **Step 3: 实现。** `server.ts` 用 `USAGE_DB_PATH` 或默认路径经 `privateAnalyticsDirectory` 打开库，调用 `attachStore` 与 `setUsageRecorder`，传给 `createAgentHttpHandler` 和 `createAttachmentsHttpHandler`。`recordTurn` 内用 `crypto.randomUUID()` 建轮次、`runInUsageTurn` 包住 `work`，轨迹只取 `AgentTraceEvent` 的 `title/status/summary/startedAt/durationMs`。用量库写失败只打日志，不影响回答。
- [ ] **Step 4:** `npm test`、`npx tsc -p agent/tsconfig.json`，预期全部通过。
- [ ] **Step 5:** `git commit -m "feat: 四个问答入口按轮次记录提问、回复和执行过程"`

### Task 4: 页面侧转发访客与会话身份

**Files:**
- Modify: `app/lib/server/runtime.ts`（`agentHeaders` 接受 `identity?: { visitor?: string; conversation?: string; admin?: string }`）、`app/api/analytics/history/route.ts`、`app/api/analytics/conversation/route.ts`、`app/api/analytics/insight/ask/route.ts`、`app/api/sessions/[id]/turns/route.ts`、`app/lib/client/history-stream.ts`、`app/components/analytics/history-conversation.tsx:97`
- Test: `tests/usage-identity-forward.test.ts`

**Interfaces:**
- Consumes: Task 3 的请求头名称。
- Produces: 浏览器发 `/api/analytics/history` 时带 `X-Conversation-Id`（当前 `conversationId`）；Workers 只转发符合 `^[0-9a-f-]{36}$` 的值，否则不带该头。管理员 cookie `ctf_internal` 存在时原样作为 `x-ctf-admin` 转发，Agent 验签通过才记 `internal: true`（验签函数见 Task 5）。

- [ ] **Step 1: 写失败测试**（读源码正则，按 memory「组件怎么测」的做法）：`postHistoryStream` 的请求头包含 `X-Conversation-Id`；`runtime.ts` 对非 UUID 会话编号不转发；活动回合转发 `x-ctf-conversation` 为路由参数 `id`；四个路由都把 `owner` 交给 `agentHeaders`。
- [ ] **Step 2:** 运行，预期失败。
- [ ] **Step 3:** 实现。`postHistoryStream` 增加参数 `conversationId: string`。
- [ ] **Step 4:** `npm test`、`npx tsc --noEmit`、`npm run lint` 通过。
- [ ] **Step 5:** `git commit -m "feat: 问答请求向 Agent 转发访客和会话编号"`

### Task 5: 管理员登录与内部查询接口

**Files:**
- Create: `agent/usage/admin.ts`、`app/api/internal/login/route.ts`、`app/api/internal/logout/route.ts`、`app/api/internal/[...path]/route.ts`
- Modify: `agent/http-handler.ts`（放行 `/internal/login`、`/internal/overview`、`/internal/conversations`、`/internal/conversations/<key>`）、`app/lib/server/runtime.ts`（`forwardInternalRequest`）、`.dev.vars.example`
- Test: `tests/usage-admin.test.ts`

**Interfaces:**
- Consumes: Task 1 查询方法。
- Produces:
  ```ts
  export function createAdminAuth(options: { password?: string; secret?: string; now?: () => number }): { configured: boolean; login(password: string): string | null; verify(token: string | undefined): boolean };
  ```
  环境变量 `INTERNAL_ADMIN_PASSWORD`、`INTERNAL_SESSION_SECRET`（至少 32 字符），只在 Agent 侧读取。凭据格式 `<过期毫秒>.<base64url HMAC-SHA256>`，有效期 12 小时。Workers 登录成功后设 `ctf_internal=<凭据>; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`，https 时加 `Secure`；登出清 cookie。查询接口 GET 参数：`from`、`to`（`YYYY-MM-DD`，跨度 ≤ 92 天）、`entry`、`channel`、`model`、`status`、`keyword`（≤ 100 字）、`internal=1`、`offset`。

- [ ] **Step 1: 写失败测试** `tests/usage-admin.test.ts`：
  - `密码正确签发凭据、错误密码返回 null`，比较用 `timingSafeEqual`（读源码断言）。
  - `篡改或过期的凭据被拒绝`：改一位签名、`now` 推后 12 小时 + 1 毫秒都 `verify === false`；对应 HTTP 请求返回 401，响应体只有 `{ error: "请先登录管理端" }`。
  - `未配置密码时内部接口返回 503「管理端未配置」`，且客户接口不受影响。
  - `查询参数越界返回 400`：`from > to`、跨度 93 天、非法 `channel`。
  - `Workers 登录接口只接受同源 POST`：`Origin` 不同主机时 403（复用 `analytics-access.ts` 的同源判断）。
- [ ] **Step 2:** 运行，预期失败。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** `npm test`、两份 `tsc`、`npm run lint` 通过。
- [ ] **Step 5:** `git commit -m "feat: 内部管理员登录与用量查询接口"`

### Task 6: 管理端页面

**Files:**
- Create: `app/internal/login/page.tsx`、`app/internal/stats/page.tsx`、`app/internal/conversations/page.tsx`、`app/internal/conversations/[key]/page.tsx`、`app/components/internal/`（筛选栏、统计表、会话表、轮次时间线）
- Test: `tests/internal-admin-ui.test.ts`

**Interfaces:**
- Consumes: Task 5 接口（`/api/internal/overview` 等）及 Task 1 的返回结构。
- Produces: 页面。

页面内容按设计文档第 3 节，取舍如下：
- 统计总览：日期范围默认最近 7 天（北京时间）；按渠道分两块，各自一张按天的表（轮次、请求、输入/输出/缓存读/缓存写 Token、不完整请求数、费用「来源未接入」）；状态分布；渠道 × 厂商 × 模型表；耗时 p50/p90。页面任何位置不出现跨渠道合计。
- 会话列表：访客编号、入口、标题（首个问题前 30 字）、最近问题、轮数、渠道、Token、耗时，点击进详情。内部流量带「内部」标记，默认隐藏，可勾选显示。
- 会话详情：按时间列出每轮的提问、公开回复、状态、耗时、SDK 启动次数；展开后是执行轨迹和模型请求表（来源、渠道、厂商、发送模型、上游返回模型、响应编号、各类 Token、耗时、状态），SDK 别名放在折叠的技术详情里。
- 接口返回 401 时跳转 `/internal/login`；任何 `null` Token 显示「未提供」，`incomplete` 请求显示「不完整」。

- [ ] **Step 1: 写失败测试**（esbuild 编进内存渲染或读源码正则，按 memory「组件怎么测」）：`null` Token 渲染为「未提供」；总览组件不对两个渠道求和（源码中不存在跨渠道累加，渲染两个渠道各自一张表）；401 时调用跳转；费用列文案为「来源未接入」。
- [ ] **Step 2:** 运行，预期失败。
- [ ] **Step 3:** 实现，沿用浅色工作台样式和 `components/ui/` 组件。
- [ ] **Step 4:** `npm test`、`npx tsc --noEmit`、`npm run lint`、`npm run build` 通过。
- [ ] **Step 5:** `git commit -m "feat: 管理端统计总览、会话列表和会话详情页面"`

### Task 7: 部署配置与真实验收

**Files:**
- Modify: `Dockerfile`（`ENV USAGE_DB_PATH=/data/usage/usage.sqlite`）、`.dev.vars.example`、`.env.example`、`CLAUDE.md`（「命令」与「架构」各补一段管理端说明）、设计文档状态行

- [ ] **Step 1:** 本地 Node 22（`nvm use 22`）配 `INTERNAL_ADMIN_PASSWORD` / `INTERNAL_SESSION_SECRET`，`npm run dev:all`。
- [ ] **Step 2:** 用 DeepSeek 渠道在智能问答同一会话问两个问题、在活动里说一句话、在深度剖析问一次图；打开 `/internal/stats` 和详情页，核对：两轮挂在同一会话、每次请求有响应编号和 Token、厂商显示 DeepSeek。
- [ ] **Step 3:** 提问中途点停止，详情显示「已取消」且已有请求保留；重启 `dev:agent` 后进行中的轮次显示「中断」。
- [ ] **Step 4:** 有 `JUZI_MODELS_KEY` 时切 `AGENT_PROVIDER=juzi` 重复 Step 2，确认渠道分开展示、缓存写入显示「未提供」。没有 key 时如实记录未验证。
- [ ] **Step 5:** 把验收结果（含未验证项）写进设计文档状态行，`git commit -m "docs: 管理端部署配置与本地验收记录"`。
