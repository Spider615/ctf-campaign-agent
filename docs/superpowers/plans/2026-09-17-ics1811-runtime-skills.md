# ICS-1811 Runtime Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the repository's existing, source-backed ICS-1811 explanatory rules into four runtime Skills, load them through the Claude Agent SDK only when needed, and fail closed when a required rule cannot be loaded.

**Architecture:** `agent/plugin/skills/` contains self-contained, reviewed `SKILL.md` files. A dependency-light `agent/skills.ts` validates the catalog on every turn, determines the minimum required Skills, and tracks native Skill tool calls. Side-effect-free `agent/run-turn.ts` supplies the exact SDK whitelist and enforces the turn contract; `agent/server.ts` is only the HTTP/environment adapter. Deterministic TypeScript remains the sole authority for facts, values, validation, and persistence.

**Tech Stack:** TypeScript 5.9, Node.js `>=22.13`, Node test runner, Claude Agent SDK `0.3.272`, Zod 4, local Claude plugin/Agent Skills, existing NDJSON trace contract

---

**Spec:** `docs/superpowers/specs/2026-09-17-ics1811-runtime-skills-design.md`

## Global Constraints

- Read the approved spec before editing. It overrides older docs only where knowledge moves from the prompt into Skills.
- Preserve the current dirty worktree. The existing changes in `agent/server.ts`, `agent/tsconfig.json`, `app/lib/agent/prompt.ts`, `app/lib/tool-trace.ts`, `agent/skills.ts`, and `agent/plugin/` are incomplete scaffolding to finish, not changes to discard.
- Use `apply_patch` for hand edits. Stage only verified task-owned files or isolated hunks; inspect `git diff --cached` before every commit.
- Use Node.js `>=22.13`. If `node --version` is older, stop verification and switch runtimes; do not interpret `bad option: --experimental-strip-types` as a code failure.
- Keep code comments, Skill prose, errors, and tests in Chinese where they are user-facing.
- Do not move executable rules out of `facts.ts`, `phrases.ts`, `offer-spec.ts`, `derive.ts`, `questions.ts`, `checks.ts`, `codebook.ts`, `proposals.ts`, `card.ts`, or `tools.ts`.
- Do not copy code tables into Skills, invent business rules, add external sources, or turn unresolved questions into defaults.
- Keep shared Agent modules compatible with Node strip-types: explicit `.ts` relative imports, no enum/namespace/parameter properties, and no `cloudflare:workers`, DB, browser-only, or root-only npm dependencies.
- The runtime catalog must not need `docs/`, `references/`, or source modules in the deployed Agent artifact. Only the CI/source validator checks referenced files on disk.
- Any Skill load failure fails the current turn. Never fall back to model memory or an abbreviated copy of Skill content in the prompt.
- `draft_promo_copy` remains guarded by deterministic code and additionally requires a successfully loaded `promo-copy-guide` in the same turn.
- Before claiming completion, use `verification-before-completion`; before merging, use `requesting-code-review`.

## File Structure Map

- `agent/plugin/.claude-plugin/plugin.json`: local plugin identity, fixed to `ics1811`.
- `agent/plugin/skills/*/SKILL.md`: four baseline source-backed Skills.
- `agent/skills.ts`: strict catalog, source validation, deterministic routing, load tracking, and turn contract.
- `agent/run-turn.ts`: side-effect-free production Agent runner with per-turn catalog loading, exact SDK configuration, event pairing, and enforcement.
- `agent/server.ts`: HTTP/environment adapter that constructs and calls the production runner.
- `app/lib/agent/prompt.ts`: compact routing and authority contract; no migrated business prose.
- `app/lib/agent/tools.ts`: deterministic promo-copy load gate.
- `app/lib/tool-trace.ts`: accepts `load_campaign_skill` as a trace-only tool.
- `tests/skills.test.ts`: catalog, sources, routing, load-state, and contract tests.
- `tests/agent-tools.test.ts`: promo gate and no-mutation tests.
- `tests/tool-trace.test.ts`: Skill trace compatibility tests.
- `tests/conversation.test.ts`: prompt contract and normal no-Skill flow tests.
- `agent/skill-smoke.ts`: optional real-SDK release smoke test.
- `README.md`, `CLAUDE.md`, `AGENTS.md`: operation, maintenance, and deployment documentation.

### Task 1: Add the four source-backed baseline Skills

**Files:**
- Verify/Modify: `agent/plugin/.claude-plugin/plugin.json`
- Create: `agent/plugin/skills/offer-entry-guide/SKILL.md`
- Create: `agent/plugin/skills/field-explainer/SKILL.md`
- Create: `agent/plugin/skills/settlement-guide/SKILL.md`
- Create: `agent/plugin/skills/promo-copy-guide/SKILL.md`
- Create: `tests/skills.test.ts`

**Content contract:** Every file has only `name` and `description` in frontmatter, one H1, and these exact H2 headings in order: `适用场景`, `回答原则`, `业务知识`, `不能做什么`, `冲突处理`, `出处`. Every list entry in the first five sections ends in one or more `[S#]` tags. The first `适用场景` entry repeats the frontmatter description exactly before its source tags. Each `回答原则` section says that source tags are internal maintenance markers and must not be read to users.

- [ ] **Step 1: Write the failing bundled-catalog smoke test**

Start `tests/skills.test.ts` with the public contract the later loader will implement:

```ts
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadSkillCatalog, validateSkillSources } from "../agent/skills.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_DIR = fileURLToPath(new URL("../agent/plugin", import.meta.url));

test("bundled catalog contains the four source-backed baseline skills", () => {
  const catalog = loadSkillCatalog(PLUGIN_DIR);
  assert.deepEqual(catalog.map((skill) => skill.name), [
    "field-explainer",
    "offer-entry-guide",
    "promo-copy-guide",
    "settlement-guide",
  ]);
  assert.doesNotThrow(() => validateSkillSources(catalog, REPO_ROOT));
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --experimental-strip-types tests/skills.test.ts
```

Expected: FAIL because the strict loader is not implemented and/or the four Skill files do not yet exist.

- [ ] **Step 3: Verify the plugin manifest identity**

Keep the existing version and description unless they are malformed; the runtime contract fixes only the plugin name. Ensure `agent/plugin/.claude-plugin/plugin.json` remains valid JSON with:

```json
{
  "name": "ics1811",
  "version": "0.1.0",
  "description": "周大福 ICS-1811 优惠开单活动的业务规则，按场景由 Agent 加载"
}
```

- [ ] **Step 4: Author `offer-entry-guide` from repository sources only**

Use this exact frontmatter description:

```yaml
name: offer-entry-guide
description: 解释 ICS-1811 优惠玩法、录入方式和不支持场景。用户询问打折、满减、克减、以旧换新、以小换大、固定或浮动折扣模式以及 1811 如何录入时使用。
```

Use H1 `# ICS-1811 优惠玩法与录入指引`.

Cover these source-backed rules without adding parameter tables or code values:

- 1811 handles approval-required sales offers; explain first and let deterministic tools produce actual field values.
- Pure discount uses floating mode only when stores may adjust the base discount; otherwise fixed. A meaning-only question does not authorize choosing for the user.
- Distinguish one-time threshold reduction from repeated threshold reduction, and actual-weight from integer-gram reduction.
- Preserve the documented outlet meal-card distinction.
- Explain platinum trade-in, diamond upgrade, gold trade-in, and buy-diamond/get-gold-reduction, including the documented 1815 post-actions.
- Label demo-inferred parameter positions as subject to the actual page and tool result.
- State that unsupported or insufficiently documented offer types require manual confirmation; never synthesize entry steps.
- Treat non-sales promotions such as pure lucky draws, check-ins, and seminars as out of 1811 scope unless an actual transaction offer is also present.
- Tell the user to verify the created detail and upload success; do not claim that OA approval started automatically.
- Tool/code results win on conflict.

Define and use these repository sources in `出处`:

```markdown
- [S1] `docs/superpowers/specs/2026-09-17-ics1811-runtime-skills-design.md` — §2.2、§3、§5.1、§9
- [S2] `references/ppt-operation-guide.txt` — slide 2–10，1811 新增、完成及 1815 修改
- [S3] `references/ppt-operation-guide.txt` — slide 5，固定和浮动折扣模式
- [S4] `references/ppt-operation-guide.txt` — slide 11–12，铂金以旧换新
- [S5] `references/ppt-operation-guide.txt` — slide 13–16，钻石以小换大和买钻石享黄金克减
- [S6] `references/ppt-operation-guide.txt` — slide 19，Outlet 活动
- [S7] `references/ppt-operation-guide.txt` — slide 20，黄金以旧换新
- [S8] `docs/superpowers/specs/2026-09-16-ics1811-sop-agent-design.md` — §1、§3.3、§3.5、§4.4、§5、§13.1
- [S9] `app/lib/campaign/ics1811/offer-spec.ts` — OFFER_TYPES、FIXED_ONLY_PATTERNS、detectPattern、offerTypeFor
- [S10] `app/lib/campaign/ics1811/derive.ts` — deriveDetails、derivePostActions、deriveFill
- [S11] `app/lib/campaign/ics1811/readback.ts` — calculation
```

- [ ] **Step 5: Author `field-explainer` from repository sources only**

Use this exact frontmatter description:

```yaml
name: field-explainer
description: 解释 ICS-1811 字段和业务名词。用户询问计折上折、固定或浮动折扣、让扣点、回款率、货品范围、货类、售价类型、限制条件、活动分组的含义或为什么需要确认时使用。
```

Use H1 `# ICS-1811 字段解释`.

Cover: the difference between customer offer stacking and commission `计折上折`; fixed versus floating as store price-adjustment behavior; decimal input for discount-bearing/recovery rates without inventing their finance definitions; the distinction among product scope, category, and category detail; optional membership/price restrictions; item/order restriction meanings; activity group versus detail offer type; no defaults for `不知道` or `按惯例`; and tool precedence. Do not include question IDs, missing-field logic, full code lists, or a permanent claim about page-version differences.

Define and use:

```markdown
- [S1] `docs/superpowers/specs/2026-09-17-ics1811-runtime-skills-design.md` — §3、§5.2、§9
- [S2] `references/ppt-operation-guide.txt` — slide 3、5、6、9、11、13、18、19
- [S3] `docs/superpowers/specs/2026-09-16-ics1811-sop-agent-design.md` — §3.1、§3.3、§3.4、§4.1、§4.4、§13.1
- [S4] `app/lib/campaign/ics1811/questions.ts` — QUESTION_TITLE、gapsOf
- [S5] `app/lib/campaign/ics1811/readback.ts` — calculation、buildReadback
- [S6] `app/lib/campaign/ics1811/derive.ts` — RESTRICTION_LABEL、deriveInfo、deriveDetails、deriveFill
- [S7] `app/lib/campaign/ics1811/checks.ts` — V-D09、V-D11、V-R01 至 V-R03
```

- [ ] **Step 6: Author `settlement-guide` from repository sources only**

Use this exact frontmatter description:

```yaml
name: settlement-guide
description: 解释单店、多店、跨区域活动的结算说明函处理。用户询问是否需要说明函、文件命名、上传流程或门店跨区域时使用。
```

Use H1 `# ICS-1811 结算说明函指引`.

Cover: the documented multi-store upload requirement; the conflicting prose/example filename orders as an unresolved conflict; 30-file maximum, unique names, upload-success confirmation; demo-generated names as suggestions only; deterministic multi-region split behavior; and explicit uncertainty for single-store requirements and cross-month naming. Do not invent file formats, size limits, over-30 handling, or cross-region letter granularity.

Define and use:

```markdown
- [S1] `docs/superpowers/specs/2026-09-17-ics1811-runtime-skills-design.md` — §3、§5.3
- [S2] `references/ppt-operation-guide.txt` — slide 4，结算说明函
- [S3] `docs/superpowers/specs/2026-09-16-ics1811-sop-agent-design.md` — §3.2、§3.5、§13.1 第 11 项
- [S4] `app/lib/campaign/ics1811/derive.ts` — stores_multi_region、deriveSettlement、derivePostActions
- [S5] `app/lib/campaign/ics1811/checks.ts` — V-A14、V-A15
- [S6] `app/lib/campaign/ics1811/fill-sheet.ts` — settlement 上传步骤
```

- [ ] **Step 7: Author `promo-copy-guide` from repository sources only**

Use this exact frontmatter description:

```yaml
name: promo-copy-guide
description: 指导 ICS-1811 活动对外宣传文案和标语。用户要求起草、修改、评价宣传文案或讨论活动标语时使用。
```

Use H1 `# ICS-1811 对外宣传文案指引`.

Cover: copy is an editable draft rather than approved publication; the model writes only headline and distinct selling points while code renders date/store/offer facts; plain text and no internal field names; all numbers must come from facts; no invented gifts, draws, free services, or other benefits; slogans are verbatim user-provided and legally confirmed text only; final publication still needs legal review; and tool rejection must be obeyed. Do not add a house brand voice, legal boilerplate, or approval claims.

Define and use:

```markdown
- [S1] `docs/superpowers/specs/2026-09-17-ics1811-runtime-skills-design.md` — §3、§5.4、§9
- [S2] `references/ppt-operation-guide.txt` — slide 3，活动标语和法务确认
- [S3] `app/lib/campaign/ics1811/promo.ts` — 文件级分工说明、offerLines、renderPromo
- [S4] `app/lib/agent/tools.ts` — draftPromoCopy
- [S5] `app/lib/campaign/ics1811/facts.ts` — slogan 写入守卫
- [S6] `app/lib/campaign/ics1811/checks.ts` — V-A03
- [S7] `docs/superpowers/specs/2026-09-16-ics1811-sop-agent-design.md` — §3.1、§4.4、T9
```

- [ ] **Step 8: Use these exact contents for `offer-entry-guide` and `field-explainer`**

Steps 4–7 are source-coverage checklists. The complete files in Steps 8–9 are normative, including their per-file source numbering; do not combine the earlier checklist numbering with these exact files.

`agent/plugin/skills/offer-entry-guide/SKILL.md`:

```markdown
---
name: offer-entry-guide
description: 解释 ICS-1811 优惠玩法、录入方式和不支持场景。用户询问打折、满减、克减、以旧换新、以小换大、固定或浮动折扣模式以及 1811 如何录入时使用。
---

# ICS-1811 优惠玩法与录入指引

## 适用场景

- 解释 ICS-1811 优惠玩法、录入方式和不支持场景。用户询问打折、满减、克减、以旧换新、以小换大、固定或浮动折扣模式以及 1811 如何录入时使用。[S1]
- 用户只是在清晰提供日期、门店、优惠等活动事实时，不需要引用本指引。[S1]
- 用户同时询问字段含义和具体录入选择时，本指引只负责录入选择；字段定义应结合字段解释规则回答。[S1]

## 回答原则

- 先用运营能理解的语言说明玩法和录入步骤，再让确定性业务工具产生最终填写值；不要把解释当成已经写入草稿的结果。[S1]
- 只说明已有材料明确支持的做法；材料缺少参数栏或存在版本差异时，直接说明需以实际页面和工具提示为准。[S1][S4]
- 不替用户决定折扣力度、是否累加、克重口径、门店能否改价或是否转换餐牌。[S4][S5]
- 不声称活动已经保存、完整、通过校验或可以提交；这些状态只来自业务工具。[S1]
- 来源编号只用于维护和审计，正常回答不向用户朗读。[S1]

## 业务知识

- ICS-1811 用于新增需审批的优惠开单活动，录入活动信息和活动明细；本指引不把 ICS-1816 批量导入混入 1811 的录入步骤。[S2][S4]
- 纯打折活动中，门店需要在基础折扣上改价、少打一点时使用浮动折扣模式；不能改价时使用固定折扣模式。只问含义时不要替用户选择。[S2][S4][S5]
- 满减要区分“只减一次”和“每满都减”：只减一次时达到两倍门槛仍只减一次，每满都减时按达到门槛的次数累加。[S4][S7]
- 克减要区分按实际克重和按单件重量的整数克计算；不能仅凭“每克减”替用户决定口径。[S4][S7]
- 全部货品不能转换为 outlet 餐牌；明确为 outlet 货品时，是否转换餐牌由用户决定。[S3][S5]
- 铂金以旧换新使用固定折扣模式，录入开单折扣和换大倍数；货类与货类明细由确定性工具给出。创建后要进 ICS-1815，将活动分组改为“17)货品回购”；不能修改时按指引联系 OA 审批人拒绝后重新提交。[S3][S4][S6]
- 钻石以小换大使用固定折扣模式并录入开单折扣；货类与货类明细由确定性工具给出。创建后要进 ICS-1815，将活动分组改为“17)货品回购”。[S3][S4][S6]
- 黄金以旧换新使用固定折扣模式，每个换大比例对应一条工费折扣明细；免工费也是明确支持的场景。创建后要进 ICS-1815，将活动分组改为“19)增值服务”，否则无法录入旧金。[S3][S4][S6][S7]
- 买钻石享黄金克减使用固定折扣模式，由钻石折扣和黄金每克减免两条关联明细组成；钻石不打折是明确支持的场景，最终字段和值由工具产生。[S3][S4][S6][S7]
- 满减、每满减、金价每整克减免和售价固定折扣的参数栏属于当前 demo 的推断录法，回答时必须提醒用户以页面为准。[S4][S5][S6]
- 黄金工费打折、满件折、满折、每满返和联单只有优惠类型名称，没有足够的参数栏材料，当前应提示人工在 1811 核实录入。[S4][S5][S6]
- 分克重段每整克优惠当前 demo 不支持。[S4][S5]
- 第二件优惠、买赠、赠品、积分加倍、满送等在 1811 明细优惠类型中没有对应选项时，应提示先确认 ICS 是否支持，不能自行替换成相近玩法。[S4][S5][S6]
- 抽奖、签到、打卡、集赞、讲座或沙龙在不带成交优惠时不属于 1811 优惠开单范围；如果同时存在明确的打折、满减或克减，只处理成交优惠部分。[S6]
- 完成新增后要核对明细并确认看到“上传服务器成功”；现有指引没有确认 1811 是否自动发起 OA 审批，因此只能提醒人工检查审批状态。[S2][S4][S6]

## 不能做什么

- 不复制玩法到最终字段值的完整映射、参数范围校验或优惠类型代码列表。[S1]
- 不把没有录入截图的玩法补成确定规则，也不把推断栏位说成正式规则。[S1][S4]
- 不复制门店、货类、号头或其他代码表内容。[S1]
- 不用所谓常见做法替用户填写人定字段或默认值。[S1][S4]
- 不根据本指引直接修改草稿、决定缺项、生成最终填写值或绕过工具守卫。[S1]

## 冲突处理

- 本指引与业务工具结果不一致时，以工具结果为准，并向用户说明当前实际可执行的结果。[S1]
- 工具把某个玩法判为不支持、待确认或需要人工录入时，不用本指引覆盖该结论。[S1][S6]

## 出处

- [S1] `docs/superpowers/specs/2026-09-17-ics1811-runtime-skills-design.md` — §2.2、§3、§5.1、§9
- [S2] `references/ppt-operation-guide.txt` — slide 2–10，1811 新增、折扣模式、完成新增与 1815 修改
- [S3] `references/ppt-operation-guide.txt` — slide 11–20，特殊换购、Outlet 与黄金以旧换新
- [S4] `docs/superpowers/specs/2026-09-16-ics1811-sop-agent-design.md` — §1、§3.3、§3.5、§4.4、§5、§13.1
- [S5] `app/lib/campaign/ics1811/offer-spec.ts` — OFFER_TYPES、FIXED_ONLY_PATTERNS、detectPattern、offerTypeFor
- [S6] `app/lib/campaign/ics1811/derive.ts` — deriveDetails、derivePostActions、deriveFill
- [S7] `app/lib/campaign/ics1811/readback.ts` — calculation
```

`agent/plugin/skills/field-explainer/SKILL.md`:

```markdown
---
name: field-explainer
description: 解释 ICS-1811 字段和业务名词。用户询问计折上折、固定或浮动折扣、让扣点、回款率、货品范围、货类、售价类型、限制条件、活动分组的含义或为什么需要确认时使用。
---

# ICS-1811 字段解释

## 适用场景

- 解释 ICS-1811 字段和业务名词。用户询问计折上折、固定或浮动折扣、让扣点、回款率、货品范围、货类、售价类型、限制条件、活动分组的含义或为什么需要确认时使用。[S1]
- 用户询问某个活动具体应选哪个折扣模式或怎样录入时，应结合优惠玩法录入规则回答，而不是只停留在字段定义。[S1]
- 用户只是在清晰提供字段事实时，不需要为了出现一个字段名而引用本指引。[S1]

## 回答原则

- 按“这个字段影响什么、需要运营确认什么、现有材料还有什么没说清”解释，使用白话，不朗读内部问题题号。[S1][S4]
- 只解释字段含义，不替用户选择人定字段，也不把页面默认值当成用户答案。[S1][S4]
- 用户说“不知道”或“按惯例”不等于已经回答，也不等于“没有”。[S1][S4]
- 字段的真实值、缺项状态和是否可提交由确定性工具判断，本指引不作状态结论。[S1]
- 来源编号只用于维护和审计，正常回答不向用户朗读。[S1]

## 业务知识

- “计折上折”是销售提成计算口径，不是顾客优惠能否叠加。不计算折上折时，销售提成按实际售价计算；计算折上折时，销售提成按实际售价乘折扣计算。[S2][S4][S6]
- 用户只说“折上折”“可叠加”或类似字样，不能据此判断提成口径，仍需确认按哪种方式计算销售提成。[S4][S5]
- 浮动折扣模式表示门店可在基础折扣上改价、少打一点；固定折扣模式表示不能这样改价。用户只问区别时，不替其选择模式。[S2][S5][S6]
- 让扣点和回款率是每条活动明细上的比例输入，录入为 0 到 1 之间的小数；只有用户明确说没有时才按 0 处理。[S2][S4][S8]
- 现有材料只明确了让扣点和回款率的录入格式，没有定义两者各自的财务业务含义；用户追问结算含义时，应说明需向财务或业务负责人确认。[S2][S4]
- 货品范围是活动级的货品池；货类是某条活动明细允许参加的类别；货类明细是在货类下进一步限定号头。三者不能混为同一字段。[S2][S3][S7]
- 会员级别和售价类型是可选的参与条件；有限定时才选择，不限制时无需勾选。[S2][S3]
- 当前确定性实现不会在浮动折扣明细中输出售价类型；用户已经限定售价类型却选择浮动模式时，应如实说明该限制当前录不进去。[S6][S7]
- 限制条件是在货类之外进一步缩小商品或订单范围的明细条件，包括模号、产品系列、价位、镶嵌原料、货组或整单金额等类别。[S4][S7]
- 多个限制值使用英文逗号分隔；部分限制栏只在某些页面版本出现，应以实际页面和工具输出为准。[S3][S4][S8]
- 活动分组是活动级分类，不等同于明细优惠类型；一般由确定性逻辑推导，特殊换购活动可能需要建完后去 ICS-1815 修改。[S4][S7]
- 询问这些字段是为了保留运营人员真实决定，避免把页面默认值、惯例或模型推测写成活动规则。[S1][S4]

## 不能做什么

- 不把“计折上折”解释成促销能否叠加。[S2][S4]
- 不编造让扣点和回款率未经材料支持的财务定义。[S2][S4]
- 不复制货品范围、售价类型、活动分组或其他代码表的完整选项列表。[S1]
- 不断言“售价类型只在固定模式出现”是所有 ICS 页面版本的永久规则；现有设计仍把模式与版本差异列为待确认。[S4]
- 不声称所有限制条件在每个页面版本都存在。[S4][S7]
- 不根据字段解释直接写草稿、判断缺项或提供默认答案。[S1]

## 冲突处理

- 本指引与业务工具结果不一致时，以工具结果为准，并用用户能理解的方式说明差异。[S1]
- 工具将字段标成待确认、无法录入或页面版本差异时，不用一般解释覆盖该提示。[S1][S7]

## 出处

- [S1] `docs/superpowers/specs/2026-09-17-ics1811-runtime-skills-design.md` — §3、§5.2、§9
- [S2] `references/ppt-operation-guide.txt` — slide 3、5、6，计折上折、折扣模式、让扣点与回款率
- [S3] `references/ppt-operation-guide.txt` — slide 11、13、18、19，售价类型、限制条件与货品范围
- [S4] `docs/superpowers/specs/2026-09-16-ics1811-sop-agent-design.md` — §3.1、§3.3、§3.4、§4.1、§4.4、§13.1
- [S5] `app/lib/campaign/ics1811/questions.ts` — QUESTION_TITLE、gapsOf
- [S6] `app/lib/campaign/ics1811/readback.ts` — calculation、buildReadback
- [S7] `app/lib/campaign/ics1811/derive.ts` — RESTRICTION_LABEL、deriveInfo、deriveDetails、deriveFill
- [S8] `app/lib/campaign/ics1811/checks.ts` — V-D09、V-D11、V-R01 至 V-R03
```

- [ ] **Step 9: Use these exact contents for `settlement-guide` and `promo-copy-guide`**

`agent/plugin/skills/settlement-guide/SKILL.md`:

```markdown
---
name: settlement-guide
description: 解释单店、多店、跨区域活动的结算说明函处理。用户询问是否需要说明函、文件命名、上传流程或门店跨区域时使用。
---

# ICS-1811 结算说明函指引

## 适用场景

- 解释单店、多店、跨区域活动的结算说明函处理。用户询问是否需要说明函、文件命名、上传流程或门店跨区域时使用。[S1]
- 用户只是在清晰提供门店或说明函事实时，不需要为了出现门店名称而引用本指引。[S1]
- 需要识别门店所属区域、分区或简称时，应使用确定性查询结果，本指引不代替门店解析。[S1][S4]

## 回答原则

- 区分“操作指引明确要求”“当前 demo 的建议”和“现有材料无法确认”，不要把建议说成正式规则。[S1][S3]
- 用户明确说没有结算说明函时，不替用户改成有；可以说明指引要求及当前系统会给出的提醒。[S3][S5]
- 文件名采用工具返回的建议值，不自行根据店名或区域拼接。[S1][S4]
- 不复制门店代码表，也不凭门店名称猜测所属区域。[S1][S4]
- 来源编号只用于维护和审计，正常回答不向用户朗读。[S1]

## 业务知识

- 操作指引明确要求多家分店活动在结算说明函处上传文件。[S2]
- 用户确认有结算说明函时，当前 demo 为每家门店生成一个建议文件名；demo 只提供建议和上传步骤，不实际上传文件。[S3][S4]
- 指引文字中的命名顺序是“区域＋分区＋简写店名＋店号＋月份”，并要求文件名不能重名。[S2]
- 指引示例的顺序却是“区域＋分区＋店号＋简写店名＋月份”，与文字规则不一致，因此不能把其中任一种顺序说成已经确认的正式规则。[S2][S3]
- 当前工具可能按示例顺序生成建议文件名；回答时应称为“建议文件名”，不能包装成正式命名标准。[S3][S4]
- 结算说明函最多上传 30 个文件，文件名不能重名。[S2][S5]
- 上传时在“结算说明函”处点击“浏览”选择文件，再点击“上传”；每个文件都要确认看到“上传成功”。[S2][S6]
- 门店经确定性查询后分属多个区域时，当前实现要求按区域分开建立 1811 活动。[S4]
- 单店活动是否必须上传结算说明函，现有材料不能确认。[S1][S3]
- 跨月活动的文件名应使用哪个月份，现有材料不能确认；当前 demo 的月份处理不能表述成正式业务规则。[S1][S3][S4]
- 多店活动明确回答没有结算说明函时，当前校验只给提醒，不替用户生成或声称已有文件。[S5]

## 不能做什么

- 不断言单店一定需要或一定不需要结算说明函。[S1][S3]
- 不在文字规则与示例冲突时自行选定正式文件名顺序。[S1][S2][S3]
- 不把跨月活动取开始月份说成已确认的业务规则。[S1][S3]
- 不复制门店代码、区域代码、分区代码或店名对照表。[S1]
- 不绕过工具自行判断门店是否跨区域。[S1][S4]
- 不声称文件已经上传或上传成功；该状态需要操作人员在页面确认。[S2][S6]

## 冲突处理

- 本指引与业务工具结果不一致时，以工具结果为准；工具生成的文件名仍应表述为建议值。[S1][S4]
- 工具判定门店跨区域、文件重名或超过数量限制时，直接采用工具提示，不用本指引放宽。[S1][S4][S5]
- 材料无法确认的问题应明确回答“现有指引不能确认”，不能根据惯例补规则。[S1][S3]

## 出处

- [S1] `docs/superpowers/specs/2026-09-17-ics1811-runtime-skills-design.md` — §3、§5.3、§9
- [S2] `references/ppt-operation-guide.txt` — slide 4，结算说明函命名、上传与数量限制
- [S3] `docs/superpowers/specs/2026-09-16-ics1811-sop-agent-design.md` — §3.2、§3.5、§13.1 第 11 项
- [S4] `app/lib/campaign/ics1811/derive.ts` — deriveInfo 的 stores_multi_region、deriveSettlement、derivePostActions
- [S5] `app/lib/campaign/ics1811/checks.ts` — V-A14、V-A15
- [S6] `app/lib/campaign/ics1811/fill-sheet.ts` — settlement 上传步骤
```

`agent/plugin/skills/promo-copy-guide/SKILL.md`:

```markdown
---
name: promo-copy-guide
description: 指导 ICS-1811 活动对外宣传文案和标语。用户要求起草、修改、评价宣传文案或讨论活动标语时使用。
---

# ICS-1811 对外宣传文案指引

## 适用场景

- 指导 ICS-1811 活动对外宣传文案和标语。用户要求起草、修改、评价宣传文案或讨论活动标语时使用。[S1]
- 用户只是在提供活动事实或修改 1811 内部活动名称、活动内容时，不把这些请求自动当成对外宣传文案任务。[S1][S4]
- 起草对外宣传文案前必须先成功加载本指引，再调用文案工具。[S1]

## 回答原则

- 把产物称为供运营修改的对外草稿，不声称已经获批或可以直接发布。[S1][S3]
- 模型只负责主标题和卖点；日期、门店和优惠说明由代码从事实层渲染，不在创意部分重新编写。[S1][S3][S4]
- 使用消费者能理解的简洁自然语言，不出现内部字段名、门店编号、区域代码或优惠类型代码。[S3]
- 正式发布前仍须进行法务确认。[S1][S3]
- 来源编号只用于维护和审计，正常回答不向用户朗读。[S1]

## 业务知识

- 主标题用于概括活动吸引点，卖点用于补充互不重复的消费者利益表达；不要重复堆叠系统随后生成的日期、门店和优惠说明。[S1][S3][S4]
- 文案工具要求主标题非空且不超过 20 个字，卖点为 1 到 4 条，每条不超过 30 个字。[S4]
- 对外文案使用纯文本；工具会移除 Markdown 强调等标记，不应主动加入这些格式。[S4]
- 日期、门店、周期和优惠力度由代码从已确认事实中生成，模型不能改写区域、店名或活动数字。[S3][S4]
- 创意部分出现的数字必须能在活动事实中找到；不能为了增强吸引力编造门槛、折扣、天数或数量。[S4]
- 不得增加事实层不存在的赠品、好礼、礼品、抽奖、免费、加赠、豪礼、礼包或其他权益。[S1][S4]
- 代码只拦截已列出的高风险词形；即使某种同义改写未被代码识别，也仍然不能虚构活动权益。[S1]
- 活动标语与主标题不同：标语只能逐字采用用户提供且法务确认过的原文，模型不能起草、润色或改写。[S2][S3][S5][S6]
- 标语尚未经法务确认时，文案草稿中不放标语，并明确提示尚未确认。[S3][S5]
- 对消费者展示门店时使用店名而不是内部店号；区域名称不带内部代码前缀。[S3]
- 对外优惠说明使用消费者能理解的表述，不输出“判断金额”“开单折扣”“金价每整克减免”等内部核对措辞。[S3]
- 系统生成的草稿会附上发布前法务确认提示；有活动日期时还会附上以门店实际公示为准的提示。[S3]

## 不能做什么

- 不自行编写最终日期、门店、周期或优惠力度文案。[S1][S3][S4]
- 不虚构事实里没有的人群、适用条件、赠品、抽奖、免费服务或其他权益。[S1][S4]
- 不起草、改写或优化活动标语，也不用主标题代替标语。[S2][S3][S5]
- 不声称标语已经法务确认、整份文案已经合规或可以直接发布。[S1][S3][S6]
- 不使用内部门店编号、区域代码、活动分组代码或页面字段术语面向消费者宣传。[S3]
- 不绕过文案工具的长度、数字和虚构权益守卫。[S1][S4]

## 冲突处理

- 本指引与文案工具结果不一致时，以工具结果为准，并根据拒绝原因修改主标题或卖点。[S1][S4]
- 工具返回的日期、门店和优惠说明不得被模型自行替换。[S1][S3]
- 标语事实或法务确认状态与模型判断不一致时，以事实守卫和校验结果为准。[S1][S5][S6]

## 出处

- [S1] `docs/superpowers/specs/2026-09-17-ics1811-runtime-skills-design.md` — §3、§5.4、§9
- [S2] `references/ppt-operation-guide.txt` — slide 3，活动标语展示位置及法务确认要求
- [S3] `app/lib/campaign/ics1811/promo.ts` — 文件级分工说明、offerLines、renderPromo
- [S4] `app/lib/agent/tools.ts` — draftPromoCopy
- [S5] `app/lib/campaign/ics1811/facts.ts` — slogan 写入守卫
- [S6] `app/lib/campaign/ics1811/checks.ts` — V-A03
```

