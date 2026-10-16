"use client";

import { useEffect, useId, type MouseEvent, type ReactNode } from "react";
import { citationNumbers } from "../../lib/analytics/advisor";
import type { AnalyticsExplainResult, AdvisorField, AdvisorItem, AdvisorSource } from "../../lib/analytics/types";
import { MarkdownText } from "../chat/markdown-text";
import { useWorkspacePanel } from "../workspace/workspace-panel-context.ts";

const toolLabels: Record<string, string> = { inspect_dataset: "核对数据覆盖", query_metrics: "读取计算指标", discover_segments: "检查分析角度", read_analysis_evidence: "核对证据", analyze_snapshot: "按条件重新比较", inspect_historical_knowledge: "检查历史资料", read_historical_case: "读取历史案例", query_sales_history: "查询真实活动历史" };

function fieldText(field: AdvisorField, source: AdvisorSource): string {
  if (field.value === null) return "未提供或未计算";
  const value = typeof field.value === "number" ? field.value.toLocaleString("zh-CN", { maximumFractionDigits: 6 }) : field.value;
  return `${value}${source.kind === "database" && field.unit === "人民币" ? "元" : field.unit ?? ""}`;
}

function Observation({ item, sources, citation }: { item: AdvisorItem; sources: AdvisorSource[]; citation: (id: string) => ReactNode }) {
  // 只排版本条已经引用的指标与前三组结果；缺失值不补零，也不添加未引用的指标。
  const entries = item.evidenceIds.flatMap((id) => {
    const source = sources.find((value) => value.id === id);
    if (!source) return [];
    return source.rows.map((row) => ({ source, label: row.label, fields: row.fields.filter((field) => field.value !== null && (!item.metricLabels || item.metricLabels.includes(field.label))) }))
      .filter((row) => row.fields.length).slice(0, 3);
  });
  if (!entries.length) return <MarkdownText text={item.text} trailing={item.evidenceIds.map(citation)} />;
  const title = (entry: typeof entries[number]) => entries.filter((value) => value.source.id === entry.source.id).length > 1 ? `${entry.source.title} · ${entry.label}` : entry.source.title;
  const samePeriod = entries.every((entry) => entry.source.periodLabel === entries[0].source.periodLabel);
  if (entries.length === 1) {
    const entry = entries[0];
    return <div className="space-y-3">
      <p className="font-semibold leading-7 text-foreground">{title(entry)}{citation(entry.source.id)}</p>
      <p className="text-xs leading-5 text-muted-foreground">{entry.source.periodLabel}</p>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">{entry.fields.map((field, index) => <div key={index} className="min-w-0"><dt className="text-sm text-muted-foreground">{field.label}</dt><dd className="mt-1 break-words text-base font-semibold tabular-nums text-foreground">{fieldText(field, entry.source)}</dd></div>)}</dl>
    </div>;
  }
  const metrics = new Map<string, AdvisorField>();
  for (const entry of entries) for (const field of entry.fields) metrics.set(JSON.stringify([field.label, field.unit ?? ""]), field);
  return <div className="min-w-0 space-y-2">
    {samePeriod ? <p className="text-xs leading-5 text-muted-foreground">{entries[0].source.periodLabel}</p> : null}
    <div role="region" aria-label="数据对比，可左右滚动查看" tabIndex={0} className="max-w-full overflow-x-auto rounded-xl border border-border bg-card/85 focus-visible:ring-2 focus-visible:ring-ring">
      <table className="w-full border-collapse text-left text-sm leading-6">
        <caption className="sr-only">本次回答引用的数据对比</caption>
        <thead className="bg-secondary/60"><tr><th scope="col" className="min-w-28 border-b border-border px-4 py-3 align-top font-medium text-muted-foreground">指标</th>{entries.map((entry, index) => <th key={index} scope="col" className="min-w-40 border-b border-border px-4 py-3 align-top font-semibold text-foreground"><div className="flex items-start justify-between gap-2"><span className="min-w-0 break-words">{title(entry)}</span><span className="shrink-0 pt-0.5">{citation(entry.source.id)}</span></div>{!samePeriod ? <span className="mt-1 block text-xs font-normal text-muted-foreground">{entry.source.periodLabel}</span> : null}</th>)}</tr></thead>
        <tbody>{[...metrics].map(([key, metric]) => <tr key={key} className="border-b border-border last:border-0"><th scope="row" className="px-4 py-3 align-top font-medium text-muted-foreground">{metric.label}</th>{entries.map((entry, index) => {
          const field = entry.fields.find((value) => value.label === metric.label && (value.unit ?? "") === (metric.unit ?? ""));
          return <td key={index} className="whitespace-nowrap px-4 py-3 align-top tabular-nums text-foreground">{field ? fieldText(field, entry.source) : <span className="text-xs text-muted-foreground">未提供或未计算</span>}</td>;
        })}</tr>)}</tbody>
      </table>
    </div>
  </div>;
}

