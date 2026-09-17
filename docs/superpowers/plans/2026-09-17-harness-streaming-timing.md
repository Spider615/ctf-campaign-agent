# Harness Streaming and Honest Timing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface real harness stages, safely stream the final assistant reply end-to-end, and replace misleading `0.0s` labels with process-local, honest timing.

**Architecture:** The Agent process emits typed phase, trace, safe text-delta/reset, and result events from actual SDK boundaries. Workers forward temporary events and commit only the final result. The browser renders one provisional reply which the authoritative Snapshot replaces. Each process measures durations with its own monotonic clock; no cross-host absolute timestamps are subtracted.

**Tech Stack:** TypeScript 5.9, Claude Agent SDK partial messages, NDJSON streaming, Web Streams, React 19, Node test runner

---

**Spec:** `docs/superpowers/specs/2026-09-17-harness-first-campaign-agent-design.md` §§7–9, 13–14

## Global constraints

- Never stream thinking blocks, tool JSON, child-agent text, or an assistant message that later becomes a tool-use turn.
- Reuse the final reply sanitizer; a partial reply must never transiently expose content the final sanitizer removes.
- Final Snapshot remains the only persisted and authoritative message.
- Use monotonic time only inside the process that owns an interval; `Date.now()` remains for ordering and message timestamps.
- Preserve backward reading of old trace messages.

### Task 1: Extract one safe final-reply sanitizer

**Files:**
- Modify: `tests/agent-tools.test.ts`
- Modify: `app/lib/agent/tools.ts`

- [ ] Add failing table tests for uplift-claim removal, question removal, sentence/line boundary trimming, and the 800-character cap through an exported pure sanitizer.
- [ ] Run the focused test and confirm the sanitizer is not yet exported/reusable.
- [ ] Extract the cleaning logic used by `finishAgentTurn` into a dependency-free pure function and keep final behavior byte-for-byte compatible.
- [ ] Add a helper that releases only safe complete lines/sentences from a growing candidate while retaining an unsafe/incomplete tail.
- [ ] Re-run `tests/agent-tools.test.ts` and both TypeScript checks.
- [ ] Commit: `refactor: share safe agent reply sanitizer`

### Task 2: Extend and strictly decode the Agent-service stream protocol

**Files:**
- Modify: `tests/agent-stream.test.ts`
- Modify: `app/lib/agent/stream.ts`
- Modify: `app/lib/agent/protocol.ts`

- [ ] Add failing tests for `phase`, `text_delta`, and `text_reset`, including split multibyte Chinese chunks, malformed payloads, unknown event types, duplicate terminal events, and data after a terminal event.
- [ ] Run `node --test --experimental-strip-types tests/agent-stream.test.ts` and observe RED.
- [ ] Add the typed events and strict decoder state machine while retaining legacy `trace` / `result` / `error` support.
- [ ] Ensure exactly one terminal `result` or `error` is accepted.
- [ ] Re-run the focused test and `npx tsc -p agent/tsconfig.json`.
- [ ] Commit: `feat: extend agent stream protocol`

### Task 3: Convert real SDK partial messages into safe reply events

**Files:**
- Modify: `tests/agent-run-turn.test.ts` (create if absent)
- Modify: `agent/run-turn.ts`

- [ ] Build a scripted async SDK-message fixture and add failing tests for top-level text deltas, ignored thinking/input-json/child events, assistant candidates reset by later `tool_use`, and multiple assistant messages.
- [ ] Add a failing order test for `analyzing` → real Skill/tool trace → `writing` → safe text delta → result.
- [ ] Run the focused test and confirm current code ignores `stream_event` messages.
- [ ] Set `includePartialMessages: true`; maintain a candidate buffer per top-level assistant message; emit only sanitized complete segments.
- [ ] Emit `text_reset` if a candidate later contains tool use; ignore all events with non-null `parent_tool_use_id`.
- [ ] Reconcile accumulated provisional text with the cleaned final result, leaving Snapshot replacement as the final fallback.
- [ ] Re-run the focused tests and agent TypeScript check.
- [ ] Commit: `feat: stream safe final agent text`

