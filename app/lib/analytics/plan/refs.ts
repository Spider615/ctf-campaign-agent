import type { AnalysisFact } from "../analysis-v2-types.ts";
import { TOTAL_ACROSS_WINDOWS, defaultRole, digitGuard, formatRoleValue, nodeLiterals, periodLiterals, sameKey, totalAcrossWindows } from "./bind.ts";
import { planChart } from "./chart.ts";
import type { NodeResult, NodeRole, NodeRow, PlanExecution } from "./execute.ts";

// 自由正文的引用解析：模型写 Markdown，数字一律写成 {{节点.指标.角色|维度=值}}，由代码从执行结果填值。
// 引用解析不了、或者句子里写死了算出来的数字，整句删掉并记一条 issue。
export type RefSpan = { start: number; end: number; factIds: string[] };
export type BodyBlock =
  | { kind: "markdown"; text: string; refs: RefSpan[] }
  | { kind: "table"; title: string; columns: string[]; rows: Array<{ cells: string[]; factIds: string[] }> }
  | { kind: "chart"; node: string; metric: string; by?: string; top: number };
export type RefIssue = { text: string; reason: string };
export type ResolvedBody = { blocks: BodyBlock[]; issues: RefIssue[]; factIds: string[]; keyFigure?: { value: string; factId: string } };
export type BodyLabels = { metric(id: string): string; dimension(id: string): string };

const MAX_BODY = 1200;
const MAX_TABLES = 3;
const MAX_CHARTS = 2;
const DEFAULT_TOP = 6;
const MAX_TOP = 8;
const ROLES: readonly NodeRole[] = ["value", "target", "reference", "delta", "change", "deviation", "share", "contribution"];
// 引用里分组取值可以写成带引号的 "…"，引号内允许花括号、逗号、竖线等，引号用 \" 转义。
export const REF = /\{\{((?:"(?:[^"\\]|\\.)*"|[^{}"])*)\}\}/g;
// 句末标点连同紧跟的右引号、右括号算一句；行尾没有标点的部分也算一句。
const SENTENCE = /[^。！？!?]*[。！？!?]+[」”’）)]*|[^。！？!?]+$/g;
const SENTENCE_END = /[。！？!?][」”’）)]*|\n/g;
// Markdown 行首标记（列表、标题、引用）不参与数字检查，整行被删光时一起删。
// 与 app/lib/markdown.ts 的列表写法一致：有序列表接受「1.」「1)」「1、」，「1、」后面可以不空格。
const LINE_PREFIX = /^\s*(?:(?:[-*+•]|\d+[.)])\s+|\d+、\s*|#{1,6}\s+|>\s?)*/;
const BLOCK_LINE = /^\s*:::\s*(table|chart)\b(.*)$/;

export type Piece = { text: string; factIds?: string[] };
export type Ref = { node: string; metric: string; role?: string; select: Record<string, string> };

