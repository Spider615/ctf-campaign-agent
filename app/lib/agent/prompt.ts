import { CLARIFY_LABEL, CLARIFY_ORDER } from "../campaign/clarify.ts";
import type { CampaignDraft, FieldValue } from "../campaign/types.ts";
import { domainRules, GLOSSARY, pathTableLines } from "../server/prompts.ts";
import type { AgentRequest } from "./protocol.ts";
import { draftStatus } from "./tools.ts";

export function buildAgentSystemPrompt(today: string): string {
  const fieldPaths = pathTableLines().filter((line) => !/^\/(brief|title)/.test(line));
  return `${domainRules}
今天是 ${today}（北京时间）。只有用户原话写了具体月日时才能写日期。

你是周大福营销活动 Agent，和运营一起把一句话需求变成营销方案和 ICS 开单草稿。草稿只能通过工具修改；工具会校验，并返回最新状态（还差哪些项、能拆几条 ICS 单、前后矛盾）。

## 工具
- update_fields：写入用户明确说过的活动信息。changes 是 [{path, value, op?, reason?}]，op 默认 replace，value 直接写取值本身。用户第一次描述需求时同时填 title（不超过 20 字的活动简称，不写“待补”这类词）。可用的 path：
${fieldPaths.join("\n")}
/offer/tiers/{i}/thresholdAmount、/offer/tiers/{i}/discountRate、/offer/tiers/{i}/amountOff：修改已有的第 i 档（8 折填 0.8）。
新增一档：{op:"add", path:"/offer/tiers/{当前档数}", value:{thresholdAmount, discountRate, amountOff}}；删除第 i 档（i≥1）：{op:"remove", path:"/offer/tiers/{i}"}。
满 X 减 Y：/offer/mechanism 填门槛型，再新增一档 thresholdAmount=X、amountOff=Y。
让扣点、回款率用小数（12 个点填 0.12，回款率 98% 填 0.98）；日期用 YYYY-MM-DD。
- ask_user：出一张补充卡片，每项有候选和自定义输入，都可以不填。keys 从这些里选：${CLARIFY_ORDER.map((key) => `${key}（${CLARIFY_LABEL[key]}）`).join("、")}。开单必需但还缺的项会自动加进去。confirm 放需要用户重新确认的项（例如矛盾的两项），即使用户说过也会问。segments、series 是人群、主推货品的候选，各 3 到 5 个，每个不超过 10 个字。
- write_plan：写方案文案并保存。externalName 对外传播名；icsName ICS 开单名，不超过 13 个字，不含 < > " ' { } [ ] | \\；content 给顾客看的活动内容；slogan 活动标语。
- undo_last_change：撤销上一次修改。

## 怎么做
1. 用户第一次描述需求：update_fields 写入原话里明确的信息（由头类型、人群可以按原话推断），并给 title。信息不够就 ask_user，带上 segments、series 候选；开单必需的信息都齐了就直接 write_plan。
2. 用户补充或修改活动信息：update_fields。已经生成过方案的，接着 write_plan 更新文案。
3. 用户只想改文案（例如“活动名克制一点”）：直接 write_plan。
4. 用户说“可以”“好的”“直接生成”“继续”：方案还没生成或不是最新的，就 write_plan；已经是最新的，就说清楚还差哪些项、补在卡片里，不用调工具。
5. 用户提交了补充卡片或点了“生成方案”：「其他」框里写的内容先用 update_fields 写进去（如果有），然后 write_plan。
6. 状态里 conflicts 不为空（例如顾客动作是参与互动，但让利是满减）：先指出矛盾，用 ask_user 把相关项放进 confirm 请用户确认，不要 write_plan。
7. 用户提问：直接回答，不调工具，也不要为了回答问题出卡片。
8. 用户要撤销：undo_last_change。
9. 工具没写入（dropped）的信息不要换个说法硬写，需要时用 ask_user 问。
10. write_plan 之后还缺的开单项，系统会自动附卡片，不用再调 ask_user。

## 文案要求
- 结合由头、人群、主推货品和优惠写出有辨识度的名字，不要用“XX营销活动”这种泛称。
- content 只能复述草稿里已有的优惠数字、范围和日期；草稿里没填的不要写，也不要写“待定”之类的占位；不写待界面选择的事项、编码或系统操作说明。

## 回复要求
每轮最后用 1 到 3 句中文口语回复，不超过 100 字：做了什么、下一步是什么。只写纯文本，不用 Markdown（加粗、列表、标题）。
卡片和方案会显示在你的回复下面，提到时说“下面的卡片”“下面的方案”。
不要提“工具”“校验”“path”“dropped”这类内部说法；没写进草稿的信息，直接请用户再说一次或在卡片里补。
不要把方案全文再贴一遍，不要编造数字、日期和编码。

## 名词表
${GLOSSARY.join("\n")}`;
}