- [ ] **Step 10: Run the focused test**

Run: `node --test --experimental-strip-types tests/skills.test.ts`

Expected: the bundled-content assertion remains RED only for loader behavior; there must be no missing source path or malformed Markdown discovered by manual inspection.

- [ ] **Step 11: Commit only the plugin content after Task 2 makes validation GREEN**

Do not commit an unvalidated intermediate plugin. Keep Task 1 changes unstaged until Task 2 completes, then include them in the first atomic commit.

---

### Task 2: Replace permissive scanning with a strict catalog and source validator

**Files:**
- Modify: `agent/skills.ts`
- Modify: `tests/skills.test.ts`
- Modify: `agent/tsconfig.json`

**Interfaces:**

```ts
export const PLUGIN_NAME = "ics1811";
export const BASELINE_SKILL_NAMES = [
  "offer-entry-guide",
  "field-explainer",
  "settlement-guide",
  "promo-copy-guide",
] as const;
export type BaselineSkillName = typeof BASELINE_SKILL_NAMES[number];
export type SkillSource = { id: string; path: string; note?: string };
export type SkillInfo = {
  name: string;
  qualifiedName: string;
  title: string;
  description: string;
  relativePath: string;
  sources: readonly SkillSource[];
};
export class SkillCatalogError extends Error {
  readonly relativePath: string;
  readonly detail: string;
  constructor(relativePath: string, detail: string) {
    super(`${relativePath}：${detail}`);
    this.name = "SkillCatalogError";
    this.relativePath = relativePath;
    this.detail = detail;
  }
}
export function loadSkillCatalog(pluginDir: string): readonly SkillInfo[];
export function validateSkillSources(catalog: readonly SkillInfo[], repoRoot: string): void;
export function qualifiedSkillNames(catalog: readonly SkillInfo[]): string[];
export function skillOf(catalog: readonly SkillInfo[], requested: unknown): SkillInfo | null;
```

- [ ] **Step 1: Add temporary-plugin fixture helpers and failing contract tests**

Use `mkdtempSync(join(tmpdir(), "ics1811-skills-"))`, `mkdirSync`, `writeFileSync`, and `rmSync(..., { recursive: true, force: true })` inside `test.after`. Add tests with these exact behavioral names:

```text
skill catalog discovers baseline and additional skills in sorted exact whitelist
skill catalog rejects a missing or wrongly named plugin manifest
skill catalog rejects an empty directory and every missing baseline skill
skill catalog rejects a missing SKILL.md and extra files in a skill directory
skill catalog rejects malformed frontmatter, unknown keys and duplicate keys
skill catalog rejects invalid names, directory mismatch and duplicate names
skill catalog rejects missing duplicate or out-of-order required sections
skill catalog rejects files over 500 lines
skill catalog requires every rule entry to cite a defined source
skill catalog rejects unused sources external URLs and placeholders
runtime catalog does not require source files but CI source validation does
skillOf accepts exact short and qualified names and rejects unknown names
```

Use the catalog/source portions of Appendix B verbatim; later tasks add the routing and load-state tests already shown in the same appendix.

- [ ] **Step 2: Run the catalog tests and verify RED**

Run: `node --test --experimental-strip-types tests/skills.test.ts`

Expected: FAIL against the current permissive `listSkills` implementation.

- [ ] **Step 3: Implement fail-closed catalog loading**

Implement these checks in this order so error messages are stable:

