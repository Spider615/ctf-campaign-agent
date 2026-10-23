"use client";

import { useEffect, useId, type MouseEvent } from "react";
import { analysisFactParents } from "../../lib/analytics/analysis-v2-fact-links.ts";
import type { AnalysisEvidence, AnalysisFact, AnalysisFrame, PlanAnswer, PlanAnswerBlock, PlanAnswerClaim, PlanAnswerV4 } from "../../lib/analytics/analysis-v2-types.ts";
import { parseBodyMarkdown, type BodyInline } from "../../lib/analytics/plan/body-markdown.ts";
import { formatValue } from "../../lib/analytics/plan/bind.ts";
import { ANALYSIS_FILTER_DIMENSIONS, SEMANTIC_DIMENSIONS } from "../../lib/analytics/semantic/model.ts";
import { useWorkspacePanel } from "../workspace/workspace-panel-context.ts";
import { VisualizationCard } from "./visualization-card.tsx";

// 筛选项的中文名来自语义层，不再手写一份。
const filterLabels = Object.fromEntries(Object.entries(ANALYSIS_FILTER_DIMENSIONS).map(([filter, dimension]) => [filter, SEMANTIC_DIMENSIONS[dimension].label])) as Record<string, string>;
const populationLabels = { sales: "销售正金额", net: "销售与退货净额", recovery: "回收抵扣候选", returns: "退货", zero_sales: "零元销售", unknown: "历史口径未核对" };
const grainLabels = { line: "销售明细行", selected_order: "当前筛选内的订单成交部分", group: "分组", unknown: "粒度尚未确认" };

function citedFacts(evidence: AnalysisEvidence, factIds: readonly string[]): AnalysisFact[] {
  const byId = new Map(evidence.facts.map((fact) => [fact.id, fact]));
  const selected = new Set<string>();
  const visit = (id: string) => {
    if (selected.has(id)) return;
    selected.add(id);
    const fact = byId.get(id);
    if (fact) analysisFactParents(fact).forEach(visit);
  };
  factIds.forEach(visit);
  return evidence.facts.filter((fact) => selected.has(fact.id));
}

function sourceMetadata(frame: AnalysisFrame) {
  const filters = Object.entries(frame.scope.filters).filter(([, values]) => values?.length).map(([name, values]) => `${filterLabels[name] ?? name}：${values!.join("、")}`).join("；");
  return {
    来源: `${frame.mode === "database" ? "历史销售数据" : frame.mode === "historical" ? "历史资料" : "授权数据快照"} · ${frame.provenance === "sample" ? "模拟或示例数据" : "用户提供数据"}`,
    周期: `${frame.scope.period.start} 至 ${frame.scope.period.end}`,
    范围: filters || "当前授权范围内全部记录",
    口径: `${populationLabels[frame.scope.population]} · ${grainLabels[frame.grain]} · ${frame.currency === "CNY" ? "人民币" : frame.currency === "unknown" ? "币种未核对" : frame.currency}`,
    数据版本: frame.datasetVersion,
  };
}

