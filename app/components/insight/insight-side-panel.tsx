"use client";

import { AlertTriangle, ChevronRight, Database, Lightbulb, MessageCircle, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { edgeKey, findEdge, findNode, routes, routesThrough, type InsightSelection } from "../../lib/insight/paths";
import { INSIGHT_EDGE_SOURCE, INSIGHT_KIND_LABEL, INSIGHT_SOURCE_LABEL, INSIGHT_STRENGTH_LABEL, type InsightEdge, type InsightGraph, type InsightNode, type InsightNodeId, type InsightTable } from "../../lib/insight/types";
import { SOURCE_TAG, STRENGTH_STYLE, scoreText } from "./insight-graph-view";

const ORDER = { strong: 0, id: 1, med: 2, weak: 3, missing: 4 } as const;
const byStrength = (a: InsightEdge, b: InsightEdge) => ORDER[a.strength] - ORDER[b.strength] || (b.score?.value ?? 0) - (a.score?.value ?? 0);

// 档位小标：有分数显示分数，没有显示档位名。
function Lk({ edge }: { edge: InsightEdge }) {
  const tone = edge.strength === "strong" ? "bg-[#eaf0ff] text-[#1d4ed8]" : edge.strength === "med" ? "bg-[#f1f5fb] text-[#3b5bdb]" : edge.strength === "missing" ? "bg-[#fdf1d8] text-[#a16207]" : "bg-[#f1f5f9] text-[#64748b]";
  return <span className={`mx-1 inline-block rounded-md px-1.5 align-[1px] text-[10.5px] font-semibold leading-4 tabular-nums ${tone}`}>{edge.score ? scoreText(edge) : INSIGHT_STRENGTH_LABEL[edge.strength]}</span>;
}

// 解释度条：0–100 的横条，下面写口径。没有分数时写效应值或档位。
function ScoreBar({ x }: { x: { strength?: InsightEdge["strength"]; score?: InsightEdge["score"]; effect?: InsightEdge["effect"] } }) {
  if (!x.strength) return null;
  const color = STRENGTH_STYLE[x.strength].stroke;
  if (x.score) return <div className="rounded-xl border border-[#e4eaf2] bg-white p-3">
    <div className="flex items-baseline justify-between"><span className="text-[12px] text-[#64748b]">解释度分数</span>
      <span className="text-[22px] font-semibold leading-none tracking-tight tabular-nums text-[#0f172a]">{x.score.value.toFixed(1)}<span className="ml-1 text-[12px] font-medium text-[#94a3b8]">/ 100 · {INSIGHT_STRENGTH_LABEL[x.strength]}</span></span></div>
    <div className="relative mt-2.5 h-1.5 overflow-hidden rounded-full bg-[#eef2f7]">
      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.max(2, x.score.value)}%`, background: color }} />
      {[2, 10].map((t) => <span key={t} className="absolute inset-y-0 w-px bg-white" style={{ left: `${t}%` }} />)}
    </div>
    <p className="mt-2 text-[11.5px] leading-relaxed text-[#64748b]">{x.score.measure}</p>
    {x.effect ? <p className="mt-2 border-t border-[#eef2f7] pt-2 text-[12px] text-[#334155]"><span className="mr-1.5 text-[#94a3b8]">直观看</span><b className="font-semibold">{x.effect.text}</b><span className="ml-1 text-[#94a3b8]">（{x.effect.measure.split("；")[0]}）</span></p> : null}
  </div>;
  if (x.effect) return <div className="rounded-xl border border-[#e4eaf2] bg-white p-3">
    <div className="flex items-baseline justify-between gap-3"><span className="shrink-0 text-[12px] text-[#64748b]">效应</span><span className="text-right text-[15px] font-semibold text-[#0f172a]">{x.effect.text}<span className="ml-1.5 text-[12px] font-medium text-[#94a3b8]">{INSIGHT_STRENGTH_LABEL[x.strength]}</span></span></div>
    <p className="mt-2 text-[11.5px] leading-relaxed text-[#64748b]">{x.effect.measure}。活动内部的机制测不出解释度，强弱按这里的门槛定，不和分数比大小。</p>
  </div>;
  return null;
}

function Table({ table }: { table: InsightTable }) {
  return <div className="overflow-hidden rounded-xl border border-[#e4eaf2]"><table className="w-full border-collapse text-[12.5px]">
    <thead className="bg-[#f8fafc]"><tr>{table.head.map((h, i) => <th key={i} scope="col" className={`px-2.5 py-1.5 text-[11.5px] font-medium text-[#64748b] ${i ? "text-right" : "text-left"}`}>{h}</th>)}</tr></thead>
    <tbody>{table.rows.map((row, r) => <tr key={r} className="border-t border-[#eef2f7]">{row.map((cell, i) => i ? <td key={i} className="px-2.5 py-1.5 text-right tabular-nums text-[#0f172a]">{cell}</td> : <th key={i} scope="row" className="px-2.5 py-1.5 text-left font-normal text-[#334155]">{cell}</th>)}</tr>)}</tbody>
  </table></div>;
}

// 三段之一：依据 / 异常 / 推荐。图标和色条区分，空的时候写原因。
const TONE = {
  basis: { icon: Database, title: "依据", hint: "数据验证的关联", bar: "bg-[#2f6bff]", ink: "text-[#1d4ed8]", bg: "bg-[#f5f8ff]" },
  anomaly: { icon: AlertTriangle, title: "异常", hint: "特殊案例和要注意的地方", bar: "bg-[#f59e0b]", ink: "text-[#b45309]", bg: "bg-[#fffbf2]" },
  advice: { icon: Lightbulb, title: "推荐", hint: "表现最好的取值和搭配", bar: "bg-[#10b981]", ink: "text-[#047857]", bg: "bg-[#f2fbf7]" },
} as const;
function Part({ tone, children, empty }: { tone: keyof typeof TONE; children?: React.ReactNode; empty?: string }) {
  const t = TONE[tone]; const Icon = t.icon;
  return <section aria-label={t.title} className={`relative overflow-hidden rounded-xl ${t.bg} py-3 pl-4 pr-3`}>
    <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-[3px] ${t.bar}`} />
    <h3 className={`flex items-center gap-1.5 text-[12.5px] font-semibold ${t.ink}`}><Icon aria-hidden="true" className="size-3.5" />{t.title}<span className="font-normal text-[#94a3b8]">· {t.hint}</span></h3>
    <div className="mt-1.5 space-y-1.5 text-[13px] leading-relaxed text-[#334155]">{children ?? <p className="text-[#94a3b8]">{empty}</p>}</div>
  </section>;
}

function SourceBox({ node }: { node: InsightNode }) {
  const s = node.source; const ai = s.kind === "grouping" || s.kind === "inferred";
  const row = (label: string, content: React.ReactNode) => <div className="flex gap-2"><span className="w-[52px] shrink-0 text-[#94a3b8]">{label}</span><span className="min-w-0 text-[#334155]">{content}</span></div>;
  return <details className={`group rounded-xl border px-3 py-2 text-[12px] ${ai ? "border-[#e6defc] bg-[#faf8ff]" : "border-[#e4eaf2] bg-[#f8fafc]"}`}>
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[#334155]">
      <span className={`rounded-[5px] border px-1.5 text-[10px] font-medium leading-4 ${SOURCE_TAG[s.kind]}`}>{INSIGHT_SOURCE_LABEL[s.kind].tag}</span>
      <span className="truncate">{INSIGHT_SOURCE_LABEL[s.kind].desc}</span>
      <ChevronRight aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-[#94a3b8] transition-transform group-open:rotate-90" />
    </summary>
    <div className="mt-2 space-y-1">
      {s.columns.length ? row("用到字段", s.columns.map((c) => <code key={c} className="mb-0.5 mr-1 inline-block rounded border border-[#e2e8f0] bg-white px-1 font-sans text-[11.5px]">{c}</code>)) : null}
      {row("怎么来", s.how)}
      {s.judgement ? row("AI 的部分", <span className="text-[#6d28d9]">{s.judgement}</span>) : null}
    </div>
  </details>;
}

function Chain({ graph, path, onSelect }: { graph: InsightGraph; path: InsightEdge[]; onSelect: (s: InsightSelection) => void }) {
  const name = (id: InsightNodeId) => <button type="button" onClick={() => onSelect({ kind: "node", id })} className="rounded px-0.5 text-[#0f172a] underline decoration-[#cbd5e1] decoration-dashed underline-offset-4 hover:text-[#1d4ed8] hover:decoration-[#2f6bff]">{findNode(graph, id)?.label ?? id}</button>;
  return <div className="text-[12.5px] leading-[1.95] text-[#94a3b8]">{name(path[0].from)}{path.map((e) => <span key={edgeKey(e)}><Lk edge={e} />→ {name(e.to)}</span>)}</div>;
}

function Relation({ graph, edge, onSelect }: { graph: InsightGraph; edge: InsightEdge; onSelect: (s: InsightSelection) => void }) {
  return <button type="button" onClick={() => onSelect({ kind: "edge", from: edge.from, to: edge.to })} className="group block w-full rounded-xl border border-[#e4eaf2] bg-white px-3 py-2 text-left transition hover:border-[#9db8ff] hover:shadow-[0_4px_12px_-6px_rgba(47,107,255,0.4)] focus-visible:border-[#2f6bff] focus-visible:outline-none">
    <span className="flex items-center gap-1 text-[12.5px] font-semibold text-[#0f172a]">{findNode(graph, edge.from)?.label}<span className="font-normal text-[#94a3b8]">→</span>{findNode(graph, edge.to)?.label}<Lk edge={edge} /><ChevronRight aria-hidden="true" className="ml-auto size-3.5 text-[#cbd5e1] group-hover:text-[#2f6bff]" /></span>
    <span className="mt-0.5 line-clamp-2 block text-[12px] leading-relaxed text-[#64748b]">{edge.basis}</span>
  </button>;
}

// 折叠的次要内容：链路、相连的线。默认收起，详情栏一屏能看完三段主内容。
function More({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <section className="border-t border-[#eef2f7] pt-2">
    <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex min-h-8 w-full items-center gap-1 text-[12px] font-medium text-[#64748b] hover:text-[#0f172a]">
      <ChevronRight aria-hidden="true" className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} />{title}<span className="text-[#94a3b8]">（{count}）</span>
    </button>
    {open ? <div className="mt-1 space-y-1.5 pb-1">{children}</div> : null}
  </section>;
}

function Header({ kicker, children, onClear }: { kicker: string; children: React.ReactNode; onClear: () => void }) {
  return <header className="mb-3 flex items-start gap-2">
    <div className="min-w-0 flex-1"><p className="text-[11.5px] font-medium text-[#94a3b8]">{kicker}</p><h2 className="mt-0.5 text-[17px] font-semibold leading-snug tracking-[-0.01em] text-[#0f172a]">{children}</h2></div>
    <button type="button" aria-label="清除选择" onClick={onClear} className="grid size-8 shrink-0 place-items-center rounded-lg text-[#94a3b8] hover:bg-[#f1f5f9] hover:text-[#334155]"><X aria-hidden="true" className="size-4" /></button>
  </header>;
}

export function InsightSidePanel({ graph, selection, onSelect, onAsk }: { graph: InsightGraph; selection: InsightSelection | null; onSelect: (s: InsightSelection | null) => void; onAsk: () => void }) {
  const ask = <button type="button" onClick={onAsk} className="mt-3 inline-flex min-h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-[#d6e2ff] bg-[#f5f8ff] px-3 text-[13px] font-medium text-[#1d4ed8] transition hover:bg-[#eaf0ff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><MessageCircle aria-hidden="true" className="size-4" />去智能问答查更细的数据</button>;
  const clear = () => onSelect(null);

  if (!selection) {
    const top = [...graph.edges].filter((e) => e.score).sort((a, b) => b.score!.value - a.score!.value).slice(0, 5);
    return <div className="space-y-3">
      <header><p className="flex items-center gap-1 text-[11.5px] font-medium text-[#94a3b8]"><Sparkles aria-hidden="true" className="size-3.5 text-[#2f6bff]" />这张图的结论</p><h2 className="mt-0.5 text-[17px] font-semibold tracking-[-0.01em] text-[#0f172a]">销售额、毛利、销量受哪些因素影响</h2></header>
      <ol className="space-y-2">{graph.summary.map((line, i) => <li key={line} className="flex gap-2.5 rounded-xl border border-[#e4eaf2] bg-white p-3 text-[13px] leading-relaxed text-[#334155]"><span className="grid size-5 shrink-0 place-items-center rounded-full bg-[#eaf0ff] text-[11px] font-semibold text-[#1d4ed8]">{i + 1}</span>{line}</li>)}</ol>
      <section><h3 className="mb-1.5 text-[12px] font-medium text-[#64748b]">解释度最高的关系</h3>
        <div className="space-y-1">{top.map((e) => <button key={edgeKey(e)} type="button" onClick={() => onSelect({ kind: "edge", from: e.from, to: e.to })} className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[12.5px] hover:bg-[#f5f8ff]">
          <span className="min-w-0 flex-1 truncate text-[#334155]">{findNode(graph, e.from)?.label} → {findNode(graph, e.to)?.label}</span>
          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-[#eef2f7]"><span className="block h-full rounded-full" style={{ width: `${e.score!.value}%`, background: STRENGTH_STYLE[e.strength].stroke }} /></span>
          <span className="w-8 text-right font-semibold tabular-nums text-[#0f172a]">{scoreText(e)}</span>
        </button>)}</div>
      </section>
    </div>;
  }

  if (selection.kind === "source") {
    const label = INSIGHT_SOURCE_LABEL[selection.source];
    return <div>
      <Header kicker="来源" onClear={clear}>{label.name}</Header>
      <p className="mb-3 text-[13px] text-[#334155]">{label.desc}。</p>
      <div className="space-y-1.5">{graph.nodes.filter((n) => n.source.kind === selection.source).map((n) => <button key={n.id} type="button" onClick={() => onSelect({ kind: "node", id: n.id })} className="block w-full rounded-xl border border-[#e4eaf2] bg-white px-3 py-2 text-left hover:border-[#9db8ff]">
        <span className="block text-[13px] font-semibold text-[#0f172a]">{n.label}</span><span className="mt-0.5 block text-[12px] text-[#64748b]">{n.source.judgement ?? n.source.how}</span>
      </button>)}</div>
    </div>;
  }

  // 连线：依据、异常、推荐三段（2026-10-19 会议定的线交互规则）。
  if (selection.kind === "edge") {
    const edge = findEdge(graph, selection.from, selection.to); if (!edge) return null;
    const all = routesThrough(graph, edge);
    return <div className="space-y-2.5">
      <Header kicker={`影响关系 · ${INSIGHT_EDGE_SOURCE[edge.strength].split("；")[0]}`} onClear={clear}>
        <button type="button" onClick={() => onSelect({ kind: "node", id: edge.from })} className="hover:text-[#1d4ed8]">{findNode(graph, edge.from)?.label}</button>
        <span className="mx-1.5 font-normal text-[#94a3b8]">→</span>
        <button type="button" onClick={() => onSelect({ kind: "node", id: edge.to })} className="hover:text-[#1d4ed8]">{findNode(graph, edge.to)?.label}</button>
      </Header>
      <ScoreBar x={edge} />
      <Part tone="basis"><p>{edge.basis}</p></Part>
      <Part tone="anomaly" empty="这条线上没有看到特别的案例。">{edge.anomalies.length ? edge.anomalies.map((a) => <p key={a}>{a}</p>) : undefined}</Part>
      <Part tone="advice" empty={edge.noRecommendation}>{edge.recommendation ? <p>{edge.recommendation}</p> : undefined}</Part>
      <More title="经过这条线的完整链路" count={all.length}>
        {all.map((p) => <Chain key={p.map(edgeKey).join("|")} graph={graph} path={p} onSelect={onSelect} />)}
        <p className="text-[11.5px] text-[#94a3b8]">链路上每一段都是单独测的关联，不能把各段相乘当成效果。</p>
      </More>
      {ask}
    </div>;
  }

  // 节点：原始数据事实分析（点交互规则）。相连线的异常、推荐汇总到下面，点线看详细。
  const node = findNode(graph, selection.id); if (!node) return null;
  const linked = graph.edges.filter((e) => e.to === node.id || e.from === node.id).sort(byStrength);
  const ins = linked.filter((e) => e.to === node.id); const outs = linked.filter((e) => e.from === node.id);
  const down = routes(graph, node.id, "down"); const up = node.kind === "metric" ? routes(graph, node.id, "up") : [];
  const anomalies = linked.flatMap((e) => e.anomalies.map((a) => ({ a, e })));
  const advice = linked.filter((e) => e.recommendation);
  const relName = (e: InsightEdge) => e.from === node.id ? findNode(graph, e.to)?.label : findNode(graph, e.from)?.label;
  return <div className="space-y-2.5">
    <Header kicker={node.column === 0 && node.strength ? `${INSIGHT_KIND_LABEL[node.kind]} · ${INSIGHT_STRENGTH_LABEL[node.strength]}` : INSIGHT_KIND_LABEL[node.kind]} onClear={clear}>{node.label}</Header>
    <ScoreBar x={node} />
    <SourceBox node={node} />
    <Part tone="basis">
      {node.paragraphs.map((p) => <p key={p}>{p}</p>)}
      {node.table ? <div className="pt-1"><Table table={node.table} /></div> : null}
      {node.note ? <p className="text-[12px] text-[#64748b]">{node.note}</p> : null}
    </Part>
    <Part tone="anomaly" empty="相连的线上没有看到特别的案例。">{anomalies.length ? anomalies.map(({ a, e }) => <p key={a}><button type="button" onClick={() => onSelect({ kind: "edge", from: e.from, to: e.to })} className="mr-1 rounded bg-white/70 px-1 text-[11px] font-medium text-[#b45309] hover:bg-white">{relName(e)}</button>{a}</p>) : undefined}</Part>
    <Part tone="advice" empty={node.kind === "metric" ? "这是结果指标，推荐看它上游的线。" : "相连的线上没有可推荐的取值。"}>{advice.length ? advice.map((e) => <p key={edgeKey(e)}><button type="button" onClick={() => onSelect({ kind: "edge", from: e.from, to: e.to })} className="mr-1 rounded bg-white/70 px-1 text-[11px] font-medium text-[#047857] hover:bg-white">{relName(e)}</button>{e.recommendation}</p>) : undefined}</Part>
    {down.length ? <More title="怎么传到指标" count={down.length}>{down.map((p) => <Chain key={p.map(edgeKey).join("|")} graph={graph} path={p} onSelect={onSelect} />)}</More> : null}
    {up.length ? <More title="从哪些因素传过来" count={up.length}>{up.map((p) => <Chain key={p.map(edgeKey).join("|")} graph={graph} path={p} onSelect={onSelect} />)}</More> : null}
    {ins.length ? <More title="受这些影响" count={ins.length}>{ins.map((e) => <Relation key={edgeKey(e)} graph={graph} edge={e} onSelect={onSelect} />)}</More> : null}
    {outs.length ? <More title="影响到" count={outs.length}>{outs.map((e) => <Relation key={edgeKey(e)} graph={graph} edge={e} onSelect={onSelect} />)}</More> : null}
    {ask}
  </div>;
}
