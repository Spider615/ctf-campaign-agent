import { validatePlanAnswer, validatePlanAnswerV4 } from "../analytics/plan/answer.ts";
import { PLAN_ANSWER_V4_SCHEMA } from "../analytics/analysis-v2-types.ts";
import { isToolTrace } from "../tool-trace.ts";
import { parseAttachmentCalculations, parseVisualizations, resolveAttachmentVisualization, visualizationText } from "../analytics/visualization.ts";
import type { ResolvedVisualization, VisualizationSpec } from "../analytics/visualization-types.ts";
import { CONVERSATION_ANSWER_SCHEMA, validAttachmentId, type AttachmentSource, type ConversationAnswer, type ConversationDraft, type ConversationRequest } from "./types.ts";

const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
function fail(message: string): never { throw new Error(message); }
const text = (v: unknown, label: string, max = 4000): string => typeof v === "string" && v.trim() && v.length <= max ? v : fail(`${label}无效`);
const stringList = (v: unknown, label: string, max: number, length = 1000): string[] => Array.isArray(v) && v.length <= max ? v.map((item) => text(item, label, length)) : fail(`${label}无效`);

export function validateConversationRequest(value: unknown): ConversationRequest {
  if (!record(value) || Object.keys(value).some((key) => !["conversationId", "question", "attachmentIds", "history", "context"].includes(key))) fail("文件对话请求格式不正确");
  if (!validAttachmentId(value.conversationId)) fail("文件对话会话标识不正确");
  const question = text(value.question, "文件问题", 500);
  if (!Array.isArray(value.attachmentIds) || !value.attachmentIds.length || value.attachmentIds.length > 100 || value.attachmentIds.some((id) => !validAttachmentId(id)) || new Set(value.attachmentIds).size !== value.attachmentIds.length) fail("附件标识不正确");
  if (!Array.isArray(value.history) || value.history.length > 10 || value.history.some((item) => !record(item) || !["user", "assistant"].includes(String(item.role)) || typeof item.text !== "string" || item.text.length > 4000)) fail("文件对话历史格式不正确");
  if (value.context !== undefined && (!Array.isArray(value.context) || value.context.length > 200 || value.context.some((item) => typeof item !== "string" || item.length > 500))) fail("文件对话持续要求格式不正确");
  return { conversationId: value.conversationId, question, attachmentIds: value.attachmentIds as string[], history: value.history as ConversationRequest["history"], ...(value.context ? { context: value.context as string[] } : {}) };
}

// 日期统一成「年月日」，免得 2025-03-01 被拆成 2025、-3、-1，正文写「3 月」反而对不上。
const datesAsText = (value: string) => value.replace(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/g, "$1年$2月$3日").replace(/(?<!\d)(\d{4})[-/](\d{1,2})(?![\d\-/])/g, "$1年$2月");
const trimNumber = (entry: string) => entry.replace(/^\+/, "").replace(/^(-?)0+(?=\d)/, "$1").replace(/(\.\d*?[1-9])0+(?=%|‰|万|亿|$)/, "$1").replace(/\.0+(?=%|‰|万|亿|$)/, "").replace(/^-0(?=%|‰|万|亿|$)/, "0");

function numericTokens(value: string): string[] {
  const plain = datesAsText(value.normalize("NFKC")).replace(/(?<![\d,.])[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])/g, (number) => number.replace(/,/g, ""));
  const arabic = (plain.match(/[+-]?\d+(?:\.\d+)?(?:%|‰|万|亿)?/g) ?? []).map(trimNumber);
  const chinese = (plain.match(/(?<![\d.])[零〇一二两三四五六七八九十百千万亿]+(?:倍|元|天|家|人|件|克|%)/g) ?? []);
  return [...arabic, ...chinese];
}