1. `.claude-plugin/plugin.json` exists, parses as JSON, and has `name === "ics1811"`.
2. `skills/` exists and all four baseline directories exist.
3. Every immediate child is a directory containing exactly one readable `SKILL.md` and no extra files.
4. Frontmatter has exactly one single-line `name` and `description`; unknown and duplicate keys fail.
5. `name` matches `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, is at most 64 Unicode code points, equals the directory name, and is unique.
6. `description` is non-empty and at most 1024 Unicode code points.
7. Body has exactly one H1 and exactly the six required H2 headings in the required order, with no additional H2 section.
8. File has at most 500 lines.
9. Every non-empty rule line in the first five sections is a Markdown list item ending with one or more `[S数字]` references.
10. Every used source ID is defined once in `出处`; every defined source ID is used.
11. Source definitions match `- [S#] \`repo/relative/path\`` with an optional non-empty ` — locator`; reject absolute paths, `..`, URL schemes, and placeholder language `TODO`, `TBD`, or `以后补`.
12. Remove the list marker and terminal source tags from the first `适用场景` item and require exact equality with `description`.
13. Return a frozen/read-only catalog sorted by short name with `qualifiedName: "ics1811:<name>"` and a plugin-relative `relativePath`.

`SkillCatalogError.message` must include the plugin-relative path and the concrete reason. Do not catch and turn the error into `[]`.

Use the catalog/parser portion of Appendix A verbatim. Tasks 3 and 4 then add the routing and load-state exports from the same final file.

- [ ] **Step 4: Implement source validation as a separate CI concern**

For each `SkillSource`, resolve its path against `repoRoot`, verify the resolved path remains under `repoRoot`, and verify it exists. Do not read or check source paths from `loadSkillCatalog`; the deployed runtime only ships the plugin.

- [ ] **Step 5: Keep a short compatibility bridge until server wiring is replaced**

If the current dirty `agent/server.ts` still imports `listSkills`, temporarily export:

```ts
export const listSkills = loadSkillCatalog;
```

Remove that alias in Task 5 when the server imports the final APIs.

- [ ] **Step 6: Run focused validation and type checks**

Run:

```bash
node --test --experimental-strip-types tests/skills.test.ts
npx tsc -p agent/tsconfig.json
```

Expected: PASS.

- [ ] **Step 7: Commit the validated plugin and catalog atomically**

```bash
git add agent/plugin/.claude-plugin/plugin.json agent/plugin/skills agent/skills.ts agent/tsconfig.json tests/skills.test.ts
git diff --cached --check
git diff --cached --stat
git commit -m "feat: add source-backed runtime skills"
```

---

### Task 3: Add conservative required-Skill routing

**Files:**
- Modify: `agent/skills.ts`
- Modify: `tests/skills.test.ts`

**Interfaces:**

```ts
export function requiredSkillsForTurn(
  request: Pick<AgentRequest, "trigger">,
): BaselineSkillName[];
```

- [ ] **Step 1: Write failing deterministic routing tests**

Add a helper that constructs only `{ trigger: { kind: "user_message", text } }`, then assert these exact results:

```ts
assert.deepEqual(required("计折上折是什么意思"), ["field-explainer"]);
assert.deepEqual(required("黄金以旧换新在 1811 怎么录"), ["offer-entry-guide"]);
assert.deepEqual(required("两家店要不要说明函"), ["settlement-guide"]);
assert.deepEqual(required("帮我写一版宣传文案"), ["promo-copy-guide"]);
assert.deepEqual(required("浮动和固定有什么区别"), ["field-explainer"]);
assert.deepEqual(required("固定折扣模式是什么意思"), ["field-explainer"]);
assert.deepEqual(required("浮动折扣和固定折扣有什么区别"), ["field-explainer"]);
assert.deepEqual(required("浮动折扣模式和固定折扣模式有什么区别"), ["field-explainer"]);
assert.deepEqual(required("这个活动该选浮动还是固定，1811 怎么录"), ["offer-entry-guide"]);
assert.deepEqual(required("先解释浮动和固定的区别，再告诉我这个活动怎么录"), [
  "offer-entry-guide",
  "field-explainer",
]);
assert.deepEqual(required("10月1日到7日，7590店，钻石95折"), []);
assert.deepEqual(required("多店活动，门店是7590和7601"), []);
assert.deepEqual(required("让扣点2%，回款率98%"), []);
```

Add synonym cases for `什么意思/含义/怎么理解`, `怎么填/如何录/该选/是否支持`, `上传/命名/必须`, and `起草/修改/润色/评价/标语`.

- [ ] **Step 2: Run routing tests and verify RED**

Run: `node --test --experimental-strip-types tests/skills.test.ts`

Expected: FAIL because `requiredSkillsForTurn` does not exist.

- [ ] **Step 3: Implement topic-plus-intent routing**

Do not route on a domain noun alone. Normalize only whitespace and case; do not rewrite the user's meaning. Use separate topic and intent predicates:

```ts
const FIELD_TOPIC = /计折上折|折上折|固定(?:折扣)?模式|浮动(?:折扣)?模式|固定(?:折扣)?(?:模式)?(?:和|与|、|还是|或)浮动(?:折扣)?(?:模式)?|浮动(?:折扣)?(?:模式)?(?:和|与|、|还是|或)固定(?:折扣)?(?:模式)?|让扣点|回款率|货品范围|货类明细|货类|售价类型|限制条件|餐牌|活动分组/;
const EXPLAIN_INTENT = /什么意思|是什么意思|什么含义|怎么理解|如何理解|有什么区别|区别是什么|有什么差别|差别是什么|为什么(?:要|需要)?(?:问|填|确认)|解释|含义|指什么/;
const OFFER_TOPIC = /折扣|打(?:\d+(?:\.\d+)?)?折|满减|克减|每克减|以旧换新|以小换大|换购|outlet|转餐牌|累加|抽奖|签到|优惠玩法|活动玩法|优惠开单|1811/;
const ENTRY_INTENT = /怎么录|如何录|怎样录|怎么填|如何填|怎样填|怎么建|如何建|怎样建|怎么创建|如何创建|该选|应该选|选哪个|怎么选|如何选择|是否支持|支不支持|能不能(?:做|录|建)|可以(?:做|录|建)吗|适不适用|怎么处理|如何处理/;
const SUPPORT_INTENT = /是否支持|支不支持|支持.{0,12}吗|能不能|能(?:做|录|建)吗|可以吗|可不可以|适不适用|是不是超出|是否超出/;
const SETTLEMENT_TOPIC = /结算说明函|说明函|跨区域|跨区|多门店|多家(?:门店|店)|两家(?:门店|店)|单店|文件命名|上传流程/;
const SETTLEMENT_INTENT = /要不要|是否|需不需要|需要吗|怎么|如何|怎样|什么|规则|处理|命名|上传|确认|可以|能否/;
const PROMO_TOPIC = /宣传文案|活动文案|对外文案|推广文案|主标题|卖点|标语|宣传语/;
const PROMO_INTENT = /帮我|请|起草|写一版|写个|改写|修改|润色|优化|评价|点评|看看|讨论|建议|怎么写|如何写|要不要|是否合适|怎么样/;
const EXPLAIN_THEN_ENTER = /(?:(?:解释|说明).*(?:区别|差别).*(?:怎么|如何|怎样).*(?:录|填|建|创建)|(?:怎么|如何|怎样).*(?:录|填|建|创建).*(?:解释|说明).*(?:区别|差别))/;
```

Apply these rules:

1. Field topic plus explain intent adds `field-explainer`.
2. Offer or field topic plus entry intent adds `offer-entry-guide`; an offer topic plus explicit support intent also adds it.
3. Meaning-only input that matches a field topic adds only `field-explainer`, even when the same text also contains the broad word `折扣`. An offer meaning question adds `offer-entry-guide` only when no field topic matched.
4. Settlement topic plus settlement intent adds `settlement-guide`.
5. Promo topic plus promo intent adds `promo-copy-guide`.
6. `EXPLAIN_THEN_ENTER` adds both field and offer guides for the approved mixed-intent phrasing even when the field noun is elided.
7. Return matched names in `BASELINE_SKILL_NAMES` order, never regex or `Set` insertion order.

Keep the router deliberately conservative. Missing a synonym can be fixed with a test; over-routing every factual turn would add latency and violate the spec.

Copy the `requiredSkillsForTurn` implementation and routing constants from Appendix A; copy the corresponding routing tests from Appendix B.

- [ ] **Step 4: Run focused tests and type checks**

Run:

```bash
node --test --experimental-strip-types tests/skills.test.ts
npx tsc -p agent/tsconfig.json
```

Expected: PASS.

- [ ] **Step 5: Commit the router**

```bash
git add agent/skills.ts tests/skills.test.ts
git diff --cached --check
git commit -m "feat: route campaign knowledge requests"
```

---

### Task 4: Enforce Skill load state and trace privacy

**Files:**
- Modify: `agent/skills.ts`
- Modify: `app/lib/tool-trace.ts`
- Modify: `tests/skills.test.ts`
- Modify: `tests/tool-trace.test.ts`

**Interfaces:**

```ts
export type SkillLoadState = {
  pending: Map<string, { skill: SkillInfo | null; started: AgentTraceEvent }>;
  loadedSkills: Set<string>;
  skillLoadFailed: boolean;
};
export function createSkillLoadState(): SkillLoadState;
export function beginSkillLoad(
  catalog: readonly SkillInfo[],
  state: SkillLoadState,
  input: { id: string; requested: unknown; at: number },
): AgentTraceEvent;
export function finishSkillLoad(
  state: SkillLoadState,
  input: { toolUseId: string; isError: boolean; at: number },
): AgentTraceEvent | null;
export function finishPendingSkillLoads(state: SkillLoadState, at: number): AgentTraceEvent[];
export function assertSkillTurnContract(
  required: readonly BaselineSkillName[],
  state: SkillLoadState,
): void;
export function finishSkillCheckedTurn<T>(
  required: readonly BaselineSkillName[],
  state: SkillLoadState,
  finish: () => T,
): T;
```

- [ ] **Step 1: Write failing load-state and postcondition tests**

Add tests for these exact cases:

- a known short or qualified Skill begins a `load_campaign_skill` trace and completes by the same `tool_use_id`;
- successful completion adds only the short name to `loadedSkills`;
- a failed result produces warning summary `规则没有加载成功` and sets `skillLoadFailed`;
- an unknown requested name produces title `加载业务规则：未知规则`, warning, and a failed turn even if the SDK result is not marked error;
- an unmatched tool result returns `null` and does not mutate state;
- unfinished calls become warnings at turn end, clear `pending`, and fail the turn;
- a missing required Skill causes `assertSkillTurnContract` to throw;
- a failed optional Skill also causes it to throw;
- a complete required set passes.
- `finishSkillCheckedTurn` never invokes its callback when the contract fails and invokes it exactly once after a valid contract.

The trace assertions must verify only `id`, safe title, status, initiator, summary, and duration. They must not contain Skill body text, full tool input, or prompt text.

- [ ] **Step 2: Run the load-state tests and verify RED**

Run: `node --test --experimental-strip-types tests/skills.test.ts`

Expected: FAIL because the state machine and contract do not exist.

- [ ] **Step 3: Implement the pure load-state machine**

Use `startTraceEvent`, `finishTraceEvent`, and `SKILL_TRACE_TOOL` from `app/lib/tool-trace.ts`.

- `beginSkillLoad` resolves through `skillOf`, stores the pending pair, and marks unknown requests failed immediately.
- Known title: `加载业务规则：${skill.title}`. Unknown title: `加载业务规则：未知规则`.
- `finishSkillLoad` removes the pending item. Known success becomes `completed` with `已读取这份规则` and adds the short name. Any SDK error or unknown Skill becomes `warning` with `规则没有加载成功` and sets the failure flag.
- `finishPendingSkillLoads` turns every remaining start event into a warning with `规则没有加载成功`, sets the failure flag, clears the map, and returns the finished events in insertion order.
- `assertSkillTurnContract` first rejects `skillLoadFailed`, then rejects every required short name absent from `loadedSkills`. Use a stable Chinese error such as `业务规则没有加载成功，请重试` rather than exposing internal prompt content.
- `finishSkillCheckedTurn` calls `assertSkillTurnContract` first and only then calls and returns `finish()`. This pure wrapper makes the critical ordering testable without importing the HTTP server.

Use the final load-state functions in Appendix A and the matching synthetic-event tests in Appendix B verbatim.

- [ ] **Step 4: Lock the trace-only tool boundary**

Keep this shape in `app/lib/tool-trace.ts`:

```ts
export const SKILL_TRACE_TOOL = "load_campaign_skill";
export type TraceToolName =
  | CampaignToolName
  | (typeof LEGACY_TOOL_NAMES)[number]
  | typeof SKILL_TRACE_TOOL;
```

Add `SKILL_TRACE_TOOL` to trace decoding only. Do not add it to `CAMPAIGN_TOOL_NAMES`; it must never enter `AgentResult.tools` as a campaign mutation/query tool.

Extend `tests/tool-trace.test.ts` to prove:

- Skill start/completion events decode and merge by ID;
- a Skill warning contributes to the warning card summary;
- old traces without the new name remain valid;
- `CAMPAIGN_TOOL_NAMES.includes(SKILL_TRACE_TOOL as never)` is false.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test --experimental-strip-types tests/skills.test.ts tests/tool-trace.test.ts
npx tsc -p agent/tsconfig.json
```

Expected: PASS.

- [ ] **Step 6: Commit the load contract**

```bash
git add agent/skills.ts app/lib/tool-trace.ts tests/skills.test.ts tests/tool-trace.test.ts
git diff --cached --check
git commit -m "feat: track campaign skill loading"
```

---

### Task 5: Wire the validated catalog into the Claude Agent SDK and gate promo copy atomically

**Files:**
- Create: `agent/run-turn.ts`
- Modify: `agent/server.ts`
- Modify: `agent/skills.ts`
- Modify: `agent/tsconfig.json`
- Modify: `app/lib/agent/prompt.ts`
- Modify: `app/lib/agent/tools.ts`
- Modify: `tests/skills.test.ts`
- Modify: `tests/agent-tools.test.ts`
- Modify: `tests/conversation.test.ts`

**Production runner interface:**

```ts
export type AgentRuntimeConfig = {
  model: string;
  modelBaseUrl: string;
  apiKey: string;
  runtimeDir: string;
  pluginDir: string;
  timeoutMs: number;
  debug?: boolean;
};

export type AgentTurnRunner = (
  request: AgentRequest,
  onTrace?: (event: AgentTraceEvent) => void,
) => Promise<AgentResult>;
export type AgentQuery = (
  params: Parameters<typeof query>[0],
) => AsyncIterable<SDKMessage>;
export type AgentRuntimeDependencies = {
  query: AgentQuery;
};
export function createAgentRunner(
  config: AgentRuntimeConfig,
  dependencies?: AgentRuntimeDependencies,
): AgentTurnRunner;
```

`agent/run-turn.ts` contains no environment-file loading, HTTP listener, or `process.exit`. It receives all runtime values through `AgentRuntimeConfig`. Move the existing `runAgentTurn` body, zod schemas, MCP registration, catalog loading, query options, and SDK message loop into the function returned by `createAgentRunner`; do not duplicate or simplify them. `agent/server.ts` retains HTTP parsing/streaming and constructs one runner after loading `.dev.vars`.

The optional `AgentRuntimeDependencies` is a narrow test seam around the SDK message source. Production and all normal smoke cases omit it and therefore use the real SDK `query`; the release-only failure probe wraps that same real stream to turn the first native Skill result into an error deterministically. It must not provide a second prompt, alternate tool set, or fake model response.

Use Appendix C as the exact final `agent/run-turn.ts` implementation.

- [ ] **Step 1: Write failing promo-copy gate tests**

In `tests/agent-tools.test.ts`, snapshot the full state before the blocked call:

```ts
const before = structuredClone(state);
const blocked = runAgentTool(state, "draft_promo_copy", {
  headline: "黄金克减季",
  highlights: ["一般足金类每克立减15元"],
});
assert.equal(blocked.isError, true);
assert.match(blocked.text, /先加载 promo-copy-guide/);
assert.deepEqual(state, before);
```

Update every existing promo-copy success and content-guard test to pass the loaded Skill explicitly:

```ts
const PROMO_CONTEXT = { loadedSkills: new Set(["promo-copy-guide"]) };
runAgentTool(state, "draft_promo_copy", input, PROMO_CONTEXT);
```

Run: `node --test --experimental-strip-types tests/agent-tools.test.ts`

Expected: FAIL because the dispatcher does not yet accept or enforce the Skill context.

- [ ] **Step 2: Implement the dispatcher-level promo gate**

Add the context type next to the dispatcher:

```ts
export type AgentToolContext = {
  loadedSkills?: ReadonlySet<string>;
};

export function runAgentTool(
  state: AgentState,
  name: AgentToolName,
  input: Record<string, unknown> = {},
  context: AgentToolContext = {},
): ToolOutcome;
```

Before invoking the handler for `draft_promo_copy`, require `context.loadedSkills?.has("promo-copy-guide")`. On failure return exactly:

```text
没保存：先加载 promo-copy-guide 业务规则，再重新调用 draft_promo_copy。
```

Do not mutate the state on this path. Preserve all current length, numeric-provenance, forbidden-benefit, and readiness guards after the new gate. Update the safe refusal summary for `draft_promo_copy` to `文案尚未生成，Agent 会先加载规则或修正文案`, with a focused assertion so a missing Skill is not mislabeled as a length or number problem.

Do not commit yet. The production runner does not pass `loadedSkills` until Steps 5–8 below; the gate and its wiring must land in the same atomic commit.

- [ ] **Step 3: Write the failing required-Skill user-prompt test**

Add to the existing prompt test in `tests/conversation.test.ts`:

```ts
const requiredPrompt = buildAgentUserPrompt(request, ["field-explainer"]);
assert.match(requiredPrompt, /## 本轮业务规则/);
assert.match(requiredPrompt, /必须先加载：ics1811:field-explainer/);
assert.doesNotMatch(requiredPrompt, /ics1811:offer-entry-guide/);

const plainPrompt = buildAgentUserPrompt(request, []);
assert.match(plainPrompt, /必须先加载：无/);
```

Run: `node --test --experimental-strip-types tests/conversation.test.ts`

Expected: FAIL because `buildAgentUserPrompt` accepts one argument and does not render the contract.

- [ ] **Step 4: Add the required-Skill block without removing existing knowledge yet**

Change the signature to:

```ts
export function buildAgentUserPrompt(
  request: AgentRequest,
  requiredSkills: readonly string[] = [],
): string;
```

Render immediately before `## 已记下的信息`:

```ts
"## 本轮业务规则",
`- 必须先加载：${requiredSkills.length
  ? requiredSkills.map((name) => `ics1811:${name}`).join("、")
  : "无"}`,
"- 成功加载后再回答；加载失败不要凭印象继续",
```

The `readonly string[]` avoids an upward dependency from `app/lib/agent/` into `agent/`. Do not shrink the system prompt in this task; first land the load-state and SDK enforcement.

- [ ] **Step 5: Refactor `runAgentTurn` initialization in dependency order**

At the start of the returned per-turn runner, load the catalog and route before creating tool handlers:

```ts
const catalog = loadSkillCatalog(config.pluginDir);
const requiredSkills = requiredSkillsForTurn(request);
const skillLoads = createSkillLoadState();
const state = createAgentState(request);
```

Define `recordSkill` before building the MCP handler. Pass the live per-turn set into every campaign tool call:

```ts
const outcome = runAgentTool(state, name, args, {
  loadedSkills: skillLoads.loadedSkills,
});
```

Catalog damage must throw before the SDK query starts; do not catch it locally or silently disable Skills.

- [ ] **Step 6: Replace conditional SDK options with the exact whitelist**

Use:

```ts
prompt: buildAgentUserPrompt(request, requiredSkills),
options: {
  model: config.model,
  systemPrompt: buildAgentSystemPrompt(request.today),
  tools: ["Skill"],
  plugins: [{ type: "local", path: config.pluginDir }],
  skills: qualifiedSkillNames(catalog),
  mcpServers: { campaign },
  allowedTools: AGENT_TOOL_NAMES.map((name) => `mcp__campaign__${name}`),
  settingSources: [],
  persistSession: false,
  maxTurns: 12,
  cwd: config.runtimeDir,
  abortController,
  stderr: (data) => stderr.push(data),
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: config.runtimeDir,
    ANTHROPIC_BASE_URL: config.modelBaseUrl,
    ANTHROPIC_API_KEY: config.apiKey,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  },
}
```

Do not add `Skill` to `allowedTools`; that list is for the business MCP server. Do not use `skills: "all"`. Keep the default plugin delivery mode.

In `agent/server.ts`, construct the same production runner used by release smoke tests:

```ts
const runAgentTurn = createAgentRunner({
  model: MODEL,
  modelBaseUrl: MODEL_BASE_URL,
  apiKey: API_KEY,
  runtimeDir: RUNTIME_DIR,
  pluginDir: PLUGIN_DIR,
  timeoutMs: TURN_TIMEOUT_MS,
  debug: DEBUG,
});
```

The existing `/turn` and `/turn/stream` handlers continue calling this local constant with the same `(request, onTrace?)` signature.

- [ ] **Step 7: Replace ad hoc Skill message handling with the tested state machine**

For assistant messages:

```ts
if (message.type === "assistant") {
  for (const block of message.message.content) {
    if (block.type !== "tool_use" || block.name !== "Skill") continue;
    recordSkill(beginSkillLoad(catalog, skillLoads, {
      id: block.id,
      requested: (block.input as { skill?: unknown }).skill,
      at: Date.now(),
    }));
  }
}
```

For user tool results:

```ts
if (message.type === "user" && Array.isArray(message.message.content)) {
  for (const block of message.message.content) {
    if (block.type !== "tool_result") continue;
    const event = finishSkillLoad(skillLoads, {
      toolUseId: block.tool_use_id,
      isError: block.is_error === true,
      at: Date.now(),
    });
    if (event) recordSkill(event);
  }
}
```

Do not log `block.input` or Skill content. The existing debug line may log only the resolved short/qualified name.

- [ ] **Step 8: Close all pending traces in `finally` and enforce the postcondition**

Use:

```ts
} finally {
  for (const event of finishPendingSkillLoads(skillLoads, Date.now())) {
    recordSkill(event);
  }
  clearTimeout(timer);
}

return finishSkillCheckedTurn(requiredSkills, skillLoads, () => finishAgentTurn(state, reply));
```

The checked wrapper must be after a successful SDK loop and own the only call to `finishAgentTurn`. Exceptions continue through the existing `/turn` or `/turn/stream` error path so Workers records the normal retryable `agent_error`; do not add Skill persistence or a new wire protocol.

- [ ] **Step 9: Remove transitional code**

- Remove the local `skillCalls` map and direct `startTraceEvent`/`finishTraceEvent` Skill handling from `agent/server.ts`.
- Remove the temporary `listSkills` alias from `agent/skills.ts`.
- Remove SDK, Zod, campaign-tool registration, `PLUGIN_NAME`, `SKILL_TRACE_TOOL`, and trace-helper imports from `agent/server.ts`; those belong in `agent/run-turn.ts` or are obsolete.
- Keep `agent/server.ts` limited to env/config, HTTP JSON/NDJSON transport, auth, and logging.
- Set `agent/tsconfig.json` include to `['server.ts', 'run-turn.ts', 'skills.ts']` at this stage.

- [ ] **Step 10: Add a Worker-level no-mutation failure test**

In `tests/conversation.test.ts`, simulate a Skill warning followed by a thrown contract error. Use a new example session so both the before and after snapshot are available:

```ts
test("a failed Skill load keeps the user input and warning trace without changing the activity", async () => {
  const d = deps();
  d.runAgent = async (_request, onTrace) => {
    const started = startTraceEvent({
      id: "skill-load-warning",
      tool: "load_campaign_skill",
      title: "加载业务规则：ICS-1811 字段解释",
      initiatedBy: "model",
      at: 100,
    });
    onTrace?.(started);
    onTrace?.(finishTraceEvent(started, {
      status: "warning",
      summary: "规则没有加载成功",
      at: 125,
    }));
    throw new Error("业务规则没有加载成功，请重试");
  };

  let snapshot = await createSession({ entryMode: "example" }, d);
  const beforeLatest = structuredClone(snapshot.latest);
  const beforeVersions = structuredClone(snapshot.versions);
  const text = "计折上折是什么意思";

  snapshot = await say(snapshot, d, text);

  assert.deepEqual(snapshot.latest, beforeLatest, "Skill 失败不能改变草稿、fill、sheet 或 seq");
  assert.deepEqual(snapshot.versions, beforeVersions, "Skill 失败不能创建版本");
  assert.deepEqual(
    snapshot.messages.slice(-3).map((message) => message.content.kind),
    ["user_text", "agent_tool_trace", "agent_error"],
  );
  assert.ok(snapshot.messages.some(
    (message) => message.role === "user" && message.content.kind === "user_text" && message.content.text === text,
  ), "失败时仍要保存用户原话");

  const trace = lastOfKind(snapshot, "agent_tool_trace");
  assert.ok(trace);
  assert.equal(trace.trace.status, "warning");
  assert.deepEqual(trace.trace.steps, [{
    id: "skill-load-warning",
    tool: "load_campaign_skill",
    title: "加载业务规则：ICS-1811 字段解释",
    status: "warning",
    initiatedBy: "model",
    startedAt: 100,
    summary: "规则没有加载成功",
    durationMs: 25,
  }]);

  const error = lastAgent(snapshot);
  assert.equal(error.kind, "agent_error");
  assert.match(error.kind === "agent_error" ? error.text : "", /业务规则没有加载成功，请重试/);
  assert.deepEqual(error.kind === "agent_error" && error.retry, { type: "text", text });
});
```

This proves the existing Workers transaction path preserves user input, draft, derived fill, sequence, and versions while persisting the safe warning trace and a retry action.

- [ ] **Step 11: Run deterministic SDK-wiring checks**

Run:

```bash
node --test --experimental-strip-types tests/skills.test.ts tests/agent-tools.test.ts tests/tool-trace.test.ts tests/conversation.test.ts
npx tsc -p agent/tsconfig.json
npx tsc --noEmit
```

Expected: PASS. Also inspect `agent/run-turn.ts` and verify exactly one built-in tool (`Skill`), exact catalog-derived Skills, nine existing campaign MCP tools, `settingSources: []`, and `maxTurns: 12`; inspect `agent/server.ts` to confirm it has no duplicate SDK wiring.

- [ ] **Step 12: Commit the SDK integration atomically**

```bash
git add agent/run-turn.ts agent/server.ts agent/skills.ts agent/tsconfig.json app/lib/agent/prompt.ts app/lib/agent/tools.ts tests/skills.test.ts tests/agent-tools.test.ts tests/conversation.test.ts
git diff --cached --check
git commit -m "feat: load campaign skills per turn"
```

This is the first commit that contains the promo gate. It also contains the production `loadedSkills` wiring, so no committed revision rejects all production promo-copy calls merely because the runner has not been connected yet.

---

### Task 6: Shrink the system prompt to routing and authority rules

**Files:**
- Modify: `app/lib/agent/prompt.ts`
- Modify: `tests/conversation.test.ts`

This task intentionally runs after the Skill catalog, load contract, promo gate, and production SDK runner are all enforced. It must not create a commit where knowledge has disappeared from both the prompt and runtime.

- [ ] **Step 1: Write failing system-prompt contract tests**

Add to the existing prompt test:

```ts
const system = buildAgentSystemPrompt("2026-09-17");
for (const qualified of [
  "ics1811:offer-entry-guide",
  "ics1811:field-explainer",
  "ics1811:settlement-guide",
  "ics1811:promo-copy-guide",
]) assert.match(system, new RegExp(qualified));

assert.match(system, /解释性问题不需要调用活动工具；需要业务知识时仍必须先用 Skill/);
assert.match(system, /活动工具和确定性代码结果优先于 Skill/);
assert.match(system, /Skill 不能声称已经保存、已经齐全或已经通过校验/);
assert.match(system, /每一轮都是新的/);
assert.doesNotMatch(system, /没加载成功，按已有规则继续/);
```

Run: `node --test --experimental-strip-types tests/conversation.test.ts`

Expected: FAIL until all four exact qualified names and authority statements are present.

- [ ] **Step 2: Replace only the system prompt's `## 业务规则` section**

Use this exact compact block:

```text
## 业务规则
解释、录入指导和对外文案规范放在本地 Skill 里。遇到对应请求必须先加载精确限定名，再回答或调用相关活动工具：
- 玩法、1811 录入方法、模式选择或是否支持：ics1811:offer-entry-guide
- 字段或业务名词的含义、区别和为什么要确认：ics1811:field-explainer
- 多门店、跨区域、结算说明函、文件命名或上传：ics1811:settlement-guide
- 起草、修改、评价宣传文案或讨论标语：ics1811:promo-copy-guide
每一轮都是新的；上一轮加载过的规则这一轮看不到。一轮只加载当前请求需要的规则，不要一次全加载。用户提示里的“必须先加载”是本轮最低要求，模型也可以按 Skill 描述补充加载其他真正相关的规则；任一加载失败都不要凭印象继续。
活动工具和确定性代码结果优先于 Skill。Skill 只负责解释和指导，不能声称已经保存、已经齐全或已经通过校验；规则与工具结果冲突时按工具结果办，并如实说明当前实际可执行结果。
```

Do not move tool schemas, `FACT_GUIDE`, `PROPOSAL_GUIDE`, quote requirements, question registration, or deterministic workflow instructions into Skills; the model still needs them to call the nine tools safely.

- [ ] **Step 3: Fix the explanatory-response sentence and promo tool instruction**

Replace the ambiguous reply rule with:

```text
- 用户问解释性问题且不需要读取或修改活动数据时，不需要调用活动工具；需要业务知识时仍必须先用 Skill 加载对应规则。
```

Make the `draft_promo_copy` tool description say `起草前必须先成功加载 ics1811:promo-copy-guide` rather than the unqualified phrase `怎么写先加载对外文案的规则`.

Keep intentional safety duplication for quote provenance, no invented numbers, slogan verbatim/legal confirmation, and tool capabilities. Remove any remaining prose that tries to teach field definitions, settlement rules, offer-entry mappings, or creative-writing style outside the Skills.

- [ ] **Step 4: Run prompt and conversation checks**

Run:

```bash
node --test --experimental-strip-types tests/conversation.test.ts tests/skills.test.ts
npx tsc --noEmit
npx tsc -p agent/tsconfig.json
```

Expected: PASS.

- [ ] **Step 5: Commit the prompt reduction**

```bash
git add app/lib/agent/prompt.ts tests/conversation.test.ts
git diff --cached --check
git commit -m "refactor: load campaign guidance from skills"
```

---

### Task 7: Add an optional real-SDK Skill delivery smoke test

**Files:**
- Create: `agent/skill-smoke.ts`
- Modify: `agent/tsconfig.json`
- Modify: `package.json`

This is a release check, not part of default CI. Deterministic tests remain the source of truth for routing and safety.

- [ ] **Step 1: Implement the smoke runner against the production Agent runner**

`agent/skill-smoke.ts` must import `createAgentRunner` from `agent/run-turn.ts`; it must not build a second SDK query, simplified prompt, or reduced tool set. Use this complete structure:

```ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { query } from "@anthropic-ai/claude-agent-sdk";

import type { AgentRequest } from "../app/lib/agent/protocol.ts";
import { applyFactWrites, createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
import { EXAMPLES } from "../app/lib/campaign/ics1811/examples.ts";
import type { Ics1811Draft } from "../app/lib/campaign/ics1811/types.ts";
import type { AgentTraceEvent, CampaignToolName } from "../app/lib/tool-trace.ts";
import { createAgentRunner, type AgentQuery } from "./run-turn.ts";
import { loadSkillCatalog, validateSkillSources } from "./skills.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLUGIN_DIR = join(REPO_ROOT, "agent/plugin");
const ENV_FILE = join(REPO_ROOT, ".dev.vars");
const TODAY = "2026-09-17";

const MUTATING_TOOLS = new Set<CampaignToolName>([
  "extract_campaign_facts",
  "accept_campaign_proposals",
  "ask_campaign_questions",
  "draft_campaign_copy",
  "draft_promo_copy",
  "undo_campaign_change",
]);

function readyDraft(): Ics1811Draft {
  const fixture = EXAMPLES.find((item) => item.id === "T1");
  if (!fixture) throw new Error("缺少 T1 验收夹具");
  const result = applyFactWrites(
    createEmptyDraft("skill-smoke", fixture.first),
    fixture.firstWrites,
    { text: fixture.first, today: TODAY },
  );
  if (result.dropped.length) throw new Error(`T1 夹具没有通过事实守卫：${JSON.stringify(result.dropped)}`);
  return result.draft;
}

function request(text: string, draft: Ics1811Draft = readyDraft()): AgentRequest {
  return {
    today: TODAY,
    draft: structuredClone(draft),
    history: [],
    trigger: { kind: "user_message", text },
    phase: "ready",
    openQuestions: [],
    proposals: [],
    canUndo: false,
  };
}

function failFirstSkillDelivery(onInjected: () => void): AgentQuery {
  return (params) => (async function*() {
    const skillToolUseIds = new Set<string>();
    let injected = false;

    for await (const message of query(params)) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use" && block.name === "Skill") {
            skillToolUseIds.add(block.id);
          }
        }
      }

      if (!injected && message.type === "user" && Array.isArray(message.message.content)) {
        const failed = structuredClone(message);
        if (!Array.isArray(failed.message.content)) throw new Error("SDK 用户消息结构在复制后改变");
        for (const block of failed.message.content) {
          if (block.type !== "tool_result" || !skillToolUseIds.has(block.tool_use_id)) continue;
          block.is_error = true;
          block.content = "发布探针注入：规则没有加载成功";
          injected = true;
          onInjected();
          break;
        }
        if (injected) {
          yield failed;
          continue;
        }
      }

      yield message;
    }
  })();
}

async function main() {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const apiKey = process.env.DEEPSEEK_API_KEY || "";
  if (!apiKey) throw new Error("缺少 DEEPSEEK_API_KEY，无法运行真实 Skill 冒烟测试");

  const catalog = loadSkillCatalog(PLUGIN_DIR);
  validateSkillSources(catalog, REPO_ROOT);
  const titleByQualified = new Map(catalog.map((skill) => [skill.qualifiedName, `加载业务规则：${skill.title}`]));
  const runtimeDir = mkdtempSync(join(tmpdir(), "ics1811-skill-smoke-"));
  const config = {
    model: process.env.AGENT_MODEL || "deepseek-flash",
    modelBaseUrl: process.env.AGENT_MODEL_BASE_URL || "https://api.deepseek.com/anthropic",
    apiKey,
    runtimeDir,
    pluginDir: PLUGIN_DIR,
    timeoutMs: 120_000,
  };

  const cases = [
    { name: "field", request: request("计折上折是什么意思"), expected: ["ics1811:field-explainer"] },
    { name: "offer", request: request("黄金以旧换新在 1811 怎么录"), expected: ["ics1811:offer-entry-guide"] },
    { name: "settlement", request: request("两家店要不要说明函"), expected: ["ics1811:settlement-guide"] },
    { name: "promo", request: request("帮我写一版宣传文案"), expected: ["ics1811:promo-copy-guide"] },
    {
      name: "plain-facts",
      request: {
        ...request(EXAMPLES.find((item) => item.id === "T1")?.first ?? ""),
        draft: createEmptyDraft("skill-smoke-plain", EXAMPLES.find((item) => item.id === "T1")?.first ?? ""),
        trigger: { kind: "first_message" as const, text: EXAMPLES.find((item) => item.id === "T1")?.first ?? "" },
        phase: "interpreting" as const,
      },
      expected: [],
    },
  ] as const;

  try {
    const runner = createAgentRunner(config);
    for (const item of cases) {
      const events: AgentTraceEvent[] = [];
      const before = structuredClone(item.request.draft);
      const result = await runner(item.request, (event) => events.push(event));
      const actualTitles = [...new Set(events
        .filter((event) => event.tool === "load_campaign_skill" && event.status === "completed")
        .map((event) => event.title))].sort();
      const expectedTitles = item.expected.map((name) => titleByQualified.get(name) ?? `缺少 ${name}`).sort();
      assert.deepEqual(actualTitles, expectedTitles, `${item.name} 加载的 Skill 不对`);

      if (item.name === "field") {
        assert.ok(result.reply, "字段解释必须返回知识回复");
        assert.match(result.reply, /销售提成|提成/, "字段解释必须说明这是提成口径");
        assert.match(result.reply, /实际售价/, "字段解释必须采用 Skill 中的实际售价口径");
        assert.match(result.reply, /不是.{0,12}(?:优惠)?叠加|(?:优惠)?叠加.{0,12}不是/, "字段解释不能把计折上折误作优惠叠加");
        assert.deepEqual(result.draft, before, "字段解释不能修改草稿");
        assert.equal(result.tools.some((name) => MUTATING_TOOLS.has(name)), false, "字段解释不能调用修改型活动工具");
      }
      if (item.name === "offer") {
        assert.ok(result.reply, "玩法录入必须返回知识回复");
        assert.match(result.reply, /固定折扣/, "黄金以旧换新必须说明固定折扣模式");
        assert.match(result.reply, /1815/, "黄金以旧换新必须说明建完后的 1815 动作");
        assert.match(result.reply, /19/, "黄金以旧换新必须说明活动分组编号 19");
        assert.match(result.reply, /增值服务/, "黄金以旧换新必须说明活动分组为增值服务");
        assert.deepEqual(result.draft, before, "玩法解释不能修改草稿");
      }
      if (item.name === "settlement") {
        assert.ok(result.reply, "结算说明函解释必须返回知识回复");
        assert.match(result.reply, /多家|两家|多店/, "回复必须把规则限定在多店场景");
        assert.match(result.reply, /结算说明函/, "回复必须明确讨论结算说明函");
        assert.match(result.reply, /上传/, "多店规则必须说明需要上传");
        assert.doesNotMatch(result.reply, /单店.{0,12}(?:一定)?不需要|跨月.{0,20}开始月份/, "不能补写材料未确认的单店或跨月规则");
        assert.deepEqual(result.draft, before, "结算解释不能修改草稿");
      }
      if (item.name === "promo") {
        const skillDone = events.findIndex((event) =>
          event.tool === "load_campaign_skill" && event.status === "completed" && event.title === titleByQualified.get("ics1811:promo-copy-guide"));
        const copyStarted = events.findIndex((event) => event.tool === "draft_promo_copy" && event.status === "started");
        assert.ok(skillDone >= 0 && copyStarted > skillDone, "宣传文案必须先加载规则再调用文案工具");
        assert.ok(result.tools.includes("draft_promo_copy"));
        assert.ok(result.draft.promo, "宣传文案工具应产出 promo 草稿");
      }
      if (item.name === "plain-facts") {
        assert.equal(events.some((event) => event.tool === "load_campaign_skill"), false);
        assert.ok(result.tools.includes("extract_campaign_facts"));
      }
      console.log(`PASS ${item.name}`);
    }

    const deliveryEvents: AgentTraceEvent[] = [];
    let deliveryFailureInjected = false;
    let deliveryReturned = false;
    const deliveryRunner = createAgentRunner(config, {
      query: failFirstSkillDelivery(() => {
        deliveryFailureInjected = true;
      }),
    });
    await assert.rejects(
      async () => {
        await deliveryRunner(request("计折上折是什么意思"), (event) => {
          deliveryEvents.push(event);
        });
        deliveryReturned = true;
      },
    );
    assert.equal(deliveryFailureInjected, true, "交付失败探针必须改写真实 SDK 的 Skill 结果");
    assert.equal(deliveryReturned, false, "Skill 交付失败后不能返回知识结果");
    assert.ok(deliveryEvents.some((event) =>
      event.tool === "load_campaign_skill" &&
      event.status === "warning" &&
      event.summary === "规则没有加载成功"
    ), "真实 Skill 读取失败必须产生安全 warning");
    console.log("PASS sdk-delivery-failure");

    const broken = createAgentRunner({ ...config, pluginDir: join(REPO_ROOT, "agent/plugin-missing") });
    await assert.rejects(() => broken(request("计折上折是什么意思")));
    console.log("PASS missing-plugin");
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
```

Each runner call creates a fresh SDK query with the real production system prompt, user prompt, exact Skill whitelist, campaign MCP tools, event pairing, promo gate, and postcondition. Unexpected extra completed Skills fail the case. The three knowledge cases also assert source-backed semantic invariants, so merely loading the right Skill while returning contradictory knowledge cannot pass.

- [ ] **Step 2: Keep both real delivery-failure and deployment-failure probes**

The `sdk-delivery-failure` case runs the real SDK query, observes the real native `Skill` tool-use/result pair, and deterministically rewrites the first matching result to `is_error: true` at the runner's SDK boundary. It must produce a warning and reject the turn without returning the model's knowledge answer. This avoids filesystem timing races while exercising the production prompt, plugin, model call, event pairing, and fail-closed postcondition. The adapter may alter only that one yielded result; it must not synthesize assistant text, bypass the real query, or change the production default dependency.

The final `plugin-missing` assertion fails in `loadSkillCatalog` before the SDK query. It separately proves that a broken deployment cannot return an ungrounded normal answer. Do not replace either case with a fake Skill response.

- [ ] **Step 3: Register the optional command and type-check target**

Add to root `package.json`:

```json
"test:skills:live": "node --experimental-strip-types agent/skill-smoke.ts"
```

Add `skill-smoke.ts` to `agent/tsconfig.json`'s `include` list. Do not add the live command to `npm test`, `lint`, or build CI.

- [ ] **Step 4: Verify without requiring credentials in CI**

Run:

```bash
npx tsc -p agent/tsconfig.json
```

Expected: PASS.

If a valid key is available, also run:

```bash
npm run test:skills:live
```

Expected: six PASS lines, including the missing-plugin failure case. If no key is available, record the smoke test as `未运行：缺少有效模型密钥`; do not weaken deterministic tests.

- [ ] **Step 5: Commit the optional smoke harness**

```bash
git add agent/skill-smoke.ts agent/tsconfig.json package.json
git diff --cached --check
git commit -m "test: add live skill delivery smoke check"
```

---

### Task 8: Document Skill maintenance, reload behavior, and deployment packaging

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update the architecture wording**

In all three docs, replace claims that all SDK built-ins are disabled with the current contract:

- the only enabled SDK built-in is `Skill`;
- exactly nine campaign tools are provided through the local MCP server;
- `settingSources: []` keeps user/project Claude settings isolated;
- the exact Skill whitelist comes from the validated local `ics1811` plugin;
- Skills explain and guide, while deterministic TypeScript remains authoritative.

Use the actual nine campaign tool names from `AGENT_TOOL_NAMES`; do not retain README's obsolete eight-tool list or AGENTS.md's obsolete four-tool list.

Use this architecture wording, adapting only the surrounding heading level:

```markdown
Agent 服务通过 Claude Agent SDK 运行一轮对话。SDK 内置工具只开放 `Skill`；活动读写由本地 MCP server 的 9 个确定性工具完成。`settingSources: []` 隔离个人和项目 Claude 配置，运行时只允许经过校验的 `ics1811` 本地插件 Skill。Skill 负责解释、录入指导和文案规范；事实、填写值、缺项、校验和落库仍以 TypeScript 工具结果为准。
```

- [ ] **Step 2: Add a `维护运行时 Skills` section**

Document this developer workflow:

1. edit or add `agent/plugin/skills/<name>/SKILL.md`;
2. include only repository-backed rules and cite every rule entry;
3. keep the six required sections and frontmatter contract;
4. run `node --test --experimental-strip-types tests/skills.test.ts` and both type checks;
5. review the diff through Git like code;
6. do not place executable field mapping, defaults, code tables, or guards in Skills.

State that the four baseline Skills cannot be removed or renamed without updating the baseline list and tests. Additional valid Skills are auto-discovered and enter the exact whitelist.

Add this exact section to the developer-facing docs; README may use the same body under its existing development section:

```markdown
## 维护运行时 Skills

- 业务 Skill 位于 `agent/plugin/skills/<name>/SKILL.md`，只整理仓库已有、能在 `出处` 中定位的规则。
- 每份 Skill 只允许 `name`、`description` 两个 frontmatter 字段，正文依次包含 `适用场景`、`回答原则`、`业务知识`、`不能做什么`、`冲突处理`、`出处`。前五节每条规则都要引用 `[S#]`。
- 四个基线 Skill 不能直接删除或改名；需要调整时同步修改 `BASELINE_SKILL_NAMES` 和测试。新增且校验通过的 Skill 会自动进入精确白名单。
- Skill 只放解释和写作指导。字段映射、默认值、代码表、事实守卫、缺项、校验和落库规则继续放在 TypeScript 中。
- 修改后运行 `node --test --experimental-strip-types tests/skills.test.ts`、`npx tsc --noEmit` 和 `npx tsc -p agent/tsconfig.json`，再通过 Git diff 和代码评审合入。
```

- [ ] **Step 3: Correct hot-reload guidance**

Document the split precisely:

- changing `agent/plugin/skills/*/SKILL.md` is picked up on the next Agent turn without restarting `dev:agent`;
- changing `agent/skills.ts`, `agent/server.ts`, `app/lib/agent/`, or `app/lib/campaign/ics1811/` still requires restarting `dev:agent`;
- a malformed Skill makes the next turn fail explicitly instead of silently disabling knowledge.

- [ ] **Step 4: Add deployment packaging verification**

State that the Agent artifact must include:

```text
agent/plugin/.claude-plugin/plugin.json
agent/plugin/skills/*/SKILL.md
```

It does not need `docs/` or `references/` at runtime. Add this release check:

```bash
test -f agent/plugin/.claude-plugin/plugin.json
test "$(find agent/plugin/skills -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')" -ge 4
```

Mention `npm run test:skills:live` as an optional pre-release SDK check requiring a valid key.

- [ ] **Step 5: Review terminology and commit**

Run:

```bash
rg -n "tools: \[\]|内置工具全部关闭|只挂 4 个工具|只挂 8 个活动工具" README.md CLAUDE.md AGENTS.md
```

Expected: no stale runtime descriptions; historical text, if any, must be clearly labeled historical.

Then:

```bash
git add README.md CLAUDE.md AGENTS.md
git diff --cached --check
git commit -m "docs: explain runtime skill maintenance"
```

---

### Task 9: Run complete verification and perform release review

**Files:**
- Verify only; fix failures in the owning task's files and rerun its focused tests before rerunning the suite.

- [ ] **Step 1: Verify runtime and repository state**

Run:

```bash
node --version
git status --short
git log --oneline -8
```

Expected: Node `>=22.13`. Confirm no unrelated dirty files were staged or overwritten.

- [ ] **Step 2: Run the deterministic suite and static validation**

Run in order:

```bash
git diff --check
npm test
npx tsc --noEmit
npx tsc -p agent/tsconfig.json
npm run lint
npm run build
```

Expected: every command exits 0. Do not claim success from an old run; capture the current outputs.

- [ ] **Step 3: Verify the deployed plugin shape and source independence**

Run:

```bash
test -f agent/plugin/.claude-plugin/plugin.json
find agent/plugin/skills -mindepth 2 -maxdepth 2 -name SKILL.md -print | sort
node --test --experimental-strip-types tests/skills.test.ts
```

Expected: exactly the four baseline files plus any intentionally reviewed additions; runtime catalog fixture tests prove source files are not required in a deployed plugin-only tree, while `validateSkillSources` proves all repository sources exist in CI.

- [ ] **Step 4: Run the optional real-SDK smoke check when credentials allow**

Run: `npm run test:skills:live`

Expected: all baseline, no-Skill, and missing-plugin cases pass. If credentials are unavailable, explicitly report this as the only skipped optional check.

- [ ] **Step 5: Inspect the final diff against the approved boundaries**

Run:

```bash
git diff --stat 5c7990b..HEAD
git diff 5c7990b..HEAD -- agent/plugin agent/skills.ts agent/run-turn.ts agent/server.ts agent/skill-smoke.ts app/lib/agent/prompt.ts app/lib/agent/tools.ts app/lib/tool-trace.ts tests README.md CLAUDE.md AGENTS.md package.json
```

Confirm:

- no database, HTTP protocol, client schema, or UI component changed;
- no deterministic business rule was deleted or weakened;
- no code table was copied into a Skill;
- every Skill statement is traceable to a repository source;
- prompt text contains routing and authority rules, not duplicate Skill bodies;
- production runtime does not require source documents;
- every failed/unknown/pending Skill load ends as a warning trace and failed turn;
- ordinary factual input requires no Skill when the catalog is healthy;
- promo copy cannot run without the same-turn guide.

- [ ] **Step 6: Request code review and address findings**

Use the `requesting-code-review` skill on the complete branch. Ask the reviewer to focus on fail-closed behavior, source fidelity, SDK whitelist semantics, trace privacy, and unchanged deterministic guards. Fix every confirmed issue, rerun the owning focused tests, then rerun Step 2.

- [ ] **Step 7: Prepare the handoff**

Run:

```bash
git status --short
git log --oneline -8
```

Report the commits, verification commands, optional live-smoke status, and any pre-existing unrelated dirty files left untouched. Do not merge or push unless the user separately asks.

---

## Appendix A: Final `agent/skills.ts`

Tasks 2–4 build this file incrementally. After Task 4, its complete content must be:

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AgentRequest } from "../app/lib/agent/protocol.ts";
import {
  finishTraceEvent,
  SKILL_TRACE_TOOL,
  startTraceEvent,
  type AgentTraceEvent,
} from "../app/lib/tool-trace.ts";

export const PLUGIN_NAME = "ics1811";

export const BASELINE_SKILL_NAMES = [
  "offer-entry-guide",
  "field-explainer",
  "settlement-guide",
  "promo-copy-guide",
] as const;

export type BaselineSkillName = (typeof BASELINE_SKILL_NAMES)[number];

export type SkillSource = {
  id: string;
  path: string;
  note?: string;
};

export type SkillInfo = {
  name: string;
  qualifiedName: string;
  title: string;
  description: string;
  relativePath: string;
  sources: readonly SkillSource[];
};

export class SkillCatalogError extends Error {
  readonly relativePath: string;
  readonly detail: string;

  constructor(relativePath: string, detail: string) {
    super(`${relativePath}：${detail}`);
    this.name = "SkillCatalogError";
    this.relativePath = relativePath;
    this.detail = detail;
  }
}

const REQUIRED_SECTIONS = [
  "适用场景",
  "回答原则",
  "业务知识",
  "不能做什么",
  "冲突处理",
  "出处",
] as const;

const RULE_SECTIONS = REQUIRED_SECTIONS.slice(0, 5);
const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_SUFFIX = /(?:\s*\[S[1-9]\d*\])+\s*$/;
const SOURCE_DEFINITION = /^- \[(S[1-9]\d*)\] `([^`]+)`(?: — (.+))?$/;
const PLACEHOLDER = /(?:\bTODO\b|\bTBD\b|以后补)/i;

type ParsedSkill = {
  directoryName: string;
  info: SkillInfo;
};

type PendingSkillLoad = {
  skill: SkillInfo | null;
  started: AgentTraceEvent;
};

export type SkillLoadState = {
  pending: Map<string, PendingSkillLoad>;
  loadedSkills: Set<string>;
  skillLoadFailed: boolean;
};

function fail(relativePath: string, detail: string): never {
  throw new SkillCatalogError(relativePath, detail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readText(absolutePath: string, relativePath: string): string {
  try {
    return readFileSync(absolutePath, "utf8").replace(/\r\n?/g, "\n");
  } catch {
    return fail(relativePath, "文件不存在或无法读取");
  }
}

function readDirectory(absolutePath: string, relativePath: string) {
  try {
    return readdirSync(absolutePath, { withFileTypes: true });
  } catch {
    return fail(relativePath, "目录不存在或无法读取");
  }
}

function lineCount(text: string): number {
  const withoutFinalNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutFinalNewline ? withoutFinalNewline.split("\n").length : 0;
}

function parseFrontmatter(
  text: string,
  relativePath: string,
): { name: string; description: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!match) fail(relativePath, "缺少合法的 YAML frontmatter");

  const metadata: Record<string, string> = {};
  for (const rawLine of match[1].split("\n")) {
    if (!rawLine.trim()) fail(relativePath, "frontmatter 不接受空行");
    const line = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(rawLine);
    if (!line) fail(relativePath, `frontmatter 只支持单行字段：${rawLine}`);
    const key = line[1];
    const value = line[2].trim();
    if (key !== "name" && key !== "description") fail(relativePath, `frontmatter 含未知字段 ${key}`);
    if (Object.hasOwn(metadata, key)) fail(relativePath, `frontmatter 字段 ${key} 重复`);
    metadata[key] = value;
  }

  const name = metadata.name ?? "";
  const description = metadata.description ?? "";
  if (!name) fail(relativePath, "frontmatter 缺少 name");
  if (!SKILL_NAME.test(name)) fail(relativePath, "name 只能由小写字母、数字和连字符组成，最长 64 个字符");
  if (!description) fail(relativePath, "description 不能为空");
  if ([...description].length > 1024) fail(relativePath, "description 不能超过 1024 个字符");

  return { name, description, body: text.slice(match[0].length) };
}

function validateSourcePath(sourcePath: string, sourceLine: string, relativePath: string): void {
  if (
    sourcePath !== sourcePath.trim() ||
    isAbsolute(sourcePath) ||
    sourcePath.startsWith("/") ||
    sourcePath.includes("\\") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/i.test(sourcePath) ||
    sourcePath.split("/").some((part) => !part || part === "." || part === "..")
  ) fail(relativePath, `出处必须是仓库内的相对路径：${sourcePath}`);
  if (/https?:\/\//i.test(sourceLine)) fail(relativePath, "出处不能使用外部 URL");
}

function parseSkill(directoryName: string, text: string, relativePath: string): ParsedSkill {
  if (lineCount(text) > 500) fail(relativePath, "SKILL.md 不能超过 500 行");
  if (PLACEHOLDER.test(text)) fail(relativePath, "SKILL.md 不能含 TODO、TBD 或“以后补”占位文字");

  const { name, description, body } = parseFrontmatter(text, relativePath);
  const lines = body.split("\n");
  const firstLevelHeadings = lines.flatMap((line, index) => {
    const match = /^# (.+)$/.exec(line);
    return match ? [{ index, title: match[1].trim() }] : [];
  });
  if (firstLevelHeadings.length !== 1 || !firstLevelHeadings[0].title) {
    fail(relativePath, "正文必须且只能有一个非空一级标题");
  }

  const sectionHeadings = lines.flatMap((line, index) => {
    const match = /^## (.+)$/.exec(line);
    return match ? [{ index, name: match[1].trim() }] : [];
  });
  const actualSections = sectionHeadings.map((item) => item.name);
  if (
    actualSections.length !== REQUIRED_SECTIONS.length ||
    REQUIRED_SECTIONS.some((section, index) => actualSections[index] !== section)
  ) fail(relativePath, `二级章节必须按顺序且各出现一次：${REQUIRED_SECTIONS.join("、")}`);
  if (firstLevelHeadings[0].index >= sectionHeadings[0].index) fail(relativePath, "一级标题必须位于所有二级章节之前");

  for (let index = 0; index < sectionHeadings[0].index; index += 1) {
    if (index === firstLevelHeadings[0].index || !lines[index].trim()) continue;
    fail(relativePath, "一级标题与“适用场景”之间不能有其他正文");
  }

  const referencedSources = new Set<string>();
  let firstUsageRule: string | null = null;
  for (let sectionIndex = 0; sectionIndex < RULE_SECTIONS.length; sectionIndex += 1) {
    const section = sectionHeadings[sectionIndex];
    const end = sectionHeadings[sectionIndex + 1].index;
    const rules = lines.slice(section.index + 1, end).map((line) => line.trim()).filter(Boolean);
    if (!rules.length) fail(relativePath, `“${section.name}”至少要有一条规则`);
    for (const rule of rules) {
      if (!rule.startsWith("- ")) fail(relativePath, `“${section.name}”中的每条规则都必须是单行列表项`);
      const suffix = SOURCE_SUFFIX.exec(rule)?.[0];
      if (!suffix) fail(relativePath, `“${section.name}”中的规则缺少末尾来源编号：${rule}`);
      const ruleText = rule.slice(2).replace(SOURCE_SUFFIX, "").trim();
      if (!ruleText) fail(relativePath, `“${section.name}”含空规则`);
      for (const source of suffix.matchAll(/\[(S[1-9]\d*)\]/g)) referencedSources.add(source[1]);
      if (sectionIndex === 0 && firstUsageRule === null) firstUsageRule = ruleText;
    }
  }
  if (firstUsageRule !== description) {
    fail(relativePath, "“适用场景”第一条移除来源编号后必须与 description 完全一致");
  }

  const sourceHeading = sectionHeadings[sectionHeadings.length - 1];
  const sourceLines = lines.slice(sourceHeading.index + 1).map((line) => line.trim()).filter(Boolean);
  if (!sourceLines.length) fail(relativePath, "“出处”至少要定义一个来源");
  const sourceIds = new Set<string>();
  const sources: SkillSource[] = [];
  for (const sourceLine of sourceLines) {
    const match = SOURCE_DEFINITION.exec(sourceLine);
    if (!match) fail(relativePath, `出处格式应为“- [S1] \`仓库相对路径\` — 定位说明”：${sourceLine}`);
    const id = match[1];
    const sourcePath = match[2];
    const note = match[3]?.trim();
    if (sourceIds.has(id)) fail(relativePath, `出处编号 ${id} 重复`);
    validateSourcePath(sourcePath, sourceLine, relativePath);
    sourceIds.add(id);
    sources.push({ id, path: sourcePath, ...(note ? { note } : {}) });
  }
  for (const id of referencedSources) if (!sourceIds.has(id)) fail(relativePath, `正文引用了未定义的出处 ${id}`);
  for (const id of sourceIds) if (!referencedSources.has(id)) fail(relativePath, `出处 ${id} 没有被正文引用`);

  return {
    directoryName,
    info: {
      name,
      qualifiedName: `${PLUGIN_NAME}:${name}`,
      title: firstLevelHeadings[0].title,
      description,
      relativePath,
      sources,
    },
  };
}

function validatePluginManifest(pluginDir: string): void {
  const relativePath = ".claude-plugin/plugin.json";
  const text = readText(resolve(pluginDir, relativePath), relativePath);
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    fail(relativePath, "插件清单不是有效的 JSON");
  }
  if (!isRecord(manifest) || manifest.name !== PLUGIN_NAME) fail(relativePath, `插件名必须是 ${PLUGIN_NAME}`);
}

export function loadSkillCatalog(pluginDir: string): readonly SkillInfo[] {
  validatePluginManifest(pluginDir);
  const skillsDir = resolve(pluginDir, "skills");
  const entries = readDirectory(skillsDir, "skills");
  const parsed: ParsedSkill[] = [];

  for (const entry of entries) {
    const entryPath = `skills/${entry.name}`;
    if (!entry.isDirectory()) fail(entryPath, "skills 目录下只能放 Skill 子目录");
    const absoluteSkillDir = resolve(skillsDir, entry.name);
    const children = readDirectory(absoluteSkillDir, entryPath);
    if (children.length !== 1 || children[0].name !== "SKILL.md" || !children[0].isFile()) {
      fail(entryPath, "每个 Skill 目录必须且只能包含一个可读的 SKILL.md");
    }
    const relativePath = `${entryPath}/SKILL.md`;
    parsed.push(parseSkill(
      entry.name,
      readText(resolve(absoluteSkillDir, "SKILL.md"), relativePath),
      relativePath,
    ));
  }

  const declaredNames = new Map<string, string>();
  for (const skill of parsed) {
    const previous = declaredNames.get(skill.info.name);
    if (previous) fail(skill.info.relativePath, `name ${skill.info.name} 与 ${previous} 重复`);
    declaredNames.set(skill.info.name, skill.info.relativePath);
  }
  for (const skill of parsed) {
    if (skill.info.name !== skill.directoryName) {
      fail(skill.info.relativePath, `name ${skill.info.name} 必须与目录名 ${skill.directoryName} 一致`);
    }
  }

  const names = new Set(parsed.map((skill) => skill.info.name));
  const missing = BASELINE_SKILL_NAMES.filter((name) => !names.has(name));
  if (missing.length) fail("skills", `缺少基线 Skill：${missing.join("、")}`);

  const sorted = parsed
    .map((skill) => Object.freeze({
      ...skill.info,
      sources: Object.freeze([...skill.info.sources]),
    }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return Object.freeze(sorted);
}

export function validateSkillSources(catalog: readonly SkillInfo[], repoRoot: string): void {
  const absoluteRoot = resolve(repoRoot);
  for (const skill of catalog) {
    for (const source of skill.sources) {
      const absoluteSource = resolve(absoluteRoot, source.path);
      const fromRoot = relative(absoluteRoot, absoluteSource);
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        fail(skill.relativePath, `出处越出仓库：${source.path}`);
      }
      if (!existsSync(absoluteSource)) fail(skill.relativePath, `出处路径不存在：${source.path}`);
    }
  }
}

export function qualifiedSkillNames(catalog: readonly SkillInfo[]): string[] {
  return catalog.map((skill) => skill.qualifiedName);
}

export function skillOf(catalog: readonly SkillInfo[], requested: unknown): SkillInfo | null {
  if (typeof requested !== "string") return null;
  const name = requested.startsWith(`${PLUGIN_NAME}:`)
    ? requested.slice(PLUGIN_NAME.length + 1)
    : requested;
  return catalog.find((skill) => skill.name === name) ?? null;
}

const FIELD_TOPIC = /计折上折|折上折|固定(?:折扣)?模式|浮动(?:折扣)?模式|固定(?:折扣)?(?:模式)?(?:和|与|、|还是|或)浮动(?:折扣)?(?:模式)?|浮动(?:折扣)?(?:模式)?(?:和|与|、|还是|或)固定(?:折扣)?(?:模式)?|让扣点|回款率|货品范围|货类明细|货类|售价类型|限制条件|餐牌|活动分组/;
const EXPLANATION_INTENT = /什么意思|是什么意思|什么含义|怎么理解|如何理解|有什么区别|区别是什么|有什么差别|差别是什么|为什么(?:要|需要)?(?:问|填|确认)|解释|含义|指什么/;
const OFFER_TOPIC = /折扣|打(?:\d+(?:\.\d+)?)?折|满减|克减|每克减|以旧换新|以小换大|换购|outlet|转餐牌|累加|抽奖|签到|优惠玩法|活动玩法|优惠开单|1811/;
const ENTRY_INTENT = /怎么录|如何录|怎样录|怎么填|如何填|怎样填|怎么建|如何建|怎样建|怎么创建|如何创建|该选|应该选|选哪个|怎么选|如何选择|是否支持|支不支持|能不能(?:做|录|建)|可以(?:做|录|建)吗|适不适用|怎么处理|如何处理/;
const SUPPORT_INTENT = /是否支持|支不支持|支持.{0,12}吗|能不能|能(?:做|录|建)吗|可以吗|可不可以|适不适用|是不是超出|是否超出/;
const SETTLEMENT_TOPIC = /结算说明函|说明函|跨区域|跨区|多门店|多家(?:门店|店)|两家(?:门店|店)|单店|文件命名|上传流程/;
const SETTLEMENT_INTENT = /要不要|是否|需不需要|需要吗|怎么|如何|怎样|什么|规则|处理|命名|上传|确认|可以|能否/;
const PROMO_TOPIC = /宣传文案|活动文案|对外文案|推广文案|主标题|卖点|标语|宣传语/;
const PROMO_INTENT = /帮我|请|起草|写一版|写个|改写|修改|润色|优化|评价|点评|看看|讨论|建议|怎么写|如何写|要不要|是否合适|怎么样/;
const EXPLAIN_THEN_ENTER = /(?:(?:解释|说明).*(?:区别|差别).*(?:怎么|如何|怎样).*(?:录|填|建|创建)|(?:怎么|如何|怎样).*(?:录|填|建|创建).*(?:解释|说明).*(?:区别|差别))/;

export function requiredSkillsForTurn(
  request: Pick<AgentRequest, "trigger">,
): BaselineSkillName[] {
  const text = request.trigger.text.replace(/\s+/g, "").toLowerCase();
  const required = new Set<BaselineSkillName>();
  const fieldTopic = FIELD_TOPIC.test(text);
  const explanation = EXPLANATION_INTENT.test(text);
  const offerTopic = OFFER_TOPIC.test(text);
  const entry = ENTRY_INTENT.test(text);
  const explainThenEnter = EXPLAIN_THEN_ENTER.test(text);

  if ((fieldTopic && explanation) || explainThenEnter) required.add("field-explainer");
  if (
    explainThenEnter ||
    (entry && (offerTopic || fieldTopic)) ||
    (offerTopic && SUPPORT_INTENT.test(text)) ||
    (offerTopic && explanation && !fieldTopic)
  ) required.add("offer-entry-guide");
  if (SETTLEMENT_TOPIC.test(text) && SETTLEMENT_INTENT.test(text)) required.add("settlement-guide");
  if (PROMO_TOPIC.test(text) && PROMO_INTENT.test(text)) required.add("promo-copy-guide");
  return BASELINE_SKILL_NAMES.filter((name) => required.has(name));
}

export function createSkillLoadState(): SkillLoadState {
  return { pending: new Map(), loadedSkills: new Set(), skillLoadFailed: false };
}

export function beginSkillLoad(
  catalog: readonly SkillInfo[],
  state: SkillLoadState,
  input: { id: string; requested: unknown; at: number },
): AgentTraceEvent {
  if (state.pending.has(input.id)) {
    state.skillLoadFailed = true;
    throw new Error(`业务规则工具调用编号重复：${input.id}`);
  }
  const skill = skillOf(catalog, input.requested);
  if (!skill) state.skillLoadFailed = true;
  const started = startTraceEvent({
    id: input.id,
    tool: SKILL_TRACE_TOOL,
    title: `加载业务规则：${skill?.title ?? "未知规则"}`,
    initiatedBy: "model",
    at: input.at,
  });
  state.pending.set(input.id, { skill, started });
  return started;
}

export function finishSkillLoad(
  state: SkillLoadState,
  input: { toolUseId: string; isError: boolean; at: number },
): AgentTraceEvent | null {
  const pending = state.pending.get(input.toolUseId);
  if (!pending) return null;
  state.pending.delete(input.toolUseId);
  const failed = input.isError || pending.skill === null;
  if (failed) state.skillLoadFailed = true;
  else state.loadedSkills.add(pending.skill.name);
  return finishTraceEvent(pending.started, {
    status: failed ? "warning" : "completed",
    summary: failed ? "规则没有加载成功" : "已读取这份规则",
    at: input.at,
  });
}

export function finishPendingSkillLoads(state: SkillLoadState, at: number): AgentTraceEvent[] {
  const events = [...state.pending.values()].map((pending) => finishTraceEvent(pending.started, {
    status: "warning",
    summary: "规则没有加载成功",
    at,
  }));
  if (events.length) state.skillLoadFailed = true;
  state.pending.clear();
  return events;
}

export function assertSkillTurnContract(
  required: readonly BaselineSkillName[],
  state: SkillLoadState,
): void {
  if (state.pending.size || state.skillLoadFailed) throw new Error("业务规则没有加载成功，请重试");
  const missing = required.filter((name) => !state.loadedSkills.has(name));
  if (missing.length) throw new Error(`本回合缺少必需的业务规则：${missing.map((name) => `${PLUGIN_NAME}:${name}`).join("、")}`);
}

export function finishSkillCheckedTurn<T>(
  required: readonly BaselineSkillName[],
  state: SkillLoadState,
  finish: () => T,
): T {
  assertSkillTurnContract(required, state);
  return finish();
}
```
---

## Appendix B: Final `tests/skills.test.ts`

Tasks 1–4 grow this test file in RED/GREEN order. After Task 4, use this complete suite:

```ts
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BASELINE_SKILL_NAMES,
  PLUGIN_NAME,
  SkillCatalogError,
  assertSkillTurnContract,
  beginSkillLoad,
  createSkillLoadState,
  finishPendingSkillLoads,
  finishSkillCheckedTurn,
  finishSkillLoad,
  loadSkillCatalog,
  qualifiedSkillNames,
  requiredSkillsForTurn,
  skillOf,
  validateSkillSources,
} from "../agent/skills.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const BUNDLED_PLUGIN_DIR = join(REPO_ROOT, "agent/plugin");

const DESCRIPTIONS: Record<string, string> = {
  "offer-entry-guide": "解释 ICS-1811 优惠玩法、录入方式和不支持场景。用户询问打折、满减、克减、以旧换新、以小换大、固定或浮动折扣模式以及 1811 如何录入时使用。",
  "field-explainer": "解释 ICS-1811 字段和业务名词。用户询问计折上折、固定或浮动折扣、让扣点、回款率、货品范围、货类、售价类型、限制条件、活动分组的含义或为什么需要确认时使用。",
  "settlement-guide": "解释单店、多店、跨区域活动的结算说明函处理。用户询问是否需要说明函、文件命名、上传流程或门店跨区域时使用。",
  "promo-copy-guide": "指导 ICS-1811 活动对外宣传文案和标语。用户要求起草、修改、评价宣传文案或讨论活动标语时使用。",
};

function descriptionFor(name: string): string {
  return DESCRIPTIONS[name] ?? `解释 ${name} 的仓库业务规则。用户明确询问 ${name} 时使用。`;
}

function skillText(name: string, description = descriptionFor(name)): string {
  return `---
name: ${name}
description: ${description}
---
# ${name}

## 适用场景

- ${description}[S1]

## 回答原则

- 只解释有仓库出处的规则。[S1]

## 业务知识

- 这是用于测试目录合同的业务知识。[S1]

## 不能做什么

- 不能替确定性代码写入业务字段。[S1]

## 冲突处理

- 与工具结果冲突时，以工具结果为准。[S1]

## 出处

- [S1] \`docs/source.md\` — 测试出处
`;
}

function writeSkill(pluginDir: string, directoryName: string, text = skillText(directoryName)): void {
  const directory = join(pluginDir, "skills", directoryName);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), text);
}

function fixture(t: TestContext): { root: string; pluginDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ics1811-skills-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginDir = join(root, "agent/plugin");
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(pluginDir, "skills"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(pluginDir, ".claude-plugin/plugin.json"), JSON.stringify({
    name: PLUGIN_NAME,
    version: "0.1.0",
    description: "测试插件",
  }));
  writeFileSync(join(root, "docs/source.md"), "# 测试出处\n");
  for (const name of BASELINE_SKILL_NAMES) writeSkill(pluginDir, name);
  return { root, pluginDir };
}

function route(text: string) {
  return requiredSkillsForTurn({ trigger: { kind: "user_message", text } });
}

test("仓库内置 Skill 目录完整、来源存在且白名单精确", () => {
  const catalog = loadSkillCatalog(BUNDLED_PLUGIN_DIR);
  assert.deepEqual(catalog.map((skill) => skill.name), [
    "field-explainer",
    "offer-entry-guide",
    "promo-copy-guide",
    "settlement-guide",
  ]);
  assert.deepEqual(
    qualifiedSkillNames(catalog),
    catalog.map((skill) => `${PLUGIN_NAME}:${skill.name}`),
  );
  assert.doesNotThrow(() => validateSkillSources(catalog, REPO_ROOT));
});

test("发现四个基线 Skill 和新增 Skill，并按名字排序", (t) => {
  const { root, pluginDir } = fixture(t);
  writeSkill(pluginDir, "z-extra-guide");
  const catalog = loadSkillCatalog(pluginDir);
  assert.deepEqual(catalog.map((skill) => skill.name), [
    "field-explainer",
    "offer-entry-guide",
    "promo-copy-guide",
    "settlement-guide",
    "z-extra-guide",
  ]);
  assert.doesNotThrow(() => validateSkillSources(catalog, root));
});

test("目录、清单和基线损坏时明确失败", async (t) => {
  await t.test("插件清单缺失", (t) => {
    const { pluginDir } = fixture(t);
    unlinkSync(join(pluginDir, ".claude-plugin/plugin.json"));
    assert.throws(() => loadSkillCatalog(pluginDir), SkillCatalogError);
  });
  await t.test("插件名错误", (t) => {
    const { pluginDir } = fixture(t);
    writeFileSync(join(pluginDir, ".claude-plugin/plugin.json"), JSON.stringify({ name: "wrong" }));
    assert.throws(() => loadSkillCatalog(pluginDir), /插件名必须是 ics1811/);
  });
  await t.test("skills 为空", (t) => {
    const { pluginDir } = fixture(t);
    rmSync(join(pluginDir, "skills"), { recursive: true, force: true });
    mkdirSync(join(pluginDir, "skills"));
    assert.throws(() => loadSkillCatalog(pluginDir), /缺少基线 Skill/);
  });
  await t.test("缺少一个基线 Skill", (t) => {
    const { pluginDir } = fixture(t);
    rmSync(join(pluginDir, "skills/promo-copy-guide"), { recursive: true, force: true });
    assert.throws(() => loadSkillCatalog(pluginDir), /缺少基线 Skill：promo-copy-guide/);
  });
  await t.test("Skill 目录缺少 SKILL.md", (t) => {
    const { pluginDir } = fixture(t);
    unlinkSync(join(pluginDir, "skills/field-explainer/SKILL.md"));
    assert.throws(() => loadSkillCatalog(pluginDir), /必须且只能包含一个可读的 SKILL\.md/);
  });
  await t.test("Skill 目录含额外文件", (t) => {
    const { pluginDir } = fixture(t);
    writeFileSync(join(pluginDir, "skills/field-explainer/reference.md"), "不允许");
    assert.throws(() => loadSkillCatalog(pluginDir), /必须且只能包含一个可读的 SKILL\.md/);
  });
  await t.test("skills 下出现普通文件", (t) => {
    const { pluginDir } = fixture(t);
    writeFileSync(join(pluginDir, "skills/README.md"), "unexpected");
    assert.throws(() => loadSkillCatalog(pluginDir), /只能放 Skill 子目录/);
  });
});

test("frontmatter 名称和描述合同严格校验", async (t) => {
  await t.test("缺少 frontmatter", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", "# field-explainer\n");
    assert.throws(() => loadSkillCatalog(pluginDir), /缺少合法的 YAML frontmatter/);
  });
  await t.test("未知字段", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", skillText("field-explainer").replace(
      "\n---\n# field-explainer",
      "\nowner: ops\n---\n# field-explainer",
    ));
    assert.throws(() => loadSkillCatalog(pluginDir), /未知字段 owner/);
  });
  await t.test("重复字段", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", skillText("field-explainer").replace(
      "name: field-explainer",
      "name: field-explainer\nname: field-explainer",
    ));
    assert.throws(() => loadSkillCatalog(pluginDir), /字段 name 重复/);
  });
  await t.test("非法名称", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", skillText("Bad_Name"));
    assert.throws(() => loadSkillCatalog(pluginDir), /name 只能由小写字母、数字和连字符组成/);
  });
  await t.test("目录名不一致", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", skillText("renamed-field-guide"));
    assert.throws(() => loadSkillCatalog(pluginDir), /必须与目录名 field-explainer 一致/);
  });
  await t.test("声明名重复", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "duplicate-guide", skillText("field-explainer"));
    assert.throws(() => loadSkillCatalog(pluginDir), /name field-explainer .*重复/);
  });
  await t.test("描述为空", (t) => {
    const { pluginDir } = fixture(t);
    const description = descriptionFor("field-explainer");
    writeSkill(pluginDir, "field-explainer", skillText("field-explainer").replace(
      `description: ${description}`,
      "description:",
    ));
    assert.throws(() => loadSkillCatalog(pluginDir), /description 不能为空/);
  });
  await t.test("适用场景首条未逐字重复 description", (t) => {
    const { pluginDir } = fixture(t);
    const description = descriptionFor("field-explainer");
    writeSkill(pluginDir, "field-explainer", skillText("field-explainer").replace(
      `- ${description}[S1]`,
      "- 另一段适用场景。[S1]",
    ));
    assert.throws(() => loadSkillCatalog(pluginDir), /必须与 description 完全一致/);
  });
});

