// 图谱问答：用户在洞察页里针对整张图或选中的节点、连线提问，回答只依据图谱里已经算好的内容。
// 这里是纯函数：校验请求、把图谱和选中对象整理成依据材料、检查回答里的数字都出自依据。
import { selectionLabel } from "./context.ts";
import { edgeKey, findNode, routes, routesThrough, type InsightSelection } from "./paths.ts";
import { INSIGHT_EDGE_SOURCE, INSIGHT_NODE_IDS, INSIGHT_SOURCE_KINDS, INSIGHT_SOURCE_LABEL, INSIGHT_STRENGTH_LABEL, type InsightCard, type InsightEdge, type InsightGraph, type InsightNode, type InsightNodeId, type InsightSourceKind } from "./types.ts";

export type InsightAskTurn = { role: "user" | "assistant"; text: string };
export type InsightAskRequest = { selection: InsightSelection | null; question: string; history: InsightAskTurn[] };
export type InsightAskResult = { schema: "insight-answer/v2"; body: string; highlights: InsightNodeId[]; removed: number };

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isNode = (v: unknown): v is InsightNodeId => typeof v === "string" && (INSIGHT_NODE_IDS as readonly string[]).includes(v);

export function parseSelection(value: unknown): InsightSelection | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) throw new Error("选中对象格式不正确");
  if (value.kind === "node" && isNode(value.id)) return { kind: "node", id: value.id };
  if (value.kind === "edge" && isNode(value.from) && isNode(value.to)) return { kind: "edge", from: value.from, to: value.to };
  if (value.kind === "source" && INSIGHT_SOURCE_KINDS.includes(value.source as InsightSourceKind)) return { kind: "source", source: value.source as InsightSourceKind };
  throw new Error("选中对象格式不正确");
}

export function parseAskBody(value: unknown): InsightAskRequest {
  if (!isObject(value)) throw new Error("请求格式不正确");
  const question = typeof value.question === "string" ? value.question.trim() : "";
  if (!question || question.length > 500) throw new Error("问题不能为空，最多 500 字");
  const history = Array.isArray(value.history) ? value.history.slice(-6).filter((t): t is InsightAskTurn => isObject(t) && (t.role === "user" || t.role === "assistant") && typeof t.text === "string").map((t) => ({ role: t.role, text: t.text.slice(0, 2000) })) : [];
  return { question, history, selection: parseSelection(value.selection) };
}

