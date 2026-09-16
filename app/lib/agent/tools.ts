import { checkDraft } from "../campaign/ics1811/checks.ts";
import { CODEBOOK, type Entry } from "../campaign/ics1811/codebook.ts";
import { deriveFill, discountText } from "../campaign/ics1811/derive.ts";
import { applyFactWrites, emptyFacts, type Dropped, type FactWrite } from "../campaign/ics1811/facts.ts";
import { renderFillSheet } from "../campaign/ics1811/fill-sheet.ts";
import { FACT_LABEL } from "../campaign/ics1811/messages.ts";
import { gapsOf, planNext } from "../campaign/ics1811/questions.ts";
import { buildReadback } from "../campaign/ics1811/readback.ts";
import type { FactKey, Ics1811Draft } from "../campaign/ics1811/types.ts";
import { plainText } from "../markdown.ts";
import { CAMPAIGN_TOOL_NAMES, type AgentTraceEvent, type CampaignToolName, type ToolTrace } from "../tool-trace.ts";
import type { AgentRequest, AgentResult } from "./protocol.ts";

export const AGENT_TOOL_NAMES = CAMPAIGN_TOOL_NAMES;
export type AgentToolName = CampaignToolName;

export const AGENT_TOOL_META: Record<CampaignToolName, { title: string }> = {
  extract_campaign_facts: { title: "提取活动信息" },
  lookup_ics_reference: { title: "查询 ICS 代码表" },
  analyze_campaign_state: { title: "运行 1811 规则分析" },
  draft_campaign_copy: { title: "起草活动名称与内容" },
  draft_promo_copy: { title: "起草对外宣传文案" },
  build_campaign_readback: { title: "生成活动复述" },
  generate_ics1811_sheet: { title: "生成 1811 填写值" },
  confirm_campaign_readback: { title: "确认活动复述" },
  undo_campaign_change: { title: "撤销上次修改" },
};

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
  analysisRan: boolean;
  readbackBuilt: boolean;
  sheetGenerated: boolean;
  trace: AgentTraceEvent[];
  tools: CampaignToolName[];
};