test("正文结构、行数和规则来源标签严格校验", async (t) => {
  await t.test("缺少章节", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", skillText("field-explainer").replace("## 冲突处理", "## 其他说明"));
    assert.throws(() => loadSkillCatalog(pluginDir), /二级章节必须按顺序且各出现一次/);
  });
  await t.test("重复章节", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", skillText("field-explainer").replace(
      "## 业务知识",
      "## 回答原则\n\n- 重复章节。[S1]\n\n## 业务知识",
    ));
    assert.throws(() => loadSkillCatalog(pluginDir), /二级章节必须按顺序且各出现一次/);
  });
  await t.test("章节顺序错误", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", skillText("field-explainer")
      .replace("## 回答原则", "## TEMP")
      .replace("## 业务知识", "## 回答原则")
      .replace("## TEMP", "## 业务知识"));
    assert.throws(() => loadSkillCatalog(pluginDir), /二级章节必须按顺序且各出现一次/);
  });
  await t.test("规则不是列表项", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", skillText("field-explainer").replace(
      "- 只解释有仓库出处的规则。[S1]",
      "只解释有仓库出处的规则。[S1]",
    ));
    assert.throws(() => loadSkillCatalog(pluginDir), /每条规则都必须是单行列表项/);
  });
  await t.test("规则缺少来源编号", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", skillText("field-explainer").replace(
      "- 只解释有仓库出处的规则。[S1]",
      "- 只解释有仓库出处的规则。",
    ));
    assert.throws(() => loadSkillCatalog(pluginDir), /规则缺少末尾来源编号/);
  });
  await t.test("超过 500 行", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", `${skillText("field-explainer")}${"\n".repeat(501)}`);
    assert.throws(() => loadSkillCatalog(pluginDir), /不能超过 500 行/);
  });
});

