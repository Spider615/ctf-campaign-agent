"use client";

import { useState } from "react";
import { inspectFile, RULE_FIELDS, SALES_FIELDS, suggestMapping } from "../../lib/analytics/import";
import { MAX_IMPORT_BYTES, type DatasetSummary, type FieldSpec, type ImportFile } from "../../lib/analytics/types";
import { analyticsRequest, downloadCsv, notifyAnalyticsChanged } from "../../lib/client/analytics";

const control = "mt-1 min-h-11 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground";
type FileState = { file: ImportFile; headers: string[]; count: number };

function Mapping({ title, state, fields, onChange }: { title: string; state: FileState; fields: FieldSpec[]; onChange: (mapping: Record<string, string>) => void }) {
  return <details className="mt-3 rounded-lg border border-border p-3" open>
    <summary className="cursor-pointer text-sm font-medium">{title} · {state.count} 行</summary>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {fields.map((f) => <label key={f.key} className="text-xs text-muted-foreground">{f.label}{f.required ? " *" : "（可选）"}
        <select className={control} value={state.file.mapping?.[f.key] ?? ""} onChange={(e) => onChange({ ...state.file.mapping, [f.key]: e.target.value })}>
          <option value="">{f.required ? "请选择对应列" : "未提供"}</option>
          {state.headers.map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
      </label>)}
    </div>
  </details>;
}

export function DatasetImporter({ onImported, disabled }: { onImported: (dataset: DatasetSummary) => void; disabled?: boolean }) {
  const [name, setName] = useState(""); const [sales, setSales] = useState<FileState | null>(null); const [rules, setRules] = useState<FileState | null>(null);
  const [simulated, setSimulated] = useState(false);
  const [inputEpoch, setInputEpoch] = useState(0);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const load = async (file: File | undefined, kind: "sales" | "rules") => {
    if (!file) { if (kind === "rules") setRules(null); return; }
    setError("");
    try {
      if (file.size > MAX_IMPORT_BYTES || !/\.(csv|json)$/i.test(file.name)) throw new Error("请选择不超过 1 MiB 的 CSV 或 JSON 文件");
      const content = await file.text(); const format = /\.json$/i.test(file.name) ? "json" : "csv";
      const table = inspectFile(content, format);
      const state = { file: { content, format, fileName: file.name, mapping: suggestMapping(table.headers, kind === "sales" ? SALES_FIELDS : RULE_FIELDS) } as ImportFile, headers: table.headers, count: table.count };
      if (kind === "sales") { setSales(state); if (!name) setName(file.name.replace(/\.[^.]+$/, "").slice(0, 80)); } else setRules(state);
    } catch (e) { setError(e instanceof Error ? e.message : "文件无法读取"); if (kind === "sales") setSales(null); else setRules(null); }
  };
  const save = async (sample = false) => {
    setBusy(true); setError("");
    try {
      const { dataset } = await analyticsRequest<{ dataset: DatasetSummary }>("/api/analytics/datasets", sample ? { sample: true } : {
        name, provenance: simulated ? "sample" : "imported", currency: "CNY", sales: sales?.file, ...(rules ? { campaigns: rules.file } : {}),
      });
      onImported(dataset); notifyAnalyticsChanged(); setSales(null); setRules(null); setName(""); setSimulated(false);
      setInputEpoch((current) => current + 1);
    } catch (e) { setError(e instanceof Error ? e.message : "导入失败，请重试"); } finally { setBusy(false); }
  };
  return <section className="rounded-xl border border-border bg-card p-4" aria-labelledby="import-heading">
    <h2 id="import-heading" className="text-base font-semibold">导入经营数据</h2>
    <p className="mt-1 text-xs leading-5 text-muted-foreground">CSV / JSON，最多 2000 条明细。净销售额与成本均为明细合计的 CNY 元，成本不是单件成本；退款用负数。记录按当前浏览器访问标识隔离。</p>
    <div className="mt-3 flex flex-wrap gap-3 text-xs">
      <button type="button" onClick={() => downloadCsv("销售明细模板.csv", [SALES_FIELDS.map((f) => f.label)])} className="min-h-9 text-primary underline underline-offset-4">销售明细模板</button>
      <button type="button" onClick={() => downloadCsv("活动规则模板.csv", [RULE_FIELDS.map((f) => f.label)])} className="min-h-9 text-primary underline underline-offset-4">活动规则模板</button>
    </div>
    <label className="mt-3 block text-sm">数据集名称<input maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className={control} placeholder="例如：2025、2026 年八九月销售" disabled={busy || disabled} /></label>
    <label className="mt-3 block text-sm">销售明细 *<input key={`sales-${inputEpoch}`} type="file" accept=".csv,.json" onChange={(e) => void load(e.target.files?.[0], "sales")} disabled={busy || disabled} className="mt-2 block w-full text-xs file:mr-2 file:min-h-10 file:rounded-lg file:border file:border-border file:bg-background file:px-3" /></label>
    <label className="mt-3 block text-sm">活动规则（可选）<input key={`rules-${inputEpoch}`} type="file" accept=".csv,.json" onChange={(e) => void load(e.target.files?.[0], "rules")} disabled={busy || disabled} className="mt-2 block w-full text-xs file:mr-2 file:min-h-10 file:rounded-lg file:border file:border-border file:bg-background file:px-3" /></label>
    {sales ? <Mapping title="确认销售字段" state={sales} fields={SALES_FIELDS} onChange={(mapping) => setSales({ ...sales, file: { ...sales.file, mapping } })} /> : null}
    {rules ? <Mapping title="确认活动字段" state={rules} fields={RULE_FIELDS} onChange={(mapping) => setRules({ ...rules, file: { ...rules.file, mapping } })} /> : null}
    <label className="mt-3 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={simulated} onChange={(e) => setSimulated(e.target.checked)} disabled={busy || disabled} />这是一份模拟数据，报告需明确标注</label>
    {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
    <button type="button" disabled={busy || disabled || !sales || !name.trim()} onClick={() => void save()} className="mt-4 min-h-11 w-full rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50">{busy ? "正在保存…" : "确认字段并导入"}</button>
    <button type="button" disabled={busy || disabled} onClick={() => void save(true)} className="mt-2 min-h-11 w-full rounded-lg border border-border px-3 text-sm disabled:opacity-50">体验虚构示例数据</button>
  </section>;
}
