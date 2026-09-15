import { buildClarifyQuestions, CARD_INTRO, CLARIFY_LABEL, isClarifyKey, missingLabels } from "../campaign/clarify.ts";
import { summarizeChanges } from "../campaign/messages.ts";
import { applyPatch } from "../campaign/patcher.ts";
import { intentConflicts, readbackItems } from "../campaign/planner.ts";
import { buildIcsDrafts } from "../campaign/split-orders.ts";
import { noIcsOrders, type FieldKey } from "../campaign/topics.ts";
import type { CampaignDraft, PatchOperation } from "../campaign/types.ts";
import { validateDraft } from "../campaign/validator.ts";
import { deriveDraft } from "../campaign/workspace-state.ts";
import { guardOps } from "../server/ai-schemas.ts";
import type { AgentCard, AgentRequest, AgentResult } from "./protocol.ts";

export const AGENT_TOOL_NAMES = ["update_fields", "ask_user", "write_plan", "undo_last_change"] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

// 一轮对话里 Agent 的工作区：工具只改这里，整轮结束后由 Workers 一次性落库。
export type AgentState = {
  request: AgentRequest;
  draft: CampaignDraft;
  ops: PatchOperation[];
  card: AgentCard | null;
  generated: boolean;
  undo: boolean;
  tools: string[];
};

export type ToolOutcome = { text: string; isError?: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const done = (value: unknown): ToolOutcome => ({ text: typeof value === "string" ? value : JSON.stringify(value) });
const refuse = (text: string): ToolOutcome => ({ text, isError: true });

const COPY_PATH = /^\/(brief|title)(\/|$)/;
const COPY_KEYS = ["externalName", "icsName", "content", "slogan"] as const;
const TIER_KEYS = ["thresholdAmount", "discountRate", "amountOff"] as const;
const TIER_LEAF = /^\/offer\/tiers\/(\d+)\/(thresholdAmount|discountRate|amountOff)$/;
const TIER_WHOLE = /^\/offer\/tiers\/(\d+)$/;
// 卡片还开着时，只为这些可选项不值得再出一张新卡片。
const OPTIONAL_CARD_KEYS: readonly string[] = ["occasion", "series", "segments"];

function shortTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items = value.filter((item): item is string => typeof item === "string").map((item) => item.trim());
  return [...new Set(items.filter((item) => item.length > 0 && item.length <= 12 && !/岁|男性|女性/.test(item)))].slice(0, 5);
}

export function createAgentState(request: AgentRequest): AgentState {
  return { request, draft: request.draft, ops: [], card: null, generated: false, undo: false, tools: [] };
}

export function draftStatus(draft: CampaignDraft) {
  const orders = buildIcsDrafts(draft);
  const ruleIssues = validateDraft(draft, orders).filter((issue) => issue.severity === "blocker" && !issue.path.startsWith("/brief"));
  return {
    missing: missingLabels(draft),
    icsOrders: noIcsOrders(draft) ? "本次不建 ICS 单" : `${orders.length} 条`,
    conflicts: intentConflicts(draft),
    ruleIssues: ruleIssues.slice(0, 5).map((issue) => issue.message),
    pendingInIcsUi: draft.unresolved,
  };
}

// 这一轮能当作「用户原话」的文字：用户打的字，或补充卡片「其他」框里写的内容。
function evidenceOf(request: AgentRequest): { text: string; trusted: FieldKey[] } {
  const trigger = request.trigger;
  if (trigger.kind === "first_message" || trigger.kind === "user_message") return { text: trigger.text, trusted: [] };
  if (trigger.kind === "card_submitted") {
    return { text: trigger.customs.map((item) => `${item.label}：${item.text}`).join("\n"), trusted: trigger.customs.map((item) => item.field) };
  }
  return { text: "", trusted: [] };
}

// 卡片还开着时，用户打的字可能是在回答卡片上的项。
function openFieldsOf(request: AgentRequest): FieldKey[] {
  if (request.trigger.kind !== "user_message" || !request.openCard) return [];
  return request.openCard.flatMap((key): FieldKey[] => (key === "scope" ? ["level", "scopeCode"] : key === "series" ? [] : [key]));
}

// 档位里的数字：字符串数字转成数字；0 当作没填（0 折、减 0 元、满 0 元都没有意义）。
function tierNumber(value: unknown): unknown {
  const number = typeof value === "string" && value.trim() && Number.isFinite(Number(value)) ? Number(value) : value;
  return number === 0 || number === "" || number === undefined ? null : number;
}

