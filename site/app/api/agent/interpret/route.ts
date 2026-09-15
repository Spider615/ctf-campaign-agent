import { parseInterpretation } from "../../../lib/server/ai-schemas.ts";
import { callDeepSeek } from "../../../lib/server/deepseek.ts";
import { interpretationSystemPrompt } from "../../../lib/server/prompts.ts";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { text?: unknown };
    if (typeof body.text !== "string" || body.text.trim().length < 4) {
      return Response.json({ error: "请用一句话说明活动" }, { status: 400 });
    }
    const content = await callDeepSeek({
      messages: [
        { role: "system", content: interpretationSystemPrompt },
        { role: "user", content: body.text.trim() },
      ],
    });
    return Response.json(parseInterpretation(content, body.text));
  } catch (error) {
    console.error("campaign interpretation failed", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "活动理解失败，请重试" },
      { status: 502 },
    );
  }
}

