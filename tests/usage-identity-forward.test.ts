import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { forwardedUsageHeaders } from "../app/lib/server/usage-identity.ts";

const OWNER = "33333333-3333-4333-8333-333333333333";
const CONVERSATION = "44444444-4444-4444-8444-444444444444";
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("转发访客、会话和管理员凭据", () => {
  const request = new Request("https://x.test/api/analytics/history", { headers: { cookie: `a=1; ctf_internal=123.abc_-; b=2`, "x-conversation-id": CONVERSATION } });
  assert.deepEqual(forwardedUsageHeaders(request, { owner: OWNER }), { "x-ctf-visitor": OWNER, "x-ctf-conversation": CONVERSATION, "x-ctf-admin": "123.abc_-" });
});

test("非法会话编号和凭据不转发", () => {
  const request = new Request("https://x.test/", { headers: { cookie: "ctf_internal=<script>", "x-conversation-id": "../../etc" } });
  assert.deepEqual(forwardedUsageHeaders(request, { owner: "not-a-uuid" }), {});
});

test("显式会话编号优先于请求头", () => {
  const request = new Request("https://x.test/", { headers: { "x-conversation-id": CONVERSATION } });
  assert.deepEqual(forwardedUsageHeaders(request, { conversation: "campaign-abc" }), { "x-ctf-conversation": "campaign-abc" });
});

test("直接问答请求带当前对话编号", () => {
  const client = read("app/lib/client/history-stream.ts");
  assert.match(client, /"X-Conversation-Id": conversationId/);
  assert.match(read("app/components/analytics/history-conversation.tsx"), /postHistoryStream\(request, progress, controller\.signal, runId, conversationId\)/);
});

test("四个入口都把身份交给 Agent 请求", () => {
  assert.match(read("app/api/analytics/history/route.ts"), /forwardedUsageHeaders\(request, \{ owner \}\)/);
  assert.match(read("app/api/analytics/insight/ask/route.ts"), /forwardedUsageHeaders\(request, \{ owner \}\)/);
  assert.match(read("app/lib/server/runtime.ts"), /forwardedUsageHeaders\(request, \{ owner \}\)/, "附件问答转发");
  assert.match(read("app/api/sessions/[id]/turns/route.ts"), /forwardedUsageHeaders\(request, \{ conversation: id \}\)/);
  assert.match(read("app/api/analytics/reports/[id]/explain/route.ts"), /forwardedUsageHeaders\(request, \{ owner, conversation: /, "报告解读按报告归会话");
});
