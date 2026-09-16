# Light AI Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing ICS-1811 campaign assistant into the approved light-blue AI workspace and stream real, auditable tool-use steps while preserving every existing SOP guard.

**Architecture:** A shared pure-TypeScript trace contract describes tool steps across the Agent process, Workers process, stored chat messages, and React client. The Agent service exposes an NDJSON stream for model-driven tools; the Workers turn route forwards safe progress events, reruns the deterministic campaign pipeline, persists one normalized trace message, and ends with the authoritative Snapshot. React renders the same `ToolRunCard` for live and stored traces, while the existing app shell and draft panel are restyled with semantic light-blue design tokens.

**Tech Stack:** TypeScript 5.9, React 19, Vinext/Next-compatible routes, Tailwind CSS 4, Cloudflare Workers/D1, Claude Agent SDK with DeepSeek Anthropic compatibility, Node test runner, Lucide React

**Spec:** `docs/superpowers/specs/2026-09-16-light-ai-workspace-design.md`

## Global Constraints

- Use Node.js `>=22.13.0`; this machine already has Node `v22.23.1` under `/Users/hukui/.nvm/versions/node/v22.23.1`.
- Preserve the current dirty worktree. Never stage, overwrite, or commit pre-existing user changes; stage only task-owned new files or individually verified task hunks.
- Keep Chinese UI copy, code comments, and user-facing errors consistent with the repository.
- Do not connect to Chow Tai Fook production systems or change the demo-only codebook boundary.
- Do not relax quote, numeric, code-table, two-round, confirmation, or server-side validation guards.
- Never expose model chain-of-thought, prompts, full tool inputs, API keys, or internal stack traces.
- Every displayed completed tool step must correspond to a real model or orchestrator call.
- Do not add a new animation or component dependency; use React, Tailwind, CSS, existing shadcn primitives, and Lucide.
- Preserve Node-strip-types boundaries: shared campaign/agent/server modules use relative imports with explicit `.ts` extensions and do not import browser-only code, `cloudflare:workers`, DB modules, or npm packages.
- Use `git diff --check`, inspect `git diff --cached`, and skip a task commit if its hunks cannot be separated safely from pre-existing edits.

## File Structure Map

- `app/lib/tool-trace.ts`: dependency-free shared tool names, trace types, event merging, summaries, and safe normalization.
- `app/lib/agent/stream.ts`: dependency-free NDJSON event encoding/decoding shared by Agent and Workers.
- `app/lib/agent/tools.ts`: concrete campaign tool implementations and AgentState flags; no transport concerns.
- `agent/server.ts`: Claude Agent SDK registration plus `/turn` JSON and `/turn/stream` NDJSON transports.
- `app/lib/server/runtime.ts`: remote Agent stream consumer and runtime dependency assembly.
- `app/lib/server/turns.ts`: authoritative campaign state transition, deterministic orchestrator tools, trace persistence.
- `app/lib/client/stream.ts`: browser response parser; emits progress and returns the terminal Snapshot.
- `app/components/chat/tool-run-card.tsx`: live and historical tool trace presentation.
- `app/components/chat/conversation.tsx`: owns transient trace state and swaps it for the stored Snapshot.
- `app/globals.css`: semantic design tokens and shared light-workspace effects.

---

### Task 1: Shared tool trace contract and stored message type

**Files:**
- Create: `app/lib/tool-trace.ts`
- Modify: `app/lib/campaign/ics1811/messages.ts`
- Create: `tests/tool-trace.test.ts`
- Modify: `tests/message-text.test.ts`

**Interfaces:**
- Produces: `CampaignToolName`, `ToolInitiator`, `ToolTraceStatus`, `AgentTraceEvent`, `ToolTrace`
- Produces: `startTraceEvent(input): AgentTraceEvent`
- Produces: `finishTraceEvent(event, input): AgentTraceEvent`
- Produces: `mergeTraceEvent(events, event): AgentTraceEvent[]`
- Produces: `traceSummary(trace): string`
- Extends: `StoredMessage` with `{ v: 2; kind: "agent_tool_trace"; trace: ToolTrace }`

- [ ] **Step 1: Write failing trace and message tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { finishTraceEvent, mergeTraceEvent, startTraceEvent, traceSummary } from "../app/lib/tool-trace.ts";
import { messageToText } from "../app/lib/campaign/ics1811/messages.ts";

