import assert from "node:assert/strict";
import test from "node:test";

import { appendLiveReply, emptyLiveReply } from "../app/lib/client/live-reply.ts";

test("live reply timestamp starts on the first visible delta and remains stable", () => {
  const blank = appendLiveReply(emptyLiveReply(), "  \n", "2026-09-17T03:00:00.000Z");
  assert.deepEqual(blank, { text: "  \n", startedAt: null });

  const visible = appendLiveReply(blank, "活动已", "2026-09-17T03:00:01.000Z");
  assert.deepEqual(visible, { text: "  \n活动已", startedAt: "2026-09-17T03:00:01.000Z" });

  const continued = appendLiveReply(visible, "建好。", "2026-09-17T03:00:02.000Z");
  assert.deepEqual(continued, { text: "  \n活动已建好。", startedAt: "2026-09-17T03:00:01.000Z" });
});

test("resetting a live reply clears both text and its timestamp", () => {
  const reset = emptyLiveReply();
  assert.deepEqual(reset, { text: "", startedAt: null });
});
