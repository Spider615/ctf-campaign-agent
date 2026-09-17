# Chat Time, Selection, and Promo Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a timestamp on every message, make all substantive text reliably selectable/copyable, and offer one real Agent-driven promo-copy next step after the activity is first completed.

**Architecture:** Existing `ChatMessage.createdAt` becomes a per-message write contract without a migration. Presentation helpers format Shanghai time and mark text/control selection boundaries. A pure CTA eligibility helper derives the first-completion invitation from message history; clicking sends a normal text turn through the same harness and opens the existing promo tab only after success.

**Tech Stack:** TypeScript 5.9, React 19, Tailwind CSS, D1/in-memory session stores, Node test runner

---

**Spec:** `docs/superpowers/specs/2026-09-17-harness-first-campaign-agent-design.md` §§10–12, 13–14

## Global constraints

- No D1 schema migration: reuse `message.created_at`.
- Every persisted message displays its own time, including trace, change, fill-sheet, and error messages.
- Do not globally disable selection or intercept copy. Controls alone are `select-none`.
- Promo CTA sends the exact normal text intent through the existing turn API; it must not call `draft_promo_copy` directly.
- Example sessions may show the CTA, but clicking it is the first real SDK round.

### Task 1: Persist distinct user-accept and assistant-complete timestamps

**Files:**
- Modify: `tests/session-store.test.ts`
- Modify: `tests/conversation.test.ts`
- Modify: `app/lib/server/session-store.ts`
- Modify: `app/lib/server/turns.ts`

- [ ] Add failing store tests where two messages in one `TurnWrite` carry different `createdAt` values and round-trip unchanged in both memory and D1 SQL bindings.
- [ ] Add failing turn tests asserting the user message uses request-accept time and completion messages use the post-Agent completion time.
- [ ] Run focused tests and confirm stores currently overwrite both with `write.now`.
- [ ] Extend `TurnWrite.messages` with optional/required `createdAt`; use it per message with a compatibility fallback to `write.now` for old test builders.
- [ ] Capture accept and completion times at their real boundaries; keep version/session `updatedAt` at commit completion.
- [ ] Re-run focused tests and both TypeScript checks.
- [ ] Commit: `fix: preserve per-message timestamps`

### Task 2: Format and render time on every message

**Files:**
- Modify: `tests/message-text.test.ts`
- Create or Modify: `app/lib/client/message-time.ts`
- Modify: `app/components/chat/message-view.tsx`

- [ ] Add failing pure formatter tests for same-day `HH:mm`, prior-day `M月D日 HH:mm`, invalid ISO fallback, Asia/Shanghai timezone, full `title`, and accessible label.
- [ ] Add a rendering-contract test proving every message branch includes one semantic `<time>`.
- [ ] Implement the dependency-free formatter with an injectable `now` for stable tests.
- [ ] Render time for user bubbles, assistant text, tool traces, changes, fill sheets, and errors; never suppress repeated minute labels.
- [ ] Run focused tests, frontend TypeScript, and lint.
- [ ] Commit: `feat: show every chat message time`

### Task 3: Harden native selection and copying

**Files:**
- Modify: `app/components/chat/message-view.tsx`
- Modify: `app/components/chat/markdown-text.tsx`
- Modify: `app/components/chat/tool-run-card.tsx`
- Modify: `app/components/chat/tool-step.tsx`
- Modify: `app/components/chat/copy-button.tsx`
- Modify: `app/components/draft/draft-panel.tsx`
- Modify: `app/globals.css` only if a narrowly scoped fallback is necessary
- Modify: `tests/message-text.test.ts`

- [ ] Add failing class/behavior tests for `select-text` on user, assistant, Markdown, fill-sheet, tool title/details, and draft text, plus `select-none` on buttons, icons, badges, time labels, and resize handles.
- [ ] Add a failing helper test: a non-collapsed browser selection prevents `<summary>` toggling; an empty selection preserves normal toggle behavior.
- [ ] Add explicit selection classes and the selection guard without registering document-wide pointer/copy handlers.
- [ ] Keep the existing copy button and ensure it copies full message text independently of native selection.
- [ ] Run focused tests and manually drag-select/copy each acceptance target on wide and narrow layouts.
- [ ] Commit: `fix: make conversation text selectable`

### Task 4: Derive a one-time promo-copy invitation

**Files:**
- Modify: `tests/message-text.test.ts`
- Modify: `app/lib/campaign/ics1811/messages.ts` or create `app/lib/client/promo-cta.ts`
- Modify: `app/components/chat/message-view.tsx`

- [ ] Add failing history-table tests: no fill sheet → hidden; first fill sheet without promo → shown only on that completion message; later fill-sheet refresh → not repeated; any existing promo → hidden; incomplete/blocked activity → hidden.
- [ ] Implement a pure helper that identifies the eligible first `agent_fill_sheet` message from current Snapshot history.
- [ ] Render a secondary action labelled `生成宣传内容` under only that message, disabled while a turn is busy.
- [ ] Re-run focused tests and frontend TypeScript.
- [ ] Commit: `feat: invite promo copy after completion`

### Task 5: Send the CTA through the real Agent turn

**Files:**
- Modify: `tests/conversation.test.ts`
- Modify: `tests/skills.test.ts`
- Modify: `app/components/chat/conversation.tsx`
- Modify: `app/components/app-shell.tsx` or the existing draft-tab controller

- [ ] Add a failing interaction test proving the click sends exactly `请基于当前活动生成一份对外营销宣传内容` as a normal `text` turn with the current `expectedSeq`.
- [ ] Add/retain the routing assertion for `campaign-sop` then `promo-copy-guide`, and the tool assertion for `draft_promo_copy`.
- [ ] Add failure tests: busy disables repeat clicks; failed turn leaves the CTA available; success removes it and requests the existing `promo` tab.
- [ ] Wire the action through the same `submitText` path as typed user input; do not introduce a special backend endpoint.
- [ ] Open the promo tab only after the successful Snapshot contains promo output.
- [ ] Re-run focused tests, both TypeScript checks, and a real-SDK smoke of the CTA path.
- [ ] Commit: `feat: run promo follow-up through harness`

### Task 6: Full regression and browser acceptance

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: relevant tests only for regressions discovered here

- [ ] Run `npm test`, `npx tsc --noEmit`, `npx tsc -p agent/tsconfig.json`, `npm run lint`, and `npm run build`.
- [ ] Restart both page and Agent processes so the non-hot-reloaded Agent code is current.
- [ ] On desktop and narrow viewport, create an activity, verify every message time, select/copy user/assistant/Markdown/tool/draft text, and confirm controls remain clickable.
- [ ] Click the promo CTA; verify the live trace loads `campaign-sop` then `promo-copy-guide`, invokes `draft_promo_copy`, streams the reply, opens the promo tab, and never shows the CTA again.
- [ ] Verify an example session labels deterministic fixture behavior and only starts the real harness after the CTA click.
- [ ] Review `git diff --check`, staged diff, and commit history before declaring completion.
- [ ] Commit: `docs: document chat follow-up experience`
