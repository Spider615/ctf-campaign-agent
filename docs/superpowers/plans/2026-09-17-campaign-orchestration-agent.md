# Campaign Orchestration Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the demo from a single ICS-1811 form assistant into a campaign-orchestration Agent with a parent Brief, dynamic execution tracks, launch-readiness gates, an optional ICS-1811 child flow, and a richer communication plan.

**Architecture:** Persist a new `campaign/v1` parent document in the existing JSON column and keep `Ics1811Draft` unchanged as one optional leaf. Pure domain functions own quote-guarded Brief writes, deterministic multi-track routing, child evaluation, communication rendering, and readiness aggregation. The Agent receives only controlled parent context plus the optional child; its tools can update Brief/communication or the child, while Workers merge the result and preserve parent identity. `Snapshot.workspace` is the only UI source for campaign stage, tracks, gates, and artifacts. This batch deliberately defers multiple 1811 children and writable human approval gates.

**Tech Stack:** TypeScript 5.9, Node.js `>=22.13`, Node test runner, React 19, vinext, Claude Agent SDK `0.3.272`, local Agent Skills

---

**Spec:** `docs/superpowers/specs/2026-09-17-campaign-orchestration-agent-design.md`

## Global constraints

- Use `/Users/jerry/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin` first in `PATH`; the system Node 18 cannot run `--experimental-strip-types`.
- Follow RED → GREEN → REFACTOR for every task. Record the focused failing command before production edits.
- Preserve `Ics1811Draft`, its fact guards, parsers, codebook, derivation, checks, and existing tests as the leaf implementation.
- Do not infer fixed OA, finance, legal, inventory, material, or store-training approval chains. Unknown external work is `needs_confirmation`.
- Do not create fake Agent steps, delays, approvals, publications, or production writes.
- Skill prose may only state repository-sourced rules; every rule must end in a valid `[S#]` marker and pass the strict catalog validator.
- Keep the generic system prompt generic. Machine tool contracts may remain in the generated user prompt.
- Preserve streaming, message timestamps, text selection/copy, undo/rollback, and optimistic seq conflict handling.
- Do not change the D1 table schema. JSON payload formats may gain backward-compatible tagged wrappers.
- Use `apply_patch` for edits, run `git diff --check` before every commit, and stage only task-owned files.

### Task 1: Introduce the parent campaign domain and deterministic workspace

**Files:**
- Create: `app/lib/campaign/types.ts`
- Create: `app/lib/campaign/brief.ts`
- Create: `app/lib/campaign/workspace.ts`
- Create: `tests/campaign-workspace.test.ts`

- [ ] Add failing tests that normalize the same legacy `ics1811/v1` document into one stable `campaign/v1` parent/task without changing the child.
- [ ] Add failing routing tests: pure brand launch → `brand_launch` and no 1811 child; pure member request → `member_crm` and no child; “新品发布 + 9 折” → both `brand_launch` and `transaction_offer` with one child; vague request → `needs_confirmation`.
- [ ] Add failing quote-guard tests for name, objective, audience, theme, channels, timing, and scope; values whose quote is not a substring of the current user message must be dropped.
- [ ] Add failing workspace tests proving a ready child yields `ics1811.sheet_ready` but does not make the campaign launch-ready while required manual gates remain.
- [ ] Run `node --test --experimental-strip-types tests/campaign-workspace.test.ts` and confirm the missing modules/behaviors fail.
- [ ] Implement `CampaignDraft`, `CampaignBrief`, track/channel/gate/artifact types, legacy normalization, deterministic optional-child creation, and guarded Brief writes. Derive routing every round; do not persist it.
- [ ] Implement `buildCampaignWorkspace` by reusing `deriveFill`, `checkDraft`, and `planNext`; do not copy 1811 facts into the parent.
- [ ] Re-run the focused test and `npx tsc --noEmit`.
- [ ] Commit: `feat: add campaign parent workspace`

### Task 2: Persist and expose campaign documents without a database migration

**Files:**
- Modify: `app/lib/server/request-validation.ts`
- Modify: `app/lib/server/session-store.ts`
- Modify: `app/lib/server/turns.ts`
- Modify: `tests/server-boundaries.test.ts`
- Modify: `tests/session-store.test.ts`
- Modify: `tests/conversation.test.ts`

