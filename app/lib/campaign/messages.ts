import type { ClarifyQuestion } from "./clarify.ts";
import type { FieldKey, TopicId } from "./topics.ts";
import type { CampaignBrief, CampaignDraft, FieldValue, SplitFactors } from "./types.ts";

export type ReadbackItem = { label: string; value: string };
export type ChangeItem = { label: string; before: string; after: string };
export type QuestionPrefill = { concessionRate: number; collectionRate: number; source: string };
export type AnswerOrigin = "chat" | "panel" | "tool";

export type StoredMessage =
  | { v: 1; kind: "user_text"; text: string }
  | { v: 1; kind: "user_answer"; topic: TopicId; label: string; values: Record<string, unknown>; origin: AnswerOrigin }
  | { v: 1; kind: "user_event"; event: "generate" | "undo" | "rollback"; label: string }
  | { v: 1; kind: "user_clarify_submit"; label: string }
  | { v: 1; kind: "agent_clarify"; intro: string; stated: ReadbackItem[]; inferred: ReadbackItem[]; questions: ClarifyQuestion[]; prefill?: QuestionPrefill }
  | { v: 1; kind: "agent_readback"; stated: ReadbackItem[]; inferred: ReadbackItem[]; uncertain: string[]; derivedType: string }
  | { v: 1; kind: "agent_question"; topic: TopicId; title: string; fields: Array<{ key: FieldKey; label: string; why: string }>; prefill?: QuestionPrefill }
  | { v: 1; kind: "agent_change"; title: string; items: ChangeItem[]; versionSeq: number }
  | { v: 1; kind: "agent_blockers"; issues: Array<{ ruleId: string; message: string; path: string; topic: TopicId | null }> }
  | { v: 1; kind: "agent_no_ics"; reason: string }
  | { v: 1; kind: "agent_ready"; total: number; factors: SplitFactors; pendingUi: string[] }
  | { v: 1; kind: "agent_regenerate_offer" }
  | { v: 1; kind: "agent_plan"; versionSeq: number; brief: CampaignBrief; total: number; readyOrders: number; blockedOrders: number; warnings: string[]; missing?: string[] }
  | { v: 1; kind: "agent_text"; text: string }
  | { v: 1; kind: "agent_error"; text: string; retry?: { type: "text"; text: string } | { type: "generate" } | { type: "interpret" } };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  createdAt: string;
  content: StoredMessage;
};

export function encodeMessage(message: StoredMessage): string {
  return JSON.stringify(message);
}

export function decodeMessage(role: string, raw: string): StoredMessage {
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; kind?: unknown };
    if (parsed && typeof parsed === "object" && parsed.v === 1 && typeof parsed.kind === "string") return parsed as StoredMessage;
  } catch {
    // 旧数据是纯文本。
  }
  return role === "user" ? { v: 1, kind: "user_text", text: raw } : { v: 1, kind: "agent_text", text: raw };
}

export function isAgentMessage(message: ChatMessage): boolean {
  return message.role === "assistant";
}

export function lastAgentMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find(isAgentMessage);
}

export function lastQuestion(messages: ChatMessage[]): (ChatMessage & { content: Extract<StoredMessage, { kind: "agent_question" }> }) | undefined {
  return [...messages].reverse().find((message) => message.content.kind === "agent_question") as
    | (ChatMessage & { content: Extract<StoredMessage, { kind: "agent_question" }> })
    | undefined;
}

// 还没提交的补充卡片：最后一张 agent_clarify，且其后既没有提交、也没有新生成的方案（新方案会取代旧卡片）。
export function openClarify(messages: ChatMessage[]): (ChatMessage & { content: Extract<StoredMessage, { kind: "agent_clarify" }> }) | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const kind = messages[index].content.kind;
    if (kind === "user_clarify_submit" || kind === "agent_plan") return undefined;
    if (kind === "agent_clarify") return messages[index] as ChatMessage & { content: Extract<StoredMessage, { kind: "agent_clarify" }> };
  }
  return undefined;
}

