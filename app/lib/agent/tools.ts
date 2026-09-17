import { checkDraft } from "../campaign/ics1811/checks.ts";
import { applyCampaignBriefWrites, CAMPAIGN_BRIEF_KEYS, type CampaignBriefWrite } from "../campaign/brief.ts";
import { communicationGate, validateCommunicationCreative } from "../campaign/communication.ts";
import type { CampaignChannel, CampaignDraft, CommunicationCreative } from "../campaign/types.ts";
import { buildCampaignWorkspace, normalizeCampaignDraft } from "../campaign/workspace.ts";
import { CODEBOOK, type Entry } from "../campaign/ics1811/codebook.ts";
import { deriveFill, discountText } from "../campaign/ics1811/derive.ts";
import { applyFactWrites, compactQuote, emptyFacts, type Dropped, type FactWrite } from "../campaign/ics1811/facts.ts";
import { renderFillSheet } from "../campaign/ics1811/fill-sheet.ts";
import { FACT_LABEL, factText } from "../campaign/ics1811/messages.ts";
import { agreesToProposal, isPureAgreement } from "../campaign/ics1811/phrases.ts";
import { acceptProposals, checkProposal } from "../campaign/ics1811/proposals.ts";
import { gapsOf, planNext, QUESTION_IDS, QUESTION_TITLE } from "../campaign/ics1811/questions.ts";
import type { FactKey, Ics1811Draft, Proposal, QuestionId } from "../campaign/ics1811/types.ts";
import { plainText } from "../markdown.ts";
import { CAMPAIGN_TOOL_NAMES, type AgentTraceEvent, type CampaignToolName, type ToolTrace } from "../tool-trace.ts";
import type { AgentRequest, AgentResult } from "./protocol.ts";
import { sanitizeAgentReply } from "./reply-stream.ts";

export const AGENT_TOOL_NAMES = CAMPAIGN_TOOL_NAMES;
export type AgentToolName = CampaignToolName;

export const AGENT_TOOL_META: Record<CampaignToolName, { title: string }> = {
  update_campaign_brief: { title: "整理活动 Brief" },
  analyze_campaign_plan: { title: "分析整体活动计划" },
  extract_campaign_facts: { title: "提取活动信息" },
  accept_campaign_proposals: { title: "按用户同意的提议记下" },
  lookup_ics_reference: { title: "查询 ICS 代码表" },
  analyze_campaign_state: { title: "运行 1811 规则分析" },
  ask_campaign_questions: { title: "登记要问的问题" },
  draft_campaign_copy: { title: "起草活动名称与内容" },
  draft_promo_copy: { title: "起草分渠道传播方案" },
  generate_ics1811_sheet: { title: "生成 1811 填写值" },
  undo_campaign_change: { title: "撤销上次修改" },
};

export const FACT_KEYS = Object.keys(emptyFacts()) as FactKey[];

// 一轮对话里 Agent 的工作区：工具只改这里，整轮结束后由 Workers 重算齐没齐、要不要生成填写值，并一次性落库。
export type AgentState = {
  request: AgentRequest;
  campaign: CampaignDraft;
  draft: Ics1811Draft | null;
  briefApplied: string[];
  applied: string[];
  dropped: Dropped[];
  copyDrafted: boolean;
  undo: boolean;
  analysisRan: boolean;
  campaignAnalysisRan: boolean;
  sheetGenerated: boolean;
  // 模型登记的「这句回复在问什么」；没调 ask_campaign_questions 时为 null。
  asking: QuestionId[] | null;
  proposals: Proposal[];
  trace: AgentTraceEvent[];
  tools: CampaignToolName[];
};

export type ToolOutcome = { text: string; isError?: boolean };