export type ToolOutcome = { text: string; isError?: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const done = (value: unknown): ToolOutcome => ({ text: typeof value === "string" ? value : JSON.stringify(value) });
const refuse = (text: string): ToolOutcome => ({ text, isError: true });

export function createAgentState(request: AgentRequest): AgentState {
  return {
    request,
    draft: request.draft,
    applied: [],
    dropped: [],
    copyDrafted: false,
    confirmRequested: false,
    undo: false,
    analysisRan: false,
    readbackBuilt: false,
    sheetGenerated: false,
    trace: [],
    tools: [],
  };
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

export function extractCampaignFacts(state: AgentState, input: Record<string, unknown>): ToolOutcome {
  state.tools.push("extract_campaign_facts");
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

export function draftCampaignCopy(state: AgentState, input: Record<string, unknown>): ToolOutcome {
  state.tools.push("draft_campaign_copy");
  if (state.undo) return refuse("这一轮已经撤销了，不要再改名称。");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const content = typeof input.content === "string" ? input.content.trim() : "";
  const problems: string[] = [];
  if (!name || [...name].length > 13) problems.push(`活动名称要有，且不超过 13 个字（现在 ${[...name].length} 个字）`);
  if (!content || [...content].length > 200) problems.push("活动内容要有，且不超过 200 个字");
  // 实测模型会把名称原样抄进内容，等于没写。内容是给门店看的活动说明，要写清货类和优惠力度。
  if (name && content === name) problems.push("活动内容不能和名称一模一样，要写清是哪些货类、优惠力度多少");
  if (COPY_SPECIAL.test(name) || COPY_SPECIAL.test(content)) problems.push("名称和内容只能用汉字、字母、数字、小数点和百分号");
  const allowed = allowedNumbers(state.draft);
  const stray = [...new Set([...`${name} ${content}`.matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]).filter((number) => !allowed.has(number)))];
  if (stray.length) problems.push(`这些数字在用户说过的信息里找不到：${stray.join("、")}`);
  if (problems.length) return refuse(`没保存：${problems.join("；")}。改好后重新调用 draft_campaign_copy。`);
  state.draft = { ...state.draft, copy: { name, content, source: "ai" } };
  state.copyDrafted = true;
  return done("名称和内容已保存。不要再调用工具，用一两句话告诉用户就行。");
}

// 对外宣传文案：模型只写创意部分（主标题和卖点）。日期、门店、优惠力度由代码
// 从事实层渲染，不让模型重写——数字有守卫拦着，但「闽深区」写成「华南区」拦不住。
// 这里不套 COPY_SPECIAL：那条白名单是为 1811 字段服务的，对外文案要能用逗号和感叹号。
function draftPromoCopy(state: AgentState, input: Record<string, unknown>): ToolOutcome {
  state.tools.push("draft_promo_copy");
  if (state.undo) return refuse("这一轮已经撤销了，不要再改文案。");
  if (!state.draft.facts.offer || !state.draft.facts.categories) return refuse("优惠方式和货类都记下来之后，才能起草对外宣传文案。");
  // 对外文案是要发出去的东西，源头就不该带 ** 这类标记——这个工具没套 COPY_SPECIAL
  // 白名单（宣传语要能用逗号和感叹号），所以标记拦不住，只能在这里剥掉。
  // 剥离放在长度校验之前：否则「**限时五天**」会按 8 个字算，白吃掉一半额度。
  const headline = plainText(typeof input.headline === "string" ? input.headline.trim() : "");
  const highlights = Array.isArray(input.highlights)
    ? input.highlights.filter((item): item is string => typeof item === "string").map((item) => plainText(item.trim())).filter(Boolean)
    : [];
  const problems: string[] = [];
  if (!headline || [...headline].length > 20) problems.push(`主标题要有，且不超过 20 个字（现在 ${[...headline].length} 个字）`);
  if (!highlights.length || highlights.length > 4) problems.push("卖点要有 1 到 4 条");
  if (highlights.some((item) => [...item].length > 30)) problems.push("每条卖点不超过 30 个字");
  // 对外发布的东西编错数字最贵，守卫和活动名称共用一套。
  const allowed = allowedNumbers(state.draft);
  const stray = [...new Set([...`${headline} ${highlights.join(" ")}`.matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]).filter((number) => !allowed.has(number)))];
  if (stray.length) problems.push(`这些数字在用户说过的信息里找不到：${stray.join("、")}`);
  if (problems.length) return refuse(`没保存：${problems.join("；")}。改好后重新调用 draft_promo_copy。`);
  state.draft = { ...state.draft, promo: { headline, highlights, source: "ai" } };
  return done("对外宣传文案已保存。日期、门店和优惠力度由系统按事实填充，你不用写，也不要写活动标语。");
}

export function confirmCampaignReadback(state: AgentState): ToolOutcome {
  state.tools.push("confirm_campaign_readback");
  const { trigger, readbackSeq, canConfirm } = state.request;
  if (trigger.kind !== "user_message" || readbackSeq === null) return refuse("现在还没有复述，不能确认。");
  if (state.applied.length || state.copyDrafted || state.undo) return refuse("这一轮改了信息，系统会重新复述，这次不能直接确认。");
  if (!canConfirm) return refuse("复述里还有没补齐或没通过的项，不能确认。");
  if (!/确认|没问题|可以|对的|没错|生成|好的|行|ok/i.test(trigger.text)) return refuse("用户这句话不是在确认。");
  state.confirmRequested = true;
  return done("已记下确认，系统会生成 1811 填写值。不要再调用工具，用一句话告诉用户。");
}

export function undoCampaignChange(state: AgentState): ToolOutcome {
  state.tools.push("undo_campaign_change");
  if (state.request.trigger.kind !== "user_message" || !state.request.canUndo) return refuse("现在没有可以撤销的修改。");
  if (state.applied.length || state.copyDrafted || state.confirmRequested) return refuse("这一轮已经做了别的修改，不能再撤销。");
  state.undo = true;
  return done("已撤销上一次修改。不要再调用工具，用一句话告诉用户。");
}

type ReferenceMatch = Pick<Entry, "code" | "label" | "display" | "origin" | "evidence">;

function referenceEntries(): ReferenceMatch[] {
  const plain = (values: readonly string[], source: string): ReferenceMatch[] => values.map((value) => ({
    code: value,
    label: value,
    display: value,
    origin: "截图",
    evidence: source,
  }));
  return [
    ...CODEBOOK.stores,
    ...CODEBOOK.regions,
    ...CODEBOOK.categories,
    ...plain(CODEBOOK.offerTypes, "ICS-1811 优惠类型代码表"),
    ...CODEBOOK.brands,
    ...CODEBOOK.productScopes,
    ...CODEBOOK.memberLevels,
    ...CODEBOOK.priceTypes,
    ...CODEBOOK.approvalFlows,
  ];
}

export function lookupIcsReference(state: AgentState, input: Record<string, unknown>): ToolOutcome {
  state.tools.push("lookup_ics_reference");
  const query = typeof input.query === "string" ? input.query.trim().toLocaleLowerCase() : "";
  if (!query) return refuse("查询词不能为空。");
  const tokens = query.split(/\s+/).filter(Boolean);
  const matches = referenceEntries()
    .map((entry) => {
      const aliases = "aliases" in entry && Array.isArray(entry.aliases) ? entry.aliases.join(" ") : "";
      const haystack = `${entry.code} ${entry.label} ${entry.display} ${aliases}`.toLocaleLowerCase();
      const score = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? (haystack === token ? 3 : 1) : 0), 0);
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.display.localeCompare(right.entry.display, "zh-CN"))
    .slice(0, 8)
    .map(({ entry }) => ({
      code: entry.code,
      label: entry.label,
      display: entry.display,
      origin: entry.origin,
      evidence: entry.evidence ?? "ICS-1811 演示代码表",
    }));
  return done({ query, matches });
}