function plain(value: unknown): string {
  if (value === null || value === undefined || value === "") return "未填";
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join("、") : "未填";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

type SummaryField = {
  label: string;
  raw: (draft: CampaignDraft) => unknown;
  text: (draft: CampaignDraft) => string;
};

function fieldValue<T>(label: string, pick: (draft: CampaignDraft) => FieldValue<T>, format: (value: T) => string = plain): SummaryField {
  return {
    label,
    raw: (draft) => {
      const field = pick(draft);
      return [field.value, field.provenance, field.suggested ?? false];
    },
    text: (draft) => format(pick(draft).value),
  };
}

function textField(label: string, pick: (draft: CampaignDraft) => string): SummaryField {
  return { label, raw: pick, text: (draft) => plain(pick(draft)) };
}

const SUMMARY_FIELDS: SummaryField[] = [
  fieldValue("顾客动作", (draft) => draft.intent.customerAction),
  fieldValue("由头类型", (draft) => draft.intent.occasion),
  textField("由头原话", (draft) => draft.intent.reason),
  fieldValue("让利机制", (draft) => draft.offer.mechanism),
  {
    label: "优惠档位",
    raw: (draft) => draft.offer.tiers.map((tier) => [tier.thresholdAmount, tier.discountRate, tier.amountOff]),
    text: (draft) => (draft.offer.tiers.length ? draft.offer.tiers.map((tier) => tier.label).join("、") : "未填"),
  },
  fieldValue("能否叠加", (draft) => draft.offer.stacking, (value) => (value === "是" ? "可以叠加" : value === "否" ? "不能叠加" : "还没定")),
  fieldValue("范围层级", (draft) => draft.scope.level),
  textField("区域", (draft) => draft.scope.regionCode),
  textField("分区", (draft) => draft.scope.divisionCode),
  {
    label: "门店",
    raw: (draft) => draft.scope.stores,
    text: (draft) => (draft.scope.stores.length ? draft.scope.stores.map((store) => `${store.code} ${store.name}`).join("、") : "未填"),
  },
  fieldValue("覆盖市场", (draft) => draft.scope.markets),
  fieldValue("渠道", (draft) => draft.scope.channels),
  textField("开始日期", (draft) => draft.schedule.batches[0]?.startDate ?? ""),
  textField("结束日期", (draft) => draft.schedule.batches[0]?.endDate ?? ""),
  fieldValue("人群", (draft) => draft.audience.segments),
  fieldValue("业务大类", (draft) => draft.products.categories),
  textField("主推货品", (draft) => draft.products.series),
  fieldValue("会员限制", (draft) => draft.audience.membership),
  textField("会员范围", (draft) => draft.audience.membershipDescription),
  fieldValue("让扣点", (draft) => draft.operations.concessionRate),
  fieldValue("回款率", (draft) => draft.operations.collectionRate),
  fieldValue("支付方式限制", (draft) => draft.operations.paymentRestricted, (value) => (value ? "有限制" : "不限制")),
  textField("活动标题", (draft) => draft.title),
  textField("对外传播名", (draft) => draft.brief.externalName),
  textField("ICS 开单名", (draft) => draft.brief.icsName),
  textField("活动内容", (draft) => draft.brief.content),
  textField("活动标语", (draft) => draft.brief.slogan),
];

export function summarizeChanges(before: CampaignDraft, after: CampaignDraft): ChangeItem[] {
  return SUMMARY_FIELDS.flatMap((field) => {
    if (JSON.stringify(field.raw(before)) === JSON.stringify(field.raw(after))) return [];
    const beforeText = field.text(before);
    const afterText = field.text(after);
    if (beforeText === afterText) return [{ label: `确认${field.label}`, before: beforeText, after: afterText }];
    return [{ label: field.label, before: beforeText, after: afterText }];
  });
}

const factorText = (factors: SplitFactors) =>
  `${factors.batches} 批次 × ${factors.markets} 市场 × ${factors.channels} 渠道 × ${factors.scopeUnits} 范围 × ${factors.offerTiers} 档优惠`;

// 复制消息时用的纯文本；卡片按界面上看到的内容逐行展开。
export function messageToText(message: StoredMessage): string {
  switch (message.kind) {
    case "user_text":
    case "agent_text":
    case "agent_error":
      return message.text;
    case "user_answer":
    case "user_event":
    case "user_clarify_submit":
      return message.label;
    case "agent_clarify":
      return [message.intro, ...message.questions.map((question) => `- ${question.title}`)].join("\n");
    case "agent_readback": {
      const lines = ["我理解的是："];
      const section = (title: string, items: ReadbackItem[]) => {
        if (items.length) lines.push(`${title}：`, ...items.map((item) => `- ${item.label}：${item.value}`));
      };
      section("你说的", message.stated);
      section("我推断的，不对直接说", message.inferred);
      if (message.uncertain.length) lines.push("我还不确定的：", ...message.uncertain.map((item) => `- ${item}`));
      lines.push(`活动类型判断：${message.derivedType}`);
      return lines.join("\n");
    }
    case "agent_question":
      return message.title;
    case "agent_change":
      return [
        message.title,
        ...message.items.map((item) => (item.label.startsWith("确认") ? `${item.label}：${item.after}` : `${item.label}：${item.before} → ${item.after}`)),
      ].join("\n");
    case "agent_blockers":
      return [`有 ${message.issues.length} 处和 ICS 开单规则冲突：`, ...message.issues.map((issue) => `- ${issue.ruleId} · ${issue.message}`)].join("\n");
    case "agent_no_ics":
      return `本次不建 ICS 单：${message.reason}`;
    case "agent_ready":
      return [
        message.total > 0 ? `字段齐了：要在 ICS 录入 ${message.total} 条优惠规则（${factorText(message.factors)}）。` : "字段齐了：这次不建 ICS 单。",
        ...(message.pendingUi.length ? [`另有 ${message.pendingUi.length} 项要在 ICS 界面上选：${message.pendingUi.join("；")}`] : []),
      ].join("\n");
    case "agent_regenerate_offer":
      return "字段改了，文案里可能还是旧的内容。要重新生成文案吗？";
    case "agent_plan":
      return [
        `对外传播名：${message.brief.externalName}`,
        `ICS 开单名：${message.brief.icsName}`,
        `活动主张：${message.brief.slogan}`,
        `活动内容：${message.brief.content}`,
        message.missing?.length
          ? `还有 ${message.missing.length} 项待补：${message.missing.join("、")}`
          : message.total > 0
            ? `要在 ICS 录入 ${message.total} 条优惠规则：${message.readyOrders} 条字段已齐，${message.blockedOrders} 条还有项要在 ICS 界面上选。`
            : "这次不建 ICS 单。",
      ].join("\n");
  }
}
