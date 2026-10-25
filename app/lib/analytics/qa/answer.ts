import { removeUnderlyingIdentity } from "../../agent/reply-stream.ts";
import type { AnalysisCapabilities, AnalysisEvidence, PlanAnswerBlock, PlanAnswerV4 } from "../analysis-v2-types.ts";
import { analysisFactParents } from "../analysis-v2-fact-links.ts";
import { validatePlanAnswerV4 } from "../plan/answer.ts";
import type { ResolvedVisualization } from "../visualization-types.ts";

export type AssembleQaAnswerInput = { runId: string; question: string; body: string; charts: Map<string, ResolvedVisualization>; evidence: AnalysisEvidence; readFactIds: Iterable<string>; operations: Array<{ id: string; op: string; status: string; summary: string }>; capabilities?: AnalysisCapabilities };

const unique = (items: string[]) => [...new Set(items)];

// 只拆 Markdown 表格，不解析或执行 HTML。反斜线转义的竖线属于单元格内容。
function tableCells(line: string): string[] | undefined {
  const text = line.trim(); const cells: string[] = []; let cell = ""; let pipes = 0; let lastPipe = -1;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\" && (text[at + 1] === "|" || text[at + 1] === "\\")) { cell += text[at + 1]; at += 1; continue; }
    if (char === "|") { cells.push(cell.trim()); cell = ""; pipes += 1; lastPipe = at; }
    else cell += char;
  }
  if (!pipes) return undefined;
  cells.push(cell.trim());
  if (text.startsWith("|")) cells.shift();
  if (lastPipe === text.length - 1) cells.pop();
  return cells;
}

