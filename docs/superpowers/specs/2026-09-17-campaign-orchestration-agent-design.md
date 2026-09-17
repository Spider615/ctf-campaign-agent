# 周大福营销活动编排 Agent 设计

日期：2026-09-17

状态：方案 A 已获用户确认，进入实现

本文在 `2026-09-17-harness-first-campaign-agent-design.md` 之上扩展产品边界。发生冲突时，以本文对活动父层、工作流路由、上线门禁和传播产物的定义为准；ICS-1811 的事实守卫、字段换算、代码表、填写值推导和校验仍以现有领域代码与设计为准。

## 1. 背景与结论

现有产品把一次会话等同于一张 ICS-1811 优惠开单活动。只要 1811 人定字段齐全，界面、会话状态和 Agent 都会说“活动建好了”。这会造成三类问题：

1. 品牌发布、会员运营、内容传播等非交易活动被误判为“不在 1811 范围”，而不是被当作有效营销活动继续规划。
2. 1811 只是优惠配置产物，却被当作整个活动的父对象；传播、门店准备、渠道投放和上线确认只能成为它的附属入口。
3. 对外文案只有标题和卖点，缺少受众、目标、信息层级、渠道版本和视觉方向，无法承担“传播方案”的职责。

基于仓库内《优惠开单活动操作指引》与公开资料能确认的边界，本产品采用以下结论：

- 先形成活动 Brief，再按活动事实动态选择执行轨；没有证据支持所有活动都必须按同一条串行流程推进。
- 交易优惠需要进入 1811 子流程；品牌传播、CRM、门店准备等轨道按活动类型动态出现，并可并行推进。
- 正式上线前用门禁汇总各轨状态；未连接真实审批、库存、物料或生产系统时，只能标记“待人工确认”，不能伪造“已审批”或“已上线”。
- Harness 负责读取 Skill、选择工具和组织对话；TypeScript 负责事实证据、动态路由、状态聚合和安全门禁。

## 2. 目标与非目标

### 2.1 目标

1. 用一个活动 Brief 作为会话父层，ICS-1811 是其中可选的交易优惠 artifact。
2. 根据当前事实动态生成适用执行轨，不为每个活动硬编码 CRM、电商、门店或传播步骤。
3. 把“1811 填写值就绪”和“活动可上线”拆成两个独立状态。
4. 让非 1811 活动仍可完成 Brief、执行规划和传播方案，不再被系统拒绝。
5. 将营销活动总体工作法放进基线 `campaign-orchestrator` Skill；把现有 `campaign-sop` 收窄为 1811 专项 Skill。
6. 传播方案至少包含创意概念、核心信息、渠道版本、视觉方向、硬事实和发布前提示，并保留确定性事实渲染。
7. 保持现有真实 harness、流式回复、工具轨迹、版本记录和原话事实守卫。

### 2.2 非目标

- 不连接周大福生产 1811、OA、CRM、投放、库存或门店系统。
- 不把公开资料推断成周大福内部固定审批链。
- 不实现通用项目管理器、甘特图、任务指派或跨会话依赖。
- 不由模型自报“已审批”“已备货”“已发布”；人工门禁只展示待确认项。
- 不在本批次迁移 D1 表结构；新增父层信息继续存进现有 `brief_json`。
- 不为每个营销类型一次性建立完整行业知识库；只新增本次有仓库出处的工作流合同。

## 3. 选定架构

### 3.1 持久化对象

新增真正的父对象 `CampaignDraft`，现有 `Ics1811Draft` 保持不变并成为叶子任务：

```ts
type CampaignBrief = {
  objective: Fact<string> | null;
  audience: Fact<string> | null;
  theme: Fact<string> | null;
  channels: Fact<CampaignChannel[]> | null;
};

type CampaignDraft = {
  schema: "campaign/v1";
  id: string;
  requestText: string;
  brief: CampaignBrief;
  routing: {
    tracks: Array<"brand_launch" | "transaction_offer" | "member_crm">;
    status: "decided" | "needs_confirmation";
    basis: string[];
  };
  tasks: Array<{
    id: string;
    kind: "ics1811";
    label: string;
    draft: Ics1811Draft;
  }>;
  activeTaskId: string | null;
  communication: CommunicationCreative | null;
  gateInputs: Record<string, HumanGateInput | undefined>;
};
```

`objective`、`audience`、`theme` 只保存用户原话；`channels` 由代码从同一段原话识别为有限枚举。父层不复制日期、门店、优惠、货类和结算等 1811 事实，避免双向同步。

