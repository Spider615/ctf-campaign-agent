import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
import { isIcs1811Draft } from "../app/lib/server/request-validation.ts";

test("session routes only accept ics1811/v1 drafts", () => {
  const draft = createEmptyDraft("d", "7590门店钻石类打9折");
  assert.equal(isIcs1811Draft({ id: "partial" }), false);
  assert.equal(isIcs1811Draft({ ...draft, schema: "campaign/v0" }), false);
  assert.equal(isIcs1811Draft(JSON.parse(JSON.stringify(draft))), true, "存进 D1 再读出来的草稿仍然有效");
});