// 「节点.指标[.角色][|维度=值,维度=值]」；指标本身可能带点（如 amount.quantity_contribution），角色只认最后一段。
// 取值含逗号、竖线、等号、引号、花括号或首尾空白时写成 "…"（引号内的 " 写成 \"），其余照写。
export function quoteRefValue(value: string): string {
  return /[,，|="{}]/.test(value) || value !== value.trim() ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

// 分组部分：「维度=取值」用 , 或 ， 分隔；取值可以是 "…"（引号内原样，\" 和 \\ 转义）。
function parseSelect(text: string): Record<string, string> | undefined {
  const select: Record<string, string> = {}; let at = 0;
  while (at < text.length) {
    const eq = text.indexOf("=", at); if (eq < 0) return undefined;
    const name = text.slice(at, eq).trim(); if (!name || /[,，"]/.test(name)) return undefined;
    let cursor = eq + 1; while (text[cursor] === " ") cursor += 1;
    let value: string;
    if (text[cursor] === '"') {
      value = ""; cursor += 1;
      while (cursor < text.length && text[cursor] !== '"') { if (text[cursor] === "\\" && cursor + 1 < text.length) cursor += 1; value += text[cursor]; cursor += 1; }
      if (text[cursor] !== '"') return undefined;
      cursor += 1; while (text[cursor] === " ") cursor += 1;
      if (cursor < text.length && !/[,，]/.test(text[cursor])) return undefined;
    } else {
      const end = text.slice(cursor).search(/[,，]/); const stop = end < 0 ? text.length : cursor + end;
      value = text.slice(cursor, stop).trim(); cursor = stop;
      if (value.includes('"')) return undefined;
    }
    if (!value) return undefined;
    select[name] = value;
    at = cursor < text.length ? cursor + 1 : cursor;
  }
  return select;
}

export function parseRef(inner: string): Ref | string {
  // 节点、指标、角色里没有竖线，第一个竖线就是分组的开始；分组取值里的竖线要放在引号里。
  const bar = inner.indexOf("|");
  const head = (bar < 0 ? inner : inner.slice(0, bar)).trim(); const selectText = bar < 0 ? "" : inner.slice(bar + 1).trim();
  const parts = head.split(".").map((part) => part.trim());
  if (parts.length < 2 || parts.some((part) => !part)) return `引用格式不对：{{${inner}}}，应写成 {{节点.指标}} 或 {{节点.指标.角色|维度=值}}`;
  const last = parts[parts.length - 1];
  const role = parts.length >= 3 && (ROLES as readonly string[]).includes(last) ? last : undefined;
  const metric = parts.slice(1, role ? -1 : undefined).join(".");
  const select = selectText ? parseSelect(selectText) : {};
  if (!select) return `引用格式不对：{{${inner}}} 的分组应写成「维度=取值」，取值含逗号、竖线、等号时写成 维度="取值"`;
  return { node: parts[0], metric, ...(role ? { role } : {}), select };
}

const factOf = (execution: PlanExecution, id: string): AnalysisFact | undefined => execution.evidence.facts.find((item) => item.id === id);
// 下钻、扫描沿用所指对比的范围，「两段时间不同不能比合计」同样适用。
const scopeNodeOf = (result: NodeResult, execution: PlanExecution) => "of" in result.node ? execution.results.get(result.node.of)?.node ?? result.node : result.node;

function nodeIssue(id: string, execution: PlanExecution): string | NodeResult {
  const result = execution.results.get(id);
  if (!result) return `计划节点「${id}」不存在`;
  if (result.status !== "completed") return `计划节点「${id}」未完成（${result.status === "unsupported" ? "不支持" : "失败"}）`;
  return result;
}

// 复核步骤也用它列出每个引用填进去的值。
export function resolveRef(inner: string, execution: PlanExecution): Piece | string {
  const ref = parseRef(inner); if (typeof ref === "string") return ref;
  const result = nodeIssue(ref.node, execution); if (typeof result === "string") return result;
  if (!result.rows.some((row) => row.metric === ref.metric)) return missingMetric(ref.node, ref.metric, result.rows);
  const role = (ref.role ?? defaultRole(result)) as NodeRole;
  const candidates = result.rows.filter((row) => row.metric === ref.metric && row.role === role);
  if (!candidates.length) return `节点「${ref.node}」的指标 ${ref.metric} 没有角色 ${role} 的数据`;
  if (totalAcrossWindows(scopeNodeOf(result, execution), ref.metric, role)) return TOTAL_ACROSS_WINDOWS;
  const scopeText = Object.keys(ref.select).length ? `分组 ${JSON.stringify(ref.select)}` : "总体";
  const exact = candidates.filter((row) => sameKey(row, ref.select));
  if (exact.length > 1) return `分组不唯一：节点「${ref.node}」有多行匹配（指标 ${ref.metric}，角色 ${role}，${scopeText}）`;
  if (!exact.length) {
    // 只写了部分维度（或没写分组而节点只有分组行）：能匹配多行，提示补全。
    const partial = candidates.filter((row) => Object.entries(ref.select).every(([name, value]) => row.key[name] === value));
    if (partial.length) return `分组不唯一，请补全分组条件（节点「${ref.node}」，指标 ${ref.metric}，${scopeText}；可用维度 ${[...new Set(partial.flatMap((row) => Object.keys(row.key)))].join("、")}）`;
    return `找不到对应分组：节点「${ref.node}」没有匹配的数据行（指标 ${ref.metric}，角色 ${role}，${scopeText}）`;
  }
  const fact = factOf(execution, exact[0].factId);
  if (!fact) return `节点「${ref.node}」的数据行缺少事实 ${exact[0].factId}`;
  if (fact.value === null) return `引用 {{${inner}}} 暂无可计算值`;
  return { text: formatRoleValue(fact, role), factIds: [fact.id] };
}

// 替换值的单位（最后一个数字之后的部分）紧跟着又写了一遍时，一律去掉紧跟的那一个，不看后面接什么。
// 「442个个活动」「510,750条条明细」是常见写法，必须去重；代价是「30单单均」也会变成「30单均」。
export function dropRepeatedUnit(rendered: string, after: string): string {
  const unit = rendered.match(/\d([^\d]*)$/)?.[1] ?? "";
  if (!unit) return after;
  // 「{{x}} 个活动期次」：引用和单位之间隔着空格时同样去重，空格一并去掉。
  const spaced = after.match(/^\s+/)?.[0] ?? "";
  return after.slice(spaced.length).startsWith(unit) ? after.slice(spaced.length + unit.length) : after;
}

// 指标找不到时列出这个节点有哪些指标；把角色（value、delta…）写在指标位置是常见错误，单独提示。
const ROLE_NAMES = ["value", "target", "reference", "delta", "change", "deviation", "share", "contribution"];
export function missingMetric(node: string, metric: string, rows: readonly { metric: string }[]): string {
  const available = [...new Set(rows.map((row) => row.metric))].slice(0, 8).join("、");
  const hint = ROLE_NAMES.includes(metric) ? `；${metric} 是角色不是指标，块里只写指标名` : "";
  return `节点「${node}」没有指标 ${metric}${hint}，可用指标：${available}`;
}

const digitsReason = (items: string[]) => `正文不能直接写算出来的数字：${items.slice(0, 4).map((item) => `「${item}」`).join("")}不能直接写；请用引用 {{节点.指标}}，或改成「最高」「多数」这类文字`;

// 一句话：先查写死的数字，再逐个替换引用；任何一处失败整句删掉。
// 方向词紧挨在带正负号的引用前面时（「高 -20%」「下降 +50%」），字面意思和数值就是反的。
// 只看引用前几个字里最后出现的方向词，「变化」「比……」这类中性说法不判。
const UP_WORDS = ["高", "高出", "高于", "增长", "增加", "上升", "上涨", "多", "提升", "领先"];
const DOWN_WORDS = ["低", "低于", "下降", "减少", "下滑", "回落", "少", "落后", "跌"];
function directionConflict(before: string, rendered: string): string | undefined {
  const sign = /^[+]/.test(rendered) ? 1 : /^-/.test(rendered) ? -1 : 0; if (!sign) return undefined;
  // 「下降了 -50%」：去掉词尾的「了」再判断。
  const tail = before.replace(/\s+$/, "").replace(/了$/, "");
  // 「最高」「最多」「降幅最高」「偏离最多」是排名或幅度说法，不表示正负方向。
  if (/最[高低多少]$|幅[度]?[高低]$/.test(tail)) return undefined;
  const word = [...UP_WORDS, ...DOWN_WORDS].filter((item) => tail.endsWith(item)).sort((a, b) => b.length - a.length)[0];
  if (!word) return undefined;
  const up = UP_WORDS.includes(word);
  if (up === sign > 0) return undefined;
  return `「${word}」后面的值是 ${rendered}，正负和字面意思相反；请改成和正负一致的说法，或用「变化」「比……」这类中性说法`;
}

function resolveSentence(raw: string, execution: PlanExecution, forbidden: (text: string) => string[]): Piece[] | string {
  const stripped = raw.replace(REF, " ");
  // 引号没闭合时整段引用不会被识别，留下的是 {{…，要单独提示，不要误报成单层花括号。
  if (/\{\{[^{}]*"/.test(stripped)) return "引用里的取值引号没有闭合：带逗号等分隔符的取值写成 维度=\"取值\"，前后两个引号都要写";
  if (/[{}]/.test(stripped)) return "引用要用两层花括号写成 {{节点.指标}}，单层花括号不会被填值";
  const digits = forbidden(stripped); if (digits.length) return digitsReason(digits);
  const pieces: Piece[] = []; let last = 0;
  for (const match of raw.matchAll(REF)) {
    const resolved = resolveRef(match[1], execution); if (typeof resolved === "string") return resolved;
    const conflict = directionConflict(raw.slice(Math.max(0, match.index - 6), match.index), resolved.text);
    if (conflict) return conflict;
    pieces.push({ text: raw.slice(last, match.index) }, resolved);
    last = match.index + match[0].length;
  }
  pieces.push({ text: raw.slice(last) });
  // 模型常在引用后再写一遍单位（「{{x}}条」），填值后去掉紧跟着的重复单位；只改引用后面的文字，引用位置不变。
  for (let index = 1; index < pieces.length; index += 2) pieces[index + 1] = { text: dropRepeatedUnit(pieces[index].text, pieces[index + 1].text) };
  return pieces.filter((piece) => piece.text || piece.factIds);
}

// 断句时先把引用遮住：带引号的取值里可能有句号、问号。
function sentencesOf(content: string): string[] {
  const masked = content.replace(REF, (match) => "x".repeat(match.length));
  return [...masked.matchAll(SENTENCE)].map((match) => content.slice(match.index, match.index + match[0].length));
}

const trimStart = (pieces: Piece[]) => { if (pieces[0] && !pieces[0].factIds) pieces[0] = { text: pieces[0].text.trimStart() }; return pieces; };
const trimEnd = (pieces: Piece[]) => { const at = pieces.length - 1; if (pieces[at] && !pieces[at].factIds) pieces[at] = { text: pieces[at].text.trimEnd() }; return pieces; };
const textOf = (pieces: Piece[]) => pieces.map((piece) => piece.text).join("");

function resolveMarkdown(lines: string[], execution: PlanExecution, forbidden: (text: string) => string[], issues: RefIssue[]): Extract<BodyBlock, { kind: "markdown" }> | undefined {
  // null 表示整行被删掉；空数组是原本的空行。
  const heading = (line: string) => /^\s*#{1,6}\s/.test(line);
  const out: Array<Piece[] | null> = lines.map((line) => {
    const prefix = line.match(LINE_PREFIX)?.[0] ?? "";
    const content = line.slice(prefix.length);
    if (!content.trim()) return prefix.trim() ? [{ text: line }] : [];
    const kept: Piece[][] = []; let dropped = false;
    for (const sentence of sentencesOf(content)) {
      const resolved = resolveSentence(sentence, execution, forbidden);
      if (typeof resolved === "string") { issues.push({ text: sentence.trim(), reason: resolved }); dropped = true; continue; }
      kept.push(resolved);
    }
    if (!dropped) return [{ text: prefix }, ...kept.flat()].filter((piece) => piece.text);
    if (!kept.length) return null;
    // 删句后收拢空白：句首、句尾不留空白，相邻两句之间最多留原来的一处空白。
    const joined: Piece[] = [];
    kept.forEach((pieces, index) => {
      const copy = [...pieces];
      // 和前一句之间的空白收成最多一个空格。
      if (index === 0 || /\s$/.test(textOf(joined))) trimStart(copy);
      else if (copy[0] && !copy[0].factIds && /^\s/.test(copy[0].text)) copy[0] = { text: copy[0].text.replace(/^\s+/, " ") };
      if (index === kept.length - 1) trimEnd(copy);
      joined.push(...copy);
    });
    return [{ text: prefix }, ...joined].filter((piece) => piece.text);
  });
  // 标题下面的段落被删光时，标题一起删，不留孤立标题。
  for (let index = 0; index < lines.length; index += 1) {
    if (!heading(lines[index]) || out[index] === null) continue;
    let end = index + 1; while (end < lines.length && !heading(lines[end])) end += 1;
    const section = out.slice(index + 1, end);
    if (section.some((line) => line === null) && section.every((line) => line === null || !textOf(line).trim())) out[index] = null;
  }
  // 去掉被删光的行，连续空行收成一行，块首尾不留空行。
  const rows: Piece[][] = [];
  for (const line of out) {
    if (line === null) continue;
    const empty = !textOf(line).trim();
    if (empty && (!rows.length || !textOf(rows[rows.length - 1]).trim())) continue;
    rows.push(empty ? [] : line);
  }
  while (rows.length && !textOf(rows[rows.length - 1]).trim()) rows.pop();
  if (!rows.length) return undefined;
  let text = ""; const refs: RefSpan[] = [];
  rows.forEach((line, index) => {
    if (index) text += "\n";
    for (const piece of line) {
      if (piece.factIds) refs.push({ start: text.length, end: text.length + piece.text.length, factIds: piece.factIds });
      text += piece.text;
    }
  });
  return { kind: "markdown", text, refs };
}

// 「节点 指标[,指标] [by 维度] [top N]」
function parseBlockArgs(rest: string): { node: string; metrics: string[]; by?: string; top: number } | string {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const [node, metricText] = tokens;
  if (!node || !metricText || ["by", "top"].includes(metricText)) return "块语法不对：应写成「::: table 节点 指标[,指标] [by 维度] [top N]」";
  let by: string | undefined; let top = DEFAULT_TOP;
  for (let index = 2; index < tokens.length; index += 2) {
    const word = tokens[index]; const value = tokens[index + 1];
    if (word === "by" && value) by = value;
    else if (word === "top" && value && /^\d+$/.test(value)) top = Math.min(MAX_TOP, Math.max(1, Number(value)));
    else return `块语法不对：无法识别「${tokens.slice(index).join(" ")}」`;
  }
  return { node, metrics: metricText.split(/[,，]/).map((item) => item.trim()).filter(Boolean), ...(by ? { by } : {}), top };
}

function resolveTable(rest: string, execution: PlanExecution, labels: BodyLabels): Extract<BodyBlock, { kind: "table" }> | string {
  const args = parseBlockArgs(rest); if (typeof args === "string") return args;
  const result = nodeIssue(args.node, execution); if (typeof result === "string") return result;
  const contrast = result.node.op === "contrast";
  // 对比表只取第一个指标，其余指标忽略。
  const metrics = contrast ? args.metrics.slice(0, 1) : args.metrics;
  const missing = metrics.find((metric) => !result.rows.some((row) => row.metric === metric));
  if (missing) return missingMetric(args.node, missing, result.rows);
  const roles: NodeRole[] = contrast ? ["target", "reference", "delta"] : [defaultRole(result)];
  const scopeNode = scopeNodeOf(result, execution);
  for (const metric of metrics) for (const role of roles) if (totalAcrossWindows(scopeNode, metric, role)) return TOTAL_ACROSS_WINDOWS;
  // 有 by 只取恰好按这一个维度分组的行，没有 by 只取总体行。
  const groupOf = (row: NodeRow) => { const names = Object.keys(row.key); return args.by ? names.length === 1 && names[0] === args.by : names.length === 0; };
  const rowFor = (key: Record<string, string>, metric: string, role: NodeRole) => result.rows.find((row) => row.metric === metric && row.role === role && sameKey(row, key));
  const sortRole: NodeRole = contrast ? "delta" : roles[0];
  const keys = new Map<string, Record<string, string>>();
  for (const row of result.rows) if (row.metric === metrics[0] && row.role === sortRole && groupOf(row)) keys.set(JSON.stringify(row.key), row.key);
  if (!keys.size) return `节点「${args.node}」没有${args.by ? `按 ${args.by} 分组` : "总体"}的 ${metrics[0]} 数据`;
  const valueOf = (key: Record<string, string>) => { const row = rowFor(key, metrics[0], sortRole); return row ? factOf(execution, row.factId)?.value ?? null : null; };
  // 按第一个指标降序；空值排最后。
  const ordered = [...keys.values()].sort((a, b) => (valueOf(b) ?? -Infinity) - (valueOf(a) ?? -Infinity)).slice(0, args.top);
  const cell = (key: Record<string, string>, metric: string, role: NodeRole): { text: string; factIds: string[] } => {
    const row = rowFor(key, metric, role); const fact = row && factOf(execution, row.factId);
    return fact ? { text: formatRoleValue(fact, role), factIds: [fact.id] } : { text: "—", factIds: [] };
  };
  const rows = ordered.map((key) => {
    const name = args.by ? key[args.by] : "总体";
    const cells = contrast ? roles.map((role) => cell(key, metrics[0], role)) : metrics.map((metric) => cell(key, metric, roles[0]));
    // 对比表的「变化」列：差额后面附上变化率。
    if (contrast) { const change = cell(key, metrics[0], "change"); if (change.factIds.length) cells[2] = { text: `${cells[2].text}（${change.text}）`, factIds: [...cells[2].factIds, ...change.factIds] }; }
    return { cells: [name, ...cells.map((item) => item.text)], factIds: [...new Set(cells.flatMap((item) => item.factIds))] };
  });
  const metricText = metrics.map((metric) => labels.metric(metric)).join("、");
  const first = args.by ? labels.dimension(args.by) : "分组";
  return {
    kind: "table",
    title: args.by ? `各${labels.dimension(args.by)}的${metricText}` : `${metricText}对比`,
    columns: contrast ? ["分组", "目标", "参照", "变化"] : [first, ...metrics.map((metric) => labels.metric(metric))],
    rows,
  };
}

function resolveChart(rest: string, execution: PlanExecution, labels: BodyLabels): Extract<BodyBlock, { kind: "chart" }> | string {
  const args = parseBlockArgs(rest); if (typeof args === "string") return args.replace("table", "chart");
  const result = nodeIssue(args.node, execution); if (typeof result === "string") return result;
  if (args.metrics.length !== 1) return "图只能画一个指标";
  if (!result.rows.some((row) => row.metric === args.metrics[0])) return missingMetric(args.node, args.metrics[0], result.rows);
  // 用答案组装同一套图表推导预判能不能画，画不出就退回给模型改，免得正文写了「如下图」却没有图。
  const plan = planChart(execution, labels, args.node, args.metrics[0], { ...(args.by ? { by: args.by } : {}), top: args.top });
  if (typeof plan === "string") return plan;
  return { kind: "chart", node: args.node, metric: args.metrics[0], ...(args.by ? { by: args.by } : {}), top: args.top };
}

// 在不超过 budget 的最后一个句末处截断。
// 找不到句末时在 budget 处硬截；截断点不落在引用替换后的数字中间。
function cutAt(text: string, budget: number, refs: RefSpan[]): number {
  let cut = 0;
  for (const match of text.matchAll(SENTENCE_END)) { const end = match.index + (match[0] === "\n" ? 0 : match[0].length); if (end > budget) break; cut = end; }
  if (cut > 0) return cut;
  cut = Math.max(0, budget);
  const inside = refs.find((ref) => ref.start < cut && cut < ref.end);
  return inside ? inside.start : cut;
}

// literals：问题原文和用户此前说过的话；维度取值和计划筛选值从执行结果里自动收集。
export function resolveBody(body: string, execution: PlanExecution, literals: readonly string[], labels: BodyLabels): ResolvedBody {
  const names = [...execution.results.values()].flatMap((result) => [...result.rows.flatMap((row) => Object.values(row.key)), ...nodeLiterals(result.node)]);
  // 计划范围里的日期展开成「2025年8月」这类说法，和原话里的日期一样允许照写。
  const dates = [...execution.results.values()].flatMap((result) => nodeLiterals(result.node)).filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item));
  const forbidden = digitGuard([...literals, ...periodLiterals(dates)], names);
  const issues: RefIssue[] = [];
  let blocks: BodyBlock[] = [];
  let pending: string[] = [];
  let tables = 0; let charts = 0;
  const flush = () => { if (pending.length) { const block = resolveMarkdown(pending, execution, forbidden, issues); if (block) blocks.push(block); } pending = []; };
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const match = line.match(BLOCK_LINE);
    if (!match) { pending.push(line); continue; }
    flush();
    const text = line.trim();
    if (match[1] === "table") {
      if (tables >= MAX_TABLES) { issues.push({ text, reason: `表格最多 ${MAX_TABLES} 个` }); continue; }
      const table = resolveTable(match[2], execution, labels);
      if (typeof table === "string") issues.push({ text, reason: table }); else { blocks.push(table); tables += 1; }
    } else {
      if (charts >= MAX_CHARTS) { issues.push({ text, reason: `图最多 ${MAX_CHARTS} 个` }); continue; }
      const chart = resolveChart(match[2], execution, labels);
      if (typeof chart === "string") issues.push({ text, reason: chart }); else { blocks.push(chart); charts += 1; }
    }
  }
  flush();

  // 正文长度按替换后的 Markdown 文字计；超出时在最后一个完整句子处截断，后面的块一并去掉。
  let used = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]; if (block.kind !== "markdown") continue;
    if (used + block.text.length <= MAX_BODY) { used += block.text.length; continue; }
    const cut = cutAt(block.text, MAX_BODY - used, block.refs);
    const text = block.text.slice(0, cut).trimEnd();
    issues.push({ text: block.text.slice(cut).trim().slice(0, 40), reason: "正文过长，已截断" });
    const kept: BodyBlock[] = text ? [{ kind: "markdown", text, refs: block.refs.filter((ref) => ref.end <= text.length) }] : [];
    blocks = [...blocks.slice(0, index), ...kept];
    break;
  }

  const factIds = [...new Set(blocks.flatMap((block) => block.kind === "markdown" ? block.refs.flatMap((ref) => ref.factIds) : block.kind === "table" ? block.rows.flatMap((row) => row.factIds) : []))];
  // 重点数字：第一个 Markdown 块的第一段恰好只有一个引用时，放大显示它。
  let keyFigure: ResolvedBody["keyFigure"];
  const first = blocks.find((block): block is Extract<BodyBlock, { kind: "markdown" }> => block.kind === "markdown");
  if (first) {
    const blank = first.text.search(/\n\s*\n/); const end = blank < 0 ? first.text.length : blank;
    const inside = first.refs.filter((ref) => ref.start < end);
    if (inside.length === 1) keyFigure = { value: first.text.slice(inside[0].start, inside[0].end), factId: inside[0].factIds[0] };
  }
  return { blocks, issues, factIds, ...(keyFigure ? { keyFigure } : {}) };
}
