type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  execute: (input: Record<string, unknown>) => ToolResult | Promise<ToolResult>;
};

type ModelContext = {
  registerTool: (tool: RegisteredTool, options?: { signal?: AbortSignal }) => void | Promise<void>;
};

declare global {
  interface Document {
    modelContext?: ModelContext;
  }
  interface Navigator {
    modelContext?: ModelContext;
  }
}

export type CampaignWebMcpActions = {
  startCampaign: (input: { mode: "blank" | "example"; prompt?: string }) => Promise<string>;
  updateFields: (input: { name?: string; content?: string; startDate?: string; endDate?: string }) => Promise<string>;
  readSummary: () => Promise<Record<string, unknown> | string>;
};

function textResult(value: string | Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

const optionalText = (value: unknown) => (typeof value === "string" ? value : undefined);

export function registerCampaignTools(actions: CampaignWebMcpActions): () => void {
  const modelContext = document.modelContext ?? navigator.modelContext;
  if (!modelContext) return () => undefined;
  const controller = new AbortController();

  const tools: RegisteredTool[] = [
    {
      name: "start_campaign_draft",
      description: "在周大福营销活动 AI 工作台中新建 Campaign 对话，或打开一段完整示例对话。",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["blank", "example"], description: "blank 新建活动；example 打开完整示例对话。" },
          prompt: { type: "string", description: "可选的活动需求原话；提供时直接以这句话开始对话。" },
        },
        required: ["mode"],
        additionalProperties: false,
      },
      execute: async (input) => textResult(await actions.startCampaign({
        mode: input.mode === "example" ? "example" : "blank",
        prompt: optionalText(input.prompt),
      })),
    },
    {
      name: "update_campaign_fields",
      description: "修改当前活动的名称、内容或起止日期。不会修改优惠、门店、标语和代码表，这些要在对话里说。",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "活动名称，不超过 13 个字，不含特殊字符" },
          content: { type: "string" },
          startDate: { type: "string", description: "YYYY-MM-DD，和 endDate 一起给" },
          endDate: { type: "string", description: "YYYY-MM-DD，和 startDate 一起给" },
        },
        additionalProperties: false,
      },
      execute: async (input) => textResult(await actions.updateFields({
        name: optionalText(input.name),
        content: optionalText(input.content),
        startDate: optionalText(input.startDate),
        endDate: optionalText(input.endDate),
      })),
    },
    {
      name: "read_campaign_summary",
      description: "读取当前 Campaign 的 Brief、执行阶段、1811 子流程、传播方案、Agent 正在问的问题、仍缺项和阻断原因。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => textResult(await actions.readSummary()),
    },
  ];

  for (const tool of tools) {
    void Promise.resolve(modelContext.registerTool(tool, { signal: controller.signal })).catch(() => undefined);
  }
  return () => controller.abort();
}
