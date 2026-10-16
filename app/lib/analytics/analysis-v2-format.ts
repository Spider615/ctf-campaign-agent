import type { AnalysisAnswer, AnalysisAnswerBlock, AnalysisAnswerNode, AnalysisDimension, AnalysisFact, AnalysisFrame } from "./analysis-v2-types.ts";
import { parseChatMarkdown, plainText, type InlineNode } from "../markdown.ts";
import { resolveAnalysisVisualization, visualizationText } from "./visualization.ts";
import type { VisualizationSpec } from "./visualization-types.ts";
import { analysisFactParents } from "./analysis-v2-fact-links.ts";

export type AnalysisInlineNode = { kind: AnalysisAnswerNode["kind"]; text: string; bold: boolean };
type AnalysisPresentationItem = { nodes: AnalysisInlineNode[]; conclusionId?: string };
export type AnalysisPresentationBlock =
  | (AnalysisPresentationItem & { kind: "paragraph" })
  | (AnalysisPresentationItem & { kind: "heading"; level: number })
  | { kind: "list"; ordered: boolean; items: AnalysisPresentationItem[] };

const DIMENSION_LABELS: Record<AnalysisDimension, string> = {
  store: "门店", region: "大区", district: "分区", category: "货类", material: "材料", offer: "活动", memberFlag: "会员标识", storeType: "门店类型", cityTier: "城市层级", mallGroup: "商场", day: "日期", sku: "货品", memberSegment: "会员分组",
};
const POPULATION_LABELS = { sales: "销售正金额行", net: "销售、零元销售和退货净额", recovery: "回收抵扣候选行", returns: "退货行", zero_sales: "零元销售行", unknown: "数据口径待核对" } as const;

function dateText(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

export function formatAnalysisPeriod(frame: AnalysisFrame): string {
  const { start, end } = frame.scope.period;
  return start === end ? dateText(start) : `${dateText(start)}至${dateText(end)}`;
}

function displayFactUnit(unit: string): string {
  return /^(?:CNY|人民币|RMB)(?:(?:\/|每).+)?$/.test(unit) ? unit.replace(/^(?:CNY|人民币|RMB)/, "元").replace("每", "/")
    : unit === "百分比" || unit === "％" ? "%" : unit === "百分点" ? "个百分点" : unit === "unknown" ? "（单位待核对）" : unit;
}

function formatFact(fact: AnalysisFact): string {
  if (fact.value === null) return "暂无可计算值";
  const unit = fact.unit;
  const money = /^(?:CNY|人民币|RMB|元|USD|美元|HKD|港元|EUR|欧元)(?:(?:\/|每).+)?$/.test(unit);
  const perGram = /(?:\/|每)克$/.test(unit);
  const percent = unit === "%" || unit === "％" || unit === "百分比" || unit === "个百分点" || unit === "百分点";
  const min = perGram ? 0 : money || percent ? 2 : 0;
  // 规则参数不是成交总额；显示到分会改变按件规则，微小比例也不能被显示成零。
  const max = fact.assumption && !fact.scenario ? 12 : perGram || unit === "克" ? 6 : money || percent ? 2 : 6;
  const rendered = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: true }).format(Object.is(fact.value, -0) ? 0 : fact.value);
  return `${rendered}${displayFactUnit(unit)}`;
}

