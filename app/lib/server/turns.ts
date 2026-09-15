import { answerLabel, answerToOps, parseAnswer } from "../campaign/answers.ts";
import { applyClarifyAnswers, buildClarifyQuestions, CLARIFY_LABEL, missingLabels, type ClarifyOptions } from "../campaign/clarify.ts";
import { lastQuestion, openClarify, summarizeChanges, type ChatMessage, type QuestionPrefill, type StoredMessage } from "../campaign/messages.ts";
import { applyPatch, diffDrafts } from "../campaign/patcher.ts";
import { deriveStatus, noIcsReason, readbackItems } from "../campaign/planner.ts";
import { buildIcsDrafts, calculateOrderCount } from "../campaign/split-orders.ts";
import { FIELD_LABEL, missingFields, missingFieldsOf, missingTopics, noIcsOrders, type FieldKey, type TopicId } from "../campaign/topics.ts";
import type { CampaignDraft, FieldDiff, IcsOrderDraft, PatchOperation, ValidationIssue } from "../campaign/types.ts";
import { validateDraft } from "../campaign/validator.ts";
import { createEmptyDraft, deriveDraft, EXAMPLE_INTERPRETATION, EXAMPLE_PREFILL, EXAMPLE_TEXT, mergeInterpretation } from "../campaign/workspace-state.ts";
import { guardTextTurn, parseGeneratedCopy, parseTurnIntent } from "./ai-schemas.ts";
import { parseClarification, type ClarificationResult } from "./clarify-schema.ts";
import type { DeepSeekMessage } from "./deepseek.ts";
import { buildInterpretationPrompt, buildTextTurnSystemPrompt, generationSystemPrompt } from "./prompts.ts";
import { ConflictError, type SessionBundle, type SessionStore, type TurnWrite } from "./session-store.ts";

export type ModelCaller = (messages: DeepSeekMessage[]) => Promise<string>;

export type TurnDeps = {
  store: SessionStore;
  callModel: ModelCaller;
  today: string;
  now?: () => string;
  newId?: () => string;
};

export class TurnError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type TurnInput =
  | { type: "text"; text: string; expectedSeq: number }
  | { type: "answer"; topic: unknown; values: unknown; origin: "chat" | "panel" | "tool"; expectedSeq: number }
  | { type: "clarify_submit"; answers: unknown; expectedSeq: number }
  | { type: "interpret"; expectedSeq: number }
  | { type: "generate"; expectedSeq: number }
  | { type: "undo"; versionSeq: number; expectedSeq: number }
  | { type: "rollback"; seq: number; expectedSeq: number };

export type VersionSummary = { seq: number; source: string; createdAt: string; diffCount: number };

export type Snapshot = {
  session: { id: string; title: string; status: string; entryMode: string; noIcs: boolean; createdAt: string; updatedAt: string };
  messages: ChatMessage[];
  versions: VersionSummary[];
  latest: { seq: number; draft: CampaignDraft; orders: IcsOrderDraft[]; issues: ValidationIssue[] };
  plan: { missingTopics: TopicId[]; openQuestionId: string | null; openClarifyId: string | null; pendingInterpretation: boolean };
};

