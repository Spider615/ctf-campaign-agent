# 对话式活动流程改造设计

> 基线文档：`2026-09-15-ctf-campaign-agent-design.md`（下称「原设计」）。原设计的 §0 硬约束、§3 领域模型、§7.1 十七条校验、§8 LLM 硬规则全部继承；本文有意偏离之处全部列在 §12。本文替换原设计 §4 的交互形态，并补充对话持久化与侧边栏页面。

## 0. 为什么改

| 用户反馈 | 根因 |
|---|---|
| 输入框默认有一句话 | `campaign-agent.tsx` 把示例句子写成了输入框初始值，与 placeholder 同文 |
| ICS 草稿是什么、菜单点不了 | 名词无解释；侧边栏 5 项中 4 项没有点击行为也没有页面 |
| 侧边栏只有「营销活动」能点 | 同上 |
| 需要对话过程，不要全是表单 | 实现偏离原设计 §4.1.1：一句话 → 整页表单 → 结果页，Agent 从不说话、从不追问，用户原话提交后即消失 |

## 1. 范围

**本轮做**

1. 对话推进主流程：Agent 回读理解、按主题逐个追问、生成方案、对话修改，全部发生在对话区。
2. 右侧「活动草稿」面板：随对话实时更新的结构化视图，可直接改字段，但不是必经步骤。
3. 侧边栏每一项可用：活动记录、码表与证据、待确认清单。
4. 对话全程持久化，刷新或重开可恢复。
5. 「看一个完整示例」「沿用最近的活动」两个起步方式。
6. 输入框初始为空，只显示 placeholder。
7. 理解与修改请求携带当前日期，但日期数字必须出自用户原话（§4.8）。

**本轮不做**

- 「从被拒的改」（1815 修改路径）。
- 全局 ICS 草稿列表（ICS 草稿只在单个活动的草稿面板里）。
- 让模型生成或润色提问措辞。
- 原设计表单中未实现的字段：节点当年公历日期、长期活动子档期切法、衡量指标与目标值、品牌线与审批流的提问。它们在草稿面板中只读展示。
- 多批次：对话与面板只编辑第一个批次。
- 按件数或克重设门槛、优惠类型编号（`offerType`）的设置：面板中只读显示为待界面选择。
- 以旧换新换购、赠品兑换、券核销三种机制的让利参数采集（写入待界面选择，§4.3）。
- 让扣点、回款率的「门店 × 业务大类」粒度（仍为活动级单值）。

## 2. 验收标准

| 编号 | 标准 | 判定方式 |
|---|---|---|
| A1 | 从 `/` 进入示例到出现方案卡片，只操作对话区（点选项或打字） | E2E，开发服务器设 `CAMPAIGN_FAKE_MODEL=1`；所有点击与输入的定位限定在 `data-testid="chat"` 元素内；最终出现方案卡片 |
| A2 | 第一句话中有依据地给出的字段，Agent 不再对其提问 | 服务端集成测试：假模型对「母亲节全国线上黄金类满 3000 减 300，不叠加，不限会员，让扣点 0.1，回款率 0.95」返回对应字段，首轮提问不含顾客动作、让利、层级、渠道、业务大类、叠加、会员、让扣点、回款率 |
| A3 | 每条提问消息只属于一个主题，且只列出该主题当前适用且缺失的字段 | 单测 |
| A4 | 刷新 `/c/:id` 后与刷新前一致 | E2E：消息条数、最后一条消息的类型与内容、草稿面板各字段值、版本条数一致 |
| A5 | 侧边栏每个可点击项都进入一个有实际内容的页面 | E2E：逐项点击，页面标题与主体内容存在 |
| A6 | `/` 加载时输入框值为空，placeholder 可见 | E2E |
| A7 | 示例建会话，以及任何 answer、skip、undo、rollback 回合，模型调用次数为 0 | 服务端集成测试（假模型计数） |
| A8 | 理解与自由输入的 prompt 含当日日期 | 单测 |
| A9 | 模型推断但无原话依据的顾客动作、市场、渠道、业务大类，一律记为待确认并被提问 | 单测（来源判定）+ 集成测试（首轮提问包含对应主题） |
| A10 | 不建 ICS 单的活动（只看到或无让利）不被追问让利参数、市场、渠道、让扣点、回款率，且能到达就绪 | 集成测试 |
| A11 | 「码表与证据」页每个取值都有原文依据 | 单测：`code-tables.ts` 中每个取值的 `raw`，精确出现在 `ppt-field-extraction.json` 中同一 slide 条目某字段的 `enum_values` 里；`year` 非空时，能在 `research-gaps.json` 的截图代际或该条目内的日期中找到依据 |
| A12 | 原设计验收 1、2、3、6、8 继续成立；验收 5、7 按 §12 修订后的口径成立 | `npm test`、`tsc --noEmit`、`npm run lint`、`npm run build` 通过；对应单测 |

## 3. 页面与路由

| 路由 | 内容 |
|---|---|
| `/` | 新活动空状态 |
| `/c/[id]` | 某个活动的对话 + 草稿面板 |
| `/codes` | 码表与证据 |
| `/open-questions` | 待确认清单 |

`app/layout.tsx` 挂载共享的应用外壳 `app-shell.tsx`（侧边栏 + 主区）。

### 3.1 侧边栏

- 品牌区（保留）。
- 「新建活动」按钮 → `/`。
- 「活动记录」：`GET /api/sessions` 列表。每项显示标题、状态标签、更新时间；当前活动（以 `useParams().id` 为准）高亮；每项有「基于它再建一个」操作（§6.3）。列表为空时显示「还没有活动」。
  - 状态标签：`collecting` → 收集中，`ready` → 待生成，`generated` → 已生成；`noIcs` 为真时另加「无需 ICS」小标签。
  - 刷新时机：`usePathname()` 变化时重新拉取；对话页在会话创建成功与每个回合成功后派发 `window` 事件 `campaign:sessions-changed`，外壳监听后重新拉取。
- 「资料」：码表与证据、待确认清单。
- 底部模型说明（保留）。
- 移动端：抽屉（保留现有实现）。

移除：「营销活动」「ICS 草稿」「历史版本」三个全局菜单项。

### 3.2 空状态 `/`

- 标题：「今天要做什么活动？」
- 说明：「说清由头、范围和优惠，Agent 会边问边帮你把方案和 ICS 开单草稿补齐。」
- 名词解释一行：「ICS 开单草稿：要在周大福 ICS 系统新建优惠活动的界面（编号 1811）里逐条录入的优惠规则清单。本工具不连接 ICS，由你照清单录入。」
- 输入框：初始值为空；placeholder「例如：母亲节华东区线下黄金类满 3000 减 300」。
- 输入框下方起步建议：「看一个完整示例」；有历史活动时再显示「沿用最近的活动」，点开后列出最近 5 个活动供选择。