test("trace events replace an in-flight step by id", () => {
  const started = startTraceEvent({ id: "t1", tool: "extract_campaign_facts", title: "提取活动信息", initiatedBy: "model", at: 100 });
  const completed = finishTraceEvent(started, { status: "completed", summary: "识别并核验 8 项信息", at: 180 });
  const events = mergeTraceEvent(mergeTraceEvent([], started), completed);
  assert.equal(events.length, 1);
  assert.equal(events[0].durationMs, 80);
  assert.equal(events[0].summary, "识别并核验 8 项信息");
});

test("stored traces become a short history line", () => {
  const trace = { status: "completed" as const, durationMs: 80, steps: [
    finishTraceEvent(startTraceEvent({ id: "t1", tool: "extract_campaign_facts", title: "提取活动信息", initiatedBy: "model", at: 100 }), { status: "completed", summary: "识别 8 项", at: 180 }),
  ] };
  assert.equal(traceSummary(trace), "AI 完成 1 个工具步骤 · 0.1 秒");
  assert.equal(messageToText({ v: 2, kind: "agent_tool_trace", trace }), "AI 完成 1 个工具步骤 · 0.1 秒");
});
```

- [ ] **Step 2: Run the focused tests and verify the missing-module failure**

Run:

```bash
node --test --experimental-strip-types tests/tool-trace.test.ts tests/message-text.test.ts
```

Expected: FAIL because `app/lib/tool-trace.ts` and `agent_tool_trace` do not exist.

- [ ] **Step 3: Implement the dependency-free trace types and pure helpers**

```ts
export const CAMPAIGN_TOOL_NAMES = [
  "extract_campaign_facts",
  "lookup_ics_reference",
  "analyze_campaign_state",
  "draft_campaign_copy",
  "build_campaign_readback",
  "generate_ics1811_sheet",
  "confirm_campaign_readback",
  "undo_campaign_change",
] as const;

export type CampaignToolName = (typeof CAMPAIGN_TOOL_NAMES)[number];
export type ToolTraceStatus = "started" | "completed" | "warning" | "failed";
export type ToolInitiator = "model" | "orchestrator";
export type AgentTraceEvent = {
  id: string;
  tool: CampaignToolName;
  title: string;
  status: ToolTraceStatus;
  initiatedBy: ToolInitiator;
  startedAt: number;
  summary?: string;
  durationMs?: number;
};
export type ToolTrace = {
  status: Exclude<ToolTraceStatus, "started">;
  durationMs: number;
  steps: AgentTraceEvent[];
};
```

Implement merging by stable `id`, clamp duration to `>= 0`, format seconds to one decimal, and reject malformed trace payloads in the `agent_tool_trace` branch of `decodeMessage`.

- [ ] **Step 4: Run focused tests**

Run: `node --test --experimental-strip-types tests/tool-trace.test.ts tests/message-text.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit only isolated Task 1 hunks**

```bash
git add app/lib/tool-trace.ts tests/tool-trace.test.ts
git add -p app/lib/campaign/ics1811/messages.ts tests/message-text.test.ts
git diff --cached --check
git commit -m "feat: add agent tool trace contract"
```

---

### Task 2: Deterministic campaign tools and safe trace summaries

**Files:**
- Modify: `app/lib/agent/tools.ts`
- Modify: `app/lib/agent/protocol.ts`
- Modify: `app/lib/agent/prompt.ts`
- Modify: `agent/server.ts`
- Modify: `tests/conversation.test.ts`
- Create: `tests/agent-tools.test.ts`

**Interfaces:**
- Consumes: `CampaignToolName`, `AgentTraceEvent`, `ToolTrace`
- Produces: `runAgentTool(state, name, input): ToolOutcome`
- Produces: `safeToolSummary(name, outcome, state): string`
- Extends: `AgentState` with `analysisRan`, `readbackBuilt`, `sheetGenerated`, and `trace`
- Extends: `AgentResult` with `trace: ToolTrace | null`

- [ ] **Step 1: Write failing tests for renamed and added tools**

