// 图谱问答：用户在洞察页里针对整张图或选中的节点、连线提问，回答只依据图谱里已经算好的内容。
// 这里是纯函数：校验请求、把图谱和选中对象整理成依据材料、检查回答里的数字都出自依据。
import { influenceList, type InsightSelection } from "./highlight.ts";
import { INSIGHT_METRICS } from "./metrics.ts";
import { INSIGHT_DIMENSIONS, INSIGHT_GROUPS } from "./ontology.ts";
import { INSIGHT_DIMENSION_IDS, INSIGHT_SOURCE_LABEL, type InsightDimensionId, type InsightEdge, type InsightGraph, type InsightGroupId, type InsightNode, type InsightRequest, type InsightSourceKind } from "./types.ts";

export type InsightAskTurn = { role: "user" | "assistant"; text: string };
export type InsightAskRequest = { request: InsightRequest; selection: InsightSelection | null; question: string; history: InsightAskTurn[] };
export type InsightAskResult = { schema: "insight-answer/v1"; body: string; highlights: string[]; removed: number };

const SOURCE_KINDS: readonly InsightSourceKind[] = ["field", "derived", "inferred", "suggested", "grouping"];
const GROUP_IDS: readonly InsightGroupId[] = ["product", "param", "store", "time", "people"];
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function parseSelection(value: unknown): InsightSelection | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) throw new Error("选中对象格式不正确");
  const id = (v: unknown) => typeof v === "string" && v.length <= 80 ? v : null;
  if (value.kind === "metric") return { kind: "metric" };
  if (value.kind === "node" && id(value.id)) return { kind: "node", id: value.id as string };
  if (value.kind === "edge" && (INSIGHT_DIMENSION_IDS as readonly string[]).includes(value.dimension as string)) return { kind: "edge", dimension: value.dimension as InsightDimensionId };
  if (value.kind === "link" && GROUP_IDS.includes(value.group as InsightGroupId) && id(value.to)) return { kind: "link", group: value.group as InsightGroupId, to: value.to as string };
  if (value.kind === "source" && SOURCE_KINDS.includes(value.source as InsightSourceKind)) return { kind: "source", source: value.source as InsightSourceKind };
  throw new Error("选中对象格式不正确");
}

export function parseAskBody(value: unknown): Omit<InsightAskRequest, "request"> {
  if (!isObject(value)) throw new Error("请求格式不正确");
  const question = typeof value.question === "string" ? value.question.trim() : "";
  if (!question || question.length > 500) throw new Error("问题不能为空，最多 500 字");
  const history = Array.isArray(value.history) ? value.history.slice(-6).filter((t): t is InsightAskTurn => isObject(t) && (t.role === "user" || t.role === "assistant") && typeof t.text === "string").map((t) => ({ role: t.role, text: t.text.slice(0, 2000) })) : [];
  return { question, history, selection: parseSelection(value.selection) };
}

// 材料里的数字保留到有意义的位数：模型照抄，界面上不会出现十几位小数。
const round = (v: number | null) => v === null ? "—" : String(Number(v.toFixed(Math.abs(v) >= 100 ? 1 : 2)));
const pct = (v: number | null) => v === null ? "—" : String(Math.round(v * 100));
// 强度为空时写清原因（多半是被顶部筛选固定成了一个取值），不让模型对着「—」猜。
const strengthText = (e: InsightEdge, metric: InsightGraph["metric"]["id"]) => e.strength === null ? `算不出强度：${e.basis[0] ?? "可比较的取值不够"}`
  : `${pct(e.strength)}${e.weak ? "（弱）" : ""}${e.best ? `，${metric === "give_per_gram" ? "让利最少" : "表现最好"}的取值「${e.best}」` : ""}`;
const nodeLine = (n: InsightNode) => `${n.id}「${n.label}」（${INSIGHT_SOURCE_LABEL[n.source.kind]}${n.source.columns.length ? `，字段 ${n.source.columns.join("、")}` : ""}）`;

// 选中对象的中文说法，界面标签和依据材料共用。
export function selectionLabel(graph: InsightGraph, selection: InsightSelection | null): string {
  if (!selection || selection.kind === "metric") return `整张图（中心：${graph.metric.label}）`;
  if (selection.kind === "edge") return `连线：${INSIGHT_DIMENSIONS[selection.dimension].label} → ${graph.metric.label}`;
  if (selection.kind === "source") return `来源：${INSIGHT_SOURCE_LABEL[selection.source]}`;
  if (selection.kind === "link") {
    const target = selection.to === "center" ? graph.metric.label : graph.nodes.find((n) => n.id === selection.to)?.label ?? selection.to;
    return `连线：${INSIGHT_GROUPS[selection.group].label} → ${target}`;
  }
  return `节点：${graph.nodes.find((n) => n.id === selection.id)?.label ?? selection.id}`;
}