- [ ] Add failing validation tests for valid legacy/new documents and an invalid optional child document.
- [ ] Add failing store tests showing legacy JSON loads as a stable campaign parent and a new campaign version round-trips in the same `brief_json` column.
- [ ] Add failing conversation tests showing a brand-only session has no 1811 child, no `out_of_scope` refusal, and no fill-sheet message; preserve the existing example conversation and values.
- [ ] Run the three focused test files and confirm failures before implementation.
- [ ] Change store-facing version types to `CampaignDraft`; normalize legacy documents at the storage boundary and keep pre-1811 legacy data rejected.
- [ ] Add `campaign` and `workspace` to `Snapshot`; make active `draft`, `fill`, and `sheet` nullable while keeping the transaction path backward compatible.
- [ ] Update `createSession`, `evaluate`, title/status logic, undo/rollback, and commit payloads to operate on the parent and optional child.
- [ ] Keep the existing single-child message flow unchanged; verify legacy/new mixed version histories are adapted per version and do not become 410.
- [ ] Re-run focused tests, `npx tsc --noEmit`, and `git diff --check`.
- [ ] Commit: `refactor: persist campaign parent documents`

### Task 3: Add the orchestration Skill and dynamic Skill routing

**Files:**
- Create: `agent/plugin/skills/campaign-orchestrator/SKILL.md`
- Modify: `agent/plugin/skills/campaign-sop/SKILL.md`
- Modify: `agent/plugin/skills/promo-copy-guide/SKILL.md`
- Modify: `agent/skills.ts`
- Modify: `tests/skills.test.ts`

- [ ] Add failing catalog and pressure tests for the new baseline Skill, source markers, exact six-section contract, and a generic activity turn that should not load the 1811 SOP.
- [ ] Add failing routing tests: every model turn starts with `campaign-orchestrator`; transaction context adds `campaign-sop`; offer/settlement/field/promo specialists remain additive and deterministic.
- [ ] Run `node --test --experimental-strip-types tests/skills.test.ts` and confirm the old five-Skill/baseline expectations fail.
- [ ] Write `campaign-orchestrator/SKILL.md` from the approved design and existing runtime sources only: parent Brief, multi-track routing, dynamic execution, honest manual gates, and child-artifact semantics.
- [ ] Narrow `campaign-sop` language from “whole activity complete” to the ICS-1811 subflow and update `promo-copy-guide` for a multi-channel communication plan.
- [ ] Update `requiredSkillsForTurn` to accept campaign context and enforce baseline-orchestrator plus conditional 1811/specialist routing.
- [ ] Re-run the focused tests and catalog smoke validation.
- [ ] Commit: `feat: add campaign orchestration skills`

### Task 4: Extend Agent protocol and tools for parent Brief analysis

**Files:**
- Modify: `app/lib/tool-trace.ts`
- Modify: `app/lib/agent/protocol.ts`
- Modify: `app/lib/agent/tools.ts`
- Modify: `app/lib/agent/prompt.ts`
- Modify: `agent/run-turn.ts`
- Modify: `tests/agent-tools.test.ts`
- Modify: `tests/agent-run-turn.test.ts`
- Modify: `tests/conversation.test.ts`

- [ ] Add failing tests for `update_campaign_brief` and `analyze_campaign_plan`, including quote rejection, channel parsing, no-child analysis, and no mutation on rejection.
- [ ] Add failing gate tests: no campaign business tool before `campaign-orchestrator`; 1811 tools also require `campaign-sop`; communication drafting also requires `promo-copy-guide`.
- [ ] Add failing protocol tests showing parent context and an optional child round-trip, while the parent id cannot be returned as a model edit. Carry `campaignStage` and nullable `ics1811Phase` separately.
- [ ] Run focused tests and confirm failures.
- [ ] Extend `AgentState` with mutable Brief/communication plus an optional child; keep existing 1811 tool implementations behind a child-required helper.
- [ ] Register both new SDK MCP tools with zod and extend the prompt’s machine contract/current-state summary without adding CTF workflow back to the generic system prompt.
- [ ] Merge only tool-produced Brief/communication/child fields in Workers and supplement overall plan analysis when the model omits it.
- [ ] Update trace titles and summaries so the user can distinguish overall campaign analysis from 1811 analysis.
- [ ] Re-run focused tests and `npx tsc -p agent/tsconfig.json`.
- [ ] Commit: `feat: orchestrate campaign brief through harness`

### Task 5: Upgrade promotional copy into a guarded communication plan

**Files:**
- Create: `app/lib/campaign/communication.ts`
- Modify: `app/lib/campaign/types.ts`
- Modify: `app/lib/agent/tools.ts`
- Modify: `agent/run-turn.ts`
- Modify: `tests/promo.test.ts`
- Modify: `tests/agent-tools.test.ts`
- Modify: `tests/conversation.test.ts`

