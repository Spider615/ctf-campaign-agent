import assert from "node:assert/strict";
import test from "node:test";

import { promoCtaMessageId, promoWasGenerated } from "../app/lib/client/promo-cta.ts";
import type { ChatMessage } from "../app/lib/campaign/ics1811/messages.ts";

const sheet = (id: string, versionSeq: number): ChatMessage => ({
  id,
  role: "assistant",
  createdAt: "2026-09-17T03:00:00.000Z",
  content: {
    v: 2,
    kind: "agent_fill_sheet",
    versionSeq,
    sheet: { banner: "", info: [], afterAdd: [], settlement: null, details: [], finish: [], postActions: [], selfCheck: [] },
  },
});

test("communication CTA stays on the first fill-sheet message after later sheet updates", () => {
  const messages = [sheet("old", 1), sheet("latest", 2)];
  assert.equal(promoCtaMessageId({ messages, briefReady: true, communication: null }), "old");
  assert.equal(promoCtaMessageId({ messages, briefReady: false, communication: null }), null);
  assert.equal(promoCtaMessageId({ messages, briefReady: true, communication: { concept: {} } }), null);
  assert.equal(promoCtaMessageId({ messages: [], briefReady: true, communication: null }), null);
});

test("communication panel opens only when the returned snapshot actually contains a parent plan", () => {
  assert.equal(promoWasGenerated(null), false);
  assert.equal(promoWasGenerated({ latest: { communication: null } }), false);
  assert.equal(promoWasGenerated({ latest: { communication: { status: "needs_review" } } }), true);
});
