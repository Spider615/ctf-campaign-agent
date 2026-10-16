"use client";

import { useEffect, useId, type MouseEvent } from "react";
import { formatAnalysisNode } from "../../lib/analytics/analysis-v2-evidence.ts";
import { analysisVisualPresentationBlocks, type AnalysisInlineNode } from "../../lib/analytics/analysis-v2-format.ts";
import { resolveAnalysisVisualization } from "../../lib/analytics/visualization.ts";
import { VisualizationCard } from "./visualization-card.tsx";
import type { AnalysisAnswer, AnalysisConclusion, AnalysisFact, AnalysisFrame, FactExpression } from "../../lib/analytics/analysis-v2-types.ts";
import { useWorkspacePanel } from "../workspace/workspace-panel-context.ts";

const filterLabels: Record<string, string> = { stores: "门店", regions: "大区", districts: "分区", categories: "货类", materials: "材料", offers: "优惠", memberFlags: "是否会员销售", storeTypes: "分店性质", skus: "货品", memberSegments: "会员分组" };
const populationLabels = { sales: "销售正金额", net: "销售与退货净额", recovery: "回收抵扣候选", returns: "退货", zero_sales: "零元销售", unknown: "历史口径未核对" };
const grainLabels = { line: "销售明细行", selected_order: "当前筛选内的订单成交部分", group: "分组", unknown: "粒度尚未确认" };

function AnswerInline({ nodes }: { nodes: AnalysisInlineNode[] }) {
  const runs: Array<{ bold: boolean; nodes: AnalysisInlineNode[] }> = [];
  for (const node of nodes) {
    const previous = runs.at(-1);
    if (previous?.bold === node.bold) previous.nodes.push(node);
    else runs.push({ bold: node.bold, nodes: [node] });
  }
  return runs.map((run, index) => {
    const content = run.nodes.map((node, at) => <span key={at} data-analysis-node={node.kind} className={node.kind === "fact_ref" ? "tabular-nums" : node.kind === "object_ref" ? "font-medium text-foreground" : undefined}>{node.text}</span>);
    return run.bold ? <strong key={index} className="font-semibold text-foreground">{content}</strong> : <span key={index}>{content}</span>;
  });
}

function AnswerLead({ nodes }: { nodes: AnalysisInlineNode[] }) {
  const first: AnalysisInlineNode[] = []; const rest: AnalysisInlineNode[] = []; let ended = false;
  for (const node of nodes) {
    if (ended) { rest.push(node); continue; }
    const end = node.kind === "text" ? /[。！？]/u.exec(node.text)?.index : undefined;
    if (end === undefined) { first.push(node); continue; }
    first.push({ ...node, text: node.text.slice(0, end + 1) });
    if (end + 1 < node.text.length) rest.push({ ...node, text: node.text.slice(end + 1) });
    ended = true;
  }
  return <><span data-analysis-lead className="block text-[17px] font-semibold leading-8 text-foreground"><AnswerInline nodes={first} /></span>{rest.length ? <span className="mt-3 block"><AnswerInline nodes={rest} /></span> : null}</>;
}

