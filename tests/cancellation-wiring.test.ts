import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { relayAbort } from "../app/lib/cancellation.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Agent runtime has no total-duration timer and aborts on HTTP disconnect", () => {
  const runner = source("../agent/run-turn.ts");
  const server = source("../agent/server.ts");
  assert.doesNotMatch(runner, /timeoutMs|setTimeout\(\(\) => abortController\.abort/);
  assert.doesNotMatch(server, /TURN_TIMEOUT_MS|120_000|120000/);
  const handler = source("../agent/http-handler.ts");
  assert.match(handler, /request\.on\("aborted"/);
  assert.match(handler, /response\.on\("close"/);
  assert.match(handler, /request\.aborted\s*\|\|\s*response\.destroyed/);
  assert.match(runner, /externalSignal\?: AbortSignal/);
  assert.match(runner, /maxTurns:\s*12/);
});

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
