# Unbounded Agent Turn and Stop Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove application-level wall-clock timeouts, keep the 12-turn logical limit, show a continuous three-dot wave while the model is working, and provide a real end-to-end stop control.

**Architecture:** A small shared cancellation module gives browser, Workers, server orchestration, and the Node Agent service one cancellation vocabulary. Each streaming turn owns an `AbortController`; its signal flows through both HTTP hops into the SDK controller, while `runTurn` treats pre-commit cancellation as a non-persisted terminal state. `store.commit(...)` is the explicit linearization point: cancellation wins before it starts, while an already-started atomic commit wins without ever persisting a partial turn.

**Tech Stack:** React 19, TypeScript, Vinext/Cloudflare Workers, Node.js HTTP, Anthropic Agent SDK, Node test runner, Tailwind CSS 4.

---

## File map

- Create `app/lib/cancellation.ts`: environment-neutral cancellation error, predicate, and guard.
- Modify `app/lib/server/turns.ts`: carry the active signal and bypass error persistence/commit after cancellation.
- Modify `app/lib/client/api.ts` and `app/lib/client/stream.ts`: pass a browser abort signal into fetch and the decoder, cancel the reader, and reject all buffered late events.
- Modify `app/components/chat/conversation.tsx`: own the active controller, stop the turn, restore typed text, and keep the waiting indicator visible below tool traces.
- Modify `app/components/chat/composer.tsx`: switch between send and square stop controls.
- Modify `app/components/chat/thinking-indicator.tsx` and `app/globals.css`: render the deliberate staggered wave with reduced-motion behavior.
- Modify `app/api/sessions/[id]/turns/route.ts`: connect browser disconnect/cancel to the Workers-side Agent request.
- Modify `app/lib/server/runtime.ts`: remove the 150-second timeout and forward the request signal to Agent HTTP.
- Modify `agent/run-turn.ts`: remove the 120-second timer and bridge an external signal into the SDK controller.
- Create `agent/http-handler.ts` and modify `agent/server.ts`: isolate the request handler, abort the runner when its HTTP client disconnects, and stop writing to a closed response.
- Modify `agent/skill-smoke.ts`: remove the deleted runtime timeout option.
- Modify `AGENTS.md`: replace the obsolete 120/150-second maintenance guidance with active cancellation plus `maxTurns = 12`.
- Modify `tests/conversation.test.ts`, `tests/client-stream.test.ts`, `tests/campaign-ui.test.ts`: lock cancellation normalization and linearization, reader abort behavior, and UI state.
- Create `tests/agent-cancellation.test.ts`: verify external cancellation reaches the SDK controller without a wall-clock timer.
- Create `tests/agent-http-cancellation.test.ts`: exercise a real disconnected HTTP client against the extracted Agent handler.
- Create `tests/cancellation-wiring.test.ts`: lock the cross-process signal wiring and absence of application timeout constants.

### Task 1: Shared cancellation contract and atomic server behavior

**Files:**
- Create: `app/lib/cancellation.ts`
- Modify: `app/lib/server/turns.ts`
- Test: `tests/conversation.test.ts`

- [ ] **Step 1: Write the failing cancellation test**

Add these tests to `tests/conversation.test.ts`, using the file's `deps(...)`, `createSession`, and `runTurn` helpers. The first covers cancellation while the Agent is active:

```ts
test("主动停止模型回合时不落用户消息、错误消息或新版本", async () => {
  const controller = new AbortController();
  const d = deps([]);
  d.signal = controller.signal;
  d.runAgent = async () => {
    controller.abort();
    throw new DOMException("已停止", "AbortError");
  };
  const initial = await createSession({ entryMode: "new", text: "你好" }, d);

  await assert.rejects(
    () => runTurn(initial.session.id, { type: "interpret", expectedSeq: initial.latest.seq }, d),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  const stored = await d.store.load(initial.session.id);
  assert.equal(stored?.versions.length, 1);
  assert.deepEqual(stored?.messages.map((message) => message.content.kind), ["user_text"]);
});
```

Add a second test for cancellation identity when an upstream implementation throws an ordinary error at the same time as the signal aborts:

```ts
test("取消信号优先于同时到达的普通 Agent 错误", async () => {
  const controller = new AbortController();
  const d = deps([]);
  d.signal = controller.signal;
  d.runAgent = async () => {
    controller.abort();
    throw new Error("上游连接断开");
  };
  const initial = await createSession({ entryMode: "new", text: "你好" }, d);

  await assert.rejects(
    () => runTurn(initial.session.id, { type: "interpret", expectedSeq: initial.latest.seq }, d),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});
```

Also add `test("开始前已停止的回合不会调用 Agent", ...)`: create the session without a signal, attach an already-aborted signal before `runTurn`, and assert rejection with `AbortError` while `d.calls()` remains `0`. This requires one `throwIfTurnCancelled(deps.signal)` at the beginning of `runTurn`, immediately after input parsing and before loading or invoking the Agent.

Add a third test that wraps the memory store with a deferred commit. It proves the documented linearization rule: after `commit(...)` has been invoked, releasing that atomic commit produces the whole successful turn even if the signal aborts while the commit is in flight:

