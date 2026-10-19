"use client";

import { Hammer, MessageCircle } from "lucide-react";
import { INSIGHT_DIMENSIONS, INSIGHT_GROUPS } from "../../lib/insight/ontology";
import { INSIGHT_METRICS } from "../../lib/insight/metrics";
import { highlightOf, influenceList } from "../../lib/insight/highlight";
import { INSIGHT_SOURCE_LABEL, isRealSource, type InsightDimensionId, type InsightEdge, type InsightGraph, type InsightMetricId, type InsightNode, type InsightSource } from "../../lib/insight/types";
import { SOURCE_STYLE, type InsightSelection } from "./insight-graph-view";

const format = (value: number | null, unit: string) => value === null ? "—" : `${value.toLocaleString("zh-CN", { maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1 })}${unit === "%" ? "%" : ""}`;

function Section({ title, tone = "plain", children }: { title: string; tone?: "plain" | "basis" | "anomaly" | "advice"; children: React.ReactNode }) {
  const accent = { plain: "border-[#dbe8f7]", basis: "border-l-[#247cff]", anomaly: "border-l-[#e0794c]", advice: "border-l-[#20a674]" }[tone];
  return <section className={`rounded-xl border border-[#dbe8f7] bg-white p-4 ${tone === "plain" ? "" : `border-l-4 ${accent}`}`}>
    <h3 className="text-[13px] font-semibold text-[#27415f]">{title}</h3>
    <div className="mt-2 space-y-1.5 text-[13px] leading-6 text-[#425a78]">{children}</div>
  </section>;
}

// 来源说明：数据里真实存在的写清字段和算法；AI 判断的单独一段写明判断内容。
function SourceBlock({ source }: { source: InsightSource }) {
  const style = SOURCE_STYLE[source.kind]; const real = isRealSource(source.kind);
  return <section className="rounded-xl border p-3 text-[12px] leading-5" style={{ borderColor: style.stroke, background: style.fill }}>
    <p className="flex items-center gap-1.5 font-semibold" style={{ color: style.text }}>
      {style.tag ? <span className="inline-grid h-[18px] min-w-[18px] place-items-center rounded px-1 text-[11px] text-white" style={{ background: style.stroke }}>{style.tag}</span> : null}
      {INSIGHT_SOURCE_LABEL[source.kind]}{real ? "：数据文件里真实存在" : source.kind === "grouping" ? "" : "：不是数据里直接有的"}
    </p>
    {source.columns.length ? <p className="mt-1.5 text-[#425a78]">字段：{source.columns.map((c) => <code key={c} className="mx-0.5 rounded bg-white/80 px-1 py-0.5 text-[11px] text-[#1d3557]">{c}</code>)}</p> : null}
    <p className="mt-1 text-[#425a78]">{source.how}</p>
    {source.judgement ? <p className="mt-1.5 rounded-lg bg-white/70 px-2 py-1.5 text-[#4b3a86]"><span className="font-medium">AI 判断：</span>{source.judgement}</p> : null}
  </section>;
}