test("来源编号、写法、仓库边界和占位符严格校验", async (t) => {
  await t.test("正文引用未定义来源", (t) => {
    const { pluginDir } = fixture(t);
    const description = descriptionFor("field-explainer");
    writeSkill(pluginDir, "field-explainer", skillText("field-explainer").replace(`${description}[S1]`, `${description}[S2]`));
    assert.throws(() => loadSkillCatalog(pluginDir), /引用了未定义的出处 S2/);
  });
  await t.test("定义来源未使用", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", skillText("field-explainer").replace(
      "- [S1] `docs/source.md` — 测试出处",
      "- [S1] `docs/source.md` — 测试出处\n- [S2] `docs/other.md` — 未使用",
    ));
    assert.throws(() => loadSkillCatalog(pluginDir), /出处 S2 没有被正文引用/);
  });
  await t.test("来源格式错误", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", skillText("field-explainer").replace(
      "- [S1] `docs/source.md` — 测试出处",
      "- [S1] docs/source.md",
    ));
    assert.throws(() => loadSkillCatalog(pluginDir), /出处格式应为/);
  });
  await t.test("外部 URL", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", skillText("field-explainer").replace(
      "`docs/source.md`",
      "`https://example.com/rule`",
    ));
    assert.throws(() => loadSkillCatalog(pluginDir), /仓库内的相对路径|外部 URL/);
  });
  await t.test("路径穿越", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", skillText("field-explainer").replace(
      "`docs/source.md`",
      "`../outside.md`",
    ));
    assert.throws(() => loadSkillCatalog(pluginDir), /仓库内的相对路径/);
  });
  await t.test("占位文字", (t) => {
    const { pluginDir } = fixture(t);
    writeSkill(pluginDir, "field-explainer", skillText("field-explainer").replace("— 测试出处", "— TODO"));
    assert.throws(() => loadSkillCatalog(pluginDir), /不能含 TODO、TBD/);
  });
});

