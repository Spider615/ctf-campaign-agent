export const ANALYTICS_CHANGED = "ctf:analytics-changed";
export async function analyticsRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", signal,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => null) as (T & { error?: unknown }) | null;
  if (!response.ok || !result) throw new Error(typeof result?.error === "string" ? result.error : "分析请求暂时无法完成，请重试");
  return result;
}
export function notifyAnalyticsChanged() { window.dispatchEvent(new Event(ANALYTICS_CHANGED)); }
export function downloadCsv(name: string, rows: Array<Array<string | number | null>>) {
  const content = rows.map((row) => row.map((value) => {
    const raw = value === null ? "" : String(value);
    // 文本不能作为表格公式执行，数字仍保持数值口径。
    const text = typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${text.replace(/"/g, '""')}"`;
  }).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
