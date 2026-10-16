import { normalizeDate } from "./import.ts";
import { TurnCancelledError, throwIfTurnCancelled } from "../cancellation.ts";
import { sealOwnedAnalysisOperation } from "./analysis-v2-evidence.ts";
import { ANALYSIS_DIMENSIONS, ANALYSIS_METHODS, ANALYSIS_METRICS } from "./analysis-v2-types.ts";
import type { AnalysisAggregateCell, AnalysisAggregateQuery, AnalysisCapabilities, AnalysisConstraints, AnalysisDataSession, AnalysisDimension, AnalysisFact, AnalysisFilters, AnalysisFrame, AnalysisMetric, AnalysisMetricDefinition, AnalysisObject, AnalysisOperationRequest, AnalysisOperationResult, AnalysisScope, FactExpression } from "./analysis-v2-types.ts";
import type { Period } from "./types.ts";

const populations = ["sales", "net", "recovery", "returns", "zero_sales"] as const;
export const ANALYSIS_FILTER_DIMENSIONS: Record<keyof AnalysisFilters, AnalysisDimension> = { stores: "store", regions: "region", districts: "district", categories: "category", materials: "material", offers: "offer", memberFlags: "memberFlag", storeTypes: "storeType", skus: "sku", memberSegments: "memberSegment" };
const labels: Record<AnalysisMetric, string> = { amount: "实收金额", quantity: "件数", grams: "克重", profit: "毛利", orders: "当前筛选内订单数", stores: "观察门店数", rows: "明细行数", tag_amount: "牌仔价合计", amount_per_order: "订单成交部分均额", amount_per_gram: "每克实收代理值", gap_per_gram: "每克牌价实收差额" };
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const uniq = <T>(values: T[]) => [...new Set(values)];
const ordered = <T extends string>(values: T[]) => uniq(values).sort();
// 本轮引用使用短而精确的身份；缓存复用原身份，注册表仍拒绝冲突与模糊引用。
const analysisId = (kind: string) => `${kind}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
export const analysisSessionExpired = (message = "分析快照已失效，请重新打开并重算证据") => Object.assign(new Error(message), { code: "ANALYSIS_SESSION_EXPIRED" });
export const analysisArgumentsInvalid = (message: string) => Object.assign(new Error(message), { code: "ANALYSIS_ARGUMENTS_INVALID" });
export function analysisMoneyCents(value: number): number {
  if (!Number.isFinite(value)) throw new Error("金额不是有效数字");
  const result = Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(result)) throw new Error("金额超出按分计算范围");
  return result;
}
export function analysisMetricDefinitions(currency: string, available: AnalysisMetric[], mode: "database" | "snapshot"): AnalysisMetricDefinition[] {
  return available.map((id) => ({ id, label: id === "profit" && mode === "database" ? "源字段零售毛利" : labels[id], unit: id === "quantity" ? "件" : id === "grams" ? "克" : id === "orders" ? "单" : id === "stores" ? "家" : id === "rows" ? "条" : id.endsWith("per_gram") ? `${currency}/克` : id === "amount_per_order" ? `${currency}/单` : currency,
    grain: id === "orders" || id === "amount_per_order" ? "selected_order" : "line", additive: !["orders", "stores", "amount_per_order", "amount_per_gram", "gap_per_gram"].includes(id), allowedPopulations: id.includes("per_") ? ["sales"] : [...populations], requiredControls: id.endsWith("per_gram") ? ["category", "material"] : [],
    definition: id === "profit" ? mode === "database" ? "直接汇总源字段零售毛利；不从成本、税率或实收反推毛利率" : "逐行实收减导入成本，金额均按分；不是数据库源字段零售毛利，不能直接比较二者" : id === "orders" ? "门店与销售单号组合去重；只覆盖当前筛选内成交部分，缺任一标识则整体订单数缺失" : id === "stores" ? "选定记录中有店号的观察门店；不是门店营业状态或正式同店定义" : id === "amount_per_order" ? "销售正金额总额除以当前筛选内复合订单数；不是整张订单客单价" : id === "amount_per_gram" ? "销售正金额总额除以克重；须同货类同材料比较，不等于每日金价或活动力度" : id === "gap_per_gram" ? "牌仔价减实收后的差额除以克重；须同货类同材料比较，不等于完整活动优惠" : id === "amount" || id === "tag_amount" ? "金额逐行四舍五入为分后汇总；任一参与行缺失则缺失，不补零" : `${labels[id]}直接来自选定记录；缺失不补零` }));
}
export function normalizeAnalysisPeriod(period: unknown): Period {
  if (!isObject(period) || Object.keys(period).some((key) => !["start", "end"].includes(key)) || typeof period.start !== "string" || typeof period.end !== "string") throw new Error("请提供有效分析日期范围");
  const value = { start: normalizeDate(period.start), end: normalizeDate(period.end) };
  if (value.start > value.end) throw new Error("分析日期范围不正确");
  return value;
}
export function normalizeAnalysisFilters(value: unknown): AnalysisFilters {
  if (!isObject(value)) throw new Error("分析筛选格式不正确");
  const result: AnalysisFilters = {};
  for (const key of Object.keys(value).sort()) {
    const items = value[key];
    if (!Object.hasOwn(ANALYSIS_FILTER_DIMENSIONS, key) || !Array.isArray(items) || items.length > 100 || items.some((v) => typeof v !== "string" || !v.trim() || v.length > 120)) throw new Error("分析筛选含不支持的字段或取值");
    if (items.length) result[key as keyof AnalysisFilters] = ordered(items as string[]);
  }
  return result;
}
export function normalizeAnalysisScope(input: unknown, capabilities: AnalysisCapabilities, constraints: AnalysisConstraints = { filters: {} }): AnalysisScope {
  if (!isObject(input) || Object.keys(input).some((key) => !["period", "population", "filters"].includes(key)) || !populations.includes(input.population as typeof populations[number])) throw new Error("分析范围或人口口径不正确");
  const period = normalizeAnalysisPeriod(input.period);
  if (period.start < capabilities.coverage.start || period.end > capabilities.coverage.end) throw new Error("分析周期超出数据覆盖范围");
  if (constraints.period && (period.start < constraints.period.start || period.end > constraints.period.end)) throw new Error("分析周期超出用户授权硬范围");
  const filters = normalizeAnalysisFilters(input.filters ?? {}); const hard = normalizeAnalysisFilters(constraints.filters);
  for (const [key, allowed] of Object.entries(hard)) {
    const selected = filters[key as keyof AnalysisFilters];
    if (selected && selected.some((v) => !allowed!.includes(v))) throw new Error("分析筛选超出用户授权硬范围");
    filters[key as keyof AnalysisFilters] = selected ?? allowed;
  }
  return { period, population: input.population as AnalysisScope["population"], filters: normalizeAnalysisFilters(filters) };
}
export function normalizeAnalysisAggregateQuery(query: AnalysisAggregateQuery, capabilities: AnalysisCapabilities): AnalysisAggregateQuery {
  if (!isObject(query) || Object.keys(query).some((key) => !["scope", "by", "metrics", "excludeStores", "excludeOrders"].includes(key)) || !Array.isArray(query.by) || query.by.some((v) => v !== "order" && !capabilities.dimensions.includes(v))) throw new Error("聚合包含不可用维度或字段");
  if (query.metrics !== undefined && (!Array.isArray(query.metrics) || !query.metrics.length || query.metrics.some((metric) => !capabilities.metrics.some((item) => item.id === metric)))) throw new Error("聚合包含不可用指标");
  if (query.by.includes("order") && !capabilities.metrics.some((v) => v.id === "orders")) throw new Error("当前数据缺少复合订单能力");
  const scope = normalizeAnalysisScope(query.scope, capabilities);
  for (const key of Object.keys(scope.filters) as Array<keyof AnalysisFilters>) if (!capabilities.dimensions.includes(ANALYSIS_FILTER_DIMENSIONS[key])) throw new Error("当前数据缺少筛选所需字段");
  const excluded = (values: unknown) => {
    if (values === undefined) return undefined;
    if (!Array.isArray(values) || values.some((v) => typeof v !== "string" || !v || v.length > 500)) throw new Error("分析排除对象格式不正确");
    return ordered(values as string[]);
  };
  return { scope, by: ordered(query.by), ...(query.metrics ? { metrics: ordered(query.metrics) } : {}), ...(query.excludeStores ? { excludeStores: excluded(query.excludeStores) } : {}), ...(query.excludeOrders ? { excludeOrders: excluded(query.excludeOrders) } : {}) };
}

function sum(cells: AnalysisAggregateCell[], metric: AnalysisMetric): number | null {
  if (metric === "rows") return cells.reduce((value, cell) => value + cell.rows, 0);
  if (!cells.length) return null;
  if (metric === "stores" || metric === "orders") {
    if (metric === "orders" && cells.every((cell) => cell.orderIds)) {
      const ids = new Set<string>();
      for (const cell of cells) for (const id of cell.orderIds!) { if (id === null) return null; ids.add(id); }
      return ids.size;
    }
    const dimension = metric === "stores" ? "store" : "order";
    if (cells.every((cell) => Object.hasOwn(cell.dimensions, dimension))) {
      const ids = cells.map((cell) => cell.dimensions[dimension]);
      if (metric === "orders" && ids.some((id) => !id)) return null;
      return new Set(ids.filter((id) => Boolean(id))).size;
    }
    if (cells.length === 1) return cells[0][metric];
    return null;
  }
  if (metric === "amount_per_order" || metric.endsWith("per_gram")) {
    const denominator = sum(cells, metric === "amount_per_order" ? "orders" : "grams"); const amount = sum(cells, "amount"); const tag = metric === "gap_per_gram" ? sum(cells, "tag_amount") : 0;
    return denominator === null || denominator <= 0 || amount === null || tag === null ? null : (metric === "gap_per_gram" ? tag - amount : amount) / denominator;
  }
  const values = cells.map((cell) => cell[metric as "amount" | "quantity" | "grams" | "profit" | "tag_amount"]);
  if (values.some((v) => v === null || !Number.isFinite(v))) return null;
  const money = ["amount", "profit", "tag_amount"].includes(metric);
  const total = values.reduce<number>((value, n) => value + (money ? analysisMoneyCents(n!) : n!), 0);
  if (!Number.isFinite(total) || Math.abs(total) > Number.MAX_SAFE_INTEGER) throw new Error("聚合指标超出安全计算范围");
  return money ? total / 100 : total;
}
const keyOf = (cell: AnalysisAggregateCell, dimensions: AnalysisDimension[]) => JSON.stringify(dimensions.map((dimension) => cell.dimensions[dimension] ?? null));
function groups(cells: AnalysisAggregateCell[], dimensions: AnalysisDimension[]): Map<string, AnalysisAggregateCell[]> {
  const result = new Map<string, AnalysisAggregateCell[]>();
  for (const cell of cells) { const key = keyOf(cell, dimensions); const list = result.get(key) ?? []; list.push(cell); result.set(key, list); }
  return result;
}

const additiveFields = ["amount", "quantity", "grams", "profit", "tag_amount"] as const;
type AdditiveField = typeof additiveFields[number];
type ControlTotals = { dimensions: AnalysisAggregateCell["dimensions"]; rows: number; totals: Record<AdditiveField, number>; missing: Record<AdditiveField, number>; missingOrders: number; orders: number; floatingRest: Record<"quantity" | "grams", number> };
function emptyControlTotals(cell: AnalysisAggregateCell, controls: AnalysisDimension[]): ControlTotals {
  return { dimensions: Object.fromEntries(controls.map((dimension) => [dimension, cell.dimensions[dimension]])), rows: 0, totals: { amount: 0, quantity: 0, grams: 0, profit: 0, tag_amount: 0 }, missing: { amount: 0, quantity: 0, grams: 0, profit: 0, tag_amount: 0 }, missingOrders: 0, orders: 0, floatingRest: { quantity: 0, grams: 0 } };
}
// 同期每个子组只读一次完整订单集合。其余组按控制层的充分统计量重算，不能把父订单数减去子订单数。
async function controlledComplements(children: Map<string, AnalysisAggregateCell[]>, controls: AnalysisDimension[], fields: AdditiveField[], checkpoint: () => Promise<void>) {
  const parent = new Map<string, ControlTotals & { owners: Map<string, string | null>; exclusive: Map<string, number>; children: ControlTotals[] }>();
  const childTotals = new Map<string, Map<string, ControlTotals>>();
  let work = 0; let parentRows = 0;
  for (const [childKey, cells] of children) {
    const strata = new Map<string, ControlTotals>(); childTotals.set(childKey, strata);
    for (const [controlKey, members] of groups(cells, controls)) {
      const child = emptyControlTotals(members[0], controls); strata.set(controlKey, child);
      const total = parent.get(controlKey) ?? { ...emptyControlTotals(members[0], controls), owners: new Map<string, string | null>(), exclusive: new Map<string, number>(), children: [] }; parent.set(controlKey, total); total.children.push(child);
      const orders = new Set<string>();
      for (const cell of members) {
        child.rows += cell.rows;
        for (const field of fields) {
          const value = cell[field];
          if (value === null || !Number.isFinite(value)) child.missing[field]++;
          else child.totals[field] += ["amount", "profit", "tag_amount"].includes(field) ? analysisMoneyCents(value) : value;
        }
        // 原逐单适配器与紧凑订单集合使用同一身份；缺标识仍是缺失，不能当作一笔订单。
        const identities = cell.orderIds ?? (Object.hasOwn(cell.dimensions, "order") ? [cell.dimensions.order || null] : [null]);
        for (const id of identities) {
          if (id === null) child.missingOrders++;
          else orders.add(id);
          if (++work % 16384 === 0) await checkpoint();
        }
      }
      child.orders = orders.size; total.rows += child.rows; parentRows += child.rows; total.missingOrders += child.missingOrders;
      for (const field of fields) { total.totals[field] += child.totals[field]; total.missing[field] += child.missing[field]; }
      for (const id of orders) {
        if (!total.owners.has(id)) total.owners.set(id, childKey);
        else if (total.owners.get(id) !== childKey) total.owners.set(id, null);
        if (++work % 16384 === 0) await checkpoint();
      }
      if (++work % 128 === 0) await checkpoint();
    }
  }
  for (const total of parent.values()) {
    total.orders = total.owners.size;
    for (const owner of total.owners.values()) {
      if (owner !== null) total.exclusive.set(owner, (total.exclusive.get(owner) ?? 0) + 1);
      if (++work % 16384 === 0) await checkpoint();
    }
    // 留下精确去重总数及各子组独占单数，释放大集合；生成其余组时无需再遍历单号。
    total.owners.clear();
    // 克重与数量不是整数分。用前后缀直接相加，避免移除大组时把其余小正分母相消成零。
    for (const field of ["quantity", "grams"] as const) if (fields.includes(field)) {
      const suffix = new Array<number>(total.children.length + 1).fill(0);
      for (let index = total.children.length - 1; index >= 0; index--) suffix[index] = suffix[index + 1] + total.children[index].totals[field];
      let prefix = 0;
      for (let index = 0; index < total.children.length; index++) {
        const child = total.children[index]; child.floatingRest[field] = prefix + suffix[index + 1]; prefix += child.totals[field];
        if (++work % 16384 === 0) await checkpoint();
      }
    }
    total.children = [];
  }
  const materialize = (total: ControlTotals, removed?: ControlTotals, exclusiveOrders = 0): AnalysisAggregateCell => {
    const values = Object.fromEntries(additiveFields.map((field) => {
      if (!fields.includes(field)) return [field, null];
      const missing = total.missing[field] - (removed?.missing[field] ?? 0);
      const value = removed && (field === "quantity" || field === "grams") ? removed.floatingRest[field] : total.totals[field] - (removed?.totals[field] ?? 0);
      if (!missing && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) throw new Error("聚合指标超出安全计算范围");
      return [field, missing ? null : ["amount", "profit", "tag_amount"].includes(field) ? value / 100 : value];
    })) as Pick<AnalysisAggregateCell, AdditiveField>;
    return { dimensions: total.dimensions, rows: total.rows - (removed?.rows ?? 0), ...values, orders: total.missingOrders - (removed?.missingOrders ?? 0) ? null : total.orders - exclusiveOrders, stores: null };
  };
  return (childKey: string) => {
    const strata = childTotals.get(childKey)!; const target: AnalysisAggregateCell[] = []; const reference: AnalysisAggregateCell[] = []; let childRows = 0;
    for (const [controlKey, child] of strata) {
      childRows += child.rows; target.push(materialize(child)); const total = parent.get(controlKey)!;
      // 不同控制组合原本不参与该子组的标准化；保留原参照总行数，完整报告排除量。
      if (total.rows > child.rows) reference.push(materialize(total, child, total.exclusive.get(childKey) ?? 0));
    }
    return { target, reference, originalRows: [childRows, parentRows - childRows] };
  };
}
const ref = (fact: AnalysisFact): FactExpression => ({ factId: fact.id });
const constant = (value: number): FactExpression => ({ constant: value });
const expression = (op: "add" | "subtract" | "multiply" | "divide", ...args: FactExpression[]): FactExpression => ({ op, args });

export function createAnalysisOperations(session: AnalysisDataSession, constraints: AnalysisConstraints) {
  const cache = new Map<string, Promise<AnalysisOperationResult>>();
  const completedAggregates = new Map<string, Array<{ metrics: AnalysisMetric[]; result: AnalysisOperationResult }>>();
  const normalize = (input: AnalysisOperationRequest): AnalysisOperationRequest => {
    const keys = ["needIds", "purpose", "method", "scope", "metrics", "by", "reference", "controls", "commonStores", "breakdown", "check", "alternative"];
    if (!isObject(input) || Object.keys(input).some((key) => !keys.includes(key)) || !ANALYSIS_METHODS.includes(input.method) || !Array.isArray(input.needIds) || !input.needIds.length || input.needIds.some((v) => typeof v !== "string" || !v || v.length > 120) || typeof input.purpose !== "string" || !input.purpose.trim() || input.purpose.length > 1000 || !Array.isArray(input.metrics) || !input.metrics.length || input.metrics.some((v) => !ANALYSIS_METRICS.includes(v))) throw new Error("分析操作参数或关联事项不正确");
    for (const values of [input.by, input.controls]) if (values !== undefined && (!Array.isArray(values) || values.some((v) => !ANALYSIS_DIMENSIONS.includes(v)))) throw new Error("分析操作维度不正确");
    if (input.breakdown !== undefined && !ANALYSIS_DIMENSIONS.includes(input.breakdown) || input.check !== undefined && !["largest_store", "largest_order", "order_distribution", "alternative_window"].includes(input.check) || input.commonStores !== undefined && typeof input.commonStores !== "boolean") throw new Error("分析方法参数不正确");
    if ((input.method === "compare" || input.method === "decompose") && !input.reference) throw analysisArgumentsInvalid("请补充 reference 参照范围，再执行对照或变化拆解");
    if (input.method === "scan" && !input.breakdown && !input.by?.length) throw analysisArgumentsInvalid("请在 by 提供完整分组维度，或在 breakdown 提供子分组维度，再执行扫描");
    if (input.method === "robustness" && !input.check) throw analysisArgumentsInvalid("请提供 check 检查类型，再执行稳健性检查");
    if (input.method === "robustness" && input.check === "alternative_window" && !input.alternative) throw analysisArgumentsInvalid("请补充 alternative 替代窗口日期，再执行窗口检查");
    const result: AnalysisOperationRequest = { ...input, scope: normalizeAnalysisScope(input.scope, session.capabilities, constraints), metrics: ordered(input.metrics), by: ordered(input.by ?? []), controls: ordered(input.controls ?? []) };
    if (input.reference) result.reference = normalizeAnalysisScope(input.reference, session.capabilities, constraints);
    if (input.alternative) { const scope = normalizeAnalysisScope({ ...result.scope, period: input.alternative }, session.capabilities, constraints); result.alternative = scope.period; }
    if (result.method === "robustness" && ["largest_order", "order_distribution"].includes(result.check ?? "") && session.capabilities.methods.includes("robustness") && session.capabilities.metrics.some((metric) => metric.id === "orders") && (result.scope.population !== "sales" || result.reference && result.reference.population !== "sales")) throw analysisArgumentsInvalid("订单成交部分检查按定义只接受 sales；请保留原问题的净销售或退货口径，改用该口径适用的指标或拆解。只有另行核对销售成交部分时，才单列目标与参照均为 sales 的检查，不能用它替代原净销售结论");
    return result;
  };
  async function perform(request: AnalysisOperationRequest, signal?: AbortSignal): Promise<AnalysisOperationResult> {
    const operationId = analysisId("o"); const controls = ordered([...(request.controls ?? []), ...(request.commonStores ? ["store" as const] : [])]);
    const result: AnalysisOperationResult = { operationId, status: "completed", method: request.method, needIds: request.needIds, purpose: request.purpose, frames: [], facts: [], objects: [], methods: [], limitations: [] };
    const factIndex = new Map<string, AnalysisFact>(); const objectIndex = new Map<string, string>(); const objectsById = new Map<string, AnalysisObject>();
    const checkpoint = async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); throwIfTurnCancelled(signal); session.assertActive?.(); };
    const method = { id: analysisId("m"), operationId, status: "completed" as "completed" | "unsupported", method: request.method, frameIds: [] as string[], controls, checks: [] as Array<{ name: string; status: "performed" | "unavailable"; result: string }>, sampleRows: 0, groupCount: 0, limitations: [] as string[] };
    result.methods.push(method);
    const check = (name: string, description: string, performed = true) => method.checks.push({ name, status: performed ? "performed" : "unavailable", result: description });
    const limit = (description: string) => { result.limitations.push(description); method.limitations.push(description); };
    const unsupported = (description: string) => { result.status = "unsupported"; method.status = "unsupported"; limit(description); check("方法适用性", description, false); return result; };
    if (!session.capabilities.methods.includes(request.method)) return unsupported("当前数据适配器没有声明该分析方法，未执行计算");
    const definitions = new Map(session.capabilities.metrics.map((metric) => [metric.id, metric]));
    const unavailable = request.metrics.find((metric) => !definitions.has(metric));
    if (unavailable) return unsupported(`当前数据没有 ${labels[unavailable]} 所需字段`);
    const dimensions = ordered([...(request.by ?? []), ...controls, ...(request.breakdown ? [request.breakdown] : [])]);
    const missing = dimensions.find((dimension) => !session.capabilities.dimensions.includes(dimension));
    if (missing) return unsupported(`当前数据缺少 ${missing} 控制或分组字段，未执行该方法`);
    const requiredControlFields = ordered(request.metrics.flatMap((metric) => definitions.get(metric)!.requiredControls));
    const missingRequiredControl = requiredControlFields.find((dimension) => !session.capabilities.dimensions.includes(dimension));
    if (missingRequiredControl) return unsupported(`当前数据缺少指标所需的 ${missingRequiredControl} 控制字段，不能通过补调用参数取得该字段`);
    for (const scope of [request.scope, request.reference].filter(Boolean) as AnalysisScope[]) {
      const missingFilter = (Object.keys(scope.filters) as Array<keyof AnalysisFilters>).find((key) => !session.capabilities.dimensions.includes(ANALYSIS_FILTER_DIMENSIONS[key]));
      if (missingFilter) return unsupported(`当前数据缺少 ${missingFilter} 筛选字段`);
      const wrongPopulation = request.metrics.find((metric) => !definitions.get(metric)!.allowedPopulations.includes(scope.population));
      if (wrongPopulation) throw analysisArgumentsInvalid(`${labels[wrongPopulation]}按登记定义只适用于 ${definitions.get(wrongPopulation)!.allowedPopulations.join("、")}，不适用于 ${scope.population}。请保留原用户口径，改选该口径支持的指标或用销售退货 decompose 拆解；另行列出销售成交部分时必须说明范围不同，不能用销售替代净销售`);
    }
    for (const metric of request.metrics) for (const dimension of definitions.get(metric)!.requiredControls) {
      const filter = (Object.keys(ANALYSIS_FILTER_DIMENSIONS) as Array<keyof AnalysisFilters>).find((key) => ANALYSIS_FILTER_DIMENSIONS[key] === dimension);
      const groupedAggregate = request.method === "aggregate" && request.by?.includes(dimension);
      if (!request.controls?.includes(dimension) && !groupedAggregate && !(filter && request.scope.filters[filter]?.length === 1 && (!request.reference || request.reference.filters[filter]?.length === 1 && request.reference.filters[filter]![0] === request.scope.filters[filter]![0]))) throw analysisArgumentsInvalid(`${labels[metric]}的 ${dimension} 字段可用，但调用缺少实际比较控制。请补充 controls，或在原授权业务范围内明确相同的单值筛选；by 分组不能代替总体控制，不能擅自解除原范围`);
    }
    if (request.reference && request.reference.population !== request.scope.population) throw analysisArgumentsInvalid("目标与 reference 参照人口口径不同，不能按同定义直接比较。请保留原问题的业务口径和范围约束，使两边采用相同定义；若要区分销售与退货贡献，请在两边净销售范围内使用 decompose，不把销售总额替代净销售");
    const grain: AnalysisFrame["grain"] = request.metrics.some((v) => ["orders", "amount_per_order"].includes(v)) || ["largest_order", "order_distribution"].includes(request.check ?? "") ? "selected_order" : "group";
    const frame = (scope: AnalysisScope, description: string): AnalysisFrame => {
      const item: AnalysisFrame = { id: analysisId("d"), snapshotId: session.snapshotId, datasetVersion: session.datasetVersion, mode: session.capabilities.mode, provenance: session.capabilities.provenance, scope: structuredClone(scope), currency: session.capabilities.currency, grain, controls, limitations: [...session.capabilities.limitations, description].filter(Boolean) };
      result.frames.push(item); method.frameIds.push(item.id); return item;
    };
    const objectsFor = (f: AnalysisFrame, cells: AnalysisAggregateCell[], by = request.by ?? []): string[] => by.map((dimension) => {
      const value = cells[0]?.dimensions[dimension]; const key = JSON.stringify([f.id, dimension, value ?? ""]); const existing = objectIndex.get(key);
      if (existing) return existing;
      const item = { id: analysisId("x"), frameId: f.id, dimension, value: value ?? "", label: value ?? "未提供" }; result.objects.push(item); objectIndex.set(key, item.id); objectsById.set(item.id, item); return item.id;
    });
    const valueOf = (item: FactExpression): number | null => {
      if ("constant" in item) return item.constant;
      if ("factId" in item) return factIndex.get(item.factId)?.value ?? null;
      const args = item.args.map(valueOf); if (args.some((v) => v === null)) return null;
      const values = args as number[]; const value = item.op === "add" ? values.reduce((a, b) => a + b, 0) : item.op === "subtract" ? values.slice(1).reduce((a, b) => a - b, values[0]) : item.op === "multiply" ? values.reduce((a, b) => a * b, 1) : values.slice(1).some((v) => v === 0) ? null : values.slice(1).reduce((a, b) => a / b, values[0]);
      return value === null || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER ? null : value;
    };
    const add = (f: AnalysisFrame, metricId: string, label: string, value: number | null, unit: string, objectIds: string[] = [], derivation?: FactExpression, definition?: string): AnalysisFact => {
      const item: AnalysisFact = { id: analysisId("f"), frameId: f.id, metricId, label, value, unit, definition: definition ?? definitions.get(metricId)?.definition ?? label, objectIds, operationId, limitations: value === null ? ["参与数据缺失、范围为空或分母无效；未补零"] : [], ...(derivation ? { derivation } : {}) };
      result.facts.push(item); factIndex.set(item.id, item); return item;
    };
    const fixedControls = (f: AnalysisFrame) => (Object.keys(ANALYSIS_FILTER_DIMENSIONS) as Array<keyof AnalysisFilters>).filter((key) => f.scope.filters[key]?.length === 1 && (!request.reference || request.scope.filters[key]?.length === 1 && request.reference.filters[key]?.length === 1 && request.scope.filters[key]![0] === request.reference.filters[key]![0])).map((key) => ANALYSIS_FILTER_DIMENSIONS[key]);
    const ratioContext = (f: AnalysisFrame, cells: AnalysisAggregateCell[], metric: AnalysisMetric) => {
      const fixed = fixedControls(f);
      const candidate = ordered([...(definitions.get(metric)?.requiredControls ?? []), ...(request.controls ?? []), ...fixed]);
      const values: Partial<Record<AnalysisDimension, string>> = {};
      for (const dimension of candidate) {
        const filter = (Object.keys(ANALYSIS_FILTER_DIMENSIONS) as Array<keyof AnalysisFilters>).find((key) => ANALYSIS_FILTER_DIMENSIONS[key] === dimension);
        const actual = cells.map((cell) => cell.dimensions[dimension] ?? (filter && f.scope.filters[filter]?.length === 1 ? f.scope.filters[filter]![0] : undefined));
        if (!actual.length || actual.some((value) => value === undefined || !value.trim()) || new Set(actual).size !== 1) return { role: "descriptive" as const, controls: [] as AnalysisDimension[], values: {} };
        values[dimension] = actual[0];
      }
      return candidate.length ? { role: "within_stratum" as const, controls: candidate, values } : { role: "descriptive" as const, controls: [] as AnalysisDimension[], values: {} };
    };
    const setComparison = (fact: AnalysisFact, role: NonNullable<AnalysisFact["comparisonRole"]>, actualControls: AnalysisDimension[], actualValues?: AnalysisFact["comparisonValues"]) => {
      fact.comparisonRole = role; fact.comparisonControls = actualControls;
      if (role === "within_stratum" && actualValues) fact.comparisonValues = { ...actualValues };
      if (role === "descriptive") { fact.definition += "；总体未调整比率，仅描述观察结构，不作为逐层或标准化比较"; fact.limitations.push("总体比率包含层间数量结构变化，不能借整体方法的控制记录当成已调整比较"); }
      return fact;
    };
    const base = (f: AnalysisFrame, cells: AnalysisAggregateCell[], metric: AnalysisMetric, label: string, objectIds: string[] = []): AnalysisFact => {
      if (metric.includes("per_")) {
        const a = base(f, cells, "amount", `${label}分子实收`, objectIds); const denominator = base(f, cells, metric === "amount_per_order" ? "orders" : "grams", `${label}分母`, objectIds);
        const numerator = metric === "gap_per_gram" ? expression("subtract", ref(base(f, cells, "tag_amount", `${label}分子牌价`, objectIds)), ref(a)) : ref(a);
        const derivation = expression("divide", numerator, ref(denominator)); const context = ratioContext(f, cells, metric);
        return setComparison(add(f, metric, `${label} · ${labels[metric]}`, denominator.value !== null && denominator.value > 0 ? valueOf(derivation) : null, definitions.get(metric)!.unit, objectIds, derivation), context.role, context.controls, context.values);
      }
      return add(f, metric, `${label} · ${labels[metric]}`, sum(cells, metric), definitions.get(metric)!.unit, objectIds);
    };
    const derived = (f: AnalysisFrame, metric: string, label: string, derivation: FactExpression, unit: string, ids: string[] = [], definition?: string) => add(f, metric, label, valueOf(derivation), unit, ids, derivation, definition);
    const readMetrics = ordered([...request.metrics,
      ...(request.method === "decompose" ? ["amount" as const, request.metrics.includes("grams") ? "grams" as const : "quantity" as const] : []),
      ...(request.method === "robustness" && ["largest_order", "largest_store"].includes(request.check ?? "") ? ["amount" as const] : []),
      ...(request.controls?.length ? request.metrics.filter((metric) => metric === "amount" || metric.includes("per_")).flatMap((metric): AnalysisMetric[] => ["amount", metric === "amount_per_order" ? "orders" : metric.endsWith("per_gram") || request.metrics.includes("grams") ? "grams" : "quantity"]) : []),
    ]);
    const load = async (scope: AnalysisScope, by: Array<AnalysisDimension | "order"> = [], excludeStores?: string[], excludeOrders?: string[], metrics?: AnalysisMetric[]) => {
      throwIfTurnCancelled(signal); session.assertActive?.();
      const query: AnalysisAggregateQuery = { scope, by: ordered(by), metrics: metrics ?? readMetrics, ...(excludeStores ? { excludeStores } : {}), ...(excludeOrders ? { excludeOrders } : {}) };
      // 跨层求订单数仍保留完整订单集合；集合身份经适配器核验后，只传分组总值，不传每单的一整行指标。
      const independentGroups = request.method === "aggregate" || request.method === "scan" && !request.reference && !request.controls?.length && !query.by.includes("order");
      const wantsOrderIds = !independentGroups && (query.by.includes("order") || query.by.length && query.metrics!.some((metric) => ["orders", "amount_per_order"].includes(metric)));
      // 原生集合包含完整店号与单号，不为活动/货类控制层再强行展开每家门店；共同店对齐、门店输出及门店数仍保留门店层。
      const needsStore = !["compare", "scan"].includes(request.method) || request.commonStores || request.by?.includes("store") || request.controls?.includes("store") || request.breakdown === "store" || query.metrics?.includes("stores");
      const compactBy = query.by.filter((dimension) => dimension !== "order" && (dimension !== "store" || needsStore));
      const compact = wantsOrderIds && session.aggregateWithOrderIds && !["largest_order", "order_distribution"].includes(request.check ?? "") ? await session.aggregateWithOrderIds({ ...query, by: compactBy }, signal) : null;
      const cells = compact ?? await session.aggregate(query, signal);
      throwIfTurnCancelled(signal); session.assertActive?.(); return cells;
    };
    // 普通汇总由适配器在请求粒度内直接去重计数，不为单个总额展开全部订单或门店。
    // 跨层对照、扫描和订单分布仍保留实际需要的明细粒度，避免把分组订单数相加。
    const internalBy = request.method === "aggregate" ? ordered(request.by ?? []) : ordered([...(request.by ?? []), ...(request.controls ?? []), "store" as const, ...(request.metrics.some((v) => ["orders", "amount_per_order"].includes(v)) ? ["order" as const] : [])]);
    const scanBy = ordered([...(request.by ?? []), ...(request.breakdown ? [request.breakdown] : [])]);
    const scanParents = request.breakdown ? scanBy.filter((dimension) => dimension !== request.breakdown) : [];
    const align = (target: AnalysisAggregateCell[], reference: AnalysisAggregateCell[], originalRows = [sum(target, "rows"), sum(reference, "rows")]) => {
      if (request.commonStores) {
        const left = new Set(target.map((cell) => cell.dimensions.store).filter(Boolean)); const right = new Set(reference.map((cell) => cell.dimensions.store).filter(Boolean)); const common = new Set([...left].filter((store) => right.has(store)));
        target = target.filter((cell) => common.has(cell.dimensions.store)); reference = reference.filter((cell) => common.has(cell.dimensions.store));
        check("共同门店", `按两个范围均有记录的观察门店交集执行，共 ${common.size} 家`); limit("共同观察门店不是正式同店；没有开闭店与营业状态，未证明门店运营条件一致");
      }
      if (request.controls?.length) {
        const left = new Set(target.map((cell) => keyOf(cell, request.controls!))); const right = new Set(reference.map((cell) => keyOf(cell, request.controls!))); const common = new Set([...left].filter((key) => right.has(key) && !JSON.parse(key).includes(null)));
        target = target.filter((cell) => common.has(keyOf(cell, request.controls!))); reference = reference.filter((cell) => common.has(keyOf(cell, request.controls!)));
        check("共同控制分层", `按 ${request.controls.join("、")} 的完整组合交集执行，共 ${common.size} 层；未提供控制值的行排除`);
      }
      check("参与样本", `目标参与 ${sum(target, "rows")} / ${originalRows[0]} 行；参照参与 ${sum(reference, "rows")} / ${originalRows[1]} 行`);
      return { target, reference };
    };
    const compareFacts = (a: AnalysisAggregateCell[], b: AnalysisAggregateCell[], fa: AnalysisFrame, fb: AnalysisFrame, label = "", objectIds: string[] = []) => {
      const output = new Map<AnalysisMetric, AnalysisFact>();
      for (const metric of request.metrics) {
        const groupedDimensions = objectIds.map((id) => objectsById.get(id)!.dimension);
        const target = base(fa, a, metric, `${label}目标`, objectIds); const reference = base(fb, b, metric, `${label}参照`, b.length ? objectsFor(fb, b, groupedDimensions) : []);
        const delta = derived(fa, `${metric}.delta`, `${label}${labels[metric]}差额`, expression("subtract", ref(target), ref(reference)), target.unit, objectIds);
        const change = derived(fa, `${metric}.relative_change`, `${label}${labels[metric]}相对变化`, expression("multiply", constant(100), expression("divide", ref(delta), ref(reference))), "%", objectIds);
        const comparisonKey = analysisId("p");
        for (const fact of [target, reference, delta, change]) fact.comparisonKey = comparisonKey;
        if (metric.includes("per_")) {
          const left = ratioContext(fa, a, metric); const right = ratioContext(fb, b, metric);
          const comparable = left.role === "within_stratum" && right.role === "within_stratum" && left.controls.length === right.controls.length && left.controls.every((dimension) => right.controls.includes(dimension) && left.values[dimension] === right.values[dimension]);
          setComparison(delta, comparable ? "within_stratum" : "descriptive", comparable ? left.controls : [], comparable ? left.values : undefined); setComparison(change, comparable ? "within_stratum" : "descriptive", comparable ? left.controls : [], comparable ? left.values : undefined);
        }
        output.set(metric, delta);
      }
      return output;
    };
    const comparisonBaseline = (delta: AnalysisFact): AnalysisFact => {
      const formula = delta.derivation;
      if (!formula || !("op" in formula) || !("factId" in formula.args[1])) throw new Error("比较派生关系不完整");
      const baselineId = formula.args[1].factId; return factIndex.get(baselineId)!;
    };
    const standardized = (a: AnalysisAggregateCell[], b: AnalysisAggregateCell[], fa: AnalysisFrame, fb: AnalysisFrame, by: AnalysisDimension[], metric: AnalysisMetric = "amount", prefix = "", targetObjectIds: string[] = []): AnalysisFact | null => {
      const denominator: AnalysisMetric = metric === "amount_per_order" ? "orders" : metric.endsWith("per_gram") || request.metrics.includes("grams") ? "grams" : "quantity";
      if (!definitions.has(denominator)) { check("参照权重标准化", "缺少对应分母字段，未执行标准化", false); return null; }
      const left = groups(a, by); const right = groups(b, by); const contributions: FactExpression[] = []; const weights: FactExpression[] = []; const baseline: FactExpression[] = [];
      for (const [key, cells] of left) {
        const reference = right.get(key); if (!reference) continue;
        const objectIds = objectsFor(fa, cells, by); const label = `${prefix}控制层 ${objectIds.map((id) => objectsById.get(id)!.label).join(" / ")}`;
        const amount = base(fa, cells, metric === "gap_per_gram" ? "gap_per_gram" : "amount", label, objectIds); const q1 = base(fa, cells, denominator, label, objectIds); const q0 = base(fb, reference, denominator, `${label}参照`);
        const amount0 = base(fb, reference, metric === "gap_per_gram" ? "gap_per_gram" : "amount", `${label}参照`);
        if (q1.value === null || q1.value <= 0 || q0.value === null || q0.value <= 0 || amount.value === null || amount0.value === null) { limit("部分控制层数量、订单或克重无效，未生成标准化总值"); check("参照权重标准化", "控制层分母无效，未执行完整标准化", false); return null; }
        const price = metric === "gap_per_gram" ? ref(amount) : expression("divide", ref(amount), ref(q1));
        contributions.push(expression("multiply", price, ref(q0))); weights.push(ref(q0)); baseline.push(metric === "gap_per_gram" ? expression("multiply", ref(amount0), ref(q0)) : ref(amount0));
      }
      if (!contributions.length) return null;
      const numerator = expression("add", ...contributions); const baseNumerator = expression("add", ...baseline); const ratio = metric.includes("per_");
      const actualControls = ordered([...by, ...fixedControls(fa), ...fixedControls(fb)]);
      const value = setComparison(derived(fa, `${metric}.standardized_target`, `${prefix}参照权重下的目标反事实${labels[metric]}`, ratio ? expression("divide", numerator, expression("add", ...weights)) : numerator, definitions.get(metric)!.unit, targetObjectIds, "使用参照范围对应分母作为各层权重；这是标准化反事实，不是观察实收或未来销售"), "standardized", actualControls);
      const reference = setComparison(derived(fb, `${metric}.standardized_reference`, `${prefix}参照权重下的参照${labels[metric]}`, ratio ? expression("divide", baseNumerator, expression("add", ...weights)) : baseNumerator, definitions.get(metric)!.unit), "standardized", actualControls);
      const delta = setComparison(derived(fa, `${metric}.standardized_delta`, `${prefix}标准化${labels[metric]}差额`, expression("subtract", ref(value), ref(reference)), value.unit, targetObjectIds), "standardized", actualControls);
      const comparisonKey = analysisId("p");
      for (const fact of [value, reference, delta]) fact.comparisonKey = comparisonKey;
      check("参照权重标准化", `按 ${by.join("、")} 分层，以参照 ${labels[denominator]} 为权重计算；实际总体金额另列`); return delta;
    };

    if (request.method === "aggregate") {
      let cells = await load(request.scope, internalBy, undefined, undefined, request.metrics);
      if (request.metrics.some((metric) => ["orders", "amount_per_order", "stores"].includes(metric)) && new Set(cells.map((cell) => keyOf(cell, request.by ?? []))).size !== cells.length) {
        const query: AnalysisAggregateQuery = { scope: request.scope, by: request.metrics.includes("stores") ? ordered([...internalBy, "store"]) : internalBy, metrics: request.metrics };
        const exact = session.aggregateWithOrderIds && request.metrics.some((metric) => ["orders", "amount_per_order"].includes(metric)) ? await session.aggregateWithOrderIds(query, signal) : null;
        cells = exact ?? await session.aggregate({ ...query, by: ordered([...internalBy, "store", ...(request.metrics.some((metric) => ["orders", "amount_per_order"].includes(metric)) ? ["order" as const] : [])]) }, signal);
        throwIfTurnCancelled(signal); session.assertActive?.();
      }
      const f = frame(request.scope, "真实选定记录汇总，空范围金额不解释为零"); const grouped = groups(cells, request.by ?? []);
      if (!grouped.size) grouped.set("[]", []);
      // 分页概览按当前所问指标的规模排序，避免名称字序把小样本变成主要分析对象；全量分组仍保留。
      const rankMetric = request.metrics.includes("amount") ? "amount" : request.metrics[0];
      const ranked = [...grouped.entries()].map(([key, cells]) => ({ key, cells, rank: sum(cells, rankMetric) }));
      ranked.sort((a, b) => (b.rank === null ? -Infinity : Math.abs(b.rank)) - (a.rank === null ? -Infinity : Math.abs(a.rank)) || a.key.localeCompare(b.key));
      for (const { cells } of ranked) { const ids = cells.length ? objectsFor(f, cells) : []; for (const metric of request.metrics) base(f, cells, metric, "汇总", ids); }
      method.sampleRows = sum(cells, "rows")!; method.groupCount = cells.length ? grouped.size : 0; check("完整范围汇总", `处理全部 ${method.sampleRows} 行、${method.groupCount} 组；无金额前列截取`);
    } else if (request.method === "compare" || request.method === "scan" && request.reference) {
      if (!request.reference) throw analysisArgumentsInvalid("请补充 reference 参照范围，再执行对照");
      const by = ordered([...internalBy, ...(request.method === "scan" ? scanBy : [])]); const target = await load(request.scope, by); const reference = await load(request.reference, by);
      const fa = frame(request.scope, "实际已读取的目标范围；可比性由共同控制层与参与记录检查决定"); const fb = frame(request.reference, "实际已读取的参照范围；空范围或空交集不生成比较事实");
      const aligned = align(target, reference);
      if (!aligned.target.length || !aligned.reference.length) return unsupported("没有完整可比的目标与参照样本，未生成差异");
      const parent = compareFacts(aligned.target, aligned.reference, fa, fb);
      method.sampleRows = sum(aligned.target, "rows")! + sum(aligned.reference, "rows")!;
      if (request.method === "compare") {
        if (request.controls?.length) for (const metric of request.metrics.filter((v) => v === "amount" || v.includes("per_"))) standardized(aligned.target, aligned.reference, fa, fb, request.controls, metric);
        if (request.by?.length) {
          const targets = groups(aligned.target, request.by); const references = groups(aligned.reference, request.by); method.groupCount = new Set([...targets.keys(), ...references.keys()]).size;
          for (const [key, cells] of targets) if (references.has(key)) compareFacts(cells, references.get(key)!, fa, fb, "分组 ", objectsFor(fa, cells));
        } else method.groupCount = 1;
        check("可比对照", "目标与参照使用相同币种、指标定义及人口口径；差异是历史相关，不证明活动增量");
      } else {
        const targetParents = groups(aligned.target, scanParents); const referenceParents = groups(aligned.reference, scanParents);
        const deviated: AnalysisFact[] = [];
        for (const parentKey of new Set([...targetParents.keys(), ...referenceParents.keys()])) {
          const targetParent = targetParents.get(parentKey) ?? []; const referenceParent = referenceParents.get(parentKey) ?? [];
          const parentIds = scanParents.length ? objectsFor(fa, targetParent.length ? targetParent : referenceParent, scanParents) : [];
          const actualParent = scanParents.length ? compareFacts(targetParent, referenceParent, fa, fb, "父组 ", parentIds) : parent;
          const parentStandard = new Map<AnalysisMetric, AnalysisFact | null>();
          if (request.controls?.length) for (const metric of request.metrics.filter((v) => v === "amount" || v.includes("per_"))) parentStandard.set(metric, standardized(targetParent, referenceParent, fa, fb, request.controls, metric, "父组 ", parentIds));
          const targets = groups(targetParent, scanBy); const references = groups(referenceParent, scanBy); const candidates = new Set([...targets.keys(), ...references.keys()]); method.groupCount += candidates.size;
          for (const key of candidates) {
          const a = targets.get(key) ?? []; const b = references.get(key) ?? []; const ids = objectsFor(fa, a.length ? a : b, scanBy); const child = compareFacts(a, b, fa, fb, "分组 ", ids);
          for (const metric of request.metrics) {
            const parentDelta = actualParent.get(metric)!; const parentBaseline = comparisonBaseline(parentDelta); const childBaseline = comparisonBaseline(child.get(metric)!);
            const adjusted = parentStandard.has(metric);
            const raw = derived(fa, `${metric}.${adjusted ? "unadjusted_deviation" : "relative_deviation"}`, `${labels[metric]}未标准化的相对父组变化偏离`, expression("multiply", constant(100), expression("subtract", expression("divide", ref(child.get(metric)!), ref(childBaseline)), expression("divide", ref(parentDelta), ref(parentBaseline)))), "个百分点", ids);
            if (metric.includes("per_")) setComparison(raw, "descriptive", []);
            let deviation = raw;
            if (adjusted) {
              const normalizedChild = standardized(a, b, fa, fb, request.controls!, metric, "分组 ", ids); const normalizedParent = parentStandard.get(metric);
              deviation = normalizedChild && normalizedParent ? derived(fa, `${metric}.relative_deviation`, `${labels[metric]}参照权重标准化后相对父组偏离`, expression("multiply", constant(100), expression("subtract", expression("divide", ref(normalizedChild), ref(comparisonBaseline(normalizedChild))), expression("divide", ref(normalizedParent), ref(comparisonBaseline(normalizedParent))))), "个百分点", ids) : add(fa, `${metric}.relative_deviation`, "控制层不足，未计算标准化偏离", null, "个百分点", ids);
              setComparison(deviation, normalizedChild && normalizedParent ? "standardized" : "descriptive", normalizedChild && normalizedParent ? request.controls! : []);
            }
            const contribution = derived(fa, `${metric}.change_contribution`, `${labels[metric]}${definitions.get(metric)!.additive ? "变化贡献占比" : "变化相对父组变化的比值（非加总贡献）"}`, expression("multiply", constant(100), expression("divide", ref(child.get(metric)!), ref(parentDelta))), "%", ids);
            if (metric.includes("per_")) setComparison(contribution, "descriptive", []);
            deviated.push(deviation);
          }
          base(fa, a, "rows", "分组样本", ids);
          }
        }
        const rank = (fact: AnalysisFact) => fact.value === null ? -Infinity : Math.abs(fact.value);
        deviated.sort((a, b) => rank(b) - rank(a) || a.label.localeCompare(b.label));
        const ids = new Set(deviated.map((f) => f.id)); result.facts = [...deviated, ...result.facts.filter((f) => !ids.has(f.id))];
        check("全范围偏离扫描", `按 ${scanBy.join("、")} 的完整组合读取全部 ${method.groupCount} 组；父层为 ${scanParents.join("、") || "整个选定范围"}；按相对各自父组变化偏离的绝对值降序排列，缺失偏离排末；未按销售额截取`); limit("偏离与贡献仅是观察到的算术关系，未证明机会或活动因果；不同规模不能仅凭排名下结论");
      }
    } else if (request.method === "decompose") {
      if (!request.reference) throw analysisArgumentsInvalid("请补充 reference 参照范围，再执行变化拆解");
      if (!request.metrics.includes("amount")) return unsupported("当前只登记实收金额的变化拆解，不对其他指标套公式");
      if (request.metrics.some((metric) => !["amount", "quantity", "grams"].includes(metric))) return unsupported("当前只登记实收金额的数量价格结构与销售退货贡献拆解，所求其他指标未执行拆解");
      if (request.scope.population === "net") {
        const target = await load(request.scope, internalBy); const reference = await load(request.reference, internalBy);
        const fa = frame(request.scope, "实际已读取净销售目标范围，由销售正金额、零元销售、退货组成"); const fb = frame(request.reference, "实际已读取同定义净销售参照范围");
        const overall = align(target, reference);
        if (!overall.target.length || !overall.reference.length) return unsupported("净销售缺少可比总体，未执行组成贡献拆解");
        const selectedDimensions = ordered([...(request.controls ?? []), ...(request.commonStores ? ["store" as const] : [])]);
        const targetKeys = new Set(overall.target.map((cell) => keyOf(cell, selectedDimensions))); const referenceKeys = new Set(overall.reference.map((cell) => keyOf(cell, selectedDimensions)));
        const pieces: FactExpression[] = []; let totalRows = 0;
        for (const population of ["sales", "zero_sales", "returns"] as const) {
          const sa = { ...request.scope, population }; const sb = { ...request.reference, population };
          const aligned = { target: (await load(sa, internalBy)).filter((cell) => targetKeys.has(keyOf(cell, selectedDimensions))), reference: (await load(sb, internalBy)).filter((cell) => referenceKeys.has(keyOf(cell, selectedDimensions))) };
          const a = frame(sa, "净销售互斥组成；无该类记录时该组成贡献为零，缺失字段仍为缺失"); const b = frame(sb, "净销售互斥组成参照");
          const va = add(a, "amount", `目标${population}金额`, aligned.target.length ? sum(aligned.target, "amount") : 0, session.capabilities.currency); const vb = add(b, "amount", `参照${population}金额`, aligned.reference.length ? sum(aligned.reference, "amount") : 0, session.capabilities.currency);
          const delta = derived(fa, `amount.${population}_contribution`, `${population}对净销售变化的贡献`, expression("subtract", ref(va), ref(vb)), va.unit); pieces.push(ref(delta)); totalRows += sum(aligned.target, "rows")! + sum(aligned.reference, "rows")!;
        }
        if (!totalRows) return unsupported("两个净销售范围均没有记录，不能把空范围解释为零");
        derived(fa, "amount.decomposed_change", "销售与退货贡献重构净销售变化", expression("add", ...pieces), session.capabilities.currency); method.sampleRows = totalRows; method.groupCount = 3;
        check("销售退货贡献拆解", "实际分别读取销售正金额、零元销售和退货；有符号数量未用于量价拆解"); void fb;
      } else if (request.scope.population === "sales") {
        const denominator: AnalysisMetric = request.metrics.includes("grams") ? "grams" : "quantity";
        if (!definitions.has(denominator)) return unsupported("量价拆解缺少对应数量或克重字段");
        const split = request.breakdown ?? (session.capabilities.dimensions.includes("category") ? "category" : undefined); const by = ordered([...(request.controls ?? []), ...(split ? [split] : [])]);
        const target = await load(request.scope, ordered([...internalBy, ...by])); const reference = await load(request.reference, ordered([...internalBy, ...by]));
        const a = frame(request.scope, "实际已读取销售目标范围；登记方法为参照价格→目标数量结构→目标价格，算术贡献不是业务原因"); const b = frame(request.reference, "实际已读取同定义销售参照范围");
        const aligned = align(target, reference);
        const left = groups(aligned.target, by); const right = groups(aligned.reference, by); const common = [...left.keys()].filter((key) => right.has(key));
        if (!common.length) return unsupported("没有可以计算量价的共同分层");
        const ac = common.flatMap((key) => left.get(key)!); const bc = common.flatMap((key) => right.get(key)!); const q1 = base(a, ac, denominator, "共同层目标"); const q0 = base(b, bc, denominator, "共同层参照"); const a0 = base(b, bc, "amount", "共同层参照");
        if (q1.value === null || q1.value <= 0 || q0.value === null || q0.value <= 0) return unsupported("共同层总数量或克重缺失或非正，未执行量价拆解");
        const mix: FactExpression[] = []; const prices: FactExpression[] = [];
        for (const key of common) {
          const ids = objectsFor(a, left.get(key)!, by); const x1 = base(a, left.get(key)!, denominator, "分层目标", ids); const x0 = base(b, right.get(key)!, denominator, "分层参照"); const y1 = base(a, left.get(key)!, "amount", "分层目标", ids); const y0 = base(b, right.get(key)!, "amount", "分层参照");
          if (x1.value === null || x1.value <= 0 || x0.value === null || x0.value <= 0 || y1.value === null || y0.value === null) return unsupported("部分共同层分母无效或金额缺失，未执行完整量价拆解");
          const p0 = expression("divide", ref(y0), ref(x0)); const p1 = expression("divide", ref(y1), ref(x1));
          mix.push(expression("multiply", ref(q1), expression("subtract", expression("divide", ref(x1), ref(q1)), expression("divide", ref(x0), ref(q0))), p0));
          prices.push(expression("multiply", ref(x1), expression("subtract", p1, p0)));
        }
        const volume = derived(a, "amount.quantity_contribution", `${labels[denominator]}变化贡献`, expression("multiply", expression("subtract", ref(q1), ref(q0)), expression("divide", ref(a0), ref(q0))), session.capabilities.currency);
        const price = derived(a, "amount.price_contribution", "分层单位实收变化贡献", expression("add", ...prices), session.capabilities.currency);
        const structure = derived(a, "amount.mix_contribution", "共同分层结构变化贡献", expression("add", ...mix), session.capabilities.currency);
        const entry = left.size > common.length ? sum([...left].filter(([key]) => !right.has(key)).flatMap(([, cells]) => cells), "amount") : 0; const exit = right.size > common.length ? sum([...right].filter(([key]) => !left.has(key)).flatMap(([, cells]) => cells), "amount") : 0;
        const entered = add(a, "amount.entry_contribution", "新增观察分层金额贡献", entry, session.capabilities.currency); const exited = add(b, "amount.exit_amount", "退出观察分层原金额", exit, session.capabilities.currency);
        derived(a, "amount.decomposed_change", "数量价格结构及进入退出重构金额变化", expression("subtract", expression("add", ref(volume), ref(price), ref(structure), ref(entered)), ref(exited)), session.capabilities.currency);
        method.sampleRows = sum(aligned.target, "rows")! + sum(aligned.reference, "rows")!; method.groupCount = new Set([...left.keys(), ...right.keys()]).size;
        check("量价结构拆解", `按 ${by.join("、") || "整体"} 分层，以 ${labels[denominator]} 作数量；真实计算数量、单位实收、共同层结构和进入退出贡献`); limit("单位实收变化包含未连接的价格、工费和商品差异；不能直接解释为优惠力度或已验证业务原因");
      } else return unsupported("当前人口口径不适用量价结构拆解；回收与退货不能直接套销售数量公式");
    } else if (request.method === "scan") {
      // 无控制层的同期扫描直接读取完整子组及父组；订单由数据适配器分别去重，不能把子组订单相加。
      const compact = !request.controls?.length;
      let cells = await load(request.scope, compact ? scanBy : ordered([...internalBy, ...scanBy]), undefined, undefined, compact ? request.metrics : undefined);
      let parentGroups = groups(cells, scanParents);
      let parentTotals = compact ? groups(await load(request.scope, scanParents, undefined, undefined, request.metrics), scanParents) : parentGroups;
      // 空值映射若合并了原始分组，保留逐单路径以取得该合并分组的准确订单数。
      if (compact && (new Set(cells.map((cell) => keyOf(cell, scanBy))).size !== cells.length || [...parentTotals.values()].some((items) => items.length > 1))) {
        cells = await load(request.scope, ordered([...internalBy, ...scanBy])); parentGroups = groups(cells, scanParents); parentTotals = parentGroups;
      }
      const f = frame(request.scope, "同窗口完整组合分组相对各自父组扫描，按实际分子分母重算，不平均组比率");
      for (const [parentKey, members] of parentGroups) {
      const parentCells = parentTotals.get(parentKey);
      if (!parentCells?.length) throw new Error("同快照父分组统计缺失，不能完成完整扫描");
      const parentIds = scanParents.length ? objectsFor(f, parentCells, scanParents) : []; const grouped = groups(members, scanBy); method.groupCount += grouped.size;
      const complementFields = additiveFields.filter((field) => readMetrics.includes(field) || field === "tag_amount" && request.metrics.includes("gap_per_gram"));
      const complement = request.controls?.length && !request.commonStores && request.metrics.some((metric) => metric === "amount" || metric.includes("per_")) ? await controlledComplements(grouped, request.controls, complementFields, checkpoint) : null;
      const alignedChildren = new Map<string, ReturnType<typeof align>>(); let scannedGroups = 0;
      for (const metric of request.metrics) {
        const parent = base(f, parentCells, metric, "父组", parentIds); const parentRows = base(f, parentCells, "rows", "父组规模", parentIds);
        for (const [childKey, values] of grouped) {
          if (++scannedGroups % 64 === 0) await checkpoint();
          const ids = objectsFor(f, values, scanBy); const value = base(f, values, metric, "分组", ids); const n = base(f, values, "rows", "分组规模", ids);
          const childValue = definitions.get(metric)!.additive ? expression("divide", ref(value), ref(n)) : ref(value); const parentValue = definitions.get(metric)!.additive ? expression("divide", ref(parent), ref(parentRows)) : ref(parent);
          const adjusted = Boolean(request.controls?.length && (metric === "amount" || metric.includes("per_")));
          const raw = derived(f, `${metric}.${adjusted ? "unadjusted_deviation" : "relative_deviation"}`, `${labels[metric]}相对父组平均值未标准化偏离`, expression("multiply", constant(100), expression("subtract", expression("divide", childValue, parentValue), constant(1))), "%", ids);
          if (metric.includes("per_")) setComparison(raw, "descriptive", []);
          if (adjusted) {
            let aligned = alignedChildren.get(childKey);
            if (!aligned) {
              if (complement) { const summary = complement(childKey); aligned = align(summary.target, summary.reference, summary.originalRows); }
              else aligned = align(values, parentCells.filter((cell) => keyOf(cell, scanBy) !== childKey));
              alignedChildren.set(childKey, aligned);
            }
            const normalized = standardized(aligned.target, aligned.reference, f, f, request.controls!, metric, "分组对其余父组 ", ids);
            if (normalized) setComparison(derived(f, `${metric}.relative_deviation`, `${labels[metric]}共同层参照权重后相对其余父组偏离`, expression("multiply", constant(100), expression("divide", ref(normalized), ref(comparisonBaseline(normalized)))), "%", ids), "standardized", request.controls!);
            else setComparison(add(f, `${metric}.relative_deviation`, "控制层不足，未计算标准化偏离", null, "%", ids), "descriptive", []);
          }
          if (definitions.get(metric)!.additive) derived(f, `${metric}.share`, `${labels[metric]}分组份额`, expression("multiply", constant(100), expression("divide", ref(value), ref(parent))), "%", ids);
        }
      }
      }
      result.facts.sort((a, b) => {
        const left = a.metricId.endsWith("relative_deviation"), right = b.metricId.endsWith("relative_deviation");
        return left && right ? Math.abs(b.value ?? 0) - Math.abs(a.value ?? 0) : left ? -1 : right ? 1 : 0;
      });
      method.sampleRows = sum(cells, "rows")!; check("全范围同期偏离扫描", `按 ${scanBy.join("、")} 完整组合的全部 ${method.groupCount} 组均参与；父层为 ${scanParents.join("、") || "整个选定范围"}；加总指标按每行平均比较，比例从父子实际分子分母重算`); limit("同期每行金额差异仍受商品与件数结构影响，不代表增长、活动增量或机会；需要可比对照后解释");
    } else if (request.method === "robustness") {
      if (!request.check) throw analysisArgumentsInvalid("请提供 check 检查类型，再执行稳健性检查");
      if (request.check === "alternative_window") {
        if (!request.alternative) throw analysisArgumentsInvalid("请补充 alternative 替代窗口日期，再执行窗口检查");
        const scope = { ...request.scope, period: request.alternative }; const aligned = align(await load(request.scope, internalBy), await load(scope, internalBy));
        const a = frame(request.scope, "原窗口"); const b = frame(scope, "替代窗口"); compareFacts(aligned.target, aligned.reference, a, b, "窗口核对 ");
        for (const metric of request.metrics) base(b, aligned.reference, metric, "替代窗口");
        const days = (p: Period) => Math.round((Date.parse(p.end) - Date.parse(p.start)) / 86400000) + 1;
        if (days(scope.period) !== days(request.scope.period)) {
          for (const [f, cells] of [[a, aligned.target], [b, aligned.reference]] as const) {
            const periodDays = add(f, "period_days", "窗口覆盖日历天数", days(f.scope.period), "日", [], undefined, "从数据框起止日期按日计算，包含首尾；不是实际营业天数");
            for (const metric of request.metrics.filter((v) => definitions.get(v)!.additive)) derived(f, `${metric}.daily`, `窗口日均${labels[metric]}`, expression("divide", ref(base(f, cells, metric, "窗口总量")), ref(periodDays)), `${definitions.get(metric)!.unit}/日`);
          }
          limit("窗口天数不同，已单列日均；日均仍未控制星期、节日与金价");
        }
        method.sampleRows = sum(aligned.target, "rows")! + sum(aligned.reference, "rows")!; method.groupCount = 2; check("替代日期窗口", "实际读取替代周期，不用外推代替检查"); limit("未连接节日对齐与每日金价；替代窗口差异仍是观察关系");
      } else {
        const order = request.check !== "largest_store";
        if (order && !definitions.has("orders")) return unsupported("当前数据缺少门店与单号组成的订单能力，不能执行订单成交部分检查");
        if (order && request.scope.population !== "sales") throw analysisArgumentsInvalid("订单成交部分检查只接受 sales 销售正金额口径；请将本次检查的 population 改为 sales，不用净销售或退货重构最大成交部分");
        if (request.check === "largest_order") {
          const totals = await load(request.scope, [], undefined, undefined, ["orders"]);
          if (!totals.length) return unsupported("当前范围没有可检查样本");
          if (sum(totals, "orders") === null) return unsupported("当前范围存在缺少复合订单标识的行，不能确定全局最大对象");
        }
        if (request.check === "order_distribution" && session.orderDistribution && !controls.length && !request.metrics.some((metric) => metric.endsWith("per_gram"))) {
          // 数据库读取完整范围后直接返回精确分位数，避免把逐单分组传回服务再排序。
          const summary = await session.orderDistribution({ scope: request.scope, metrics: request.metrics }, signal);
          if (!summary.orderCount) return unsupported("没有完整复合订单标识，未执行分布检查");
          const f = frame(request.scope, "只重构当前筛选内订单成交部分，缺店号或单号的行未参与分布");
          for (const metric of request.metrics) for (const name of ["p50", "p90", "p99"] as const) {
            const quantileFact = add(f, `${metric}.${name}`, `订单成交部分${labels[metric]}${name}`, summary.quantiles[metric]?.[name] ?? null, definitions.get(metric)!.unit, [], undefined, "筛选内复合订单聚合后升序排列，最近秩分位数；任一订单该指标缺失则总体分位数缺失");
            if (metric.includes("per_")) {
              const context = ratioContext(f, [{ dimensions: {}, rows: summary.sampleRows, amount: null, quantity: null, grams: null, profit: null, orders: summary.orderCount, stores: null, tag_amount: null }], metric);
              setComparison(quantileFact, context.role, context.controls);
            }
          }
          add(f, "rows.excluded", "缺复合订单标识的排除行数", summary.excludedRows, "条"); add(f, "orders.observed", "参与分布的订单成交部分数", summary.orderCount, "单");
          method.sampleRows = summary.sampleRows; method.groupCount = summary.orderCount; check("订单成交部分分布", `按店号和单号重构 ${summary.orderCount} 个当前筛选内成交部分，不能称整张订单`);
          if (summary.excludedRows) { limit(`缺店号或销售单号的 ${summary.excludedRows} 行未参与分布，不把观察分布当成完整订单分布`); check("完整订单覆盖", "缺失复合订单标识，仅执行已识别订单成交部分分布", false); }
        } else {
        const cells = await load(request.scope, ordered([...internalBy, "store", ...(order ? ["order" as const] : [])]));
        if (!cells.length) return unsupported("当前范围没有可检查样本");
        const dimension = order ? "order" : "store"; const valid = cells.filter((cell) => cell.dimensions[dimension]); const excluded = sum(cells.filter((cell) => !cell.dimensions[dimension]), "rows")!;
        if (request.check === "order_distribution") {
          const grouped = new Map<string, AnalysisAggregateCell[]>(); for (const cell of valid) { const key = cell.dimensions.order!; grouped.set(key, [...(grouped.get(key) ?? []), cell]); }
          if (!grouped.size) return unsupported("没有完整复合订单标识，未执行分布检查");
          const f = frame(request.scope, "只重构当前筛选内订单成交部分，缺店号或单号的行未参与分布");
          for (const metric of request.metrics) {
            const values = [...grouped.values()].map((cells) => sum(cells, metric)); const present = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
            for (const [name, quantile] of [["p50", 0.5], ["p90", 0.9], ["p99", 0.99]] as const) {
              const quantileFact = add(f, `${metric}.${name}`, `订单成交部分${labels[metric]}${name}`, present.length === values.length ? present[Math.ceil(quantile * present.length) - 1] : null, definitions.get(metric)!.unit, [], undefined, "筛选内复合订单聚合后升序排列，最近秩分位数；任一订单该指标缺失则总体分位数缺失");
              if (metric.includes("per_")) { const context = ratioContext(f, valid, metric); setComparison(quantileFact, context.role, context.controls); }
            }
          }
          add(f, "rows.excluded", "缺复合订单标识的排除行数", excluded, "条"); add(f, "orders.observed", "参与分布的订单成交部分数", grouped.size, "单");
          method.sampleRows = sum(valid, "rows")!; method.groupCount = grouped.size; check("订单成交部分分布", `按店号和单号重构 ${grouped.size} 个当前筛选内成交部分，不能称整张订单`);
          if (excluded) { limit(`缺店号或销售单号的 ${excluded} 行未参与分布，不把观察分布当成完整订单分布`); check("完整订单覆盖", "缺失复合订单标识，仅执行已识别订单成交部分分布", false); }
        } else {
          if (excluded) return unsupported(`有 ${excluded} 行缺少 ${order ? "复合订单" : "门店"} 标识，不能确定全局最大对象`);
          const grouped = new Map<string, AnalysisAggregateCell[]>(); for (const cell of valid) { const key = cell.dimensions[dimension]!; grouped.set(key, [...(grouped.get(key) ?? []), cell]); }
          const ranked = [...grouped].map(([id, values]) => ({ id, value: sum(values, "amount") }));
          if (ranked.some((item) => item.value === null)) return unsupported("选取最大对象所需金额缺失，未执行排除检查");
          ranked.sort((a, b) => Math.abs(b.value!) - Math.abs(a.value!) || a.id.localeCompare(b.id)); const selected = ranked[0].id;
          const reference = request.reference ? await load(request.reference, ordered([...internalBy, "store", ...(order ? ["order" as const] : [])])) : [];
          const original = request.reference ? align(cells, reference) : { target: cells, reference: [] };
          const fa = frame(request.scope, "原范围，按全局金额绝对值选最大对象"); const fb = request.reference ? frame(request.reference, "原范围参照") : null;
          if (fb) compareFacts(original.target, original.reference, fa, fb, "原范围 "); else for (const metric of request.metrics) base(fa, original.target, metric, "原范围");
          const excludedStores = order ? undefined : [selected]; const excludedOrders = order ? [selected] : undefined;
          const afterA = await load(request.scope, ordered([...internalBy, "store", ...(order ? ["order" as const] : [])]), excludedStores, excludedOrders); const afterB = request.reference ? await load(request.reference, ordered([...internalBy, "store", ...(order ? ["order" as const] : [])]), excludedStores, excludedOrders) : [];
          const aligned = request.reference ? align(afterA, afterB) : { target: afterA, reference: [] };
          const a = frame(request.scope, `实际排除目标范围选出的全局最大${order ? "订单成交部分" : "门店"}，按实收金额绝对值选取，同一对象也从参照中排除`); const b = request.reference ? frame(request.reference, "参照实际排除相同对象") : null;
          if (b) compareFacts(aligned.target, aligned.reference, a, b, "剔除后 "); else for (const metric of request.metrics) base(a, aligned.target, metric, "剔除后");
          if (!order) objectsFor(fa, [{ ...cells[0], dimensions: { store: selected } }], ["store"]);
          method.sampleRows = sum(aligned.target, "rows")! + sum(aligned.reference, "rows")!; method.groupCount = grouped.size;
          check(order ? "全局最大订单成交部分" : "全局最大门店", `按目标全范围实收金额绝对值选取，实际剔除后重新读取；${order ? "当前筛选内成交部分不等于完整订单，逐单标识不进入公开证据" : "不是每组各删一家，也没有按前列门店选择"}`);
        }
        }
      }
    }
    result.limitations = uniq(result.limitations); method.limitations = uniq(method.limitations); throwIfTurnCancelled(signal); session.assertActive?.(); return result;
  }
  const wait = async (pending: Promise<AnalysisOperationResult>, signal?: AbortSignal): Promise<AnalysisOperationResult> => {
    if (!signal) return pending;
    let abort = () => {};
    try { return await new Promise<AnalysisOperationResult>((resolve, reject) => {
      abort = () => { void session.close(); reject(new TurnCancelledError()); };
      signal.addEventListener("abort", abort, { once: true }); pending.then(resolve, reject); if (signal.aborted) abort();
    }); } finally { signal.removeEventListener("abort", abort); }
  };
  const reuseResult = (result: AnalysisOperationResult, request: AnalysisOperationRequest): AnalysisOperationResult => {
    const needIds = [...request.needIds]; Object.freeze(needIds);
    return Object.freeze({ ...result, needIds, purpose: request.purpose, cached: true });
  };
  return { async execute(input: AnalysisOperationRequest, signal?: AbortSignal): Promise<AnalysisOperationResult> {
    if (signal?.aborted) { await session.close(); throwIfTurnCancelled(signal); }
    session.assertActive?.(); let request: AnalysisOperationRequest;
    try { request = normalize(input); } catch (error) { throw analysisArgumentsInvalid(error instanceof Error ? error.message : "分析参数不正确，请按方法合同修正后重试"); }
    const { needIds: _needs, purpose: _purpose, ...operation } = request; void _needs; void _purpose; const key = JSON.stringify(operation);
    const existing = cache.get(key);
    if (existing) { const result = await wait(existing, signal); throwIfTurnCancelled(signal); session.assertActive?.(); return reuseResult(result, request); }
    const { metrics, ...aggregate } = operation; const aggregateKey = JSON.stringify(aggregate);
    // 相同范围、分组和控制下，缩窄已完成汇总的指标直接复用原证据；不跨范围合并或截取总体。
    const reused = request.method === "aggregate" ? completedAggregates.get(aggregateKey)?.find((item) => metrics.every((metric) => item.metrics.includes(metric))) : undefined;
    if (reused) { throwIfTurnCancelled(signal); session.assertActive?.(); return reuseResult(reused.result, request); }
    const pending = perform(request, signal).then((result) => sealOwnedAnalysisOperation(result, signal)); cache.set(key, pending);
    try {
      const result = await wait(pending, signal);
      throwIfTurnCancelled(signal); session.assertActive?.();
      if (request.method === "aggregate" && result.status === "completed") {
        const entries = completedAggregates.get(aggregateKey) ?? []; entries.push({ metrics, result }); completedAggregates.set(aggregateKey, entries);
      }
      return result;
    } catch (error) { cache.delete(key); throw error; }
  } };
}