```ts
const requestFor = (text: string): AgentRequest => ({
  today: "2026-09-16",
  draft: createEmptyDraft("tool-test", text),
  history: [],
  trigger: { kind: "user_message", text },
  phase: "asking",
  roundsUsed: 0,
  openQuestions: [],
  readbackSeq: null,
  canConfirm: false,
  canUndo: false,
});

test("campaign tools expose deterministic analysis without changing the draft", () => {
  const state = createAgentState(requestFor("满5000减500，钻石类"));
  const before = structuredClone(state.draft);
  const outcome = runAgentTool(state, "analyze_campaign_state");
  const body = JSON.parse(outcome.text);
  assert.deepEqual(state.draft, before);
  assert.equal(typeof body.detailCount, "number");
  assert.ok(Array.isArray(body.missing));
  assert.equal(state.analysisRan, true);
});

test("reference lookup returns codebook matches and source labels", () => {
  const state = createAgentState(requestFor("7590门店一般足金类"));
  const outcome = runAgentTool(state, "lookup_ics_reference", { query: "7590 一般足金" });
  const body = JSON.parse(outcome.text);
  assert.ok(body.matches.some((item: { code: string }) => item.code === "7590"));
  assert.ok(body.matches.some((item: { label: string }) => item.label === "一般足金类"));
  assert.ok(body.matches.every((item: { origin: string }) => item.origin));
});
```

Update the existing guard test to call `extract_campaign_facts`, `draft_campaign_copy`, and `confirm_campaign_readback`.

- [ ] **Step 2: Run focused tests and verify unknown-tool failures**

Run: `node --test --experimental-strip-types tests/agent-tools.test.ts tests/conversation.test.ts`

Expected: FAIL because the new tool names and state flags are not implemented.

- [ ] **Step 3: Refactor existing tools and add the deterministic tools**

Implement these exact mappings:

```ts
const toolHandlers: Record<CampaignToolName, (state: AgentState, input: Record<string, unknown>) => ToolOutcome> = {
  extract_campaign_facts: extractCampaignFacts,
  lookup_ics_reference: lookupIcsReference,
  analyze_campaign_state: analyzeCampaignState,
  draft_campaign_copy: draftCampaignCopy,
  build_campaign_readback: buildCampaignReadback,
  generate_ics1811_sheet: generateIcs1811Sheet,
  confirm_campaign_readback: confirmCampaignReadback,
  undo_campaign_change: undoCampaignChange,
};
```

`lookup_ics_reference` searches code, label, display, and aliases across stores, regions, categories, offer types, brands, product scopes, member levels, price types, and approval flows; it returns at most eight matches with `code`, `label`, `display`, `origin`, and `evidence`.

`analyze_campaign_state` calls `deriveFill`, `checkDraft`, `gapsOf`, and `planNext` and returns only counts, public labels, blockers, warnings, and `canConfirm`. `build_campaign_readback` calls `buildReadback` and returns its summary plus missing/blocker counts. `generate_ics1811_sheet` rejects unless the current request is confirmable and returns only detail/post-action/check counts; Workers still generates the authoritative sheet.

- [ ] **Step 4: Update Agent registration and prompts**

Register all eight tool names in `agent/server.ts`. Keep narrow zod schemas:

```ts
tool("lookup_ics_reference", "查询 ICS 演示代码表，不修改草稿", {
  query: z.string().min(1).max(120),
}, handle("lookup_ics_reference"));
tool("analyze_campaign_state", "运行确定性的 1811 字段推导、缺项和校验", {}, handle("analyze_campaign_state"));
```

Update the system prompt to require `analyze_campaign_state` after field extraction, forbid invented tool results, and allow direct answers for explanatory questions that do not modify the campaign.

- [ ] **Step 5: Run tool and conversation tests**

Run: `node --test --experimental-strip-types tests/agent-tools.test.ts tests/conversation.test.ts`

Expected: PASS, including existing quote, copy, confirm, undo, and reply-trimming guards.

- [ ] **Step 6: Commit only isolated Task 2 hunks**

```bash
git add tests/agent-tools.test.ts
git add -p app/lib/agent/tools.ts app/lib/agent/protocol.ts app/lib/agent/prompt.ts agent/server.ts tests/conversation.test.ts
git diff --cached --check
git commit -m "feat: expose campaign rules as agent tools"
```

---

### Task 3: Agent-service NDJSON event stream

**Files:**
- Create: `app/lib/agent/stream.ts`
- Modify: `agent/server.ts`
- Modify: `app/lib/agent/protocol.ts`
- Create: `tests/agent-stream.test.ts`