```ts
test("原子提交开始后取消不会伪装成未提交", async () => {
  const controller = new AbortController();
  const d = deps([record(example("T2").firstWrites)]);
  d.signal = controller.signal;
  const initial = await startNew(d, "T2");
  const baseStore = d.store;
  let markCommitStarted!: () => void;
  let releaseCommit!: () => void;
  const commitStarted = new Promise<void>((resolve) => { markCommitStarted = resolve; });
  const mayCommit = new Promise<void>((resolve) => { releaseCommit = resolve; });
  d.store = {
    list: () => baseStore.list(),
    load: (id) => baseStore.load(id),
    remove: (id) => baseStore.remove(id),
    commit: async (write) => {
      markCommitStarted();
      await mayCommit;
      await baseStore.commit(write);
    },
  };

  const pending = interpret(initial, d);
  await commitStarted;
  controller.abort();
  releaseCommit();
  const snapshot = await pending;

  const stored = await baseStore.load(initial.session.id);
  assert.equal(snapshot.latest.seq, 2);
  assert.equal(stored?.versions.length, 2);
  assert.equal(stored?.messages.at(-1)?.content.kind, "agent_text");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
PATH=/Users/jerry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
node --test --experimental-strip-types --test-name-pattern="主动停止模型回合|取消信号优先|开始前已停止|原子提交开始" tests/conversation.test.ts
```

Expected: FAIL because `TurnDeps` has no `signal` contract and cancellation is currently converted into a persisted `agent_error`.

- [ ] **Step 3: Add the shared cancellation primitive**

Create `app/lib/cancellation.ts`:

```ts
export class TurnCancelledError extends Error {
  constructor(message = "已停止生成") {
    super(message);
    this.name = "AbortError";
  }
}

export function isTurnCancelled(error: unknown): boolean {
  return error instanceof TurnCancelledError ||
    (error instanceof Error && error.name === "AbortError");
}

export function throwIfTurnCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TurnCancelledError();
}

export function relayAbort(source: AbortSignal, target: AbortController): () => void {
  const abort = () => {
    if (!target.signal.aborted) target.abort(source.reason);
  };
  source.addEventListener("abort", abort, { once: true });
  if (source.aborted) abort();
  return () => source.removeEventListener("abort", abort);
}
```

- [ ] **Step 4: Make `runTurn` cancellation-aware**

In `app/lib/server/turns.ts`, import the helpers, add `signal?: AbortSignal` to `TurnDeps`, normalize cancellation inside the `runAgent` catch, and guard the final commit:

```ts
import { isTurnCancelled, throwIfTurnCancelled, TurnCancelledError } from "../cancellation.ts";

export type TurnDeps = {
  store: SessionStore;
  runAgent: AgentRunner;
  today: string;
  signal?: AbortSignal;
  now?: () => string;
  newId?: () => string;
  emitTrace?: (event: AgentTraceEvent) => void;
  emitProgress?: (event: AgentTransientEvent) => void;
};
```

Insert `throwIfTurnCancelled(deps.signal);` immediately after `parseTurnInput(body)`, on the line immediately before the current `result = await deps.runAgent(...)` statement, and again immediately after that awaited call returns. Keep the existing request, trace, and progress arguments unchanged.

At the beginning of the existing `catch (error)` around `deps.runAgent`, normalize a cancelled signal before inspecting the thrown error:

```ts
if (deps.signal?.aborted) throw new TurnCancelledError();
if (isTurnCancelled(error)) throw error;
```

Immediately before the final `commitAndLoad(...)`, insert:

```ts
throwIfTurnCancelled(deps.signal);
```

Document this line as the cancellation linearization boundary. Do not check the signal after `commitAndLoad` starts and pretend the write was cancelled: D1 batch is atomic but not safely interruptible. The linearization test from Step 1 must lock this behavior.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the Step 2 command again. Expected: PASS. Cancellation before commit leaves only the initial snapshot; a simultaneously thrown ordinary error is normalized to `AbortError`; cancellation after commit invocation yields one complete atomic turn.

- [ ] **Step 6: Commit the atomic cancellation boundary**

```bash
git add app/lib/cancellation.ts app/lib/server/turns.ts tests/conversation.test.ts
git commit -m "feat: keep cancelled agent turns atomic"
```

### Task 2: Browser stop control and continuous thinking wave

**Files:**
- Modify: `app/lib/client/api.ts`
- Modify: `app/lib/client/stream.ts`
- Modify: `app/components/chat/conversation.tsx`
- Modify: `app/components/chat/composer.tsx`
- Modify: `app/components/chat/thinking-indicator.tsx`
- Modify: `app/globals.css`
- Test: `tests/client-stream.test.ts`
- Test: `tests/campaign-ui.test.ts`

- [ ] **Step 1: Write failing UI and client-signal tests**

Extend the source fixtures at the top of `tests/campaign-ui.test.ts`:

```ts
const conversationSource = readFileSync(new URL("../app/components/chat/conversation.tsx", import.meta.url), "utf8");
const thinkingSource = readFileSync(new URL("../app/components/chat/thinking-indicator.tsx", import.meta.url), "utf8");
const globalsSource = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
```

Then add:

