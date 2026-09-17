import type { AgentPhase, AgentRequest, AgentResult, AgentTrigger } from "../agent/protocol.ts";
import type { AgentProgressEvent } from "../agent/stream.ts";
import { AGENT_TOOL_META } from "../agent/tools.ts";
import { renderCommunicationPlan } from "../campaign/communication.ts";
import type { CampaignBriefKey, CampaignDraft, CampaignWorkspace, CommunicationPlan } from "../campaign/types.ts";
import { buildCampaignWorkspace, createCampaignDraft, ensureIcs1811Child, normalizeCampaignDraft } from "../campaign/workspace.ts";
import { applyCardAnswers } from "../campaign/ics1811/card.ts";
import { checkDraft } from "../campaign/ics1811/checks.ts";
import { deriveFill } from "../campaign/ics1811/derive.ts";
import { EXAMPLES } from "../campaign/ics1811/examples.ts";
import { applyFactWrites, createEmptyDraft } from "../campaign/ics1811/facts.ts";
import { renderFillSheet, type FillSheet } from "../campaign/ics1811/fill-sheet.ts";
import { flowOf, messageToText, summarizeFactChanges, type ChangeItem, type ChatMessage, type StoredMessage } from "../campaign/ics1811/messages.ts";
import { isPureAgreement } from "../campaign/ics1811/phrases.ts";
import { renderPromo, type PromoDoc } from "../campaign/ics1811/promo.ts";
import { acceptProposals, liveProposals, withoutEitherOr } from "../campaign/ics1811/proposals.ts";
import { byPriority, planNext } from "../campaign/ics1811/questions.ts";
import { buildReadback } from "../campaign/ics1811/readback.ts";
import type { Check, FactKey, FillModel, FlowPhase, Gap, Ics1811Draft, Proposal, QuestionId } from "../campaign/ics1811/types.ts";
import { finishTraceEvent, intervalUnionDurationMs, isToolTraceTiming, mergeTraceEvent, startTraceEvent, type AgentTraceEvent, type CampaignToolName, type ToolTrace, type ToolTraceTiming } from "../tool-trace.ts";
import { ConflictError, type SessionBundle, type SessionStatus, type SessionStore, type TurnWrite } from "./session-store.ts";

// 需要模型的回合（理解首句、用户打字）交给 Agent 服务：问什么、怎么说归模型。
// 缺什么、齐没齐、生不生成填写值、落库都由这里的代码按事实层重算决定（设计文档 4.3 节）。
export type AgentTransientEvent = Exclude<AgentProgressEvent, { type: "trace" }>;
export type AgentRunner = (
  request: AgentRequest,
  onTrace?: (event: AgentTraceEvent) => void,
  onProgress?: (event: AgentTransientEvent) => void,
) => Promise<AgentResult>;

export type TurnDeps = {
  store: SessionStore;
  runAgent: AgentRunner;
  today: string;
  now?: () => string;
  newId?: () => string;
  emitTrace?: (event: AgentTraceEvent) => void;
  emitProgress?: (event: AgentTransientEvent) => void;
};

export class TurnError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// 没有「确认」和「提交卡片」：信息齐了就生成填写值，追问在对话里答。
export type TurnInput =
  | { type: "text"; text: string; expectedSeq: number }
  | { type: "edit"; answers: Record<string, unknown>; copy: { name?: string; content?: string } | null; origin: "panel" | "tool"; expectedSeq: number }
  | { type: "interpret"; expectedSeq: number }
  | { type: "dismiss"; noteId: string; expectedSeq: number }
  | { type: "undo"; versionSeq: number; expectedSeq: number }
  | { type: "rollback"; seq: number; expectedSeq: number };

export type VersionSummary = { seq: number; source: string; createdAt: string; diffCount: number };

// 阶段类型已挪到领域层（等待文案 thinking.ts 要用，不能反向依赖 server 层），这里只转出去。
export type { FlowPhase };

