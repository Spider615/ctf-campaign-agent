import type { ResolvedVisualization } from "./visualization-types.ts";

export const VISUALIZATION_CSP = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
export const escapeVisualizationText = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const colors = ["#2470cc", "#168475", "#9b62b0", "#b57524"];
// 比率图按百分数显示刻度和数值，精确原值仍在数据表里。
export const visualizationValueLabel = (chart: Pick<ResolvedVisualization, "valueFormat">, value: number) => chart.valueFormat === "percent" ? `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value * 100)}%` : tick(value);
const tick = (value: number) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2, notation: Math.abs(value) >= 10000 ? "compact" : "standard" }).format(value);
const trim = (value: string, length = 13) => [...value].length > length ? [...value].slice(0, length).join("") + "…" : value;

// 图形只由规范数据和固定 SVG 元素生成；业务文字始终转义，不接收模型标记或样式。
export function visualizationSvg(chart: ResolvedVisualization, hiddenSeries: readonly string[] = [], viewportWidth = 720): string {
  const escape = escapeVisualizationText; const width = Math.max(240, Math.min(1200, viewportWidth));
  const count = chart.categories.length;
  const stacked = chart.kind === "stacked_bar"; const line = chart.kind === "line";
  const height = line ? chart.xAxis ? 340 : 300 : Math.max(180, 70 + count * (stacked ? 34 : 18 * chart.series.length + 14));
  const left = line ? 64 : width < 480 ? 94 : 128, right = width < 480 ? 30 : 64, top = 12, bottom = chart.xAxis ? 64 : 40;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const values = chart.series.flatMap((series) => series.values.map((value) => value.value).filter((v): v is number => v !== null));
  const positives = chart.categories.map((_, at) => chart.series.reduce((sum, series) => sum + Math.max(0, series.values[at].value ?? 0), 0));
  const negatives = chart.categories.map((_, at) => chart.series.reduce((sum, series) => sum + Math.min(0, series.values[at].value ?? 0), 0));
  const low = Math.min(0, ...(stacked ? negatives : values)); const high = Math.max(0, ...(stacked ? positives : values));
  const range = high - low || 1; const max = high === low ? low + 1 : high;
  const x = (v: number) => left + (v - low) / range * plotWidth;
  const y = (v: number) => top + (max - v) / range * plotHeight;
  const shown = (value: number) => visualizationValueLabel(chart, value);
  const pointLabel = (seriesIndex: number, at: number) => { const value = chart.series[seriesIndex].values[at]; return `${chart.categories[at].label}，${chart.series[seriesIndex].label}：${value.value === null ? "未提供" : chart.valueFormat === "percent" ? shown(value.value) : `${value.exact}${chart.unit}`}`; };
  const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(chart.title)}" style="display:block;width:100%;height:auto;min-width:${width}px;font-family:system-ui,sans-serif;font-size:12px"><style>.viz-row:hover{fill:#eef2f7}</style><title>${escape(chart.title)}</title><desc>${escape(`${chart.scope}；${chart.selectionLabel}；单位：${chart.unit}。完整数值见数据表。`)}</desc>`];
  const steps = width < 480 ? 2 : 4;
  for (let i = 0; i <= steps; i++) {
    const value = low + (max - low) * i / steps;
    if (line) { const pos = y(value); parts.push(`<line x1="${left}" y1="${pos}" x2="${width - right}" y2="${pos}" stroke="#eef2f7"/><text x="${left - 10}" y="${pos + 4}" text-anchor="end" fill="#52677e">${escape(shown(value))}</text>`); }
    else { const pos = x(value); parts.push(`<line x1="${pos}" y1="${top}" x2="${pos}" y2="${height - bottom}" stroke="#eef2f7"/><text x="${pos}" y="${height - bottom + 24}" text-anchor="middle" fill="#52677e">${escape(shown(value))}</text>`); }
  }
  if (line) {
    const times = chart.categories.map((item) => chart.xAxis?.kind === "number" ? item.numericValue! : Date.parse(`${item.key.split("/")[0]}T00:00:00Z`));
    const firstTime = Math.min(...times), span = Math.max(...times) - firstTime;
    const atX = (at: number) => left + (span ? (times[at] - firstTime) / span : 0.5) * plotWidth;
    const labelCount = width < 480 ? 3 : 6;
    const labels = new Set(Array.from({ length: labelCount }, (_, at) => Math.round((count - 1) * at / (labelCount - 1))));
    chart.categories.forEach((category, at) => { if (labels.has(at)) parts.push(`<text x="${atX(at)}" y="${height - bottom + 24}" text-anchor="middle" fill="#52677e">${escape(trim(category.label, 10))}</text>`); });
    chart.categories.forEach((_, at) => {
      const from = at ? (atX(at - 1) + atX(at)) / 2 : left; const to = at < count - 1 ? (atX(at) + atX(at + 1)) / 2 : width - right;
      parts.push(`<rect class="viz-row" data-row="${at}" x="${from}" y="${top}" width="${Math.max(1, to - from)}" height="${plotHeight}" fill="transparent"/>`);
    });
    chart.series.forEach((series, si) => {
      if (hiddenSeries.includes(series.key)) return;
      let path = ""; let open = false;
      series.values.forEach((value, at) => { if (value.value === null) { open = false; return; } path += `${open ? "L" : "M"}${atX(at)},${y(value.value)} `; open = true; });
      parts.push(`<path d="${path}" fill="none" stroke="${colors[si]}" stroke-width="2.5"${si ? ` stroke-dasharray="${si * 3 + 2} ${si + 2}"` : ""}/>`);
      series.values.forEach((value, at) => { if (value.value === null) return; const label = escape(pointLabel(si, at)); parts.push(`<circle cx="${atX(at)}" cy="${y(value.value)}" r="4" fill="${colors[si]}" stroke="white" pointer-events="none" data-point="${si}:${at}" tabindex="0" role="img" aria-label="${label}"></circle>`); });
    });
  } else {
    parts.push(`<line x1="${x(0)}" y1="${top}" x2="${x(0)}" y2="${height - bottom}" stroke="#8299b0"/>`);
    const rowHeight = plotHeight / Math.max(1, count);
    chart.categories.forEach((category, at) => {
      const mid = top + rowHeight * (at + 0.5);
      parts.push(`<rect class="viz-row" data-row="${at}" x="${left}" y="${top + rowHeight * at}" width="${plotWidth}" height="${rowHeight}" fill="transparent"/>`);
      parts.push(`<text x="${left - 12}" y="${mid + 4}" text-anchor="end" fill="#364f68"><title>${escape(category.label)}</title>${escape(trim(category.label, Math.max(3, Math.floor((left - 28) / 12))))}</text>`);
      let positive = 0, negative = 0;
      chart.series.forEach((series, si) => {
        if (hiddenSeries.includes(series.key)) return;
        const value = series.values[at]; const barHeight = stacked ? 20 : Math.min(18, (rowHeight - 10) / chart.series.length);
        const yTop = stacked ? mid - barHeight / 2 : mid - chart.series.length * barHeight / 2 + si * barHeight;
        const label = escape(pointLabel(si, at));
        if (value.value === null) { if (!stacked) parts.push(`<text x="${Math.min(width - right - 40, x(0) + 6)}" y="${yTop + barHeight - 2}" fill="#6f8092" pointer-events="none" data-point="${si}:${at}" tabindex="0" aria-label="${label}">未提供</text>`); return; }
        const start = stacked ? value.value >= 0 ? positive : negative : 0; const end = start + value.value;
        if (stacked) { if (value.value >= 0) positive = end; else negative = end; }
        parts.push(`<rect x="${Math.min(x(start), x(end))}" y="${yTop}" width="${Math.max(1, Math.abs(x(end) - x(start)))}" height="${barHeight - 2}" rx="3" fill="${colors[si]}" pointer-events="none" data-point="${si}:${at}" tabindex="0" role="img" aria-label="${label}"></rect>`);
        if (!stacked && count <= 12 && width >= 480) {
          const label = shown(value.value);
          if (value.value >= 0 || Math.abs(x(end) - x(start)) >= label.length * 7 + 10) parts.push(`<text x="${x(end) + 5}" y="${yTop + barHeight - 3}" text-anchor="start" pointer-events="none" fill="${value.value < 0 ? "white" : "#364f68"}">${escape(label)}</text>`);
        }
      });
    });
  }
  if (chart.xAxis) parts.push(`<text x="${left + plotWidth / 2}" y="${height - 28}" text-anchor="middle" fill="#52677e">${escape(`${chart.xAxis.label}（${chart.xAxis.unit}）`)}</text>`);
  const unitLabel = chart.valueFormat === "percent" || /单位未提供/.test(chart.unit) ? "" : chart.unit;
  parts.push(`${unitLabel ? `<text x="${width - right}" y="${height - 6}" text-anchor="end" fill="#8a9bb0">${escape(unitLabel)}</text>` : ""}</svg>`);
  return parts.join("");
}