const nodeName = (graph: InsightGraph, id: InsightNodeId) => findNode(graph, id)?.label ?? id;
const route = (graph: InsightGraph, path: InsightEdge[]) => path.length ? [nodeName(graph, path[0].from), ...path.map((e) => `（${INSIGHT_STRENGTH_LABEL[e.strength]}）→ ${nodeName(graph, e.to)}`)].join(" ") : "";
const sourceLine = (n: InsightNode) => `来源：${INSIGHT_SOURCE_LABEL[n.source.kind].name}${n.source.columns.length ? `；字段 ${n.source.columns.join("、")}` : ""}；怎么来：${n.source.how}${n.source.judgement ? `\nAI 的部分：${n.source.judgement}` : ""}`;
// 业务卡片：页面上用户看到的结论、要注意和 AI 建议。建议单独标出来，和支撑它的数据分开，问答时不能把建议当成数据。
const cardText = (c: InsightCard) => [
  `页面上的结论：${c.say.replace(/[【】]/g, "")}`, `怎么知道的：${c.how}`,
  ...(c.watch.length ? [`要注意：${c.watch.join("；")}`] : []),
  ...(c.stores ? [`点名的门店（${c.stores.title}）：${c.stores.rows.map((r) => `${r.name} ${r.value}${c.stores!.unit}`).join("，")}；同类店一般水平 ${c.stores.peer}${c.stores.unit}`] : []),
  c.todo ? `可以怎么做（AI 建议，不是数据）：${c.todo}` : `可以怎么做：没有建议（${c.todoNote ?? ""}）`,
  ...(c.todo && c.evidence.length ? [`支撑这条建议的数据：\n${c.evidence.map((x) => `- ${x}`).join("\n")}`] : []),
].join("\n");
const nodeDetail = (n: InsightNode) => [
  `${n.id}「${n.label}」：${n.subtitle}`, cardText(n.card), sourceLine(n), ...n.paragraphs,
  ...(n.table ? [`表：${n.table.head.join(" | ")}\n${n.table.rows.map((r) => `- ${r.join(" | ")}`).join("\n")}`] : []),
  ...(n.note ? [`注意：${n.note}`] : []),
].join("\n");
const strengthText = (e: InsightEdge) => e.score ? `解释度 ${e.score.value.toFixed(1)}/100，${INSIGHT_STRENGTH_LABEL[e.strength]}` : e.effect ? `${e.effect.text}，${INSIGHT_STRENGTH_LABEL[e.strength]}` : INSIGHT_STRENGTH_LABEL[e.strength];
const edgeLine = (graph: InsightGraph, e: InsightEdge) => `- ${nodeName(graph, e.from)} → ${nodeName(graph, e.to)}（${strengthText(e)}；${INSIGHT_EDGE_SOURCE[e.strength]}）：${e.basis}`;
// 选中线时展开三段和分数口径。
const edgeDetail = (graph: InsightGraph, e: InsightEdge) => [edgeLine(graph, e), cardText(e.card),
  ...(e.score ? [`解释度口径：${e.score.measure}`] : e.effect ? [`效应口径：${e.effect.measure}`] : []),
  ...(e.peers ? [`同类店对比：${e.peers.text}例：${e.peers.example.group}（${e.peers.example.n} 家），${e.peers.example.param}最高的 ${e.peers.example.k} 家 ${e.peers.example.hi.param}、${e.peers.example.outcome} ${e.peers.example.hi.outcome}；最低的 ${e.peers.example.k} 家 ${e.peers.example.lo.param}、${e.peers.example.outcome} ${e.peers.example.lo.outcome}。`] : []),
  `异常：${e.anomalies.length ? e.anomalies.join("；") : "无"}`, `推荐：${e.recommendation ?? `无（${e.noRecommendation ?? ""}）`}`,
  ...(e.peers?.laggards.length ? [`同类店里可以推一把的店：${e.peers.laggards.join("；")}`] : [])].join("\n");

// 依据材料：图谱概况 + 全部连线依据 + 选中对象的详情和链路 + 可高亮的节点清单。数字只出自这里。
export function askContext(graph: InsightGraph, selection: InsightSelection | null): string {
  const lines: string[] = [];
  lines.push(`## 图谱范围\n${graph.scope.period}全国销售明细 ${graph.scope.rows.toLocaleString("zh-CN")} 行、${graph.scope.stores.toLocaleString("zh-CN")} 家店；${graph.scope.note}。三个结果指标：${graph.kpis.map((k) => `${k.label} ${k.value}${k.unit}（${k.detail}）`).join("；")}。`);
  lines.push(`## 图上三句话结论\n${graph.summary.map((s) => `- ${s}`).join("\n")}`);
  lines.push(`## 所有连线（因素 → 结果）\n${graph.edges.map((e) => edgeLine(graph, e)).join("\n")}`);
  const detail: string[] = [];
  if (!selection) for (const n of graph.nodes.filter((x) => x.kind === "factor" || x.kind === "decomp")) detail.push(nodeDetail(n));
  else if (selection.kind === "source") for (const n of graph.nodes.filter((x) => x.source.kind === selection.source)) detail.push(`- ${n.label}：${n.source.judgement ?? n.source.how}`);
  else if (selection.kind === "node") {
    const n = findNode(graph, selection.id);
    if (n) {
      detail.push(nodeDetail(n));
      const down = routes(graph, n.id, "down"); const up = n.kind === "metric" ? routes(graph, n.id, "up") : [];
      if (down.length) detail.push(`怎么传到指标：\n${down.map((p) => `- ${route(graph, p)}`).join("\n")}`);
      if (up.length) detail.push(`从哪些因素传过来：\n${up.map((p) => `- ${route(graph, p)}`).join("\n")}`);
      for (const e of graph.edges.filter((x) => x.from === n.id || x.to === n.id)) { const other = findNode(graph, e.from === n.id ? e.to : e.from); if (other) detail.push(`### 相连的「${other.label}」\n${edgeDetail(graph, e)}\n${nodeDetail(other)}`); }
    }
  } else {
    const e = graph.edges.find((x) => edgeKey(x) === edgeKey(selection));
    if (e) {
      detail.push(edgeDetail(graph, e));
      for (const id of [e.from, e.to]) { const n = findNode(graph, id); if (n) detail.push(`### ${n.label}\n${nodeDetail(n)}`); }
      detail.push(`经过这条线的完整链路：\n${routesThrough(graph, e).map((p) => `- ${route(graph, p)}`).join("\n")}`);
    }
  }
  lines.push(`## 用户选中的：${selectionLabel(graph, selection)}\n${detail.join("\n\n")}`);
  lines.push(`## 读图前要知道的\n${graph.methods.map((m) => `- ${m.title}：${m.text}`).join("\n")}\n- 链路上每一段都是单独测的关联，不能把各段相乘当成效果。`);
  lines.push(`## 可高亮的节点 id\n${graph.nodes.map((n) => `${n.id}=${n.label}`).join("；")}`);
  return lines.join("\n\n");
}

