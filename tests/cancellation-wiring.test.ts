import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { relayAbort } from "../app/lib/cancellation.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Workers forwards cancellation without a wall-clock timeout", () => {
  const route = source("../app/api/sessions/[id]/turns/route.ts");
  const runtime = source("../app/lib/server/runtime.ts");

  assert.match(route, /request\.signal/);
  assert.match(route, /relayAbort\(request\.signal, turnController\)/);
  assert.match(runtime, /signal\?: AbortSignal/);
  assert.doesNotMatch(runtime, /AbortSignal\.timeout/);
  assert.doesNotMatch(runtime, /150_000|150000/);
});

test("an already-aborted source signal is relayed immediately", () => {
  const source = new AbortController();
  const target = new AbortController();
  source.abort("stopped-before-listener");

  const cleanup = relayAbort(source.signal, target);
  assert.equal(target.signal.aborted, true);
  assert.equal(target.signal.reason, "stopped-before-listener");
  cleanup();
});