### 3.3 对话页 `/c/[id]`

- 中间：消息流（`components/ui/message-scroller` + `message` + `bubble`），底部输入框。对话区根元素带 `data-testid="chat"`。
- 右侧：草稿面板。视口 ≥1280px 时固定为 380px 一栏；768–1279px 时默认收起，由顶部「草稿」按钮展开为覆盖层；<768px 时为底部抽屉，由输入框上方的胶囊「草稿 · N 条 ICS · 还差 M 项」打开。
- 会话不存在：显示「找不到这个活动」与「新建活动」按钮。

### 3.4 输入框与请求中状态

- Enter 发送，Shift+Enter 换行；`nativeEvent.isComposing` 为真或 `keyCode === 229` 时按 Enter 不发送。
- 回合请求进行中：禁用发送按钮、所有卡片按钮、面板提交；输入框仍可输入；模型回合在消息流末尾显示「正在理解…」占位气泡。
- 当前存在可交互的提问卡片时，placeholder 换成该主题的打字提示（§4.3）。
- 请求失败（4xx/5xx）时，已输入文字留在输入框中，并在输入框上方显示错误。

## 4. 对话模型

### 4.1 会话状态

每个回合结束后纯派生，不保留粘滞：

- 适用的缺失字段非空，或存在 blocker → `collecting`；
- 否则 `brief.externalName` 为空 → `ready`；
- 否则 → `generated`。

`noIcs` 不是状态，由最新草稿派生（§4.2）。历史数据中 `status = draft` 的会话在读取时按上述规则重算。

### 4.2 来源、适用性与缺失

**来源（`provenance`）在本轮的用法**

- `user`：用户明确给出——原话中有依据（§4.8）、点选、面板填写、明确确认。
- `ai`：仅用于模型推断的 `intent.occasion`（由头分类）与 `audience.segments`（人群）。这两项不是码表、不影响开单与拆单，视为已填，回读中列入「我推断的，不对直接说」。文案（`brief`）没有 provenance 字段，由版本来源区分写入方式。
- `default`：仅限 PPT 明文默认值（周期 0、货品范围 0、转换餐牌 0），不带种子数据中的证据年份。
- `pending`：未知，或模型推断但无原话依据。后者在 `FieldValue` 上加可选属性 `suggested: true`，提问卡片预选该值，面板来源标签显示「待你确认」。

**不建单判定**：`noIcsOrders(draft)` = 顾客动作为「只看到」，或让利机制为「无让利」。

**缺失**：一个适用的必填字段满足以下任一条件即为缺失——值为空（空串、空数组、`null`）；值为「还没定」；`provenance = pending`（含 `suggested`）。让扣点、回款率、支付方式限制另外要求 `provenance = user`。适用性与各字段的缺失条件见 §4.3。

### 4.3 主题

```ts
type TopicId = "action" | "offer" | "scope" | "schedule" | "audience_products" | "operations" | "brief";
```

planner 按 `action → offer → scope → schedule → audience_products → operations` 的顺序，选**第一个有适用缺失字段、且未在跳过中**的主题提问。`brief` 不参与缺失判定、从不提问，但纳入字段路径表、answer 回合与面板编辑。

| 主题 | 字段 | 适用条件 | 缺失条件 | 控件 | 为什么问（按字段） |
|---|---|---|---|---|---|
| action | `intent.customerAction` | 始终 | 还没定或 pending | 单选：只看到 / 参与互动 / 到场 / 留资 / 下单 / 带旧货来换 | 决定要不要在 ICS 开单：只到「看到」就不开单 |
| action | `intent.occasion` | 始终 | pending | 单选 6 项 | 决定方案的叙事和文案口径 |
| offer | `offer.mechanism` | 顾客动作不是只看到 | 还没定或 pending | 单选：无让利 / 以旧换新换购 / 门槛型 / 直接价格 / 赠品兑换 / 券核销 | 决定 ICS 里建哪类优惠规则 |
| offer | `offer.tiers[0]` | 机制为门槛型或直接价格 | 门槛型：无档位，或判断金额为空，或折扣率与减免额都为空；直接价格：无档位，或折扣率与减免额都为空 | 门槛型：判断金额 +「减钱 / 打折」二选一后出现减免额或折扣率；直接价格：「减钱 / 打折」二选一 | 优惠数字只用你给的，我不猜 |
| offer | `offer.stacking` | 机制已定且不是无让利 | 还没定或 pending | 单选：不能叠加 / 可以叠加 | 决定 ICS 里是否计算折上折、能否用券 |
| scope | `scope.level` | 始终 | pending | 单选：全国 / 区域 / 分区 / 指定门店 / 电商平台 | 范围层级决定 ICS 里选哪一级 |
| scope | 范围编码 | 层级为区域、分区或指定门店 | 区域：`regionCode` 为空；分区：`divisionCode` 为空；指定门店：`stores` 为空 | 区域、分区：文本框；指定门店：多行输入，每行「行号 行名」 | 每个范围单元单独开单 |
| scope | `scope.markets` | 非 noIcs | 空或 pending | 多选：内地 / 港澳 | 每个市场单独开单 |
| scope | `scope.channels` | 非 noIcs | 空或 pending | 多选：线下 / 线上 | 线上、线下在 ICS 里是两条单 |
| schedule | `schedule.batches[0].startDate`、`endDate` | 始终 | 任一为空 | 两个日期输入 | ICS 不接受没有结束日期的活动 |
| audience_products | `audience.segments` | 始终 | 空 | 多选：家庭赠礼客群 / 婚嫁客群 / 悦己自购客群 / 存量会员 / 到店游客，并入草稿中已有取值；另有「其他」文本框 | 按场合、关系、身份描述，不按年龄性别 |
| audience_products | `products.categories` | 始终 | 空或 pending | 多选：镶嵌类 / 素金类 / 黄金类 / 赠品 | 决定 ICS 里选哪些货类 |
| audience_products | `audience.membership` | 始终 | 还没定或 pending | 单选：不限 / 限；选「限」时出现范围描述文本框 | 限会员时要在 ICS 界面勾选会员级别 |
| operations | `operations.concessionRate`、`collectionRate` | 非 noIcs | provenance 不为 user | 两个数字输入；有上次值时另有「沿用上次（x / y）」按钮一键填入 | 门店合约参数，AI 推不出来；0 也合法，但要你明确给 |
| operations | `operations.paymentRestricted` | 非 noIcs | provenance 不为 user | 单选：不限制 / 有限制 | 有限制时要在 ICS 界面勾选支付方式 |
| brief | `title`、`brief.externalName`、`icsName`、`content`、`slogan` | — | 不参与 | 文本框 | — |