路由不是互斥单标签，而是纯函数根据 `requestText`、Brief 与 1811 优惠事实推导的多轨集合：

- `transaction_offer`：成交优惠、折扣、满减、克减、换购等；
- `brand_launch`：品牌、新品、联名、内容或线下体验；
- `member_crm`：会员、私域、积分或 CRM 触达；
- 信息不足时 `status = "needs_confirmation"`，先补 Brief，不默认成 1811 活动。

同一活动可以同时命中多条轨，例如“新品发布 + 门店 9 折”同时包含 `brand_launch` 和 `transaction_offer`。首批自动创建 0 或 1 个 1811 任务；数据结构允许将来在有确定性拆分依据时扩为多个任务，但不恢复旧设计的多维笛卡尔拆单。

读取旧 `ics1811/v1` 时，服务端用旧 draft id 稳定、无损地包装成一个 `campaign/v1` 父对象和一个 1811 任务；首次写新版本后保存父对象。数据库列无需迁移。

### 3.2 共享工作台视图

新增纯函数 `buildCampaignWorkspace(draft, icsEvaluation)`，服务端把结果放进 `Snapshot.workspace`。React 不自行推断轨道或门禁。

```ts
type CampaignWorkspace = {
  tracks: CampaignTrack[];
  stage: "briefing" | "planning" | "preparing" | "blocked" | "ready_for_launch";
  brief: {
    status: "draft" | "ready";
    items: BriefItem[];
    missing: CampaignBriefKey[];
    completeCount: number;
    totalCount: number;
  };
  tracks: ExecutionTrack[];
  readiness: {
    status: "blocked" | "needs_confirmation" | "ready";
    gates: ReadinessGate[];
  };
  artifacts: {
    ics1811: Ics1811Artifact;
    communications: CommunicationsArtifact;
  };
};
```

工作台是从事实和确定性结果重算的投影视图，不单独落库。轨道、门禁和 artifact 都必须带 `basis` 或 `nextAction`，让用户知道状态为什么成立以及下一步是什么。

### 3.3 动态执行轨

执行轨按活动事实选择，不显示不适用的轨：

| 轨道 | 出现条件 | 当前批次可验证的产物 |
|---|---|---|
| 活动策略 | 所有活动 | Brief 的目标、受众、主题、渠道是否齐全 |
| 优惠配置 | tracks 包含 `transaction_offer` | 1811 缺项、阻断和填写值 |
| 内容传播 | tracks 包含 `brand_launch` / `member_crm`，或用户明确要求传播 | 传播方案是否已生成、是否待审 |
| 会员触达 | tracks 包含 `member_crm` | 受众与会员渠道是否明确；实际 CRM 配置待人工 |
| 门店准备 | 有线下门店或 1811 子流程 | 门店范围已明确；库存、物料、培训待人工 |

轨道状态统一为 `not_started | in_progress | blocked | needs_confirmation | ready | not_applicable`。当前版本不提供按钮假装执行外部系统动作，只给出下一动作并允许用户继续通过对话补充事实或生成产物。

### 3.4 上线门禁

门禁从适用轨道聚合：

- Brief 核心信息：目标、受众、主题、渠道至少齐全；
- 优惠配置：仅在需要 1811 时要求填写值就绪且无 blocker；
- 传播物料：需要传播轨时要求已有草稿，仍标为“待人工审阅”；
- 会员配置：需要会员触达时标为“待人工确认 CRM 配置”；
- 门店准备：有门店时标为“待人工确认库存、物料与人员准备”。

`ready_for_launch` 只在所有适用门禁为 `passed` 或 `not_applicable` 时出现。由于 demo 没有外部系统和人工确认写入，涉及审批、CRM、库存、物料与培训的门禁不会自动通过。首批 UI 通常显示“待上线确认”，这是准确状态，不是功能失败。

## 4. Agent、Skill 与工具

### 4.1 Skill 路由

新增基线 `campaign-orchestrator`：每个模型回合都先读取，负责活动父层、多轨路由、动态执行轨、先补什么信息以及不伪造外部执行。

现有 `campaign-sop` 改为 ICS-1811 专项，只在以下情况叠加：

- 活动类型需要交易优惠；
- 用户正在补充或修改优惠、货类、门店、结算等 1811 信息；
- 用户询问 1811 录入或填写值。