**Interfaces:**
- Produces: `AgentStreamEvent = { type: "trace"; event: AgentTraceEvent } | { type: "result"; result: AgentResult } | { type: "error"; error: string }`
- Produces: `encodeAgentStreamEvent(event): string`
- Produces: `decodeAgentStreamLine(line): AgentStreamEvent`
- Produces: `runAgentTurn(request, onTrace?): Promise<AgentResult>` in the Agent process
- Adds: `POST /turn/stream` with `application/x-ndjson; charset=utf-8`

- [ ] **Step 1: Write failing NDJSON codec tests**

```ts
const completedEvent: AgentTraceEvent = {
  id: "trace-1",
  tool: "extract_campaign_facts",
  title: "提取活动信息",
  status: "completed",
  initiatedBy: "model",
  startedAt: 100,
  durationMs: 80,
  summary: "识别并核验 8 项信息",
};

test("agent stream events survive line encoding", () => {
  const source: AgentStreamEvent = { type: "trace", event: completedEvent };
  assert.deepEqual(decodeAgentStreamLine(encodeAgentStreamEvent(source).trim()), source);
});

test("decoder rejects a result without the existing AgentResult guards", () => {
  assert.throws(() => decodeAgentStreamLine('{"type":"result","result":{}}'), /不完整/);
});
```

- [ ] **Step 2: Run the stream test and verify the missing-module failure**

Run: `node --test --experimental-strip-types tests/agent-stream.test.ts`

Expected: FAIL because `app/lib/agent/stream.ts` is missing.

- [ ] **Step 3: Implement strict line encoding and decoding**

Each encoded event is exactly one JSON object followed by `\n`. Reuse `parseAgentResult` for terminal results and the Task 1 trace guards for trace events. Reject empty, unknown, and oversized lines.

- [ ] **Step 4: Instrument real tool handlers**

Wrap every SDK tool handler with one stable ID and timestamps:

```ts
const handle = (name: CampaignToolName) => async (args: Record<string, unknown>) => {
  const started = startTraceEvent({ id: crypto.randomUUID(), tool: name, title: TOOL_META[name].title, initiatedBy: "model", at: Date.now() });
  onTrace?.(started);
  const outcome = runAgentTool(state, name, args);
  const finished = finishTraceEvent(started, {
    status: outcome.isError ? "warning" : "completed",
    summary: safeToolSummary(name, outcome, state),
    at: Date.now(),
  });
  state.trace = mergeTraceEvent(state.trace, finished);
  onTrace?.(finished);
  return sdkToolResult(outcome);
};
```

The summary must come from `safeToolSummary`; never stringify tool arguments into a trace event.

- [ ] **Step 5: Add `/turn/stream` while preserving `/turn`**

For the streaming route, write trace lines as callbacks arrive, write one result line on success, and one friendly error line on failure. Keep authentication, body-size limits, timeout, and `/turn` behavior unchanged.

- [ ] **Step 6: Run stream, tool, and Agent type checks**

Run:

```bash
node --test --experimental-strip-types tests/agent-stream.test.ts tests/agent-tools.test.ts
npx tsc -p agent/tsconfig.json
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add app/lib/agent/stream.ts tests/agent-stream.test.ts
git add -p agent/server.ts app/lib/agent/protocol.ts
git diff --cached --check
git commit -m "feat: stream real agent tool events"
```

---

### Task 4: Workers streaming route, persistence, and browser decoder

**Files:**
- Modify: `app/lib/server/runtime.ts`
- Modify: `app/lib/server/turns.ts`
- Modify: `app/api/sessions/[id]/turns/route.ts`
- Modify: `app/lib/client/api.ts`
- Create: `app/lib/client/stream.ts`
- Modify: `app/lib/campaign/ics1811/messages.ts`
- Create: `tests/client-stream.test.ts`
- Modify: `tests/conversation.test.ts`

**Interfaces:**
- Changes: `AgentRunner = (request, onTrace?) => Promise<AgentResult>`
- Changes: `TurnDeps` accepts optional `emitTrace(event): void`
- Produces: `TurnStreamEvent = { type: "trace"; event: AgentTraceEvent } | { type: "snapshot"; snapshot: Snapshot } | { type: "error"; error: string }`
- Produces: `consumeTurnStream(response, onTrace): Promise<Snapshot>`
- Produces: `postTurnStream(id, body, onTrace): Promise<Snapshot>`
- Persists: one `agent_tool_trace` message before the Agent text/readback/fill-sheet output