**机制为以旧换新换购、赠品兑换、券核销时**：不采集档位数值；`deriveDraft` 保证恰好一个档位，数值全为空，标签为「{机制}（细节需在 ICS 界面填写）」，并在 `unresolved` 写入代码常量条目「让利细节需在 ICS 界面填写」。

**打字提示**：action「也可以直接打字，例如：顾客下单才算」；offer「例如：满 3000 减 300，不和券叠加」；scope「例如：华东区线下，内地」；schedule「例如：5 月 4 日到 5 月 10 日」；audience_products「例如：给妈妈买礼物的人，黄金类，不限会员」；operations「例如：让扣点 0.12，回款率 0.98，支付方式不限」。

**卡片提交规则**

- 卡片只列出本主题适用且缺失的字段，「为什么问」只显示这些字段的说明。
- 只含一个单选字段的卡片：点选即提交。
- 其他卡片：有「确定」按钮，卡片内全部字段有值时才可用；有依赖的控件逐步出现（如先选机制再出现档位）。
- 卡片不提供「还没定」选项；每张卡片有「先跳过」。
- 面板「改」可只提交单个字段。

**跳过**：`user_skip` 消息记录 `atSeq`（跳过时的最新版本号）。主题「跳过中」当且仅当：存在该主题的 `user_skip`；其后没有该主题的 `user_answer`；且最新草稿中该主题字段的值与 `atSeq` 版本相同。推导在 `planner.ts`，输入为消息与版本。

**上次值（operations 的「沿用上次」）**：上次值不写进草稿。planner 即将发出 operations 提问时，由 `turns.ts` 查询并放进 `agent_question.prefill`：

- 示例会话（`entryMode = example`）：使用代码常量 `{ concessionRate: 0.12, collectionRate: 0.98, source: "演示数据" }`，不查数据库。
- 其他会话：仅当业务大类恰好 1 个时，按键（范围键，业务大类）查询 `store_constant`；多个大类时不预填。
- 范围键：区域 → `区域:` + `regionCode` 去掉括注后 trim；分区 → `分区:` + `divisionCode` 同上；指定门店 → `门店:` + 第一家门店行号；全国、电商平台 → 层级名。
- 点「沿用上次」只填入输入框，仍需「确定」提交，写入 `provenance = user`。

### 4.4 回合输入

所有回合走 `POST /api/sessions/[id]/turns`：

```ts
type TurnInput =
  | { type: "text"; text: string; expectedSeq: number }
  | { type: "answer"; topic: TopicId; values: AnswerValues[TopicId]; origin: "chat" | "panel" | "tool"; expectedSeq: number }
  | { type: "skip"; topic: TopicId; expectedSeq: number }
  | { type: "generate"; expectedSeq: number }
  | { type: "undo"; versionSeq: number; expectedSeq: number }
  | { type: "rollback"; seq: number; expectedSeq: number };

type Tier = { thresholdAmount: number | null; discountRate: number | null; amountOff: number | null };

type AnswerValues = {
  action: { customerAction?: "只看到" | "参与互动" | "到场" | "留资" | "下单" | "带旧货来换"; occasion?: OccasionType };
  offer: { mechanism?: Exclude<OfferMechanism, "还没定">; tier?: Tier; stacking?: "是" | "否" };
  scope: {
    level?: "全国" | "区域" | "分区" | "指定门店" | "电商平台";
    regionText?: string;
    divisionText?: string;
    stores?: Array<{ code: string; name: string }>; // 客户端解析后提交
    markets?: Array<"内地" | "港澳">;
    channels?: Array<"线上" | "线下">;
  };
  schedule: { startDate?: string; endDate?: string };
  audience_products: { segments?: string[]; categories?: Array<"镶嵌类" | "素金类" | "黄金类" | "赠品">; membership?: "不限" | "限"; membershipDescription?: string };
  operations: { concessionRate?: number; collectionRate?: number; paymentRestricted?: boolean };
  brief: { title?: string; externalName?: string; icsName?: string; content?: string; slogan?: string };
};
```

**answer 取值校验**（不合法返回 400，不落库）：至少一个字段；枚举在允许集合内；数字为有限数；`0 < discountRate ≤ 1`；`amountOff ≥ 0`；`thresholdAmount > 0`；同一档折扣率与减免额不同时非空；日期为 `YYYY-MM-DD` 且开始不晚于结束（本次提交与草稿现值合并后判断）；文本 trim 后非空，文案类不超过 200 字、活动内容不超过 500 字；门店每项 `code` 匹配 `/^[A-Za-z0-9-]+$/`、按 code 去重、`name` 非空。

**门店多行输入的客户端解析**：逐行 trim，空行忽略；以第一个半角或全角空白分成 code 与 name；任意一行不合法时卡片内提示并禁止提交。

**answerToOps 规则**

- `provenance` 一律为 `user`，并清除 `suggested`。
- scope：按层级写入对应编码字段，同时把 `regionCode`、`divisionCode`、`rowCode`、`stores` 中其余三项置空；本轮不使用 `rowCode`；区域、分区文本追加「（请在生产界面选择）」。
- offer：草稿无档位时生成 `add /offer/tiers/0`（完整 OfferTier，`id`、`label` 由代码生成）；有档位时 replace 叶子。
- brief：写入对应文案字段。

**undo**：要求 `versionSeq` 等于最新版本号，否则 409；把第 `versionSeq - 1` 版的草稿作为新版本写入。
**rollback**：把第 `seq` 版的草稿作为新版本写入。
**expectedSeq**：与最新版本号不一致时返回 409，客户端重新拉取快照并提示「页面已更新，请重试」。

新会话的第一句话不走 turns，走 `POST /api/sessions`（§6）。

### 4.5 回合的服务端流程

1. 读取会话、最新版本、消息；会话不存在返回 404；校验 `expectedSeq`。
2. 构造用户消息：`text` → `user_text`；`answer` → `user_answer`（`label` 为可读摘要，如「不能叠加」；`origin = panel` 时界面渲染为「你在草稿里改了 X」）；`skip` → `user_skip`（带 `atSeq`）；`generate`、`undo`、`rollback` → `user_event`。
3. 计算新草稿：
   - `answer`：校验 → `answerToOps` → 应用。
   - `text`：调模型（§5.2）→ 守卫（§5.3）→ 应用通过守卫的 ops（可能为空）。模型调用失败时，本回合只写用户消息与 `agent_error`（`retry: {type: "text", text}`）。
   - `skip`：不改草稿。
   - `generate`：前置条件为「适用缺失为空且无 blocker」，否则 409。调模型 → `parseGeneratedCopy` → 写入 `/brief` → `deriveDraft` → 拆单 → 校验。若出现路径在 `/brief` 下的 blocker，把 blocker 回喂模型重新生成，最多再 2 轮；仍有 blocker 则不产生版本、不改状态，发出 `agent_blockers` 与 `agent_error`（`retry: {type: "generate"}`）。只剩 R3 warning 时保留并在方案卡片上标出。模型调用失败同样发出带 generate 重试的 `agent_error`。
   - `undo`、`rollback`：取目标版本草稿。