其他专项 Skill 保持按需叠加：`offer-entry-guide`、`field-explainer`、`settlement-guide`、`promo-copy-guide`。所有规则仍要求仓库出处标记、静态校验与 Git 评审。

### 4.2 新增和调整的工具

新增两个工具：

1. `update_campaign_brief`：写入目标、受众、主题、渠道。每项必须携带本轮原话；代码校验 quote 是用户原话子串，文本值直接使用 quote，渠道由代码解析。
2. `analyze_campaign_plan`：返回活动类型、Brief 缺项、动态轨道、门禁和 1811 artifact 状态，不修改草稿。

原工具调整：

- `analyze_campaign_state` 明确只分析 1811 子流程；
- `generate_ics1811_sheet` 的成功语义改成“1811 填写值已准备”，不再代表整个活动完成；
- `draft_promo_copy` 升级为传播方案创意输入，仍须先加载 `promo-copy-guide`；
- 所有活动业务工具在 `campaign-orchestrator` 加载前都被门禁拒绝；1811 专属工具还要求 `campaign-sop`。

Agent 可以在同一回合并行组织需要的分析，但事实写入仍逐个经过确定性工具。编排器仅在模型漏跑安全分析时补跑，并在轨迹中标记“系统补跑”。

Agent 协议保持最小权限：请求携带父层 Brief、路由、门禁摘要和可选的当前 1811 子任务；结果只返回工具实际改过的 Brief、传播创意和当前子任务。Workers 把结果合并回父对象，父 id、兄弟任务和人工门禁不能被模型覆盖。品牌或会员活动即使没有 1811 子任务，也必须走真实 harness，通过父层工具完成分析和对话。

### 4.3 对话行为

- 首句先提取 Brief 与活动事实，再分析整体计划。
- `unknown`、品牌或会员活动优先补 Brief 缺项，不再进入 1811 全量追问。
- 需要 1811 时，现有确定性缺项目录继续控制优惠子流程的问题。
- 一轮最多自然地问 1–3 个当前最关键问题；不引入固定轮数或固定 wizard。
- 1811 就绪时回复“1811 填写值已准备”，同时说明它只是子流程。
- Brief 达到传播起草门槛后，界面持续提供“生成传播方案”；已有方案后改为“查看/继续完善”，入口不消失。

## 5. 传播方案

### 5.1 数据结构

传播创意落在父 `CampaignDraft` 中，事实部分由代码每轮渲染：

```ts
type CommunicationCreative = {
  concept: {
    headline: string;
    subheadline: string;
    coreMessage: string;
  };
  channelOutputs: Array<{
    channel: CampaignChannel;
    format: string;
    copy: string;
    cta: string;
  }>;
  visualDirection: string;
  source: "ai" | "user";
};
```

最终 `CommunicationPlan` 由创意输入加确定性事实生成：目标、受众、主题、活动时间、适用门店、优惠力度、用户提供且已法务确认的标语，以及发布前检查提示。

### 5.2 生成门槛与守卫

生成至少需要：

- 目标；
- 受众；
- 主题；
- 至少一个渠道；
- 如活动含交易优惠，优惠、货类、日期和适用范围必须来自事实层。

模型不能编造赠品、抽奖、明星、稀缺数量、折扣、日期、门店、目标人群或已审批状态。创意文字中的数字继续使用 allowed-numbers 守卫；渠道必须属于用户已确认的渠道。活动标语仍只能照抄用户提供且已法务确认的原文。

传播方案是“运营草稿”，状态最多为 `needs_review`；没有真实法务或品牌审批接口时不显示“已通过”。

## 6. 服务端流程和兼容性

1. `createSession` 创建 `campaign/v1` 父 draft；确定性初筛命中交易优惠时创建一个 1811 子任务，否则任务数组为空。
2. `runTurn` 调模型前生成整体 workspace，把父层上下文和当前可选子任务交给 Agent；`AgentRequest.phase` 使用活动父层阶段。
3. 模型返回后，Workers 只合并受控的 Brief、传播创意和当前子任务，再重算所有 artifact 与 workspace。
4. 没有 1811 子任务时，`Snapshot.latest.ics1811` 为 `null`；界面显示“不适用”，不造一份空填写值欺骗旧组件。
5. 1811 专属消息带可选 `taskId`；问题、提议和填写值按任务作用域读取。旧消息没有 `taskId` 时只归唯一的 legacy 子任务。
6. `ics_orders_json` 兼容旧单份 `FillSheet` 与按 `taskId` 保存的 `campaign-outputs/v1` 映射，不改数据库表。
7. 会话数据库状态暂保留 `collecting | confirmed`；UI 将 `confirmed` 安全显示为“1811 已就绪”，不再映射为“活动已建好”。整体 stage 只从 Snapshot workspace 展示。
8. 旧 `ics1811/v1` 在读取时无损包装；更早的旧营销方案结构仍返回 410。