const EXAMPLE_OPTIONS: ClarifyOptions = {
  segments: ["为母亲选礼的人", "家庭赠礼客群", "悦己自购客群"],
  series: ["足金吊坠", "足金手镯", "黄金转运珠"],
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const agentText = (text: string): StoredMessage => ({ v: 1, kind: "agent_text", text });

export function parseTurnInput(body: unknown): TurnInput {
  if (!isRecord(body) || !integer(body.expectedSeq)) throw new TurnError(400, "请求内容不完整");
  const expectedSeq = body.expectedSeq;
  switch (body.type) {
    case "text":
      if (typeof body.text !== "string" || !body.text.trim()) throw new TurnError(400, "请输入内容");
      return { type: "text", text: body.text.trim().slice(0, 1000), expectedSeq };
    case "answer":
      return { type: "answer", topic: body.topic, values: body.values, origin: body.origin === "panel" || body.origin === "tool" ? body.origin : "chat", expectedSeq };
    case "clarify_submit":
      return { type: "clarify_submit", answers: isRecord(body.answers) ? body.answers : {}, expectedSeq };
    case "interpret":
      return { type: "interpret", expectedSeq };
    case "generate":
      return { type: "generate", expectedSeq };
    case "undo":
      if (!integer(body.versionSeq)) throw new TurnError(400, "请求内容不完整");
      return { type: "undo", versionSeq: body.versionSeq, expectedSeq };
    case "rollback":
      if (!integer(body.seq)) throw new TurnError(400, "请求内容不完整");
      return { type: "rollback", seq: body.seq, expectedSeq };
    default:
      throw new TurnError(400, "不支持的操作");
  }
}

const UNDERSTOOD_KINDS = new Set(["agent_clarify", "agent_plan", "agent_readback", "agent_question"]);

// 新建会话先只存用户那句话；在理解成功（产生补充卡片或方案）之前都算待理解，失败后可以重试。
export function isPendingInterpretation(bundle: SessionBundle): boolean {
  return bundle.session.entryMode === "new" &&
    (bundle.versions.at(-1)?.seq ?? 0) === 1 &&
    !bundle.messages.some((message) => UNDERSTOOD_KINDS.has(message.content.kind));
}

function versionSource(index: number, trigger: StoredMessage | undefined, createdBy: string): string {
  if (index === 0) return "初始";
  if (trigger?.kind === "user_text") return createdBy === "rollback" ? "版本恢复" : "对话修改";
  if (trigger?.kind === "user_clarify_submit") return "补充信息并生成";
  if (trigger?.kind === "user_answer") return trigger.origin === "panel" ? "草稿手改" : "选项回答";
  if (trigger?.kind === "user_event") return trigger.event === "generate" ? "生成文案" : "版本恢复";
  if (trigger?.kind.startsWith("agent_")) return "理解需求";
  return createdBy === "rollback" ? "版本恢复" : createdBy === "ai" ? "对话修改" : "手动修改";
}

export function buildSnapshot(bundle: SessionBundle): Snapshot {
  const latest = bundle.versions.at(-1);
  if (!latest) throw new TurnError(404, "活动还没有可打开的版本");
  const orders = buildIcsDrafts(latest.draft);
  const issues = validateDraft(latest.draft, orders);
  const triggers = new Map(bundle.messages.filter((message) => message.producedVersionId).map((message) => [message.producedVersionId as string, message.content]));
  const missing = missingTopics(latest.draft);
  const question = lastQuestion(bundle.messages);
  return {
    session: { ...bundle.session, status: deriveStatus(latest.draft, issues), noIcs: noIcsOrders(latest.draft) },
    messages: bundle.messages.map(({ id, role, createdAt, content }) => ({ id, role, createdAt, content })),
    versions: bundle.versions.map((version, index) => ({
      seq: version.seq,
      source: versionSource(index, triggers.get(version.id), version.createdBy),
      createdAt: version.createdAt,
      diffCount: index === 0 ? 0 : summarizeChanges(bundle.versions[index - 1].draft, version.draft).length,
    })),
    latest: { seq: latest.seq, draft: latest.draft, orders, issues },
    plan: {
      missingTopics: missing,
      openQuestionId: question && missing.includes(question.content.topic) ? question.id : null,
      openClarifyId: openClarify(bundle.messages)?.id ?? null,
      pendingInterpretation: isPendingInterpretation(bundle),
    },
  };
}

async function commitAndLoad(deps: TurnDeps, write: TurnWrite): Promise<Snapshot> {
  try {
    await deps.store.commit(write);
  } catch (error) {
    if (error instanceof ConflictError) throw new TurnError(409, error.message);
    throw error;
  }
  const bundle = await deps.store.load(write.session.id);
  if (!bundle) throw new TurnError(404, "找不到这个活动");
  return buildSnapshot(bundle);
}

type CopyOutcome = { ok: true; draft: CampaignDraft } | { ok: false; failure: string; copyBlockers: ValidationIssue[] };

// 生成四个文案字段；文案触发 /brief 下的开单规则阻断时，把阻断回喂模型，最多再修两轮。
async function generateCopy(base: CampaignDraft, deps: TurnDeps): Promise<CopyOutcome> {
  const messages: DeepSeekMessage[] = [
    { role: "system", content: generationSystemPrompt },
    { role: "user", content: JSON.stringify(base) },
  ];
  let failure = "请重试";
  let copyBlockers: ValidationIssue[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let content: string;
    try {
      content = await deps.callModel(messages);
    } catch (error) {
      return { ok: false, failure: errorText(error, "模型服务暂时不可用"), copyBlockers: [] };
    }
    try {
      const copy = parseGeneratedCopy(content);
      const draft = structuredClone(base) as CampaignDraft;
      draft.brief = copy;
      if (!base.brief.externalName) draft.title = copy.externalName.slice(0, 28);
      const derived = deriveDraft(draft);
      copyBlockers = validateDraft(derived, buildIcsDrafts(derived)).filter((issue) => issue.severity === "blocker" && issue.path.startsWith("/brief"));
      if (copyBlockers.length === 0) return { ok: true, draft: derived };
      failure = "文案没有通过开单规则校验";
      messages.push({ role: "assistant", content }, { role: "user", content: `校验未通过：${copyBlockers.map((issue) => issue.message).join("；")}。只修正文案里的问题。` });
    } catch (error) {
      failure = errorText(error, "模型返回的文案不完整");
      messages.push({ role: "assistant", content }, { role: "user", content: `上次返回不符合要求：${failure}。只返回 externalName、icsName、content、slogan 四个字符串字段。` });
    }
  }
  return { ok: false, failure, copyBlockers };
}

function copyFailureMessages(outcome: Extract<CopyOutcome, { ok: false }>): StoredMessage[] {
  const messages: StoredMessage[] = [];
  if (outcome.copyBlockers.length) {
    messages.push({ v: 1, kind: "agent_blockers", issues: outcome.copyBlockers.map((issue) => ({ ruleId: issue.ruleId, message: issue.message, path: issue.path, topic: "brief" })) });
  }
  messages.push({ v: 1, kind: "agent_error", text: `文案生成失败：${outcome.failure}`, retry: { type: "generate" } });
  return messages;
}

function planMessage(draft: CampaignDraft, orders: IcsOrderDraft[], issues: ValidationIssue[], versionSeq: number): StoredMessage {
  const split = calculateOrderCount(draft);
  const blockedOrders = draft.unresolved.length ? orders.length : 0;
  return {
    v: 1,
    kind: "agent_plan",
    versionSeq,
    brief: draft.brief,
    total: split.total,
    readyOrders: orders.length - blockedOrders,
    blockedOrders,
    warnings: issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
    missing: missingLabels(draft),
  };
}

function missingCard(draft: CampaignDraft, intro: string): StoredMessage | null {
  const questions = buildClarifyQuestions(draft, [], { segments: [], series: [] });
  return questions.length ? { v: 1, kind: "agent_clarify", intro, stated: [], inferred: [], questions } : null;
}

const MISSING_EXAMPLE: Record<FieldKey, string> = {
  customerAction: "顾客下单才算",
  occasion: "日历节点",
  mechanism: "满减",
  tier: "满 2000 减 200",
  stacking: "不能叠加",
  level: "全国",
  scopeCode: "华东区",
  markets: "内地",
  channels: "线下",
  dates: "12 月 30 日到 1 月 3 日",
  segments: "给家人送礼的人",
  categories: "黄金类",
  membership: "不限会员",
  rates: "让扣点 0.12，回款率 0.98",
  paymentRestricted: "支付方式不限",
};

// 按草稿当前状态给出下一步，替代「没听懂」之类的套话。
function nextStepHint(draft: CampaignDraft, orders: IcsOrderDraft[], unclear = false): string {
  const prefix = unclear ? "我没完全明白你的意思。" : "";
  const missing = missingFields(draft);
  if (missing.length) {
    const labels = missingLabels(draft);
    const example = [...new Set(missing.map((key) => MISSING_EXAMPLE[key]))].slice(0, 2).join("，");
    return `${prefix}现在还差：${labels.join("、")}。直接告诉我就行，比如「${example}」。`;
  }
  if (!draft.brief.externalName) return `${prefix}信息都齐了，说一声「生成方案」我就开始写。`;
  if (noIcsOrders(draft)) return `${prefix}方案已经齐了，这次不建 ICS 单。想调整文案直接说。`;
  return `${prefix}方案和 ICS 草稿都齐了，共 ${orders.length} 条。可以在右侧「ICS」页签复制清单去 1811 录入；想改哪里直接说。`;
}

function stateSummary(draft: CampaignDraft, orders: IcsOrderDraft[], issues: ValidationIssue[], cardOpen: boolean): string {
  const missing = missingLabels(draft);
  const split = calculateOrderCount(draft);
  const blockers = issues.filter((issue) => issue.severity === "blocker");
  return [
    `阶段：${draft.brief.externalName ? "已生成方案" : cardOpen ? "补充卡片待提交" : "还没生成方案"}`,
    `ICS 单：${noIcsOrders(draft) ? "本次不建 ICS 单" : `${orders.length} 条（${split.factors.batches} 批次 × ${split.factors.markets} 市场 × ${split.factors.channels} 渠道 × ${split.factors.scopeUnits} 范围 × ${split.factors.offerTiers} 档优惠）`}`,
    `还差：${missing.length ? missing.join("、") : "无"}`,
    `待界面选择：${draft.unresolved.length ? draft.unresolved.join("；") : "无"}`,
    `规则冲突：${blockers.length ? blockers.map((issue) => issue.message).join("；") : "无"}`,
  ].join("\n");
}

// 最近一次方案之后，活动信息（文案以外的字段）有没有变过。
function factsChangedSincePlan(bundle: SessionBundle, draft: CampaignDraft): boolean {
  const plan = [...bundle.messages].reverse().find((message) => message.content.kind === "agent_plan");
  if (!plan || plan.content.kind !== "agent_plan") return true;
  const planSeq = plan.content.versionSeq;
  const version = bundle.versions.find((item) => item.seq === planSeq);
  if (!version) return true;
  return diffDrafts(version.draft, draft).some((diff) => !diff.path.startsWith("/brief") && diff.path !== "/title");
}

// 把第一句话的理解结果变成草稿和 Agent 消息：信息不够出补充卡片；够了直接生成方案。
async function understand(text: string, clarification: ClarificationResult, prefill: QuestionPrefill | undefined, deps: TurnDeps) {
  const merged = mergeInterpretation(text, clarification);
  const questions = buildClarifyQuestions(merged, clarification.ask, clarification.options);
  const messages: StoredMessage[] = [];
  if (noIcsOrders(merged)) messages.push({ v: 1, kind: "agent_no_ics", reason: noIcsReason(merged) });

  if (questions.length > 0) {
    const { stated, inferred } = readbackItems(merged);
    messages.push({
      v: 1,
      kind: "agent_clarify",
      intro: "补充一下会更准，每一项都可以不填。填完点「确认提交」，我按已有信息生成方案。",
      stated,
      inferred,
      questions,
      ...(prefill ? { prefill } : {}),
    });
    return { draft: merged, messages, generated: false };
  }

  const outcome = await generateCopy(merged, deps);
  if (outcome.ok) {
    messages.push(agentText("信息够了，我直接生成了方案。"));
    return { draft: outcome.draft, messages, generated: true };
  }
  messages.push(...copyFailureMessages(outcome));
  return { draft: merged, messages, generated: false };
}

// 修改类回合之后的提示：补充卡片还开着时什么都不追加；生成过方案、改了事实字段时提议重新生成文案。
function followUps(prev: CampaignDraft, next: CampaignDraft, diffs: FieldDiff[], history: ChatMessage[]): StoredMessage[] {
  const out: StoredMessage[] = [];
  if (noIcsOrders(next) && !noIcsOrders(prev)) out.push({ v: 1, kind: "agent_no_ics", reason: noIcsReason(next) });
  if (openClarify(history) || diffs.length === 0) return out;
  if (next.brief.externalName) {
    const copyTouched = diffs.some((diff) => diff.path.startsWith("/brief"));
    const factsTouched = diffs.some((diff) => !diff.path.startsWith("/brief") && diff.path !== "/title");
    if (factsTouched && !copyTouched) out.push({ v: 1, kind: "agent_regenerate_offer" });
  } else {
    const split = calculateOrderCount(next);
    out.push({ v: 1, kind: "agent_ready", total: split.total, factors: split.factors, pendingUi: next.unresolved });
  }
  return out;
}

export async function createSession(body: unknown, deps: TurnDeps): Promise<Snapshot> {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const input = isRecord(body) ? body : {};
  const entryMode = input.entryMode === "example" ? "example" : input.entryMode === "new" ? "new" : null;
  if (!entryMode) throw new TurnError(400, "不支持的新建方式");

  const sessionId = newId();
  const versionId = newId();

  // 新建：只存这句话，立即返回；理解由对话页发起的 interpret 回合完成。
  if (entryMode === "new") {
    const text = typeof input.text === "string" ? input.text.trim().slice(0, 1000) : "";
    if (text.length < 4) throw new TurnError(400, "请用一句话说明活动");
    const draft = deriveDraft(createEmptyDraft());
    draft.title = text.slice(0, 28);
    const orders = buildIcsDrafts(draft);
    return commitAndLoad(deps, {
      isNew: true,
      now,
      session: { id: sessionId, title: draft.title, entryMode, status: deriveStatus(draft, validateDraft(draft, orders)), createdAt: now, updatedAt: now },
      version: { id: versionId, seq: 1, draft, orders, createdBy: "human", patch: null },
      messages: [{ id: newId(), role: "user", content: { v: 1, kind: "user_text", text }, producedVersionId: versionId }],
    });
  }

  const clarification: ClarificationResult = { ...EXAMPLE_INTERPRETATION, sufficient: false, ask: [], options: EXAMPLE_OPTIONS };
  const result = await understand(EXAMPLE_TEXT, clarification, EXAMPLE_PREFILL, deps);
  const draft = result.draft;
  const orders = buildIcsDrafts(draft);
  const issues = validateDraft(draft, orders);
  const agentMessages = result.generated ? [...result.messages, planMessage(draft, orders, issues, 1)] : result.messages;
  return commitAndLoad(deps, {
    isNew: true,
    now,
    session: { id: sessionId, title: draft.title, entryMode, status: deriveStatus(draft, issues), createdAt: now, updatedAt: now },
    version: { id: versionId, seq: 1, draft, orders, createdBy: draft.brief.externalName ? "ai" : "human", patch: null },
    messages: [
      { id: newId(), role: "user", content: { v: 1, kind: "user_text", text: EXAMPLE_TEXT }, producedVersionId: versionId },
      ...agentMessages.map((content) => ({ id: newId(), role: "assistant" as const, content, producedVersionId: null })),
    ],
  });
}

export async function runTurn(sessionId: string, body: unknown, deps: TurnDeps): Promise<Snapshot> {
  const input = parseTurnInput(body);
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const bundle = await deps.store.load(sessionId);
  if (!bundle) throw new TurnError(404, "找不到这个活动");
  const latest = bundle.versions.at(-1);
  if (!latest) throw new TurnError(404, "活动还没有可打开的版本");
  if (input.expectedSeq !== latest.seq) throw new TurnError(409, "页面已更新，请重试");

  const prev = latest.draft;
  const prevIssues = validateDraft(prev, buildIcsDrafts(prev));
  const sessionBase = { ...bundle.session, updatedAt: now };

  const commitMessagesOnly = (userContent: StoredMessage | null, messages: StoredMessage[]) => commitAndLoad(deps, {
    isNew: false,
    now,
    session: { ...sessionBase, status: deriveStatus(prev, prevIssues) },
    version: null,
    messages: [
      ...(userContent ? [{ id: newId(), role: "user" as const, content: userContent, producedVersionId: null }] : []),
      ...messages.map((content) => ({ id: newId(), role: "assistant" as const, content, producedVersionId: null })),
    ],
  });

  let next: CampaignDraft = prev;
  let userContent: StoredMessage | null = null;
  let ops: PatchOperation[] = [];
  let createdBy: "ai" | "human" | "rollback" = "human";
  let patchReason = "";
  let generated = false;
  let advanced = false;
  let attachMissingCard = false;
  const before: StoredMessage[] = [];
  const notes: StoredMessage[] = [];

  switch (input.type) {
    case "answer": {
      let answer;
      try {
        answer = parseAnswer(input.topic, input.values, prev);
      } catch (error) {
        throw new TurnError(400, errorText(error, "回答内容不正确"));
      }
      ops = answerToOps(answer, prev);
      next = applyPatch(prev, ops);
      patchReason = answerLabel(answer);
      userContent = { v: 1, kind: "user_answer", topic: answer.topic, label: patchReason, values: answer.values as Record<string, unknown>, origin: input.origin };
      break;
    }
    case "interpret": {
      if (!isPendingInterpretation(bundle)) throw new TurnError(409, "这句话已经理解过了");
      const first = bundle.messages.find((message) => message.content.kind === "user_text");
      const text = first?.content.kind === "user_text" ? first.content.text : bundle.session.title;
      createdBy = "ai";
      let clarification: ClarificationResult;
      try {
        const content = await deps.callModel([
          { role: "system", content: buildInterpretationPrompt(deps.today) },
          { role: "user", content: text },
        ]);
        clarification = parseClarification(content, text);
      } catch (error) {
        return commitMessagesOnly(null, [{ v: 1, kind: "agent_error", text: `没理解成功：${errorText(error, "模型服务暂时不可用")}`, retry: { type: "interpret" } }]);
      }
      const result = await understand(text, clarification, undefined, deps);
      next = result.draft;
      generated = result.generated;
      notes.push(...result.messages);
      break;
    }
    case "text": {
      userContent = { v: 1, kind: "user_text", text: input.text };
      createdBy = "ai";
      patchReason = input.text;
      const card = openClarify(bundle.messages);
      const question = lastQuestion(bundle.messages);
      const openTopic = !card && question && missingTopics(prev).includes(question.content.topic) ? question.content.topic : null;
      const openFields = openTopic ? missingFieldsOf(prev, openTopic) : [];
      const promptFields = card ? card.content.questions.map((item) => CLARIFY_LABEL[item.key]) : openFields.map((key) => FIELD_LABEL[key]);
      let content: string;
      try {
        content = await deps.callModel([
          { role: "system", content: buildTextTurnSystemPrompt({ today: deps.today, openFields: promptFields }) },
          { role: "user", content: `当前状态：\n${stateSummary(prev, buildIcsDrafts(prev), prevIssues, Boolean(card))}\n当前草稿：${JSON.stringify(prev)}\n用户说：${input.text}` },
        ]);
      } catch (error) {
        return commitMessagesOnly(userContent, [{ v: 1, kind: "agent_error", text: `这句没处理成功：${errorText(error, "模型服务暂时不可用")}`, retry: { type: "text", text: input.text } }]);
      }
      let guard = { ops: [] as PatchOperation[], dropped: [] as string[], undecided: [] as string[], reply: null as string | null };
      try {
        guard = guardTextTurn(content, { draft: prev, userText: input.text, openFields });
      } catch {
        // 非法 JSON：没有改动，下面按当前状态给下一步。
      }
      const intent = parseTurnIntent(content, guard.ops.length > 0);
      if (guard.ops.length) {
        try {
          next = applyPatch(prev, guard.ops);
          ops = guard.ops;
        } catch {
          next = prev;
        }
      }
      if (guard.dropped.length) notes.push(agentText(`${guard.dropped.join("、")}没能从你的话里确定，请说得具体些，或者在卡片、草稿面板里选。`));
      if (guard.undecided.length) notes.push(agentText(`${guard.undecided.join("、")}先放着，定了再告诉我。`));

      if (intent === "undo" && ops.length === 0) {
        const target = bundle.versions.find((version) => version.seq === latest.seq - 1);
        if (target) {
          next = structuredClone(target.draft);
          createdBy = "rollback";
        } else {
          notes.push(agentText("现在还没有可以撤销的修改。"));
        }
        break;
      }

      // 「可以」「直接生成」：文案不是最新就生成；已是最新但还缺开单信息，就说清楚缺什么并给卡片；都齐了就指到 ICS 清单。
      if (intent === "generate" || intent === "confirm") {
        advanced = true;
        const derived = deriveDraft(next);
        if (!derived.brief.externalName || factsChangedSincePlan(bundle, derived)) {
          const outcome = await generateCopy(derived, deps);
          if (outcome.ok) {
            next = outcome.draft;
            generated = true;
          } else {
            next = derived;
            notes.push(...copyFailureMessages(outcome));
          }
        } else if (missingFields(derived).length) {
          notes.push(agentText(`方案文案已经是最新的。要开出 ICS 单还差：${missingLabels(derived).join("、")}。${card ? "在上面的卡片里补上，点「确认提交」就行。" : "补在下面的卡片里就行。"}`));
          attachMissingCard = !card;
        } else {
          notes.push(agentText(nextStepHint(derived, buildIcsDrafts(derived))));
        }
        break;
      }

      if (guard.reply) before.push(agentText(guard.reply));
      if (!ops.length && !guard.reply && !guard.dropped.length && !guard.undecided.length) {
        const derived = deriveDraft(next);
        notes.push(agentText(nextStepHint(derived, buildIcsDrafts(derived), true)));
      }
      break;
    }
    case "clarify_submit": {
      const card = openClarify(bundle.messages);
      if (!card) throw new TurnError(409, "这张补充卡片已经提交过了");
      const application = applyClarifyAnswers(input.answers, prev, card.content.questions.map((item) => item.key));
      // 方案已经生成过、这次什么都没补、方案之后也没在对话里改过：不重复生成，只收起卡片。
      if (prev.brief.externalName && application.ops.length === 0 && application.customs.length === 0 && !factsChangedSincePlan(bundle, prev)) {
        userContent = { v: 1, kind: "user_clarify_submit", label: "先不补充" };
        notes.push(agentText("好，这几项先空着。之后想补，直接在对话里说就行。"));
        break;
      }
      let working = application.draft;
      ops = [...application.ops];
      if (application.customs.length) {
        const written = application.customs.map((item) => `${item.label}：${item.text}`).join("\n");
        try {
          const content = await deps.callModel([
            { role: "system", content: buildTextTurnSystemPrompt({ today: deps.today, openFields: application.customs.map((item) => item.label) }) },
            { role: "user", content: `当前草稿：${JSON.stringify(working)}\n用户在补充卡片的「其他」里写了：\n${written}` },
          ]);
          const guard = guardTextTurn(content, { draft: working, userText: written, openFields: [], trustedFields: application.customs.map((item) => item.field) });
          if (guard.ops.length) {
            working = applyPatch(working, guard.ops);
            ops.push(...guard.ops);
          }
          if (guard.dropped.length) notes.push(agentText(`「其他」里写的${guard.dropped.join("、")}没能确定，先按待补处理。`));
        } catch {
          notes.push(agentText("「其他」里写的内容没解析成功，先按已选的选项生成。"));
        }
      }
      if (application.ignored.length) notes.push(agentText(`${application.ignored.join("、")}填得不完整或不合规，已忽略。`));
      userContent = { v: 1, kind: "user_clarify_submit", label: application.summary.length ? application.summary.join("；") : "先不补充，直接生成" };
      createdBy = "ai";
      patchReason = "补充卡片提交";
      const outcome = await generateCopy(deriveDraft(working), deps);
      if (outcome.ok) {
        next = outcome.draft;
        generated = true;
      } else {
        next = working;
        notes.push(...copyFailureMessages(outcome));
      }
      break;
    }
    case "generate": {
      userContent = { v: 1, kind: "user_event", event: "generate", label: prev.brief.externalName ? "重新生成文案" : "生成活动方案" };
      createdBy = "ai";
      const outcome = await generateCopy(prev, deps);
      if (!outcome.ok) return commitMessagesOnly(userContent, copyFailureMessages(outcome));
      next = outcome.draft;
      generated = true;
      break;
    }
    case "undo": {
      if (input.versionSeq !== latest.seq || latest.seq <= 1) throw new TurnError(409, "之后已有新的修改，可以在版本页签里恢复");
      const target = bundle.versions.find((version) => version.seq === latest.seq - 1);
      if (!target) throw new TurnError(404, "找不到要恢复的版本");
      next = structuredClone(target.draft);
      createdBy = "rollback";
      userContent = { v: 1, kind: "user_event", event: "undo", label: "撤销上一次修改" };
      break;
    }
    case "rollback": {
      const target = bundle.versions.find((version) => version.seq === input.seq);
      if (!target) throw new TurnError(404, "找不到要恢复的版本");
      next = structuredClone(target.draft);
      createdBy = "rollback";
      userContent = { v: 1, kind: "user_event", event: "rollback", label: `恢复到版本 ${input.seq}` };
      break;
    }
  }

  next = deriveDraft(next);
  const orders = buildIcsDrafts(next);
  const issues = validateDraft(next, orders);
  const diffs = diffDrafts(prev, next);
  const changed = diffs.length > 0;
  const versionSeq = latest.seq + 1;
  const versionId = changed ? newId() : null;
  const understanding = input.type === "interpret";

  const agentMessages: StoredMessage[] = [...before];
  const items = changed && !generated && !understanding ? summarizeChanges(prev, next) : [];
  if (items.length) {
    agentMessages.push({
      v: 1,
      kind: "agent_change",
      title: input.type === "rollback" ? `已恢复到版本 ${input.seq}` : createdBy === "rollback" ? "已撤销" : items.length === 1 ? "记下了" : `改了 ${items.length} 处`,
      items,
      versionSeq,
    });
  }
  agentMessages.push(...notes);

  if (generated) {
    // 生成的文案和上一版完全一样时不产生新版本，方案指向当前版本。
    agentMessages.push(planMessage(next, orders, issues, changed ? versionSeq : latest.seq));
  } else if (input.type !== "clarify_submit" && !understanding && !advanced) {
    agentMessages.push(...followUps(prev, next, diffs, bundle.messages));
  }

  // 生成了方案但开单信息还不全，或用户要继续时缺项：只列缺的那几项，出一张小卡片。
  if ((generated && missingFields(next).length > 0) || attachMissingCard) {
    const card = missingCard(next, "要开出 ICS 单还差这几项。补上后点「确认提交」，我会更新方案；暂时不补也没关系。");
    if (card) agentMessages.push(card);
  }

  return commitAndLoad(deps, {
    isNew: false,
    now,
    session: { ...sessionBase, title: next.title, status: deriveStatus(next, issues) },
    version: versionId
      ? {
          id: versionId,
          seq: versionSeq,
          draft: next,
          orders,
          createdBy,
          patch: ops.length && (input.type === "text" || input.type === "answer" || input.type === "clarify_submit")
            ? { id: newId(), ops, source: input.type === "answer" ? "human" : "ai", reason: patchReason }
            : null,
        }
      : null,
    messages: [
      ...(userContent ? [{ id: newId(), role: "user" as const, content: userContent, producedVersionId: versionId }] : []),
      // 没有用户消息的回合（理解需求），由第一条 Agent 消息标记它产生的版本。
      ...agentMessages.map((content, index) => ({
        id: newId(),
        role: "assistant" as const,
        content,
        producedVersionId: !userContent && index === 0 ? versionId : null,
      })),
    ],
  });
}