4. `next = deriveDraft(prev, next)` → `buildIcsDrafts` → `validateDraft` → `diffDrafts(prev, next)` 并按 §4.7 归并。
5. diff 非空时追加 `draft_version`；`text`、`answer` 回合且有 ops 时同时写 `patch`（`source`：text 为 `ai`，answer 为 `human`；undo、rollback 版本 `created_by = rollback`；generate 版本 `created_by = ai`）。
6. 按 §4.6 生成 Agent 消息。
7. 更新 `session.status`；`title` 规则：建会话时取理解结果 `summary`（最多 28 字，示例与复制见 §6）；首次 generate 成功后改为 `brief.externalName`；之后仅在 brief 回合修改 `title` 时变化。更新 `updated_at`。
8. generate 成功，且非 noIcs、operations 三个字段均为 `user`、`entryMode ≠ example`、业务大类恰好 1 个时，upsert `store_constant`。
9. 第 2–8 步全部写入放在一次 D1 `batch` 中（D1 batch 为原子事务）。唯一约束失败（含 `idx_version_session_seq`）返回 409，其他 D1 错误返回 503，整体不落库。

### 4.6 Agent 消息编排

一个回合的 Agent 消息按下列顺序组成，各项可叠加：

1. `text` 回合且守卫保留了 `reply` → `agent_text`（reply）。
2. diff 非空 → `agent_change`（undo 标题「已撤销」，rollback 标题「已恢复到版本 N」，其余「记下了」或「改了 N 处」）。
3. `text` 回合有被守卫丢弃的 op → `agent_text`：「{字段名} 没能从你的话里确定，请点选或说得具体些。」；ops 全部为空且无 reply → `agent_text`：「这句我没对上要改哪一项。」
4. 本回合（或建会话时）`noIcsOrders` 由假变真 → `agent_no_ics`（说明理由：只看到时「顾客动作只到品牌曝光，报名、互动、到场由 CRM 或活动系统承接」；无让利时「没有成交优惠，ICS 只覆盖成交规则」）。
5. generate 成功 → `agent_plan`，结束。
6. 否则按以下第一个满足的条件发出一条：
   1. 有适用缺失、且未跳过的主题 → 该主题的 `agent_question`。若上一条 Agent 消息是同主题、同缺失字段的提问且本回合无 diff，则不重发。
   2. 适用缺失的主题全部在跳过中 → `agent_skipped_summary`（卡片内按主题内联渲染提问控件，提交走 answer 回合）；与上一条汇总相同且本回合无 diff 时不重发。
   3. 缺失为空但有 blocker → `agent_blockers`（列出全部 blocker；每条按路径前缀映射到主题并附「去改」，打开该主题控件走 answer 回合；映射不到主题的只给文字）；与上一条相同且本回合无 diff 时不重发。
   4. 缺失为空、无 blocker、`brief.externalName` 为空 → `agent_ready`（拆单数、因子、待界面选择的项、「生成活动方案」）；与上一条相同时不重发。
   5. 缺失为空、无 blocker、`brief.externalName` 非空、本回合 diff 含 `/brief` 与 `/title` 以外的路径 → `agent_regenerate_offer`。
7. 缺失非空时，若本回合新出现了路径不属于任何缺失字段的 blocker，在第 6 步消息之前追加 `agent_blockers`（仅列这些新 blocker）。

### 4.7 消息存储

`message.content` 存 JSON；`role` 为 `user` 或 `assistant`。旧数据为纯文本时按原 `role` 解码为 `user_text` 或 `agent_text`。读取一律 `ORDER BY created_at, rowid`；内存存储按插入顺序返回。`produced_version_id` 写在触发该版本的用户消息上。

```ts
type StoredMessage =
  | { v: 1; kind: "user_text"; text: string }
  | { v: 1; kind: "user_answer"; topic: TopicId; label: string; values: Record<string, unknown>; origin: "chat" | "panel" | "tool" }
  | { v: 1; kind: "user_skip"; topic: TopicId; atSeq: number }
  | { v: 1; kind: "user_event"; event: "generate" | "undo" | "rollback"; label: string }
  | { v: 1; kind: "agent_readback"; stated: ReadbackItem[]; inferred: ReadbackItem[]; uncertain: string[]; derivedType: string }
  | { v: 1; kind: "agent_question"; topic: TopicId; title: string; fields: Array<{ key: string; label: string; why: string }>; prefill?: { concessionRate: number; collectionRate: number; source: string } }
  | { v: 1; kind: "agent_change"; title: string; items: Array<{ label: string; before: string; after: string }>; versionSeq: number }
  | { v: 1; kind: "agent_blockers"; issues: Array<{ ruleId: string; message: string; path: string; topic?: TopicId }> }
  | { v: 1; kind: "agent_skipped_summary"; topics: TopicId[] }
  | { v: 1; kind: "agent_no_ics"; reason: string }
  | { v: 1; kind: "agent_ready"; total: number; factors: SplitFactors; pendingUi: string[] }
  | { v: 1; kind: "agent_regenerate_offer" }
  | { v: 1; kind: "agent_plan"; versionSeq: number; brief: CampaignBrief; total: number; readyOrders: number; blockedOrders: number; warnings: string[] }
  | { v: 1; kind: "agent_text"; text: string }
  | { v: 1; kind: "agent_error"; text: string; retry?: { type: "text"; text: string } | { type: "generate" } };

type ReadbackItem = { label: string; value: string };
```

**可交互规则**（任何回合请求进行中时一律不可交互）

- `agent_question`：是消息流中最后一条 `agent_question`，且其主题当前仍有适用缺失；否则只读显示问题标题。
- `agent_skipped_summary`、`agent_blockers` 的「去改」、`agent_ready`、`agent_regenerate_offer`、`agent_error` 的重试：是最后一条 Agent 消息时可用。
- `agent_change` 的「撤销」：`versionSeq` 等于最新版本号时可用；否则显示「之后已有修改，可在版本页签恢复」。

