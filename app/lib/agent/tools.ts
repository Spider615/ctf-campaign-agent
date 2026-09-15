import { checkDraft } from "../campaign/ics1811/checks.ts";
import { deriveFill, discountText } from "../campaign/ics1811/derive.ts";
import { applyFactWrites, emptyFacts, type Dropped, type FactWrite } from "../campaign/ics1811/facts.ts";
import { FACT_LABEL } from "../campaign/ics1811/messages.ts";
import { gapsOf } from "../campaign/ics1811/questions.ts";
import type { FactKey, Ics1811Draft } from "../campaign/ics1811/types.ts";
import type { AgentRequest, AgentResult } from "./protocol.ts";

export const AGENT_TOOL_NAMES = ["update_fields", "draft_copy", "confirm_readback", "undo_last_change"] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

export const FACT_KEYS = Object.keys(emptyFacts()) as FactKey[];

// 一轮对话里 Agent 的工作区：工具只改这里，整轮结束后由 Workers 决定出卡、复述还是输出，并一次性落库。
export type AgentState = {
  request: AgentRequest;
  draft: Ics1811Draft;
  applied: string[];
  dropped: Dropped[];
  copyDrafted: boolean;
  confirmRequested: boolean;
  undo: boolean;
  tools: string[];
};

export type ToolOutcome = { text: string; isError?: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const done = (value: unknown): ToolOutcome => ({ text: typeof value === "string" ? value : JSON.stringify(value) });
const refuse = (text: string): ToolOutcome => ({ text, isError: true });

export function createAgentState(request: AgentRequest): AgentState {
  return { request, draft: request.draft, applied: [], dropped: [], copyDrafted: false, confirmRequested: false, undo: false, tools: [] };
}

// 告诉模型接下来系统会怎么做：还缺什么、有什么挡着确认、当前名称内容。
export function draftStatus(draft: Ics1811Draft, today: string) {
  const fill = deriveFill(draft);
  const checks = checkDraft(draft, fill, today);
  return {
    outOfScope: fill.outOfScope,
    missing: gapsOf(draft).map((gap) => gap.title),
    blockers: checks.filter((check) => check.severity === "blocker" && check.id !== "V-A08").map((check) => check.message),
    name: fill.info.name.value,
    content: fill.info.content.value,
  };
}

export function updateFields(state: AgentState, input: Record<string, unknown>): ToolOutcome {
  state.tools.push("update_fields");
  if (state.undo) return refuse("这一轮已经撤销了，不能再修改。");
  const writes: FactWrite[] = (Array.isArray(input.facts) ? input.facts : []).filter(isRecord).flatMap((item) =>
    typeof item.key === "string" && FACT_KEYS.includes(item.key as FactKey) && typeof item.quote === "string"
      ? [{ key: item.key as FactKey, quote: item.quote, value: item.value }]
      : [],
  );
  if (!writes.length) return refuse("facts 为空，或者 key、quote 不对。");
  const { request } = state;
  const result = applyFactWrites(state.draft, writes, { text: request.trigger.text, today: request.today, openQuestions: request.openQuestions });
  state.draft = result.draft;
  state.applied.push(...result.applied);
  state.dropped.push(...result.dropped);
  return done({
    applied: result.applied.map((key) => FACT_LABEL[key]),
    dropped: result.dropped.map((item) => `${FACT_LABEL[item.key] ?? item.key}：${item.reason}。不要换个说法硬写，系统会追问。`),
    status: draftStatus(state.draft, request.today),
  });
}

const COPY_SPECIAL = /[^\p{Script=Han}A-Za-z0-9.%]/u;

// 名称和内容里允许出现的数字：只能来自用户说过的信息。
function allowedNumbers(draft: Ics1811Draft): Set<string> {
  const allowed = new Set<string>();
  const add = (value: number | null | undefined) => {
    if (value === null || value === undefined) return;
    allowed.add(String(value));
    allowed.add(String(Number((value * 100).toFixed(2))));
    if (value > 0 && value <= 1) allowed.add(discountText(value));
  };
  for (const item of draft.facts.offer?.value.items ?? []) {
    [item.discount, item.upgradeRatio, item.multiple, item.threshold, item.amount].forEach(add);
    if (item.threshold !== null) add(item.threshold * 2);
    if (item.amount !== null) add(item.amount * 2);
  }
  const dates = draft.facts.dates?.value;
  for (const date of dates ? [dates.start, dates.end] : []) date.split("-").map(Number).forEach(add);
  (draft.facts.weekdays?.value ?? []).forEach(add);
  (draft.facts.stores?.value ?? []).forEach((code) => allowed.add(code));
  return allowed;
}

export function draftCopy(state: AgentState, input: Record<string, unknown>): ToolOutcome {
  state.tools.push("draft_copy");
  if (state.undo) return refuse("这一轮已经撤销了，不要再改名称。");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const content = typeof input.content === "string" ? input.content.trim() : "";
  const problems: string[] = [];
  if (!name || [...name].length > 13) problems.push(`活动名称要有，且不超过 13 个字（现在 ${[...name].length} 个字）`);
  if (!content || [...content].length > 200) problems.push("活动内容要有，且不超过 200 个字");
  if (COPY_SPECIAL.test(name) || COPY_SPECIAL.test(content)) problems.push("名称和内容只能用汉字、字母、数字、小数点和百分号");
  const allowed = allowedNumbers(state.draft);
  const stray = [...new Set([...`${name} ${content}`.matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]).filter((number) => !allowed.has(number)))];
  if (stray.length) problems.push(`这些数字在用户说过的信息里找不到：${stray.join("、")}`);
  if (problems.length) return refuse(`没保存：${problems.join("；")}。改好后重新调用 draft_copy。`);
  state.draft = { ...state.draft, copy: { name, content, source: "ai" } };
  state.copyDrafted = true;
  return done("名称和内容已保存。不要再调用工具，用一两句话告诉用户就行。");
}

