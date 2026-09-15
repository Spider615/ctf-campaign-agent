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
  startCampaign: (input: { mode: "blank" | "example"; prompt?: string }) => string;
  updateFields: (input: {
    title?: string;
    externalName?: string;
    content?: string;
    slogan?: string;
    startDate?: string;
    endDate?: string;
  }) => string;
  readSummary: () => Record<string, unknown>;
};

function textResult(value: string | Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

export function registerCampaignTools(actions: CampaignWebMcpActions): () => void {
  const modelContext = document.modelContext ?? navigator.modelContext;
  if (!modelContext) return () => undefined;
  const controller = new AbortController();

  const tools: RegisteredTool[] = [
    {
      name: "start_campaign_draft",
      description: "在周大福营销活动 Agent 中新建空白草稿或打开完整演示草稿。",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["blank", "example"], description: "blank 新建空白活动；example 打开完整母亲节演示。" },
          prompt: { type: "string", description: "可选的活动需求原话，打开空白草稿时会放入输入框。" },
        },
        required: ["mode"],
        additionalProperties: false,
      },
      execute: (input) => textResult(actions.startCampaign({
        mode: input.mode === "example" ? "example" : "blank",
        prompt: typeof input.prompt === "string" ? input.prompt : undefined,
      })),
    },
    {
      name: "update_campaign_fields",
      description: "修改当前活动草稿的展示名称、文案或首批档期；不会修改内部码表和优惠数字。",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          externalName: { type: "string" },
          content: { type: "string" },
          slogan: { type: "string" },
          startDate: { type: "string", description: "YYYY-MM-DD" },
          endDate: { type: "string", description: "YYYY-MM-DD" },
        },
        additionalProperties: false,
      },
      execute: (input) => textResult(actions.updateFields({
        title: typeof input.title === "string" ? input.title : undefined,
        externalName: typeof input.externalName === "string" ? input.externalName : undefined,
        content: typeof input.content === "string" ? input.content : undefined,
        slogan: typeof input.slogan === "string" ? input.slogan : undefined,
        startDate: typeof input.startDate === "string" ? input.startDate : undefined,
        endDate: typeof input.endDate === "string" ? input.endDate : undefined,
      })),
    },
    {
      name: "read_campaign_summary",
      description: "读取当前活动阶段、拆单数量、待确认项和规则校验摘要。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: () => textResult(actions.readSummary()),
    },
  ];

  for (const tool of tools) {
    void Promise.resolve(modelContext.registerTool(tool, { signal: controller.signal })).catch(() => undefined);
  }
  return () => controller.abort();
}