```ts
test("streaming turns expose a real stop control and keep the wave below tool traces", () => {
  assert.match(composerSource, /Square/);
  assert.match(composerSource, /停止生成/);
  assert.match(conversationSource, /new AbortController\(\)/);
  assert.match(conversationSource, /onStop=/);
  assert.match(conversationSource, /继续理解/);
  assert.match(conversationSource, /inFlightTurn/);
  assert.match(conversationSource, /setInput\(\(current\)/);
  assert.match(conversationSource, /caught instanceof ApiError && caught\.status === 409/);
  assert.match(conversationSource, /latestUserText\(next\) === text/);
  assert.match(conversationSource, /trim\(\)\.slice\(0, 1000\)/);
  assert.match(composerSource, /maxLength=\{1000\}/);
  assert.match(conversationSource, /!stopping && !liveReply\.text && waiting/);
  assert.doesNotMatch(conversationSource, /!liveTrace\.length\s*&&\s*!liveReply\.text\s*&&\s*waiting/);
  assert.match(thinkingSource, /thinking-wave-dot/);
  assert.match(globalsSource, /@keyframes thinking-wave/);
});
```

Import `postTurnStream` beside the existing `ApiError` import, then add this fetch-forwarding test to `tests/client-stream.test.ts`:

```ts
test("postTurnStream forwards the AbortSignal to fetch", async (t) => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let received: AbortSignal | null = null;
  globalThis.fetch = async (_input, init) => {
    received = init?.signal as AbortSignal;
    return await new Promise<Response>((_resolve, reject) => {
      received?.addEventListener("abort", () => reject(new DOMException("已停止", "AbortError")), { once: true });
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const pending = postTurnStream("session-1", { type: "interpret", expectedSeq: 1 }, {}, controller.signal);
  controller.abort();

  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(received, controller.signal);
});
```

Add a deterministic decoder test using a `ReadableStream` that enqueues a trace and snapshot in the same buffered chunk but never closes. Abort from `onTrace`; this specifically locks the buffered-event race that fetch cancellation alone does not cover:

```ts
test("browser decoder cancels its reader and ignores buffered events after abort", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode([
        JSON.stringify({ type: "trace", event: completedEvent }),
        JSON.stringify({ type: "snapshot", snapshot }),
      ].join("\n") + "\n"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const seen: string[] = [];

  await assert.rejects(
    () => consumeTurnStream(new Response(body), {
      onTrace: () => {
        seen.push("trace");
        controller.abort();
      },
      onTextDelta: () => seen.push("late-delta"),
    }, controller.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  assert.deepEqual(seen, ["trace"]);
  assert.equal(cancelled, true);
});
```

- [ ] **Step 2: Run the two tests and verify RED**

```bash
PATH=/Users/jerry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
node --test --experimental-strip-types --test-name-pattern="stop control|AbortSignal|cancels its reader" \
tests/campaign-ui.test.ts tests/client-stream.test.ts
```

Expected: FAIL because the stop props, signal-aware decoder, persistent waiting indicator, and named wave animation do not exist.

- [ ] **Step 3: Forward the signal from the client API**

Change `postTurnStream` in `app/lib/client/api.ts` to pass the same signal into both fetch and the stream decoder:

```ts
export async function postTurnStream(
  id: string,
  body: TurnBody & { expectedSeq: number },
  handlers: TurnStreamHandlers,
  signal?: AbortSignal,
): Promise<Snapshot> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/turns`, {
    ...json(body),
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    signal,
  });
  return consumeTurnStream(response, handlers, signal);
}
```

Change `consumeTurnStream` in `app/lib/client/stream.ts` to accept `signal?: AbortSignal`. Import `TurnCancelledError` and `throwIfTurnCancelled`, then enforce the signal at all observable boundaries:

1. Check before HTTP/body parsing and after every `reader.read()`.
2. Check at the start of every buffered-line dispatch, before calling any handler or accepting a snapshot.
3. Register an abort listener that calls `reader.cancel(signal.reason)`; immediately handle an already-aborted signal after registration.
4. If the signal aborted while another error was thrown, normalize to `TurnCancelledError`.
5. In `finally`, remove the listener, best-effort cancel an aborted reader, and release its lock.

The implementation shape should be:

```ts
export async function consumeTurnStream(
  response: Response,
  handlers: TurnStreamHandlers,
  signal?: AbortSignal,
): Promise<Snapshot> {
  throwIfTurnCancelled(signal);
  // existing response validation
  const reader = response.body.getReader();
  const cancelReader = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", cancelReader, { once: true });
  if (signal?.aborted) cancelReader();
  try {
    // Existing decode loop, with throwIfTurnCancelled(signal) after each read
    // and at the beginning of consumeLine before dispatching any event.
    throwIfTurnCancelled(signal);
    return snapshot;
  } catch (error) {
    if (signal?.aborted) throw new TurnCancelledError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    if (signal?.aborted) await reader.cancel(signal.reason).catch(() => undefined);
    reader.releaseLock();
  }
}
```

- [ ] **Step 4: Turn Composer's busy control into a stop button**

In `app/components/chat/composer.tsx`, import `Square`, extend props, and replace the button content/behavior:

```tsx
import { ArrowUp, Square } from "lucide-react";

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  busy: boolean;
  stoppable?: boolean;
  stopping?: boolean;
  placeholder: string;
};
```

Inside the component:

```tsx
const stopMode = busy && stoppable;
const buttonDisabled = stopMode ? stopping : !canSend;

