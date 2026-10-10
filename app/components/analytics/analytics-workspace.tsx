"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { AnalysisQuery, AnalysisReport, DatasetSummary } from "../../lib/analytics/types";
import { analyticsRequest, notifyAnalyticsChanged } from "../../lib/client/analytics";
import type { ReportSummary } from "../../lib/server/analytics-store";
import { DatasetImporter } from "./dataset-importer";
import { ReportView } from "./report-view";

const control = "mt-1 min-h-11 w-full rounded-lg border border-input bg-card px-3 text-sm";
const emptyQuery: AnalysisQuery = { period: { start: "", end: "" }, comparison: null, filters: {} };

export function AnalyticsWorkspace({ initialReportId }: { initialReportId?: string }) {
  const router = useRouter(); const [datasets, setDatasets] = useState<DatasetSummary[]>([]); const [history, setHistory] = useState<ReportSummary[]>([]);
  const [selected, setSelected] = useState<DatasetSummary | null>(null); const [query, setQuery] = useState<AnalysisQuery>(emptyQuery);
  const [report, setReport] = useState<AnalysisReport | null>(null); const [question, setQuestion] = useState("帮我找出值得核对的活动效果差异");
  const [booting, setBooting] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const active = useRef<AbortController | null>(null);
  const choose = (dataset: DatasetSummary) => {
    setSelected(dataset); setReport(null); setError("");
    const year = Number(dataset.maxDate.slice(0, 4)); const start = dataset.minDate > `${year}-01-01` ? dataset.minDate : `${year}-01-01`;
    setQuery({ period: { start, end: dataset.maxDate }, comparison: dataset.minDate.slice(0, 4) < String(year) ? { start: `${year - 1}${start.slice(4)}`, end: `${year - 1}${dataset.maxDate.slice(4)}` } : null, filters: {} });
  };
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        // 先初始化访问 cookie，再读取报告，避免首次并行请求生成不同访问标识。
        const loaded = await analyticsRequest<{ datasets: DatasetSummary[] }>("/api/analytics/datasets", undefined, controller.signal);
        const records = await analyticsRequest<{ reports: ReportSummary[] }>("/api/analytics/reports", undefined, controller.signal);
        if (controller.signal.aborted) return;
        setDatasets(loaded.datasets); setHistory(records.reports);
        const text = new URLSearchParams(window.location.search).get("question"); if (text) setQuestion(text.slice(0, 500));
        if (initialReportId) {
          const result = await analyticsRequest<{ report: AnalysisReport }>(`/api/analytics/reports/${initialReportId}`, undefined, controller.signal);
          let ds = loaded.datasets.find((d) => d.id === result.report.datasetId);
          if (!ds) ds = (await analyticsRequest<{ dataset: DatasetSummary }>(`/api/analytics/datasets/${result.report.datasetId}`, undefined, controller.signal)).dataset;
          if (!controller.signal.aborted) { setSelected(ds); setQuery(result.report.query); setReport(result.report); if (!text && result.report.question !== undefined) setQuestion(result.report.question); if (!loaded.datasets.some((d) => d.id === ds.id)) setDatasets([...loaded.datasets, ds]); }
        } else if (loaded.datasets[0]) {
          const ds = loaded.datasets[0]; const year = Number(ds.maxDate.slice(0, 4)); const start = ds.minDate > `${year}-01-01` ? ds.minDate : `${year}-01-01`;
          setSelected(ds); setQuery({ period: { start, end: ds.maxDate }, comparison: ds.minDate.slice(0, 4) < String(year) ? { start: `${year - 1}${start.slice(4)}`, end: `${year - 1}${ds.maxDate.slice(4)}` } : null, filters: {} });
        }
        notifyAnalyticsChanged();
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "分析记录无法读取"); }
      finally { if (!controller.signal.aborted) setBooting(false); }
    };
    void load(); return () => { controller.abort(); active.current?.abort(); };
  }, [initialReportId]);
  const imported = (dataset: DatasetSummary) => { setDatasets((d) => [dataset, ...d]); choose(dataset); };
  const analyze = async () => {
    if (!selected) return;
    const controller = new AbortController(); active.current = controller; setBusy(true); setError("");
    try {
      const result = await analyticsRequest<{ report: AnalysisReport }>("/api/analytics/reports", { datasetId: selected.id, query, question }, controller.signal);
      if (!controller.signal.aborted) { setReport(result.report); setHistory((h) => [result.report, ...h]); notifyAnalyticsChanged(); router.replace(`/analysis/${result.report.id}`); }
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "计算失败，请重试"); }
    finally { if (active.current === controller) setBusy(false); }
  };
  const filter = (key: keyof AnalysisQuery["filters"], value: string) => setQuery((q) => ({ ...q, filters: { ...q.filters, [key]: value ? [value] : [] } }));
  return <div className="mx-auto max-w-[1500px] p-4 md:p-7">
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-medium text-[var(--brand-ruby)]">周大福 · 营销决策</p><h1 className="mt-1 text-2xl font-semibold">从经营数据看活动效果</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">复盘历史活动，比较分组差异，每条结论都能查看数据依据。</p></div><Link href="/campaign/new" className="inline-flex min-h-11 items-center rounded-lg border border-border bg-card px-4 text-sm">进入活动执行</Link></header>
    {error ? <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-card p-3 text-sm text-destructive"><span>{error}</span>{!selected && !booting ? <button type="button" onClick={() => window.location.reload()} className="min-h-10 underline">重新加载</button> : null}</div> : null}
    <div className="grid items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="space-y-4" aria-label="分析数据与范围">
        <DatasetImporter onImported={imported} disabled={booting || busy} />
        {datasets.length ? <section className="rounded-xl border border-border bg-card p-4"><h2 className="font-semibold">选择数据与范围</h2><label className="mt-3 block text-sm">数据集<select className={control} value={selected?.id ?? ""} disabled={busy} onChange={(e) => { const ds = datasets.find((d) => d.id === e.target.value); if (ds) choose(ds); }}><option value="">请选择</option>{datasets.map((d) => <option key={d.id} value={d.id}>{d.provenance === "sample" ? "[示例] " : ""}{d.name}</option>)}</select></label>{selected ? <><p className="mt-2 text-xs text-muted-foreground">{selected.rowCount} 条明细，{selected.ruleCount} 条规则 · {selected.minDate} 至 {selected.maxDate}</p><div className="mt-3 grid grid-cols-2 gap-2"><label className="text-xs">分析开始<input type="date" className={control} value={query.period.start} disabled={busy} onChange={(e) => setQuery((q) => ({ ...q, period: { ...q.period, start: e.target.value } }))} /></label><label className="text-xs">分析结束<input type="date" className={control} value={query.period.end} disabled={busy} onChange={(e) => setQuery((q) => ({ ...q, period: { ...q.period, end: e.target.value } }))} /></label></div><label className="mt-3 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(query.comparison)} disabled={busy} onChange={(e) => setQuery((q) => ({ ...q, comparison: e.target.checked ? { start: `${Number(q.period.start.slice(0, 4)) - 1}${q.period.start.slice(4)}`, end: `${Number(q.period.end.slice(0, 4)) - 1}${q.period.end.slice(4)}` } : null }))} />设置比较期</label>{query.comparison ? <div className="grid grid-cols-2 gap-2"><label className="text-xs">比较开始<input type="date" className={control} value={query.comparison.start} disabled={busy} onChange={(e) => setQuery((q) => ({ ...q, comparison: { ...q.comparison!, start: e.target.value } }))} /></label><label className="text-xs">比较结束<input type="date" className={control} value={query.comparison.end} disabled={busy} onChange={(e) => setQuery((q) => ({ ...q, comparison: { ...q.comparison!, end: e.target.value } }))} /></label></div> : null}
          {([ ["regions", "区域", selected.facets.regions], ["categories", "货类", selected.facets.categories], ["stores", "门店", selected.facets.stores], ["memberSegments", "会员分组", selected.facets.memberSegments], ["campaignIds", "活动编号", selected.facets.campaignIds] ] as const).filter(([, , values]) => values.length).map(([key, label, values]) => <label key={key} className="mt-3 block text-sm">{label}<select className={control} disabled={busy} value={query.filters[key]?.[0] ?? ""} onChange={(e) => filter(key, e.target.value)}><option value="">全部</option>{values.map((v) => <option key={v} value={v}>{v}</option>)}</select></label>)}
          <label className="mt-3 block text-sm">关注的问题<textarea className={`${control} py-2`} rows={2} maxLength={500} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="例如：新老会员的活动表现有什么差异？" /></label>
          <button type="button" disabled={busy || !query.period.start || !query.period.end} onClick={() => void analyze()} className="mt-4 min-h-11 w-full rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy ? "正在计算并保存…" : "开始复盘"}</button>{busy ? <button type="button" onClick={() => { active.current?.abort(); setBusy(false); }} className="mt-2 min-h-10 w-full text-sm text-muted-foreground">停止等待</button> : null}</> : null}</section> : null}
        {history.length ? <section><h2 className="px-1 text-sm font-semibold">最近报告</h2><div className="mt-2 space-y-1">{history.slice(0, 8).map((h) => <Link key={h.id} href={`/analysis/${h.id}`} className="block rounded-lg border border-border bg-card p-3 text-sm hover:bg-secondary"><span className="line-clamp-1">{h.provenance === "sample" ? "[示例] " : ""}{h.datasetName}</span><span className="mt-1 block text-xs text-muted-foreground">{h.query.period.start} 至 {h.query.period.end}</span></Link>)}</div></section> : null}
      </aside>
      <section className="min-w-0" aria-label="分析结果">{report ? <ReportView key={report.id} report={report} question={question} dirty={JSON.stringify(query) !== JSON.stringify(report.query)} /> : <div className="rounded-xl border border-border bg-card p-6 md:p-8"><h2 className="text-lg font-semibold">{booting ? "正在读取分析记录…" : selected ? "数据已保存，选择范围后开始复盘" : "先选择一份经营数据"}</h2><p className="mt-3 text-sm leading-7 text-muted-foreground">复盘会计算净销售额、件数及可用的毛利，比较区域、门店、货类和会员分组。缺少的成本或标签会明确标记，每条差异都可查看原始明细。</p><div className="mt-6 border-t border-border pt-4"><p className="text-sm font-medium">当前交付范围</p><p className="mt-2 text-sm leading-7 text-muted-foreground">本期提供历史数据复盘和可核对的分组洞察。活动机制推荐、收益预测和执行系统提交需要后续验证。</p></div></div>}</section>
    </div>
  </div>;
}