function SourceDetails({ source, onRows }: { source: AdvisorSource; onRows: (id: string) => void }) {
  return <div data-advisor-source className="min-w-0 select-text space-y-3">
    <p className="break-words text-sm font-medium leading-6">{source.title}</p>
    <div className="text-xs leading-6">
      <p><span className="text-muted-foreground">来源：</span>{source.kind === "database" ? "历史销售数据" : source.kind === "historical" ? "历史资料" : source.kind === "snapshot" ? "授权数据快照" : "当前报告数据"} · {source.provenance === "sample" ? "模拟或示例数据" : "用户提供数据"}</p>
      <p><span className="text-muted-foreground">周期：</span>{source.periodLabel}</p>
      <p className="break-words"><span className="text-muted-foreground">范围：</span>{source.scope}</p>
      <p className="break-words"><span className="text-muted-foreground">口径：</span>{source.definition}</p>
    </div>
    {source.rows.map((row, index) => <table key={`${row.label}-${index}`} className="w-full table-fixed border-collapse text-left text-xs leading-6">
      <caption className="pb-2 text-left font-medium">{row.label}</caption>
      <thead><tr className="border-b border-border bg-secondary/50"><th scope="col" className="w-2/3 px-3 py-2 font-medium text-muted-foreground">指标</th><th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">数值</th></tr></thead>
      <tbody>{row.fields.map((field, fieldIndex) => <tr key={fieldIndex} className="border-b border-border"><th scope="row" className="break-words px-3 py-2 align-top font-normal">{field.label}</th><td className="break-words px-3 py-2 text-right align-top font-medium tabular-nums">{fieldText(field, source)}</td></tr>)}</tbody>
    </table>)}
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">数据版本</summary><p className="mt-2 break-all leading-5">{source.datasetVersion}</p></details>
    {source.kind === "report" && source.reportEvidenceId ? <button type="button" onClick={() => onRows(source.reportEvidenceId!)} className="mt-2 min-h-10 text-sm text-primary underline underline-offset-4">查看该来源的销售明细</button> : null}
  </div>;
}

export function AdvisorAnswer({ explanation, onRows, conversational = false }: { explanation: AnalyticsExplainResult; onRows: (id: string) => void; conversational?: boolean }) {
  const answerId = useId();
  const { panelId, activeId, togglePanel, dismissPanel } = useWorkspacePanel();
  useEffect(() => () => dismissPanel(answerId), [answerId, dismissPanel]);
  const advice = explanation.advice ?? []; const sources = explanation.sources ?? []; const numbers = citationNumbers(advice);
  const selected = sources.find((source) => activeId === `${answerId}:source:${source.id}`)?.id ?? null;
  const toggleSource = (id: string, event: MouseEvent<HTMLButtonElement>) => {
    const source = sources.find((value) => value.id === id);
    if (source) togglePanel({ id: `${answerId}:source:${id}`, title: `出处 ${numbers.get(id)}`, label: "数据出处", content: <SourceDetails source={source} onRows={onRows} /> }, event.currentTarget);
  };
  const citation = (id: string) => <sup key={id} className="ml-1 inline-flex align-baseline leading-none" style={{ top: "-0.2em" }}><button type="button" aria-label={`查看数据出处${numbers.get(id)}`} aria-controls={panelId} aria-expanded={selected === id} onClick={(event) => toggleSource(id, event)} className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 no-underline transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-reduce:transition-none ${selected === id ? "bg-accent-foreground text-primary-foreground" : "bg-primary/10 text-accent-foreground hover:bg-primary/20"}`}><span className="text-[11px] font-semibold leading-none tabular-nums">{numbers.get(id)}</span></button></sup>;
  return <div className={`${conversational ? "" : "mt-4"} min-w-0 select-text`}>
    {explanation.partial ? <p role="status" className="mb-4 text-sm leading-6 text-muted-foreground">部分判断还需要进一步核对，以下保留了已核验的数据和可用建议。</p> : null}
    {advice.length ? <div data-advisor-body className="space-y-6">{advice.map((item, index) => <div key={index} className="min-w-0">
      {item.kind === "observation" ? <Observation item={item} sources={sources} citation={citation} /> : <>
        {item.target ? <p className="mb-2 text-sm font-semibold text-foreground">参考候选：{item.target.label}</p> : null}
        {item.kind === "hypothesis" ? <p className="mb-1 text-xs leading-6 text-muted-foreground">以下是可能的解释，仍需验证：</p> : null}
        <MarkdownText text={item.text} trailing={item.evidenceIds.map(citation)} />
      </>}
    </div>)}</div> : <p className="text-sm leading-6 text-muted-foreground">本次没有形成可采用的营销回答，可继续核对下方计算结果。</p>}
    {numbers.size ? <nav aria-label="回答的数据出处" className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3"><span className="text-xs text-muted-foreground">数据出处</span>{[...numbers].map(([id, n]) => <button key={id} type="button" onClick={(event) => toggleSource(id, event)} aria-label={`查看数据出处${n}`} aria-controls={panelId} aria-expanded={selected === id} className={`min-h-11 max-w-full rounded-lg border px-3 py-2 text-left text-xs text-primary hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring ${selected === id ? "border-primary/40 bg-secondary" : "border-border"}`}>出处 {n}</button>)}</nav> : null}
    {conversational && sources.some((s) => s.kind === "database" && s.limitations.some((limit) => /尚未.*对数/.test(limit))) ? <p className="mt-3 text-xs leading-6 text-muted-foreground">按源数据探索口径计算，尚未与 Power BI 对数；具体范围和口径可点角标查看。</p> : null}
    {!conversational && explanation.tools.length ? <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">本次实际读取动作</summary><p className="mt-2 leading-6">{explanation.tools.map((tool) => toolLabels[tool] ?? "读取分析证据").join(" → ")}</p>{explanation.skills?.length ? <p className="mt-1">已加载分析检查与周大福营销顾问规则。</p> : null}</details> : null}
  </div>;
}