<Button
  type="button"
  size="icon"
  aria-label={stopMode ? "停止生成" : "发送"}
  disabled={buttonDisabled}
  onClick={stopMode ? onStop : onSubmit}
  className="size-11 rounded-xl bg-[#247cff] text-white shadow-[0_8px_20px_rgba(36,124,255,0.25)] transition hover:-translate-y-0.5 hover:bg-[#176bea] disabled:shadow-none"
>
  {stopMode ? <Square className="size-3.5 fill-current" /> : <ArrowUp />}
</Button>
```

Add `maxLength={1000}` to Composer's `Textarea`, matching `parseTurnInput`'s server-side text limit. Keep Enter submission gated by `canSend`, so pressing Enter while streaming cannot start a second turn.

- [ ] **Step 5: Own and stop the active stream in Conversation**

In `app/components/chat/conversation.tsx`, import the predicate and then add state and refs. Use a synchronous token ref as the actual single-flight lock; React `busy` state alone does not close the double-click window:

```ts
import { isTurnCancelled } from "../../lib/cancellation";
```

```ts
const [stopping, setStopping] = useState(false);
const [interpretationStopped, setInterpretationStopped] = useState(false);
const inFlightTurn = useRef<symbol | null>(null);
const activeTurn = useRef<{ token: symbol; controller: AbortController; kind: TurnKind } | null>(null);
const currentSessionId = useRef(sessionId);
currentSessionId.current = sessionId;

const stopGeneration = useCallback(() => {
  const current = activeTurn.current;
  if (!current || current.controller.signal.aborted) return;
  setStopping(true);
  current.controller.abort();
  setPendingText(null);
  setPendingAt(null);
  setLiveTrace([]);
  setLiveReply(emptyLiveReply());
  setLivePhase(null);
  setRunStartedAt(null);
  if (current.kind === "interpret") setInterpretationStopped(true);
}, []);
```

At the top of `send`, reject a second call when `inFlightTurn.current` is set. Compute `streams` before it is used, capture the requested session, and acquire a unique token synchronously before the first state update. For streaming bodies, create and retain the controller with that token:

```ts
if (!snapshot || busy || inFlightTurn.current) return null;
const streams = WAITING_KINDS.includes(body.type);
const requestSessionId = sessionId;
const token = Symbol("turn");
inFlightTurn.current = token;
const controller = streams ? new AbortController() : null;
if (controller) activeTurn.current = { token, controller, kind: body.type };
const ownsUi = () => inFlightTurn.current === token && currentSessionId.current === requestSessionId;
const isCurrent = () => ownsUi() && !controller?.signal.aborted;
```

Remove the old later `const streams = ...` declaration when moving it here.

Replace the streaming API call with the complete signal-aware call:

```ts
await postTurnStream(sessionId, payload, {
  onTrace: (event) => {
    if (isCurrent()) setLiveTrace((current) => mergeTraceEvent(current, event));
  },
  onPhase: (phase) => {
    if (isCurrent()) setLivePhase(phase);
  },
  onTextDelta: (delta) => {
    if (!isCurrent()) return;
    const arrivedAt = new Date().toISOString();
    setLiveReply((current) => appendLiveReply(current, delta, arrivedAt));
  },
  onTextReset: () => {
    if (isCurrent()) setLiveReply(emptyLiveReply());
  },
}, controller?.signal)
```

After either `postTurnStream` or `postTurn` resolves, call `isCurrent()` before `setSnapshot` or session-change notifications. This covers token replacement, abort, and the render-to-effect window of a session change. If false, return `null` and ignore that old result.

Refactor `load()` to return `Promise<Snapshot | null>` after updating state. Before applying its fetched snapshot, verify that `currentSessionId.current` still matches the session captured by that `load` invocation.

Use this catch/finally behavior:

```ts
} catch (caught) {
  if (isTurnCancelled(caught) || controller?.signal.aborted) {
    if (ownsUi() && body.type === "interpret") setInterpretationStopped(true);
    return null;
  }
  if (ownsUi()) {
    if (caught instanceof ApiError && caught.status === 409) return await load();
    setError(caught instanceof Error ? caught.message : "没保存成功，可以重试");
  }
  return null;
} finally {
  if (inFlightTurn.current === token) {
    inFlightTurn.current = null;
    if (activeTurn.current?.token === token) activeTurn.current = null;
    setStopping(false);
    setBusy(null);
    setPendingText(null);
    setPendingAt(null);
    setLiveTrace([]);
    setLiveReply(emptyLiveReply());
    setLivePhase(null);
    setRunStartedAt(null);
  }
}
```

Abort on unmount or `sessionId` change, invalidate the old token so late callbacks/finally blocks cannot clear a newer turn, and reset the local stopped flag:

```ts
useEffect(() => {
  setInterpretationStopped(false);
  setError("");
  setStopping(false);
  setBusy(null);
  setPendingText(null);
  setPendingAt(null);
  setLiveTrace([]);
  setLiveReply(emptyLiveReply());
  setLivePhase(null);
  setRunStartedAt(null);
  return () => {
    activeTurn.current?.controller.abort();
    activeTurn.current = null;
    inFlightTurn.current = null;
  };
}, [sessionId]);
```

Compute `needsInterpretation` with `!interpretationStopped`, do not lock Composer solely because the persisted snapshot is still pending after a local stop, and pass the stop props:

```tsx
const needsInterpretation = Boolean(
  !interpretationStopped && snapshot?.flow.pendingInterpretation &&
  !snapshot.messages.some((message) => message.role === "assistant"),
);