export function visualizationHtml(chart: ResolvedVisualization): string {
  const escape = escapeVisualizationText;
  const table = `<table><caption>图表数据 · ${escape(chart.unit)}</caption><thead><tr><th scope="col">${chart.xAxis ? escape(`${chart.xAxis.label}（${chart.xAxis.unit}）`) : "分组"}</th>${chart.series.map((s) => `<th scope="col">${escape(s.label)}</th>`).join("")}</tr></thead><tbody>${chart.categories.map((category, at) => `<tr><th scope="row">${escape(category.label)}</th>${chart.series.map((series) => `<td>${escape(series.values[at].exact ?? "未提供")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  return `<!doctype html><html lang="zh-CN"><head><meta http-equiv="Content-Security-Policy" content="${VISUALIZATION_CSP}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(chart.title)}</title><style>body{margin:0;padding:20px;background:#fff;color:#243e58;font:14px/1.6 system-ui,sans-serif}h1{font-size:18px;margin:0 0 8px}p{overflow-wrap:anywhere;color:#52677e}.plot{overflow:auto;max-height:560px}table{border-collapse:collapse;width:100%;margin-top:16px;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid #dce6ef;text-align:left;padding:8px;overflow-wrap:anywhere}td{text-align:right}caption{text-align:left;font-weight:600}.legend{display:flex;flex-wrap:wrap;gap:12px}.key{display:inline-block;width:10px;height:10px;margin-right:5px;border-radius:2px}</style></head><body><h1>${escape(chart.title)}</h1><p>${escape(chart.scope)}<br>${escape(chart.selectionLabel)} · 单位：${escape(chart.unit)}</p><div class="legend">${chart.series.map((series, at) => `<span><i class="key" style="background:${colors[at]}"></i>${escape(series.label)}</span>`).join("")}</div><div class="plot">${visualizationSvg(chart, [], 480)}</div><p>${escape(chart.definition)}</p>${chart.limitations.length ? `<p>${escape(chart.limitations.join("；"))}</p>` : ""}${table}</body></html>`;
}
