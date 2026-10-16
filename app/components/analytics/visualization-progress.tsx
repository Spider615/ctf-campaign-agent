"use client";

import type { VisualizationProgressState } from "../../lib/analytics/visualization-progress.ts";
import { resolveVisualizationPreview } from "../../lib/analytics/visualization-progress.ts";
import { VisualizationCard, VisualizationSourceSummary } from "./visualization-card.tsx";

export function VisualizationProgress({ state, live, conversationId }: { state: VisualizationProgressState; live: boolean; conversationId?: string }) {
  return <div className="min-w-0 space-y-4">{state.items.map((event) => {
    const chart = resolveVisualizationPreview(event.preview);
    const versions = [...new Set(event.preview.evidence?.frames.map((frame) => frame.datasetVersion) ?? event.preview.calculations?.map((calculation) => calculation.version) ?? [])];
    return <VisualizationCard key={`${event.runId}:${chart.id}`} chart={chart} status={live ? "running" : "incomplete"} conversationId={conversationId} files={(event.preview.calculations ?? []).map((calculation) => ({ id: calculation.attachmentId, version: calculation.version }))} sourceContent={<VisualizationSourceSummary chart={chart} version={versions.join("、")} />} />;
  })}{state.invalidated ? <p role="status" className="text-xs leading-6 text-muted-foreground">{state.invalidated}</p> : null}</div>;
}