function citedFacts(answer: AnalysisAnswer, conclusion: AnalysisConclusion): AnalysisFact[] {
  const selected = new Set<string>();
  const expression = (value: FactExpression) => { if ("factId" in value) visit(value.factId); else if ("op" in value) value.args.forEach(expression); };
  const visit = (id: string) => { if (selected.has(id)) return; selected.add(id); const fact = answer.evidence.facts.find((item) => item.id === id); if (fact?.derivation) expression(fact.derivation); };
  conclusion.factIds.forEach(visit);
  return answer.evidence.facts.filter((fact) => selected.has(fact.id));
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

export function AnalysisSourceData({ answer, conclusion }: { answer: AnalysisAnswer; conclusion?: AnalysisConclusion }) {
  const facts = conclusion ? citedFacts(answer, conclusion) : answer.evidence.facts;
  const methods = conclusion ? answer.evidence.methods.filter((method) => conclusion.methodIds.includes(method.id)) : answer.evidence.methods;
  const objects = conclusion ? answer.evidence.objects.filter((object) => conclusion.objectIds.includes(object.id) || facts.some((fact) => fact.objectIds.includes(object.id))) : answer.evidence.objects;
  const frameIds = new Set(facts.length ? facts.map((fact) => fact.frameId) : [...objects.map((object) => object.frameId), ...methods.flatMap((method) => method.frameIds)]);
  const frames = conclusion ? answer.evidence.frames.filter((frame) => frameIds.has(frame.id)) : answer.evidence.frames;
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
  return <div data-analysis-source className="min-w-0 select-text space-y-4">
    {entries.length ? <div>{metadataLines(entries[0].metadata, shared.filter((label) => label !== "数据版本"))}</div> : null}
    {entries.map((group, index) => {
      const rows = facts.filter((fact) => group.frameIds.includes(fact.frameId));
      return <section key={index} className="min-w-0 space-y-2">
        {metadataLines(group.metadata, labels.filter((label) => !shared.includes(label)))}
        {rows.length ? <table className="w-full table-fixed border-collapse text-left text-xs leading-6">
          <caption className="sr-only">引用数据</caption>
          <thead><tr className="border-b border-border bg-secondary/50"><th scope="col" className="w-2/3 px-3 py-2 font-medium text-muted-foreground">指标</th><th scope="col" className="px-3 py-2 text-right font-medium text-muted-foreground">数值</th></tr></thead>
          <tbody>{rows.map((fact) => <tr key={fact.id} className="border-b border-border"><th scope="row" className="break-words px-3 py-2 align-top font-normal">{fact.label}</th><td className="break-words px-3 py-2 text-right align-top font-medium tabular-nums">{formatAnalysisNode({ kind: "fact_ref", factId: fact.id }, answer)}</td></tr>)}</tbody>
        </table> : null}
      </section>;
    })}
    {!facts.length ? <p className="text-xs text-muted-foreground">暂无已保存的引用数据。</p> : null}
    {shared.includes("数据版本") ? <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">数据版本</summary><p className="mt-2 break-all leading-5">{entries[0].metadata.数据版本}</p></details> : null}
  </div>;
}

function AnswerBoundary({ answer }: { answer: AnalysisAnswer }) {
  if (answer.status === "answered") return null;
  const boundaries = [...new Set([...answer.review.issues.map((issue) => issue.requirement), ...answer.conclusions.flatMap((conclusion) => conclusion.limitations), ...answer.task.needs.filter((need) => need.status === "open" || need.status === "needs_business_input").map((need) => `待完成：${need.judgement}`)])];
  return <div role="status" data-analysis-boundary className="rounded-lg border border-border bg-secondary/45 px-3 py-2 text-sm leading-6">
    <p className="font-medium">{answer.status === "incomplete" ? "本次分析尚未完成，待完成事项如下。" : "以下判断有条件成立，需按这些边界采用。"}</p>
    <ul className="mt-1 space-y-1 text-muted-foreground">{boundaries.map((text, index) => <li key={index}>{text}</li>)}</ul>
  </div>;
}

export function AnalysisAnswerView({ answer }: { answer: AnalysisAnswer }) {
  const answerId = useId();
  const { panelId, activeId, togglePanel, dismissPanel } = useWorkspacePanel();
  useEffect(() => () => dismissPanel(answerId), [answerId, dismissPanel]);
  const numbers = new Map(answer.conclusions.map((conclusion, index) => [conclusion.id, index + 1]));
  const activeConclusion = answer.conclusions.find((conclusion) => activeId === `${answerId}:conclusion:${conclusion.id}`)?.id ?? null;
  const toggle = (id: string, event: MouseEvent<HTMLButtonElement>) => {
    const conclusion = answer.conclusions.find((value) => value.id === id);
    if (conclusion) togglePanel({ id: `${answerId}:conclusion:${id}`, title: `出处 ${numbers.get(id)}`, label: "数据出处", content: <AnalysisSourceData answer={answer} conclusion={conclusion} /> }, event.currentTarget);
  };
  const citation = (id: string) => <sup className="ml-1 inline-flex align-baseline leading-none"><button type="button" aria-label={`查看数据出处${numbers.get(id)}`} aria-controls={panelId} aria-expanded={activeConclusion === id} onClick={(event) => toggle(id, event)} className={`relative inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-semibold leading-none tabular-nums before:absolute before:-inset-3 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${activeConclusion === id ? "bg-accent-foreground text-primary-foreground" : "bg-primary/10 text-accent-foreground hover:bg-primary/20"}`}>{numbers.get(id)}</button></sup>;
  const blocks = analysisVisualPresentationBlocks(answer);
  const firstParagraph = answer.status !== "incomplete" && answer.review.verdict !== "revise" ? blocks.findIndex((block) => block.kind === "paragraph") : -1;
  return <div className="min-w-0 select-text">
    {answer.status === "incomplete" ? <AnswerBoundary answer={answer} /> : null}
    <div data-analysis-body className={`space-y-4 ${answer.status === "incomplete" ? "mt-4" : ""}`}>
      {blocks.map((block, index) => {
        if (block.kind === "visualization") return <VisualizationCard key={block.spec.id} chart={resolveAnalysisVisualization(block.spec, answer.evidence)} sourceContent={<AnalysisSourceData answer={answer} />} />;
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return <List key={index} className={`${block.ordered ? "list-decimal" : "list-disc"} space-y-2.5 pl-5 text-[15px] leading-7 text-[#425873] marker:text-[#8aa0b9]`}>{block.items.map((item, at) => <li key={at} className="break-words pl-1"><AnswerInline nodes={item.nodes} />{item.conclusionId ? citation(item.conclusionId) : null}</li>)}</List>;
        }
        const suffix = block.conclusionId ? citation(block.conclusionId) : null;
        if (block.kind === "heading") {
          const Heading = block.level <= 2 ? "h2" : block.level === 3 ? "h3" : "h4";
          return <Heading key={index} className={`break-words pt-3 font-semibold leading-8 tracking-tight text-foreground first:pt-0 ${block.level <= 2 ? "text-[18px]" : "text-base"}`}><AnswerInline nodes={block.nodes} />{suffix}</Heading>;
        }
        return <p key={index} className="whitespace-pre-wrap break-words text-[15px] leading-7 text-[#425873]">{index === firstParagraph ? <AnswerLead nodes={block.nodes} /> : <AnswerInline nodes={block.nodes} />}{suffix}</p>;
      })}
    </div>
    {answer.status === "conditional" ? <div className="mt-4"><AnswerBoundary answer={answer} /></div> : null}
    {answer.questions.length ? <div className="mt-4 space-y-2 text-sm leading-6"><p className="font-medium">需要你补充的业务信息</p>{answer.questions.map((question, index) => <p key={index} className="break-words text-muted-foreground">{question}</p>)}</div> : null}
    {numbers.size ? <nav aria-label="回答的数据出处" className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3"><span className="text-xs text-muted-foreground">数据出处</span>{answer.conclusions.map((conclusion) => <button key={conclusion.id} type="button" onClick={(event) => toggle(conclusion.id, event)} aria-label={`查看数据出处${numbers.get(conclusion.id)}`} aria-controls={panelId} aria-expanded={activeConclusion === conclusion.id} className={`min-h-11 max-w-full rounded-lg border px-3 py-2 text-left text-xs text-primary hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring ${activeConclusion === conclusion.id ? "border-primary/40 bg-secondary" : "border-border"}`}>出处 {numbers.get(conclusion.id)}</button>)}</nav> : null}
    {answer.status === "incomplete" && (answer.evidence.frames.length || answer.evidence.facts.length) ? <button type="button" aria-controls={panelId} aria-expanded={activeId === `${answerId}:evidence`} onClick={(event) => togglePanel({ id: `${answerId}:evidence`, title: "已核验依据", label: "分析尚未完成", content: <AnalysisSourceData answer={answer} /> }, event.currentTarget)} className="mt-4 min-h-11 rounded-lg border border-border px-3 py-2 text-sm text-primary hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring">查看已核验依据</button> : null}
  </div>;
}