// 出处给业务人员看：先用三句白话说清数据从哪来、统计哪段时间什么范围、数字怎么算的，
// 再列这条结论引用的数字；口径代号、数据版本和逐项事实收进「技术详情」，需要对数时再展开。
const POPULATION_PLAIN = { sales: "只算销售", net: "销售减去退货", recovery: "旧金回收抵扣", returns: "只算退货", zero_sales: "零元销售", unknown: "口径待核对" } as const;
const METHOD_PLAIN: Record<string, string> = { aggregate: "汇总统计", compare: "两段时间或两组对象对比", decompose: "拆解变化来源", scan: "逐组扫描找差异", robustness: "剔除最大门店或大单后复核" };
const plainDate = (value: string) => { const [year, month, day] = value.split("-"); return `${year}年${Number(month)}月${Number(day)}日`; };
function plainPeriod(frame: AnalysisFrame) {
  const { start, end } = frame.scope.period;
  const [sy, sm] = start.split("-"); const [ey, em, ed] = end.split("-");
  const lastDay = new Date(Date.UTC(Number(ey), Number(em), 0)).getUTCDate();
  if (sy === ey && sm === em && start.endsWith("-01") && Number(ed) === lastDay) return `${sy}年${Number(sm)}月`;
  return `${plainDate(start)}至${plainDate(end)}`;
}
function plainScope(frame: AnalysisFrame) {
  const filters = Object.entries(frame.scope.filters).filter(([, values]) => values?.length).map(([name, values]) => `${filterLabels[name] ?? name}为${values!.slice(0, 3).join("、")}${values!.length > 3 ? ` 等 ${values!.length} 个` : ""}`);
  return filters.length ? filters.join("，") : "全部门店和货品";
}
function plainFactLabel(fact: AnalysisFact) {
  return fact.label.replace(/^汇总 · /, "").replace(/全量口径/g, "全部记录").replace(/销售口径/g, "只看销售").replace(/退货口径/g, "只看退货").replace(/开单优惠名称/g, "活动名称");
}
// 差额、变化率、偏离带正负号，和结论正文里的写法一致。
const SIGNED_METRIC = /\.(?:delta|relative_change|relative_deviation)$/;
const defaultFactText = (fact: AnalysisFact) => `${formatValue(fact, SIGNED_METRIC.test(fact.metricId))}${fact.assumption ? "（假设）" : ""}`;

// 范围的白话名字：只写和另一组不同的那部分（比如「周末」「工作日」），两组一样的部分放在下面一句里说。
function rangeName(frame: AnalysisFrame, other?: AnalysisFrame) {
  const parts: string[] = [];
  if (!other || plainPeriod(frame) !== plainPeriod(other)) parts.push(plainPeriod(frame));
  for (const [name, values] of Object.entries(frame.scope.filters)) {
    if (!values?.length) continue;
    const mine = [...values].sort().join("、"); const theirs = [...(other?.scope.filters[name as keyof typeof frame.scope.filters] ?? [])].sort().join("、");
    if (!other || mine !== theirs) parts.push(values.length > 3 ? `${values.slice(0, 3).join("、")} 等 ${values.length} 个${filterLabels[name] ?? ""}` : values.join("、"));
  }
  return parts.join("，") || "全部";
}
const shortLabel = (label: string) => label.replace(/^汇总 · /, "").replace(/^(?:目标|参照)\s*·\s*/, "").replace(/^.*?·\s*/, "").replace(/(?:差额|相对变化)$/, "");
const COMPARISON = /\.(?:delta|relative_change)$/;

/**
 * 业务版出处：先一句话说这个数是什么，再用一张小表把算式摊开（两组各多少、差多少），最后一句交代数据范围。
 * 对比类的数字（差额、变化率）找到同一组比较里的「目标」和「参照」；其他数字直接列出来。
 */