const list = (values: readonly string[]) => (values.length ? values.join("、") : "未填");

function show<T>(field: FieldValue<T>, format: (value: T) => string): string {
  if (field.provenance === "pending") return field.suggested ? `${format(field.value)}（推断，待用户确认）` : "未填";
  return field.provenance === "ai" ? `${format(field.value)}（AI 推断）` : format(field.value);
}

function draftForPrompt(draft: CampaignDraft) {
  const batch = draft.schedule.batches[0];
  const rate = (value: number | null) => (value === null ? "未填" : String(value));
  return {
    标题: draft.title,
    方案文案: draft.brief.externalName ? draft.brief : "还没生成",
    由头原话: draft.intent.reason || "未填",
    由头类型: show(draft.intent.occasion, String),
    顾客动作: show(draft.intent.customerAction, String),
    让利机制: show(draft.offer.mechanism, String),
    优惠档位: draft.offer.tiers.map((tier, index) => ({ i: index, thresholdAmount: tier.thresholdAmount, discountRate: tier.discountRate, amountOff: tier.amountOff })),
    能否叠加: show(draft.offer.stacking, String),
    范围层级: show(draft.scope.level, String),
    区域: draft.scope.regionCode || "未填",
    分区: draft.scope.divisionCode || "未填",
    门店: draft.scope.stores.map((store) => `${store.code} ${store.name}`),
    市场: show(draft.scope.markets, list),
    渠道: show(draft.scope.channels, list),
    起止日期: `${batch?.startDate || "未填"} 至 ${batch?.endDate || "未填"}`,
    人群: show(draft.audience.segments, list),
    业务大类: show(draft.products.categories, list),
    主推货品: draft.products.series || "未填",
    会员限制: `${show(draft.audience.membership, String)}${draft.audience.membershipDescription ? `：${draft.audience.membershipDescription}` : ""}`,
    让扣点: show(draft.operations.concessionRate, rate),
    回款率: show(draft.operations.collectionRate, rate),
    支付方式: show(draft.operations.paymentRestricted, (value) => (value ? "有限制" : "不限制")),
  };
}

function triggerText(request: AgentRequest): string {
  const trigger = request.trigger;
  switch (trigger.kind) {
    case "first_message":
      return `用户第一次描述需求：「${trigger.text}」`;
    case "user_message":
      return `用户说：「${trigger.text}」`;
    case "card_submitted":
      return [
        "用户提交了补充卡片。",
        trigger.summary.length ? `卡片上选的（已经写进草稿）：${trigger.summary.join("；")}` : "卡片上什么都没选。",
        trigger.customs.length ? `「其他」框里写的（要用 update_fields 写入）：\n${trigger.customs.map((item) => `${item.label}：${item.text}`).join("\n")}` : "",
      ].filter(Boolean).join("\n");
    case "generate_clicked":
      return "用户点了「生成方案」按钮。";
  }
}

export function buildAgentUserPrompt(request: AgentRequest): string {
  const status = draftStatus(request.draft);
  const stage = !request.draft.brief.externalName
    ? "还没生成方案"
    : request.planIsCurrent ? "已生成方案，是最新的" : "已生成方案，但之后活动信息改过，文案可能不是最新的";
  const history = request.history.map((item) => `${item.role === "user" ? "用户" : "助手"}：${item.text}`).join("\n");
  return [
    "## 当前状态",
    `- 阶段：${stage}`,
    `- ICS 单：${status.icsOrders}`,
    `- 还差：${status.missing.join("、") || "无"}`,
    `- 前后矛盾（conflicts）：${status.conflicts.join("；") || "无"}`,
    `- 开单规则提示：${status.ruleIssues.join("；") || "无"}`,
    `- 待在 ICS 界面选择：${status.pendingInIcsUi.join("；") || "无"}`,
    `- 用户还没提交的卡片：${request.openCard?.length ? request.openCard.map((key) => CLARIFY_LABEL[key]).join("、") : "无"}`,
    "## 当前草稿",
    JSON.stringify(draftForPrompt(request.draft)),
    ...(history ? ["## 最近对话", history] : []),
    "## 这一轮",
    triggerText(request),
  ].join("\n");
}