**diff 归并**（用于 `agent_change.items` 与版本 `diffCount`）：叶子 diff 归并到字段路径表中的字段；`FieldValue` 的 `value`、`provenance`、`suggested` 合并成一项；数组整体算一项；档位以一档为单位。只有来源变化时显示为「确认：{含义} {值}」。`label` 取字段路径表的「含义」；值按类型格式化：数组用顿号连接，档位写「满 X 减 Y」「满 X 打 N 折」「N 折」「减 Y 元」，`null` 写「未填」。不在路径表中的派生字段（`derivedType`、`activityGroup`、`couponAllowed`、档位 `label`）不单独展示。

**版本来源显示**（草稿面板版本页签、快照 `versions[].source`）：通过 `produced_version_id` 反查触发消息——`user_text` → 对话修改；`user_answer`（chat 或 tool）→ 选项回答；`user_answer`（panel）→ 草稿手改；`user_event` generate → 生成文案；`user_event` undo 或 rollback → 版本恢复；版本 1 → 初始。

### 4.8 回读与来源判定

**`agent_readback` 分三块**：你说的（`provenance = user` 的字段，以及 `intent.reason` 原话摘录）；我推断的，不对直接说（`ai` 字段、`pending + suggested` 字段、派生的活动类型判断）；我还不确定的（理解结果的 `unresolved`）。回读之后同一回合紧跟 §4.6 的后续消息。

**来源判定**（确定性，不依赖模型自报；用于第一句话理解，以及自由输入中不属于当前提问主题的字段）：

| 字段 | 记为 user 的条件 | 不满足时 |
|---|---|---|
| 让利数字（判断金额、折扣率、减免额） | 通过数字守卫（§5.3） | 丢弃 |
| `offer.mechanism` | 门槛型：原话匹配「满 + 数字」且数字通过守卫；直接价格：原话匹配「数字 + 折」或「减 + 数字」且通过守卫；以旧换新换购：含「以旧换新」或「换购」；赠品兑换：含「赠品」或「赠送」；券核销：含「券」；无让利：含「无优惠」「不打折」或「无让利」 | pending + suggested |
| `intent.customerAction` | 机制为门槛型或直接价格且已记为 user，取值为「下单」；机制为以旧换新换购且已记为 user，取值为「带旧货来换」；或取值原文出现在原话中 | pending + suggested |
| `scope.markets`、`scope.channels`、`products.categories` | 每个取值都有依据词出现在原话中：内地「内地」「大陆」；港澳「港澳」「香港」「澳门」；线下「线下」；线上「线上」；黄金类「黄金」；素金类「素金」；镶嵌类「镶嵌」；赠品「赠品」 | 整个字段 pending + suggested |
| `scope.level` 与编码 | 全国：含「全国」；电商平台：含「电商」「天猫」「京东」；区域：区域名（去括注）是原话子串；分区：含「分区」且分区名是原话子串；指定门店：每个行号出现在原话中 | pending（编码丢弃） |
| `offer.stacking` | 含「叠加」「同享」「一起用」「同时用」或「折上折」 | 丢弃（保持缺失） |
| `audience.membership` | 含「会员」 | 丢弃 |
| `operations.concessionRate`、`collectionRate` | 含「扣点」/「回款」且数字通过守卫 | 丢弃 |
| `operations.paymentRestricted` | 含「支付」或「付款」 | 丢弃 |
| 开始、结束日期 | 月与日的数字都出现在原话中（年份按今天补全：若月日早于今天则取下一年） | 丢弃 |
| `intent.occasion`、`audience.segments` | — | 记为 ai |

### 4.9 草稿面板

- 头部：活动名、状态标签、「N 条 ICS 单」及因子（noIcs 时显示「不建 ICS 单」）、「还差 M 项」（点击滚动到当前提问卡片）。
- 页签：
  1. **字段**：按主题分组，另有「文案」组。每行：含义、值、来源标签（你说的 / AI 推断 / 系统默认 / 待你确认 / 待界面选择）、「改」。「改」弹出该主题控件，只提交该字段，走 answer 回合（`origin = panel`）。缺失行高亮；不适用的行显示「不建 ICS 单，无需填写」。未进入提问的字段（品牌线、衡量指标、周内循环日、货品范围、转换餐牌、优惠类型编号、按件数或克重的门槛）只读展示；其中码表类字段（渠道、货品范围、转换餐牌、周期）的证据显示为 `code-tables.ts` 中的「页码 · 截图 · 年份或年份未知」。
  2. **ICS**：顶部说明「每一条 = 要在 ICS 新建优惠活动界面（1811）录入的一条优惠规则」。面板内每条用两行卡片展示（第一行序号与状态；第二行档期、市场渠道、范围、优惠），另有「展开为表格」打开全宽覆盖层显示完整表格。「复制清单」「下载证据包」沿用现有实现。
  3. **待选**：`unresolved` 列表（沿用现有实现）。
  4. **校验**：十七条规则结果（沿用现有实现）。
  5. **版本**：版本列表，含来源（§4.7）、归并后的 diff 条数、「恢复此版本」（走 rollback 回合）。

### 4.10 示例对话

用户消息固定为「母亲节华东区线下黄金类满 3000 减 300」，理解结果为代码内置的固定字段（不调模型）：由头分类日历节点、`reason` 母亲节送礼、机制门槛型、判断金额 3000、减免额 300、顾客动作下单、区域华东区、渠道线下、业务大类黄金类、人群「家庭赠礼客群」、市场内地。经 §4.8 判定后：

- 你说的：机制与档位、顾客动作、区域（层级区域）、渠道、业务大类、由头原话；
- 我推断的：由头分类、人群、市场内地（待你确认）；
- 提问顺序：offer（叠加）→ scope（确认市场）→ schedule（档期）→ audience_products（会员）→ operations（以演示常量「沿用上次」）→ 就绪。

之后的问答、生成、修改全部走真实回合。生成文案调用模型（E2E 下为假模型），失败时显示错误与重试，不回退到预置文案。

## 5. 模型调用

### 5.1 第一句话理解

在现有 `interpretationSystemPrompt` 基础上：

- 写入「今天是 YYYY-MM-DD（北京时间）」，只用于补全年份；明确要求：原话中没有具体月日时不得输出日期，节日名与「下个月」类说法写入 `unresolved`。
- `InterpretationFields` 增加 `stacking`、`membership`、`membershipDescription`、`scopeLevel`、`divisionText`、`stores`、`concessionRate`、`collectionRate`、`paymentRestricted`，prompt 同步列出取值集合；删除「未提供的会员限制和叠加规则写入 unresolved」的示例表述。
- 解析结果经 §4.8 来源判定后交给 `mergeInterpretation(text, interpretation, today)`，以 `createEmptyDraft()` 为基底（§6.1），不再以母亲节种子为基底，不再静默填入让扣点、回款率、支付方式。

### 5.2 自由输入回合

prompt 输入：