function PlainSource({ evidence, factIds, formatFact }: { evidence: AnalysisEvidence; factIds: string[]; formatFact: (fact: AnalysisFact) => string }) {
  const byId = new Map(evidence.facts.map((fact) => [fact.id, fact]));
  const frameOf = (fact: AnalysisFact) => evidence.frames.find((frame) => frame.id === fact.frameId);
  const cited = factIds.map((id) => byId.get(id)).filter((fact): fact is AnalysisFact => Boolean(fact));
  // 对比：同一个 comparisonKey 里，派生关系里的两个父事实就是目标和参照。
  const pairOf = (fact: AnalysisFact) => {
    if (!COMPARISON.test(fact.metricId)) return null;
    const delta = fact.metricId.endsWith(".delta") ? fact : evidence.facts.find((x) => x.comparisonKey && x.comparisonKey === fact.comparisonKey && x.metricId.endsWith(".delta"));
    const formula = delta?.derivation;
    if (!formula || !("op" in formula) || formula.args.length < 2 || !("factId" in formula.args[0]) || !("factId" in formula.args[1])) return null;
    const target = byId.get(formula.args[0].factId); const reference = byId.get(formula.args[1].factId);
    if (!target || !reference) return null;
    const change = evidence.facts.find((x) => x.comparisonKey && x.comparisonKey === fact.comparisonKey && x.metricId.endsWith(".relative_change"));
    return { target, reference, delta, change };
  };
  const pairs = cited.map(pairOf).filter((x): x is NonNullable<ReturnType<typeof pairOf>> => Boolean(x));
  const singles = cited.filter((fact) => !COMPARISON.test(fact.metricId) || !pairOf(fact));
  const frames = [...new Set(cited.flatMap((fact) => { const p = pairOf(fact); return p ? [p.target, p.reference] : [fact]; }).map(frameOf).filter((f): f is AnalysisFrame => Boolean(f)))];
  const rows = evidence.methods.filter((method) => cited.some((fact) => fact.operationId === method.operationId)).reduce((total, method) => total + method.sampleRows, 0);
  const shared = frames[0] ? `${plainPeriod(frames[0])}${frames.every((f) => plainPeriod(f) === plainPeriod(frames[0])) ? "" : "等"}${frames.every((f) => !Object.values(f.scope.filters).some((v) => v?.length)) ? "，全部门店和货品" : ""}` : "";
  const source = frames.some((f) => f.provenance === "sample") ? "模拟数据" : frames.some((f) => f.mode === "database") ? "销售系统的历史销售明细" : "上传的销售数据";
  return <div data-plain-source className="space-y-3">
    {pairs.map(({ target, reference, delta, change }, index) => {
      const tf = frameOf(target); const rf = frameOf(reference); const what = shortLabel(target.label) || shortLabel(delta.label);
      const tName = tf ? rangeName(tf, rf) : "这一组"; const rName = rf ? rangeName(rf, tf) : "对照组";
      const up = (delta.value ?? 0) >= 0;
      const changeText = change?.value != null ? `${up ? "多" : "少"} ${formatFact({ ...change, value: Math.abs(change.value) }).replace(/^[+-]/, "")}` : `${up ? "多" : "少"} ${formatFact({ ...delta, value: Math.abs(delta.value ?? 0) }).replace(/^[+-]/, "")}`;
      return <section key={index} className="space-y-2">
        <p className="text-[15px] font-semibold leading-7 text-foreground">{tName}比{rName}，{what}{changeText}</p>
        <div className="overflow-hidden rounded-xl border border-[#dce6f0]"><table className="w-full border-collapse text-[13px] leading-6">
          <caption className="sr-only">{what}对比</caption>
          <tbody>
            <tr className="border-b border-[#eef2f7]"><th scope="row" className="px-3 py-2 text-left font-normal text-[#425873]">{tName}</th><td className="px-3 py-2 text-right font-semibold tabular-nums">{formatFact(target)}</td></tr>
            <tr className="border-b border-[#eef2f7]"><th scope="row" className="px-3 py-2 text-left font-normal text-[#425873]">{rName}</th><td className="px-3 py-2 text-right tabular-nums">{formatFact(reference)}</td></tr>
            <tr className="bg-[#f5f8fc]"><th scope="row" className="px-3 py-2 text-left font-medium text-foreground">差多少</th><td className={`px-3 py-2 text-right font-semibold tabular-nums ${up ? "text-[#2f7a55]" : "text-[#b4543a]"}`}>{formatFact(delta)}{change?.value != null ? `（${formatFact(change)}）` : ""}</td></tr>
          </tbody>
        </table></div>
      </section>;
    })}
    {singles.length ? <ul className="space-y-1 rounded-xl bg-secondary/45 px-3.5 py-2.5 text-[13px] leading-6">{singles.slice(0, 8).map((fact) => <li key={fact.id} className="flex items-baseline justify-between gap-4"><span className="min-w-0 break-words text-[#425873]">{plainFactLabel(fact)}</span><span className="shrink-0 font-semibold tabular-nums">{formatFact(fact)}</span></li>)}</ul> : null}
    {frames.length ? <p className="text-xs leading-6 text-muted-foreground">数据来自{source}，{shared}{rows ? `，共 ${rows.toLocaleString("zh-CN")} 条销售记录` : ""}。数字由系统按数据直接算出，不是模型估的。</p> : null}
  </div>;
}

