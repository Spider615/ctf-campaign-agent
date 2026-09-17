import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { query } from "@anthropic-ai/claude-agent-sdk";

import type { AgentRequest, AgentResult } from "../app/lib/agent/protocol.ts";
import { applyFactWrites, createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
import { EXAMPLES } from "../app/lib/campaign/ics1811/examples.ts";
import type { Ics1811Draft } from "../app/lib/campaign/ics1811/types.ts";
import type { AgentTraceEvent, CampaignToolName } from "../app/lib/tool-trace.ts";
import { createAgentRunner, type AgentQuery } from "./run-turn.ts";
import { loadSkillCatalog, SkillCatalogError, validateSkillSources } from "./skills.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PLUGIN_DIR = fileURLToPath(new URL("./plugin/", import.meta.url));
const ENV_FILE = resolve(REPO_ROOT, ".dev.vars");
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
  const example = EXAMPLES.find((item) => item.id === "T1");
  assert.ok(example, "缺少 T1 验收夹具");
  const result = applyFactWrites(
    createEmptyDraft("skill-smoke-ready", example.first),
    example.firstWrites,
    { text: example.first, today: TODAY },
  );
  if (result.dropped.length) {
    throw new Error(`T1 就绪草稿有字段被丢弃：${JSON.stringify(result.dropped)}`);
  }
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
  return (params) => ({
    async *[Symbol.asyncIterator]() {
      let firstSkillToolUseId: string | null = null;
      let injected = false;

      for await (const message of query(params)) {
        if (message.type === "assistant" && firstSkillToolUseId === null) {
          const skillUse = message.message.content.find(
            (block) => block.type === "tool_use" && block.name === "Skill",
          );
          if (skillUse?.type === "tool_use") firstSkillToolUseId = skillUse.id;
        }

        if (
          !injected
          && firstSkillToolUseId !== null
          && message.type === "user"
          && Array.isArray(message.message.content)
        ) {
          const blockIndex = message.message.content.findIndex(
            (block) => block.type === "tool_result" && block.tool_use_id === firstSkillToolUseId,
          );
          if (blockIndex >= 0) {
            const clone = structuredClone(message);
            assert.ok(Array.isArray(clone.message.content), "Skill 结果消息内容不是数组");
            const block = clone.message.content[blockIndex];
            assert.equal(block?.type, "tool_result", "匹配的 Skill 结果类型不正确");
            if (block?.type !== "tool_result") throw new Error("匹配的 Skill 结果类型不正确");
            block.is_error = true;
            block.content = "发布探针注入：规则没有加载成功";
            injected = true;
            onInjected();
            yield clone;
            continue;
          }
        }

        yield message;
      }
    },
  });
}

function completedSkillTitles(trace: readonly AgentTraceEvent[]): string[] {
  return [...new Set(
    trace
      .filter((event) => event.tool === "load_campaign_skill" && event.status === "completed")
      .map((event) => event.title),
  )].sort();
}

function replyOf(result: AgentResult): string {
  assert.ok(result.reply, "Agent 没有返回文字回复");
  return result.reply;
}

function assertDraftUnchanged(result: AgentResult, input: AgentRequest): void {
  assert.deepEqual(result.draft, input.draft, "解释型请求不应修改活动草稿");
}

function assertNoMutatingTools(result: AgentResult): void {
  const used = result.tools.filter((tool) => MUTATING_TOOLS.has(tool));
  assert.deepEqual(used, [], `解释型请求调用了写工具：${used.join("、")}`);
}

