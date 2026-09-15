import type { AgentPhase, AgentRequest, AgentResult, AgentTrigger } from "../agent/protocol.ts";
import { applyCardAnswers } from "../campaign/ics1811/card.ts";
import { checkDraft } from "../campaign/ics1811/checks.ts";
import { deriveFill } from "../campaign/ics1811/derive.ts";
import { EXAMPLES } from "../campaign/ics1811/examples.ts";
import { applyFactWrites, createEmptyDraft } from "../campaign/ics1811/facts.ts";
import { renderFillSheet, type FillSheet } from "../campaign/ics1811/fill-sheet.ts";
import { flowOf, messageToText, summarizeFactChanges, type ChatMessage, type StoredMessage } from "../campaign/ics1811/messages.ts";
import { planNext } from "../campaign/ics1811/questions.ts";
import { buildReadback } from "../campaign/ics1811/readback.ts";
import type { Check, FactKey, FillModel, Gap, Ics1811Draft, Plan } from "../campaign/ics1811/types.ts";
import { ConflictError, type SessionBundle, type SessionStatus, type SessionStore, type TurnWrite } from "./session-store.ts";

// 需要模型的回合（理解首句、用户打字）交给 Agent 服务；出卡、复述、确认、落库都由这里的代码决定（设计文档 4.3 节）。
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
  | { type: "card"; answers: Record<string, unknown>; expectedSeq: number }
  | { type: "edit"; answers: Record<string, unknown>; copy: { name?: string; content?: string } | null; origin: "panel" | "tool"; expectedSeq: number }
  | { type: "interpret"; expectedSeq: number }
  | { type: "confirm"; expectedSeq: number }
  | { type: "dismiss"; noteId: string; expectedSeq: number }
  | { type: "undo"; versionSeq: number; expectedSeq: number }
  | { type: "rollback"; seq: number; expectedSeq: number };

export type VersionSummary = { seq: number; source: string; createdAt: string; diffCount: number };

export type FlowPhase = "interpreting" | "asking" | "readback" | "blocked" | "confirmed" | "out_of_scope";