test("运行时加载不要求来源文件随部署，CI 校验会发现缺失来源", (t) => {
  const { root, pluginDir } = fixture(t);
  const catalog = loadSkillCatalog(pluginDir);
  unlinkSync(join(root, "docs/source.md"));
  assert.doesNotThrow(() => loadSkillCatalog(pluginDir));
  assert.throws(() => validateSkillSources(catalog, root), /出处路径不存在：docs\/source\.md/);
});

test("skillOf 支持限定名和短名称并拒绝未知名称", (t) => {
  const { pluginDir } = fixture(t);
  const catalog = loadSkillCatalog(pluginDir);
  assert.equal(skillOf(catalog, "field-explainer")?.name, "field-explainer");
  assert.equal(skillOf(catalog, "ics1811:field-explainer")?.name, "field-explainer");
  assert.equal(skillOf(catalog, "other:field-explainer"), null);
  assert.equal(skillOf(catalog, "missing-guide"), null);
  assert.equal(skillOf(catalog, null), null);
});

test("requiredSkillsForTurn 只对明确知识意图设置必需 Skill", () => {
  assert.deepEqual(route("计折上折是什么意思"), ["field-explainer"]);
  assert.deepEqual(route("黄金以旧换新在 1811 怎么录"), ["offer-entry-guide"]);
  assert.deepEqual(route("1811支持抽奖活动吗"), ["offer-entry-guide"]);
  assert.deepEqual(route("两家店要不要说明函"), ["settlement-guide"]);
  assert.deepEqual(route("帮我写一版宣传文案"), ["promo-copy-guide"]);
  assert.deepEqual(route("这个活动的标语要不要加"), ["promo-copy-guide"]);
  assert.deepEqual(route("10月1日到7日，7590店，钻石95折"), []);
  assert.deepEqual(route("多店活动，门店是7590和7601"), []);
  assert.deepEqual(route("让扣点2%，回款率98%"), []);
});