// 数字核对：回答里的数字必须出现在依据材料或用户原话里；四舍五入到 0–2 位小数也算。不通过的句子删掉。
const NUMBER = /\d+(?:,\d{3})*(?:\.\d+)?/g;
function allowedNumbers(sources: readonly string[]): Set<string> {
  const allowed = new Set<string>();
  for (const text of sources) for (const raw of text.match(NUMBER) ?? []) {
    const value = Number(raw.replaceAll(",", "")); if (!Number.isFinite(value)) continue;
    for (const digits of [0, 1, 2]) allowed.add(String(Number(value.toFixed(digits))));
    allowed.add(String(value));
    if (Math.abs(value) < 1) for (const digits of [0, 1]) allowed.add(String(Number((value * 100).toFixed(digits))));
  }
  return allowed;
}
export function checkAnswerNumbers(body: string, sources: readonly string[]): { body: string; removed: number } {
  const allowed = allowedNumbers(sources);
  // 模型偶尔吐出不成字的字节（U+FFFD），这种句子和编出来的数字一样整句删掉。
  const ok = (sentence: string) => !sentence.includes("�") && (sentence.match(NUMBER) ?? []).every((raw) => allowed.has(String(Number(raw.replaceAll(",", "")))));
  let removed = 0;
  const kept = body.split("\n").map((line) => {
    const parts = line.match(/[^。！？；]+[。！？；]?/g) ?? [line];
    return parts.filter((sentence) => { const pass = ok(sentence); if (!pass) removed++; return pass; }).join("");
  });
  return { body: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

export function cleanHighlights(ids: unknown): InsightNodeId[] {
  return Array.isArray(ids) ? [...new Set(ids.filter(isNode))].slice(0, 8) : [];
}

// 选中对象本身对应的节点：节点是它自己，线是两端，来源是这一类节点，整张图是四个因素。
export function selectionHighlights(graph: InsightGraph, selection: InsightSelection | null): InsightNodeId[] {
  if (!selection) return graph.nodes.filter((n) => n.kind === "factor").map((n) => n.id);
  if (selection.kind === "node") return [selection.id];
  if (selection.kind === "edge") return [selection.from, selection.to];
  return graph.nodes.filter((n) => n.source.kind === selection.source).map((n) => n.id).slice(0, 8);
}

// 待采集的数据库里也没有：回答里建议去智能问答查这些，等于把用户送去一个查不到的地方。
// 句子同时提到「智能问答」和待采集的说法时删掉，由界面固定的「去智能问答查更细的数据」入口兜底。
const UNCOLLECTED = /新客|老客|新老会员|复购|会员\s*ID|会员等级|首购|金价|客流|转化率|ROI|用券|核销/;
export function dropUncollectedReferrals(body: string): { body: string; removed: number } {
  let removed = 0;
  const kept = body.split("\n").filter((line) => {
    const bad = /智能问答/.test(line) && UNCOLLECTED.test(line);
    if (bad) removed++; return !bad;
  });
  return { body: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}
