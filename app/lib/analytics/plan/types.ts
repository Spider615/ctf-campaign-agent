// 声明式分析计划：节点只能使用语义层登记的维度、指标与筛选，由代码校验和执行。
export type PlanScope = { period: { start: string; end: string }; population: "sales" | "net" | "returns" | "recovery" | "zero_sales"; filters: Record<string, string[]> };
export type PlanNode =
  | { id: string; op: "measure"; scope: PlanScope; metrics: string[]; by?: string[] }
  | { id: string; op: "contrast"; target: PlanScope; reference: PlanScope; metrics: string[]; by?: string[]; align?: { commonStores?: boolean; controls?: string[] } }
  | { id: string; op: "decompose"; of: string }
  | { id: string; op: "drill"; of: string; path: string[]; minRows?: number }
  | { id: string; op: "scan"; of: string; dimensions?: string[]; minRows?: number; top?: number }
  | { id: string; op: "robust"; of: string; checks: Array<"largest_store" | "largest_order" | "halves" | "alternative_window">; alternative?: { start: string; end: string } }
  | { id: string; op: "scenario"; of: string; adjustment: { kind: "per_gram" | "per_item" | "per_order"; amount: string } | { kind: "amount_rate"; rate: string } | { kind: "order_threshold"; threshold: string; amount: string }; netVolumeChanges: string[]; reason: string };
export type AnalysisPlan = { question: string; nodes: PlanNode[] };
export type PlanIssue = { node?: string; field?: string; message: string };
export type PlanValidation = { valid: PlanNode[]; dropped: Array<{ node: PlanNode; issues: PlanIssue[] }>; issues: PlanIssue[] };

// 下钻、扫描分组的最小样本行数默认值：图表和结论摘要都只用达到它的分组。
export const DEFAULT_MIN_ROWS = 200;