export function analyzeCampaignState(state: AgentState): ToolOutcome {
  state.tools.push("analyze_campaign_state");
  const fill = deriveFill(state.draft);
  const checks = checkDraft(state.draft, fill, state.request.today);
  const missing = gapsOf(state.draft);
  const plan = planNext(state.draft, fill, checks, state.request.roundsUsed, state.request.openQuestions);
  state.analysisRan = true;
  return done({
    detailCount: fill.details.length,
    missing: missing.map((gap) => gap.title),
    blockers: checks.filter((check) => check.severity === "blocker" && check.id !== "V-A08").map((check) => check.message),
    warnings: checks.filter((check) => check.severity === "warning").map((check) => check.message),
    action: plan.action,
    canConfirm: plan.action === "readback" && plan.canConfirm,
  });
}

export function buildCampaignReadback(state: AgentState): ToolOutcome {
  state.tools.push("build_campaign_readback");
  const fill = deriveFill(state.draft);
  const checks = checkDraft(state.draft, fill, state.request.today);
  const missing = gapsOf(state.draft);
  const readback = buildReadback(state.draft, fill, checks, missing);
  state.readbackBuilt = true;
  return done({
    summary: readback.summary,
    missingCount: readback.missing.length,
    blockerCount: readback.blockers.length,
    warningCount: readback.attention.length,
    canConfirm: readback.canConfirm,
  });
}

export function generateIcs1811Sheet(state: AgentState): ToolOutcome {
  state.tools.push("generate_ics1811_sheet");
  if (!state.confirmRequested) return refuse("用户还没有确认最新复述，不能生成填写值。");
  const fill = deriveFill(state.draft);
  const checks = checkDraft(state.draft, fill, state.request.today);
  const blockers = checks.filter((check) => check.severity === "blocker");
  if (gapsOf(state.draft).length || blockers.length) return refuse("活动信息还没补齐或校验未通过，不能生成填写值。");
  const sheet = renderFillSheet(fill, checks);
  state.sheetGenerated = true;
  return done({
    detailCount: sheet.details.length,
    postActionCount: sheet.postActions.length,
    checkCount: sheet.selfCheck.length,
  });
}

const TOOL_HANDLERS: Record<CampaignToolName, (state: AgentState, input: Record<string, unknown>) => ToolOutcome> = {
  extract_campaign_facts: extractCampaignFacts,
  lookup_ics_reference: lookupIcsReference,
  analyze_campaign_state: analyzeCampaignState,
  draft_campaign_copy: draftCampaignCopy,
  draft_promo_copy: draftPromoCopy,
  build_campaign_readback: buildCampaignReadback,
  generate_ics1811_sheet: generateIcs1811Sheet,
  confirm_campaign_readback: (state) => confirmCampaignReadback(state),
  undo_campaign_change: (state) => undoCampaignChange(state),
};

export function runAgentTool(state: AgentState, name: CampaignToolName, input: Record<string, unknown> = {}): ToolOutcome {
  return TOOL_HANDLERS[name](state, input);
}

