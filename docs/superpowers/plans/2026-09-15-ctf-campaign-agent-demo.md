# 周大福营销活动生成 Agent Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a polished, working web demo that turns one natural-language campaign request into a reviewed campaign brief and deterministic ICS order drafts, then supports patch-based edits and rollback.

**Architecture:** A Vinext/React working surface runs on a Cloudflare-compatible Worker. Pure TypeScript domain modules own splitting, validation, patching, and demo seeds; a small server route owns DeepSeek calls; D1 stores sessions, messages, immutable versions, patches, and store constants. The hosted Worker/D1 adapter replaces the Fastify/better-sqlite3 deployment boundary from the design document while preserving its SQLite data model and behavior.

**Tech Stack:** TypeScript, React 19, Vinext, Tailwind CSS, Cloudflare Workers, D1/Drizzle, Node test runner, DeepSeek OpenAI-compatible API (`deepseek-flash`)

**Spec:** `docs/superpowers/specs/2026-09-15-ctf-campaign-agent-design.md`

## Global Constraints

- Never call or submit to a Chow Tai Fook production system.
- Never generate an import-ready 1816 Excel file.
- Never invent internal code-table values; unresolved values use `pending` provenance and display the source/vintage warning.
- AI provenance is allowed only for copy fields such as campaign names, content, claims, and talking points.
- Offer values come only from explicit user input, never from historical campaigns.
- The ICS order count is a deterministic product of batches, markets, channels, scope units, and offer tiers.
- `customerAction = "只看到"` disables the offer section and produces zero ICS orders.
- The DeepSeek API key remains server-only and is never committed or returned to the browser.
- The model identifier is `deepseek-flash`, which DeepSeek currently routes to DeepSeek-V4.1-Flash.
- Main body text is at least 16px; regular control labels are at least 14px; desktop and mobile must not overflow horizontally.

---

### Task 1: Site foundation and domain contracts

**Files:**
- Create: `site/` from the bundled Vinext starter
- Create: `site/app/lib/campaign/types.ts`
- Create: `site/app/lib/campaign/demo-seeds.ts`
- Create: `site/tests/domain-contracts.test.ts`
- Modify: `site/package.json`
- Modify: `site/.openai/hosting.json`

**Interfaces:**
- Produces: `CampaignDraft`, `CampaignBrief`, `IcsOrderDraft`, `FieldValue<T>`, `PatchOperation`, `DraftVersion`, `ValidationIssue`
- Produces: `createMotherDaySeed(): CampaignDraft` and `createVisibilityOnlySeed(): CampaignDraft`

- [ ] **Step 1: Initialize the Sites-compatible project and install its locked dependencies**

Run the Sites profile configurator, starter setup, and dependency installer from `site/`. Keep the starter lockfile and scripts.

- [ ] **Step 2: Write the failing contract test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createMotherDaySeed } from "../app/lib/campaign/demo-seeds.ts";

test("seed keeps value provenance and evidence metadata", () => {
  const draft = createMotherDaySeed();
  assert.equal(draft.intent.occasion.value, "日历节点");
  assert.equal(draft.intent.occasion.provenance, "user");
  assert.equal(draft.scope.channels.vintage?.year, 2021);
});
```

- [ ] **Step 3: Run the test and verify the missing module failure**

Run: `npm test -- tests/domain-contracts.test.ts`

Expected: FAIL because `demo-seeds.ts` does not exist.

- [ ] **Step 4: Add focused domain types and realistic seeds**

Define `FieldValue<T>` with `value`, `provenance`, and optional `vintage`; model intent, audience, products, offer tiers, scope, schedule, metrics, and operational constants as separate objects. Seed a complete Mother’s Day East China discount campaign and a visibility-only brand campaign.

- [ ] **Step 5: Run the contract test**

Run: `npm test -- tests/domain-contracts.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the foundation**

```bash
git add site
git commit -m "feat: scaffold campaign agent site"
```

---

### Task 2: Deterministic split count and 17-rule validator

**Files:**
- Create: `site/app/lib/campaign/split-orders.ts`
- Create: `site/app/lib/campaign/validator.ts`
- Create: `site/tests/split-orders.test.ts`
- Create: `site/tests/validator.test.ts`

**Interfaces:**
- Consumes: `CampaignDraft`, `IcsOrderDraft`, `ValidationIssue`
- Produces: `calculateOrderCount(draft: CampaignDraft): SplitSummary`
- Produces: `buildIcsDrafts(draft: CampaignDraft): IcsOrderDraft[]`
- Produces: `validateDraft(draft: CampaignDraft, orders: IcsOrderDraft[]): ValidationIssue[]`

- [ ] **Step 1: Write failing split-count tests**