// 依据材料：图谱全局概况 + 选中对象的详情 + 可高亮的节点清单。数字只出自这里。
export function askContext(graph: InsightGraph, selection: InsightSelection | null): { text: string; nodeIds: string[] } {
  const m = graph.metric; const unit = m.unit;
  const lines: string[] = [];
  lines.push(`## 图谱范围\n货类 ${graph.request.category}，优惠 ${graph.request.offer}，对照 一般開單，2025 年 8 月。`);
  lines.push(`## 中心指标：${m.label}（${unit}）\n口径：${m.definition}\n活动 ${round(m.offer)}，一般開單 ${round(m.base)}，${m.id === "give_per_gram" ? "同日对齐的每克让利" : "差值"} ${round(m.delta)}`);
  const edges = [...graph.edges].sort((a, b) => (b.strength ?? 0) - (a.strength ?? 0));
  lines.push(`## 各维度和${m.label}的关系强度（0–100，20 以下算弱）\n${edges.map((e) => `- ${INSIGHT_DIMENSIONS[e.dimension].label}：${strengthText(e, m.id)}`).join("\n")}`);
  const missing = graph.nodes.filter((n) => n.kind === "missing");
  lines.push(`## 数据里没有、AI 补全的待采集项\n${missing.map((n) => `- ${n.label}：${n.note ?? ""}`).join("\n")}`);

  const detail: string[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgeDetail = (dim: InsightDimensionId) => {
    const e = graph.edges.find((x) => x.dimension === dim); const node = byId.get(`dim:${dim}`);
    if (node) detail.push(`维度 ${nodeLine(node)}${node.source.judgement ? `\nAI 判断：${node.source.judgement}` : ""}`);
    if (node?.facts.length) detail.push(`取值分布：${node.facts.map((f) => `${f.label} ${f.value}`).join("，")}`);
    if (e && e.strength === null) { detail.push(`和${m.label}的关系：算不出。${e.basis.join("；")}。这是因为顶部筛选已经固定了货类，不是数据缺失；想比较不同货类，要在顶部切换货类分别看。`); return; }
    if (e) {
      detail.push(`和${m.label}的关系强度：${strengthText(e, m.id)}`);
      detail.push(`依据：\n${e.basis.map((b) => `- ${b}`).join("\n")}`);
      detail.push(`异常：\n${e.anomalies.length ? e.anomalies.map((a) => `- ${a}`).join("\n") : "- 无"}`);
      if (e.recommendation) detail.push(`推荐：${e.recommendation}`);
      detail.push(`各取值（取值 | 活动 | 一般開單 | 比较值 | 活动行数 | 样本够不够）：\n${e.table.slice(0, 14).map((r) => `- ${r.value} | ${round(r.offer)} | ${round(r.base)} | ${round(r.delta)} | ${r.rows} | ${r.small ? "样本少，未参与比较" : "够"}`).join("\n")}`);
    }
    const inf = influenceList(graph, dim);
    if (inf.length) detail.push(`这个维度对各指标的影响强度（0–100）：${inf.map((x) => `${INSIGHT_METRICS[x.metric].label} ${pct(x.strength)}`).join("，")}`);
  };
  if (!selection || selection.kind === "metric") {
    detail.push(`实收拆成四段（活动 / 一般開單，占比是这段对差距的贡献）：\n${graph.decomposition.map((d) => `- ${d.label}：${round(d.offer)} / ${round(d.base)}，占比 ${d.share === null ? "—" : Math.round(d.share * 100)}%`).join("\n")}`);
    for (const e of edges.filter((x) => !x.weak).slice(0, 3)) { detail.push(`### ${INSIGHT_DIMENSIONS[e.dimension].label}`); edgeDetail(e.dimension); }
  } else if (selection.kind === "edge") edgeDetail(selection.dimension);
  else if (selection.kind === "source") {
    for (const n of graph.nodes.filter((x) => x.source.kind === selection.source && x.kind !== "group")) detail.push(`- ${nodeLine(n)}：${n.source.judgement ?? n.source.how}`);
  } else {
    const id = selection.kind === "link" ? (selection.to === "center" ? `group:${selection.group}` : selection.to) : selection.id;
    const node = byId.get(id);
    if (node?.id.startsWith("dim:")) edgeDetail(node.id.slice(4) as InsightDimensionId);
    else if (node?.kind === "group") {
      detail.push(`「${node.label}」是一组维度，本身不是数据；问这一组，就是问组里每个维度和${m.label}的关系。`);
      for (const child of graph.nodes.filter((n) => n.group === node.group && n.kind !== "group")) {
        detail.push(`### ${child.label}`);
        if (child.id.startsWith("dim:")) edgeDetail(child.id.slice(4) as InsightDimensionId);
        else detail.push(`${nodeLine(child)}：${child.note ?? "待采集"}${child.source.judgement ? `\nAI 判断：${child.source.judgement}` : ""}`);
      }
    } else if (node) {
      detail.push(`${nodeLine(node)}\n${node.note ?? ""}${node.source.judgement ? `\nAI 判断：${node.source.judgement}` : ""}`);
      if (node.affects) {
        detail.push(`AI 推测它会影响：维度 ${node.affects.dimensions.map((d) => INSIGHT_DIMENSIONS[d].label).join("、") || "—"}；指标 ${node.affects.metrics.map((x) => INSIGHT_METRICS[x as keyof typeof INSIGHT_METRICS]?.label ?? x).join("、") || "—"}`);
        // 待采集项本身没有数据；把它推测会影响的维度的现有数据带上，回答才能说「现在图上能看到什么、补上后能多看到什么」。
        if (node.kind === "missing") for (const dim of node.affects.dimensions) {
          detail.push(`### 现有数据：${INSIGHT_DIMENSIONS[dim].label}（它推测会影响的维度）`);
          edgeDetail(dim);
        }
      }
    }
  }
  lines.push(`## 用户选中的：${selectionLabel(graph, selection)}\n${detail.join("\n")}`);
  lines.push(`## 读图前要知道的\n${graph.limitations.map((l) => `- ${l}`).join("\n")}`);
  const nodeIds = graph.nodes.filter((n) => n.kind !== "metric").map((n) => n.id);
  lines.push(`## 可高亮的节点 id\n${graph.nodes.filter((n) => n.kind === "dimension" || n.kind === "missing" || n.kind === "group").map((n) => `${n.id}=${n.label}`).join("；")}`);
  return { text: lines.join("\n\n"), nodeIds };
}

// 数字核对：回答里的数字必须出现在依据材料或用户原话里；四舍五入到 0–2 位小数也算。不通过的句子删掉。
const NUMBER = /\d+(?:,\d{3})*(?:\.\d+)?/g;
function allowedNumbers(sources: readonly string[]): Set<string> {
  const allowed = new Set<string>();
  for (const text of sources) for (const raw of text.match(NUMBER) ?? []) {
    const value = Number(raw.replaceAll(",", "")); if (!Number.isFinite(value)) continue;
    for (const digits of [0, 1, 2]) allowed.add(String(Number(value.toFixed(digits))));
    allowed.add(String(value));
    // 比例按百分数说：0.36 → 36
    if (Math.abs(value) < 1) for (const digits of [0, 1]) allowed.add(String(Number((value * 100).toFixed(digits))));
  }
  return allowed;
}
export function checkAnswerNumbers(body: string, sources: readonly string[]): { body: string; removed: number } {
  const allowed = allowedNumbers(sources);
  // 模型偶尔吐出不成字的字节（U+FFFD），这种句子和编出来的数字一样整句删掉。
  const ok = (sentence: string) => !sentence.includes("\uFFFD") && (sentence.match(NUMBER) ?? []).every((raw) => allowed.has(String(Number(raw.replaceAll(",", "")))));
  let removed = 0;
  const kept = body.split("\n").map((line) => {
    const parts = line.match(/[^。！？；]+[。！？；]?/g) ?? [line];
    return parts.filter((sentence) => { const pass = ok(sentence); if (!pass) removed++; return pass; }).join("");
  });
  return { body: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

export function cleanHighlights(ids: unknown, nodeIds: readonly string[]): string[] {
  return Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === "string" && nodeIds.includes(id)))].slice(0, 8) : [];
}

