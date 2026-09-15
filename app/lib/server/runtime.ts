import { env } from "cloudflare:workers";

import { getDbBinding } from "../../../db/index.ts";
import { parseAgentResult, type AgentRequest, type AgentResult } from "../agent/protocol.ts";
import { createD1Store } from "./session-store.ts";
import { TurnError, type TurnDeps } from "./turns.ts";

const DEFAULT_AGENT_URL = "http://127.0.0.1:8788";

// Agent 服务（agent/server.ts）跑 Claude Agent SDK；这里只负责把这一轮发过去、把结果拿回来。
async function runAgentRemote(request: AgentRequest): Promise<AgentResult> {
  const base = (env.AGENT_SERVICE_URL || DEFAULT_AGENT_URL).replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(`${base}/turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.AGENT_SERVICE_TOKEN ? { authorization: `Bearer ${env.AGENT_SERVICE_TOKEN}` } : {}),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(150_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new Error("Agent 超时了，请重试");
    throw new Error("连不上 Agent 服务，请先运行 npm run dev:agent");
  }
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `Agent 服务出错（${response.status}）`);
  return parseAgentResult(body);
}

export function todayInShanghai(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function runtimeDeps(): TurnDeps {
  return {
    store: createD1Store(getDbBinding()),
    runAgent: runAgentRemote,
    today: todayInShanghai(),
  };
}

export function errorResponse(error: unknown, fallback: string): Response {
  if (error instanceof TurnError) return Response.json({ error: error.message }, { status: error.status });
  console.error(fallback, error);
  return Response.json({ error: fallback }, { status: 503 });
}