const retryInterpretation = () => {
  autoStarted.current = null;
  setInterpretationStopped(false);
};

const placeholder = interpretationStopped
  ? "已停止理解，可以继续补充，或点「继续理解」"
  : pendingInterpretation && !needsInterpretation && busy !== "interpret"
    ? "没理解成功，点上面的「重试」"
    : flow.phase === "collecting" ? collectingPlaceholder(flow) : PLACEHOLDER[flow.phase];

<Composer
  value={input}
  onChange={setInput}
  busy={busy !== null || (pendingInterpretation && !interpretationStopped)}
  stoppable={Boolean(busy && WAITING_KINDS.includes(busy))}
  stopping={stopping}
  onStop={stopGeneration}
  placeholder={placeholder}
  onSubmit={() => {
    const text = input.trim().slice(0, 1000);
    if (!text) return;
    const submittedSessionId = sessionId;
    setInput("");
    void send({ type: "text", text }).then((next) => {
      const alreadyCommitted = next ? latestUserText(next) === text : false;
      if (!alreadyCommitted && currentSessionId.current === submittedSessionId) {
        setInput((current) => current.length ? current : text);
      }
    });
  }}
/>
```

Add a small `latestUserText(snapshot)` helper that scans messages from the end and returns the newest `user_text` value. Use the same canonical text as the server—`input.trim().slice(0, 1000)`—for sending, committed-text comparison, and restoration; Composer's `maxLength={1000}` is the matching UI guard. The source assertions above are the >1000-character regression contract.

When `interpretationStopped` is true, render a neutral inline status above Composer: “已停止理解，你可以继续补充，或继续理解”，with a “继续理解” button wired to `retryInterpretation`. It is not a red error. Keep the textarea editable during streaming; the functional input restore above preserves anything the user typed while waiting.

Do not rely on a later 409 to discover whether a stopped or transport-uncertain turn committed. `Conversation` leases a `crypto.randomUUID()` `clientTurnId` per canonical controlled `TurnBody`: an uncertain `null` result keeps the lease for the same-body retry, a different body gets a different ID, and a successful Snapshot or completed stale-seq 409 reconciliation clears it. The server excludes `expectedSeq` and `clientTurnId` from the request hash, stores the ID plus hash on the first persisted message, and uses a deterministic message primary key as the atomic idempotency fence. A committed same-ID/same-body retry returns the winning Snapshot; same ID with a different body is a 400 without another Agent call. After a successful send, deliberately sending the same text again therefore receives a fresh ID. Non-chat `postTurn` callers also receive an ID at the API boundary.

The submit callback still restores the canonical submitted text only if that exact text is not already the newest committed user message. A genuine stale-seq 409 still refreshes the Snapshot without a red error, avoiding duplicates without discarding a different stale-tab draft.

- [ ] **Step 6: Keep the three-dot wave visible after traces start**

Update `ThinkingIndicator` to accept `continued`, attach a stable animation class, and pass the row state through:

```tsx
export function ThinkingIndicator({ label, continued = false }: { label: string; continued?: boolean }) {
  return (
    <AgentRow continued={continued}>
      <div role="status" aria-live="polite" className="inline-flex items-center gap-3 rounded-2xl border border-[#c9ddf6] bg-white/80 px-4 py-3 shadow-[0_10px_28px_rgba(36,124,255,0.08)]">
        <span className="flex h-4 items-center gap-1" aria-hidden="true">
          <span className="thinking-wave-dot size-1.5 rounded-full bg-[#247cff] [animation-delay:-240ms]" />
          <span className="thinking-wave-dot size-1.5 rounded-full bg-[#5b9cff] [animation-delay:-120ms]" />
          <span className="thinking-wave-dot size-1.5 rounded-full bg-[#8dc0ff]" />
        </span>
        <span className="text-sm text-[#59718d]">{label}…</span>
      </div>
    </AgentRow>
  );
}
```

Render it whenever no safe reply text exists, even if traces exist, except while the clicked stop is settling:

```tsx
{!stopping && !liveReply.text && waiting ? (
  <ThinkingIndicator
    continued={liveTrace.length > 0}
    label={livePhase === "writing" ? "正在组织回复…" : waiting}
  />
) : null}
```

Gate the transient `ToolRunCard` and live-reply blocks with `!stopping` as well. `stopGeneration` already clears their state synchronously; the render guard guarantees they disappear in the same click render even if a queued state update or buffered event races the abort. Keep `busy` and the synchronous token lock until the request promise settles, so the disabled square cannot start a second turn while cancellation is propagating.

Add to `app/globals.css`:

```css
@keyframes thinking-wave {
  0%, 60%, 100% { opacity: 0.42; transform: translateY(2px) scale(0.9); }
  30% { opacity: 1; transform: translateY(-3px) scale(1); }
}

.thinking-wave-dot { animation: thinking-wave 1.05s ease-in-out infinite; }

@media (prefers-reduced-motion: reduce) {
  .thinking-wave-dot { animation: none; opacity: 0.75; transform: none; }
}
```

- [ ] **Step 7: Run focused tests and commit the browser experience**

Run the Step 2 command. Expected: PASS.

```bash
git add app/lib/client/api.ts app/lib/client/stream.ts app/components/chat/conversation.tsx \
  app/components/chat/composer.tsx app/components/chat/thinking-indicator.tsx \
  app/globals.css tests/client-stream.test.ts tests/campaign-ui.test.ts