export function safeToolSummary(name: CampaignToolName, outcome: ToolOutcome, state: AgentState): string {
  if (outcome.isError) return "未执行，当前活动条件尚未满足";
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(outcome.text) as unknown;
    if (isRecord(parsed)) body = parsed;
  } catch {
    // 文案、确认和撤销工具返回短文本，不需要解析。
  }
  switch (name) {
    case "extract_campaign_facts":
      return `识别并核验 ${state.applied.length} 项信息${state.dropped.length ? `，${state.dropped.length} 项需确认` : ""}`;
    case "lookup_ics_reference":
      return `匹配 ${Array.isArray(body?.matches) ? body.matches.length : 0} 条代码表记录`;
    case "analyze_campaign_state":
      return `完成规则分析 · ${Array.isArray(body?.missing) ? body.missing.length : 0} 项待补`;
    case "draft_campaign_copy":
      return "活动名称与内容已起草";
    case "draft_promo_copy":
      return `对外宣传文案已起草 · ${state.draft.promo?.highlights.length ?? 0} 条卖点`;
    case "build_campaign_readback":
      return `生成复述 · ${Number(body?.missingCount ?? 0)} 项待补`;
    case "generate_ics1811_sheet":
      return `生成 ${Number(body?.detailCount ?? 0)} 条优惠明细`;
    case "confirm_campaign_readback":
      return "最新活动复述已确认";
    case "undo_campaign_change":
      return "已恢复到上一个活动版本";
  }
}

const UPLIFT_CLAIM = /[^。！？\n]*(提升|增长|增加)[^。，,]{0,6}\d+(?:\.\d+)?\s*%[^。！？\n]*[。！？]?/g;
// 要补的信息由系统出卡片，模型回复里的问句一律删掉（§9(二) 以外不单独问）。
const QUESTION_SENTENCE = /[^。！？!?\n]*[？?]/g;

// 这个上限是防失控（模型抽风输出几千字），不是限制表达。
// 160 是旧工具集时代（只管提取事实，实测回复 12-100 字）定的；放开后实测它回答
// 「这个力度够不够吸引人」「签到抽奖怎么设计」自然就是 420-440 字，卡在 450 等于
// 又把天花板压在它头顶上，稍长一点就被砍半句。留足余量。
// 截断逻辑本身保留：宁可少一句，不留半句。
const MAX_REPLY = 800;

// 回复要像一两句话；超长时在句末截断，不留半句。
// 按行处理。原来是把整段切成句子再拼回去，而切句的正则把 \n 排除在外，
// 于是换行在重新拼接时被静默删光：模型分点写的「1. …\n2. …」糊成一行，
// 界面解析不出列表，长回复也全成了一大坨。换行是模型表达结构的方式，得留着。
function trimReply(text: string): string {
  const kept: string[] = [];
  let total = 0;
  for (const line of text.split("\n")) {
    if (total >= MAX_REPLY) break;
    if (!line.trim()) {
      if (kept.length) kept.push("");
      continue;
    }
    let out = "";
    for (const sentence of line.match(/[^。！!；;]+[。！!；;]?/g) ?? [line]) {
      if ((total || out) && total + out.length + sentence.length > MAX_REPLY) break;
      out += sentence;
    }
    if (!out) break;
    kept.push(out);
    total += out.length;
  }
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  return kept.join("\n");
}

export function finishAgentTurn(state: AgentState, reply: string | null): AgentResult {
  // 问句只在卡片开着时删：那会儿系统正在问用户，模型再问会和卡片重复、打乱两轮限制。
  // 没卡片时放它正常说话——「这样理解对吗」这类澄清是对话该有的样子，一刀切删问句
  // 正是它显得死板的来源。编造的效果预估（提升 X%）任何时候都删，那是事实问题。
  const asking = state.request.openQuestions.length > 0;
  const withoutClaims = (reply ?? "").replace(UPLIFT_CLAIM, "");
  const cleaned = trimReply((asking ? withoutClaims.replace(QUESTION_SENTENCE, "") : withoutClaims).trim());
  const steps = state.trace.filter((event) => event.status !== "started");
  const trace: ToolTrace | null = steps.length
    ? {
        status: steps.some((event) => event.status === "failed") ? "failed" : steps.some((event) => event.status === "warning") ? "warning" : "completed",
        durationMs: Math.max(...steps.map((event) => event.startedAt + (event.durationMs ?? 0))) - Math.min(...steps.map((event) => event.startedAt)),
        steps,
      }
    : null;
  return {
    draft: state.draft,
    applied: [...new Set(state.applied)],
    dropped: state.dropped,
    reply: cleaned || null,
    copyDrafted: state.copyDrafted,
    confirmRequested: state.confirmRequested,
    undo: state.undo,
    tools: state.tools,
    trace,
  };
}