// 返回普通文字；调用方必须以文本节点呈现，不能把对象名称当 HTML 或链接解释。
export function formatAnalysisNode(node: AnalysisAnswerNode, answer: AnalysisAnswer): string {
  if (node.kind === "text") return node.text;
  if (node.kind === "fact_ref") {
    const fact = answer.evidence.facts.find((item) => item.id === node.factId);
    if (!fact) throw new Error(`事实引用不存在：${node.factId}`);
    const visited = new Set<string>();
    const hypothetical = (id: string): boolean => {
      if (visited.has(id)) return false;
      visited.add(id); const source = answer.evidence.facts.find((item) => item.id === id);
      if (source?.assumption) return true;
      const walk = (expression: NonNullable<AnalysisFact["derivation"]>): boolean => "factId" in expression ? hypothetical(expression.factId) : "args" in expression && expression.args.some(walk);
      return Boolean(source?.derivation && walk(source.derivation));
    };
    const marker = fact.assumption ? fact.metricId.startsWith("scenario.") ? "（情景测算）" : "（假设）" : (fact.metricId.startsWith("calculation.") || fact.metricId.startsWith("scenario.")) && hypothetical(fact.id) ? "（情景测算）" : "";
    return `${formatFact(fact)}${marker}`;
  }
  if (node.kind === "object_ref") {
    const object = answer.evidence.objects.find((item) => item.id === node.objectId);
    if (!object) throw new Error(`对象引用不存在：${node.objectId}`);
    return /^[\p{N}\s.-]+$/u.test(object.label) ? `${DIMENSION_LABELS[object.dimension]}${object.label}` : object.label;
  }
  if (node.kind === "period_ref") {
    const frame = answer.evidence.frames.find((item) => item.id === node.frameId);
    if (!frame) throw new Error(`周期引用不存在：${node.frameId}`);
    return formatAnalysisPeriod(frame);
  }
  if (node.kind === "user_condition_ref") {
    const condition = answer.userConditions.find((item) => item.id === node.conditionId);
    if (!condition) throw new Error(`用户条件引用不存在：${node.conditionId}`);
    return `用户条件：「${condition.quote}」`;
  }
  const parameter = answer.trialParameters.find((item) => item.id === node.parameterId);
  if (!parameter) throw new Error(`计划参数引用不存在：${node.parameterId}`);
  const value = parameter.kind === "store_count" ? parameter.objectIds.length : parameter.value;
  return `建议设置：${value}${parameter.kind === "store_count" ? "家门店" : "天"}（拟议，须${parameter.conditions.join("；")}）`;
}

function unitBoundary(text: string): boolean {
  // 斜线和“每”可能继续组成更完整的单位，不能只删前半段。
  if (/^(?:[\/／]|每)/u.test(text)) return false;
  if (!text || /^[\s\p{P}\p{S}]/u.test(text)) return true;
  // 仅接受数值关系连接词；任意汉字接续仍保留，避免把单笔、克重、元旦等词截掉。
  return /^(?:增加|减少|增长|下降|上升|变化|变动|升至|降至|增至|减至|升到|降到|增到|减到|提高|降低|以上|以下|以内|以外|左右|上下)/u.test(text);
}

// 只更改展示片段，并与原节点保持同索引；事实单位、数值、草稿和证据都不修改。
export function formatAnalysisNodes(nodes: readonly AnalysisAnswerNode[], answer: AnalysisAnswer): string[] {
  const formatted = nodes.map((node) => formatAnalysisNode(node, answer));
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.kind !== "fact_ref") continue;
    const fact = answer.evidence.facts.find((item) => item.id === node.factId);
    if (!fact || fact.value === null || !fact.unit || fact.unit === "unknown") continue;
    const unit = displayFactUnit(fact.unit);
    const candidates = [...new Set([unit, ...(unit.includes("/") ? [unit.split("/")[0]] : [])])].sort((left, right) => right.length - left.length);
    const textIndices: number[] = [];
    for (let next = index + 1; next < nodes.length && nodes[next].kind === "text"; next += 1) textIndices.push(next);
    const adjacent = textIndices.map((at) => formatted[at]).join("");
    let start = /^\s*/u.exec(adjacent)![0].length;
    const before = nodes.slice(0, index).filter((item) => item.kind === "text").map((item) => item.text).join("").split("\n").at(-1)!;
    // 加粗的闭合标记不隔断相邻单位，保留标记，只去掉已由引用提供的重复单位。
    if ((before.match(/\*\*/gu)?.length ?? 0) % 2 === 1 && adjacent.startsWith("**", start)) start += 2 + /^\s*/u.exec(adjacent.slice(start + 2))![0].length;
    const duplicate = candidates.find((candidate) => candidate && adjacent.startsWith(candidate, start) && unitBoundary(adjacent.slice(start + candidate.length)));
    if (!duplicate) continue;
    const end = start + duplicate.length;
    let offset = 0;
    for (const at of textIndices) {
      const text = formatted[at];
      const from = Math.max(0, start - offset); const to = Math.min(text.length, end - offset);
      if (to > from) formatted[at] = text.slice(0, from) + text.slice(to);
      offset += text.length;
    }
  }
  return formatted;
}