```ts
test("count is batches × markets × channels × scope units × offer tiers", () => {
  const draft = createMotherDaySeed();
  draft.schedule.batches = [draft.schedule.batches[0], { ...draft.schedule.batches[0], id: "b2" }];
  draft.scope.markets.value = ["内地", "港澳"];
  draft.scope.channels.value = ["线下", "线上"];
  draft.offer.tiers = [draft.offer.tiers[0], { ...draft.offer.tiers[0], id: "t2" }];
  assert.equal(calculateOrderCount(draft).total, 16);
});

test("visibility-only campaign produces no ICS orders", () => {
  assert.equal(calculateOrderCount(createVisibilityOnlySeed()).total, 0);
});
```

- [ ] **Step 2: Run split tests and verify failure**

Run: `npm test -- tests/split-orders.test.ts`

Expected: FAIL because `calculateOrderCount` is missing.

- [ ] **Step 3: Implement split calculation and order expansion**

Use only explicit arrays from the draft. Treat a non-store scope as one scope unit. Return the factor labels with the total so the UI can explain the arithmetic.

- [ ] **Step 4: Write failing validator tests for the high-risk rules**

Cover end-date required, discount/amount unit separation, explicit concession and collection rates, mutually exclusive geographic scope, assigned-item master switch, product-scope conversion, and `customerAction = "只看到"`.

- [ ] **Step 5: Implement all 17 rules with stable IDs**

Each issue has `ruleId`, `severity`, `path`, `message`, and optional `evidence`. Unknown character-length semantics produce a warning; missing required values and invalid combinations produce blockers.

- [ ] **Step 6: Run deterministic tests**

Run: `npm test -- tests/split-orders.test.ts tests/validator.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit deterministic behavior**

```bash
git add site/app/lib/campaign site/tests
git commit -m "feat: add deterministic ics validation"
```

---

### Task 3: Patch, diff, and rollback engine

**Files:**
- Create: `site/app/lib/campaign/patcher.ts`
- Create: `site/tests/patcher.test.ts`

**Interfaces:**
- Consumes: `CampaignDraft`, `PatchOperation`, `DraftVersion`
- Produces: `applyPatch(draft: CampaignDraft, ops: PatchOperation[]): CampaignDraft`
- Produces: `diffDrafts(before: CampaignDraft, after: CampaignDraft): FieldDiff[]`
- Produces: `rollbackTo(versions: DraftVersion[], seq: number): DraftVersion`

- [ ] **Step 1: Write failing patch isolation tests**

```ts
test("changing the discount does not rename the campaign", () => {
  const before = createMotherDaySeed();
  const after = applyPatch(before, [{ op: "replace", path: "/offer/tiers/0/discountRate", value: 0.82, reason: "用户改为8.2折", provenance: "user" }]);
  assert.equal(after.offer.tiers[0].discountRate, 0.82);
  assert.equal(after.brief.externalName, before.brief.externalName);
  assert.equal(diffDrafts(before, after).length, 1);
});
```

- [ ] **Step 2: Run the patch test and verify failure**

Run: `npm test -- tests/patcher.test.ts`

Expected: FAIL because the patcher module is missing.

- [ ] **Step 3: Implement a path-whitelisted immutable patcher**

Support `add`, `replace`, and `remove`; reject prototype keys, unknown roots, and out-of-range array paths. Generate field-level before/after values for the diff drawer.

- [ ] **Step 4: Run patch tests**

Run: `npm test -- tests/patcher.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit version behavior**

```bash
git add site/app/lib/campaign/patcher.ts site/tests/patcher.test.ts
git commit -m "feat: add patch and rollback engine"
```

---

### Task 4: D1 persistence and session API

**Files:**
- Modify: `site/db/schema.ts`
- Modify: `site/db/index.ts`
- Create: `site/app/lib/server/session-repository.ts`
- Create: `site/app/api/sessions/route.ts`
- Create: `site/app/api/sessions/[id]/route.ts`
- Create: `site/app/api/sessions/[id]/versions/route.ts`
- Create: `site/drizzle/0000_campaign_agent.sql`
- Modify: `site/cloudflare-env.d.ts`
- Modify: `site/.openai/hosting.json`

**Interfaces:**
- Produces: `listSessions(): Promise<SessionSummary[]>`
- Produces: `getSession(id: string): Promise<SessionDetail | null>`
- Produces: `createSession(input: CreateSessionInput): Promise<SessionDetail>`
- Produces: `appendVersion(input: AppendVersionInput): Promise<DraftVersion>`
- Produces: HTTP `GET/POST /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions/:id/versions`

- [ ] **Step 1: Define the schema and indexes**

