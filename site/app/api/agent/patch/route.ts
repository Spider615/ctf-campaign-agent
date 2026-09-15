import { applyPatch } from "../../../lib/campaign/patcher.ts";
import { buildIcsDrafts } from "../../../lib/campaign/split-orders.ts";
import { validateDraft } from "../../../lib/campaign/validator.ts";
import type { DeepSeekMessage } from "../../../lib/server/deepseek.ts";
import { callDeepSeek } from "../../../lib/server/deepseek.ts";
import { parsePatchProposal } from "../../../lib/server/ai-schemas.ts";
import { patchSystemPrompt } from "../../../lib/server/prompts.ts";
import { isCampaignDraft } from "../../../lib/server/request-validation.ts";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { draft?: unknown; instruction?: unknown };
    if (!isCampaignDraft(body.draft) || typeof body.instruction !== "string" || !body.instruction.trim()) {
      return Response.json({ error: "请提供当前草稿和修改要求" }, { status: 400 });
    }

    const messages: DeepSeekMessage[] = [
      { role: "system", content: patchSystemPrompt },
      { role: "user", content: `当前草稿：${JSON.stringify(body.draft)}\n修改要求：${body.instruction}` },
    ];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const content = await callDeepSeek({ messages });
      const ops = parsePatchProposal(content, body.instruction);
      const nextDraft = applyPatch(body.draft, ops);
      const orders = buildIcsDrafts(nextDraft);
      const issues = validateDraft(nextDraft, orders);
      const blockers = issues.filter((entry) => entry.severity === "blocker");
      if (blockers.length === 0) return Response.json({ ops, nextDraft, orders, issues });
      if (attempt === 2) {
        return Response.json({ error: "修改仍与业务规则冲突", ops, issues }, { status: 422 });
      }
      messages.push(
        { role: "assistant", content },
        { role: "user", content: `校验未通过：${JSON.stringify(blockers)}。只修正这些冲突，保持其他字段不变。` },
      );
    }

    return Response.json({ error: "修改失败" }, { status: 422 });
  } catch (error) {
    console.error("campaign patch failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "修改失败，请重试" },
      { status: 502 },
    );
  }
}

