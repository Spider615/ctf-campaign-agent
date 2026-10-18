"use client";

import { useEffect, useRef, useState } from "react";
import { DIMENSION_LABELS, type AnalysisReport, type Dimension, type EvidenceResult } from "../../lib/analytics/types";
import { analyticsRequest, downloadCsv, explainAnalyticsReport } from "../../lib/client/analytics";
import { selectedInsights } from "../../lib/analytics/explain";
import { isPlanAnswer, type AnalyticsAnswerResult } from "../../lib/analytics/stream";
import { AdvisorAnswer } from "./advisor-answer";
import { PlanAnswerView } from "./plan-answer";
import { MarkdownText } from "../chat/markdown-text";
import { isConversationAnswer } from "../../lib/attachments/answer";

const number = (v: number | null, suffix = "") => v === null ? "未计算" : `${v.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${suffix}`;

export function ReportView({ report, dirty, question }: { report: AnalysisReport; dirty: boolean; question: string }) {
  const [dimension, setDimension] = useState<Dimension>(report.availableDimensions.includes("memberSegment") ? "memberSegment" : report.availableDimensions[0]);
  const [evidence, setEvidence] = useState<EvidenceResult | null>(null); const [error, setError] = useState("");
  const [loadingEvidence, setLoadingEvidence] = useState(false); const [busyQuestion, setBusyQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ question: string; result: AnalyticsAnswerResult } | null>(null);
  const explaining = !dirty && busyQuestion === question;
  const explanation = !dirty && answer?.question === question ? answer.result : null;
  const legacyExplanation = explanation && !isPlanAnswer(explanation) && !isConversationAnswer(explanation) ? explanation : null;
  const evidenceRequest = useRef<AbortController | null>(null); const explainRequest = useRef<AbortController | null>(null);
  useEffect(() => () => { evidenceRequest.current?.abort(); explainRequest.current?.abort(); }, []);
  useEffect(() => { explainRequest.current?.abort(); }, [question, dirty]);
  const showEvidence = async (id: string) => {
    evidenceRequest.current?.abort(); const controller = new AbortController(); evidenceRequest.current = controller; setLoadingEvidence(true); setError("");
    try {
      const result = await analyticsRequest<{ evidence: EvidenceResult }>(`/api/analytics/reports/${report.id}/evidence?evidenceId=${encodeURIComponent(id)}`, undefined, controller.signal);
      if (!controller.signal.aborted) setEvidence(result.evidence);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "证据无法读取"); }
    finally { if (evidenceRequest.current === controller) setLoadingEvidence(false); }
  };
  const explain = async () => {
    explainRequest.current?.abort();
    const controller = new AbortController(); explainRequest.current = controller; setBusyQuestion(question); setAnswer(null); setError("");
    try {
      const result = await explainAnalyticsReport(report, question, controller.signal);
      if (!controller.signal.aborted) setAnswer({ question, result });
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "AI 解读暂不可用；计算结果与明细仍可查看"); }
    finally { if (explainRequest.current === controller) setBusyQuestion(null); }
  };
  const highlighted = selectedInsights(report, legacyExplanation);
  return <article className="min-w-0 space-y-6" aria-labelledby="report-heading">
    <header className="border-b border-border pb-4">
      <div className="flex flex-wrap items-center gap-2"><span className="rounded-md bg-secondary px-2 py-1 text-xs text-secondary-foreground">{report.provenance === "sample" ? "模拟或示例数据，不能证明客户效果" : "用户导入数据"}</span><span className="text-xs text-muted-foreground">{new Date(report.createdAt).toLocaleString("zh-CN")}</span></div>
      <h2 id="report-heading" className="mt-3 text-xl font-semibold">{report.datasetName}</h2>
      <p className="mt-1 text-sm text-muted-foreground">分析期 {report.query.period.start} 至 {report.query.period.end}{report.query.comparison ? ` · 比较期 ${report.query.comparison.start} 至 ${report.query.comparison.end}` : " · 未设置比较期"}</p>
      {dirty ? <p role="status" className="mt-3 text-sm text-[var(--warning)]">筛选已变更，当前仍显示上次报告。重新分析后更新结果。</p> : null}
    </header>
    <dl className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {[["净销售额（元）", number(report.metrics.sales)], ["净件数", number(report.metrics.quantity)], ["毛利（元）", number(report.metrics.grossProfit)], ["销售变化", number(report.salesChangePercent, "%")]].map(([label, value]) => <div key={label} className="rounded-xl border border-border bg-card p-4"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-2 text-xl font-semibold tabular-nums">{value}</dd></div>)}
    </dl>
    <p className="text-xs text-muted-foreground">分析期 {report.metrics.rows} 条明细{report.baseline ? `，比较期 ${report.baseline.rows} 条` : ""}。退款已按导入负数扣减；毛利仅在成本完整时计算。</p>
    <section aria-labelledby="advisor-heading">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 id="advisor-heading" className="text-base font-semibold">营销分析与建议</h3><div className="flex gap-2"><button type="button" onClick={() => void explain()} disabled={explaining || dirty || !question.trim()} className="min-h-10 rounded-lg border border-border px-3 text-sm disabled:opacity-50">{explaining ? "小福正在核对数据…" : "分析问题并给建议"}</button>{explaining ? <button type="button" onClick={() => { explainRequest.current?.abort(); setBusyQuestion(null); }} className="min-h-10 px-3 text-sm text-muted-foreground">停止</button> : null}</div></div>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">关注问题：{question}</p>
      {explanation && isPlanAnswer(explanation) ? <div className="mt-4"><PlanAnswerView answer={explanation} /></div> : legacyExplanation?.reply ? <div className="mt-4"><MarkdownText text={legacyExplanation.reply} /></div> : legacyExplanation ? <AdvisorAnswer explanation={legacyExplanation} onRows={(id) => void showEvidence(id)} /> : <p className="mt-2 text-xs leading-6 text-muted-foreground">小福会核对当前数据，必要时重新比较或读取已启用的历史资料。回答中的数字角标可展开周期、口径与证据。</p>}
    </section>
    <section aria-labelledby="insights-heading">
      <h3 id="insights-heading" className="text-base font-semibold">值得核对的差异</h3>
      {highlighted.length ? <div className="mt-3 divide-y divide-border">{highlighted.map((insight) => <div key={insight.id} className="py-4"><h4 className="text-sm font-semibold">{insight.title}</h4><p className="mt-1 text-sm leading-6 text-muted-foreground">{insight.explanation}</p><button type="button" onClick={() => void showEvidence(insight.evidenceId)} className="mt-2 min-h-9 text-sm text-primary underline underline-offset-4">查看对应明细与活动规则</button></div>)}</div> : <p className="mt-3 text-sm leading-6 text-muted-foreground">{explanation ? "原报告未选出与当前问题匹配的分组洞察；新增比较和历史参考见上方回答，也可核对下方分组结果。" : "本范围未形成满足样本条件的分组洞察，可查看下方分组结果或扩大数据范围。"}</p>}
      {legacyExplanation?.nextDimensions.length ? <p className="mt-2 text-sm text-muted-foreground">小福建议继续核对：{legacyExplanation.nextDimensions.map((d) => DIMENSION_LABELS[d]).join("、")}。这些是分析方向，尚未证明因果。</p> : null}
    </section>
    <section aria-labelledby="groups-heading">
      <h3 id="groups-heading" className="text-base font-semibold">分组对比</h3>
      <div className="my-3 flex flex-wrap gap-2" aria-label="选择分组维度">{report.availableDimensions.map((d) => <button key={d} type="button" aria-pressed={dimension === d} onClick={() => setDimension(d)} className={`min-h-10 rounded-lg border px-3 text-sm ${dimension === d ? "border-primary bg-secondary text-secondary-foreground" : "border-border bg-card"}`}>{DIMENSION_LABELS[d]}</button>)}</div>
      <div className="overflow-x-auto rounded-xl border border-border bg-card"><table className="w-full text-left text-sm"><caption className="sr-only">{DIMENSION_LABELS[dimension]}净销售额与比较期变化，单位为 CNY 元</caption><thead className="border-b border-border bg-muted"><tr>{["分组", "分析期净销售额", "比较期净销售额", "变化", "分析期明细", "依据"].map((h) => <th key={h} className="whitespace-nowrap px-3 py-3 font-medium">{h}</th>)}</tr></thead><tbody>{report.groups.filter((g) => g.dimension === dimension).map((g) => <tr key={g.id} className="border-b border-border last:border-0"><th scope="row" className="max-w-60 break-words px-3 py-3 font-normal">{g.value}</th><td className="px-3 py-3 tabular-nums">{g.current?.rows ? number(g.current.sales) : "无明细"}</td><td className="px-3 py-3 tabular-nums">{report.query.comparison ? (g.baseline?.rows ? number(g.baseline.sales) : "无明细") : "未设置"}</td><td className="px-3 py-3 tabular-nums">{number(g.current?.rows && g.baseline?.rows ? g.salesChangePercent : null, "%")}</td><td className="px-3 py-3 tabular-nums">{g.current?.rows ?? 0}</td><td className="px-3 py-3"><button type="button" onClick={() => void showEvidence(g.id)} className="min-h-10 whitespace-nowrap text-primary underline">明细</button></td></tr>)}</tbody></table></div>
    </section>
    <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="evidence-heading">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 id="evidence-heading" className="font-semibold">数据依据</h3><button type="button" onClick={() => void showEvidence("overall")} disabled={loadingEvidence} className="min-h-10 text-sm text-primary underline">{loadingEvidence ? "读取明细…" : "查看本次全部明细"}</button></div>
      <p className="mt-2 break-all text-xs text-muted-foreground">数据版本 {report.datasetVersion}</p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">净销售额按分汇总；毛利 = 净销售额 − 净销售成本；增长率 =（本期 − 比较期）/ 比较期，仅在比较期大于 0 时计算。</p>
      {Object.entries(report.query.filters).some(([, v]) => v?.length) ? <p className="mt-2 text-xs text-muted-foreground">报告筛选：{Object.values(report.query.filters).filter((v) => v?.length).map((v) => v!.join("、")).join("；")}</p> : null}
      <details className="mt-3"><summary className="cursor-pointer text-sm">数据覆盖与计算限制（{report.limitations.length}）</summary><ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">{report.limitations.map((l) => <li key={l}>· {l}</li>)}</ul></details>
      {evidence ? <div className="mt-4 border-t border-border pt-3"><h4 className="text-sm font-medium">{evidence.title}</h4><div className="mt-2 flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">本期 {evidence.currentRows.length} 条，比较期 {evidence.baselineRows.length} 条。下方显示前 50 条。</p><button type="button" onClick={() => downloadCsv("分析证据.csv", [["所属时期", "明细ID", "日期", "门店", "货类", "净销售额（元）", "件数", "成本（元）", "会员分组", "活动编号"], ...evidence.currentRows.map((r) => ["分析期", r.lineId, r.date, r.store, r.category, r.netSales, r.quantity, r.cost, r.memberSegment, r.campaignId]), ...evidence.baselineRows.map((r) => ["比较期", r.lineId, r.date, r.store, r.category, r.netSales, r.quantity, r.cost, r.memberSegment, r.campaignId])])} className="min-h-10 text-sm text-primary underline">导出全部证据明细</button></div><div className="mt-2 overflow-x-auto"><table className="w-full text-left text-xs"><caption className="sr-only">选中证据的销售明细</caption><thead><tr>{["时期", "明细ID", "日期", "门店", "货类", "净销售额（元）", "会员分组"].map((h) => <th key={h} className="whitespace-nowrap border-b border-border px-2 py-2">{h}</th>)}</tr></thead><tbody>{[...evidence.currentRows.map((r) => ({ ...r, side: "分析期" })), ...evidence.baselineRows.map((r) => ({ ...r, side: "比较期" }))].slice(0, 50).map((r) => <tr key={`${r.side}:${r.lineId}`}><td className="px-2 py-2">{r.side}</td><td className="max-w-36 break-all px-2 py-2">{r.lineId}</td><td className="whitespace-nowrap px-2 py-2">{r.date}</td><td className="px-2 py-2">{r.store}</td><td className="px-2 py-2">{r.category}</td><td className="px-2 py-2 tabular-nums">{number(r.netSales)}</td><td className="px-2 py-2">{r.memberSegment ?? "未提供"}</td></tr>)}</tbody></table></div>{evidence.rules.length ? <div className="mt-3 text-xs leading-6"><strong>对应活动规则</strong>{evidence.rules.map((r, i) => <p key={`${r.campaignId}-${i}`}>{r.name}（{r.campaignId}）：{r.mechanism ?? "机制未提供"}，力度 {r.discountValue ?? "未提供"}</p>)}</div> : <p className="mt-3 text-xs text-muted-foreground">这些明细没有可用活动规则，无法解释具体优惠力度。</p>}</div> : null}
    </section>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </article>;
}