- [ ] Add failing tests for the generation gate: objective, audience, theme, and one confirmed channel are required; transaction campaigns additionally require their hard offer/date/scope facts.
- [ ] Add failing rendering tests for concept, core message, per-channel output, visual direction, deterministic audience/theme/date/store/offer facts, and `needs_review` status.
- [ ] Add failing guard tests for an unconfirmed channel, invented number/right, invented audience, and unconfirmed slogan.
- [ ] Run focused tests and confirm the current headline/highlights-only promo fails.
- [ ] Replace the model input contract with concept, channel outputs, CTA, and visual direction while retaining length, entitlement, numeric, and plain-text guards.
- [ ] Render `CommunicationPlan` from parent creative plus deterministic parent/1811 facts; support old leaf promo as read-only legacy content until regenerated.
- [ ] Ensure promo requests with missing Brief produce explicit missing fields instead of a generic or empty draft.
- [ ] Re-run focused tests, both TypeScript checks, and `git diff --check`.
- [ ] Commit: `feat: generate channel-ready communication plans`

### Task 6: Replace the 1811 side panel with the campaign workspace

**Files:**
- Modify: `app/components/app-shell.tsx`
- Modify: `app/components/chat/conversation.tsx`
- Modify: `app/components/chat/message-view.tsx`
- Modify: `app/components/draft/draft-panel.tsx`
- Modify: `app/components/draft/fill-sheet-view.tsx`
- Create: `app/components/draft/brief-view.tsx`
- Create: `app/components/draft/execution-track-view.tsx`
- Create: `app/components/draft/readiness-view.tsx`
- Create: `app/components/draft/communications-view.tsx`
- Create: `app/components/draft/ics1811-view.tsx`
- Modify: `app/lib/client/promo-cta.ts`
- Modify: `tests/promo-cta.test.ts`
- Modify: `tests/message-text.test.ts`

- [ ] Add failing pure view-model tests for campaign stage labels, default `brief` tab, persistent `generate | view | continue | disabled` communication action, and the absence of “活动建好了”.
- [ ] Run focused UI-helper tests and confirm old 1811-only semantics fail.
- [ ] Change brand/sidebar/header/button copy to “营销活动 AI 工作台”, campaign stage, and “活动工作台”; map legacy `confirmed` to “1811 已就绪”.
- [ ] Build the five top-level tabs `Brief / 执行 / 上线检查 / 传播方案 / 1811`; drive all status from `Snapshot.workspace`.
- [ ] Move existing sheet/edit/TBC/check/version UI under the 1811 view; handle `not_applicable` without rendering an empty form.
- [ ] Render dynamic track cards and readiness gates with status, basis, next action, responsible role, and explicit demo/manual boundaries.
- [ ] Render the full communication plan and keep its action visible after generation; route generation/improvement through the existing streaming text turn and auto-open the communications tab only after a plan is returned.
- [ ] Replace message and sheet banners with “1811 填写值已准备/已同步更新” and “是否可上线请以上线检查为准”.
- [ ] Re-run focused tests and `npx tsc --noEmit`.
- [ ] Commit: `feat: present campaign orchestration workspace`

### Task 7: Verify regressions, runtime truthfulness, and documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `agent/skill-smoke.ts`
- Modify: relevant tests only if verification exposes a real missing contract

- [ ] Update architecture docs for `campaign/v1`, optional 1811 child, baseline `campaign-orchestrator`, conditional `campaign-sop`, workspace stages, and communication-plan semantics.
- [ ] Update live smoke expectations to prove `campaign-orchestrator` loads before the first business tool and the 1811 SOP only appears for transaction work.
- [ ] Run `npm test` with the bundled Node runtime.
- [ ] Run `npx tsc --noEmit` and `npx tsc -p agent/tsconfig.json`.
- [ ] Run `npm run lint` and `npm run build`.
- [ ] Run `git diff --check`, inspect `git status --short`, and review the full commit range for unrelated changes.
- [ ] If a valid key is configured, run `npm run test:skills:live`; otherwise state that this optional live check was not run.
- [ ] Perform wide/mobile manual smoke: brand-only, complete transaction offer, integrated member offer, missing-Brief communication request, successful streamed communication generation, text selection/copy, timestamps, undo, and version restore.
- [ ] Commit: `docs: explain campaign orchestration runtime`
