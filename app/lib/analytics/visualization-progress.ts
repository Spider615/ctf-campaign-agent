import { validateAnalysisEvidence } from "./analysis-v2-evidence.ts";
import { parseAttachmentCalculations, parseVisualizationSpec, resolveAnalysisVisualization, resolveAttachmentVisualization } from "./visualization.ts";
import { VISUALIZATION_SCHEMA, type VisualizationFileSource, type VisualizationPreview, type VisualizationProgressEvent } from "./visualization-types.ts";
import { validAttachmentId } from "../attachments/types.ts";

type Upsert = Extract<VisualizationProgressEvent, { action: "upsert" }>;
export type VisualizationProgressState = { runs: Record<string, number>; items: Upsert[]; invalidated?: string };
function fail(message: string): never { throw new Error(`图表过程${message}`); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail("格式不正确"); return value as Record<string, unknown>; }
function text(value: unknown, max = 120): string { if (typeof value !== "string" || !value.trim() || value.length > max) fail("引用格式不正确"); return value; }
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export function resolveVisualizationPreview(preview: VisualizationPreview) {
  return preview.spec.source.kind !== "attachment" ? resolveAnalysisVisualization(preview.spec, preview.evidence!) : resolveAttachmentVisualization(preview.spec, preview.calculations ?? [], preview.sources ?? []);
}

export function parseVisualizationProgress(value: unknown): VisualizationProgressEvent {
  const raw = record(value);
  if (raw.type !== "visualization" || raw.schema !== VISUALIZATION_SCHEMA || !Number.isSafeInteger(raw.epoch) || Number(raw.epoch) < 0 || Number(raw.epoch) > 10000) fail("版本或证据代次不正确");
  const runId = text(raw.runId), epoch = Number(raw.epoch);
  if (raw.action === "retract") {
    if (!Array.isArray(raw.ids) || raw.ids.length > 6 || !["scope_changed", "snapshot_changed", "source_unavailable"].includes(String(raw.reason))) fail("撤回信息不正确");
    const ids = raw.ids.map((id) => text(id)); if (new Set(ids).size !== ids.length) fail("撤回引用重复");
    return { type: "visualization", schema: VISUALIZATION_SCHEMA, runId, epoch, action: "retract", ids, reason: raw.reason as "scope_changed" };
  }
  if (raw.action !== "upsert") fail("动作不支持");
  const input = record(raw.preview); const spec = parseVisualizationSpec(input.spec); let preview: VisualizationPreview;
  if (spec.source.kind !== "attachment") {
    if (input.calculations !== undefined || input.sources !== undefined) fail("不能混入文件或其他来源");
    preview = { spec, evidence: validateAnalysisEvidence(input.evidence) };
  } else {
    if (input.evidence !== undefined || !Array.isArray(input.sources) || input.sources.length > 200) fail("文件来源不正确");
    const sources: VisualizationFileSource[] = input.sources.map((entry) => {
      const source = record(entry);
      if (!validAttachmentId(source.attachmentId) || typeof source.version !== "string" || !/^[a-f0-9]{64}$/.test(source.version)) fail("文件身份或版本不正确");
      return { id: text(source.id), attachmentId: source.attachmentId, version: source.version, name: text(source.name, 255), location: text(source.location, 600), excerpt: text(source.excerpt, 12000), ...(source.calculationId === undefined ? {} : { calculationId: text(source.calculationId) }) };
    });
    if (new Set(sources.map((item) => item.id)).size !== sources.length) fail("文件来源重复");
    preview = { spec, calculations: parseAttachmentCalculations(input.calculations), sources };
  }
  resolveVisualizationPreview(preview);
  return { type: "visualization", schema: VISUALIZATION_SCHEMA, runId, epoch, action: "upsert", preview };
}

export function reduceVisualizationProgress(previous: VisualizationProgressState | undefined, input: VisualizationProgressEvent): VisualizationProgressState {
  const event = parseVisualizationProgress(input); const state = previous ?? { runs: {}, items: [] };
  const known = state.runs[event.runId];
  if (known !== undefined && event.epoch < known) fail("证据代次已经失效");
  const own = state.items.filter((item) => item.runId === event.runId);
  if (event.action === "retract") {
    if (known !== undefined && event.epoch <= known) fail("撤回代次必须向前推进");
    if (own.some((item) => !event.ids.includes(item.preview.spec.id))) fail("撤回遗漏旧证据图表");
    return { runs: { ...state.runs, [event.runId]: event.epoch }, items: state.items.filter((item) => item.runId !== event.runId), invalidated: event.reason === "source_unavailable" ? "图表来源已删除或失效" : "范围或快照已更新，旧图表已撤回" };
  }
  if (known !== undefined && event.epoch > known && own.length) fail("新证据代次必须先撤回旧图表");
  const prior = own.find((item) => item.preview.spec.id === event.preview.spec.id);
  if (prior) {
    if (event.preview.spec.revision < prior.preview.spec.revision) fail("修订顺序回退");
    if (event.preview.spec.revision === prior.preview.spec.revision) {
      if (canonical(prior) !== canonical(event)) fail("同一修订内容冲突");
      return state;
    }
  } else if (state.items.length >= 12) fail("阶段图表数量过多");
  return { runs: { ...state.runs, [event.runId]: event.epoch }, items: [...state.items.filter((item) => item.runId !== event.runId || item.preview.spec.id !== event.preview.spec.id), event] };
}

export function restoreVisualizationProgress(value: unknown): VisualizationProgressState | undefined {
  if (value === undefined) return undefined;
  try {
    const raw = record(value); if (!Array.isArray(raw.items) || raw.items.length > 12) return undefined;
    let state: VisualizationProgressState | undefined;
    for (const item of raw.items) state = reduceVisualizationProgress(state, parseVisualizationProgress(item));
    return state ?? { runs: {}, items: [], ...(typeof raw.invalidated === "string" ? { invalidated: raw.invalidated.slice(0, 100) } : {}) };
  } catch { return undefined; }
}