1. `sharedRules` 与原设计 §8 全部硬规则（补上效果口径禁令、归因禁令、活动名两套口径、标语进法务清单、数据集外品类先做前置校验）；
2. 今天日期（同 §5.1 的日期规则）；
3. 当前草稿 JSON；
4. 当前可交互提问的主题与字段（如有）；
5. 字段路径表：路径 → 含义 → 取值类型或枚举，由 `topics.ts` 生成，是模型可写路径的唯一来源；
6. 名词表：ICS、1811、1815、1816、开单、拆单、叠加与折上折、只看到、待界面选择、让扣点、回款率。每条解释必须摘自 `references/` 或原设计文档；找不到出处的名词只写「运营按合约填写的业务参数」，不自行解释；
7. 用户原话。

输出 `{ ops: [{ op, path, value, reason }], reply?: string }`。`reply` 用于用户在提问而非提供信息时的简短回答。

### 5.3 自由输入守卫

1. **路径**：只接受字段路径表中的叶子路径。`FieldValue` 字段写到字段本身（如 `/offer/stacking`），`value` 为原始值，由守卫包装成 `{value, provenance}`。档位只允许：`replace /offer/tiers/{i}/{thresholdAmount|discountRate|amountOff}`；`add /offer/tiers/{n}`（n 等于当前档数，value 只含这三个键，`id`、`label` 由代码生成）；`remove /offer/tiers/{i}`（i ≥ 1）。禁止整体写入 `/offer`、`/offer/tiers`、`/offer/tiers/{i}` 等对象或数组。沿用现有内部码表路径黑名单。
2. **数字**：递归检查 `value` 中所有数值叶子，每个都必须出现在本回合原话中；可接受写法为 v、v×10、v×100，各自四舍五入到 4 位小数、去掉末尾的 0 后按字符串比较（去掉原话中的千分位逗号）。
3. **来源**：属于当前可交互提问主题的字段，通过类型校验即接受，记为 `user`；其他字段按 §4.8 判定，不满足则丢弃该 op 并在 §4.6 第 3 步说明。`/brief` 与 `/title` 下的文案修改无需依据。
4. **类型**：`value` 按字段路径表声明的枚举与类型校验，不合法的 op 丢弃。
5. **还没定**：取值为「还没定」的 op 不应用；若属于当前提问主题，本回合追加该主题的 `user_skip`。
6. **reply**：不超过 300 字；出现编号码前缀（如「12)」）或效果预估（「提升 / 增长 / 增加」后 6 字内出现「数字 + %」）时丢弃整条 reply，合法 ops 照常应用。
7. **校验**：应用后新增 blocker 时保留改动，由 §4.6 呈现，不回喂模型修正（理由见 §12）。

### 5.4 生成文案

沿用 `generationSystemPrompt` 与 `parseGeneratedCopy`；prompt 同样补上原设计 §8 全部硬规则；发送给模型的草稿为 `createEmptyDraft` 体系下的真实草稿，不含种子遗留字段。blocker 回喂最多 2 轮（§4.5 第 3 步）。

### 5.5 开发用假模型

`turns.ts` 的依赖 `callModel` 在开发构建且环境变量 `CAMPAIGN_FAKE_MODEL=1` 时替换为假实现：文案请求返回固定四个文案字段；其他请求返回 `{ "ops": [] }`。生产构建中该开关无效。

## 6. 会话创建

### 6.1 空草稿

`createEmptyDraft()`：批次标签、衡量指标、让利承担为空；品牌线 `{ value: "", provenance: "pending" }`；周期 `[0]`、货品范围 `0`、转换餐牌 `false` 为 `default` 且不带证据年份；其余 FieldValue 为空值加 `pending`；`tiers = []`；`offerType = null`；让扣点、回款率 `null` + `pending`，支付方式限制 `false` + `pending`。理解、示例、复制都以它为基底。

### 6.2 `deriveDraft(prev, next)`

每个回合应用 ops 后执行，产生的变化计入 diff：

- 顾客动作变为只看到 → 机制 `{无让利, default}`，`tiers = []`，叠加 `{还没定, default}`。
- 顾客动作从只看到改为其他值 → 机制与叠加重置为 `{还没定, pending}`，`tiers = []`。
- 机制为无让利 → `tiers = []`。
- 机制为以旧换新换购、赠品兑换、券核销 → 按 §4.3 保证一个空档位与 unresolved 常量条目；机制离开这三种时移除该常量条目。
- 每档 `label` 按数值重算（门槛型「满 X 减 Y」「满 X 打 N 折」；直接价格「N 折」「减 Y 元」；无数值「待补优惠档位」）。
- `couponAllowed`：叠加为否 → `false`，为是 → `true`，否则 `null`。
- `derivedType`、`activityGroup` 按现有 `mergeInterpretation` 中的映射规则每回合重算。
- `unresolved` 中由代码写入的条目集中定义为常量集合（如「区域编码需在 1811 生产界面确认」「让利细节需在 ICS 界面填写」）；模型写入的条目保持原样。

### 6.3 `POST /api/sessions`

| entryMode | 请求字段 | 处理 |
|---|---|---|
| `new` | `text` | 调模型理解（失败返回 502，不建会话）→ `mergeInterpretation` → `deriveDraft` → 版本 1 → `user_text` + `agent_readback` + §4.6 后续消息 |
| `example` | — | 固定理解结果（§4.10）→ 同上；模型调用 0 次 |
| `copy` | `fromSessionId` | 读取来源会话最新草稿：新 `id`；标题「原标题 · 新档期」；清空 `brief` 四个文案字段；清空第一批次开始、结束日期；保留其余字段及其 provenance；`unresolved` 只保留代码常量条目。版本 1 → `agent_text`「沿用了《原标题》的范围、让利和门店参数。」（来源为 noIcs 时为「沿用了《原标题》的范围与参数。」）+ §4.6 后续消息 |

返回会话快照，客户端跳转 `/c/[id]` 并派发 `campaign:sessions-changed`。

### 6.4 快照

`GET /api/sessions/[id]`：

```ts
{
  session: { id, title, status, entryMode, noIcs, createdAt, updatedAt },
  messages: Array<{ id, role, createdAt, content: StoredMessage }>,
  versions: Array<{ seq, source, createdAt, diffCount }>,
  latest: { seq, draft, orders, issues },
  plan: { missingTopics: TopicId[], skippedTopics: TopicId[], openQuestionMessageId: string | null }
}
```

turns 接口返回：`{ newMessages, latest, versions, session, plan }`。
`GET /api/sessions` 列表每项：`{ id, title, status, noIcs, updatedAt, versionCount }`，`noIcs` 由最新版本草稿读取时计算。

## 7. 资料页

两页均为服务端组件，不把原始资料打进客户端包。

### 7.1 码表与证据 `/codes`