// 来源里的同一个数允许按常见写法展示：保留 0–2 位小数、换成万或亿、比率写成百分数。
// 只换写法不换数，负号和数量级都不会丢。
function displayForms(token: string): string[] {
  const match = token.match(/^(-?\d+(?:\.\d+)?)(%|‰|万|亿)?$/); if (!match) return [token];
  const value = Number(match[1]); const suffix = match[2] ?? ""; if (!Number.isFinite(value)) return [token];
  const forms = new Set([token]);
  // 舍入后至少保留两位有效数字，0.29 不能写成 0，21.77 不能写成 22 以外更粗的数。
  const significant = (text: string) => text.replace(/^-?0*\.?0*/, "").replace(/\./, "").length;
  const rounded = (number: number, unit: string) => { for (const digits of [0, 1, 2]) { const shown = number.toFixed(digits); if (significant(shown) >= 2) forms.add(trimNumber(shown + unit)); } };
  rounded(value, suffix);
  if (!suffix) {
    if (Math.abs(value) >= 1000) rounded(value / 1e4, "万");
    if (Math.abs(value) >= 1e7) rounded(value / 1e8, "亿");
    if (Math.abs(value) <= 10 && match[1].includes(".")) rounded(value * 100, "%");
  }
  return [...forms];
}

const magnitude = (token: string): number | null => { const match = token.match(/^(-?\d+(?:\.\d+)?)(%|‰|万|亿)?$/); if (!match) return null; const scale = { "%": 0.01, "‰": 0.001, 万: 1e4, 亿: 1e8 }[match[2] as "%"] ?? 1; return Number(match[1]) * scale; };
// 模型写错舍入或单位时，找出来源里数值接近的数，列出它允许的写法，帮模型一次改对。
function nearbyForms(token: string, sourceTokens: string[]): string[] {
  const value = magnitude(token); if (value === null || value === 0) return [];
  const near = (other: number, target: number) => Math.abs(Math.abs(other) - Math.abs(target)) <= Math.abs(target) * 0.02;
  const candidates = [...new Set(sourceTokens)].map((candidate) => ({ candidate, other: magnitude(candidate) })).filter((item): item is { candidate: string; other: number } => item.other !== null && item.other !== 0);
  const close = candidates.filter((item) => near(item.other, value)).map((item) => item.candidate);
  // 差 10 倍、100 倍、1 万倍通常是万和元、百分数和小数换错了，直接点明。
  if (!close.length && Math.abs(value) >= 1000) { const shifted = candidates.find((item) => [10, 100, 1e4].some((factor) => near(item.other * factor, value) || near(item.other / factor, value))); if (shifted) return [`（数量级不对，来源是 ${shifted.candidate}）`, ...displayForms(shifted.candidate).filter((form) => /[万亿%]$/.test(form)).slice(-2)]; }
  const percent = token.endsWith("%"); const large = /[万亿]$/.test(token);
  return close.slice(0, 2).flatMap((candidate) => displayForms(candidate).filter((form) => percent ? form.endsWith("%") : large ? /[万亿]$/.test(form) : !/[%万亿‰]$/.test(form)).slice(-2)).slice(0, 4);
}

function source(value: unknown): AttachmentSource {
  if (!record(value)) fail("文件引用格式不正确");
  const kind = value.kind;
  if (!["document", "table", "image", "database"].includes(String(kind))) fail("文件引用类型无效");
  if (!validAttachmentId(value.attachmentId)) fail("文件引用附件标识无效");
  if (typeof value.version !== "string" || !/^[a-f0-9]{64}$/.test(value.version)) fail("文件引用版本无效");
  const result: AttachmentSource = { id: text(value.id, "引用标识", 120), attachmentId: value.attachmentId, version: value.version, name: text(value.name, "文件名称", 255), location: text(value.location, "文件位置", 600), kind: kind as AttachmentSource["kind"], excerpt: text(value.excerpt, "文件引用正文", 12000) };
  if (value.imageId !== undefined) result.imageId = text(value.imageId, "图像标识", 80);
  if (value.databaseRunId !== undefined) result.databaseRunId = text(value.databaseRunId, "经营分析标识", 120);
  if (value.databaseFactId !== undefined) result.databaseFactId = text(value.databaseFactId, "经营事实标识", 120);
  if (value.calculationId !== undefined) { if (kind !== "table") fail("文件计算来源必须是表格"); result.calculationId = text(value.calculationId, "表格计算标识", 120); }
  return result;
}