/**
 * 出处面板。给 factIds 时只列这些事实及其推导来源；不给就列全部。
 * methodIds、objectIds、formatFact 供旧版回答的适配器传入，保证只有一份实现；新版回答不需要。
 */
export function AnalysisSourceData({ evidence, factIds, methodIds, objectIds, formatFact = defaultFactText }: { evidence: AnalysisEvidence; factIds?: string[]; methodIds?: readonly string[]; objectIds?: readonly string[]; formatFact?: (fact: AnalysisFact) => string }) {
  const scoped = factIds !== undefined;
  const facts = scoped ? citedFacts(evidence, factIds) : evidence.facts;
  const operationIds = new Set(facts.map((fact) => fact.operationId));
  const methods = scoped ? evidence.methods.filter((method) => methodIds ? methodIds.includes(method.id) : operationIds.has(method.operationId)) : evidence.methods;
  const objects = scoped ? evidence.objects.filter((object) => objectIds?.includes(object.id) || facts.some((fact) => fact.objectIds.includes(object.id))) : evidence.objects;
  const frameIds = new Set(facts.length ? facts.map((fact) => fact.frameId) : [...objects.map((object) => object.frameId), ...methods.flatMap((method) => method.frameIds)]);
  const frames = scoped ? evidence.frames.filter((frame) => frameIds.has(frame.id)) : evidence.frames;
  const groups = new Map<string, { metadata: ReturnType<typeof sourceMetadata>; frameIds: string[] }>();
  for (const frame of frames) {
    const metadata = sourceMetadata(frame); const key = JSON.stringify(metadata);
    const group = groups.get(key);
    if (group) group.frameIds.push(frame.id);
    else groups.set(key, { metadata, frameIds: [frame.id] });
  }
  const entries = [...groups.values()];
  const labels = Object.keys(entries[0]?.metadata ?? {}) as Array<keyof ReturnType<typeof sourceMetadata>>;
  const shared = labels.filter((label) => entries.every((entry) => entry.metadata[label] === entries[0].metadata[label]));
  const metadataLines = (metadata: ReturnType<typeof sourceMetadata>, keys: typeof labels) => keys.map((label) => <p key={label} className="break-words text-xs leading-6"><span className="text-muted-foreground">{label}：</span>{metadata[label]}</p>);
  // 白话摘要：只引用正文直接用到的数字（结论引用的），推导用的父指标留在技术详情里。
  const headline = scoped ? evidence.facts.filter((fact) => factIds.includes(fact.id)) : facts.slice(0, 8);
  const shown = (headline.length ? headline : facts).slice(0, 8);
  const sourceText = [...new Set(frames.map((frame) => `${frame.mode === "database" ? "销售系统的历史销售明细" : frame.mode === "historical" ? "历史资料" : "上传的销售数据"}${frame.provenance === "sample" ? "（模拟数据）" : ""}`))].join("；");
  const periodText = [...new Set(frames.map((frame) => `${plainPeriod(frame)}，${plainScope(frame)}，${POPULATION_PLAIN[frame.scope.population]}`))].join("；");
  const methodText = [...new Set(methods.map((method) => METHOD_PLAIN[method.method] ?? "汇总统计"))].join("、") || "汇总统计";
  const rows = methods.reduce((total, method) => total + method.sampleRows, 0);
  return <div data-analysis-source className="min-w-0 select-text space-y-4">
    {frames.length ? <dl className="space-y-2.5 text-[13px] leading-6">
      <div><dt className="text-xs text-muted-foreground">数据来源</dt><dd className="break-words">{sourceText}</dd></div>
      <div><dt className="text-xs text-muted-foreground">统计范围</dt><dd className="break-words">{periodText}</dd></div>
      <div><dt className="text-xs text-muted-foreground">怎么算的</dt><dd className="break-words">{methodText}{rows ? `，共核对 ${rows.toLocaleString("zh-CN")} 条记录` : ""}，数字由系统直接计算</dd></div>
    </dl> : null}
    {shown.length ? <div className="rounded-xl bg-secondary/45 px-3.5 py-2.5"><p className="mb-1 text-xs text-muted-foreground">用到的数字</p>
      <ul className="space-y-1 text-[13px] leading-6">{shown.map((fact) => <li key={fact.id} className="flex items-baseline justify-between gap-4"><span className="min-w-0 break-words text-[#425873]">{plainFactLabel(fact)}</span><span className="shrink-0 font-semibold tabular-nums">{formatFact(fact)}</span></li>)}</ul>
    </div> : <p className="text-xs text-muted-foreground">暂无已保存的引用数据。</p>}
    {entries.length ? <details className="group text-xs text-muted-foreground"><summary className="min-h-9 cursor-pointer py-2">技术详情（口径与全部事实）</summary>
      <div className="mt-2 space-y-4">
        <div>{metadataLines(entries[0].metadata, shared.filter((label) => label !== "数据版本"))}</div>
        {entries.map((group, index) => {
          const groupRows = facts.filter((fact) => group.frameIds.includes(fact.frameId));
          return <section key={index} className="min-w-0 space-y-2">
            {metadataLines(group.metadata, labels.filter((label) => !shared.includes(label)))}
            {groupRows.length ? <table className="w-full table-fixed border-collapse text-left text-xs leading-6">
              <caption className="sr-only">引用数据</caption>
              <thead><tr className="border-b border-border bg-secondary/50"><th scope="col" className="w-2/3 px-3 py-2 font-medium text-muted-foreground">指标</th><th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">数值</th></tr></thead>
              <tbody>{groupRows.map((fact) => <tr key={fact.id} className="border-b border-border"><th scope="row" className="break-words px-3 py-2 align-top font-normal">{fact.label}</th><td className="break-words px-3 py-2 text-right align-top font-medium tabular-nums">{formatFact(fact)}</td></tr>)}</tbody>
            </table> : null}
          </section>;
        })}
        {shared.includes("数据版本") ? <p className="break-all leading-5">数据版本：{entries[0].metadata.数据版本}</p> : null}
      </div>
    </details> : null}
  </div>;
}