Create the six tables from the spec. Add indexes for session recency, messages by session/time, versions by session/sequence, patches by session/time, and a unique compound index on store code plus business category.

- [ ] **Step 2: Generate and inspect the D1 migration**

Run: `npm run db:generate`

Expected: one schema-only SQL migration with complete statements and no seed data.

- [ ] **Step 3: Implement prepared-statement repository methods**

Keep binding access inside `db/index.ts`. Use separate prepared statements and `batch()` for operations that create a message, patch, and immutable version together.

- [ ] **Step 4: Implement explicit API error responses**

Return `400` for invalid request data, `404` for missing sessions, and `503` for unavailable storage. Never discard the client draft on a failed save.

- [ ] **Step 5: Build and apply the migration locally**

Run the Sites build, then apply the generated migration to the local D1 binding using Wrangler and the generated Worker configuration.

- [ ] **Step 6: Commit persistence**

```bash
git add site/db site/app/lib/server site/app/api site/drizzle site/cloudflare-env.d.ts site/.openai/hosting.json
git commit -m "feat: persist campaign sessions"
```

---

### Task 5: DeepSeek interpretation, generation, and patch routes

**Files:**
- Create: `site/app/lib/server/deepseek.ts`
- Create: `site/app/lib/server/prompts.ts`
- Create: `site/app/lib/server/ai-schemas.ts`
- Create: `site/app/api/agent/interpret/route.ts`
- Create: `site/app/api/agent/generate/route.ts`
- Create: `site/app/api/agent/patch/route.ts`
- Create: `site/tests/ai-schemas.test.ts`
- Create: `site/.env.example`

**Interfaces:**
- Produces: `interpretCampaign(text: string): Promise<InterpretationResult>`
- Produces: `generateBrief(draft: CampaignDraft): Promise<GeneratedCopy>`
- Produces: `proposePatch(draft: CampaignDraft, instruction: string): Promise<PatchOperation[]>`
- Produces: HTTP `POST /api/agent/interpret`, `/generate`, and `/patch`

- [ ] **Step 1: Write failing schema-boundary tests**

Test that AI output containing an internal code-table path is rejected, offer numbers absent from user input are rejected, and malformed JSON returns a typed model error.

- [ ] **Step 2: Implement the DeepSeek server client**

Call `https://api.deepseek.com/chat/completions` with `model: "deepseek-flash"` and `response_format: { type: "json_object" }`. Read `DEEPSEEK_API_KEY` only on the server. Add a bounded timeout and surface upstream status without returning credentials or prompts.

- [ ] **Step 3: Implement the three prompts and output parsers**

The interpreter may prefill intent, audience, products, scope, schedule, and explicit offer values found in user text. The generator may only author copy fields. The patch route emits field-level operations and runs deterministic validation; retry a failed correction at most twice.

- [ ] **Step 4: Add a recoverable demo fallback**

If the model is unavailable, keep the typed user input and present a retry action. Do not silently substitute fabricated AI output. The built-in example remains usable without the model.

- [ ] **Step 5: Run boundary tests and a server-side smoke call**

Run: `npm test -- tests/ai-schemas.test.ts`

Expected: PASS. Then call the local interpret endpoint with the Mother’s Day sentence and confirm the response contains structured fields but no secret.

- [ ] **Step 6: Commit AI integration without the secret file**

```bash
git add site/app/lib/server site/app/api/agent site/tests/ai-schemas.test.ts site/.env.example
git commit -m "feat: integrate deepseek campaign generation"
```

---

### Task 6: First viewport and guided review flow

**Files:**
- Modify: `site/app/page.tsx`
- Modify: `site/app/globals.css`
- Modify: `site/app/layout.tsx`
- Modify: `site/public/favicon.svg`
- Create: `site/app/components/campaign-agent.tsx`
- Create: `site/app/components/start-panel.tsx`
- Create: `site/app/components/prompt-composer.tsx`
- Create: `site/app/components/review-form.tsx`
- Create: `site/app/components/field-source.tsx`

**Interfaces:**
- Consumes: `/api/agent/interpret`, campaign domain types, demo seeds
- Produces: a single-page flow with states `start | interpreting | review | generating | result`

- [ ] **Step 1: Establish the visual thesis**

Use a precise modern jewelry-operations look: deep burgundy navigation rail, warm white working canvas, restrained gold accents, fine grid lines, squared cards with modest rounding, and generous but dense Chinese typography. No stock jewelry photography or decorative hero.

- [ ] **Step 2: Build the bounded first product slice**

Show the four entry choices, the natural-language composer, a realistic recent-activity list, and the campaign workspace silhouette in the first viewport. Make “新建活动” the primary path and “从示例开始” immediately usable.

- [ ] **Step 3: Start the retained development preview and hand off the first meaningful slice**