test("固定和浮动按解释或录入意图区分", () => {
  assert.deepEqual(route("浮动和固定有什么区别"), ["field-explainer"]);
  assert.deepEqual(route("固定折扣模式是什么意思"), ["field-explainer"]);
  assert.deepEqual(route("浮动折扣和固定折扣有什么区别"), ["field-explainer"]);
  assert.deepEqual(route("浮动折扣模式和固定折扣模式有什么区别"), ["field-explainer"]);
  assert.deepEqual(route("这个活动该选浮动还是固定，1811 怎么录"), ["offer-entry-guide"]);
  assert.deepEqual(route("先解释区别，再告诉我这个活动怎么录"), [
    "offer-entry-guide",
    "field-explainer",
  ]);
});

test("同一回合可以要求多个相关 Skill", () => {
  assert.deepEqual(route("两家店要不要说明函，也帮我写一版宣传文案"), [
    "settlement-guide",
    "promo-copy-guide",
  ]);
});

test("成功加载 Skill 后记录 completed 轨迹并满足合同", (t) => {
  const { pluginDir } = fixture(t);
  const catalog = loadSkillCatalog(pluginDir);
  const state = createSkillLoadState();
  const started = beginSkillLoad(catalog, state, {
    id: "tool-1",
    requested: "ics1811:field-explainer",
    at: 100,
  });
  assert.equal(started.tool, "load_campaign_skill");
  assert.equal(started.status, "started");
  const finished = finishSkillLoad(state, { toolUseId: "tool-1", isError: false, at: 140 });
  assert.ok(finished);
  assert.equal(finished.status, "completed");
  assert.equal(finished.summary, "已读取这份规则");
  assert.equal(finished.durationMs, 40);
  assert.deepEqual([...state.loadedSkills], ["field-explainer"]);
  assert.doesNotThrow(() => assertSkillTurnContract(["field-explainer"], state));
});

test("漏掉必需 Skill 时后置合同拒绝回复", () => {
  const state = createSkillLoadState();
  assert.throws(
    () => assertSkillTurnContract(["field-explainer"], state),
    /缺少必需的业务规则：ics1811:field-explainer/,
  );
  assert.doesNotThrow(() => assertSkillTurnContract([], state));
});

test("失败的非必需 Skill 也拒绝本回合", (t) => {
  const { pluginDir } = fixture(t);
  const catalog = loadSkillCatalog(pluginDir);
  const state = createSkillLoadState();
  beginSkillLoad(catalog, state, { id: "tool-1", requested: "ics1811:settlement-guide", at: 100 });
  const finished = finishSkillLoad(state, { toolUseId: "tool-1", isError: true, at: 120 });
  assert.equal(finished?.status, "warning");
  assert.equal(finished?.summary, "规则没有加载成功");
  assert.throws(() => assertSkillTurnContract([], state), /业务规则没有加载成功/);
});

test("未知 Skill 记 warning 并使回合失败", (t) => {
  const { pluginDir } = fixture(t);
  const catalog = loadSkillCatalog(pluginDir);
  const state = createSkillLoadState();
  const started = beginSkillLoad(catalog, state, {
    id: "tool-unknown",
    requested: "ics1811:not-enabled",
    at: 100,
  });
  assert.equal(started.title, "加载业务规则：未知规则");
  const finished = finishSkillLoad(state, { toolUseId: "tool-unknown", isError: false, at: 110 });
  assert.equal(finished?.status, "warning");
  assert.equal(state.loadedSkills.size, 0);
  assert.throws(() => assertSkillTurnContract([], state), /业务规则没有加载成功/);
});

test("回合结束时把未完成 Skill 收束为 warning", (t) => {
  const { pluginDir } = fixture(t);
  const catalog = loadSkillCatalog(pluginDir);
  const state = createSkillLoadState();
  beginSkillLoad(catalog, state, { id: "tool-pending", requested: "ics1811:offer-entry-guide", at: 100 });
  const finished = finishPendingSkillLoads(state, 180);
  assert.equal(state.pending.size, 0);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, "warning");
  assert.equal(finished[0].summary, "规则没有加载成功");
  assert.equal(finished[0].durationMs, 80);
  assert.throws(() => assertSkillTurnContract([], state), /业务规则没有加载成功/);
});

test("无关或重复 tool_result 不会伪造加载成功", (t) => {
  const { pluginDir } = fixture(t);
  const catalog = loadSkillCatalog(pluginDir);
  const state = createSkillLoadState();
  beginSkillLoad(catalog, state, { id: "tool-1", requested: "ics1811:promo-copy-guide", at: 100 });
  assert.equal(finishSkillLoad(state, { toolUseId: "another", isError: false, at: 110 }), null);
  assert.equal(state.loadedSkills.size, 0);
  assert.ok(finishSkillLoad(state, { toolUseId: "tool-1", isError: false, at: 120 }));
  assert.equal(finishSkillLoad(state, { toolUseId: "tool-1", isError: false, at: 130 }), null);
  assert.deepEqual([...state.loadedSkills], ["promo-copy-guide"]);
});

test("finishSkillCheckedTurn 只在合同通过后调用完成回调", () => {
  let calls = 0;
  assert.throws(
    () => finishSkillCheckedTurn(["field-explainer"], createSkillLoadState(), () => ++calls),
    /缺少必需的业务规则/,
  );
  assert.equal(calls, 0);

  const ready = createSkillLoadState();
  ready.loadedSkills.add("field-explainer");
  assert.equal(finishSkillCheckedTurn(["field-explainer"], ready, () => ++calls), 1);
  assert.equal(calls, 1);
});
```

---

## Appendix C: Final `agent/run-turn.ts`

```ts
import { mkdirSync } from "node:fs";

import {
  createSdkMcpServer,
  query,
  tool,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../app/lib/agent/prompt.ts";
import type { AgentRequest, AgentResult } from "../app/lib/agent/protocol.ts";
import {
  AGENT_TOOL_META,
  AGENT_TOOL_NAMES,
  createAgentState,
  FACT_KEYS,
  finishAgentTurn,
  runAgentTool,
  safeToolSummary,
  type AgentToolName,
} from "../app/lib/agent/tools.ts";
import { QUESTION_IDS } from "../app/lib/campaign/ics1811/questions.ts";
import type { FactKey, QuestionId } from "../app/lib/campaign/ics1811/types.ts";
import { mergeTraceEvent, startTraceEvent, finishTraceEvent, type AgentTraceEvent } from "../app/lib/tool-trace.ts";
import {
  beginSkillLoad,
  createSkillLoadState,
  finishPendingSkillLoads,
  finishSkillCheckedTurn,
  finishSkillLoad,
  loadSkillCatalog,
  qualifiedSkillNames,
  requiredSkillsForTurn,
} from "./skills.ts";

export type AgentRuntimeConfig = {
  model: string;
  modelBaseUrl: string;
  apiKey: string;
  runtimeDir: string;
  pluginDir: string;
  timeoutMs: number;
  debug?: boolean;
};

export type AgentTurnRunner = (
  request: AgentRequest,
  onTrace?: (event: AgentTraceEvent) => void,
) => Promise<AgentResult>;

export type AgentQuery = (
  params: Parameters<typeof query>[0],
) => AsyncIterable<SDKMessage>;

export type AgentRuntimeDependencies = {
  query: AgentQuery;
};

const DEFAULT_AGENT_RUNTIME_DEPENDENCIES: AgentRuntimeDependencies = { query };

const factKey = z.enum(FACT_KEYS as [FactKey, ...FactKey[]]);
const questionId = z.enum(QUESTION_IDS as [QuestionId, ...QuestionId[]]);

export function createAgentRunner(
  config: AgentRuntimeConfig,
  dependencies: AgentRuntimeDependencies = DEFAULT_AGENT_RUNTIME_DEPENDENCIES,
): AgentTurnRunner {
  return async (request, onTrace) => {
    const catalog = loadSkillCatalog(config.pluginDir);
    const requiredSkills = requiredSkillsForTurn(request);
    const skillLoads = createSkillLoadState();
    const state = createAgentState(request);
    const recordSkill = (event: AgentTraceEvent) => {
      state.trace = mergeTraceEvent(state.trace, event);
      onTrace?.(event);
    };

    const handle = (name: AgentToolName) => async (args: Record<string, unknown>) => {
      const started = startTraceEvent({
        id: crypto.randomUUID(),
        tool: name,
        title: AGENT_TOOL_META[name].title,
        initiatedBy: "model",
        at: Date.now(),
      });
      state.trace = mergeTraceEvent(state.trace, started);
      onTrace?.(started);
      const outcome = runAgentTool(state, name, args, { loadedSkills: skillLoads.loadedSkills });
      const finished = finishTraceEvent(started, {
        status: outcome.isError ? "warning" : "completed",
        summary: safeToolSummary(name, outcome, state),
        at: Date.now(),
      });
      state.trace = mergeTraceEvent(state.trace, finished);
      onTrace?.(finished);
      if (config.debug) {
        console.log(`[tool] ${name} ${JSON.stringify(args).slice(0, 800)}\n       → ${outcome.isError ? "拒绝：" : ""}${outcome.text.slice(0, 500)}`);
      }
      return {
        content: [{ type: "text" as const, text: outcome.text }],
        ...(outcome.isError ? { isError: true } : {}),
      };
    };

    const campaign = createSdkMcpServer({
      name: "campaign",
      version: "2.0.0",
      tools: [
        tool("extract_campaign_facts", "记下用户这一轮明确说过的活动信息，每项附原话片段；工具核对后返回还缺什么", {
          facts: z.array(z.object({
            key: factKey,
            value: z.unknown().optional(),
            quote: z.string(),
          })),
        }, handle("extract_campaign_facts")),
        tool("accept_campaign_proposals", "用户同意你上一句的提议时，按提议记下；quote 取用户表示同意的原话，只同意其中几项时列出题号", {
          quote: z.string(),
          questions: z.array(questionId).optional(),
        }, handle("accept_campaign_proposals")),
        tool("lookup_ics_reference", "查询 ICS 演示代码表，不修改草稿", {
          query: z.string().min(1).max(120),
        }, handle("lookup_ics_reference")),
        tool("analyze_campaign_state", "运行确定性的 1811 字段推导、缺项和校验，返回还缺的题号和是否已经齐了", {}, handle("analyze_campaign_state")),
        tool("ask_campaign_questions", "登记这句回复要问用户的问题（题号），可附带提议的具体值；登记后在回复里用自己的话问", {
          questions: z.array(questionId),
          proposals: z.array(z.object({
            question: questionId,
            answer: z.unknown(),
          })).optional(),
        }, handle("ask_campaign_questions")),
        tool("draft_campaign_copy", "起草活动名称（不超过 13 个字）和活动内容，只写用户说过的数字，不写标语", {
          name: z.string(),
          content: z.string(),
        }, handle("draft_campaign_copy")),
        tool("draft_promo_copy", "起草对外宣传文案的创意部分：主标题和卖点。日期、门店、优惠力度由系统按事实填充，不要写，也不要写活动标语；必须先加载 ics1811:promo-copy-guide", {
          headline: z.string(),
          highlights: z.array(z.string()),
        }, handle("draft_promo_copy")),
        tool("generate_ics1811_sheet", "活动信息齐了时查看 ICS-1811 填写值摘要；齐了系统也会自动生成", {}, handle("generate_ics1811_sheet")),
        tool("undo_campaign_change", "撤销上一次修改", {}, handle("undo_campaign_change")),
      ],
    });

    mkdirSync(config.runtimeDir, { recursive: true });
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), config.timeoutMs);
    const stderr: string[] = [];
    let reply: string | null = null;

    try {
      for await (const message of dependencies.query({
        prompt: buildAgentUserPrompt(request, requiredSkills),
        options: {
          model: config.model,
          systemPrompt: buildAgentSystemPrompt(request.today),
          tools: ["Skill"],
          plugins: [{ type: "local" as const, path: config.pluginDir }],
          skills: qualifiedSkillNames(catalog),
          mcpServers: { campaign },
          allowedTools: AGENT_TOOL_NAMES.map((name) => `mcp__campaign__${name}`),
          settingSources: [],
          persistSession: false,
          maxTurns: 12,
          cwd: config.runtimeDir,
          abortController,
          stderr: (data) => stderr.push(data),
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            CLAUDE_CONFIG_DIR: config.runtimeDir,
            ANTHROPIC_BASE_URL: config.modelBaseUrl,
            ANTHROPIC_API_KEY: config.apiKey,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          },
        },
      })) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type !== "tool_use" || block.name !== "Skill") continue;
            const requested = (block.input as { skill?: unknown }).skill;
            recordSkill(beginSkillLoad(catalog, skillLoads, {
              id: block.id,
              requested,
              at: Date.now(),
            }));
            if (config.debug) console.log(`[skill] ${typeof requested === "string" ? requested : "未知规则"}`);
          }
        }
        if (message.type === "user" && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type !== "tool_result") continue;
            const event = finishSkillLoad(skillLoads, {
              toolUseId: block.tool_use_id,
              isError: block.is_error === true,
              at: Date.now(),
            });
            if (event) recordSkill(event);
          }
        }
        if (message.type !== "result") continue;
        if (message.subtype === "success") reply = message.result;
        else {
          throw new Error(
            message.subtype === "error_max_turns"
              ? "Agent 步骤太多，没在限定步数内完成"
              : "Agent 执行出错",
          );
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) throw new Error("Agent 超时了，请重试");
      const tail = stderr.join("").slice(-1500);
      if (tail) console.error(tail);
      throw error;
    } finally {
      for (const event of finishPendingSkillLoads(skillLoads, Date.now())) recordSkill(event);
      clearTimeout(timer);
    }

    return finishSkillCheckedTurn(
      requiredSkills,
      skillLoads,
      () => finishAgentTurn(state, reply),
    );
  };
}
```