const STEP_STATUS: Record<string, string> = { unsupported: "未能完成", failed: "未完成", dropped: "已舍弃" };
const bodyClass = "break-words text-[15px] leading-7 text-[#425873]";
const sectionTitle = "mb-1.5 text-sm font-medium text-foreground";

function ConfidenceChip({ confidence }: { confidence: PlanAnswerClaim["confidence"] }) {
  // 只在方向翻转时提醒；稳健或未检查都不打标签，免得正文花哨。
  if (confidence !== "flipped") return null;
  return <span data-confidence={confidence} className="ml-1.5 inline-flex items-center rounded px-1.5 align-[1px] text-[11px] font-medium leading-5 text-amber-700 ring-1 ring-inset ring-amber-200">需谨慎</span>;
}

function TextList({ items, title, name }: { items: readonly string[]; title: string; name: string }) {
  if (!items.length) return null;
  return <section data-plan-section={name}><h3 className={sectionTitle}>{title}</h3><ul className={`list-disc space-y-2 pl-5 ${bodyClass} marker:text-[#8aa0b9]`}>{items.map((item, index) => <li key={index} className="pl-1">{item}</li>)}</ul></section>;
}

function Figures({ figures }: { figures: NonNullable<PlanAnswer["figures"]> }) {
  const compare = Boolean(figures.referenceLabel);
  return <section data-plan-section="figures" className="overflow-x-auto rounded-xl border border-[#dce6f0]">
    <table className="w-full min-w-[22rem] border-collapse text-left text-[13px] leading-6">
      <caption className="sr-only">关键数据</caption>
      <thead><tr className="border-b border-[#dce6f0] bg-[#f5f8fc] text-xs text-muted-foreground">
        <th scope="col" className="px-3 py-2 font-medium">指标</th>
        <th scope="col" className="px-3 py-2 text-right font-medium">{figures.targetLabel}</th>
        {compare ? <><th scope="col" className="px-3 py-2 text-right font-medium">{figures.referenceLabel}</th><th scope="col" className="px-3 py-2 text-right font-medium">变化</th></> : null}
      </tr></thead>
      <tbody>{figures.rows.map((row, index) => <tr key={index} className="border-b border-[#eef2f7] last:border-0">
        <th scope="row" className="px-3 py-2 font-normal text-[#425873]">{row.label}</th>
        <td className="px-3 py-2 text-right font-medium tabular-nums text-foreground">{row.target}</td>
        {compare ? <><td className="px-3 py-2 text-right tabular-nums text-[#425873]">{row.reference ?? "—"}</td><td className={`px-3 py-2 text-right tabular-nums ${row.change?.startsWith("-") ? "text-[#b4543a]" : row.change ? "text-[#2f7a55]" : "text-muted-foreground"}`}>{row.change ?? "—"}</td></> : null}
      </tr>)}</tbody>
    </table>
  </section>;
}