## 7. 界面设计

保留聊天为主、右栏为工作台的三栏结构。右栏顶层改成五个 tab：

1. `Brief`：显示活动类型、目标、受众、主题、渠道、缺项与原话出处。
2. `执行`：动态轨道卡片，展示状态、当前产物、依赖、下一动作和责任角色。
3. `上线检查`：汇总 blocker 与待人工确认项，明确说明 demo 未连接外部系统。
4. `传播方案`：持续入口与完整产物；各渠道块可复制，已有方案后可继续对话完善。
5. `1811`：复用当前填写值、修改、待确认、校验和版本内容；不适用时说明原因。

全局措辞同步调整：

- “1811 AI 工作台”改为“营销活动 AI 工作台”；
- 顶栏按钮“填写值”改为“活动工作台”；
- “活动建好了”改为“1811 填写值已准备”；
- 填写值 banner 明确“是否可上线请以上线检查为准”；
- 会话列表的 `confirmed` 改为“1811 已就绪”。

桌面与移动端继续复用同一个工作台组件；流式正文、真实工具轨迹、消息时间和文本选择行为不回退。

## 8. 错误处理与安全边界

- Brief 写入 quote 不在本轮原话中：拒绝该项，不污染版本。
- 活动类型仍未知：保持 briefing，询问目标/受众/主题，而不是默认为优惠活动。
- 1811 不适用：artifact 标为 `not_applicable`，不产生填写值消息，不阻断其他轨。
- 传播缺核心 Brief：工具返回具体缺项，Agent 继续追问，不生成空洞模板。
- 模型漏调总体分析：编排器补跑 `analyze_campaign_plan` 并留下真实轨迹。
- 任何外部准备项没有证据：标记 `needs_confirmation`，不得自动通过。
- Agent 失败：沿用现有可重试错误路径，本轮 draft 不落版本，用户输入保留。

## 9. 测试与验收

### 9.1 自动化测试

- `campaign-brief.test.ts`：原话写入守卫、渠道解析、旧 draft 兼容。
- `campaign-workspace.test.ts`：旧 draft 稳定包装、多轨路由、0/1 子任务、动态轨道、1811 不适用、门禁聚合和整体 stage。
- `agent-tools.test.ts`：两个新工具、传播生成门槛、Skill 门禁、无写入副作用。
- `skills.test.ts`：基线 `campaign-orchestrator`、按需 `campaign-sop` 与来源校验。
- `conversation.test.ts`：优惠活动仍生成填写值；品牌活动不再被拒绝；1811 就绪不等于活动可上线；Agent 不能覆盖父层或兄弟任务；任务作用域不串提议；传播方案完整落库并从事实重算。
- `promo.test.ts`：多渠道传播结构、数字/权益守卫、标语和硬事实边界。
- 纯 UI view-model 测试：状态标签、默认 tab、传播入口 `generate | view | continue | disabled`。

### 9.2 人工验收

1. 一句完整优惠活动：真实加载两个 SOP、分析并生成 1811；界面只说“1811 填写值已准备”。
2. 新品发布活动：进入品牌活动 Brief，显示策略与传播轨，1811 标为不适用且不追问让扣点等字段。
3. 会员优惠活动：同时显示会员、传播和 1811 轨，互不冒充已经执行外部系统动作。
4. 生成传播方案：走标准 text turn，工具轨迹与正文真实流式；完成后自动打开传播页签。
5. 缺目标或受众时点生成：Agent 明确追问缺项，不输出低质量模板。
6. 已有传播方案：入口仍可查看和继续完善。
7. 宽屏、窄屏都能使用五个 tab；消息时间、选择复制、版本恢复和填写值出处跳转保持可用。

## 10. 发布约束

- 所有 Skill 规则必须来自本文、现有代码或仓库引用资料，并逐条标 `[S#]`。
- 先写失败测试，再实现；每一批都运行 Node 24 下的 focused tests。
- 最终运行 `npm test`、两套 TypeScript 检查、lint 和 build。
- 不修改生产连接声明，不加入伪延时、假工具轨迹或假审批结果。