// 选中对象本身对应的节点：组和维度是它自己，连线是两端里的维度或待采集项，来源筛选是这一类的全部节点。
export function selectionHighlights(graph: InsightGraph, selection: InsightSelection | null): string[] {
  if (!selection || selection.kind === "metric") return graph.edges.filter((e) => !e.weak).map((e) => `dim:${e.dimension}`).slice(0, 5);
  if (selection.kind === "edge") return [`dim:${selection.dimension}`];
  if (selection.kind === "node") return graph.nodes.some((n) => n.id === selection.id) ? [selection.id] : [];
  if (selection.kind === "link") return [selection.to === "center" ? `group:${selection.group}` : selection.to];
  return graph.nodes.filter((n) => n.source.kind === selection.source && n.kind !== "metric").map((n) => n.id).slice(0, 8);
}

// 待采集的数据库里也没有：回答里建议去智能问答查这些，等于把用户送去一个查不到的地方。
// 句子同时提到「智能问答」和待采集的说法时删掉，由界面固定的「去智能问答查更细的数据」入口兜底。
const UNCOLLECTED = /新客|复购|会员\s*ID|会员等级|门槛|封顶|叠加规则|客流|转化率|ROI|用券|核销/;
export function dropUncollectedReferrals(body: string): { body: string; removed: number } {
  let removed = 0;
  const kept = body.split("\n").filter((line) => {
    const bad = /智能问答/.test(line) && UNCOLLECTED.test(line);
    if (bad) removed++; return !bad;
  });
  return { body: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}
