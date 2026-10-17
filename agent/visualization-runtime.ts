import { randomUUID } from "node:crypto";
import { selectAnalysisEvidence } from "../app/lib/analytics/analysis-v2-evidence.ts";
import type { AnalysisDraft, AnalysisEvidence } from "../app/lib/analytics/analysis-v2-types.ts";
import { parseVisualizationSpec, resolveAnalysisVisualization, resolveAttachmentVisualization } from "../app/lib/analytics/visualization.ts";
import { VISUALIZATION_SCHEMA, VISUALIZATION_LIMITS, type AttachmentCalculation, type VisualizationFileSource, type VisualizationProgressEvent, type VisualizationSpec } from "../app/lib/analytics/visualization-types.ts";

type Placement = { id: string; afterBlockIndex: number; conclusionId?: string };
type Input = Pick<VisualizationSpec, "kind" | "source"> & Partial<Pick<VisualizationSpec, "renderer" | "selection" | "title">> & { id?: string };
export function createVisualizationRegistry(options: { runId: string; enabled: boolean; emit?: (event: VisualizationProgressEvent) => void; analysisEvidence?: () => AnalysisEvidence; attachmentEvidence?: () => { calculations: AttachmentCalculation[]; sources: VisualizationFileSource[] }; audit?: (kind: string, data: unknown) => void; maxCharts?: number }) {
  let epoch = 0; const items = new Map<string, VisualizationSpec>(); const signatures = new Map<string, string>();
  return {
    present(rawInput: Input) {
      if (!options.enabled) throw new Error("当前客户端未启用图表展示");
      const input = { ...rawInput, renderer: rawInput.renderer ?? "native", selection: rawInput.selection ?? { mode: "all" as const } };
      const prior = input.id ? items.get(input.id) : undefined;
      if (input.id && !prior) throw new Error("图表修订引用不存在");
      const signature = JSON.stringify({ kind: input.kind, renderer: input.renderer, source: input.source, selection: input.selection, title: input.title });
      const knownId = input.id ?? signatures.get(signature); const known = knownId ? items.get(knownId) : undefined;
      const spec = parseVisualizationSpec({ id: known?.id ?? randomUUID(), revision: known ? known.revision + (signature === JSON.stringify({ kind: known.kind, renderer: known.renderer, source: known.source, selection: known.selection, title: known.title }) ? 0 : 1) : 1, kind: input.kind, renderer: input.renderer, source: input.source, selection: input.selection, afterBlockIndex: 0, ...(input.title ? { title: input.title } : {}) });
      const maxCharts = options.maxCharts ?? VISUALIZATION_LIMITS.charts;
      if (!known && items.size >= maxCharts) throw new Error(`本轮最多准备 ${maxCharts} 张图，请复用已有图表或用文字说明`);
      const evidence = options.analysisEvidence?.(); const attachment = options.attachmentEvidence?.();
      const chart = spec.source.kind !== "attachment" && evidence ? resolveAnalysisVisualization(spec, evidence) : spec.source.kind === "attachment" && attachment ? resolveAttachmentVisualization(spec, attachment.calculations, attachment.sources) : (() => { throw new Error("图表来源不属于本轮已读取的证据"); })();
      if (!known || spec.revision !== known.revision) {
        for (const [key, id] of signatures) if (id === spec.id) signatures.delete(key);
        items.set(spec.id, spec); signatures.set(signature, spec.id);
        let preview;
        if (spec.source.kind !== "attachment" && evidence) {
          const projected = selectAnalysisEvidence({ status: "answered", conclusions: [], blocks: [{ kind: "paragraph", nodes: [{ kind: "text", text: "图表预览" }] }], questions: [], userConditions: [], trialParameters: [], visualizations: { schema: VISUALIZATION_SCHEMA, items: [spec] } } as AnalysisDraft, evidence);
          // 预览保留数值父链与实际检查样本；完整方法记录继续保存在最终证据。
          projected.methods = projected.methods.map((method) => ({ ...method, checks: method.checks.filter((check) => check.status === "performed").slice(0, 1) }));
          preview = { spec, evidence: projected };
        } else {
          const ids = spec.source.kind === "attachment" ? spec.source.calculationIds : [];
          const calculations = attachment!.calculations.filter((item) => ids.includes(item.id)); const sourceIds = new Set(calculations.flatMap((item) => item.groups.map((group) => group.sourceId)));
          preview = { spec, calculations, sources: attachment!.sources.filter((item) => sourceIds.has(item.id)) };
        }
        const event: VisualizationProgressEvent = { type: "visualization", schema: VISUALIZATION_SCHEMA, runId: options.runId, epoch, action: "upsert", preview };
        if (JSON.stringify(event).length <= 2_000_000) options.emit?.(event);
        options.audit?.("visualization", { spec, epoch });
      }
      return { visualizationId: spec.id, revision: spec.revision, chart };
    },
    place(placements: Placement[] | undefined, acceptedImports: VisualizationSpec[] = []) {
      if (placements === undefined) return undefined;
      if (!options.enabled || placements.length > 6 || new Set(placements.map((item) => item.id)).size !== placements.length) throw new Error("图表引用重复、数量过多或未启用");
      return { schema: VISUALIZATION_SCHEMA, items: placements.map((placement) => {
        const candidates = [items.get(placement.id), ...acceptedImports.filter((item) => item.id === placement.id)].filter((item): item is VisualizationSpec => Boolean(item));
        if (candidates.length !== 1) throw new Error("图表引用不存在、重复或来源已经失效");
        return parseVisualizationSpec({ ...candidates[0], ...placement });
      }) };
    },
    view() { return [...items.values()].map((item) => ({ id: item.id, revision: item.revision, source: item.source, kind: item.kind, renderer: item.renderer })); },
    reset(reason: "scope_changed" | "snapshot_changed" | "source_unavailable") {
      const ids = [...items.keys()]; epoch++; items.clear(); signatures.clear();
      if (ids.length) options.emit?.({ type: "visualization", schema: VISUALIZATION_SCHEMA, runId: options.runId, epoch, action: "retract", ids, reason });
    },
  };
}
