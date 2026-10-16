import { validateAnalysisAnswer } from "../analytics/analysis-v2-evidence.ts";
import { isToolTrace } from "../tool-trace.ts";
import { parseAttachmentCalculations, parseVisualizationSpec, parseVisualizations, resolveAnalysisVisualization, resolveAttachmentVisualization, visualizationText } from "../analytics/visualization.ts";
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

function numericTokens(value: string): string[] {
  const plain = value.normalize("NFKC").replace(/(?<![\d,.])[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\d,])/g, (number) => number.replace(/,/g, ""));
  const arabic = (plain.match(/[+-]?\d+(?:\.\d+)?(?:%|‰)?/g) ?? []).map((entry) => entry.replace(/^\+/, "").replace(/^(\-?)0+(?=\d)/, "$1").replace(/(\.\d*?[1-9])0+(?=%|‰|$)/, "$1").replace(/\.0+(?=%|‰|$)/, ""));
  const chinese = (plain.match(/[零〇一二两三四五六七八九十百千万亿]+(?:倍|元|天|家|人|件|克|%)/g) ?? []);
  return [...arabic, ...chinese];
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

export function validateConversationDraft(value: unknown, sources: readonly AttachmentSource[]): ConversationDraft {
  if (!record(value) || !["answered", "partial"].includes(String(value.status)) || !Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > 40) fail("文件回答正文格式不正确");
  const byId = new Map(sources.map((item) => [item.id, item]));
  const blocks = value.blocks.map((raw) => {
    if (!record(raw)) fail("文件回答段落格式不正确");
    const content = text(raw.text, "文件回答段落", 6000); const ids = stringList(raw.sourceIds, "文件引用", 30, 120);
    if (!ids.length || ids.some((id) => !byId.has(id)) || new Set(ids).size !== ids.length) fail("文件回答引用了未读取的依据或缺少引用");
    const supported = new Set(ids.flatMap((id) => numericTokens(byId.get(id)!.excerpt)));
    if (numericTokens(content).some((number) => !supported.has(number))) fail("文件回答包含未绑定来源的数字，请引用原文或调用表格计算");
    return { text: content, sourceIds: ids };
  });
  const limitations = stringList(value.limitations, "文件回答限制", 30, 1500);
  return { status: value.status as ConversationDraft["status"], blocks, limitations };
}

export function resolveConversationVisualization(spec: VisualizationSpec, answer: Pick<ConversationAnswer, "blocks" | "sources" | "calculations" | "databaseAnswers">): ResolvedVisualization {
  if (spec.conclusionId) fail("文件图表不能引用不存在的分析结论");
  if (spec.source.kind === "attachment") return resolveAttachmentVisualization(spec, answer.calculations ?? [], answer.sources);
  const matches = (answer.databaseAnswers ?? []).flatMap((database) => (database.visualizations?.items ?? []).filter((original) => original.id === spec.id && JSON.stringify(parseVisualizationSpec({ ...original, afterBlockIndex: spec.afterBlockIndex, conclusionId: undefined })) === JSON.stringify(parseVisualizationSpec(spec))).map(() => database));
  if (matches.length !== 1) fail("经营图表必须引用已通过核验的原图，不能修改数据或选择范围");
  const database = matches[0]; const block = answer.blocks[spec.afterBlockIndex];
  if (!block?.sourceIds.some((id) => answer.sources.some((source) => source.id === id && source.kind === "database" && source.databaseRunId === database.task.runId))) fail("经营图表没有关联本段实际引用的经营范围");
  const chart = resolveAnalysisVisualization(spec, database.evidence);
  return { ...chart, sourceIds: answer.sources.filter((source) => source.databaseRunId === database.task.runId && chart.factIds.includes(source.databaseFactId ?? "")).map((source) => source.id) };
}

export function validateConversationAnswer(value: unknown): ConversationAnswer {
  if (!record(value) || value.schema !== CONVERSATION_ANSWER_SCHEMA || !Array.isArray(value.sources) || value.sources.length > 200) fail("文件回答合同不正确");
  const sources = value.sources.map(source);
  if (new Set(sources.map((item) => item.id)).size !== sources.length) fail("文件引用标识重复");
  const draft = validateConversationDraft(value, sources);
  const visualizations = parseVisualizations(value.visualizations, draft.blocks.length);
  const calculations = value.calculations === undefined ? undefined : parseAttachmentCalculations(value.calculations);
  if (calculations && new Set(calculations.map((item) => item.id)).size !== calculations.length) fail("表格计算标识重复");
  if (value.trace !== undefined && !isToolTrace(value.trace)) fail("文件回答过程记录不正确");
  const databaseAnswers = value.databaseAnswers === undefined ? undefined : Array.isArray(value.databaseAnswers) && value.databaseAnswers.length <= 5 ? value.databaseAnswers.map(validateAnalysisAnswer) : fail("经营数据引用不正确");
  for (const item of sources.filter((item) => item.kind === "database")) {
    const answer = databaseAnswers?.find((answer) => answer.task.runId === item.databaseRunId);
    const fact = answer?.evidence.facts.find((fact) => fact.id === item.databaseFactId);
    if (!answer || !fact || answer.review.verdict === "revise") fail("经营数据引用没有通过原始核验");
  }
  for (const spec of visualizations?.items ?? []) resolveConversationVisualization(spec, { ...draft, calculations, sources, databaseAnswers });
  return { schema: CONVERSATION_ANSWER_SCHEMA, ...draft, sources, ...(databaseAnswers ? { databaseAnswers } : {}), ...(visualizations ? { visualizations } : {}), ...(calculations ? { calculations } : {}), ...(value.trace ? { trace: value.trace as ConversationAnswer["trace"] } : {}) };
}

export const conversationAnswerText = (answer: ConversationAnswer): string => [...answer.blocks.map((block) => block.text), ...(answer.visualizations?.items ?? []).map((spec) => visualizationText(resolveConversationVisualization(spec, answer)))].join("\n\n");
export const isConversationAnswer = (value: unknown): value is ConversationAnswer => record(value) && value.schema === CONVERSATION_ANSWER_SCHEMA;
