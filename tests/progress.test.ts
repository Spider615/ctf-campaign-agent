import assert from "node:assert/strict";
import test from "node:test";

import { draftCompletion } from "../app/lib/campaign/ics1811/progress.ts";

test("draft completion is bounded and handles an empty requirement set", () => {
  assert.equal(draftCompletion(8, 2), 75);
  assert.equal(draftCompletion(0, 0), 100);
  assert.equal(draftCompletion(3, 5), 0);
});