git commit -m "feat: add streaming stop control and thinking wave"
```

### Task 3: Workers-to-Agent cancellation wiring and timeout removal

**Files:**
- Modify: `app/api/sessions/[id]/turns/route.ts`
- Modify: `app/lib/server/runtime.ts`
- Create: `tests/cancellation-wiring.test.ts`

- [ ] **Step 1: Write the failing static wiring contract**

Create `tests/cancellation-wiring.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the wiring test and verify RED**

```bash
PATH=/Users/jerry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
node --test --experimental-strip-types tests/cancellation-wiring.test.ts
```

Expected: FAIL because the route only toggles `active` and runtime still installs `AbortSignal.timeout(150_000)`.

- [ ] **Step 3: Forward route cancellation**

In `app/api/sessions/[id]/turns/route.ts`, import `isTurnCancelled` and `relayAbort`. In the streaming branch, create a controller before the `ReadableStream`, relay `request.signal` with the helper (which immediately handles an already-aborted request), and use one cleanup-safe abort function. Keep `active` declared before the function so the closure never touches an uninitialized binding:

```ts
let active = true;
const turnController = new AbortController();
const stopRelaying = relayAbort(request.signal, turnController);
const abortTurn = () => {
  active = false;
  if (!turnController.signal.aborted) turnController.abort();
};
```

Pass `turnController.signal` as the third argument to `runtimeDeps`, call `abortTurn()` from `ReadableStream.cancel()`, and call `stopRelaying()` in the `runTurn(...).finally(...)` block:

```ts
runtimeDeps(
  (event) => emit({ type: "trace", event }),
  (event) => emit(event),
  turnController.signal,
)
```

When `controller.enqueue(...)` throws because the browser disappeared, call `abortTurn()` rather than only setting `active = false`. In the promise catch, silently ignore cancellation (`isTurnCancelled(error)` or `turnController.signal.aborted`) instead of emitting a public error event.

For the non-streaming branch, use `runtimeDeps(undefined, undefined, request.signal)`.

- [ ] **Step 4: Remove Workers' total timeout and preserve cancellation identity**

In `app/lib/server/runtime.ts`, import the shared cancellation helpers, then change `agentFetch`, `runAgentJson`, and `runAgentRemote` to accept `signal?: AbortSignal`. Pass that signal directly to `fetch` and classify cancellation before the connection fallback:

```ts
import { isTurnCancelled, TurnCancelledError } from "../cancellation.ts";
```

```ts
async function agentFetch(url: string, request: AgentRequest, accept?: string, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { ...agentHeaders(), ...(accept ? { accept } : {}) },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || isTurnCancelled(error)) throw new TurnCancelledError();
    throw new Error("连不上 Agent 服务，请先运行 npm run dev:agent");
  }
}
```

Update `runtimeDeps` so its `runAgent` closure retains the signal:

```ts
export function runtimeDeps(
  emitTrace?: (event: AgentTraceEvent) => void,
  emitProgress?: (event: AgentTransientEvent) => void,
  signal?: AbortSignal,
): TurnDeps {
  return {
    store: createD1Store(getDbBinding()),
    runAgent: (request, onTrace, onProgress) =>
      runAgentRemote(request, onTrace, onProgress, signal),
    today: todayInShanghai(),
    signal,
    emitTrace,
    emitProgress,
  };
}
```

- [ ] **Step 5: Run the wiring test and commit**

Run the Step 2 command. Expected: PASS.

```bash
git add "app/api/sessions/[id]/turns/route.ts" app/lib/server/runtime.ts \
  tests/cancellation-wiring.test.ts
git commit -m "feat: propagate turn cancellation through workers"
```

### Task 4: Agent HTTP disconnect and SDK cancellation without a timer

**Files:**
- Modify: `agent/run-turn.ts`
- Create: `agent/http-handler.ts`
- Modify: `agent/server.ts`
- Modify: `agent/skill-smoke.ts`
- Modify: `AGENTS.md`
- Modify: `tests/cancellation-wiring.test.ts`
- Create: `tests/agent-cancellation.test.ts`
- Create: `tests/agent-http-cancellation.test.ts`

- [ ] **Step 1: Write the failing SDK cancellation test**

Create `tests/agent-cancellation.test.ts` with a fake query that waits for the SDK controller to abort:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRequest } from "../app/lib/agent/protocol.ts";
import { createCampaignDraft } from "../app/lib/campaign/workspace.ts";
import { createAgentRunner, type AgentQuery } from "../agent/run-turn.ts";