export type Snapshot = {
  session: { id: string; title: string; status: string; entryMode: string; createdAt: string; updatedAt: string };
  messages: ChatMessage[];
  versions: VersionSummary[];
  // Campaign 是唯一持久化文档；1811 是可选子流程。传播方案、fill/sheet/promo 都从草稿重算，不另存。
  latest: {
    seq: number;
    campaign: CampaignDraft;
    draft: Ics1811Draft | null;
    fill: FillModel | null;
    checks: Check[];
    sheet: FillSheet | null;
    communication: CommunicationPlan | null;
    // 旧版 1811 对外文案只读兼容；新传播方案以 communication 为准。
    promo: PromoDoc | null;
  };
  workspace: CampaignWorkspace;
  flow: {
    phase: FlowPhase;
    replyId: string | null; // Agent 最近一次回复；asking 和 proposals 出自这条
    asking: Gap[]; // 那条回复问过、现在仍缺的
    proposals: Proposal[]; // 那条回复的提议、现在仍适用的；用户回「行」就按这个记
    missing: string[];
    missingIds: QuestionId[]; // 和 missing 一一对应；界面按题号取那句能照抄的回答示例
    sheetSeq: number | null; // 最近一次生成填写值对应的版本
    pendingInterpretation: boolean;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const agentText = (text: string): StoredMessage => ({ v: 2, kind: "agent_text", text });

function localToolDurationMs(events: readonly AgentTraceEvent[]): number {
  if (!events.length) return 0;
  const origin = Math.min(...events.map((event) => event.startedAt));
  return intervalUnionDurationMs(events.map((event) => ({
    offsetMs: Math.max(0, event.startedAt - origin),
    durationMs: event.durationMs ?? 0,
  })));
}

function combinedTraceTiming(
  events: readonly AgentTraceEvent[],
  turnStartedAt: number,
  workerTotalMs: number,
  agentTiming?: ToolTraceTiming,
): ToolTraceTiming {
  // Agent 和 Workers 可能在不同机器上，绝不能拿两边的 startedAt 直接相减。
  // 模型步骤使用 Agent 自己的 monotonic 汇总；编排器步骤只在 Workers 本机做区间并集。
  const orchestrator = events.filter((event) => event.initiatedBy === "orchestrator");
  const orchestratorMs = intervalUnionDurationMs(orchestrator.map((event) => ({
    offsetMs: Math.max(0, event.startedAt - turnStartedAt),
    durationMs: event.durationMs ?? 0,
  })));
  const model = events.filter((event) => event.initiatedBy === "model");
  const modelMs = agentTiming?.skillsToolsMs ?? localToolDurationMs(model);
  const totalMs = Math.max(0, workerTotalMs, agentTiming?.totalMs ?? 0);
  const skillsToolsMs = Math.min(totalMs, modelMs + orchestratorMs);
  return {
    totalMs,
    analysisWaitingMs: Math.max(0, totalMs - skillsToolsMs),
    skillsToolsMs,
  };
}

function toolTraceOf(
  events: readonly AgentTraceEvent[],
  turnStartedAt: number,
  workerTotalMs: number,
  options: { status?: "failed"; agentTiming?: ToolTraceTiming } = {},
): ToolTrace | null {
  const steps = events.filter((event) => event.status !== "started");
  if (!steps.length && options.status !== "failed") return null;
  const timing = combinedTraceTiming(steps, turnStartedAt, workerTotalMs, options.agentTiming);
  return {
    status: options.status ?? (steps.some((event) => event.status === "failed") ? "failed" : steps.some((event) => event.status === "warning") ? "warning" : "completed"),
    durationMs: timing.skillsToolsMs,
    timing,
    steps,
  };
}

function timingFromAgentError(error: unknown): ToolTraceTiming | undefined {
  if (!error || typeof error !== "object" || !("timing" in error)) return undefined;
  const timing = (error as { timing?: unknown }).timing;
  return isToolTraceTiming(timing) ? timing : undefined;
}

export function parseTurnInput(body: unknown): TurnInput {
  if (!isRecord(body) || !integer(body.expectedSeq)) throw new TurnError(400, "请求内容不完整");
  const expectedSeq = body.expectedSeq;
  switch (body.type) {
    case "text":
      if (typeof body.text !== "string" || !body.text.trim()) throw new TurnError(400, "请输入内容");
      return { type: "text", text: body.text.trim().slice(0, 1000), expectedSeq };
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
    !bundle.messages.some((message) => message.role === "assistant" && message.content.kind !== "agent_error" && message.content.kind !== "agent_tool_trace");
}

function evaluate(campaign: CampaignDraft, messages: readonly ChatMessage[], today: string) {
  const workspace = buildCampaignWorkspace(campaign, today);
  const flow = flowOf(messages);
  const draft = campaign.ics1811;
  if (!draft) {
    return {
      workspace,
      draft,
      fill: null,
      checks: [] as Check[],
      plan: null,
      flow,
      missing: [] as Gap[],
      asking: [] as QuestionId[],
      proposals: [] as Proposal[],
    };
  }
  const fill = deriveFill(draft);
  const checks = checkDraft(draft, fill, today);
  const plan = planNext(draft, fill, checks);
  const missing: Gap[] = plan.action === "collect" ? plan.missing : [];
  const missingIds = missing.map((gap) => gap.id);
  // Agent 上一句问的只留现在仍缺的；提议只留仍然成立的（用户之后自己改过的作废）。建好后的改值提议也算。
  const asking = flow.asking.filter((id) => missingIds.includes(id));
  const proposals = plan.action === "out_of_scope" ? [] : liveProposals(draft, flow.proposals, today);
  return { workspace, draft, fill, checks, plan, flow, missing, asking, proposals };
}

function phaseOf(state: ReturnType<typeof evaluate>, pendingInterpretation: boolean): FlowPhase {
  if (pendingInterpretation) return "interpreting";
  const { plan } = state;
  if (!plan) {
    if (state.workspace.stage === "blocked") return "blocked";
    return state.workspace.brief.status === "ready" ? "ready" : "collecting";
  }
  if (plan.action === "out_of_scope") return "out_of_scope";
  if (plan.action === "ready") return "ready";
  return plan.missing.length ? "collecting" : "blocked";
}

function sessionStatusOf(state: ReturnType<typeof evaluate>): SessionStatus {
  if (state.plan?.action === "ready") return "ics_ready";
  if (state.workspace.stage === "preparing") return "preparing";
  if (state.workspace.stage === "needs_confirmation") return "needs_confirmation";
  return "briefing";
}

const BRIEF_LABEL: Record<CampaignBriefKey, string> = {
  name: "活动名称",
  objective: "活动目标",
  audience: "目标受众",
  theme: "活动主题",
  channels: "传播渠道",
  timing: "活动时机",
  scope: "活动范围",
};

function briefValue(campaign: CampaignDraft, key: CampaignBriefKey): string {
  const value = campaign.brief[key]?.value;
  if (value === undefined || value === null) return "未填";
  return Array.isArray(value) ? value.join("、") : String(value);
}

function summarizeCampaignChanges(before: CampaignDraft, after: CampaignDraft): ChangeItem[] {
  const brief = (Object.keys(BRIEF_LABEL) as CampaignBriefKey[]).flatMap((key) => {
    const previous = briefValue(before, key);
    const next = briefValue(after, key);
    return previous === next ? [] : [{ label: BRIEF_LABEL[key], before: previous, after: next }];
  });
  const child = before.ics1811 && after.ics1811
    ? summarizeFactChanges(before.ics1811, after.ics1811)
    : before.ics1811 === after.ics1811
      ? []
      : [{ label: "1811 优惠配置", before: before.ics1811 ? "已创建" : "不适用", after: after.ics1811 ? "已创建" : "不适用" }];
  const communication = JSON.stringify(before.communication) === JSON.stringify(after.communication)
    ? []
    : [{ label: "传播方案", before: before.communication ? "已起草" : "未起草", after: after.communication ? "已起草" : "未起草" }];
  return [...brief, ...child, ...communication];
}

// 活动建好（或建好后又改了）时放进对话的那条：填写值，外加代码写的「这次建了什么」。
function sheetMessage(draft: Ics1811Draft, fill: FillModel, checks: readonly Check[], versionSeq: number, sheet: FillSheet): StoredMessage {
  const summary = buildReadback(draft, fill, checks, []);
  return { v: 2, kind: "agent_fill_sheet", versionSeq, sheet, summary: summary.summary, lines: summary.essentials };
}

function versionSource(index: number, trigger: StoredMessage | undefined, createdBy: string): string {
  if (index === 0) return "初始";
  if (createdBy === "rollback") return "版本恢复";
  switch (trigger?.kind) {
    case "user_text":
      return "对话修改";
    case "user_card_submit":
      return "补充卡片"; // 旧会话
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
  const state = evaluate(latest.draft, bundle.messages, today);
  const pendingInterpretation = isPendingInterpretation(bundle);
  const triggers = new Map(bundle.messages.filter((message) => message.producedVersionId).map((message) => [message.producedVersionId as string, message.content]));
  return {
    session: { ...bundle.session },
    messages: bundle.messages.map(({ id, role, createdAt, content }) => ({ id, role, createdAt, content })),
    versions: bundle.versions.map((version, index) => ({
      seq: version.seq,
      source: versionSource(index, triggers.get(version.id), version.createdBy),
      createdAt: version.createdAt,
      diffCount: index === 0 ? 0 : summarizeCampaignChanges(bundle.versions[index - 1].draft, version.draft).length,
    })),
    latest: {
      seq: latest.seq,
      campaign: latest.draft,
      draft: state.draft,
      fill: state.fill,
      checks: state.checks,
      sheet: state.fill ? renderFillSheet(state.fill, state.checks) : null,
      communication: renderCommunicationPlan(latest.draft),
      promo: state.draft && state.fill ? renderPromo(state.draft, state.fill) : null,
    },
    workspace: state.workspace,
    flow: {
      phase: phaseOf(state, pendingInterpretation),
      replyId: state.flow.replyId,
      asking: state.missing.filter((gap) => state.asking.includes(gap.id)),
      proposals: state.proposals,
      missing: state.missing.map((gap) => gap.title),
      missingIds: state.missing.map((gap) => gap.id),
      sheetSeq: state.flow.sheetSeq,
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
// 只列名称和内容真正引用到的事实：templateCopy() 用货类、优惠、克重口径、满减累加、货品范围，
// 内容里还可能写「门店可在折扣基础上改价」，所以带上 discountEditable。
// 门店和日期不在名称和内容里出现，改门店不该把模型起草的名称抹回模板。
const COPY_FACTS: readonly FactKey[] = ["offer", "categories", "productScope", "gramBasis", "thresholdRepeat", "discountEditable"];

function copyOutdated(before: Ics1811Draft, after: Ics1811Draft): boolean {
  return COPY_FACTS.some((key) => JSON.stringify(before.facts[key]?.value ?? null) !== JSON.stringify(after.facts[key]?.value ?? null));
}

const changeLabel = (before: Ics1811Draft, after: Ics1811Draft, empty: string) =>
  summarizeFactChanges(before, after).map((item) => `${item.label}：${item.after}`).join("；") || empty;

// 面板里手改字段也会显示成用户自己说的话，所以 label 要像人说的，
// 而不是 changeLabel 那种「字段：值」的系统写法。
const editSaidLabel = (before: Ics1811Draft, after: Ics1811Draft) => {
  const items = summarizeFactChanges(before, after);
  return items.map((item) => `把${item.label}改成${item.after}`).join("，") || "没有改动";
};

export async function createSession(body: unknown, deps: TurnDeps): Promise<Snapshot> {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const timestamp = deps.now ?? (() => new Date().toISOString());
  const createdAt = timestamp();
  const input = isRecord(body) ? body : {};
  const entryMode = input.entryMode === "example" ? "example" : input.entryMode === "new" ? "new" : null;
  if (!entryMode) throw new TurnError(400, "不支持的新建方式");
  const sessionId = newId();
  const versionId = newId();

  // 新建：只存这句话，立即返回；理解由对话页发起的 interpret 回合交给 Agent。
  if (entryMode === "new") {
    const text = typeof input.text === "string" ? input.text.trim().slice(0, 1000) : "";
    if (text.length < 4) throw new TurnError(400, "请用一句话说明活动");
    const draft = createCampaignDraft(newId(), text);
    return commitAndLoad(deps, {
      isNew: true,
      now: createdAt,
      session: { id: sessionId, title: text.slice(0, 28), entryMode, status: "briefing", createdAt, updatedAt: createdAt },
      version: { id: versionId, seq: 1, draft, sheet: null, createdBy: "human", patch: null },
      messages: [{ id: newId(), role: "user", content: { v: 2, kind: "user_text", text }, producedVersionId: versionId, createdAt }],
    });
  }

  // 示例：SOP 第九部分的复述示例（T1），一句话说全了，不调 Agent，直接建好。
  const example = EXAMPLES[0];
  const child = applyFactWrites(createEmptyDraft(newId(), example.first), example.firstWrites, { text: example.first, today: deps.today }).draft;
  const draft = normalizeCampaignDraft(child);
  const { fill, checks, plan } = evaluate(draft, [], deps.today);
  if (!fill || !plan) throw new Error("示例活动缺少 1811 子流程");
  const sheet = renderFillSheet(fill, checks);
  const ready = plan.action === "ready";
  const assistantAt = timestamp();
  const sheetAt = ready ? timestamp() : null;
  const updatedAt = sheetAt ?? assistantAt;
  return commitAndLoad(deps, {
    isNew: true,
    now: updatedAt,
    session: { id: sessionId, title: fill.info.name.value, entryMode, status: ready ? "ics_ready" : "briefing", createdAt, updatedAt },
    version: { id: versionId, seq: 1, draft, sheet, createdBy: "human", patch: null },
    messages: [
      { id: newId(), role: "user", content: { v: 2, kind: "user_text", text: example.first }, producedVersionId: versionId, createdAt },
      { id: newId(), role: "assistant", content: { v: 2, kind: "agent_text", text: "一句话里已经包含 1811 所需信息，填写值已准备。这只代表系统配置产物就绪，对外上线仍要按上线检查确认。", asking: [], proposals: [] }, producedVersionId: null, createdAt: assistantAt },
      ...(ready ? [{ id: newId(), role: "assistant" as const, content: sheetMessage(child, fill, checks, 1, sheet), producedVersionId: null, createdAt: sheetAt! }] : []),
    ],
  });
}

export async function runTurn(sessionId: string, body: unknown, deps: TurnDeps): Promise<Snapshot> {
  const turnStartedAt = Date.now();
  const turnStartedMonotonic = performance.now();
  const input = parseTurnInput(body);
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const timestamp = deps.now ?? (() => new Date().toISOString());
  const userOccurredAt = timestamp();
  const bundle = await deps.store.load(sessionId);
  if (!bundle) throw new TurnError(404, "找不到这个活动");
  if (bundle.legacy) throw new TurnError(410, "这个活动是旧版本创建的，请新建活动");
  const latest = bundle.versions.at(-1);
  if (!latest) throw new TurnError(404, "活动还没有可打开的版本");
  if (input.expectedSeq !== latest.seq) throw new TurnError(409, "页面已更新，请重试");

  let traceEvents: AgentTraceEvent[] = [];
  let agentTiming: ToolTraceTiming | undefined;
  const recordTrace = (event: AgentTraceEvent) => {
    const previous = traceEvents.find((item) => item.id === event.id);
    traceEvents = mergeTraceEvent(traceEvents, event);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(event)) deps.emitTrace?.(event);
  };
  const traceContent = (status?: "failed"): StoredMessage | null => {
    const trace = toolTraceOf(
      traceEvents,
      turnStartedAt,
      Math.max(0, performance.now() - turnStartedMonotonic),
      { status, agentTiming },
    );
    return trace ? { v: 2, kind: "agent_tool_trace", trace } : null;
  };
  const runOrchestratorTool = <T>(name: CampaignToolName, action: () => T, summary: (value: T) => string): T => {
    const started = startTraceEvent({
      id: crypto.randomUUID(),
      tool: name,
      title: AGENT_TOOL_META[name].title,
      initiatedBy: "orchestrator",
      at: Date.now(),
    });
    recordTrace(started);
    try {
      const value = action();
      recordTrace(finishTraceEvent(started, { status: "completed", summary: summary(value), at: Date.now() }));
      return value;
    } catch (error) {
      recordTrace(finishTraceEvent(started, { status: "warning", summary: "当前条件未通过，未执行", at: Date.now() }));
      throw error;
    }
  };

  const before = evaluate(latest.draft, bundle.messages, deps.today);
  const prev = latest.draft;
  const previousVersion = () => {
    const target = bundle.versions.find((version) => version.seq === latest.seq - 1);
    if (!target) throw new TurnError(404, "找不到要恢复的版本");
    return structuredClone(target.draft);
  };

  const commitMessagesOnly = (userContent: StoredMessage | null, messages: StoredMessage[]) => {
    const records = [
      ...(userContent ? [{ id: newId(), role: "user" as const, content: userContent, producedVersionId: null, createdAt: userOccurredAt }] : []),
      ...messages.map((content) => ({ id: newId(), role: "assistant" as const, content, producedVersionId: null, createdAt: timestamp() })),
    ];
    const committedAt = timestamp();
    return commitAndLoad(deps, {
      isNew: false,
      now: committedAt,
      session: { ...bundle.session, updatedAt: committedAt },
      version: null,
      messages: records,
    });
  };

  let next: CampaignDraft = prev;
  let userContent: StoredMessage | null = null;
  let createdBy: "ai" | "human" | "rollback" = "human";
  let patch: { ops: unknown; source: "ai" | "human"; reason: string } | null = null;
  let trigger: AgentTrigger | null = null;
  const agentTools = new Set<CampaignToolName>();
  // 编排器在调模型之前就按提议记下了事实（用户整句只是点头）。
  let acceptedByOrchestrator = false;
  let acceptedTexts: string[] = [];

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
      next = ensureIcs1811Child(prev, input.text, newId);
      // 整句只是「行」「对」：不靠模型理解，按上一句的提议直接记下，模型拿到的是记好之后的草稿。
      if (prev.ics1811 && before.proposals.length && isPureAgreement(input.text)) {
        const accepted = runOrchestratorTool(
          "accept_campaign_proposals",
          () => acceptProposals(prev.ics1811!, before.proposals, input.text),
          (value) => `按提议记下 ${value.accepted.length} 项`,
        );
        if (accepted.accepted.length) {
          next = { ...prev, ics1811: accepted.draft };
          acceptedByOrchestrator = true;
          acceptedTexts = accepted.accepted.map((item) => item.text);
          patch = { ops: { accepted: accepted.accepted.map((item) => item.id) }, source: "human", reason: `同意提议：${input.text.slice(0, 50)}` };
        }
      }
      break;
    case "edit": {
      if (!prev.ics1811 || !before.fill) throw new TurnError(400, "当前活动没有 1811 优惠配置可修改");
      const result = applyCardAnswers(prev.ics1811, input.answers);
      let child = result.draft;
      if (input.copy) {
        child = { ...child, copy: { name: input.copy.name ?? before.fill.info.name.value, content: input.copy.content ?? before.fill.info.content.value, source: "user" } };
      }
      next = { ...prev, ics1811: child };
      if (result.ignored.length) throw new TurnError(400, result.ignored.map((item) => item.reason).join("；"));
      userContent = { v: 2, kind: "user_edit", label: input.origin === "panel" ? editSaidLabel(prev.ics1811, child) : changeLabel(prev.ics1811, child, "没有改动"), origin: input.origin };
      patch = { ops: { answers: input.answers, copy: input.copy }, source: "human", reason: input.origin === "panel" ? "草稿手改" : "工具修改" };
      break;
    }
    case "dismiss":
      if (!prev.ics1811 || !before.fill?.notes.some((note) => note.id === input.noteId && note.kind === "restriction_unresolved")) throw new TurnError(400, "这条提示不能直接跳过");
      next = { ...prev, ics1811: { ...prev.ics1811, dismissedNotes: [...prev.ics1811.dismissedNotes, input.noteId] } };
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

  let result: AgentResult | null = null;
  if (trigger) {
    const current = evaluate(next, bundle.messages, deps.today);
    // 1811 子阶段与父 Campaign 阶段分开；没有子流程时不伪造 collecting。
    const phase: AgentPhase | null = input.type === "interpret"
      ? "interpreting"
      : before.plan?.action === "ready"
        ? "ready"
        : before.plan
          ? "collecting"
          : null;
    try {
      result = await deps.runAgent({
        today: deps.today,
        campaign: next,
        draft: next.ics1811,
        history: historyForAgent(bundle.messages),
        trigger,
        ...(phase ? { phase } : {}),
        campaignStage: current.workspace.stage,
        ics1811Phase: phase,
        openQuestions: current.asking,
        // 已经按提议记下的不再交给模型，免得它再采纳一遍；只告诉它记下了什么。
        proposals: acceptedByOrchestrator ? [] : before.proposals,
        ...(acceptedTexts.length ? { accepted: acceptedTexts } : {}),
        canUndo: latest.seq > 1,
      }, recordTrace, deps.emitProgress);
    } catch (error) {
      // 远端 Agent 的步骤只能由 Agent 进程自己的时钟收尾；网络中断时宁可不持久化
      // 那条未完成步骤，也不能用 Workers 墙钟编一个耗时。编排器步骤则都在本进程。
      for (const event of traceEvents.filter((item) => item.status === "started" && item.initiatedBy === "orchestrator")) {
        recordTrace(finishTraceEvent(event, { status: "failed", summary: "执行中断，可以重试", at: Date.now() }));
      }
      // 预采纳的事实跟着这一轮一起作废（版本不落库），轨迹不能还写着「已记下」。
      for (const event of traceEvents.filter((item) => item.initiatedBy === "orchestrator" && item.tool === "accept_campaign_proposals" && item.status === "completed")) {
        recordTrace({ ...event, status: "failed", summary: "没保存，重试时会重新记下" });
      }
      const reason = errorText(error, "Agent 服务暂时不可用");
      agentTiming = timingFromAgentError(error);
      const trace = traceContent("failed");
      if (input.type === "interpret") return commitMessagesOnly(null, [...(trace ? [trace] : []), { v: 2, kind: "agent_error", text: `没理解成功：${reason}`, retry: { type: "interpret" } }]);
      return commitMessagesOnly(userContent, [...(trace ? [trace] : []), { v: 2, kind: "agent_error", text: `这句没处理成功：${reason}`, retry: { type: "text", text: input.type === "text" ? input.text : "" } }]);
    }
    agentTiming = result.trace?.timing;
    for (const event of result.trace?.steps ?? []) recordTrace(event);
    for (const toolName of result.tools) agentTools.add(toolName);
    if (result.undo) {
      next = previousVersion();
      createdBy = "rollback";
    } else {
      next = {
        ...next,
        brief: result.brief ?? next.brief,
        ics1811: result.draft,
        communication: result.communication !== undefined ? result.communication : next.communication,
      };
      if (result.briefApplied?.length || result.applied.length || result.dropped.length) {
        patch = {
          ops: {
            briefApplied: result.briefApplied ?? [],
            applied: result.applied,
            dropped: result.dropped,
            ...(patch ? { proposals: patch.ops } : {}),
          },
          source: "ai",
          reason: trigger.text.slice(0, 200),
        };
      }
    }
  }

  // 撤销、恢复是回到那个版本本来的样子，不按「事实变了」清掉当时起草的名称。
  if (createdBy !== "rollback" && prev.ics1811 && next.ics1811 && next.ics1811.copy?.source === "ai" && !(result?.copyDrafted && !result.undo) && copyOutdated(prev.ics1811, next.ics1811)) {
    next = { ...next, ics1811: { ...next.ics1811, copy: null } };
  }

  const changed = JSON.stringify(prev) !== JSON.stringify(next);
  const versionSeq = changed ? latest.seq + 1 : latest.seq;
  const versionId = changed ? newId() : null;
  const deterministicEdit = input.type === "edit" || input.type === "dismiss" || input.type === "undo" || input.type === "rollback";
  const factsTouched = acceptedByOrchestrator || agentTools.has("extract_campaign_facts") || agentTools.has("accept_campaign_proposals");
  const shouldSupplementChildAnalysis = Boolean(next.ics1811) && !agentTools.has("analyze_campaign_state") && (factsTouched || deterministicEdit);
  let after = shouldSupplementChildAnalysis
    ? runOrchestratorTool(
        "analyze_campaign_state",
        () => evaluate(next, bundle.messages, deps.today),
        (value) => (value.plan?.action === "ready" ? "完成规则分析 · 信息已齐" : `完成规则分析 · ${value.missing.length} 项待补`),
      )
    : evaluate(next, bundle.messages, deps.today);
  if (!agentTools.has("analyze_campaign_plan") && (trigger || deterministicEdit)) {
    after = runOrchestratorTool(
      "analyze_campaign_plan",
      () => evaluate(next, bundle.messages, deps.today),
      (value) => `完成整体活动计划分析 · ${value.workspace.routing.tracks.length || 0} 条执行轨`,
    );
  }
  const agentMessages: StoredMessage[] = [];

  if (changed && input.type !== "interpret") {
    const items = summarizeCampaignChanges(prev, next);
    if (items.length) {
      const title = input.type === "rollback" ? `已恢复到版本 ${input.seq}` : createdBy === "rollback" ? "已撤销" : items.length === 1 ? "记下了" : `改了 ${items.length} 处`;
      agentMessages.push({ v: 2, kind: "agent_change", title, items, versionSeq });
    }
  }

  if (result && trigger) {
    const reply = after.draft
      ? replyWithQuestions(result, after, input.type === "interpret" || (factsTouched && changed), after.draft, deps.today)
      : result.reply
        ? { v: 2 as const, kind: "agent_text" as const, text: result.reply, asking: [], proposals: [] }
        : null;
    if (reply) agentMessages.push(reply);
  }

  let status: SessionStatus = sessionStatusOf(after);
  if (after.plan?.action === "ready" && after.draft && after.fill) {
    status = "ics_ready";
    // 齐了就建好：刚补齐的这一轮、或者建好以后又改了，都出一份最新的填写值；什么都没变就不重复出。
    const lastSheet = [...bundle.messages].reverse().find((message) => message.content.kind === "agent_fill_sheet")?.content;
    const rendered = renderFillSheet(after.fill, after.checks);
    // 只改了对外文案这类不进填写值的东西时，填写值和上一份一模一样，不再发一条「已同步更新」。
    // 但中间掉回过「还缺」（比如改出新缺项又撤销），回到建好要再出一份，对话里才看得到。
    const sameAsLast = lastSheet?.kind === "agent_fill_sheet" &&
      JSON.stringify(lastSheet.sheet) === JSON.stringify(rendered) &&
      bundle.versions.filter((version) => version.seq > lastSheet.versionSeq).every((version) => evaluate(version.draft, [], deps.today).plan?.action === "ready");
    if ((changed || before.flow.sheetSeq !== latest.seq) && !sameAsLast) {
      // 模型自己已经成功生成过就不再补跑一步，免得轨迹里同一件事出现两次；内容照样按最终草稿重算。
      const modelGenerated = traceEvents.some((event) => event.tool === "generate_ics1811_sheet" && event.initiatedBy === "model" && event.status === "completed");
      const sheet = modelGenerated
        ? rendered
        : runOrchestratorTool("generate_ics1811_sheet", () => rendered, (value) => `生成 ${value.details.length} 条优惠明细`);
      agentMessages.push(sheetMessage(after.draft, after.fill, after.checks, versionSeq, sheet));
    }
  } else if (after.plan?.action === "out_of_scope" && trigger && !agentMessages.some((message) => message.kind === "agent_text")) {
    // 不在 1811 范围：模型会先接住想法再说明录不进去（提示词里要求的），它什么都没说时才由代码说明。
    agentMessages.push(agentText(after.plan.reason));
  }
  if (trigger && agentMessages.length === 0) agentMessages.push(agentText("我没理解这句要改什么，可以换个说法再说一次。"));

  const trace = traceContent();
  if (trace) agentMessages.unshift(trace);

  const title = next.brief.name?.value ?? (after.draft?.facts.offer && after.fill ? after.fill.info.name.value : bundle.session.title);
  const messageRecords = [
    ...(userContent ? [{ id: newId(), role: "user" as const, content: userContent, producedVersionId: versionId, createdAt: userOccurredAt }] : []),
    // 没有用户消息的回合（理解需求），由第一条 Agent 消息标记它产生的版本。
    ...agentMessages.map((content, index) => ({
      id: newId(),
      role: "assistant" as const,
      content,
      producedVersionId: !userContent && index === 0 ? versionId : null,
      createdAt: timestamp(),
    })),
  ];
  const committedAt = timestamp();
  return commitAndLoad(deps, {
    isNew: false,
    now: committedAt,
    session: { ...bundle.session, title, status, updatedAt: committedAt },
    version: versionId
      ? { id: versionId, seq: versionSeq, draft: next, sheet: after.fill ? renderFillSheet(after.fill, after.checks) : null, createdBy, patch: patch ? { id: newId(), ...patch } : null }
      : null,
    messages: messageRecords,
  });
}

type Evaluation = ReturnType<typeof evaluate>;

// 模型的回复，连同它在问什么、提议了什么一起存下，下一轮的短回答和点头按这个对。
// 模型没登记要问什么时兜底：这一轮记下了东西却没接着问，就按缺项目录补一句，免得对话停在「记下了」。
function replyWithQuestions(result: AgentResult, after: Evaluation, recordedSomething: boolean, draft: Ics1811Draft, today: string): StoredMessage | null {
  const missingIds = after.missing.map((gap) => gap.id);
  let text = result.reply ?? "";
  let asking: QuestionId[] = [];
  let proposals: Proposal[] = [];
  if (result.asking !== null) {
    asking = result.asking.filter((id) => missingIds.includes(id));
    // 提议按最终回复再过一遍：二选一的问法配提议，用户一句「对」会记成其中一边。
    proposals = after.plan?.action === "out_of_scope" ? [] : withoutEitherOr(text, liveProposals(draft, result.proposals, today));
  } else if (missingIds.length && recordedSomething && !/[？?]/.test(text)) {
    const fallback = byPriority(after.missing).slice(0, 2);
    text = [text, `还想跟你确认一下：${fallback.map((gap) => gap.title).join("")}`].filter(Boolean).join("\n\n");
    asking = fallback.map((gap) => gap.id);
  } else if (!/[？?]/.test(text)) {
    // 这句没在问（比如在回答用户的疑问）：上一句还没答的问题继续有效。提议不续：
    // 用户对这句解释回一句「好的」是「知道了」，不能被当成同意之前的提议。
    asking = after.asking;
  }
  // 问了但没登记题号：不知道在问哪一项，就不把任何一项当成在问，短回答记不下时模型会再问清楚。
  return text ? { v: 2, kind: "agent_text", text, asking, proposals } : null;
}