- [ ] **Step 1: Write failing browser stream parser tests**

```ts
const completedEvent: AgentTraceEvent = {
  id: "trace-1",
  tool: "extract_campaign_facts",
  title: "提取活动信息",
  status: "completed",
  initiatedBy: "model",
  startedAt: 100,
  durationMs: 80,
  summary: "识别并核验 8 项信息",
};
const snapshot = { session: { id: "session-1" } } as unknown as Snapshot;
const responseFrom = (chunks: string[]) => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  },
}), { headers: { "content-type": "application/x-ndjson" } });

test("browser decoder handles split JSON lines and returns the final snapshot", async () => {
  const chunks = [
    '{"type":"trace","event":',
    `${JSON.stringify(completedEvent)}}\n{"type":"snapshot","snapshot":${JSON.stringify(snapshot)}}\n`,
  ];
  const seen: AgentTraceEvent[] = [];
  const result = await consumeTurnStream(responseFrom(chunks), (event) => seen.push(event));
  assert.deepEqual(seen, [completedEvent]);
  assert.deepEqual(result, snapshot);
});
```

Also cover a final line without a trailing newline, a server error event, an HTTP JSON error, and a stream ending before `snapshot`.

- [ ] **Step 2: Run the parser test and verify the missing-module failure**

Run: `node --test --experimental-strip-types tests/client-stream.test.ts`

Expected: FAIL because `app/lib/client/stream.ts` is missing.

- [ ] **Step 3: Implement the browser NDJSON parser**

Use `response.body.getReader()`, one `TextDecoder`, and a carry buffer. Dispatch only validated trace events. Throw `ApiError` for HTTP errors and stream error events. Require exactly one terminal Snapshot.

- [ ] **Step 4: Consume Agent-service streaming in runtime**

Add `runAgentRemote(request, onTrace)` that POSTs to `/turn/stream`, parses lines with `decodeAgentStreamLine`, forwards trace events, and returns the terminal `AgentResult`. Fall back to the existing `/turn` JSON request only when the service explicitly returns `404`, so genuine stream failures are not hidden.

- [ ] **Step 5: Stream the Workers turn response**

When the browser sends `Accept: application/x-ndjson`, construct a `ReadableStream`:

```ts
const stream = new ReadableStream({
  start(controller) {
    const emit = (event: TurnStreamEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
    void runTurn(id, body, runtimeDeps((event) => emit({ type: "trace", event })))
      .then((snapshot) => emit({ type: "snapshot", snapshot }))
      .catch((error) => emit({ type: "error", error: publicTurnError(error) }))
      .finally(() => controller.close());
  },
});
```

Add a focused public-error helper beside `errorResponse`:

```ts
export function publicTurnError(error: unknown): string {
  if (error instanceof TurnError) return error.message;
  return "没保存成功，可以重试";
}
```

Keep the existing JSON response when the Accept header is absent, so tests and non-stream callers remain compatible.

- [ ] **Step 6: Persist one normalized trace message**

Collect final tool steps by ID. For model calls, use the trace returned by AgentResult. For deterministic confirmation and sheet generation, wrap `renderFillSheet` as an orchestrator `generate_ics1811_sheet` step. Insert the trace before the related Agent output message. Do not include live `started` events in stored messages.

If Agent execution fails after trace events were emitted, persist the completed/failed steps next to the existing `agent_error`. If the client connection drops, the server still finishes the turn and commits once.

- [ ] **Step 7: Run parser and conversation tests**

Run:

```bash
node --test --experimental-strip-types tests/client-stream.test.ts tests/conversation.test.ts tests/message-text.test.ts
npx tsc --noEmit
```

Expected: PASS. Existing JSON turn tests remain unchanged; new assertions find one `agent_tool_trace` message with stable ordering.

- [ ] **Step 8: Commit Task 4**

```bash
git add app/lib/client/stream.ts tests/client-stream.test.ts
git add -p app/lib/server/runtime.ts app/lib/server/turns.ts 'app/api/sessions/[id]/turns/route.ts' app/lib/client/api.ts app/lib/campaign/ics1811/messages.ts tests/conversation.test.ts
git diff --cached --check
git commit -m "feat: stream and persist campaign tool traces"
```

---

### Task 5: Live and historical tool-run card