test("external cancellation aborts the SDK query without waiting for a timer", async (t) => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-agent-cancel-"));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  let sdkSignal: AbortSignal | null = null;
  let markQueryStarted!: () => void;
  const queryStarted = new Promise<void>((resolve) => { markQueryStarted = resolve; });
  const query: AgentQuery = async function* ({ options }) {
    sdkSignal = options.abortController?.signal ?? null;
    markQueryStarted();
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(new DOMException("已停止", "AbortError"));
      if (sdkSignal?.aborted) abort();
      else sdkSignal?.addEventListener("abort", abort, { once: true });
    });
  };
  const runner = createAgentRunner({
    model: "test-model",
    modelBaseUrl: "http://127.0.0.1",
    apiKey: "test-key",
    runtimeDir,
    pluginDir: join(process.cwd(), "agent/plugin"),
  }, { query });
  const controller = new AbortController();
  const request: AgentRequest = {
    today: "2026-09-17",
    campaign: createCampaignDraft("campaign-1", "你好"),
    draft: null,
    history: [],
    trigger: { kind: "first_message", text: "你好" },
    campaignStage: "briefing",
    ics1811Phase: null,
    openQuestions: [],
    proposals: [],
    canUndo: false,
  };

  const pending = runner(request, undefined, undefined, controller.signal);
  await queryStarted;
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  controller.abort();

  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.equal(sdkSignal?.aborted, true);
});
```

- [ ] **Step 2: Write a real Agent HTTP disconnect test**

Create `tests/agent-http-cancellation.test.ts`. Start an ephemeral Node HTTP server with the extracted `createAgentHttpHandler`, inject a fake `AgentTurnRunner`, POST a valid request to `/turn/stream`, wait on a deferred promise until the fake runner receives its signal, then destroy the client socket. The fake runner should wait for the signal and throw `TurnCancelledError` after it aborts.

Assert all of the following:

- the injected runner signal becomes aborted;
- the fake runner settles after disconnect rather than staying alive;
- no error event/frame is written after disconnect;
- the injected logger receives no failure log for the cancellation.

Add a second subtest for body parsing: declare a larger `content-length`, write only a partial JSON body, do not end the request, and destroy the client socket. Wait for the server request's `aborted` event, then one event-loop turn. Assert that the fake runner was never called and that no 400/error log was emitted. This proves listeners are bound before `readJson`, rather than only covering disconnects after model execution starts.

Give both client requests an `error` listener so the intentional socket reset does not become an unhandled test error.

- [ ] **Step 3: Extend the static contract and verify RED**

Add these assertions to `tests/cancellation-wiring.test.ts`:

```ts
test("Agent runtime has no total-duration timer and aborts on HTTP disconnect", () => {
  const runner = source("../agent/run-turn.ts");
  const server = source("../agent/server.ts");
  const handler = source("../agent/http-handler.ts");
  assert.doesNotMatch(runner, /timeoutMs|setTimeout\(\(\) => abortController\.abort/);
  assert.doesNotMatch(server, /TURN_TIMEOUT_MS|120_000|120000/);
  assert.match(handler, /request\.on\("aborted"/);
  assert.match(handler, /response\.on\("close"/);
  assert.match(handler, /request\.aborted\s*\|\|\s*response\.destroyed/);
  assert.match(runner, /externalSignal\?: AbortSignal/);
  assert.match(runner, /maxTurns:\s*12/);
});
```

Run:

```bash
PATH=/Users/jerry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH \
node --test --experimental-strip-types tests/agent-cancellation.test.ts \
  tests/agent-http-cancellation.test.ts tests/cancellation-wiring.test.ts
```

Expected: FAIL because the runner has no external signal argument, the testable HTTP handler does not exist, and both total timeout constants still exist.

- [ ] **Step 4: Bridge the external signal into the SDK controller**

In `agent/run-turn.ts`, import the shared cancellation error, remove `timeoutMs` from `AgentRuntimeConfig`, add a fourth optional signal to `AgentTurnRunner`, delete the timer, and bridge the signal:

```ts
import { relayAbort, TurnCancelledError } from "../app/lib/cancellation.ts";
```

```ts
export type AgentTurnRunner = (
  request: AgentRequest,
  onTrace?: (event: AgentTraceEvent) => void,
  onProgress?: (event: Exclude<AgentProgressEvent, { type: "trace" }>) => void,
  externalSignal?: AbortSignal,
) => Promise<AgentResult>;
```

Immediately after creating the SDK controller:

```ts
const abortController = new AbortController();
const stopRelaying = externalSignal ? relayAbort(externalSignal, abortController) : () => {};
```

In the catch block, classify external cancellation before other SDK errors:

```ts
if (externalSignal?.aborted) throw new TurnCancelledError();
```

In `finally`, remove the external listener and retain pending-Skill cleanup:

```ts
stopRelaying();
```

Delete the `setTimeout`, `clearTimeout`, and the branch that converts any internal controller abort into “Agent 超时了”. Keep `maxTurns: 12` unchanged.

- [ ] **Step 5: Extract the Agent handler and abort on disconnect**

Create `agent/http-handler.ts` and export `createAgentHttpHandler({ runAgentTurn, token, model, logger = console })`. Move request validation, JSON reading, stream framing, timing, logging, and `/health` handling from `agent/server.ts` into this injected handler. Import the shared cancellation helpers there.

```ts
import { isTurnCancelled, TurnCancelledError } from "../app/lib/cancellation.ts";
```

For every `/turn` and `/turn/stream` request, create and bind the controller before reading the body. Check current socket state immediately after listener registration to close the “disconnect before listener” race:

```ts
const requestController = new AbortController();
const abortDisconnected = () => {
  if (!response.writableEnded && !requestController.signal.aborted) requestController.abort();
};
request.on("aborted", abortDisconnected);
response.on("close", abortDisconnected);
if (request.aborted || response.destroyed) abortDisconnected();
```

Pass `requestController.signal` as the fourth `runAgentTurn` argument. Guard stream writes:

```ts
const writeEvent = (event: unknown) => {
  if (response.destroyed || response.writableEnded) return false;
  response.write(encodeAgentStreamEvent(event));
  return true;
};
```

Use `writeEvent` for trace/progress/result/error output. In both JSON and stream catches, if `requestController.signal.aborted` or `isTurnCancelled(error)`, return immediately: do not log a failure, complete pending trace steps, send a 502, or emit an error frame. Remove both disconnect listeners in `finally`.

Reduce `agent/server.ts` to environment/config setup, `createAgentRunner(...)`, `createAgentHttpHandler(...)`, and `server.listen(...)`. Delete `TURN_TIMEOUT_MS` and its config entry. The extracted handler must receive the same signal as the fourth `runAgentTurn` argument for both JSON and stream routes.

- [ ] **Step 6: Remove the obsolete smoke-test option**

Delete `timeoutMs: 120_000` from the runtime config in `agent/skill-smoke.ts`. Do not change its scenario-level test runner limits or `maxTurns`.

- [ ] **Step 7: Update the repository maintenance guide**

In `AGENTS.md`, replace the stale statement that an invalid key waits for a 120-second timeout with: the application has no total-duration timer; provider/authentication errors surface as real upstream errors, and a hanging turn can be actively stopped. Replace the protocol statement “Workers 150s / Agent 120s” with: neither hop imposes an application wall-clock timeout, cancellation propagates browser → Workers → Agent SDK, and `maxTurns = 12` remains the logical loop cap.

- [ ] **Step 8: Run focused tests and commit**

Run the Step 2 command. Expected: PASS.

```bash
git add agent/run-turn.ts agent/http-handler.ts agent/server.ts agent/skill-smoke.ts AGENTS.md \
  tests/agent-cancellation.test.ts tests/agent-http-cancellation.test.ts \
  tests/cancellation-wiring.test.ts
git commit -m "feat: cancel agent sdk work on disconnect"
```

### Task 5: Full verification, browser smoke test, and review

**Files:**
- Verify all files changed in Tasks 1–4

- [ ] **Step 1: Run the complete automated suite**

```bash
PATH=/Users/jerry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm test
PATH=/Users/jerry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npx tsc --noEmit
PATH=/Users/jerry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npx tsc -p agent/tsconfig.json
PATH=/Users/jerry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run lint
PATH=/Users/jerry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run build
git diff --check
```

Expected: every command exits 0; `npm test` has no failed, cancelled, skipped, or todo tests.

- [ ] **Step 2: Restart both local processes**

Stop the existing `npm run dev:all` session and restart it with the repository's Node 22 runtime:

```bash
PATH=/Users/jerry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH npm run dev:all
```

Expected: Agent health service starts on the configured `AGENT_PORT`, and Vinext prints the active localhost URL.

- [ ] **Step 3: Verify the waiting wave and stop button in the browser**

Open the active localhost URL, start a new marketing conversation, and observe one streaming turn:

1. Before tools appear, three dots move in a left-to-right wave.
2. After the Skill/tool card appears and before reply text starts, the three dots remain visible below the card.
3. The send arrow is replaced by a clickable square with accessible name “停止生成”.
4. Clicking it immediately clears temporary trace/reply UI, restores the submitted text only when the user has not typed a newer draft, unlocks the composer, and shows no red error.
5. If the stopped turn was the initial automatic interpretation, a neutral “继续理解” action is available and successfully starts it again.
6. Browser/network inspection shows the streaming request cancelled; Agent logs stop growing for that turn.
7. Force a stale-seq 409 (for example with the same session in two tabs): the stale tab refreshes to the committed snapshot without a red error and without restoring the already-committed sentence into the input.

- [ ] **Step 4: Verify there is no application total timeout**

Use the controlled fake Agent query to prove it remains pending across multiple event-loop turns and only settles when its controller is explicitly aborted. Do not wait on a paid model merely to consume 120 seconds. The source contract must confirm that runtime code contains neither `AbortSignal.timeout(150_000)` nor the Agent `setTimeout(...120_000...)` timer, while `maxTurns: 12` remains.

- [ ] **Step 5: Request independent code review and close findings**

Ask a reviewer to inspect cancellation races, late events, response-close behavior, and the initial auto-interpret stop state. Fix any Critical or Important finding, then rerun Step 1.

- [ ] **Step 6: Commit any review fixes**

If review required changes:

```bash
git add app/lib/cancellation.ts app/lib/server/turns.ts app/lib/client/api.ts app/lib/client/stream.ts \
  app/components/chat/conversation.tsx app/components/chat/composer.tsx \
  app/components/chat/thinking-indicator.tsx app/globals.css \
  "app/api/sessions/[id]/turns/route.ts" app/lib/server/runtime.ts \
  agent/run-turn.ts agent/http-handler.ts agent/server.ts agent/skill-smoke.ts AGENTS.md \
  tests/conversation.test.ts tests/client-stream.test.ts tests/campaign-ui.test.ts \
  tests/agent-cancellation.test.ts tests/agent-http-cancellation.test.ts \
  tests/cancellation-wiring.test.ts
git commit -m "fix: close agent cancellation review gaps"
```

If review found no changes, do not create an empty commit.