export type AgentToolContext = {
  loadedSkills?: ReadonlySet<string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const done = (value: unknown): ToolOutcome => ({ text: typeof value === "string" ? value : JSON.stringify(value) });
const refuse = (text: string): ToolOutcome => ({ text, isError: true });

export function createAgentState(request: AgentRequest): AgentState {
  const supplied = (request as AgentRequest & { campaign?: CampaignDraft }).campaign;
  const campaign = supplied
    ? structuredClone(supplied)
    : request.draft
      ? normalizeCampaignDraft(request.draft)
      : {
          schema: "campaign/v1" as const,
          id: "agent:campaign",
          requestText: request.trigger.text,
          brief: { name: null, objective: null, audience: null, theme: null, channels: null, timing: null, scope: null },
          ics1811: null,
          communication: null,
        };
  // 请求里的 child 是 Workers 选定的受控叶子；父对象里若有旧值，以显式字段为准。
  campaign.ics1811 = request.draft;
  return {
    request,
    campaign,
    draft: request.draft,
    briefApplied: [],
    applied: [],
    dropped: [],
    copyDrafted: false,
    undo: false,
    analysisRan: false,
    campaignAnalysisRan: false,
    sheetGenerated: false,
    asking: null,
    proposals: [],
    trace: [],
    tools: [],
  };
}

const noIcs1811 = () => refuse("当前活动没有 1811 优惠配置子流程；请先分析整体活动计划，不要调用 1811 工具。");

export function updateCampaignBrief(state: AgentState, input: Record<string, unknown>): ToolOutcome {
  state.tools.push("update_campaign_brief");
  if (state.undo) return refuse("这一轮已经撤销了，不能再修改 Brief。");
  const writes: CampaignBriefWrite[] = (Array.isArray(input.writes) ? input.writes : []).filter(isRecord).flatMap((item) =>
    typeof item.key === "string" && CAMPAIGN_BRIEF_KEYS.includes(item.key as CampaignBriefWrite["key"]) && typeof item.quote === "string"
      ? [{ key: item.key as CampaignBriefWrite["key"], quote: item.quote, value: item.value }]
      : [],
  );
  if (!writes.length) return refuse("writes 为空，或者 key、quote 不对。");
  const result = applyCampaignBriefWrites(state.campaign.brief, writes, { text: state.request.trigger.text });
  state.campaign = { ...state.campaign, brief: result.brief, ics1811: state.draft };
  state.briefApplied.push(...result.applied);
  return done({
    applied: result.applied,
    dropped: result.dropped.map((item) => `${item.key}：${item.reason}`),
    brief: buildCampaignWorkspace(state.campaign, state.request.today).brief,
  });
}

export function analyzeCampaignPlan(state: AgentState): ToolOutcome {
  state.tools.push("analyze_campaign_plan");
  state.campaign = { ...state.campaign, ics1811: state.draft };
  const workspace = buildCampaignWorkspace(state.campaign, state.request.today);
  state.campaignAnalysisRan = true;
  return done(workspace);
}

// 告诉模型现在的样子：还缺什么（带题号，登记追问要用）、有什么挡着生成、齐没齐、当前名称内容。
export function draftStatus(draft: Ics1811Draft, today: string) {
  const fill = deriveFill(draft);
  const checks = checkDraft(draft, fill, today);
  const plan = planNext(draft, fill, checks);
  return {
    outOfScope: fill.outOfScope,
    missing: gapsOf(draft).map((gap) => ({ id: gap.id, question: gap.title, ...(gap.candidates?.length ? { candidates: gap.candidates } : {}), ...(gap.hint ? { hint: gap.hint } : {}) })),
    blockers: checks.filter((check) => check.severity === "blocker" && check.id !== "V-A08").map((check) => check.message),
    complete: plan.action === "ready",
    name: fill.info.name.value,
    content: fill.info.content.value,
  };
}

export function extractCampaignFacts(state: AgentState, input: Record<string, unknown>): ToolOutcome {
  state.tools.push("extract_campaign_facts");
  if (state.undo) return refuse("这一轮已经撤销了，不能再修改。");
  if (!state.draft) return noIcs1811();
  const writes: FactWrite[] = (Array.isArray(input.facts) ? input.facts : []).filter(isRecord).flatMap((item) =>
    typeof item.key === "string" && FACT_KEYS.includes(item.key as FactKey) && typeof item.quote === "string"
      ? [{ key: item.key as FactKey, quote: item.quote, value: item.value }]
      : [],
  );
  if (!writes.length) return refuse("facts 为空，或者 key、quote 不对。");
  const { request } = state;
  const result = applyFactWrites(state.draft, writes, {
    text: request.trigger.text,
    today: request.today,
    openQuestions: request.openQuestions,
    proposed: request.proposals.map((item) => item.id),
  });
  state.draft = result.draft;
  state.applied.push(...result.applied);
  state.dropped.push(...result.dropped);
  return done({
    // 带上记下后的值：模型照这个说「记下了什么」，不凭自己的理解复述（实测会说成反的）。
    applied: result.applied.map((key) => `${FACT_LABEL[key]}：${factText(key, result.draft.facts[key])}`),
    dropped: result.dropped.map((item) => `${FACT_LABEL[item.key] ?? item.key}：${item.reason}。不要换个说法硬写，在回复里跟用户问清楚。`),
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
  if (!state.draft) return noIcs1811();
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

const CAMPAIGN_CHANNELS: readonly CampaignChannel[] = ["store", "wechat", "ecommerce", "social", "member_crm", "event"];

// 对外传播方案：模型只写创意概念、分渠道文本与视觉方向；目标、受众、日期、
// 门店和优惠等硬事实继续由 communication.ts 从 Campaign Brief / 1811 子单确定性渲染。
function draftPromoCopy(state: AgentState, input: Record<string, unknown>): ToolOutcome {
  state.tools.push("draft_promo_copy");
  if (state.undo) return refuse("这一轮已经撤销了，不要再改文案。");
  const gate = communicationGate(state.campaign);
  if (!gate.ready) return refuse(`传播方案还不能起草，先补齐：${gate.missing.join("、")}。`);

  const conceptInput = isRecord(input.concept) ? input.concept : {};
  const clean = (value: unknown) => plainText(typeof value === "string" ? value.trim() : "");
  const concept = {
    headline: clean(conceptInput.headline),
    subheadline: clean(conceptInput.subheadline),
    coreMessage: clean(conceptInput.coreMessage),
  };
  const channelOutputs = (Array.isArray(input.channelOutputs) ? input.channelOutputs : [])
    .filter(isRecord)
    .map((output) => ({
      channel: output.channel,
      format: clean(output.format),
      copy: clean(output.copy),
      cta: clean(output.cta),
    }));
  const visualDirection = clean(input.visualDirection);
  const problems: string[] = [];
  if (!concept.headline || [...concept.headline].length > 28) problems.push("主标题要有，且不超过 28 个字");
  if (!concept.subheadline || [...concept.subheadline].length > 48) problems.push("副标题要有，且不超过 48 个字");
  if (!concept.coreMessage || [...concept.coreMessage].length > 160) problems.push("核心信息要有，且不超过 160 个字");
  if (!channelOutputs.length) problems.push("至少要有 1 个分渠道版本");
  if (channelOutputs.some((output) => !CAMPAIGN_CHANNELS.includes(output.channel as CampaignChannel))) problems.push("分渠道版本里有未知渠道");
  if (channelOutputs.some((output) => !output.format || !output.copy || !output.cta)) problems.push("每个渠道都要有内容形式、正文和 CTA");
  if (channelOutputs.some((output) => [...output.copy].length > 300)) problems.push("单个渠道正文不超过 300 个字");
  if (!visualDirection || [...visualDirection].length > 240) problems.push("视觉方向要有，且不超过 240 个字");
  if (problems.length) return refuse(`没保存：${problems.join("；")}。改好后重新调用 draft_promo_copy。`);

  const creative: CommunicationCreative = {
    concept,
    channelOutputs: channelOutputs as CommunicationCreative["channelOutputs"],
    visualDirection,
    source: "ai",
  };
  const checked = validateCommunicationCreative(state.campaign, creative);
  if (!checked.ok) return refuse(`没保存：${checked.errors.join("；")}。改好后重新调用 draft_promo_copy。`);
  state.campaign = { ...state.campaign, communication: creative, ics1811: state.draft };
  return done({ saved: true, channelCount: creative.channelOutputs.length, status: "needs_review" });
}

const isQuestionId = (value: unknown): value is QuestionId => typeof value === "string" && (QUESTION_IDS as string[]).includes(value);

// 模型登记这句回复要问的问题和提议。问什么、怎么措辞归模型；问的必须是当前真的缺的项，
// 提议可以是缺项怎么填，也可以是已填项改成什么（建好后替用户换算的改动）。
// 提议的值由代码校验并渲染成文字，用户点头时按渲染出来的值记。
export function askCampaignQuestions(state: AgentState, input: Record<string, unknown>): ToolOutcome {
  state.tools.push("ask_campaign_questions");
  if (state.undo) return refuse("这一轮已经撤销了，不用再问。");
  if (!state.draft) return noIcs1811();
  const { request } = state;
  const gaps = gapsOf(state.draft).map((gap) => gap.id);
  const questions = [...new Set(Array.isArray(input.questions) ? input.questions.filter(isQuestionId) : [])];
  const rawProposals = Array.isArray(input.proposals) ? input.proposals.filter(isRecord) : [];
  const proposals: Proposal[] = [];
  const problems: string[] = [];
  for (const item of rawProposals) {
    if (!isQuestionId(item.question)) {
      problems.push("proposals 里的 question 不是有效题号");
      continue;
    }
    // 用户刚说了还不知道的，不能拿「没有」「0」替他占位（「不知道」不等于「没有」）。
    if (item.question === "Q5a" && /扣点|回款/.test(request.trigger.text) && /不知道|不清楚|不确定|待定|没定|要问|问一下|问问|再说/.test(request.trigger.text)) {
      problems.push("用户说了让扣点或回款率还不知道，不能提议没有或 0 占位，如实说还缺");
      continue;
    }
    const checked = checkProposal(state.draft, item.question, item.answer, request.today);
    if (checked.ok) proposals.push(checked.proposal);
    else problems.push(checked.reason);
  }
  if (problems.length) return refuse(`提议没登记：${problems.join("；")}。改好后重新调用 ask_campaign_questions。`);
  // 问了已经不缺、也没有改值提议的项（比如同一轮先记下了）就略过，不为这个让模型重来一遍。
  const asking = [...new Set([...questions, ...proposals.map((item) => item.id)])].filter((id) => gaps.includes(id));
  const stale = questions.filter((id) => !gaps.includes(id) && !proposals.some((item) => item.id === id));
  const topics = new Set([...asking, ...proposals.map((item) => item.id)]);
  if (!topics.size) return refuse(`没有要登记的问题${stale.length ? `（${stale.join("、")} 现在不缺）` : ""}。现在缺的题号：${gaps.join("、") || "无"}`);
  // 一次问太多就又成了填表（实测模型会一口气问 4 件）。挑最要紧的，其余下一句再问。
  if (topics.size > 3) return refuse(`一次最多问 3 件，现在是 ${topics.size} 件。挑最要紧的 3 件以内重新登记，其余等用户答完再问。`);
  state.asking = asking;
  state.proposals = proposals;
  return done({
    asking: asking.map((id) => QUESTION_TITLE[id]),
    ...(stale.length ? { skipped: `${stale.join("、")} 现在不缺，没登记` } : {}),
    proposals: proposals.map((item) => item.text),
    note: proposals.length
      ? "用自己的话把这些问出来。提议要用肯定问法把上面的具体值说出来（「这次也按 X 吧？」），用户回「行」「对」就照这个记下；不要用「有没有」「是A还是B」这种问法配提议，也不要说成已经定了。"
      : "用自己的话把这些问出来，揉进一两句话里，别列成表单。",
  });
}

// 用户同意上一句的提议。只认用户这一轮原话里明确的点头；改了其中一项的，那一项用 extract_campaign_facts 记。
export function acceptCampaignProposals(state: AgentState, input: Record<string, unknown>): ToolOutcome {
  state.tools.push("accept_campaign_proposals");
  if (state.undo) return refuse("这一轮已经撤销了，不能再修改。");
  if (!state.draft) return noIcs1811();
  const { request } = state;
  if (!request.proposals.length) return refuse("上一句没有提议可以采纳。用户说的具体内容用 extract_campaign_facts 记。");
  const quote = typeof input.quote === "string" ? input.quote.trim() : "";
  const said = compactQuote(request.trigger.text);
  const at = quote ? said.indexOf(compactQuote(quote)) : -1;
  if (at < 0) return refuse("quote 必须逐字取自用户这一轮的原话。");
  // 「不行」里的「行」、「不对」里的「对」不是点头。
  if (!agreesToProposal(quote) || /[不没别未]$/.test(said.slice(0, at))) return refuse("这句话不是明确的同意。用户改了或说了具体值，用 extract_campaign_facts 按原话记。");
  const only = Array.isArray(input.questions) && input.questions.length ? input.questions.filter(isQuestionId) : undefined;
  // 整句只是点头的，编排器已经替你记下了；走到这里的都夹带了别的话，必须说清同意的是哪几项。
  if (!only?.length && !isPureAgreement(request.trigger.text)) return refuse("用户这句话除了点头还说了别的，questions 只列他明确同意的题号。");
  const result = acceptProposals(state.draft, request.proposals, quote, only);
  if (!result.accepted.length) return refuse("没有能采纳的提议：可能已经填过了，或者题号不在上一句的提议里。");
  state.draft = result.draft;
  state.applied.push(...result.keys);
  return done({ accepted: result.accepted.map((item) => item.text), status: draftStatus(state.draft, request.today) });
}

export function undoCampaignChange(state: AgentState): ToolOutcome {
  state.tools.push("undo_campaign_change");
  if (state.request.trigger.kind !== "user_message" || !state.request.canUndo) return refuse("现在没有可以撤销的修改。");
  if (state.request.accepted?.length) return refuse("用户这句是在同意提议，已经记下了，不是要撤销。");
  if (state.applied.length || state.copyDrafted) return refuse("这一轮已经做了别的修改，不能再撤销。");
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
  if (!state.draft) return noIcs1811();
  const fill = deriveFill(state.draft);
  const checks = checkDraft(state.draft, fill, state.request.today);
  const status = draftStatus(state.draft, state.request.today);
  state.analysisRan = true;
  return done({
    detailCount: fill.details.length,
    missing: status.missing,
    blockers: status.blockers,
    warnings: checks.filter((check) => check.severity === "warning").map((check) => check.message),
    complete: status.complete,
    next: status.outOfScope
      ? "不在 1811 范围，说明原因即可"
      : status.complete
        ? "齐了：系统这一轮会直接生成 1811 填写值。用两三句话告诉用户 1811 配置产物已准备，并说明整体活动仍要看上线检查；不要说活动已建好或可以上线。"
        : status.missing.length
          ? "还缺：挑最要紧的 1–3 项，先调用 ask_campaign_questions 登记，再在回复里问。"
          : "不缺信息，但有挡着生成的问题：如实说明，告诉用户怎么处理。",
  });
}

// 齐了才能生成；不需要用户再确认。最终填写值仍由 Workers 按最新草稿重新生成。
export function generateIcs1811Sheet(state: AgentState): ToolOutcome {
  state.tools.push("generate_ics1811_sheet");
  if (!state.draft) return noIcs1811();
  const fill = deriveFill(state.draft);
  const checks = checkDraft(state.draft, fill, state.request.today);
  if (planNext(state.draft, fill, checks).action !== "ready") return refuse("活动信息还没补齐或校验未通过，不能生成填写值。");
  const sheet = renderFillSheet(fill, checks);
  state.sheetGenerated = true;
  return done({
    detailCount: sheet.details.length,
    postActionCount: sheet.postActions.length,
    checkCount: sheet.selfCheck.length,
  });
}

const TOOL_HANDLERS: Record<CampaignToolName, (state: AgentState, input: Record<string, unknown>) => ToolOutcome> = {
  update_campaign_brief: updateCampaignBrief,
  analyze_campaign_plan: (state) => analyzeCampaignPlan(state),
  extract_campaign_facts: extractCampaignFacts,
  accept_campaign_proposals: acceptCampaignProposals,
  lookup_ics_reference: lookupIcsReference,
  analyze_campaign_state: analyzeCampaignState,
  ask_campaign_questions: askCampaignQuestions,
  draft_campaign_copy: draftCampaignCopy,
  draft_promo_copy: draftPromoCopy,
  generate_ics1811_sheet: generateIcs1811Sheet,
  undo_campaign_change: (state) => undoCampaignChange(state),
};

export function runAgentTool(
  state: AgentState,
  name: CampaignToolName,
  input: Record<string, unknown> = {},
  context: AgentToolContext = {},
): ToolOutcome {
  if (name === "draft_promo_copy" && !context.loadedSkills?.has("promo-copy-guide")) {
    return refuse("没保存：先加载 promo-copy-guide 业务规则，再重新调用 draft_promo_copy。");
  }
  return TOOL_HANDLERS[name](state, input);
}

// 工具被拒时给界面看的话：说清是哪类没通过，不带入参原文和内部理由。
const REFUSED_SUMMARY: Record<CampaignToolName, string> = {
  update_campaign_brief: "没有能按原话记下的 Brief 信息",
  analyze_campaign_plan: "整体活动分析未执行",
  extract_campaign_facts: "没有能按原话记下的内容，Agent 会跟你确认",
  accept_campaign_proposals: "这句不算同意提议，改按原话处理",
  lookup_ics_reference: "查询词为空，未查询",
  analyze_campaign_state: "规则分析未执行",
  ask_campaign_questions: "问题或提议没通过校验，Agent 已调整",
  draft_campaign_copy: "名称或内容不合规（长度、字符或数字），Agent 重拟",
  draft_promo_copy: "传播方案尚未生成，Agent 会先加载规则或修正内容",
  generate_ics1811_sheet: "信息还没齐，暂不生成",
  undo_campaign_change: "现在没有可撤销的修改",
};

export function safeToolSummary(name: CampaignToolName, outcome: ToolOutcome, state: AgentState): string {
  if (outcome.isError) return REFUSED_SUMMARY[name];
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(outcome.text) as unknown;
    if (isRecord(parsed)) body = parsed;
  } catch {
    // 文案和撤销工具返回短文本，不需要解析。
  }
  switch (name) {
    case "update_campaign_brief":
      return `整理并核验 ${state.briefApplied.length} 项 Brief 信息`;
    case "analyze_campaign_plan":
      return "完成整体活动计划分析";
    case "extract_campaign_facts":
      return `识别并核验 ${state.applied.length} 项信息${state.dropped.length ? `，${state.dropped.length} 项需确认` : ""}`;
    case "lookup_ics_reference":
      return `匹配 ${Array.isArray(body?.matches) ? body.matches.length : 0} 条代码表记录`;
    case "accept_campaign_proposals":
      return `按提议记下 ${Array.isArray(body?.accepted) ? body.accepted.length : 0} 项`;
    case "analyze_campaign_state":
      return body?.complete ? "完成规则分析 · 信息已齐" : `完成规则分析 · ${Array.isArray(body?.missing) ? body.missing.length : 0} 项待补`;
    case "ask_campaign_questions":
      return `登记 ${Array.isArray(body?.asking) ? body.asking.length : 0} 个问题${Array.isArray(body?.proposals) && body.proposals.length ? `，${body.proposals.length} 项提议` : ""}`;
    case "draft_campaign_copy":
      return "活动名称与内容已起草";
    case "draft_promo_copy":
      return `传播方案已起草 · ${state.campaign.communication?.channelOutputs.length ?? 0} 个渠道版本`;
    case "generate_ics1811_sheet":
      return `生成 ${Number(body?.detailCount ?? 0)} 条优惠明细`;
    case "undo_campaign_change":
      return "已恢复到上一个活动版本";
  }
}

export function finishAgentTurn(state: AgentState, reply: string | null): AgentResult {
  // 问什么由模型决定，问句不再删。编造的效果预估（提升 X%）任何时候都删，那是事实问题。
  const cleaned = sanitizeAgentReply(reply);
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
    brief: state.campaign.brief,
    communication: state.campaign.communication,
    briefApplied: [...new Set(state.briefApplied)],
    applied: [...new Set(state.applied)],
    dropped: state.dropped,
    reply: cleaned || null,
    copyDrafted: state.copyDrafted,
    undo: state.undo,
    asking: state.asking,
    proposals: state.proposals,
    tools: state.tools,
    trace,
  };
}
