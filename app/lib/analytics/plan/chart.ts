import type { AnalysisFact } from "../analysis-v2-types.ts";
import type { NodeRow, PlanExecution } from "./execute.ts";
import { DEFAULT_MIN_ROWS, type PlanNode, type PlanScope } from "./types.ts";

// 计划图表的推导：v3 答案、v4 答案组装和正文 chart 块的预判共用一套逻辑。
// 只依赖执行结果和指标、维度的显示名；画不出来时返回原因（中文），供正文解析退回给模型。
export type ChartLabels = { metric(id: string): string; dimension(id: string): string };
// by：只画按这个维度分组的行；top：条形图最多几组（不超过 MAX_BARS）。都不给时按节点自身的分组画。
export type ChartOptions = { by?: string; top?: number };

export const MAX_BARS = 8;
const MAX_POINTS = 366;
const periodText = (scope: PlanScope) => `${scope.period.start}至${scope.period.end}`;

export type Point = { key: string; label: string; fact: AnalysisFact };
export type ChartPlan = { kind: "bar" | "line"; title: string; selectionLabel: string; points: Point[] };

export const keyText = (key: Record<string, string>) => Object.values(key).join(" · ");

// 对比窗口：目标期与参照期。
type ContrastNode = Extract<PlanNode, { op: "contrast" }>;
const windowKey = (node: ContrastNode) => `${periodText(node.target)}|${periodText(node.reference)}`;

// 对比节点的分层描述：对齐方式加窗口。
// 目标期与参照期相同，且同组里还有别的窗口，才算「同窗口」；孤零零的相同期仍按对齐方式叫。
function tierLabel(node: ContrastNode, windows: Set<string>, labels: ChartLabels): string {
  const controls = node.align?.controls ?? []; const common = node.align?.commonStores === true;
  const sameWindow = node.target.period.start === node.reference.period.start && node.target.period.end === node.reference.period.end && [...windows].some((key) => key !== windowKey(node));
  if (controls.includes("store") && controls.includes("day")) return "同店同日";
  if (controls.length) {
    const base = `${common ? "共同门店·" : ""}按${controls.map((id) => labels.dimension(id)).join("×")}`;
    return sameWindow ? `同窗口·${base}` : base;
  }
  if (common) return sameWindow ? "共同门店·同窗口" : "共同门店";
  return sameWindow ? "同窗口" : "全量";
}

const TIER_ORDER = ["全量", "共同门店", "同窗口", "共同门店·同窗口", "同店同日"];
const tierRank = (label: string) => {
  const index = TIER_ORDER.indexOf(label);
  return index >= 0 ? index : label.includes("按") ? TIER_ORDER.length : TIER_ORDER.length + 1;
};