// 出处面板：这条结论用到的数据，加本次的口径说明、待确认口径和分析步骤。
// 业务看上面三块（一句话、算式小表、数据范围）；口径定义、分析步骤、逐项事实收进「给分析师看」，默认收起。
// 有待确认的口径时在业务版下面单独提醒一句，不让它藏在折叠里。
export function SourcePanel({ answer, factIds }: { answer: PlanAnswer | PlanAnswerV4; factIds: string[] }) {
  return <div className="space-y-4">
    {factIds.length ? <PlainSource evidence={answer.evidence} factIds={factIds} formatFact={defaultFactText} /> : null}
    {answer.assumptions.length ? <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-800">有 {answer.assumptions.length} 处口径还没和业务确认，数字先作参考。</p> : null}
    <details className="group border-t border-border pt-2 text-xs leading-6 text-muted-foreground">
      <summary className="min-h-8 cursor-pointer py-1.5 font-medium text-foreground">给分析师看（口径、分析步骤、全部数字）</summary>
      <div className="mt-2 space-y-4">
        <AnalysisSourceData evidence={answer.evidence} factIds={factIds} />
        {answer.assumptions.length || answer.definitions.length ? <section><h4 className="mb-1 font-medium text-foreground">口径</h4>
          <ul className="list-disc space-y-1 pl-4">{[...answer.assumptions, ...answer.definitions].map((item, index) => <li key={index} className="break-words">{item}</li>)}</ul>
        </section> : null}
        {answer.plan.length ? <section><h4 className="mb-1 font-medium text-foreground">分析步骤</h4>
          <ol className="list-decimal space-y-1 pl-4">{answer.plan.map((step, index) => <li key={`${step.id}:${index}`} className="break-words">{step.summary}{step.status !== "completed" ? <span className="ml-1 text-amber-700">（{STEP_STATUS[step.status] ?? "未知状态"}）</span> : null}</li>)}</ol>
        </section> : null}
      </div>
    </details>
  </div>;
}

export function PlanAnswerView({ answer }: { answer: PlanAnswer }) {
  const answerId = useId();
  const { panelId, activeId, togglePanel, dismissPanel } = useWorkspacePanel();
  useEffect(() => () => dismissPanel(answerId), [answerId, dismissPanel]);
  // 出处做成文字后的小号上标数字，悬停或展开时才变色，不抢正文。
  const sourceButton = (key: string, number: number, claim: PlanAnswerClaim) => {
    const id = `${answerId}:${key}`; const open = activeId === id;
    const toggle = (event: MouseEvent<HTMLButtonElement>) => togglePanel({ id, title: `出处 ${number}`, label: "数据出处", content: <SourcePanel answer={answer} factIds={claim.factIds} /> }, event.currentTarget);
    return <sup className="ml-0.5 align-super leading-none"><button type="button" aria-label={`查看数据出处${number}`} aria-controls={panelId} aria-expanded={open} onClick={toggle} className={`rounded px-0.5 text-[11px] font-normal tabular-nums transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${open ? "text-primary" : "text-[#9aabbf]"}`}>[{number}]</button></sup>;
  };
  const claims = answer.claims.slice(0, 5);
  return <div data-plan-answer className="min-w-0 select-text space-y-4">
    {/* 主结论的重点数字单独放大放在最上面，一眼看到问题的答案；句子在下面给出口径和含义。 */}
    {answer.headline?.keyFigure ? <p data-plan-key-figure className="break-words text-[32px] font-semibold leading-tight tracking-tight text-[#174e96] tabular-nums">{answer.headline.keyFigure.value}</p> : null}
    {answer.headline
      ? <p data-plan-headline className={`break-words font-semibold text-foreground ${answer.headline.keyFigure ? "-mt-2 text-[15px] leading-7" : "text-[16px] leading-8"}`}>{answer.headline.text}<ConfidenceChip confidence={answer.headline.confidence} />{sourceButton("headline", 1, answer.headline)}</p>
      : <p role="status" data-plan-headline className="rounded-lg border border-border bg-secondary/45 px-3 py-2 text-sm font-medium leading-6">这次没有得出可以直接采用的结论</p>}
    {answer.figures?.rows.length ? <Figures figures={answer.figures} /> : null}
    {claims.length ? <section data-plan-section="findings"><h3 className={sectionTitle}>主要发现</h3><ul data-plan-claims className={`list-disc space-y-2.5 pl-5 ${bodyClass} marker:text-[#8aa0b9]`}>{claims.map((claim, index) => <li key={index} data-plan-claim className="pl-1"><span>{claim.text}</span><ConfidenceChip confidence={claim.confidence} />{sourceButton(`claim:${index}`, index + 1 + (answer.headline ? 1 : 0), claim)}</li>)}</ul></section> : null}
    {answer.chart ? <VisualizationCard chart={answer.chart} sourceContent={<SourcePanel answer={answer} factIds={answer.chart.factIds} />} /> : null}
    <TextList items={answer.actions} title="建议" name="actions" />
    <TextList items={answer.cannotConclude} title="暂时不能下的结论" name="cannot-conclude" />
  </div>;
}

// v4 表格块：沿用关键数据表的样式，标题小号放在表上方；第一列是分组或指标名。
function BodyTable({ block }: { block: Extract<PlanAnswerBlock, { kind: "table" }> }) {
  const changeAt = block.columns.indexOf("变化");
  return <section data-plan-block="table" className="min-w-0">
    {block.title ? <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{block.title}</h3> : null}
    <div className="overflow-x-auto rounded-xl border border-[#dce6f0]">
      <table className="w-full min-w-[22rem] border-collapse text-left text-[13px] leading-6">
        <caption className="sr-only">{block.title || "数据表"}</caption>
        <thead><tr className="border-b border-[#dce6f0] bg-[#f5f8fc] text-xs text-muted-foreground">{block.columns.map((column, index) => <th key={index} scope="col" className={`px-3 py-2 font-medium ${index ? "text-right" : ""}`}>{column}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex} className="border-b border-[#eef2f7] last:border-0">{row.cells.map((cell, index) => index === 0
          ? <th key={index} scope="row" className="px-3 py-2 font-normal text-[#425873]">{cell}</th>
          : <td key={index} className={`px-3 py-2 text-right tabular-nums ${index === changeAt ? cell.startsWith("-") ? "text-[#b4543a]" : cell && cell !== "—" ? "text-[#2f7a55]" : "text-muted-foreground" : index === 1 ? "font-medium text-foreground" : "text-[#425873]"}`}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  </section>;
}

// v4：重点数字放大在最上面，下面是模型写的正文；正文里每个数字是一个按钮，点开看这一个数字的出处。
export function PlanAnswerV4View({ answer }: { answer: PlanAnswerV4 }) {
  const answerId = useId();
  const { panelId, activeId, togglePanel, dismissPanel } = useWorkspacePanel();
  useEffect(() => () => dismissPanel(answerId), [answerId, dismissPanel]);
  const numberButton = (key: string, text: string, factIds: string[]) => {
    const id = `${answerId}:${key}`; const open = activeId === id;
    const toggle = (event: MouseEvent<HTMLButtonElement>) => togglePanel({ id, title: `${text} 的出处`, label: "数据出处", content: <SourcePanel answer={answer} factIds={factIds} /> }, event.currentTarget);
    return <button key={key} type="button" data-plan-ref aria-label={`查看 ${text} 的出处`} aria-controls={panelId} aria-expanded={open} onClick={toggle} className={`inline rounded-sm font-semibold tabular-nums underline decoration-1 underline-offset-4 transition-colors hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${open ? "text-primary decoration-primary" : "text-inherit decoration-[#b9c8d9]"}`}>{text}</button>;
  };
  const inline = (nodes: BodyInline[], key: string) => nodes.map((node, index) => {
    const content = node.parts.map((part, at) => part.kind === "ref" ? numberButton(`${key}:${part.index}`, part.text, part.factIds) : <span key={at}>{part.text}</span>);
    return node.bold ? <strong key={index} className="font-semibold text-[#17243a]">{content}</strong> : <span key={index}>{content}</span>;
  });
  const markdown = (block: Extract<PlanAnswerBlock, { kind: "markdown" }>, blockIndex: number) => {
    const key = `b${blockIndex}`;
    return <div key={key} data-plan-block="markdown" className="min-w-0 space-y-3 break-words text-[15px] leading-7 text-foreground">
      {parseBodyMarkdown(block.text, block.refs).map((item, index) => {
        if (item.kind === "para") return <p key={index} className="whitespace-pre-wrap">{inline(item.inline, key)}</p>;
        if (item.kind === "heading") {
          const Heading = item.level <= 2 ? "h2" : item.level === 3 ? "h3" : "h4";
          return <Heading key={index} className={`pt-2 font-semibold tracking-tight first:pt-0 ${item.level <= 2 ? "text-[18px]" : "text-base"}`}>{inline(item.inline, key)}</Heading>;
        }
        const items = item.items.map((entry, at) => <li key={at} className="pl-1">{inline(entry, key)}</li>);
        return item.ordered ? <ol key={index} start={item.start} className="list-decimal space-y-1 pl-5">{items}</ol> : <ul key={index} className="list-disc space-y-1 pl-5 marker:text-[#8aa0b9]">{items}</ul>;
      })}
    </div>;
  };
  return <div data-plan-answer data-plan-answer-version="v4" className="min-w-0 select-text space-y-4">
    {answer.keyFigure ? <p data-plan-key-figure className="break-words text-[32px] font-semibold leading-tight tracking-tight text-[#174e96] tabular-nums">{answer.keyFigure.value}</p> : null}
    {answer.body.map((block, index) => block.kind === "markdown" ? markdown(block, index)
      : block.kind === "table" ? <BodyTable key={`b${index}`} block={block} />
      : <VisualizationCard key={`b${index}`} chart={block.chart} sourceContent={<SourcePanel answer={answer} factIds={block.chart.factIds} />} />)}
  </div>;
}
