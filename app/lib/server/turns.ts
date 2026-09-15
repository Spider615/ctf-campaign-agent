import type { AgentCard, AgentRequest, AgentResult, AgentTrigger } from "../agent/protocol.ts";
import { answerLabel, answerToOps, parseAnswer } from "../campaign/answers.ts";
import { applyClarifyAnswers, buildClarifyQuestions, CARD_INTRO, missingLabels, type ClarifyKey, type ClarifyOptions } from "../campaign/clarify.ts";
import { lastQuestion, messageToText, openClarify, summarizeChanges, type ChatMessage, type StoredMessage } from "../campaign/messages.ts";
import { applyPatch, diffDrafts } from "../campaign/patcher.ts";
import { deriveStatus, noIcsReason, readbackItems } from "../campaign/planner.ts";
import { buildIcsDrafts, calculateOrderCount } from "../campaign/split-orders.ts";
import { missingFields, missingTopics, noIcsOrders, type TopicId } from "../campaign/topics.ts";
import type { CampaignDraft, FieldDiff, IcsOrderDraft, PatchOperation, ValidationIssue } from "../campaign/types.ts";
import { validateDraft } from "../campaign/validator.ts";
import { createEmptyDraft, deriveDraft, EXAMPLE_INTERPRETATION, EXAMPLE_PREFILL, EXAMPLE_TEXT, mergeInterpretation } from "../campaign/workspace-state.ts";
import { ConflictError, type SessionBundle, type SessionStore, type TurnWrite } from "./session-store.ts";

// 需要模型的回合交给 Agent 服务（Claude Agent SDK）；这里负责校验请求、组装展示的消息和落库。
export type AgentRunner = (request: AgentRequest) => Promise<AgentResult>;

