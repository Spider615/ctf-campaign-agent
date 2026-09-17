// Campaign Brief 的事实写入守卫：每一项都必须能在用户本轮原话中定位；
// 文本值直接使用原话片段，渠道也只从同一片段确定性解析。

import type { FactVia } from "./ics1811/types.ts";
import type { CampaignBrief, CampaignBriefKey, CampaignChannel } from "./types.ts";

export type CampaignBriefWrite = { key: CampaignBriefKey; quote: string; value?: unknown };
export type CampaignBriefWriteContext = { text: string; via?: FactVia };
export type DroppedCampaignBriefWrite = { key: CampaignBriefKey; quote: string; reason: string };
export type CampaignBriefWriteResult = {
  brief: CampaignBrief;
  applied: CampaignBriefKey[];
  dropped: DroppedCampaignBriefWrite[];
};

export const CAMPAIGN_BRIEF_KEYS: readonly CampaignBriefKey[] = ["name", "objective", "audience", "theme", "channels", "timing", "scope"];

export function createEmptyCampaignBrief(): CampaignBrief {
  return { name: null, objective: null, audience: null, theme: null, channels: null, timing: null, scope: null };
}

const CHANNEL_PATTERNS: ReadonlyArray<{ channel: CampaignChannel; pattern: RegExp }> = [
  { channel: "store", pattern: /门店|线下|分行|店内|专柜/iu },
  { channel: "wechat", pattern: /微信|公众号|视频号|小程序|朋友圈/iu },
  { channel: "ecommerce", pattern: /电商|商城|天猫|京东|线上商店|网上商城/iu },
  { channel: "social", pattern: /小红书|微博|抖音|社交媒体|社媒/iu },
  { channel: "member_crm", pattern: /会员|CRM|私域|短信|社群/iu },
  { channel: "event", pattern: /发布会|展览|展会|快闪|沙龙|直播/iu },
];

export function channelsFromQuote(quote: string): CampaignChannel[] {
  return CHANNEL_PATTERNS.filter(({ pattern }) => pattern.test(quote)).map(({ channel }) => channel);
}

export function applyCampaignBriefWrites(
  input: CampaignBrief,
  writes: readonly CampaignBriefWrite[],
  context: CampaignBriefWriteContext,
): CampaignBriefWriteResult {
  const brief = structuredClone(input);
  const applied: CampaignBriefKey[] = [];
  const dropped: DroppedCampaignBriefWrite[] = [];
  const via = context.via ?? "text";

  for (const write of writes) {
    const quote = typeof write.quote === "string" ? write.quote.trim() : "";
    if (!CAMPAIGN_BRIEF_KEYS.includes(write.key)) {
      dropped.push({ key: write.key, quote, reason: "不认识的 Brief 字段" });
      continue;
    }
    if (!quote || !context.text.includes(quote)) {
      dropped.push({ key: write.key, quote, reason: "原话片段不在用户这一轮说的话里" });
      continue;
    }
    if (write.key === "channels") {
      const channels = channelsFromQuote(quote);
      if (!channels.length) {
        dropped.push({ key: write.key, quote, reason: "原话片段里没有支持的渠道" });
        continue;
      }
      brief.channels = { value: channels, quote, via };
    } else {
      brief[write.key] = { value: quote, quote, via };
    }
    applied.push(write.key);
  }

  return { brief, applied: [...new Set(applied)], dropped };
}
