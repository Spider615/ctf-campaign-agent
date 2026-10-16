import type { DatabaseExplainRequest, HistoryQuery } from "./database.ts";
import type { AnalyticsExplainResult } from "./types.ts";
import { isPureAgreement } from "../campaign/ics1811/phrases.ts";

const replies = {
  greeting: "你好，我是小福。可以帮你查历史销售数据、复盘活动表现，或一起找新的营销机会。你想先聊什么？",
  thanks: "不客气，随时继续问我。",
  capabilities: "我可以用历史数据帮你查销售、比较区域和门店、复盘活动表现，再给出有数据依据的营销建议。直接说你的问题，或把活动方案发给我就行。",
  acknowledgement: "好的，有新的问题或要调整的内容，直接告诉我。",
} as const;
const clean = (text: string) => text.normalize("NFKC").trim().replace(/[\s，,。.!！?？～~]/g, "").toLowerCase();
export const isPlainAcknowledgement = (text: string) => isPureAgreement(text) || !/[？?]/.test(text) && /^(确认)$/.test(clean(text));

// 只匹配整条轻量消息，不能吞掉“你好，帮我分析……”中的业务要求。
export function quickAnalyticsReply(question: string): AnalyticsExplainResult | null {
  const text = clean(question);
  const kind = /^(你好[啊呀]?|您好|嗨|哈喽|hello|hi|小福你好|你好小福|早上好|早安|上午好|中午好|下午好|晚上好)$/.test(text) ? "greeting"
    : /^(?:好的|好|嗯|收到|明白了|了解了)?(?:谢谢(?:你|小福)?|感谢|多谢|thanks|thankyou)$/.test(text) ? "thanks"
    : /^(你是谁|你能(?:帮我)?做什么|你可以(?:帮我)?做什么|你会做什么|怎么使用你|如何使用你|介绍一下你自己)$/.test(text) ? "capabilities" : isPlainAcknowledgement(question) ? "acknowledgement" : null;
  return kind ? { insightIds: [], nextDimensions: [], tools: [], skills: [], sources: [], advice: [], reply: replies[kind] } : null;
}
export const isQuickAnalyticsReply = (value: unknown): value is string => typeof value === "string" && Object.values(replies).some((reply) => reply === value);

export function analyticsDialogueMode(question: string, previousQuestions: readonly string[] = []): "lookup" | "analysis" {
  const explicitMode = (text: string) => {
    const task = text.replace(/(?:不需要|无需|不要|不用|别|不做|不进行)(?:做|进行|提供|给出|给我|给|任何|额外|深入|再)?(?:分析|建议)(?:(?:和|与|及)(?:分析|建议))?/g, "");
    if (/为什么|原因|分析|洞察|机会|创新|建议|优化|策略|复盘|效果|影响|提升|改进|评估|值得|寻找|增量|有没有用|是否.*(?:有用|有效)/.test(task)) return "analysis";
    if (/销售|金额|订单|单数|件数|金重|克重|毛利|退货|排名|排行|占比|多少|查询|查数|统计|汇总|数值|数字|指标|数据|计算|口径/.test(task)) return "lookup";
    if (/(?:比较|对比).*(?:优惠|机制|活动|方案)|(?:优惠|机制|活动|方案).*(?:比较|对比)/.test(task)) return "analysis";
    return null;
  };
  const mode = explicitMode(question); if (mode) return mode;
  // 省略式追问沿用最近实际任务，不能把调整筛选自动升级成营销分析。
  if (question.length <= 80 && /只看|只查|按|改看|换成|换为|再看|那|呢[？?]?$/.test(question)) for (const previous of [...previousQuestions].reverse()) {
    if (quickAnalyticsReply(previous)) continue;
    const previousMode = explicitMode(previous); if (previousMode) return previousMode;
  }
  return "analysis";
}

// 有业务上下文时留给受控 Agent 解释，不能将“总额”偷偷扩大成所有门店。
export function quickMonthlySalesQuery(request: DatabaseExplainRequest): HistoryQuery | null {
  if (request.context?.some((text) => !quickAnalyticsReply(text)) || request.history.some((item) => item.role === "user" && !quickAnalyticsReply(item.text))) return null;
  if (request.context === undefined && request.history.some((item) => !quickAnalyticsReply(item.text) && !isQuickAnalyticsReply(item.text.trim()))) return null;
  const text = request.question.normalize("NFKC").replace(/\s/g, "");
  const match = /^(?:请|麻烦)?(?:帮我)?(?:查一下|查询|查|看一下|告诉我)?(20\d{2}|\d{2})年(0?[1-9]|1[0-2])月的?(?:总销售额|销售总额|销售额)(?:一共|总共)?(?:是多少|有多少|多少钱|多少)?[?？。!！]*$/.exec(text);
  if (!match) return null;
  const year = match[1].length === 2 ? `20${match[1]}` : match[1]; const month = match[2].padStart(2, "0");
  const endDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return { period: { start: `${year}-${month}-01`, end: `${year}-${month}-${endDay}` }, by: "overall", population: "net", filters: {} };
}