Require a successful local response and compilation before opening the preview. Keep the same preview running for later edits.

- [ ] **Step 4: Add the AI understanding review**

After interpretation, show compact field groups for occasion, customer action, audience, products, offer, range, schedule, metric, and operational constants. AI-filled fields carry an “AI 理解” marker; explicit user values carry “你提供的”; defaults show their vintage; required gaps use a visible amber treatment.

- [ ] **Step 5: Add deterministic live order arithmetic**

Keep the split formula visible in the review header and update it immediately when batches, markets, channels, store rows, or offer tiers change.

- [ ] **Step 6: Add responsive and accessible behavior**

On narrow screens, collapse the rail into a header, stack the workspace panels, preserve 44px touch targets, and keep all form labels associated with controls. Confirm keyboard focus is visible.

- [ ] **Step 7: Commit the guided flow**

```bash
git add site/app site/public/favicon.svg
git commit -m "feat: build guided campaign workspace"
```

---

### Task 7: Results, ICS checklist, conversation edits, and rollback

**Files:**
- Create: `site/app/components/result-workspace.tsx`
- Create: `site/app/components/campaign-brief.tsx`
- Create: `site/app/components/ics-order-list.tsx`
- Create: `site/app/components/validation-panel.tsx`
- Create: `site/app/components/patch-composer.tsx`
- Create: `site/app/components/version-drawer.tsx`
- Modify: `site/app/components/campaign-agent.tsx`

**Interfaces:**
- Consumes: `/api/agent/generate`, `/api/agent/patch`, `/api/sessions`, deterministic domain modules
- Produces: campaign brief, ICS filling checklist, pending selections, validation state, field diff, and rollback controls

- [ ] **Step 1: Render the direct result summary**

Open with the exact deterministic count, its multiplication factors, complete versus blocked order counts, and the first missing fields. For visibility-only campaigns, replace all offer and ICS UI with the explicit zero-order explanation.

- [ ] **Step 2: Render the campaign brief and ICS orders**

Provide tabs for 活动方案, ICS 开单清单, 待界面选择, and 校验结果. Each non-empty enum shows vintage/source metadata. `null`, empty arrays, and empty objects remain visible as unfilled values.

- [ ] **Step 3: Wire conversational patches**

Send only the current draft plus the change instruction. Preview the exact changed paths and before/after values; let the user apply or cancel. On validation failure, show the rule number and path.

- [ ] **Step 4: Wire manual changes through the same version path**

Manual form edits create human-source patches and immutable versions. The version drawer shows sequence, source, reason, and changed fields, with rollback creating a new version rather than mutating history.

- [ ] **Step 5: Add export-safe actions**

Allow copying the 1811 field checklist and downloading a JSON evidence package. Label the 1816 table “仅供核对，不可上传”. Do not produce XLS/XLSX.

- [ ] **Step 6: Commit the result workspace**

```bash
git add site/app/components
git commit -m "feat: add ics results and version history"
```

---

### Task 8: WebMCP, verification, and publishing

**Files:**
- Create: `site/app/lib/webmcp.ts`
- Modify: `site/app/components/campaign-agent.tsx`
- Modify: `site/README.md`

**Interfaces:**
- Produces WebMCP tools: `start_campaign_draft`, `update_campaign_fields`, `read_campaign_summary`

- [ ] **Step 1: Register WebMCP tools against visible UI actions**

`start_campaign_draft` enters the same prompt and review state as the composer. `update_campaign_fields` stages validated fields without bypassing review. `read_campaign_summary` is read-only and returns the current deterministic order count and blocker list.

- [ ] **Step 2: Run the full deterministic test suite**

Run: `npm test`

Expected: all contract, split, validator, patcher, and AI boundary tests pass.

- [ ] **Step 3: Run the production build**

Run the Sites build wrapper and confirm the Worker entrypoint exports a callable default `fetch` handler. Inspect the generated migration before packaging.

- [ ] **Step 4: Perform UI QA**

Check the new-campaign path, example path, visibility-only path, mobile viewport, AI error state, validation blocker, conversational patch diff, and rollback. Confirm no horizontal overflow, no clipped text, and no browser console errors.

- [ ] **Step 5: Confirm secret hygiene**

Search tracked files and build output for the API key prefix and `DEEPSEEK_API_KEY` value. Verify `.env*` remains ignored while `.env.example` contains only an empty placeholder.

- [ ] **Step 6: Save and deploy the Site**

Save a new private Site version, attach the D1 migration and server-side DeepSeek secret through the hosting platform, deploy it, and verify the terminal deployment state reports success.

- [ ] **Step 7: Final commit**

```bash
git add site
git commit -m "feat: finish campaign agent demo"
```