export function planChart(execution: PlanExecution, labels: ChartLabels, nodeId: string, metric: string, options: ChartOptions = {}): ChartPlan | string {
  const result = execution.results.get(nodeId);
  if (!result) return `计划节点「${nodeId}」不存在`;
  if (result.status !== "completed") return `计划节点「${nodeId}」未完成，不能出图`;
  const { node } = result; const label = labels.metric(metric);
  const factsById = new Map(execution.evidence.facts.map((fact) => [fact.id, fact]));
  const factOf = (row: NodeRow) => factsById.get(row.factId);
  const { by } = options;
  const bars = Math.min(MAX_BARS, Math.max(1, options.top ?? MAX_BARS));
  if (bars < 2) return "图至少要 2 组，top 不能小于 2";
  const byText = !by ? "" : labels.dimension(by) === by ? `按${by}` : `按${labels.dimension(by)}（${by}）`;
  const tooFew = (count: number) => `节点「${nodeId}」${byText}的${label}分组样本不足，至少要 2 组（现在 ${count} 组）`;
  const onlyBy = (row: NodeRow) => { const names = Object.keys(row.key); return names.length === 1 && names[0] === by; };

  if (node.op === "drill" || node.op === "scan") {
    let rows = result.rows.filter((row) => row.metric === metric && row.role === "deviation" && Object.keys(row.key).length > 0);
    const depthOf = (row: NodeRow) => Object.keys(row.key).length;
    if (by) {
      // 指定维度时取这个维度第一次出现的那一层（下钻路径上的层级；扫描就是按这个维度的行）。
      rows = rows.filter((row) => by in row.key);
      if (!rows.length) return `节点「${nodeId}」没有${byText}分组的${label}偏离数据`;
      const depth = Math.min(...rows.map(depthOf)); rows = rows.filter((row) => depthOf(row) === depth);
    } else if (node.op === "drill" && rows.length) {
      // 下钻只取最深一层，免得父组与子组混在一张图里。
      const depth = Math.max(...rows.map(depthOf)); rows = rows.filter((row) => depthOf(row) === depth);
    }
    const minRows = node.minRows ?? DEFAULT_MIN_ROWS;
    const points = rows
      .filter((row) => row.sampleRows !== undefined && row.sampleRows >= minRows)
      .map((row) => ({ row, fact: factOf(row) }))
      .filter((item): item is { row: NodeRow; fact: AnalysisFact } => item.fact !== undefined && item.fact.value !== null)
      .sort((a, b) => Math.abs(b.fact.value!) - Math.abs(a.fact.value!)).slice(0, bars)
      .map(({ row, fact }): Point => ({
        key: JSON.stringify(row.key),
        // 扫描跨维度，类别带上维度名区分；下钻、或已指定维度时直接用取值。
        label: node.op === "scan" && !by && Object.keys(row.key).length === 1 ? `${labels.dimension(Object.keys(row.key)[0])}：${keyText(row.key)}` : keyText(row.key), fact,
      }));
    return points.length >= 2 ? { kind: "bar", title: `${label}偏离最大的分组`, selectionLabel: `按偏离幅度取前 ${points.length} 组`, points } : tooFew(points.length);
  }

  // 对比节点画的是不同对齐方式的分层图，不按维度分组；指定了维度就不画。
  if (node.op === "contrast" && by) return `节点「${nodeId}」是对比节点，不能按维度分组出图；要按维度画图请用下钻、扫描或分组统计节点`;
  if (node.op === "contrast") {
    const candidates: Array<{ node: ContrastNode; fact: AnalysisFact }> = [];
    for (const item of execution.results.values()) {
      if (item.node.op !== "contrast" || item.status !== "completed" || !item.node.metrics.includes(metric)) continue;
      const row = item.rows.find((entry) => entry.metric === metric && entry.role === "change" && Object.keys(entry.key).length === 0);
      const fact = row && factOf(row); if (!fact || fact.value === null) continue;
      candidates.push({ node: item.node, fact });
    }
    const windows = new Set(candidates.map((item) => windowKey(item.node)));
    const seen = new Set<string>(); const tiers: Array<Point & { rank: number }> = [];
    for (const { node: contrastNode, fact } of candidates) {
      const name = tierLabel(contrastNode, windows, labels);
      if (seen.has(name)) continue; seen.add(name);
      tiers.push({ key: contrastNode.id, label: name, fact, rank: tierRank(name) });
    }
    // 按分层排序，同层保持执行顺序（sort 稳定）。
    const points: Point[] = tiers.sort((a, b) => a.rank - b.rank).map((tier) => ({ key: tier.key, label: tier.label, fact: tier.fact }));
    return points.length >= 3 ? { kind: "bar", title: `${label}变化：不同对齐方式的对比`, selectionLabel: `${points.length} 种对齐方式`, points } : `节点「${nodeId}」是对比节点，只有 3 种以上对齐方式的对比时才能出分层图（现在 ${points.length} 种）`;
  }

  if (node.op !== "measure") return `节点「${nodeId}」是 ${node.op} 节点，不能出图`;
  if (!by && !node.by?.length) return `节点「${nodeId}」没有分组，画不出图；请在块里写 by 维度，或换成分组统计节点`;
  // 分组汇总（如各城市级别的每店实收）：按值从高到低画柱状图。
  if (by ? by !== "day" : !node.by?.includes("day")) {
    const grouped = result.rows.filter((row) => row.metric === metric && row.role === "value" && (by ? onlyBy(row) : Object.keys(row.key).length > 0));
    if (!grouped.length) return `节点「${nodeId}」没有恰好${byText}分组的${label}数据`;
    const points = grouped
      .map((row) => ({ row, fact: factOf(row) }))
      .filter((item): item is { row: NodeRow; fact: AnalysisFact } => item.fact !== undefined && item.fact.value !== null)
      .sort((a, b) => b.fact.value! - a.fact.value!).slice(0, bars)
      .map(({ row, fact }): Point => ({ key: JSON.stringify(row.key), label: keyText(row.key), fact }));
    return points.length >= 2 ? { kind: "bar", title: `各${(by ? [by] : node.by ?? []).map((id) => labels.dimension(id)).join("、")}的${label}`, selectionLabel: `按${label}从高到低取前 ${points.length} 组`, points } : tooFew(points.length);
  }

  {
    const points = result.rows
      .filter((row) => row.metric === metric && row.role === "value" && Object.keys(row.key).length === 1 && row.key.day !== undefined)
      .map((row) => ({ row, fact: factOf(row) }))
      .filter((item): item is { row: NodeRow; fact: AnalysisFact } => item.fact !== undefined)
      .sort((a, b) => a.row.key.day.localeCompare(b.row.key.day)).slice(0, MAX_POINTS)
      .map(({ row, fact }): Point => ({ key: row.key.day, label: row.key.day, fact }));
    return points.length >= 2 ? { kind: "line", title: `${label}逐日走势`, selectionLabel: `${points.length} 个日期`, points } : `节点「${nodeId}」按日期的${label}不足 2 天，画不出走势图`;
  }
}