### Task 4: Forward phase and reply events from Agent service to browser

**Files:**
- Modify: `agent/server.ts`
- Modify: `app/lib/server/runtime.ts`
- Modify: `app/lib/server/turns.ts`
- Modify: `app/api/sessions/[id]/turns/route.ts`
- Modify: `app/lib/client/stream.ts`
- Modify: `app/lib/client/api.ts`
- Modify: `tests/client-stream.test.ts`
- Modify: `tests/conversation.test.ts`

- [ ] Add failing parser tests for browser `phase` / `text_delta` / `text_reset` / `snapshot` events and split Chinese chunks.
- [ ] Add failing server-turn tests proving transient events are forwarded but never persisted, and errors terminate with the stored retry message.
- [ ] Run focused tests and observe RED.
- [ ] Wire callbacks through all three streaming hops; keep non-model deterministic turns on ordinary JSON.
- [ ] Reject duplicate snapshots, stream data after terminal, and invalid event payloads.
- [ ] Re-run focused tests and both TypeScript checks.
- [ ] Commit: `feat: forward live harness reply events`

### Task 5: Render one provisional reply and hand it off to Snapshot

**Files:**
- Modify: `app/components/chat/conversation.tsx`
- Modify: `app/components/chat/message-view.tsx`
- Modify: `tests/message-text.test.ts`

- [ ] Add failing reducer/helper tests for appending deltas, resetting a candidate, clearing on failure, and replacing provisional text with one persisted assistant message without duplication.
- [ ] Add `liveReply` and actual phase state to `Conversation`; show a temporary assistant bubble only when safe text arrives.
- [ ] On Snapshot, clear all transient state before rendering persisted messages; on error or abort, discard provisional text.
- [ ] Keep tool traces and text updates independently renderable in the same turn.
- [ ] Run focused tests, `npx tsc --noEmit`, and a browser smoke with deliberately delayed text chunks.
- [ ] Commit: `feat: render streamed agent replies`

### Task 6: Measure and display honest process-local durations

**Files:**
- Modify: `tests/tool-trace.test.ts`
- Modify: `app/lib/tool-trace.ts`
- Modify: `agent/run-turn.ts`
- Modify: `agent/server.ts`
- Modify: `app/lib/server/runtime.ts`
- Modify: `app/lib/server/turns.ts`
- Modify: `app/components/chat/tool-run-card.tsx`
- Modify: `app/components/chat/tool-step.tsx`

- [ ] Add failing tests for `formatDuration`: `<1ms`, rounded integer milliseconds below one second, and one decimal second at or above one second.
- [ ] Add failing interval-union tests and harness-analysis calculations, including overlapping intervals and non-negative clamping.
- [ ] Add backward-compatibility tests proving legacy `durationMs` is labelled `步骤跨度`, never `总用时`.
- [ ] Replace per-tool wall-clock subtraction with a local monotonic clock and serialize duration/relative offsets measured in the Agent process.
- [ ] Measure Workers total locally and expose optional harness, analysis/waiting, tool/Skill, and system/network summary fields without subtracting cross-host timestamps.
- [ ] Update live and completed cards to share the formatter and show baseline Skill count in the collapsed summary.
- [ ] Run `tests/tool-trace.test.ts`, both TypeScript checks, lint, and a manual slow-turn check where small tool steps show milliseconds while the harness total shows seconds.
- [ ] Commit: `fix: report honest harness durations`

### Task 7: Verify failure and compatibility paths

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: relevant tests only if a discovered regression needs coverage

- [ ] Exercise success, Agent error, timeout, client abort, malformed NDJSON, and old stored trace rendering.
- [ ] Confirm no thinking/tool JSON appears in the browser or persisted messages.
- [ ] Run `npm test`, both TypeScript checks, `npm run lint`, and `npm run build`.
- [ ] With a valid model key, run the live smoke and visually confirm real phase order and character-by-character or sentence-chunk progress.
- [ ] Commit: `docs: describe harness streaming and timing`