export type TurnDeps = {
  store: SessionStore;
  runAgent: AgentRunner;
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

// 新建会话先只存用户那句话；Agent 第一次回应之前都算待理解，失败后可以重试。
export function isPendingInterpretation(bundle: SessionBundle): boolean {
  return bundle.session.entryMode === "new" &&
    (bundle.versions.at(-1)?.seq ?? 0) === 1 &&
    !bundle.messages.some((message) => message.role === "assistant" && message.content.kind !== "agent_error");
}

function versionSource(index: number, trigger: StoredMessage | undefined, createdBy: string): string {
  if (index === 0) return "初始";
  if (trigger?.kind === "user_text") return createdBy === "rollback" ? "版本恢复" : "对话修改";
  if (trigger?.kind === "user_clarify_submit") return "补充信息并生成";
  if (trigger?.kind === "user_answer") return trigger.origin === "panel" ? "草稿手改" : "选项回答";
  if (trigger?.kind === "user_event") return trigger.event === "generate" ? "生成方案" : "版本恢复";
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

// 最近一次方案之后，活动信息（文案以外的字段）有没有变过。
function factsChangedSincePlan(bundle: SessionBundle, draft: CampaignDraft): boolean {
  const plan = [...bundle.messages].reverse().find((message) => message.content.kind === "agent_plan");
  if (!plan || plan.content.kind !== "agent_plan") return true;
  const planSeq = plan.content.versionSeq;
  const version = bundle.versions.find((item) => item.seq === planSeq);
  if (!version) return true;
  return diffDrafts(version.draft, draft).some((diff) => !diff.path.startsWith("/brief") && diff.path !== "/title");
}

// 最近的对话，给 Agent 当上下文。
function historyForAgent(messages: ChatMessage[]): AgentRequest["history"] {
  return messages.slice(-12).flatMap((message) => {
    const text = messageToText(message.content).trim();
    return text ? [{ role: message.role, text: text.slice(0, 400) }] : [];
  });
}

// 生成了方案时，这些字段的变化由方案卡片展示，不再列进「改了几处」。
const COPY_LABELS = new Set(["活动标题", "对外传播名", "ICS 开单名", "活动内容", "活动标语"]);

// 手动修改（选项、草稿面板）之后的提示：补充卡片还开着时什么都不追加；生成过方案、改了事实字段时提议重新生成。
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

  // 新建：只存这句话，立即返回；理解由对话页发起的 interpret 回合交给 Agent。
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

  // 示例：固定的理解结果，直接出补充卡片，不调 Agent。
  const draft = mergeInterpretation(EXAMPLE_TEXT, EXAMPLE_INTERPRETATION);
  const orders = buildIcsDrafts(draft);
  const issues = validateDraft(draft, orders);
  const card: StoredMessage = {
    v: 1,
    kind: "agent_clarify",
    intro: CARD_INTRO.first,
    ...readbackItems(draft),
    questions: buildClarifyQuestions(draft, [], EXAMPLE_OPTIONS),
    prefill: EXAMPLE_PREFILL,
  };
  return commitAndLoad(deps, {
    isNew: true,
    now,
    session: { id: sessionId, title: draft.title, entryMode, status: deriveStatus(draft, issues), createdAt: now, updatedAt: now },
    version: { id: versionId, seq: 1, draft, orders, createdBy: "human", patch: null },
    messages: [
      { id: newId(), role: "user", content: { v: 1, kind: "user_text", text: EXAMPLE_TEXT }, producedVersionId: versionId },
      { id: newId(), role: "assistant", content: card, producedVersionId: null },
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
  // 需要模型的回合：base 是交给 Agent 的草稿（卡片提交时已写入选项），openCard 是还没提交的卡片问的项。
  let agent: { trigger: AgentTrigger; base: CampaignDraft; openCard: ClarifyKey[] | null } | null = null;
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
      agent = { trigger: { kind: "first_message", text }, base: prev, openCard: null };
      break;
    }
    case "text": {
      userContent = { v: 1, kind: "user_text", text: input.text };
      createdBy = "ai";
      patchReason = input.text;
      const card = openClarify(bundle.messages);
      agent = { trigger: { kind: "user_message", text: input.text }, base: prev, openCard: card ? card.content.questions.map((item) => item.key) : null };
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
      if (application.ignored.length) notes.push(agentText(`${application.ignored.join("、")}填得不完整或不合规，已忽略。`));
      userContent = { v: 1, kind: "user_clarify_submit", label: application.summary.length ? application.summary.join("；") : "先不补充，直接生成" };
      createdBy = "ai";
      patchReason = "补充卡片提交";
      ops = [...application.ops];
      next = application.draft;
      agent = { trigger: { kind: "card_submitted", summary: application.summary, customs: application.customs }, base: application.draft, openCard: null };
      break;
    }
    case "generate": {
      userContent = { v: 1, kind: "user_event", event: "generate", label: prev.brief.externalName ? "重新生成方案" : "生成活动方案" };
      createdBy = "ai";
      agent = { trigger: { kind: "generate_clicked" }, base: prev, openCard: null };
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

  let reply: string | null = null;
  let agentCard: AgentCard | null = null;
  if (agent) {
    let result: AgentResult | null = null;
    try {
      result = await deps.runAgent({
        today: deps.today,
        draft: agent.base,
        history: historyForAgent(bundle.messages),
        trigger: agent.trigger,
        openCard: agent.openCard,
        planIsCurrent: Boolean(agent.base.brief.externalName) && !factsChangedSincePlan(bundle, agent.base),
        canUndo: latest.seq > 1,
      });
    } catch (error) {
      const reason = errorText(error, "Agent 服务暂时不可用");
      if (input.type === "interpret") return commitMessagesOnly(null, [{ v: 1, kind: "agent_error", text: `没理解成功：${reason}`, retry: { type: "interpret" } }]);
      if (input.type === "text") return commitMessagesOnly(userContent, [{ v: 1, kind: "agent_error", text: `这句没处理成功：${reason}`, retry: { type: "text", text: input.text } }]);
      if (input.type === "generate") return commitMessagesOnly(userContent, [{ v: 1, kind: "agent_error", text: `方案生成失败：${reason}`, retry: { type: "generate" } }]);
      // 卡片提交：选项已经写进草稿，先保存下来，方案可以重试生成。
      notes.push({ v: 1, kind: "agent_error", text: `方案生成失败：${reason}`, retry: { type: "generate" } });
    }
    if (result?.undo) {
      const target = bundle.versions.find((version) => version.seq === latest.seq - 1);
      if (target) {
        next = structuredClone(target.draft);
        createdBy = "rollback";
      }
    } else if (result) {
      next = result.draft;
      ops = [...ops, ...result.ops];
      generated = result.generated;
    }
    reply = result?.reply ?? null;
    agentCard = result?.card ?? null;
  }

  next = deriveDraft(next);
  const orders = buildIcsDrafts(next);
  const issues = validateDraft(next, orders);
  const diffs = diffDrafts(prev, next);
  const changed = diffs.length > 0;
  const versionSeq = latest.seq + 1;
  const versionId = changed ? newId() : null;

  const agentMessages: StoredMessage[] = [];
  // 卡片提交的内容已经写在用户那条消息里，理解需求的结果写在卡片的复述里，都不再单独列改动。
  const listChanges = changed && input.type !== "interpret" && input.type !== "clarify_submit";
  const items = listChanges ? summarizeChanges(prev, next).filter((item) => !generated || !COPY_LABELS.has(item.label)) : [];
  if (items.length) {
    agentMessages.push({
      v: 1,
      kind: "agent_change",
      title: input.type === "rollback" ? `已恢复到版本 ${input.seq}` : createdBy === "rollback" ? "已撤销" : items.length === 1 ? "记下了" : `改了 ${items.length} 处`,
      items,
      versionSeq,
    });
  }
  if (agent && noIcsOrders(next) && !noIcsOrders(prev)) agentMessages.push({ v: 1, kind: "agent_no_ics", reason: noIcsReason(next) });
  if (reply) agentMessages.push(agentText(reply));
  agentMessages.push(...notes);
  // 生成的文案和上一版完全一样时不产生新版本，方案指向当前版本。
  if (generated) agentMessages.push(planMessage(next, orders, issues, changed ? versionSeq : latest.seq));

  if (agentCard) {
    agentMessages.push(agentCard);
  } else if (generated && missingFields(next).length > 0) {
    const card = missingCard(next, CARD_INTRO.later);
    if (card) agentMessages.push(card);
  } else if (input.type === "interpret" && !generated) {
    // 兜底：第一轮 Agent 没出卡片也没出方案时，照样给出理解结果和要补的项。
    const questions = buildClarifyQuestions(next, [], { segments: [], series: [] });
    if (questions.length) agentMessages.push({ v: 1, kind: "agent_clarify", intro: CARD_INTRO.first, ...readbackItems(next), questions });
  }

  if (!agent) agentMessages.push(...followUps(prev, next, diffs, bundle.messages));
  if (agent && agentMessages.length === 0) agentMessages.push(agentText("我没理解要做什么，可以换个说法，或者直接在卡片、草稿面板里改。"));

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