// 模型写档位的方式五花八门：写还不存在的档位的叶子字段、用 replace 写整档、编号跳号。
// 统一成「修改已有档位的叶子字段」和「按顺序新增档位」两种，再交给守卫核对数字。
function normalizeChanges(changes: Record<string, unknown>[], tierCount: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const newTiers = new Map<number, Record<string, unknown>>();
  const addToNewTier = (index: number, values: Record<string, unknown>) => newTiers.set(index, { ...newTiers.get(index), ...values });

  for (const change of changes) {
    const path = typeof change.path === "string" ? change.path : "";
    const leaf = TIER_LEAF.exec(path);
    if (leaf) {
      const index = Number(leaf[1]);
      const value = tierNumber(change.value);
      if (index >= tierCount) {
        if (value !== null) addToNewTier(index, { [leaf[2]]: value });
      } else {
        out.push({ op: "replace", path, value, reason: change.reason });
      }
      continue;
    }
    const whole = TIER_WHOLE.exec(path);
    if (whole && change.op !== "remove") {
      const index = Number(whole[1]);
      const tier = isRecord(change.value) ? change.value : {};
      const values = Object.fromEntries(TIER_KEYS.map((key) => [key, tierNumber(tier[key])]));
      if (index >= tierCount) {
        addToNewTier(index, values);
      } else {
        for (const key of TIER_KEYS) {
          if (values[key] !== null) out.push({ op: "replace", path: `${path}/${key}`, value: values[key], reason: change.reason });
        }
      }
      continue;
    }
    out.push({ op: change.op ?? "replace", path, value: change.value, reason: change.reason });
  }

  [...newTiers.entries()].sort(([a], [b]) => a - b).forEach(([, value], offset) => {
    out.push({ op: "add", path: `/offer/tiers/${tierCount + offset}`, value });
  });
  return out;
}

export function updateFields(state: AgentState, input: Record<string, unknown>): ToolOutcome {
  state.tools.push("update_fields");
  if (state.undo) return refuse("这一轮已经撤销了，不能再修改。");
  const changes = Array.isArray(input.changes) ? input.changes.filter(isRecord) : [];
  const copyChanges = changes.filter((change) => typeof change.path === "string" && COPY_PATH.test(change.path));
  const fieldChanges = normalizeChanges(changes.filter((change) => !copyChanges.includes(change)), state.draft.offer.tiers.length);
  const { text, trusted } = evidenceOf(state.request);
  const guard = guardOps(fieldChanges, { draft: state.draft, userText: text, openFields: openFieldsOf(state.request), trustedFields: trusted });

  const before = state.draft;
  let next = before;
  if (guard.ops.length) {
    try {
      next = deriveDraft(applyPatch(before, guard.ops));
    } catch {
      return refuse("改动没能写入，检查 path 和 value 是否符合路径表。");
    }
    state.ops.push(...guard.ops);
  }
  const title = typeof input.title === "string" ? input.title.trim().slice(0, 28) : "";
  if (title && state.request.trigger.kind === "first_message") next = { ...next, title };
  state.draft = next;

  return done({
    applied: summarizeChanges(before, next).map((item) => `${item.label}：${item.after}`),
    dropped: guard.dropped.map((label) => `${label}：用户原话里没有依据，没写入。不要猜，需要时用 ask_user 问。`),
    undecided: guard.undecided,
    ...(copyChanges.length ? { note: "名称、内容、标语、标题这些文案要用 write_plan 改。" } : {}),
    status: draftStatus(next),
  });
}