// 影响到哪些参数：维度给数据算出的强度（可点切换中心指标），待采集项给 AI 推测的列表。
function Affects({ graph, node, onSelect, onMetric }: { graph: InsightGraph; node: InsightNode; onSelect: (s: InsightSelection) => void; onMetric?: (metric: InsightMetricId, dimension: InsightDimensionId) => void }) {
  const lit = highlightOf(graph, { kind: "node", id: node.id });
  const dims = [...(lit?.nodes ?? [])].filter((id) => id.startsWith("dim:") && id !== node.id).map((id) => id.slice(4) as InsightDimensionId);
  const dim = node.id.startsWith("dim:") ? node.id.slice(4) as InsightDimensionId : null;
  if (dim) {
    const list = influenceList(graph, dim);
    if (!list.length) return null;
    return <Section title="影响到哪些参数">
      <p className="text-[12px] text-[#7187a1]">同一份数据里，这个维度的不同取值让各指标差别多大（0–100），橙色是明显影响的。点指标名把图的中心换成它。</p>
      <ul className="mt-1 space-y-1">{list.map(({ metric, strength }) => <li key={metric} className="flex items-center gap-2">
        {onMetric && metric !== graph.metric.id && strength !== null ? <button type="button" onClick={() => onMetric(metric, dim)} title={`把中心换成${INSIGHT_METRICS[metric].label}，看${INSIGHT_DIMENSIONS[dim].label}这条线`} className="w-24 shrink-0 truncate text-left text-[12px] text-[#2470cc] underline-offset-2 hover:underline">{INSIGHT_METRICS[metric].label}</button>
          : <span className={`w-24 shrink-0 truncate text-[12px] ${metric === graph.metric.id ? "font-semibold text-[#174e96]" : ""}`}>{INSIGHT_METRICS[metric].label}</span>}
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#eef3f9]"><span className={`block h-full rounded-full ${(strength ?? 0) >= 0.2 ? "bg-[#f59e0b]" : "bg-[#c5d0dc]"}`} style={{ width: `${Math.round((strength ?? 0) * 100)}%` }} /></span>
        <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-[#5c7392]">{strength === null ? "—" : Math.round(strength * 100)}</span>
      </li>)}</ul>
      {dim && graph.edges.some((e) => e.dimension === dim) ? <button type="button" onClick={() => onSelect({ kind: "edge", dimension: dim })} className="mt-1 min-h-10 text-[13px] text-[#2470cc] underline-offset-4 hover:underline">看它和{graph.metric.label}的依据、异常、推荐</button> : null}
    </Section>;
  }
  const metrics = [...(lit?.metrics.keys() ?? [])] as InsightMetricId[];
  if (!dims.length && !metrics.length) return null;
  return <Section title={node.kind === "missing" ? "AI 推测它会影响" : "包含的维度"}>
    {dims.length ? <div className="flex flex-wrap gap-1.5">{dims.map((d) => <button key={d} type="button" onClick={() => onSelect({ kind: "node", id: `dim:${d}` })} className="min-h-8 rounded-lg border border-[#f3d38a] bg-[#fffaf0] px-2 text-[12px] text-[#7a5a10] hover:bg-[#fff3d6]">{INSIGHT_DIMENSIONS[d].label}</button>)}</div> : null}
    {metrics.length ? <p className="text-[12px]">指标：{metrics.map((m) => INSIGHT_METRICS[m]?.label ?? m).join("、")}</p> : null}
    {node.kind === "missing" ? <p className="text-[11px] text-[#8a6a12]">这是 AI 的推测，补上数据后才能验证。</p> : null}
  </Section>;
}

function Limitations({ graph }: { graph: InsightGraph }) {
  return <details className="rounded-xl border border-[#ebe3cf] bg-[#fffcf3] p-3 text-[12px] leading-5 text-[#6f5b25]">
    <summary className="cursor-pointer font-medium">读这张图前要知道的（{graph.limitations.length} 条）</summary>
    <ul className="mt-2 list-disc space-y-1 pl-4">{graph.limitations.map((line) => <li key={line}>{line}</li>)}</ul>
  </details>;
}

function EdgeTable({ edge, unit }: { edge: InsightEdge; unit: string }) {
  return <div className="overflow-x-auto rounded-xl border border-[#dbe8f7] bg-white">
    <table className="w-full min-w-[320px] text-left text-[12px]">
      <caption className="sr-only">各取值的活动值、对照值和差值</caption>
      <thead className="bg-[#f4f8fd] text-[#5c7392]"><tr><th scope="col" className="px-3 py-2 font-medium">取值</th><th scope="col" className="px-2 py-2 text-right font-medium">活动</th><th scope="col" className="px-2 py-2 text-right font-medium">对照</th><th scope="col" className="px-2 py-2 text-right font-medium">比较值</th><th scope="col" className="px-3 py-2 text-right font-medium">活动行数</th></tr></thead>
      <tbody>{edge.table.map((row) => <tr key={row.value} className={`border-t border-[#eef3f9] ${row.small ? "text-[#a3b1c2]" : "text-[#27415f]"} ${row.value === edge.best ? "bg-[#effaf5]" : ""}`}>
        <th scope="row" className="max-w-[140px] truncate px-3 py-1.5 font-normal" title={row.value}>{row.value}{row.small ? <span className="ml-1 text-[10px]">样本少</span> : null}</th>
        <td className="px-2 py-1.5 text-right tabular-nums">{format(row.offer, unit)}</td>
        <td className="px-2 py-1.5 text-right tabular-nums">{format(row.base, unit)}</td>
        <td className="px-2 py-1.5 text-right font-medium tabular-nums">{format(row.delta, unit)}</td>
        <td className="px-3 py-1.5 text-right tabular-nums">{row.rows.toLocaleString("zh-CN")}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export function InsightSidePanel({ graph, selection, onAsk, onDraft, onSelect, onMetric }: { graph: InsightGraph; selection: InsightSelection | null; onAsk: (edge: InsightEdge | null) => void; onDraft: (text: string) => void; onSelect: (selection: InsightSelection) => void; onMetric?: (metric: InsightMetricId, dimension: InsightDimensionId) => void }) {
  const metric = graph.metric; const spec = INSIGHT_METRICS[metric.id];
  const ask = (edge: InsightEdge | null) => <button type="button" onClick={() => onAsk(edge)} className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-[#c7ddff] bg-white px-3 text-sm font-medium text-[#174e96] hover:bg-[#f5f9ff] focus-visible:ring-2 focus-visible:ring-ring"><MessageCircle aria-hidden="true" className="size-4" />问一问</button>;

  if (!selection || selection.kind === "metric") {
    return <div className="space-y-3">
      <SourceBlock source={graph.nodes.find((n) => n.id === "metric")!.source} />
      <Section title={`${metric.label}${metric.status === "inferred" ? "（口径推断）" : metric.status === "missing" ? "（暂时算不了）" : ""}`}>
        <p>{metric.definition}</p>
        {metric.status !== "missing" ? <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
          {(metric.id === "penetration" ? [["渗透率", metric.offer]] as const : [[`活动（${graph.request.offer}）`, metric.offer], ["一般開單", metric.base], [metric.id === "give_per_gram" ? "同日对齐" : "差值", metric.delta]] as const).map(([k, v]) => <div key={k} className="rounded-lg bg-[#f4f8fd] p-2"><dt className="text-[11px] text-[#7187a1]">{k}</dt><dd className="mt-0.5 text-[15px] font-semibold tabular-nums text-[#20314d]">{format(v, metric.unit)}<span className="ml-0.5 text-[10px] font-normal text-[#7187a1]">{metric.unit}</span></dd></div>)}
        </dl> : null}
      </Section>
      <Section title="实收拆成四段：活动比一般開單多或少在哪">
        {graph.decomposition.map((d) => <div key={d.label} className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-[12px]">{d.label}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-[#eef3f9]"><span className={`block h-full rounded-full ${(d.share ?? 0) >= 0 ? "bg-[#247cff]" : "bg-[#e0794c]"}`} style={{ width: `${Math.min(100, Math.abs(d.share ?? 0) * 100)}%` }} /></span>
          <span className="w-28 shrink-0 text-right text-[11px] tabular-nums text-[#5c7392]">{format(d.offer, "")} / {format(d.base, "")}</span>
        </div>)}
        <p className="text-[11px] text-[#7187a1]">每行是 活动 / 一般開單；条长是这一段对两者差距的贡献（对数分解）。订单数差距主要是两类成交的规模不同，不代表活动拉来了多少单。</p>
      </Section>
      <Section title="怎么看这张图"><p>四周每个维度连到中心的线，粗细表示这个维度的不同取值之间{spec.label}差别有多大。点一条线看依据、异常和推荐；点黄框看还缺什么数据。</p></Section>
      <div className="flex gap-2">{ask(null)}</div>
      <Limitations graph={graph} />
    </div>;
  }

  if (selection.kind === "source") {
    const nodes = graph.nodes.filter((n) => n.source.kind === selection.source && n.kind !== "group");
    const style = SOURCE_STYLE[selection.source];
    return <div className="space-y-3">
      <Section title={`${INSIGHT_SOURCE_LABEL[selection.source]}（${nodes.length} 项）`}>
        <p className="text-[12px] text-[#7187a1]">{isRealSource(selection.source) ? "这些在数据文件里真实存在，取值和算法都能对上原始字段。" : selection.source === "inferred" ? "这些取值来自数据，但含义或归类是 AI 的解读，需要业务确认。" : "这些数据里没有，是 AI 认为会影响活动效果、建议采集的。"}</p>
        <ul className="mt-1 space-y-1">{nodes.map((n) => <li key={n.id}><button type="button" onClick={() => onSelect({ kind: "node", id: n.id })} className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-[#f4f8fd]">
          <span className="font-medium" style={{ color: style.text }}>{n.label}</span>
          <span className="mt-0.5 block text-[11px] text-[#7187a1]">{n.source.judgement ?? n.source.how}</span>
        </button></li>)}</ul>
      </Section>
    </div>;
  }

  if (selection.kind === "link") {
    const target = selection.to === "center" ? graph.nodes.find((n) => n.id === `group:${selection.group}`) : graph.nodes.find((n) => n.id === selection.to);
    if (!target) return null;
    return <div className="space-y-3">
      <div className="rounded-xl bg-[linear-gradient(145deg,#f8fbff,#eaf4ff)] px-4 py-3">
        <p className="text-[11px] text-[#7187a1]">{selection.to === "center" ? `${metric.label} ← ${INSIGHT_GROUPS[selection.group].label}` : `${INSIGHT_GROUPS[selection.group].label} → ${target.label}`}</p>
        <p className="mt-1 text-sm font-semibold text-[#20314d]">{selection.to === "center" ? `${INSIGHT_GROUPS[selection.group].label}这一组的维度` : `${target.label}：数据里没有，AI 补全`}</p>
      </div>
      {selection.to === "center" ? <Section title="这一组的维度和它们的关系">
        {graph.nodes.filter((n) => n.group === selection.group && n.kind !== "group").map((n) => { const edge = n.id.startsWith("dim:") ? graph.edges.find((e) => `dim:${e.dimension}` === n.id) : null;
          return <button key={n.id} type="button" onClick={() => onSelect(edge ? { kind: "edge", dimension: edge.dimension } : { kind: "node", id: n.id })} className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[#f4f8fd]">
            <span className="flex items-center gap-1.5"><span className="inline-grid h-4 min-w-4 place-items-center rounded px-0.5 text-[10px] text-white" style={{ background: SOURCE_STYLE[n.source.kind].stroke }}>{SOURCE_STYLE[n.source.kind].tag}</span>{n.label}</span>
            <span className="text-[12px] text-[#7187a1]">{edge ? edge.weak ? "关系弱" : `强度 ${Math.round((edge.strength ?? 0) * 100)}` : n.kind === "missing" ? "待采集" : "—"}</span>
          </button>; })}
      </Section> : <><SourceBlock source={target.source} /><Affects graph={graph} node={target} onSelect={onSelect} /></>}
    </div>;
  }

  if (selection.kind === "node") {
    const node = graph.nodes.find((n) => n.id === selection.id);
    if (!node) return null;
    return <div className="space-y-3">
      <SourceBlock source={node.source} />
      <Section title={node.label}>
        {node.status === "missing" ? <p className="rounded-lg bg-[#fff8e1] px-3 py-2 text-[#6f5b25]">{node.note ?? "这一项现在没有数据"}</p> : node.note ? <p className="text-[12px] text-[#7187a1]">{node.note}</p> : null}
        {node.facts.length ? <dl className="divide-y divide-[#eef3f9]">{node.facts.map((f) => <div key={f.label} className="flex justify-between gap-3 py-1.5"><dt className="truncate text-[#5c7392]" title={f.label}>{f.label}</dt><dd className="shrink-0 tabular-nums text-[#20314d]">{f.value}</dd></div>)}</dl> : null}
        {node.kind === "group" ? <p className="text-[12px] text-[#7187a1]">点这一组下面的维度连线，看它和{metric.label}的关系。</p> : null}
      </Section>
      <Affects graph={graph} node={node} onSelect={onSelect} onMetric={onMetric} />
      <Limitations graph={graph} />
    </div>;
  }

  const edge = graph.edges.find((e) => e.dimension === selection.dimension);
  if (!edge) return null;
  const dim = INSIGHT_DIMENSIONS[edge.dimension];
  return <div className="space-y-3">
    <div className="rounded-xl bg-[linear-gradient(145deg,#f8fbff,#eaf4ff)] px-4 py-3">
      <p className="text-[11px] text-[#7187a1]">{dim.label} → {metric.label}</p>
      <p className="mt-1 text-sm font-semibold text-[#20314d]">{edge.weak ? "关系弱：各取值之间差别不大" : `关系强度 ${Math.round((edge.strength ?? 0) * 100)} / 100`}</p>
      {dim.note ? <p className="mt-1 text-[11px] leading-5 text-[#7187a1]">{dim.note}</p> : null}
    </div>
    <SourceBlock source={graph.nodes.find((n) => n.id === `dim:${edge.dimension}`)!.source} />
    <Section title="依据" tone="basis">{edge.basis.map((line) => <p key={line}>{line}</p>)}</Section>
    <Section title="异常" tone="anomaly">{edge.anomalies.length ? edge.anomalies.map((line) => <p key={line}>{line}</p>) : <p className="text-[#7187a1]">没有明显偏离的取值。</p>}</Section>
    <Section title="推荐" tone="advice">{edge.recommendation ? <p>{edge.recommendation}</p> : <p className="text-[#7187a1]">样本不够，暂不推荐。</p>}{edge.weak && edge.recommendation ? <p className="text-[12px] text-[#7187a1]">这个维度关系弱，按它来选门店或时间意义不大。</p> : null}</Section>
    <div className="flex gap-2">
      {ask(edge)}
      <button type="button" disabled={!edge.draft} onClick={() => edge.draft && onDraft(edge.draft)} title={edge.draft ? undefined : "关系弱或样本不够时不建议按这个建活动"} className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#174e96] px-3 text-sm font-medium text-white hover:bg-[#123f7a] focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-[#b7c7da]"><Hammer aria-hidden="true" className="size-4" />按这个建活动</button>
    </div>
    <EdgeTable edge={edge} unit={metric.unit} />
    <Affects graph={graph} node={graph.nodes.find((n) => n.id === `dim:${edge.dimension}`)!} onSelect={onSelect} onMetric={onMetric} />
    <p className="text-[11px] leading-5 text-[#7187a1]">比较值：{metric.id === "give_per_gram" ? "该取值下同日对齐的每克让利" : metric.id === "penetration" ? "该取值下的渗透率" : "该取值下活动值减一般開單"}。单位 {metric.unit}。绿色行是推荐取值，灰色行样本太少未参与比较。</p>
    <Limitations graph={graph} />
  </div>;
}
