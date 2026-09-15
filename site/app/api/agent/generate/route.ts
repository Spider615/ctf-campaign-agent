import { parseGeneratedCopy } from "../../../lib/server/ai-schemas.ts";
import { callDeepSeek } from "../../../lib/server/deepseek.ts";
import { generationSystemPrompt } from "../../../lib/server/prompts.ts";
import { isCampaignDraft } from "../../../lib/server/request-validation.ts";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { draft?: unknown };
    if (!isCampaignDraft(body.draft)) {
      return Response.json({ error: "活动草稿结构不完整" }, { status: 400 });
    }
    const content = await callDeepSeek({
      messages: [
        { role: "system", content: generationSystemPrompt },
        { role: "user", content: JSON.stringify(body.draft) },
      ],
    });
    return Response.json(parseGeneratedCopy(content));
  } catch (error) {
    console.error("campaign generation failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "活动方案生成失败，请重试" },
      { status: 502 },
    );
  }
}

