// 估算费用（人民币）：每次请求的 Token × 单价。这是估算，不是账单；实际扣费以官方账单为准。
// DeepSeek 用官方价格页的单价（https://api-docs.deepseek.com/zh-cn/quick_start/pricing，2026-10-26 核对），
// 按北京时间分高峰和空闲：工作日 9:00–12:00、14:00–18:00 为高峰，其余时段半价。
// 法定节假日官方也算空闲，这里拿不到节假日日历，节假日按工作日算，估算会偏高。
// 句子互动网关没有价格接口，单价从环境变量读；没配就算不出，显示「未定价」，不显示 0。
import type { UsageChannel } from "./store.ts";

type Price = { input: number; cacheRead: number; output: number };
type Tokens = { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null };
export type CostInput = Tokens & { channel: UsageChannel; model: string; startedAt: number };

// 高峰时段每百万 Token 的价格（元）。
const DEEPSEEK_PEAK: Record<string, Price> = {
  "deepseek-flash": { input: 2, cacheRead: 0.04, output: 8 },
  "deepseek-v4-pro": { input: 9, cacheRead: 0.3, output: 27 },
};

export function isDeepseekPeak(ms: number): boolean {
  const beijing = new Date(ms + 8 * 3600_000);
  const day = beijing.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  return minutes >= 9 * 60 && minutes < 12 * 60 || minutes >= 14 * 60 && minutes < 18 * 60;
}

const positive = (value: string | undefined) => {
  if (value === undefined || value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : NaN;
};

export function createCostEstimator(env: Record<string, string | undefined> = process.env) {
  const input = positive(env.JUZI_INPUT_PRICE_PER_M);
  const output = positive(env.JUZI_OUTPUT_PRICE_PER_M);
  const cacheRead = positive(env.JUZI_CACHE_READ_PRICE_PER_M);
  // 输入、输出都配了且是合法数字才定价；缓存命中没单独配时按输入价算。
  const juzi: Price | undefined = input !== undefined && output !== undefined && !Number.isNaN(input) && !Number.isNaN(output) && !Number.isNaN(cacheRead ?? 0)
    ? { input, output, cacheRead: cacheRead ?? input } : undefined;

  const priceOf = (request: CostInput): Price | undefined => {
    if (request.channel === "juzi") return juzi;
    const peak = DEEPSEEK_PEAK[request.model];
    if (!peak) return undefined;
    const factor = isDeepseekPeak(request.startedAt) ? 1 : 0.5;
    return { input: peak.input * factor, cacheRead: peak.cacheRead * factor, output: peak.output * factor };
  };

  // 返回元，保留 6 位小数免得小额请求被舍成 0；算不出返回 null。
  return (request: CostInput): number | null => {
    const price = priceOf(request);
    if (!price) return null;
    const parts: Array<[number | null, number]> = [[request.inputTokens, price.input], [request.cacheReadTokens, price.cacheRead], [request.outputTokens, price.output]];
    if (parts.every(([count]) => count === null)) return null;
    const yuan = parts.reduce((total, [count, perMillion]) => total + (count ?? 0) * perMillion / 1_000_000, 0);
    return Math.round(yuan * 1e6) / 1e6;
  };
}
export type CostEstimator = ReturnType<typeof createCostEstimator>;