function removeInlineCharts(line: string, issues: string[]): string {
  let text = "";
  for (let at = 0; at < line.length;) {
    if (line[at] === "\\" && at + 1 < line.length) { text += line.slice(at, at + 2); at += 2; continue; }
    if (line[at] === "`") {
      const run = /^`+/.exec(line.slice(at))![0]; let end = line.indexOf(run, at + run.length);
      while (end >= 0 && (line[end - 1] === "`" || line[end + run.length] === "`")) end = line.indexOf(run, end + run.length);
      if (end >= 0) { text += line.slice(at, end + run.length); at = end + run.length; continue; }
      text += run; at += run.length; continue;
    }
    if (line.startsWith("[[chart:", at)) {
      const end = line.indexOf("]]", at + 8);
      if (end >= 0) {
        const id = line.slice(at + 8, end);
        issues.push(`图表「${id}」占位必须独立成行，已移除内联占位；请调整后重新提交`);
        at = end + 2; continue;
      }
    }
    text += line[at]; at += 1;
  }
  return text;
}

function parseBody(text: string, charts: Map<string, ResolvedVisualization>): { body: PlanAnswerBlock[]; issues: string[] } {
  const body: PlanAnswerBlock[] = []; const issues: string[] = []; let pending: string[] = [];
  // 先识别表格结构，普通段落再按语句清洗；表格在拆列后逐格清洗，避免删掉同行数值和分隔符。
  const flush = () => { const value = removeUnderlyingIdentity(pending.join("\n")).trim(); if (value) body.push({ kind: "markdown", text: value, refs: [] }); pending = []; };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let fence: { char: string; length: number } | undefined;
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]; const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      pending.push(line);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = { char: marker[1][0], length: marker[1].length }; pending.push(line); continue; }
    if (/^(?: {4}|\t)/.test(line)) { pending.push(line); continue; }
    const placeholder = /^ {0,3}\[\[chart:([^\]\s]+)\]\]\s*$/.exec(line);
    if (placeholder) {
      const id = placeholder[1]; const chart = charts.get(id);
      if (chart) { flush(); body.push({ kind: "chart", chart }); }
      else issues.push(`图表「${id}」不存在或尚未生成，已移除占位；请先生成图表后重新提交`);
      continue;
    }
    const cleanLine = removeInlineCharts(line, issues);
    const columns = tableCells(cleanLine); const separator = at + 1 < lines.length ? tableCells(lines[at + 1]) : undefined;
    if (columns?.length && separator?.length === columns.length && separator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      flush(); const rows: Array<{ cells: string[]; factIds: string[] }> = [];
      at += 1;
      while (at + 1 < lines.length) {
        const next = lines[at + 1];
        if (!next.trim() || /^\s*\[\[chart:/.test(next)) break;
        const cells = tableCells(removeInlineCharts(next, issues)); if (!cells) break;
        if (cells.length !== columns.length) throw new Error(`表格第 ${rows.length + 1} 行的单元格数与列数不一致，请修正后重新提交正文`);
        rows.push({ cells: cells.map(removeUnderlyingIdentity), factIds: [] }); at += 1;
      }
      body.push({ kind: "table", title: "", columns: columns.map(removeUnderlyingIdentity), rows });
    } else pending.push(cleanLine);
  }
  flush(); return { body, issues };
}

// 从已读分页与图表引用出发补齐整个父链。无图时同样保留已读的真实结果。
function retainedEvidence(evidence: AnalysisEvidence, factIds: Iterable<string>): AnalysisEvidence {
  const index = new Map(evidence.facts.map((fact) => [fact.id, fact])); const keep = new Set(factIds);
  for (const id of keep) {
    const fact = index.get(id);
    if (!fact) throw new Error(`回答引用的事实依据「${id}」不存在，请重新读取结果后提交`);
    analysisFactParents(fact).forEach((parent) => keep.add(parent));
  }
  const facts = evidence.facts.filter((fact) => keep.has(fact.id));
  const operationIds = new Set(facts.map((fact) => fact.operationId));
  const methods = evidence.methods.filter((method) => operationIds.has(method.operationId));
  const objectIds = new Set(facts.flatMap((fact) => fact.objectIds)); const objects = evidence.objects.filter((item) => objectIds.has(item.id));
  const frameIds = new Set([...facts.map((fact) => fact.frameId), ...objects.map((item) => item.frameId), ...methods.flatMap((method) => method.frameIds)]);
  return { facts, objects, methods, frames: evidence.frames.filter((frame) => frameIds.has(frame.id)) };
}

function contextOf(evidence: AnalysisEvidence, capabilities?: AnalysisCapabilities): { definitions: string[]; assumptions: string[] } {
  const definitions = evidence.facts.map((fact) => fact.definition);
  const assumptions = [
    ...evidence.facts.flatMap((fact) => [...fact.limitations, ...(fact.assumption ? [`假设：${fact.assumption.reason}`] : [])]),
    ...evidence.frames.flatMap((frame) => frame.limitations), ...evidence.methods.flatMap((method) => method.limitations),
    ...(capabilities?.limitations ?? []),
  ];
  const metricIds = new Set(evidence.facts.flatMap((fact) => [fact.metricId, fact.metricId.split(".")[0]]));
  const dimensionIds = new Set([...evidence.objects.map((item) => item.dimension), ...evidence.frames.flatMap((frame) => frame.controls), ...evidence.methods.flatMap((method) => method.controls)]);
  for (const entry of [...(capabilities?.metrics ?? []).filter((metric) => metricIds.has(metric.id)), ...(capabilities?.dimensionCatalog ?? []).filter((dimension) => dimensionIds.has(dimension.id))]) {
    if (entry.basis === "assumption") assumptions.push(`口径待确认：${entry.label}，${entry.definition}`);
    else definitions.push(`${entry.label}：${entry.definition}`);
  }
  return { definitions: unique(definitions.map(removeUnderlyingIdentity).filter(Boolean)), assumptions: unique(assumptions.map(removeUnderlyingIdentity).filter(Boolean)) };
}

export function assembleQaAnswer(input: AssembleQaAnswerInput): PlanAnswerV4 {
  if (typeof input.body !== "string") throw new Error("回答正文必须是 Markdown 文字，请补充正文后重新提交");
  const text = input.body.trim();
  if (!text) throw new Error("回答正文为空或清洗后没有有效内容，请重写正文后重新提交");
  const { body, issues } = parseBody(text, input.charts);
  if (!body.length) throw new Error("回答正文没有有效内容，请补充正文或生成有效图表后重新提交");
  const chartFacts = body.flatMap((block) => block.kind === "chart" ? [...block.chart.factIds, ...block.chart.series.flatMap((series) => series.values.flatMap((point) => point.refIds))] : []);
  const evidence = retainedEvidence(input.evidence, [...input.readFactIds, ...chartFacts]);
  const context = contextOf(evidence, input.capabilities);
  const incomplete = input.operations.filter((operation) => operation.status !== "completed");
  const limitations = incomplete.map((operation) => `操作「${operation.id}」${operation.status === "unsupported" ? "不支持" : "未完成"}：${removeUnderlyingIdentity(operation.summary)}`);
  // 仅做 v4 结构与证据完整性校验；自由正文没有数字引用或语义复核门禁。
  return validatePlanAnswerV4({
    schema: "analysis-answer/v4", runId: input.runId, question: input.question, status: issues.length || incomplete.length ? "partial" : "answered", body,
    definitions: context.definitions, assumptions: unique([...context.assumptions, ...limitations, ...issues]),
    plan: input.operations.map((operation) => ({ ...operation, summary: removeUnderlyingIdentity(operation.summary) })), review: { notes: [] }, evidence,
  });
}
