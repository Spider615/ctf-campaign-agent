export type DeepSeekMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type DeepSeekOptions = {
  apiKey?: string;
  messages: DeepSeekMessage[];
  fetcher?: typeof fetch;
};

export async function getDeepSeekApiKey(): Promise<string> {
  const { env } = await import("cloudflare:workers");
  const key = env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("未配置 DeepSeek API key");
  return key;
}

export async function callDeepSeek({
  apiKey,
  messages,
  fetcher = fetch,
}: DeepSeekOptions): Promise<string> {
  const resolvedApiKey = apiKey ?? (await getDeepSeekApiKey());
  let response: Response;
  try {
    response = await fetcher("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolvedApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-flash",
        messages,
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new Error("模型服务暂时不可用（网络错误）");
  }

  if (!response.ok) throw new Error(`模型服务暂时不可用（${response.status}）`);
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型没有返回内容");
  return content;
}
