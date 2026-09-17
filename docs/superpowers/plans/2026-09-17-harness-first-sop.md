# Harness-first Campaign SOP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every model-backed campaign turn load a source-backed `campaign-sop` Skill before any campaign tool, and reduce the system prompt to a reusable marketing-Agent contract.

**Architecture:** `agent/skills.ts` owns the deterministic minimum Skill set, while `agent/run-turn.ts` enforces a pre-tool gate inside the SDK MCP handler and retains the existing post-turn validation. `campaign-sop/SKILL.md` contains only repository-sourced workflow guidance; TypeScript remains authoritative for facts, values, gaps, validation, and persistence.

**Tech Stack:** TypeScript 5.9, Node.js `>=22.13`, Node test runner, Claude Agent SDK `0.3.272`, local Claude plugin/Agent Skills

---

**Spec:** `docs/superpowers/specs/2026-09-17-harness-first-campaign-agent-design.md` §§3–6, 13–14

## Global constraints

- Preserve the user's existing uncommitted `app/lib/agent/prompt.ts` Q5c wording while refactoring that file.
- Follow RED → GREEN → REFACTOR for each task; do not add production behavior before observing the focused test fail.
- Skill prose may only restate rules already present in the repository and every rule must carry a valid `[S#]` source marker.
- Do not move `FactKey`, parsing, proposal eligibility, question planning, code tables, validation, or write guards out of TypeScript.
- `edit`, `dismiss`, `undo`, and `rollback` remain deterministic and must not emit fake Skill traces.
- Stage and commit only task-owned files; run `git diff --check` before each commit.

### Task 1: Route every model turn through the baseline SOP

**Files:**
- Modify: `tests/skills.test.ts`
- Modify: `agent/skills.ts`
- Modify: `agent/skill-smoke.ts`

- [ ] Add failing table tests asserting plain facts, short replies, field changes, explanations, settlement questions, and promo requests all start with `campaign-sop`; specialists follow it in deterministic order.
- [ ] Add a failing test proving two consecutive model turns each start with an empty loaded set and must reload `campaign-sop`.
- [ ] Run `node --test --experimental-strip-types tests/skills.test.ts` and confirm the old empty-set expectation fails.
- [ ] Add `campaign-sop` to `BASELINE_SKILL_NAMES` and initialize every model-backed required set with it, preserving specialist routing.
- [ ] Update the real-SDK smoke expectation from “plain facts load no Skill” to “plain facts load `campaign-sop` before the first campaign tool.”
- [ ] Re-run the focused test and `npx tsc -p agent/tsconfig.json`.
- [ ] Commit: `feat: require campaign sop on model turns`

### Task 2: Author and validate the source-backed `campaign-sop` Skill

**Files:**
- Create: `agent/plugin/skills/campaign-sop/SKILL.md`
- Modify: `tests/skills.test.ts`

- [ ] Add a failing catalog test for five baseline Skills and a source-validation test for `campaign-sop`.
- [ ] Add failing content-contract assertions for the approved six H2 sections and for workflow rules: extract explicit facts, analyze, ask only returned gaps, at most two question rounds, never default human-decided fields, refresh fill values after changes, and offer—but never auto-run—promo copy after completion.
- [ ] Run `node --test --experimental-strip-types tests/skills.test.ts` and confirm failure because the Skill is absent.
- [ ] Create the Skill with frontmatter name `campaign-sop`, a routing description that exactly matches its first `适用场景` bullet, and H2 sections `适用场景` / `回答原则` / `业务知识` / `不能做什么` / `冲突处理` / `出处`.
- [ ] Cite only `docs/superpowers/specs/2026-09-16-ics1811-sop-agent-design.md`, `app/lib/server/turns.ts`, and the relevant `app/lib/campaign/ics1811/*.ts` files; do not cite the new design as the origin of a business rule when an implementation source exists.
- [ ] Run the focused test, then scan for untagged bullets with `node --test --experimental-strip-types tests/skills.test.ts`.
- [ ] Commit: `feat: add campaign creation sop skill`

### Task 3: Reject campaign tools until the SOP is truly loaded

**Files:**
- Modify: `tests/skills.test.ts`
- Modify: `tests/agent-tools.test.ts`
- Modify: `agent/skills.ts`
- Modify: `agent/run-turn.ts`

- [ ] Add a failing unit test for a pure gate helper: before `campaign-sop`, every `AGENT_TOOL_NAMES` tool is rejected; after it, normal tools pass; `draft_promo_copy` still requires `promo-copy-guide`.
- [ ] Add a no-mutation regression test using a draft snapshot before and after a rejected tool call.
- [ ] Add a runner event-order test proving the completed native Skill result precedes the first campaign MCP handler execution.
- [ ] Run the focused tests and confirm the handler currently reaches `runAgentTool` without the baseline Skill.
- [ ] Implement the gate in the MCP handler immediately before `runAgentTool`; return a retryable tool error without touching `AgentState`.
- [ ] Keep the post-turn `assertRequiredSkillsLoaded` check so a tool-free response cannot falsely satisfy the turn contract.
- [ ] Run `node --test --experimental-strip-types tests/skills.test.ts tests/agent-tools.test.ts` and `npx tsc -p agent/tsconfig.json`.
- [ ] Commit: `feat: gate campaign tools on sop load`

### Task 4: Make the system prompt generic without weakening contracts

**Files:**
- Modify: `tests/conversation.test.ts`
- Modify: `tests/skills.test.ts`
- Modify: `app/lib/agent/prompt.ts`

- [ ] Add failing assertions that the system prompt contains the generic marketing-Agent identity, per-turn Skill loading, tool authority, privacy, no pre-tool user-facing prose, concise Chinese output, and “only ask gaps returned by tools.”
- [ ] Add failing negative assertions for ICS-1811-specific SOP prose, Q1–Q6 explanations, and the full `FACT_GUIDE` in the system prompt.
- [ ] Confirm the focused tests fail against the existing prompt.
- [ ] Refactor `buildAgentSystemPrompt` to the generic contract; retain machine-readable tool and current-state contracts in `buildAgentUserPrompt` where needed.
- [ ] Preserve the user's Q5c guard semantics in whichever machine contract remains; do not turn “没有” into a model default.
- [ ] Run `node --test --experimental-strip-types tests/conversation.test.ts tests/skills.test.ts`, both TypeScript checks, and `git diff --check`.
- [ ] Commit: `refactor: make marketing agent prompt generic`

### Task 5: Verify the SOP batch and document the runtime contract

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `agent/skill-smoke.ts`

- [ ] Update maintenance docs: every model turn reloads `campaign-sop`; specialist Skills are additive; deterministic turns do not invoke the SDK; Skill changes require Git review, static validation, and live smoke.
- [ ] Run `npm test`, `npx tsc --noEmit`, `npx tsc -p agent/tsconfig.json`, `npm run lint`, and `npm run build`.
- [ ] With a valid key, run `npm run test:skills:live` and verify the trace order `campaign-sop` → optional specialist → first business tool.
- [ ] Review `git diff`, `git diff --check`, and the commit range for accidental edits to the user's pre-existing Q5c change.
- [ ] Commit: `docs: explain baseline campaign sop runtime`