export type Snapshot = {
  session: { id: string; title: string; status: string; entryMode: string; createdAt: string; updatedAt: string };
  messages: ChatMessage[];
  versions: VersionSummary[];
  latest: { seq: number; draft: Ics1811Draft; fill: FillModel; checks: Check[]; sheet: FillSheet };
  flow: {
    phase: FlowPhase;
    roundsUsed: number;
    openCardId: string | null;
    openQuestions: Gap[]; // 开着的卡片上还没答的题
    readbackId: string | null; // 对应最新版本的复述
    canConfirm: boolean;
    missing: string[];
    confirmedSeq: number | null;
    pendingInterpretation: boolean;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const agentText = (text: string): StoredMessage => ({ v: 2, kind: "agent_text", text });

export function parseTurnInput(body: unknown): TurnInput {
  if (!isRecord(body) || !integer(body.expectedSeq)) throw new TurnError(400, "请求内容不完整");
  const expectedSeq = body.expectedSeq;
  switch (body.type) {
    case "text":
      if (typeof body.text !== "string" || !body.text.trim()) throw new TurnError(400, "请输入内容");
      return { type: "text", text: body.text.trim().slice(0, 1000), expectedSeq };
    case "card":
      return { type: "card", answers: isRecord(body.answers) ? body.answers : {}, expectedSeq };
    case "edit": {
      const copy = isRecord(body.copy) ? body.copy : null;
      return {
        type: "edit",
        answers: isRecord(body.answers) ? body.answers : {},
        copy: copy ? { ...(typeof copy.name === "string" ? { name: copy.name.trim() } : {}), ...(typeof copy.content === "string" ? { content: copy.content.trim() } : {}) } : null,
        origin: body.origin === "tool" ? "tool" : "panel",
        expectedSeq,
      };
    }
    case "interpret":
      return { type: "interpret", expectedSeq };
    case "confirm":
      return { type: "confirm", expectedSeq };
    case "dismiss":
      if (typeof body.noteId !== "string" || !body.noteId) throw new TurnError(400, "请求内容不完整");
      return { type: "dismiss", noteId: body.noteId, expectedSeq };
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

function evaluate(draft: Ics1811Draft, messages: readonly ChatMessage[], today: string) {
  const fill = deriveFill(draft);
  const checks = checkDraft(draft, fill, today);
  const flow = flowOf(messages);
  const plan = planNext(draft, fill, checks, flow.roundsUsed, flow.askedBefore);
  return { fill, checks, flow, plan };
}

// 正在问用户的问题：每轮出卡问的是当时全部缺项，两轮用完后复述里列的也是全部缺项。「可以」「没有」这类短回答按这些问题记。
const posedQuestions = (plan: Plan): Gap[] => (plan.action === "ask" ? plan.questions : plan.action === "readback" ? plan.missing : []);

function versionSource(index: number, trigger: StoredMessage | undefined, createdBy: string): string {
  if (index === 0) return "初始";
  if (createdBy === "rollback") return "版本恢复";
  switch (trigger?.kind) {
    case "user_text":
      return "对话修改";
    case "user_card_submit":
      return "补充卡片";
    case "user_edit":
      return trigger.origin === "panel" ? "草稿手改" : "工具修改";
    case "user_event":
      return trigger.event === "dismiss" ? "处理提示" : "版本恢复";
    default:
      return trigger?.kind.startsWith("agent_") ? "理解需求" : "修改";
  }
}

export function buildSnapshot(bundle: SessionBundle, today: string): Snapshot {
  if (bundle.legacy) throw new TurnError(410, "这个活动是旧版本创建的，请新建活动");
  const latest = bundle.versions.at(-1);
  if (!latest) throw new TurnError(404, "活动还没有可打开的版本");
  const { fill, checks, flow, plan } = evaluate(latest.draft, bundle.messages, today);
  const pendingInterpretation = isPendingInterpretation(bundle);
  const confirmed = flow.confirmedSeq === latest.seq;
  const gaps = posedQuestions(plan);
  const openIds = flow.openCard?.content.questions.map((question) => question.id) ?? [];
  const phase: FlowPhase = pendingInterpretation
    ? "interpreting"
    : confirmed
      ? "confirmed"
      : plan.action === "out_of_scope"
        ? "out_of_scope"
        : flow.openCard || plan.action === "ask"
          ? "asking"
          : plan.canConfirm ? "readback" : "blocked";
  const triggers = new Map(bundle.messages.filter((message) => message.producedVersionId).map((message) => [message.producedVersionId as string, message.content]));
  return {
    session: { ...bundle.session },
    messages: bundle.messages.map(({ id, role, createdAt, content }) => ({ id, role, createdAt, content })),
    versions: bundle.versions.map((version, index) => ({
      seq: version.seq,
      source: versionSource(index, triggers.get(version.id), version.createdBy),
      createdAt: version.createdAt,
      diffCount: index === 0 ? 0 : summarizeFactChanges(bundle.versions[index - 1].draft, version.draft).length,
    })),
    latest: { seq: latest.seq, draft: latest.draft, fill, checks, sheet: renderFillSheet(fill, checks) },
    flow: {
      phase,
      roundsUsed: flow.roundsUsed,
      openCardId: flow.openCard?.id ?? null,
      openQuestions: gaps.filter((gap) => openIds.includes(gap.id)),
      readbackId: flow.latestReadback?.content.versionSeq === latest.seq ? flow.latestReadback.id : null,
      canConfirm: plan.action === "readback" && plan.canConfirm,
      missing: gaps.map((gap) => gap.title),
      confirmedSeq: flow.confirmedSeq,
      pendingInterpretation,
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
  return buildSnapshot(bundle, deps.today);
}

// 最近的对话，给 Agent 当上下文。
function historyForAgent(messages: readonly ChatMessage[]): AgentRequest["history"] {
  return messages.slice(-12).flatMap((message) => {
    const text = messageToText(message.content).trim();
    return text ? [{ role: message.role, text: text.slice(0, 400) }] : [];
  });
}

// 这些事实变了，模型之前起草的名称和内容可能过时，退回模板，等下一次对话再重拟。
const COPY_FACTS: readonly FactKey[] = ["offer", "categories", "productScope", "gramBasis", "thresholdRepeat", "discountEditable", "stores", "dates"];

function copyOutdated(before: Ics1811Draft, after: Ics1811Draft): boolean {
  return COPY_FACTS.some((key) => JSON.stringify(before.facts[key]?.value ?? null) !== JSON.stringify(after.facts[key]?.value ?? null));
}

const changeLabel = (before: Ics1811Draft, after: Ics1811Draft, empty: string) =>
  summarizeFactChanges(before, after).map((item) => `${item.label}：${item.after}`).join("；") || empty;

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
    const draft = createEmptyDraft(newId(), text);
    return commitAndLoad(deps, {
      isNew: true,
      now,
      session: { id: sessionId, title: text.slice(0, 28), entryMode, status: "collecting", createdAt: now, updatedAt: now },
      version: { id: versionId, seq: 1, draft, sheet: null, createdBy: "human", patch: null },
      messages: [{ id: newId(), role: "user", content: { v: 2, kind: "user_text", text }, producedVersionId: versionId }],
    });
  }

  // 示例：SOP 第九部分的复述示例（T1），信息齐全，不调 Agent，直接复述。
  const example = EXAMPLES[0];
  const draft = applyFactWrites(createEmptyDraft(newId(), example.first), example.firstWrites, { text: example.first, today: deps.today }).draft;
  const { fill, checks, plan } = evaluate(draft, [], deps.today);
  const readback = buildReadback(draft, fill, checks, plan.action === "readback" ? plan.missing : []);
  return commitAndLoad(deps, {
    isNew: true,
    now,
    session: { id: sessionId, title: fill.info.name.value, entryMode, status: readback.canConfirm ? "readback" : "collecting", createdAt: now, updatedAt: now },
    version: { id: versionId, seq: 1, draft, sheet: renderFillSheet(fill, checks), createdBy: "human", patch: null },
    messages: [
      { id: newId(), role: "user", content: { v: 2, kind: "user_text", text: example.first }, producedVersionId: versionId },
      { id: newId(), role: "assistant", content: agentText("信息都齐了，不用追问。下面是我的理解，确认无误就生成 1811 填写值。"), producedVersionId: null },
      { id: newId(), role: "assistant", content: { v: 2, kind: "agent_readback", versionSeq: 1, readback }, producedVersionId: null },
    ],
  });
}

export async function runTurn(sessionId: string, body: unknown, deps: TurnDeps): Promise<Snapshot> {
  const input = parseTurnInput(body);
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const bundle = await deps.store.load(sessionId);
  if (!bundle) throw new TurnError(404, "找不到这个活动");
  if (bundle.legacy) throw new TurnError(410, "这个活动是旧版本创建的，请新建活动");
  const latest = bundle.versions.at(-1);
  if (!latest) throw new TurnError(404, "活动还没有可打开的版本");
  if (input.expectedSeq !== latest.seq) throw new TurnError(409, "页面已更新，请重试");

  const before = evaluate(latest.draft, bundle.messages, deps.today);
  const prev = latest.draft;
  const previousVersion = () => {
    const target = bundle.versions.find((version) => version.seq === latest.seq - 1);
    if (!target) throw new TurnError(404, "找不到要恢复的版本");
    return structuredClone(target.draft);
  };

  const commitMessagesOnly = (userContent: StoredMessage | null, messages: StoredMessage[]) => commitAndLoad(deps, {
    isNew: false,
    now,
    session: { ...bundle.session, updatedAt: now },
    version: null,
    messages: [
      ...(userContent ? [{ id: newId(), role: "user" as const, content: userContent, producedVersionId: null }] : []),
      ...messages.map((content) => ({ id: newId(), role: "assistant" as const, content, producedVersionId: null })),
    ],
  });

  let next: Ics1811Draft = prev;
  let userContent: StoredMessage | null = null;
  let createdBy: "ai" | "human" | "rollback" = "human";
  let patch: { ops: unknown; source: "ai" | "human"; reason: string } | null = null;
  let trigger: AgentTrigger | null = null;
  let confirm = false;
  const notes: StoredMessage[] = [];

  switch (input.type) {
    case "interpret":
      if (!isPendingInterpretation(bundle)) throw new TurnError(409, "这句话已经理解过了");
      trigger = { kind: "first_message", text: prev.requestText };
      createdBy = "ai";
      break;
    case "text":
      userContent = { v: 2, kind: "user_text", text: input.text };
      trigger = { kind: "user_message", text: input.text };
      createdBy = "ai";
      break;
    case "card": {
      const card = before.flow.openCard;
      if (!card) throw new TurnError(409, "这张卡片已经提交过了");
      const asked = card.content.questions.map((question) => question.id as string);
      const result = applyCardAnswers(prev, Object.fromEntries(Object.entries(input.answers).filter(([id]) => asked.includes(id))));
      next = result.draft;
      if (result.ignored.length) notes.push(agentText(`有 ${result.ignored.length} 项没记下：${result.ignored.map((item) => item.reason).join("；")}`));
      userContent = { v: 2, kind: "user_card_submit", round: card.content.round, label: changeLabel(prev, next, "先不补充") };
      patch = { ops: { answers: input.answers, applied: result.applied }, source: "human", reason: `第 ${card.content.round} 轮卡片` };
      break;
    }
    case "edit": {
      const result = applyCardAnswers(prev, input.answers);
      next = result.draft;
      if (input.copy) {
        next = { ...next, copy: { name: input.copy.name ?? before.fill.info.name.value, content: input.copy.content ?? before.fill.info.content.value, source: "user" } };
      }
      if (result.ignored.length) throw new TurnError(400, result.ignored.map((item) => item.reason).join("；"));
      userContent = { v: 2, kind: "user_edit", label: changeLabel(prev, next, "没有改动"), origin: input.origin };
      patch = { ops: { answers: input.answers, copy: input.copy }, source: "human", reason: input.origin === "panel" ? "草稿手改" : "工具修改" };
      break;
    }
    case "confirm":
      confirm = true;
      userContent = { v: 2, kind: "user_event", event: "confirm", label: "确认无误，生成填写值" };
      break;
    case "dismiss":
      if (!before.fill.notes.some((note) => note.id === input.noteId && note.kind === "restriction_unresolved")) throw new TurnError(400, "这条提示不能直接跳过");
      next = { ...prev, dismissedNotes: [...prev.dismissedNotes, input.noteId] };
      userContent = { v: 2, kind: "user_event", event: "dismiss", label: "这条限制不限定" };
      break;
    case "undo":
      if (input.versionSeq !== latest.seq || latest.seq <= 1) throw new TurnError(409, "之后已有新的修改，可以在版本页签里恢复");
      next = previousVersion();
      createdBy = "rollback";
      userContent = { v: 2, kind: "user_event", event: "undo", label: "撤销上一次修改" };
      break;
    case "rollback": {
      const target = bundle.versions.find((version) => version.seq === input.seq);
      if (!target) throw new TurnError(404, "找不到要恢复的版本");
      next = structuredClone(target.draft);
      createdBy = "rollback";
      userContent = { v: 2, kind: "user_event", event: "rollback", label: `恢复到版本 ${input.seq}` };
      break;
    }
  }

  let reply: string | null = null;
  let copyDrafted = false;
  if (trigger) {
    const phase: AgentPhase = input.type === "interpret"
      ? "interpreting"
      : before.flow.confirmedSeq === latest.seq ? "output" : before.flow.openCard ? "asking" : before.flow.latestReadback ? "readback" : "asking";
    let result: AgentResult;
    try {
      result = await deps.runAgent({
        today: deps.today,
        draft: next,
        history: historyForAgent(bundle.messages),
        trigger,
        phase,
        roundsUsed: before.flow.roundsUsed,
        openQuestions: posedQuestions(before.plan).map((question) => question.id),
        readbackSeq: before.flow.latestReadback?.content.versionSeq === latest.seq ? latest.seq : null,
        canConfirm: before.plan.action === "readback" && before.plan.canConfirm,
        canUndo: latest.seq > 1,
      });
    } catch (error) {
      const reason = errorText(error, "Agent 服务暂时不可用");
      if (input.type === "interpret") return commitMessagesOnly(null, [{ v: 2, kind: "agent_error", text: `没理解成功：${reason}`, retry: { type: "interpret" } }]);
      return commitMessagesOnly(userContent, [{ v: 2, kind: "agent_error", text: `这句没处理成功：${reason}`, retry: { type: "text", text: input.type === "text" ? input.text : "" } }]);
    }
    if (result.undo) {
      next = previousVersion();
      createdBy = "rollback";
    } else {
      next = result.draft;
      copyDrafted = result.copyDrafted;
      if (result.applied.length || result.dropped.length) patch = { ops: { applied: result.applied, dropped: result.dropped }, source: "ai", reason: trigger.text.slice(0, 200) };
    }
    reply = result.reply;
    confirm = result.confirmRequested && !result.undo;
  }

  if (next.copy?.source === "ai" && !copyDrafted && copyOutdated(prev, next)) next = { ...next, copy: null };

  const changed = JSON.stringify(prev) !== JSON.stringify(next);
  const versionSeq = changed ? latest.seq + 1 : latest.seq;
  const versionId = changed ? newId() : null;
  const after = evaluate(next, bundle.messages, deps.today);
  const agentMessages: StoredMessage[] = [];

  if (changed && input.type !== "interpret" && input.type !== "card") {
    const items = summarizeFactChanges(prev, next);
    if (items.length) {
      const title = input.type === "rollback" ? `已恢复到版本 ${input.seq}` : createdBy === "rollback" ? "已撤销" : items.length === 1 ? "记下了" : `改了 ${items.length} 处`;
      agentMessages.push({ v: 2, kind: "agent_change", title, items, versionSeq });
    }
  }
  // 不在 1811 范围时只留代码的说明，免得模型再说一遍意思相同的话。
  if (reply && after.plan.action !== "out_of_scope") agentMessages.push(agentText(reply));
  agentMessages.push(...notes);

  let status: SessionStatus = "collecting";
  if (confirm) {
    if (changed || before.flow.latestReadback?.content.versionSeq !== latest.seq) throw new TurnError(409, "复述已经更新，请看最新的复述再确认");
    if (!(after.plan.action === "readback" && after.plan.canConfirm)) throw new TurnError(409, "还有没补齐或没通过的项，不能确认");
    agentMessages.push({ v: 2, kind: "agent_fill_sheet", versionSeq: latest.seq, sheet: renderFillSheet(after.fill, after.checks) });
    status = "confirmed";
  } else if (after.plan.action === "out_of_scope") {
    if (trigger) agentMessages.push(agentText(after.plan.reason));
  } else if (after.plan.action === "ask") {
    // 卡片还开着时打字或手改：要问的都还在这张卡片上，就不出新卡片（已答的题隐藏）；
    // 回答引出了卡片上没有的追问，就出下一轮，把新追问和上一轮没答的一起问。
    const onCard = before.flow.openCard?.content.questions.map((question) => question.id) ?? [];
    const keepOpen = Boolean(before.flow.openCard) && input.type !== "card" && after.plan.questions.every((question) => onCard.includes(question.id));
    if (!keepOpen) agentMessages.push({ v: 2, kind: "agent_round_card", round: after.plan.round, questions: after.plan.questions });
  } else {
    const current = !changed && !before.flow.openCard && before.flow.latestReadback?.content.versionSeq === latest.seq;
    if (!current) agentMessages.push({ v: 2, kind: "agent_readback", versionSeq, readback: buildReadback(next, after.fill, after.checks, after.plan.missing) });
    status = after.plan.canConfirm ? "readback" : "collecting";
  }
  if (!confirm && before.flow.confirmedSeq === latest.seq && !changed) status = "confirmed";
  if (trigger && agentMessages.length === 0) agentMessages.push(agentText("我没理解这句要改什么，可以换个说法再说一次。"));

  const title = next.facts.offer ? after.fill.info.name.value : bundle.session.title;
  return commitAndLoad(deps, {
    isNew: false,
    now,
    session: { ...bundle.session, title, status, updatedAt: now },
    version: versionId
      ? { id: versionId, seq: versionSeq, draft: next, sheet: renderFillSheet(after.fill, after.checks), createdBy, patch: patch ? { id: newId(), ...patch } : null }
      : null,
    messages: [
      ...(userContent ? [{ id: newId(), role: "user" as const, content: userContent, producedVersionId: versionId }] : []),
      // 没有用户消息的回合（理解需求），由第一条 Agent 消息标记它产生的版本。
      ...agentMessages.map((content, index) => ({ id: newId(), role: "assistant" as const, content, producedVersionId: !userContent && index === 0 ? versionId : null })),
    ],
  });
}