export function confirmReadback(state: AgentState): ToolOutcome {
  state.tools.push("confirm_readback");
  const { trigger, readbackSeq, canConfirm } = state.request;
  if (trigger.kind !== "user_message" || readbackSeq === null) return refuse("现在还没有复述，不能确认。");
  if (state.applied.length || state.copyDrafted || state.undo) return refuse("这一轮改了信息，系统会重新复述，这次不能直接确认。");
  if (!canConfirm) return refuse("复述里还有没补齐或没通过的项，不能确认。");
  if (!/确认|没问题|可以|对的|没错|生成|好的|行|ok/i.test(trigger.text)) return refuse("用户这句话不是在确认。");
  state.confirmRequested = true;
  return done("已记下确认，系统会生成 1811 填写值。不要再调用工具，用一句话告诉用户。");
}

export function undoLastChange(state: AgentState): ToolOutcome {
  state.tools.push("undo_last_change");
  if (state.request.trigger.kind !== "user_message" || !state.request.canUndo) return refuse("现在没有可以撤销的修改。");
  if (state.applied.length || state.copyDrafted || state.confirmRequested) return refuse("这一轮已经做了别的修改，不能再撤销。");
  state.undo = true;
  return done("已撤销上一次修改。不要再调用工具，用一句话告诉用户。");
}

export function runAgentTool(state: AgentState, name: AgentToolName, input: Record<string, unknown> = {}): ToolOutcome {
  switch (name) {
    case "update_fields":
      return updateFields(state, input);
    case "draft_copy":
      return draftCopy(state, input);
    case "confirm_readback":
      return confirmReadback(state);
    case "undo_last_change":
      return undoLastChange(state);
  }
}

const UPLIFT_CLAIM = /[^。！？\n]*(提升|增长|增加)[^。，,]{0,6}\d+(?:\.\d+)?\s*%[^。！？\n]*[。！？]?/g;
// 要补的信息由系统出卡片，模型回复里的问句一律删掉（§9(二) 以外不单独问）。
const QUESTION_SENTENCE = /[^。！？!?\n]*[？?]/g;

export function finishAgentTurn(state: AgentState, reply: string | null): AgentResult {
  const cleaned = (reply ?? "").replace(UPLIFT_CLAIM, "").replace(QUESTION_SENTENCE, "").trim().slice(0, 300);
  return {
    draft: state.draft,
    applied: [...new Set(state.applied)],
    dropped: state.dropped,
    reply: cleaned || null,
    copyDrafted: state.copyDrafted,
    confirmRequested: state.confirmRequested,
    undo: state.undo,
    tools: state.tools,
  };
}