export function askUser(state: AgentState, input: Record<string, unknown>): ToolOutcome {
  state.tools.push("ask_user");
  if (state.undo) return refuse("这一轮已经撤销了，不要再出卡片。");
  if (state.card) return refuse("这一轮已经出过卡片了，不要重复出。");
  const keys = Array.isArray(input.keys) ? input.keys.filter(isClarifyKey) : [];
  const confirm = Array.isArray(input.confirm) ? input.confirm.filter(isClarifyKey) : [];
  const questions = buildClarifyQuestions(state.draft, keys, { segments: shortTexts(input.segments), series: shortTexts(input.series) }, confirm);
  if (questions.length === 0) return done("没有需要用户补充的项，不用出卡片。");

  const open = state.request.openCard;
  if (open && state.request.trigger.kind === "user_message") {
    const essential = questions.filter((question) => confirm.includes(question.key) || !OPTIONAL_CARD_KEYS.includes(question.key));
    if (essential.every((question) => open.includes(question.key))) {
      return done("上面那张卡片还没提交，已经包含要问的项，不要重复出。回复里提醒用户填那张卡片就行。");
    }
  }

  const first = state.request.trigger.kind === "first_message";
  const intro = typeof input.intro === "string" && input.intro.trim() ? input.intro.trim().slice(0, 120) : first ? CARD_INTRO.first : CARD_INTRO.later;
  const { stated, inferred } = first ? readbackItems(state.draft) : { stated: [], inferred: [] };
  state.card = { v: 1, kind: "agent_clarify", intro, stated, inferred, questions };
  return done(`卡片已经放在你的回复下面，问的是：${questions.map((question) => CLARIFY_LABEL[question.key]).join("、")}。不要再调用工具，用一两句话告诉用户为什么要补这些。`);
}

export function writePlan(state: AgentState, input: Record<string, unknown>): ToolOutcome {
  state.tools.push("write_plan");
  if (state.undo) return refuse("这一轮已经撤销了，不要再生成方案。");
  const empty = COPY_KEYS.filter((key) => typeof input[key] !== "string" || !(input[key] as string).trim());
  if (empty.length) return refuse(`文案没保存：${empty.join("、")} 是空的，四个字段都要写。`);

  // 用户在对话里说要生成时，矛盾要先确认；用户提交卡片或点按钮，说明已经看过，照样生成。
  const conflicts = intentConflicts(state.draft);
  const explicit = state.request.trigger.kind === "card_submitted" || state.request.trigger.kind === "generate_clicked";
  if (conflicts.length && !explicit) return refuse(`先请用户确认矛盾：${conflicts.join("；")}用 ask_user 把相关项放进 confirm。`);

  const draft = structuredClone(state.draft);
  draft.brief = {
    externalName: (input.externalName as string).trim(),
    icsName: (input.icsName as string).trim(),
    content: (input.content as string).trim(),
    slogan: (input.slogan as string).trim(),
  };
  if (!state.draft.brief.externalName) draft.title = draft.brief.externalName.slice(0, 28);
  const derived = deriveDraft(draft);
  const blockers = validateDraft(derived, buildIcsDrafts(derived)).filter((issue) => issue.severity === "blocker" && issue.path.startsWith("/brief"));
  if (blockers.length) return refuse(`文案没通过开单规则：${blockers.map((issue) => issue.message).join("；")}。改好后重新调用 write_plan。`);

  state.draft = derived;
  state.generated = true;
  const status = draftStatus(derived);
  return done({
    saved: true,
    status,
    next: status.missing.length
      ? "方案已保存，会显示在你的回复下面。还缺的开单项系统会自动附一张卡片，不用再调 ask_user，回复里提一句还差什么即可。"
      : "方案已保存，开单信息已经齐了。",
  });
}

export function undoLastChange(state: AgentState): ToolOutcome {
  state.tools.push("undo_last_change");
  if (state.request.trigger.kind !== "user_message" || !state.request.canUndo) return refuse("现在没有可以撤销的修改。");
  if (state.ops.length || state.generated || state.card) return refuse("这一轮已经做了别的修改，不能再撤销。");
  state.undo = true;
  return done("已撤销上一次修改。不要再调用工具，用一句话告诉用户。");
}

export function runAgentTool(state: AgentState, name: AgentToolName, input: Record<string, unknown> = {}): ToolOutcome {
  switch (name) {
    case "update_fields":
      return updateFields(state, input);
    case "ask_user":
      return askUser(state, input);
    case "write_plan":
      return writePlan(state, input);
    case "undo_last_change":
      return undoLastChange(state);
  }
}

const UPLIFT_CLAIM = /[^。！？\n]*(提升|增长|增加)[^。，,]{0,6}\d+(?:\.\d+)?\s*%[^。！？\n]*[。！？]?/g;

export function finishAgentTurn(state: AgentState, reply: string | null): AgentResult {
  const cleaned = (reply ?? "").replace(UPLIFT_CLAIM, "").trim().slice(0, 600);
  return {
    draft: state.draft,
    ops: state.ops,
    reply: cleaned || null,
    card: state.card,
    generated: state.generated,
    undo: state.undo,
    tools: state.tools,
  };
}