**Files:**
- Create: `app/components/chat/tool-run-card.tsx`
- Create: `app/components/chat/tool-step.tsx`
- Create: `app/components/chat/agent-avatar.tsx`
- Modify: `app/components/chat/conversation.tsx`
- Modify: `app/components/chat/message-view.tsx`
- Modify: `app/components/chat/thinking-indicator.tsx`
- Modify: `tests/tool-trace.test.ts`

**Interfaces:**
- Produces: `ToolRunCard({ trace, live, startedAt }): React.ReactNode`
- Produces: `ToolStep({ event, live }): React.ReactNode`
- Consumes: `postTurnStream(id, body, onTrace)` and `mergeTraceEvent`

- [ ] **Step 1: Add failing view-model assertions**

Add pure helpers to `tool-trace.ts` and test them without a DOM:

```ts
const event = (id: string, status: ToolTraceStatus): AgentTraceEvent => ({
  id,
  tool: "analyze_campaign_state",
  title: "运行 1811 规则分析",
  status,
  initiatedBy: "model",
  startedAt: 0,
  durationMs: 100,
});
const failedTrace: ToolTrace = { status: "failed", durationMs: 300, steps: [event("1", "completed"), event("2", "completed"), event("3", "failed")] };
const warningTrace: ToolTrace = { status: "warning", durationMs: 300, steps: [event("1", "completed"), event("2", "completed"), event("3", "warning")] };
const completedTrace: ToolTrace = { status: "completed", durationMs: 3800, steps: [event("1", "completed"), event("2", "completed"), event("3", "completed"), event("4", "completed")] };

test("trace card summary prioritizes failures and warnings", () => {
  assert.deepEqual(traceCardSummary(failedTrace), { tone: "failed", label: "执行失败 · 已完成 2 步" });
  assert.deepEqual(traceCardSummary(warningTrace), { tone: "warning", label: "完成 3 步 · 1 项需注意" });
  assert.deepEqual(traceCardSummary(completedTrace), { tone: "success", label: "完成 4 个工具步骤 · 3.8 秒" });
});
```

- [ ] **Step 2: Run the trace test and verify the missing-helper failure**

Run: `node --test --experimental-strip-types tests/tool-trace.test.ts`

Expected: FAIL because `traceCardSummary` does not exist.

- [ ] **Step 3: Implement trace-card view helpers and components**

`ToolRunCard` requirements:

- Live header: breathing blue dot, “AI 正在搭建活动”, elapsed timer.
- Stored header: collapsed by default, summary text from `traceCardSummary`.
- Step states use icon plus text, never color alone.
- Tool code names use a small monospace badge.
- Orchestrator steps show “系统补跑” only when `initiatedBy === "orchestrator"` and the same tool was expected from the model.
- The live card has `role="status"` and `aria-live="polite"`; stored cards do not.

- [ ] **Step 4: Wire streaming state into Conversation**

Add transient state:

```ts
const [liveTrace, setLiveTrace] = useState<AgentTraceEvent[]>([]);
const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
```

For `interpret`, `text`, and `confirm`, call `postTurnStream`; merge each event by ID. Clear transient state only after the terminal Snapshot is installed. Keep pending user bubbles and the existing retry/error behavior. JSON-only card/edit/dismiss/undo/rollback calls continue through `postTurn` unless Task 4 exposes a trace for them.

- [ ] **Step 5: Render persisted trace messages**

Add an `agent_tool_trace` branch in `MessageItem` before `agent_text`. Use the same card component with `live={false}`. Update continuation/avatar logic so a trace followed by Agent text reads as one Agent response.

Keep `ThinkingIndicator` only as a network-start fallback before the first trace event; remove it once the live card exists.

- [ ] **Step 6: Run focused tests and page type check**

Run:

```bash
node --test --experimental-strip-types tests/tool-trace.test.ts tests/message-text.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add app/components/chat/tool-run-card.tsx app/components/chat/tool-step.tsx app/components/chat/agent-avatar.tsx
git add -p app/components/chat/conversation.tsx app/components/chat/message-view.tsx app/components/chat/thinking-indicator.tsx app/lib/tool-trace.ts tests/tool-trace.test.ts
git diff --cached --check
git commit -m "feat: show live agent tool execution"
```

---

### Task 6: Light-blue design system, shell, homepage, and composer

**Files:**
- Modify: `app/globals.css`
- Modify: `app/components/app-shell.tsx`
- Modify: `app/components/chat/empty-state.tsx`
- Modify: `app/components/chat/composer.tsx`
- Modify: `app/layout.tsx`

