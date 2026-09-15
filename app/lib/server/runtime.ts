import { env } from "cloudflare:workers";

import { getDbBinding } from "../../../db/index.ts";
import { callDeepSeek, type DeepSeekMessage } from "./deepseek.ts";
import { createD1Store } from "./session-store.ts";
import { TurnError, type TurnDeps } from "./turns.ts";

const FAKE_COPY = {
  externalName: "母亲节 · 金饰心意",
  icsName: "母亲节金饰礼遇",
  content: "活动期间，华东区指定门店黄金类商品满 3000 元减 300 元。",
  slogan: "把心意戴在身边",
};

// 仅开发环境：CAMPAIGN_FAKE_MODEL=1 时不请求 DeepSeek，给 E2E 用。
function fakeModel(messages: DeepSeekMessage[]): Promise<string> {
  const system = messages[0]?.content ?? "";
  if (system.includes("你只负责文案")) return Promise.resolve(JSON.stringify(FAKE_COPY));
  if (system.includes("返回 {summary, fields, unresolved}")) return Promise.resolve(JSON.stringify({ summary: "", fields: {}, unresolved: [] }));
  return Promise.resolve(JSON.stringify({ ops: [] }));
}

export function todayInShanghai(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function runtimeDeps(): TurnDeps {
  const isDev = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
  const useFakeModel = isDev && env.CAMPAIGN_FAKE_MODEL === "1";
  return {
    store: createD1Store(getDbBinding()),
    callModel: useFakeModel ? fakeModel : (messages) => callDeepSeek({ messages }),
    today: todayInShanghai(),
  };
}

export function errorResponse(error: unknown, fallback: string): Response {
  if (error instanceof TurnError) return Response.json({ error: error.message }, { status: error.status });
  console.error(fallback, error);
  return Response.json({ error: fallback }, { status: 503 });
}
