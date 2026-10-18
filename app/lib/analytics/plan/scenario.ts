import type { AnalysisAdjustment, AnalysisDataSession, AnalysisEvidence, AnalysisFact, AnalysisOperationResult, FactExpression } from "../analysis-v2-types.ts";
import { analysisArgumentsInvalid } from "../analysis-v2-operations.ts";
import { normalizeNetChanges, normalizeScenarioAdjustment } from "../analysis-v2-scenarios.ts";
import { scenarioCents, scenarioRevenue } from "../scenario-decimal.ts";
import { throwIfTurnCancelled } from "../../cancellation.ts";

// 计划里的情景节点参数；基线由执行器从所指 measure 的总体实收事实取得，模型不能指定。
export type PlanScenarioInput = { id: string; adjustment: AnalysisAdjustment; netVolumeChanges: string[]; reason: string };

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// 规则和净增只是假设；真正的逐行或逐单损失由当前授权快照计算，模型不能填写结果。
export async function simulatePlanScenario(input: PlanScenarioInput, baselineFactId: string, evidence: AnalysisEvidence, session: AnalysisDataSession, signal?: AbortSignal): Promise<AnalysisOperationResult> {
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000) throw analysisArgumentsInvalid("情景需要写明假设理由");
  const adjustment = normalizeScenarioAdjustment(input.adjustment), changes = normalizeNetChanges(input.netVolumeChanges);
  const base = evidence.facts.find((fact) => fact.id === baselineFactId); const frame = evidence.frames.find((item) => item.id === base?.frameId);
  if (!base) throw analysisArgumentsInvalid("情景基线必须是实际已读取的原始实收依据");
  if (base.metricId !== "amount" || base.derivation || base.assumption || base.objectIds.length || !frame || frame.scope.population !== "sales" || frame.mode === "historical" || base.value === null || base.value <= 0) throw analysisArgumentsInvalid("请先按目标范围读取销售正金额的总体 amount 基线，分组、历史参考及假设不能替代");
  if (frame.snapshotId !== session.snapshotId || frame.datasetVersion !== session.datasetVersion) throw analysisArgumentsInvalid("情景不能使用旧快照基线，请在当前范围重新读取");
  if (!session.scenario || !session.capabilities.scenarios?.includes(adjustment.kind)) throw analysisArgumentsInvalid("当前数据源没有声明该情景能力，不能以聚合算术代替逐行规则");
  if (adjustment.kind === "per_gram" && (!frame.scope.filters.categories?.length || frame.scope.filters.categories.length !== 1 || frame.scope.filters.materials?.length !== 1)) throw analysisArgumentsInvalid("每克情景须明确同一货类与材料，不能用混合货品代表计价黄金");
  session.assertActive?.(); throwIfTurnCancelled(signal);
  const measured = await session.scenario({ scope: frame.scope as Parameters<NonNullable<AnalysisDataSession["scenario"]>>[0]["scope"], adjustment }, signal);
  throwIfTurnCancelled(signal); session.assertActive?.();
  if (scenarioCents(base.value) !== BigInt(measured.amountCents) || !measured.sampleRows) throw analysisArgumentsInvalid("同范围情景重算与原始基线不一致，不能继续发布");
  const signature = JSON.stringify({ frame: frame.id, base: base.id, adjustment, changes, reason: input.reason });
  const operationId = `scenario-${(await digest(signature)).slice(0, 24)}`;
  throwIfTurnCancelled(signal);
  const orderBased = adjustment.kind === "per_order" || adjustment.kind === "order_threshold";
  const limits = [...new Set([...frame.limitations, "显式情景计算，不是需求预测、今年业绩或已执行活动；收入持平不等于毛利或现金持平", "价格环境、商品及优惠结构固定，净成交量变化相对不调整方案，排除跨活动、货品、门店和日期的成交挪动", "额外让利按行或订单成交部分到分，实收最低为零；未重算退货、回收与成本", ...(orderBased ? ["按店号与单号聚合当前筛选内销售成交部分，门槛也仅作用于该部分；不是完整订单或真实资格核验"] : [])])];
  const facts: AnalysisFact[] = [];
  const add = (key: string, metricId: string, label: string, value: number | null, unit: string, extra: Partial<AnalysisFact> = {}) => {
    const fact: AnalysisFact = { id: `${operationId}-${key}`, frameId: frame.id, operationId, metricId, label, value, unit, objectIds: [], definition: "当前授权范围的确定性条件情景；不估计需求响应", limitations: limits, ...extra }; facts.push(fact); return fact;
  };
  const hypothetical = { assumption: { reason: input.reason } };
  const parameter = adjustment.kind === "amount_rate" ? add("parameter", "assumption.scenario_rate", "假设对现有实收追加让利比例", Number(adjustment.rate) * 100, "%", hypothetical) : add("parameter", "assumption.scenario_amount", "假设额外让利", Number(adjustment.amount), `${frame.currency}/${orderBased ? "单" : adjustment.kind === "per_gram" ? "克" : "件"}`, hypothetical);
  const parameters = [parameter.id];
  if (adjustment.kind === "order_threshold") parameters.push(add("threshold", "assumption.scenario_threshold", "假设订单成交部分金额门槛", Number(adjustment.threshold), frame.currency, hypothetical).id);
  add("missing", "scenario.missing_units", "缺少必要单位的销售行", measured.missingUnits, "条");
  add("invalid", "scenario.nonpositive_units", "单位非正的销售行", measured.nonpositiveUnits, "条");
  const completed = measured.lossCents !== null;
  if (!completed) limits.push("所选总体含缺失或非正单位，未发布部分覆盖的优惠损失或收入情景，请先界定完整有效范围");
  if (completed) {
    const loss = add("loss", "scenario.static_loss", "同销量额外让利", measured.lossCents! / 100, frame.currency, { ...hypothetical, scenario: { kind: "static_loss", baselineFactId: base.id, parameterFactIds: parameters } });
    const remaining = add("static", "scenario.static_revenue", "销量不变时实收", (measured.amountCents - measured.lossCents!) / 100, frame.currency, { derivation: { op: "subtract", args: [{ factId: base.id }, { factId: loss.id }] } });
    const threshold: FactExpression = { op: "multiply", args: [{ op: "divide", args: [{ factId: loss.id }, { factId: remaining.id }] }, { constant: 100 }] };
    add("break-even", "scenario.break_even_pct", "收入持平所需净成交量增幅", remaining.value! > 0 ? 100 * loss.value! / remaining.value! : null, "%", { derivation: threshold });
    changes.forEach((change, index) => {
      const rate = add(`rate-${index}`, "assumption.net_volume_change", "假设净成交量变化情景", Number(change) * 100, "%", hypothetical);
      const result = scenarioRevenue(measured.amountCents, measured.lossCents!, change);
      const scenario = { kind: "revenue" as const, baselineFactId: base.id, lossFactId: loss.id, rateFactId: rate.id, netChange: change };
      add(`after-${index}`, "scenario.revenue_after", "条件测算实收", result.afterCents / 100, frame.currency, { ...hypothetical, scenario });
      add(`change-${index}`, "scenario.revenue_change", "条件测算实收变化", result.changeCents / 100, frame.currency, { ...hypothetical, scenario });
    });
  }
  const method = { id: `${operationId}-method`, operationId, method: "aggregate" as const, status: completed ? "completed" as const : "unsupported" as const, frameIds: [frame.id], controls: [...frame.controls], checks: [{ name: "完整情景计算", status: completed ? "performed" as const : "unavailable" as const, result: completed ? `按${orderBased ? "复合订单成交部分" : "完整销售行"}计算并逐项到分与封顶；核对原始总体实收一致，覆盖全部有效范围` : "缺失单位不能补零或静默丢弃，未生成收入结果" }], sampleRows: measured.sampleRows, groupCount: completed ? changes.length : 0, limitations: limits };
  return { operationId, method: "aggregate", status: method.status, needIds: ["plan"], purpose: `scenario ${input.id}`, frames: [frame], facts, objects: [], methods: [method], limitations: limits };
}