**Interfaces:**
- Produces: global semantic tokens from design spec section 2
- Preserves: existing AppShell session loading, mobile navigation, WebMCP registration, and routing

- [ ] **Step 1: Record a baseline visual and interaction checklist**

Start the existing app with Node 22 and record the current desktop home, conversation, and mobile states. Verify before editing:

```text
[ ] New-session submit works
[ ] Existing session opens
[ ] Mobile navigation opens and closes
[ ] Composer keyboard submit works
[ ] Filling panel opens from the header
```

This baseline distinguishes visual regressions from pre-existing behavior.

- [ ] **Step 2: Replace global color tokens and add reusable workspace effects**

Define the exact approved tokens in `:root`, including `--primary: #247cff`, `--background: #eef6ff`, `--foreground: #17243a`, `--border: #d9e7f6`, success/warning colors, and ruby/gold brand accents. Add reusable CSS classes for a low-opacity grid, glass surface, blue focus glow, trace pulse, and reduced-motion overrides.

Do not leave raw old burgundy values in business components except the brand mark and explicit destructive/brand accents.

- [ ] **Step 3: Restyle AppShell without changing its data behavior**

Implement a 252px light glass sidebar, blue new-activity button, pale-blue selected session, and compact Agent status card. Preserve all current event listeners, session refresh behavior, reference links, and mobile overlay semantics.

- [ ] **Step 4: Restyle the empty state and composer**

The homepage keeps the current templates and example entry, but moves the composer to the visual center. Add the exact capability line “8 个工具已连接 · ICS 规则库 · 代码表 · 版本记录”. The composer gets a white surface, blue focus halo, visible keyboard hint, and a 44px send target.

- [ ] **Step 5: Verify shell behavior and type safety**

Run:

```bash
npx tsc --noEmit
npm run lint
```

Manually repeat the Step 1 checklist at 1440×900 and 390×844. Expected: all behavior unchanged, no horizontal scroll, no dark full-height sidebar.

- [ ] **Step 6: Commit isolated visual hunks**

```bash
git add -p app/globals.css app/components/app-shell.tsx app/components/chat/empty-state.tsx app/components/chat/composer.tsx app/layout.tsx
git diff --cached --check
git commit -m "feat: apply light ai workspace shell"
```

---

### Task 7: Conversation cards, live draft panel, references, and responsive polish

**Files:**
- Modify: `app/components/chat/step-rail.tsx`
- Modify: `app/components/chat/message-view.tsx`
- Modify: `app/components/chat/clarify-card.tsx`
- Modify: `app/components/chat/readback-card.tsx`
- Modify: `app/components/chat/question-controls.tsx`
- Modify: `app/components/draft/draft-panel.tsx`
- Modify: `app/components/draft/fill-sheet-view.tsx`
- Modify: `app/codes/page.tsx`
- Modify: `app/open-questions/page.tsx`

**Interfaces:**
- Preserves: all existing message actions, question parsing, confirmation, rollback, source jumps, tab state, and panel resizing
- Produces: visual completion percentage `Math.round((totalRequired - missingCount) / totalRequired * 100)` using a named pure helper with zero-denominator protection

- [ ] **Step 1: Write a failing completion-helper test**

```ts
test("draft completion is bounded and handles an empty requirement set", () => {
  assert.equal(draftCompletion(8, 2), 75);
  assert.equal(draftCompletion(0, 0), 100);
  assert.equal(draftCompletion(3, 5), 0);
});
```

Place the pure helper in `app/lib/campaign/ics1811/progress.ts` and test it in `tests/progress.test.ts`.

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `node --test --experimental-strip-types tests/progress.test.ts`

Expected: FAIL because `progress.ts` is missing.

- [ ] **Step 3: Implement the helper and update the progress rail**

Use five steps: 说清需求、AI 分析、补齐信息、核对复述、生成填写值. Preserve the current domain-driven `campaignSteps` mapping; change only labels/states needed to match the approved mockup. Ensure mobile horizontal scrolling retains visible focus.

- [ ] **Step 4: Restyle business cards with semantic tokens**

Apply the light workspace hierarchy to user bubbles, Agent rows, change notes, clarification controls, readback confirmation, alerts, and source links. Keep business-critical warning and blocker distinctions. Replace raw hex colors with semantic classes or CSS variables touched in Task 6.

