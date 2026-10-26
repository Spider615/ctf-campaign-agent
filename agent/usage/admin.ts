// 管理端登录：一个共享密码，签发 12 小时的 HMAC 凭据「<过期毫秒>.<签名>」。
// 密码和签名密钥只在 Agent 环境里读取，Workers 只转发 cookie。
import { createHmac, timingSafeEqual } from "node:crypto";

import { beijingDay, type TurnStatus, type UsageChannel, type UsageEntry, type UsageFilter, type UsagePage } from "./store.ts";

export const ADMIN_SESSION_SECONDS = 12 * 3600;
export type AdminAuth = { configured: boolean; locked(): boolean; login(password: string): string | null; verify(token: string | undefined): boolean };
// 登录限速：连续输错 5 次锁 5 分钟（共享密码，防暴力猜测）。
const LOGIN_LIMIT = 5; const LOGIN_LOCK_MS = 5 * 60_000;

const sameText = (a: string, b: string) => {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createAdminAuth({ password, secret, now = Date.now }: { password?: string; secret?: string; now?: () => number }): AdminAuth {
  const configured = Boolean(password) && Boolean(secret && secret.length >= 32);
  const failures = { count: 0, lockedUntil: 0 };
  const sign = (expires: string) => createHmac("sha256", secret ?? "").update(`ctf-internal:${expires}`).digest("base64url");
  return {
    configured,
    locked: () => now() < failures.lockedUntil,
    login(input) {
      if (!configured || now() < failures.lockedUntil) return null;
      if (!input || !sameText(input, password!)) {
        if (++failures.count >= LOGIN_LIMIT) { failures.count = 0; failures.lockedUntil = now() + LOGIN_LOCK_MS; }
        return null;
      }
      failures.count = 0;
      const expires = String(now() + ADMIN_SESSION_SECONDS * 1000);
      return `${expires}.${sign(expires)}`;
    },
    verify(token) {
      if (!configured || !token) return false;
      const match = /^(\d{1,16})\.([A-Za-z0-9_-]{1,128})$/.exec(token);
      if (!match || Number(match[1]) < now()) return false;
      return sameText(match[2], sign(match[1]));
    },
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRIES: UsageEntry[] = ["analysis", "attachments", "campaign", "insight"];
const CHANNELS: UsageChannel[] = ["deepseek", "juzi"];
const STATUSES: TurnStatus[] = ["running", "answered", "partial", "failed", "cancelled", "interrupted"];

// 默认最近 7 天（北京时间）；跨度最多 92 天。
const PAGE_SIZES = [10, 20, 50, 100];
export function parseUsageQuery(params: URLSearchParams): UsageFilter & UsagePage {
  const today = beijingDay(Date.now());
  const from = params.get("from") ?? beijingDay(Date.now() - 6 * 86400_000);
  const to = params.get("to") ?? today;
  if (!DATE.test(from) || !DATE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new Error("日期格式应为 YYYY-MM-DD");
  if (from > to) throw new Error("开始日期不能晚于结束日期");
  if ((Date.parse(to) - Date.parse(from)) / 86400_000 > 91) throw new Error("一次最多查 92 天");
  const filter: UsageFilter & UsagePage = { from, to };
  const pick = <T extends string>(name: string, allowed: T[]) => {
    const value = params.get(name);
    if (value === null || value === "") return undefined;
    if (!allowed.includes(value as T)) throw new Error(`不支持的筛选：${name}`);
    return value as T;
  };
  const entry = pick("entry", ENTRIES); if (entry) filter.entry = entry;
  const channel = pick("channel", CHANNELS); if (channel) filter.channel = channel;
  const status = pick("status", STATUSES); if (status) filter.status = status;
  const model = params.get("model")?.trim(); if (model) { if (model.length > 100) throw new Error("模型名太长"); filter.model = model; }
  const keyword = params.get("keyword")?.trim(); if (keyword) { if (keyword.length > 100) throw new Error("关键词最多 100 字"); filter.keyword = keyword; }
  const page = params.get("page");
  if (page) { const value = Number(page); if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) throw new Error("页码不正确"); filter.page = value; }
  const pageSize = params.get("pageSize");
  if (pageSize) { const value = Number(pageSize); if (!PAGE_SIZES.includes(value)) throw new Error("每页条数只能是 10、20、50 或 100"); filter.pageSize = value; }
  return filter;
}