1. **页首说明**：资料来自《营销活动优惠开单操作指引》（资讯及通讯应用中心、营销管理部业务规划科，文档更新日期 2024/04/22），截图跨 2019–2025 年。
2. **可用码表**（原设计 §3.4 所列 7 项：审批流、货品范围、转换餐牌、活动分组、线上线下、优惠性质、优惠类型名称）：逐个取值列出「取值 / 原文 / 页码 · 截图 / 证据年份」。证据年份按顺序取：`research-gaps.json` 中该截图的代际；否则该截图抽取条目内可见的业务日期年份；两者都没有时显示「年份未知（PPT 更新于 2024/04/22，截图跨 2019–2025）」，不得省略。取值整理在 `app/lib/reference/code-tables.ts`，每项为 `{ label, raw, slide, image, year: number | null }`，`raw` 为原文逐字（保留繁体与编号前缀）。
3. **不可用码表**（会员级别、售价类型、货类、货类明细、品牌、支付方式、区域类）：每项写不可用原因（取自原设计 §3.4）与产品处理方式（输出业务意图、界面待选）。
4. 不逐页铺开 `ppt-field-extraction.json` 的抽取记录。

### 7.2 待确认清单 `/open-questions`

列出需要周大福确认的事项，整理在 `app/lib/reference/open-questions.ts`：原设计 §12 的 8 项，加上本文 §13 的第 4、5 项。每项三栏：**要确认什么** / **不确认会怎样**（对应 demo 中哪一步变成待界面选择，或哪条校验口径未定）/ **找谁确认**（资讯及通讯应用中心或营销管理部业务规划科，依据指引封面署名）。不展示 `research-gaps.json` 中 `gaps` 与 `unverified_claims` 的原文。

## 8. WebMCP

三个工具的名称与输入结构保持不变（对外接口）。工具在 `app-shell.tsx` 中注册一次；会话 id 取 `useParams().id`。`CampaignWebMcpActions` 三个方法改为返回 `Promise`。

- `start_campaign_draft {mode, prompt?}`：`example` → 创建示例会话并跳转；`blank` 且有 `prompt` → 以 `new` 模式创建会话并跳转；`blank` 无 `prompt` → 跳转 `/`。
- `update_campaign_fields {title, externalName, content, slogan, startDate, endDate}`：不在 `/c/[id]` 时返回「当前没有打开的活动」。按字段拆成 `brief` 与 `schedule` 两个 answer 回合（`origin = tool`）顺序提交，第二个回合使用第一个回合返回的最新版本号。
- `read_campaign_summary`：不在 `/c/[id]` 时返回「当前没有打开的活动」；否则返回 `{ status, title, orderCount, noIcs, missingTopics, unresolved, blockers }`。

## 9. 模块划分

**纯逻辑（可单测）**

| 文件 | 职责 |
|---|---|
| `app/lib/campaign/topics.ts` | 主题定义（字段、适用条件、缺失条件、控件描述、为什么问、打字提示）；`missingFields`、`missingTopics`；字段路径表；依据词 |
| `app/lib/campaign/evidence.ts` | §4.8 来源判定、§5.3 数字守卫 |
| `app/lib/campaign/answers.ts` | answer 取值校验与 `answerToOps` |
| `app/lib/campaign/planner.ts` | §4.6 消息编排、跳过推导、状态派生 |
| `app/lib/campaign/messages.ts` | `StoredMessage` 类型、编解码（含旧文本兼容）、可交互判定、diff 归并与格式化、版本来源 |
| `app/lib/campaign/workspace-state.ts` | `createEmptyDraft`、`deriveDraft`、`mergeInterpretation`、示例固定理解结果、代码常量 unresolved 集合 |
| `app/lib/campaign/validator.ts` | R13 改为仅在非 noIcs 时生效 |
| `app/lib/reference/code-tables.ts`、`open-questions.ts` | 资料页数据 |

**服务端**

| 文件 | 职责 |
|---|---|
| `app/lib/server/session-store.ts` | 存储接口（会话、消息、版本、patch、store_constant）；D1 实现通过参数接收 `D1Database`（仅 `import type`）；内存实现供测试 |
| `app/lib/server/turns.ts` | `createSession(input, deps)`、`runTurn(sessionId, input, deps)`；`deps = { store, callModel, today }` |
| `app/lib/server/prompts.ts` | 理解、自由输入、文案三个 prompt |
| `app/lib/server/ai-schemas.ts` | 理解结果解析扩展；自由输入输出解析与 §5.3 守卫 |
| `app/api/sessions/route.ts` | `GET` 列表、`POST` 创建 |
| `app/api/sessions/[id]/route.ts` | `GET` 快照 |
| `app/api/sessions/[id]/turns/route.ts` | `POST` 回合 |

`getDbBinding()` 只在 `route.ts` 中调用。凡会被测试 import 的模块，不得静态或间接 import `db/*` 与 `cloudflare:workers`，不使用 `@/` 别名，相对 import 一律带 `.ts` 扩展名，不使用 enum、namespace、参数属性等 strip-types 不支持的语法。本轮不新增数据库迁移。

删除（在新界面接通并通过验证后执行）：`app/api/agent/interpret`、`generate`、`patch`，`app/api/sessions/[id]/versions` 四个路由；`campaign-agent.tsx`、`start-panel.tsx`、`review-form.tsx`、`result-workspace.tsx` 四个组件。

**界面**

| 文件 | 职责 |
|---|---|
| `app/layout.tsx` + `app/components/app-shell.tsx` | 外壳、侧边栏、活动记录刷新、WebMCP 注册 |
| `app/page.tsx` + `app/components/chat/empty-state.tsx` | 空状态 |
| `app/c/[id]/page.tsx` + `app/components/chat/conversation.tsx` | 对话页状态：快照、发送回合、请求中禁用、409 处理 |
| `app/components/chat/message-view.tsx` | 按 `kind` 渲染消息与卡片 |
| `app/components/chat/question-card.tsx` | 主题控件（对话卡片、跳过汇总、阻断「去改」、面板「改」共用） |
| `app/components/chat/composer.tsx` | 输入框 |
| `app/components/draft/draft-panel.tsx` 及子组件 | 草稿面板；ICS、待选、校验、版本页签从 `result-workspace.tsx` 迁移 |
| `app/components/source-badge.tsx` | 来源标签增加「待你确认」（`suggested`） |
| `app/codes/page.tsx`、`app/open-questions/page.tsx` | 资料页 |

## 10. 错误处理

