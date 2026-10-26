// 管理端浏览器请求：凭据在 HttpOnly cookie 里，由 Workers 转给 Agent 验签；401 回登录页。
export class InternalApiError extends Error {}

export async function internalGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/internal/${path}`, { credentials: "same-origin", signal, cache: "no-store" });
  if (response.status === 401) {
    // 整页跳转：登录后新 cookie 生效、页面状态清空。
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/internal/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    throw new InternalApiError("请先登录管理端");
  }
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new InternalApiError(body?.error ?? `请求失败（${response.status}）`);
  return body as T;
}

export async function internalPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/internal/${path}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (response.status === 401) {
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/internal/login?next=${encodeURIComponent(window.location.pathname)}`;
    throw new InternalApiError("请先登录管理端");
  }
  const result = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new InternalApiError(result?.error ?? `请求失败（${response.status}）`);
  return result as T;
}

export async function internalLogin(password: string): Promise<string | null> {
  const response = await fetch("/api/internal/login", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  if (response.ok) return null;
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? "登录失败";
}

export async function internalLogout() {
  await fetch("/api/internal/logout", { method: "POST", credentials: "same-origin" });
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.href = "/internal/login";
}