- [ ] **Step 5: Add live draft hierarchy**

At the panel top show “ICS-1811 实时草稿”, the current phase chip, draft completion bar, detail count, missing count, and round count. Use existing `recentlyFilled`/`highlightedFields` to mark current-turn fields with a pale-blue background; never infer freshness from render time.

- [ ] **Step 6: Restyle reference pages**

Apply the same page background, glass cards, blue headings, table borders, focus states, and mobile overflow handling to `/codes` and `/open-questions`. Do not change reference data or table contents.

- [ ] **Step 7: Run domain, progress, type, and lint checks**

Run:

```bash
node --test --experimental-strip-types tests/progress.test.ts tests/recent-fill.test.ts tests/steps.test.ts tests/conversation.test.ts
npx tsc --noEmit
npm run lint
```

Expected: PASS.

- [ ] **Step 8: Commit isolated Task 7 hunks**

```bash
git add app/lib/campaign/ics1811/progress.ts tests/progress.test.ts
git add -p app/components/chat/step-rail.tsx app/components/chat/message-view.tsx app/components/chat/clarify-card.tsx app/components/chat/readback-card.tsx app/components/chat/question-controls.tsx app/components/draft/draft-panel.tsx app/components/draft/fill-sheet-view.tsx app/codes/page.tsx app/open-questions/page.tsx
git diff --cached --check
git commit -m "feat: polish campaign workspace views"
```

---

### Task 8: End-to-end verification, visual QA, and documentation sync

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify only if QA finds a scoped defect: files changed in Tasks 1–7

**Interfaces:**
- Documents: eight-tool catalog, streaming trace behavior, JSON compatibility endpoint, failure fallback, and visual breakpoints
- Verifies: all existing ICS-1811 behavior plus new trace and UI requirements

- [ ] **Step 1: Synchronize documentation**

Replace the old four-tool names with the eight-tool catalog. Document that the browser turn route uses NDJSON streaming while `/turn` JSON remains available for compatibility. State that tool summaries exclude hidden reasoning and that Workers rerun the deterministic pipeline before persistence.

- [ ] **Step 2: Run the complete automated verification suite with Node 22**

Run:

```bash
npm test
npx tsc --noEmit
npx tsc -p agent/tsconfig.json
npm run lint
npm run build
git diff --check
```

Expected: every command exits 0. Record the exact failing command and output before making any additional correction.

- [ ] **Step 3: Exercise a real local Agent turn**

Start `npm run dev:all` with a valid local `.dev.vars`. Create one complete activity and one incomplete activity. Verify:

```text
[ ] Live tool card appears immediately
[ ] Every completed row corresponds to a server event
[ ] Tool names, summaries, ordering, and durations are plausible
[ ] Completed card persists after reload and defaults to collapsed
[ ] Missing information produces warning, not a fake success
[ ] Confirmation calls generate_ics1811_sheet only after the latest valid readback
[ ] Retry after an Agent error does not duplicate versions
```

If no API key is available, use the existing fake Agent integration path to verify the same event sequence and explicitly report that live-model verification remains unavailable.

- [ ] **Step 4: Perform responsive visual QA**

Inspect these exact states and sizes:

1. 1440×900 home and active conversation: three-column layout, tool card dominant, right draft readable.
2. 1024×768 conversation: draft opens as a drawer, no horizontal page scroll.
3. 390×844 home, question card, tool card, readback, and filled result: touch targets ≥44px and composer remains usable.
4. Reduced-motion mode: no pulse/bounce loop; state remains understandable.
5. Keyboard-only pass: new activity, session navigation, composer, tool disclosure, tabs, confirm, and draft drawer all receive visible focus.

- [ ] **Step 5: Inspect the final diff for scope and user-change safety**

Run:

```bash
git status --short
git diff --stat
git diff --check
git diff --cached
```

Confirm every changed line traces to the approved spec. Do not delete `.superpowers/` mockup files or any pre-existing untracked file without explicit permission; leave them uncommitted.

- [ ] **Step 6: Commit documentation and any isolated QA fixes**

```bash
git add README.md CLAUDE.md
git diff --cached --check
git commit -m "docs: describe light ai tool workspace"
```

Stage a Task 8 QA fix only by running `git add -p` against its exact file after reviewing that file's diff; if a hunk overlaps a pre-existing edit, leave it unstaged rather than broadening the commit.