// 限制说明不绑定来源，但里面的数字同样要能在本轮读到的来源里找到，免得口径说明里冒出编造的数。
export function unsupportedLimitationNumbers(limitations: readonly string[], sources: readonly AttachmentSource[]): string[] {
  const supported = new Set(sources.flatMap((item) => numericTokens(item.excerpt).flatMap(displayForms)));
  return [...new Set(limitations.flatMap((text) => numericTokens(text.replace(/(\d[\d,]*(?:\.\d+)?)\s*个百分点/g, "$1%")).filter((number) => !supported.has(number) && !supported.has("-" + number))))];
}

export function validateConversationDraft(value: unknown, sources: readonly AttachmentSource[]): ConversationDraft {
  if (!record(value) || !["answered", "partial"].includes(String(value.status)) || !Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > 40) fail("文件回答正文格式不正确");
  const byId = new Map(sources.map((item) => [item.id, item]));
  const blocks = value.blocks.map((raw, index) => {
    if (!record(raw)) fail("文件回答段落格式不正确");
    const content = text(raw.text, "文件回答段落", 6000); const ids = stringList(raw.sourceIds, "文件引用", 30, 120);
    if (!ids.length || ids.some((id) => !byId.has(id)) || new Set(ids).size !== ids.length) {
      const unknown = ids.filter((id) => !byId.has(id)); const repeated = ids.filter((id, position) => ids.indexOf(id) !== position);
      fail(`文件回答引用了未读取的依据或缺少引用：第${index + 1}段${!ids.length ? "没有绑定来源" : ""}${unknown.length ? `引用了本轮没有返回的 ${[...new Set(unknown)].slice(0, 8).join("、")}` : ""}${repeated.length ? `重复引用 ${[...new Set(repeated)].slice(0, 8).join("、")}` : ""}。只能引用工具实际返回的 sourceId，去掉这些编号或先读取、计算出对应来源。`);
    }
    const supported = new Set(ids.flatMap((id) => numericTokens(byId.get(id)!.excerpt).flatMap(displayForms)));
    // 「下降 7.69%」「减少 954.55 万」用方向词表达变化：这类数字按绝对值或负值对上来源都算有据；
    // 其他数字照旧逐个比对，正数不能冒充负值。
    const listless = content.replace(/(^|\n)([ \t]*(?:#{1,6}[ \t]+)?)[0-9]{1,2}[.)、][ \t]+/g, "$1$2");
    const directional: string[] = [];
    const businessText = listless
      .replace(/(\d[\d,]*(?:\.\d+)?)\s*个百分点/g, (_whole, number: string) => { directional.push(...numericTokens(number + "%")); return "百分点"; })
      .replace(/(?<![至最])(下降|减少|降低|回落|下滑|缩减|亏损)(了|约|近|超过|达)?\s*(\d[\d,]*(?:\.\d+)?(?:%|‰|万|亿)?)/g, (_whole, verb: string, filler: string | undefined, number: string) => { directional.push(...numericTokens(number)); return verb + (filler ?? ""); });
    const unsupported = [...new Set([...numericTokens(businessText).filter((number) => !supported.has(number)), ...directional.filter((number) => !supported.has(number) && !supported.has("-" + number))])];
    if (unsupported.length) {
      const hints = unsupported.slice(0, 6).flatMap((token) => { const near = nearbyForms(token, ids.flatMap((id) => numericTokens(byId.get(id)!.excerpt))); return near.length ? [`${token} 可写成 ${near.join(" / ")}`] : []; });
      fail(`文件回答第${index + 1}段包含未绑定来源的数字：${unsupported.slice(0, 12).join("、")}；本段引用：${ids.join("、")}。${hints.length ? `按来源四舍五入后的写法：${hints.join("；")}。` : ""}数字要来自绑定的来源（可按万、亿、百分数或两位小数四舍五入展示）；找不到来源时先用计算工具算出，或删掉这个数字保留判断。`);
    }
    return { text: content, sourceIds: ids };
  });
  const limitations = stringList(value.limitations, "文件回答限制", 30, 1500);
  return { status: value.status as ConversationDraft["status"], blocks, limitations };
}

export function resolveConversationVisualization(spec: VisualizationSpec, answer: Pick<ConversationAnswer, "blocks" | "sources" | "calculations">): ResolvedVisualization {
  if (spec.conclusionId) fail("文件图表不能引用不存在的分析结论");
  if (spec.source.kind === "attachment") return resolveAttachmentVisualization(spec, answer.calculations ?? [], answer.sources);
  // 经营数据答案的图不再导入文件回答，只认文件表格计算生成的图。
  return fail("文件回答不能引用经营数据图表");
}

// 文件回答里的经营数据引用：新回答带 v4，旧会话里存的仍是 v3。
const databaseAnswer = (value: unknown) => record(value) && value.schema === PLAN_ANSWER_V4_SCHEMA ? validatePlanAnswerV4(value) : validatePlanAnswer(value);

export function validateConversationAnswer(value: unknown): ConversationAnswer {
  if (!record(value) || value.schema !== CONVERSATION_ANSWER_SCHEMA || !Array.isArray(value.sources) || value.sources.length > 200) fail("文件回答合同不正确");
  const sources = value.sources.map(source);
  if (new Set(sources.map((item) => item.id)).size !== sources.length) fail("文件引用标识重复");
  const draft = validateConversationDraft(value, sources);
  const visualizations = parseVisualizations(value.visualizations, draft.blocks.length);
  const calculations = value.calculations === undefined ? undefined : parseAttachmentCalculations(value.calculations);
  if (calculations && new Set(calculations.map((item) => item.id)).size !== calculations.length) fail("表格计算标识重复");
  if (value.trace !== undefined && !isToolTrace(value.trace)) fail("文件回答过程记录不正确");
  const databaseAnswers = value.databaseAnswers === undefined ? undefined : Array.isArray(value.databaseAnswers) && value.databaseAnswers.length <= 5 ? value.databaseAnswers.map(databaseAnswer) : fail("经营数据引用不正确");
  for (const item of sources.filter((item) => item.kind === "database")) {
    const answer = databaseAnswers?.find((answer) => answer.runId === item.databaseRunId);
    const fact = answer?.evidence.facts.find((fact) => fact.id === item.databaseFactId);
    if (!answer || !fact) fail("经营数据引用没有通过原始核验");
  }
  for (const spec of visualizations?.items ?? []) resolveConversationVisualization(spec, { ...draft, calculations, sources });
  return { schema: CONVERSATION_ANSWER_SCHEMA, ...draft, sources, ...(databaseAnswers ? { databaseAnswers } : {}), ...(visualizations ? { visualizations } : {}), ...(calculations ? { calculations } : {}), ...(value.trace ? { trace: value.trace as ConversationAnswer["trace"] } : {}) };
}

export const conversationAnswerText = (answer: ConversationAnswer): string => [...answer.blocks.map((block) => block.text), ...(answer.visualizations?.items ?? []).map((spec) => visualizationText(resolveConversationVisualization(spec, answer)))].join("\n\n");
export const isConversationAnswer = (value: unknown): value is ConversationAnswer => record(value) && value.schema === CONVERSATION_ANSWER_SCHEMA;