function presentBlock(block: AnalysisAnswerBlock, answer: AnalysisAnswer): AnalysisPresentationBlock[] {
  const formatted = formatAnalysisNodes(block.nodes, answer);
  // 只解析模型文字的排版；对象名称、数字和用户原话先用不冲突的占位符保护，之后按字面还原。
  let marker = "\uFFFC";
  while (block.nodes.some((node) => node.kind === "text" && node.text.includes(marker))) marker += "\uFFFC";
  const references: AnalysisInlineNode[] = [];
  let source = block.nodes.map((node, index) => {
    if (node.kind === "text") return formatted[index];
    const at = references.push({ kind: node.kind, text: formatted[index], bold: false }) - 1;
    return `${marker}${at}${marker}`;
  }).join("");
  if (block.kind === "heading" && !/^#{1,6}\s/u.test(source.trimStart())) source = `## ${source}`;
  if (block.kind === "bullet" && !/^(?:[-*•]|\d+[.、)])\s/u.test(source.trimStart())) source = `- ${source}`;
  const inline = (values: InlineNode[]): AnalysisInlineNode[] => values.flatMap((value) => {
    const nodes: AnalysisInlineNode[] = []; let offset = 0;
    for (const match of value.text.matchAll(new RegExp(`${marker}(\\d+)${marker}`, "gu"))) {
      if (match.index > offset) nodes.push({ kind: "text", text: value.text.slice(offset, match.index), bold: value.kind === "bold" });
      nodes.push({ ...references[Number(match[1])], bold: value.kind === "bold" });
      offset = match.index + match[0].length;
    }
    if (offset < value.text.length) nodes.push({ kind: "text", text: value.text.slice(offset), bold: value.kind === "bold" });
    return nodes;
  });
  const parsed = parseChatMarkdown(source);
  return parsed.map((part, index) => {
    const conclusionId = index === parsed.length - 1 ? block.conclusionId : undefined;
    if (part.kind === "list") return { kind: "list", ordered: part.ordered, items: part.items.map((item, at) => ({ nodes: inline(item), ...(at === part.items.length - 1 && conclusionId ? { conclusionId } : {}) })) };
    const item = { nodes: inline(part.inline), ...(conclusionId ? { conclusionId } : {}) };
    return part.kind === "heading" ? { ...item, kind: "heading", level: part.level } : { ...item, kind: "paragraph" };
  });
}

function presentationText(block: AnalysisPresentationBlock): string {
  return block.kind === "list" ? block.items.map((item) => item.nodes.map((node) => node.text).join("")).join("\n") : block.nodes.map((node) => node.text).join("");
}

// 建议字段已接受硬核验与逐项独立复核，模型漏写到blocks时仍须在客户正文展示。
export function analysisDisplayBlocks(answer: AnalysisAnswer): AnalysisAnswerBlock[] {
  if (answer.review.verdict === "revise") return answer.blocks;
  const last = new Map<string, number>(); const existing = new Map<string, string>();
  answer.blocks.forEach((block, index) => {
    if (!block.conclusionId) return;
    last.set(block.conclusionId, index);
    existing.set(block.conclusionId, `${existing.get(block.conclusionId) ?? ""}\n${presentBlock(block, answer).map(presentationText).join("\n")}`);
  });
  const actions = new Map(answer.conclusions.map((conclusion) => [conclusion.id, conclusion.action?.trim()]));
  return answer.blocks.flatMap((block, index): AnalysisAnswerBlock[] => {
    const id = block.conclusionId, action = id ? actions.get(id) : undefined;
    if (!id || !action || last.get(id) !== index || existing.get(id)?.replace(/\s/gu, "").includes(plainText(action).replace(/\s/gu, ""))) return [block];
    return [block, { kind: "paragraph", conclusionId: id, nodes: [{ kind: "text", text: `建议动作：${action}` }] }];
  });
}

export function analysisPresentationBlocks(answer: AnalysisAnswer): AnalysisPresentationBlock[] {
  const blocks: AnalysisPresentationBlock[] = [];
  for (const part of analysisDisplayBlocks(answer).flatMap((block) => presentBlock(block, answer))) {
    const previous = blocks.at(-1);
    if (part.kind === "list" && previous?.kind === "list" && part.ordered === previous.ordered) previous.items.push(...part.items);
    else blocks.push(part);
  }
  return blocks;
}

