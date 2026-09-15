import assert from "node:assert/strict";
import test from "node:test";

import { createMotherDaySeed } from "../app/lib/campaign/demo-seeds.ts";
import { callDeepSeek } from "../app/lib/server/deepseek.ts";
import {
  deserializeVersion,
  serializeVersion,
} from "../app/lib/server/session-codec.ts";
import { isCampaignDraft } from "../app/lib/server/request-validation.ts";

test("draft versions survive database JSON serialization", () => {
  const draft = createMotherDaySeed();
  const encoded = serializeVersion(draft, [{ id: "ics-1" }], 3);
  const decoded = deserializeVersion(encoded);

  assert.equal(decoded.seq, 3);
  assert.equal(decoded.draft.brief.icsName, "母亲节金礼");
  assert.deepEqual(decoded.orders, [{ id: "ics-1" }]);
});

test("DeepSeek request uses V4.1 Flash model and JSON mode", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fakeFetch: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "{\"summary\":\"ok\"}" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const result = await callDeepSeek({
    apiKey: "test-key",
    messages: [{ role: "user", content: "测试" }],
    fetcher: fakeFetch,
  });

  assert.equal(result, "{\"summary\":\"ok\"}");
  assert.equal(requestBody?.model, "deepseek-flash");
  assert.deepEqual(requestBody?.response_format, { type: "json_object" });
});

test("DeepSeek failures return a concise typed error", async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 });

  await assert.rejects(
    () =>
      callDeepSeek({
        apiKey: "test-key",
        messages: [{ role: "user", content: "测试" }],
        fetcher: fakeFetch,
      }),
    /模型服务暂时不可用（429）/,
  );
});

test("session routes reject partial campaign drafts", () => {
  assert.equal(isCampaignDraft({ id: "partial" }), false);
  assert.equal(isCampaignDraft(createMotherDaySeed()), true);
});