| 情况 | 处理 |
|---|---|
| text 回合模型网络错误或超时（45 秒） | 写入用户消息与 `agent_error`（重试即以同一文字发起新 text 回合） |
| text 回合模型返回非法 JSON | 不应用任何 ops；`agent_text`「这句我没对上要改哪一项。」 |
| 部分 op 被守卫丢弃 | 应用其余 op；§4.6 第 3 步说明被丢弃的字段 |
| answer 取值不合法 | 400，不落库，卡片内提示 |
| 应用后新增 blocker | 保留改动，§4.6 呈现 |
| generate 前置条件不满足 | 409，客户端刷新快照 |
| generate 模型失败，或回喂 2 轮后仍有 `/brief` blocker | 不产生版本；`agent_error` 带 generate 重试（后者另附 `agent_blockers`） |
| `expectedSeq` 不一致、undo 的 `versionSeq` 不是最新、唯一约束冲突 | 409，客户端刷新快照并提示「页面已更新，请重试」 |
| D1 其他写入失败 | 503，本回合整体不落库；提示「没保存成功，可以重试」，文字留在输入框 |
| 会话不存在 | 404；页面显示「找不到这个活动」与「新建活动」 |
| `new` 模式理解失败 | 502，不建会话，输入框保留文字并显示错误 |

## 11. 测试

**单测（node:test，沿用现有写法）**

- `topics`：空草稿、示例草稿、只看到草稿、无让利草稿、三种非数值机制草稿、复制草稿的适用缺失字段与主题（A3、A10）。
- `evidence`：§4.8 表中每一行的正反例；数字守卫对 0.12 / 12 / 12%、0.85 / 85 折、3,000 的判定（A9）。
- `answers`：每个主题的 ops 与 `provenance = user`；scope 切换层级清空其余编码；无档位时 add；非法取值拒绝。
- `planner`：主题顺序；同主题无 diff 不重发；首句只看到时同回合既有说明也有提问；无缺失但有 R1 时发阻断卡片；跳过推导与汇总不重复；「还没定」转跳过不死循环；就绪与重新生成提议分支；生成后撤销到生成前时发就绪卡片。
- `messages`：编解码往返；旧纯文本兼容；可交互判定；diff 归并与格式化；版本来源反查。
- `workspace-state`：`createEmptyDraft` 不含种子遗留；`deriveDraft` 的「下单 → 只看到 → 下单」后 offer 重新出现、档位标签正确、couponAllowed 映射；`mergeInterpretation` 让扣点为 `null` + pending。
- `validator`：noIcs 时不触发 R13。
- `prompts`：理解与自由输入 prompt 含当日日期（A8）；字段路径表覆盖所有主题字段；名词表条目有出处标注。
- `ai-schemas`：§5.3 各条守卫。
- `code-tables`：A11。

**服务端集成（内存存储 + 假模型）**

- 示例建会话、answer、skip、undo、rollback 回合模型调用 0 次（A7）。
- A2 富信息首句；A9 推断字段被提问；A10 不建单活动到达就绪。
- text 回合：假模型返回合法 ops、部分非法 ops、空 ops、超时。
- generate：成功；首次超时后重试成功；文案含 ASCII 双引号时两轮回喂后仍失败则不落版本。
- `expectedSeq` 冲突、undo 非最新版本、copy 建会话、store_constant 写回条件。
- 写入失败时不产生部分数据。

**E2E（Playwright MCP，开发服务器 + `CAMPAIGN_FAKE_MODEL=1`，验证阶段执行）**

- A1、A4、A5、A6。
- 另用真实模型自己输入一句话走完一次对话，作为冒烟检查并记录结果（不作为验收判定）。

**现有测试的变更**：`campaign-domain.test.ts` 第 132–162 行的理解用例按 §4.8 与 §6.1 改写（`occasion.provenance` 为 `ai`，新增让扣点为 `null` + pending 的断言）；`ai-boundary.test.ts` 的 patch 用例迁移到 §5.3 守卫，保留 `/brief` 可写的断言；其余保持。

## 12. 与原设计的差异

| 原设计 | 本文 | 理由 |
|---|---|---|
| §4.1 四个入口卡片 | 空状态 + 示例、沿用最近；「从被拒的改」本轮不做 | 用户确认本轮不做 1815 路径 |
| §4.1.1、§4.2 生成前表单 | 按主题逐个提问 + 草稿面板；未实现字段只读展示 | 用户反馈「不要全是表单」；原设计本意即对话为主 |
| §3.3 `ai` 只允许文案类 | `ai` 另用于由头分类与人群的推断值；顾客动作、市场、渠道、业务大类的推断值记为待确认 | 由头分类与人群不是码表、不影响开单与拆单；决定开单与拆单的推断值必须经用户确认，保住验收 2、8 |
| §4.2 F 区节点公历日期、§10 农历日期缺失阻断 | 本轮不做该字段；日期数字必须出自原话，否则档期必问 | 以「不推算、必问」达成同一目的 |
| §4.3 patch 先预览再应用 | 直接生效 + 改动卡片 +「撤销」 | 对话中逐句确认会打断节奏；可见性与可回滚性不变 |
| §4.3 校验失败回喂模型最多 2 轮 | 自由输入回合不回喂，呈现冲突；generate 回合保留回喂 | 自由输入改的是用户陈述的业务事实，让模型为过校验去改这些值等于替用户编造；文案由模型生成，回喂合理 |
| §4.4 交付首句 | 就绪卡片 + 方案卡片 | 同一信息拆成生成前与生成后两步 |
| 验收 5「第二次同门店自动预填、不再追问」 | 复制模式不追问；新建模式命中上次值时一键「沿用上次」后确定 | R13 要求让扣点、回款率被明确回答，一次确认是最小代价 |
| 验收 7 与 §0.3「每个枚举值带证据年份」 | 能从资料推出的给出年份；推不出的显式标「年份未知」并附文档日期与截图跨度 | 资料中部分截图无代际与日期依据，编造年份违反 §0.4；显式标注是不编造前提下的最严格做法 |
| R13 让扣点、回款率必须回答 | 仅在建 ICS 单时生效 | 不建单就没有合约参数 |
| 现有实现：让扣点、回款率静默默认 0.12 / 0.98 | 必须由用户确认 | 原设计 R13 与 §10「不默认」 |

## 13. 已知不确定

1. DeepSeek Flash 能否从一句自由输入中稳定抽出多个字段并写对路径，需实测；兜底是提示用户点选项。
2. vinext 对 `app/c/[id]/page.tsx`、共享布局中的客户端组件、服务端组件 import 仓库根目录 JSON 的支持，需在实现第一步验证。
3. 模板化提问在演示中可能有「脚本感」，本轮不引入模型润色。
4. 待周大福确认：以旧换新换购、赠品兑换、券核销各自需要哪些让利参数必填。
5. 待周大福确认：「顾客下单但无让利」的活动是否确实不建 ICS 单。