async function main(): Promise<void> {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error("缺少 DEEPSEEK_API_KEY：请先在仓库根目录的 .dev.vars 中填写，再运行真实 Skill smoke。");
  }

  const catalog = loadSkillCatalog(PLUGIN_DIR);
  validateSkillSources(catalog, REPO_ROOT);
  const safeTraceTitleByQualifiedName = new Map(
    catalog.map((skill) => [skill.qualifiedName, `加载业务规则：${skill.title}`] as const),
  );
  const expectedTitles = (qualifiedNames: readonly string[]) => qualifiedNames.map((qualifiedName) => {
    const title = safeTraceTitleByQualifiedName.get(qualifiedName);
    assert.ok(title, `Skill catalog 缺少 ${qualifiedName}`);
    return title;
  }).sort();

  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "ics1811-skill-smoke-"));
  try {
    const config = {
      model: process.env.AGENT_MODEL || "deepseek-flash",
      modelBaseUrl: process.env.AGENT_MODEL_BASE_URL || "https://api.deepseek.com/anthropic",
      apiKey,
      runtimeDir: resolve(temporaryRoot, "runtime"),
      pluginDir: PLUGIN_DIR,
      timeoutMs: 120_000,
    };
    const productionRunner = createAgentRunner(config);

    const runNormalCase = async (
      name: string,
      input: AgentRequest,
      expectedSkills: readonly string[],
      verify: (result: AgentResult, trace: readonly AgentTraceEvent[]) => void,
    ) => {
      const trace: AgentTraceEvent[] = [];
      const result = await productionRunner(input, (event) => trace.push(event));
      assert.deepEqual(
        completedSkillTitles(trace),
        expectedTitles(expectedSkills),
        `${name} 加载的 Skill 不符合预期`,
      );
      verify(result, trace);
      console.log(`PASS ${name}`);
    };

    const fieldInput = request("计折上折是什么意思");
    await runNormalCase("field", fieldInput, ["ics1811:campaign-sop", "ics1811:field-explainer"], (result) => {
      const reply = replyOf(result);
      assert.match(reply, /提成/);
      assert.match(reply, /实际售价/);
      assert.match(
        reply,
        /(?:不是|不等于|并非).{0,20}(?:(?:优惠|促销).{0,8}(?:叠加|能否叠加)|(?:叠加|能否叠加).{0,8}(?:优惠|促销))|(?:(?:优惠|促销).{0,8}(?:叠加|能否叠加)|(?:叠加|能否叠加).{0,8}(?:优惠|促销)).{0,24}(?:不是|不等于|并非|没关系|无关)/,
        "必须明确说明计折上折不是优惠叠加",
      );
      assert.doesNotMatch(
        reply,
        /计折上折.{0,16}(?:就是|等同于|相当于|意味着|指的是|(?<!不)等于).{0,16}(?:(?:优惠|促销).{0,8}(?:叠加|能否叠加)|(?:叠加|能否叠加).{0,8}(?:优惠|促销))/,
        "不能先把计折上折说成优惠叠加，再用其他句子补救",
      );
      assertDraftUnchanged(result, fieldInput);
      assertNoMutatingTools(result);
    });

    const offerInput = request("黄金以旧换新在 1811 怎么录");
    await runNormalCase("offer", offerInput, ["ics1811:campaign-sop", "ics1811:offer-entry-guide"], (result) => {
      const reply = replyOf(result);
      assert.match(
        reply,
        /(?:使用|采用|选择|选用|选|用|按).{0,8}固定折扣|固定折扣.{0,10}(?:模式|录入|开单)/,
        "必须肯定说明黄金以旧换新使用固定折扣",
      );
      assert.match(
        reply,
        /(?:创建|建好|建完|完成|保存).{0,12}(?:后|之后).{0,10}(?:去|进|进入|到|打开|在)\s*(?:ICS-)?1815|(?:ICS-)?1815.{0,24}(?:(?:修改|调整|更改|改).{0,12}活动分组|活动分组.{0,12}(?:修改|调整|更改|改))/,
        "必须肯定说明创建后到 1815 修改活动分组",
      );
      assert.match(
        reply,
        /活动分组.{0,16}(?:改为|改成|调整为|设为|选择|选为|应为|定为).{0,8}19[)）]?\s*增值服务|19[)）]?\s*增值服务.{0,16}(?:活动分组|分组)/,
        "必须肯定说明活动分组改为 19 增值服务",
      );
      assert.doesNotMatch(
        reply,
        /(?:不是|并非|不应|不该|不能|不需要|无需|不用).{0,10}固定折扣|(?:不用|无需|不需要|不必|不要|不能|不应|不该).{0,10}(?:去|进|进入|到|打开|在)?\s*(?:ICS-)?1815|(?:不是|并非|不属于|(?:不应|不该|不要|不能|无需|不用|不必)(?:设为|改为|改成|调整为|选择|选为)?).{0,10}19[)）]?\s*增值服务/,
        "不能把固定折扣、1815 或 19 增值服务说成否定规则",
      );
      assertDraftUnchanged(result, offerInput);
      assertNoMutatingTools(result);
    });

    const settlementInput = request("两家店要不要说明函");
    await runNormalCase("settlement", settlementInput, ["ics1811:campaign-sop", "ics1811:settlement-guide"], (result) => {
      const reply = replyOf(result);
      assert.match(reply, /多家|两家|多店/);
      assert.match(reply, /说明函/);
      assert.match(reply, /上传/);
      assert.match(
        reply,
        /(?:要求|需(?:要)?|须|应当|应该|必须).{0,20}(?:多家|两家|多店).{0,48}(?:上传|提供)|(?:多家|两家|多店).{0,48}(?:(?:要求|需(?:要)?|须|应当|应该|必须|要).{0,20}(?:上传|提供)|(?:上传|提供).{0,20}(?:要求|需(?:要)?|须|应当|应该|必须))/,
        "必须肯定说明多店活动需要上传说明函",
      );
      assert.doesNotMatch(
        reply,
        /(?:多家|两家|多店).{0,20}(?:不需要|无需|不用|不必).{0,16}(?:上传|提供).{0,12}(?:结算)?说明函/,
        "不能声称两家或多家门店不需要上传说明函",
      );
      // 现有材料没有单店和跨月命名规则，回复里出现这类补写结论就让 smoke 失败。
      assert.doesNotMatch(
        reply,
        /单店.{0,12}(?:一定)?不需要|跨月.{0,20}开始月份/,
        "不能补写单店不需要说明函或跨月使用开始月份的规则",
      );
      assertDraftUnchanged(result, settlementInput);
      assertNoMutatingTools(result);
    });

    const promoInput = request("帮我写一版宣传文案");
    await runNormalCase("promo", promoInput, ["ics1811:campaign-sop", "ics1811:promo-copy-guide"], (result, trace) => {
      const loadedIndex = trace.findIndex(
        (event) => event.tool === "load_campaign_skill"
          && event.title === safeTraceTitleByQualifiedName.get("ics1811:promo-copy-guide")
          && event.status === "completed",
      );
      const draftedIndex = trace.findIndex(
        (event) => event.tool === "draft_promo_copy" && event.status === "started",
      );
      assert.ok(loadedIndex >= 0, "没有看到宣传文案 Skill 加载完成");
      assert.ok(draftedIndex > loadedIndex, "必须先加载宣传文案 Skill，再调用文案工具");
      assert.ok(result.tools.includes("draft_promo_copy"), "结果中缺少 draft_promo_copy 工具记录");
      assert.ok(result.draft!.promo, "宣传文案没有写入草稿");
    });

    const t1 = EXAMPLES.find((item) => item.id === "T1");
    assert.ok(t1, "缺少 T1 验收夹具");
    const plainFactsInput: AgentRequest = {
      ...request(t1.first, createEmptyDraft("skill-smoke-plain", t1.first)),
      trigger: { kind: "first_message", text: t1.first },
      phase: "interpreting",
    };
    await runNormalCase("plain-facts", plainFactsInput, ["ics1811:campaign-sop"], (result, trace) => {
      const loadedIndex = trace.findIndex(
        (event) => event.tool === "load_campaign_skill"
          && event.title === safeTraceTitleByQualifiedName.get("ics1811:campaign-sop")
          && event.status === "completed",
      );
      const extractedIndex = trace.findIndex(
        (event) => event.tool === "extract_campaign_facts" && event.status === "started",
      );
      assert.ok(loadedIndex >= 0, "纯活动事实没有加载 campaign-sop");
      assert.ok(extractedIndex > loadedIndex, "必须先加载 campaign-sop，再提取活动事实");
      assert.ok(result.tools.includes("extract_campaign_facts"), "纯活动事实没有调用 extract_campaign_facts");
    });

    let injectionCount = 0;
    const failureTrace: AgentTraceEvent[] = [];
    const failureRunner = createAgentRunner(config, {
      query: failFirstSkillDelivery(() => {
        injectionCount += 1;
      }),
    });
    await assert.rejects(
      failureRunner(request("计折上折是什么意思"), (event) => failureTrace.push(event)),
      /业务规则没有加载成功，请重试/,
    );
    assert.equal(injectionCount, 1, "没有准确注入一次真实 Skill delivery 失败");
    assert.ok(
      failureTrace.some((event) => event.tool === "load_campaign_skill"
        && event.status === "warning"
        && event.summary === "规则没有加载成功"),
      "Skill delivery 失败没有记录精确的 warning trace",
    );
    console.log("PASS sdk-delivery-failure");

    const missingPluginRunner = createAgentRunner({
      ...config,
      pluginDir: resolve(temporaryRoot, "missing-plugin"),
    });
    await assert.rejects(
      missingPluginRunner(request("计折上折是什么意思")),
      (error: unknown) => error instanceof SkillCatalogError
        && error.relativePath === ".claude-plugin/plugin.json"
        && error.detail.startsWith("读取失败："),
    );
    console.log("PASS missing-plugin");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