export type AnalysisVisualPresentationBlock = AnalysisPresentationBlock | { kind: "visualization"; spec: VisualizationSpec };
export function analysisVisualPresentationBlocks(answer: AnalysisAnswer): AnalysisVisualPresentationBlock[] {
  if (!answer.visualizations?.items.length) return analysisPresentationBlocks(answer);
  const blocks: AnalysisVisualPresentationBlock[] = [];
  for (const block of analysisDisplayBlocks(answer)) {
    for (const part of presentBlock(block, answer)) {
      const previous = blocks.at(-1);
      if (part.kind === "list" && previous?.kind === "list" && part.ordered === previous.ordered) previous.items.push(...part.items);
      else blocks.push(part);
    }
    const index = answer.blocks.indexOf(block);
    for (const spec of answer.visualizations.items.filter((item) => item.afterBlockIndex === index)) blocks.push({ kind: "visualization", spec });
  }
  return blocks;
}

export function analysisAnswerText(answer: AnalysisAnswer): string {
  const body = analysisPresentationBlocks(answer).map((block) => block.kind === "list" ? block.items.map((item, index) => `${block.ordered ? `${index + 1}. ` : "• "}${item.nodes.map((node) => node.text).join("")}`).join("\n") : presentationText(block)).join("\n\n");
  const factIds = new Set(answer.conclusions.flatMap((item) => item.factIds));
  const objectIds = new Set(answer.conclusions.flatMap((item) => item.objectIds));
  const frameIds = new Set<string>();
  const visited = new Set<string>();
  function includeFact(id: string): void {
    if (visited.has(id)) return; visited.add(id);
    const fact = answer.evidence.facts.find((item) => item.id === id);
    if (!fact) return;
    factIds.add(id); frameIds.add(fact.frameId); fact.objectIds.forEach((objectId) => objectIds.add(objectId));
    analysisFactParents(fact).forEach(includeFact);
  }
  for (const id of factIds) includeFact(id);
  for (const block of answer.blocks) for (const node of block.nodes) {
    if (node.kind === "fact_ref") includeFact(node.factId);
    if (node.kind === "object_ref") objectIds.add(node.objectId);
    if (node.kind === "period_ref") frameIds.add(node.frameId);
  }
  for (const parameter of answer.trialParameters) parameter.objectIds.forEach((id) => objectIds.add(id));
  for (const object of answer.evidence.objects) if (objectIds.has(object.id)) frameIds.add(object.frameId);
  const operations = new Set(answer.evidence.facts.filter((fact) => factIds.has(fact.id)).map((fact) => fact.operationId));
  const methods = answer.evidence.methods.filter((method) => operations.has(method.operationId) || answer.conclusions.some((item) => item.methodIds.includes(method.id)));
  for (const method of methods) method.frameIds.forEach((id) => frameIds.add(id));
  const scopes = new Set(answer.evidence.frames.filter((frame) => frameIds.has(frame.id)).map((frame) => `${formatAnalysisPeriod(frame)}，${POPULATION_LABELS[frame.scope.population]}，${frame.currency === "CNY" ? "人民币" : frame.currency === "unknown" || frame.currency === "未核对" ? "币种未核对" : frame.currency}，${frame.mode === "historical" ? "历史资料，" : ""}${frame.provenance === "sample" ? "模拟数据" : "导入数据"}`));
  const limits = new Set([
    ...answer.conclusions.flatMap((item) => item.limitations),
    ...answer.evidence.frames.filter((frame) => frameIds.has(frame.id)).flatMap((frame) => frame.limitations),
    ...answer.evidence.facts.filter((fact) => factIds.has(fact.id)).flatMap((fact) => [fact.definition, ...fact.limitations]),
    ...methods.flatMap((method) => method.limitations),
  ]);
  const status = answer.status === "incomplete" ? "分析尚未完成。" : answer.status === "conditional" ? "以下判断有条件成立。" : "";
  const charts = (answer.visualizations?.items ?? []).map((spec) => visualizationText(resolveAnalysisVisualization(spec, answer.evidence))).join("\n\n");
  return [status, body, charts, answer.questions.length ? `需要确认：${answer.questions.join("；")}` : "", scopes.size ? `依据：${[...scopes].join("；")}。` : "", limits.size ? `口径与限制：${[...limits].join("；")}` : ""].filter(Boolean).join("\n\n");
}
