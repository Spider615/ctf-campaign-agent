// Campaign Brief 的事实写入守卫：每一项都必须能在用户本轮原话中定位；
// 文本值直接使用原话片段；渠道只根据本轮原话语境，对既有已确认值做确定性增减或替换。

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

const ADD_CHANNEL_PATTERN = /^加|再加|再上|只加|加上|加一个|(?:原有)?基础上加|增加|新增|添加|补充|同时|而且|同步(?:发|投|上|推)|也(?:在|发|投|做|用|要)|以及|还要|外加/iu;
const ADD_CHANNEL_PREFIX_PATTERN = /^加|再加|再上|只加|加上|加一个|(?:原有)?基础上加|增加|新增|添加|补充|同步(?:发|投|上|推)|还要|外加/iu;
const NEGATED_ADD_CHANNEL_PATTERN = /不(?:用|需要|要|必)?(?:再)?(?:加|增加|新增|添加)|别(?:再)?(?:加|增加|新增|添加)|无需(?:再)?(?:加|增加|新增|添加)|不必(?:再)?(?:加|增加|新增|添加)|取消(?:增加|新增|添加)/iu;
const NEGATED_REMOVE_CHANNEL_PATTERN = /不(?:用|需要|要|必)?(?:再)?(?:取消|去掉|删掉|删除|移除|拿掉|撤掉|排除)|别(?:再)?(?:取消|去掉|删掉|删除|移除|拿掉|撤掉|排除)|无需(?:再)?(?:取消|去掉|删掉|删除|移除|拿掉|撤掉|排除)/iu;
const NEGATED_KEEP_CHANNEL_PATTERN = /不(?:要)?保留|别保留|无需保留|不必保留/iu;
const REMOVE_CHANNEL_PATTERN = /不(?:要)?保留|别保留|无需保留|不必保留|别用|别发|不要|不用|不再用|不做|不发(?:了)?|取消|去掉|删掉|删了|删除|移除|拿掉|撤掉|排除/iu;
const REPLACE_CHANNEL_PATTERN = /改成|改为|改到|改用|改做|换成|换为|换用|转到|转为|只保留|仅保留|只做|只投|只发|只用|只留|只要|仅做|仅投|仅发|仅用|仅留|(?:^|[^更修整])改|换/iu;
const REPLACE_CHANNEL_MARKER_PATTERN = /改成|改为|改到|改用|改做|换成|换为|换用|转到|转为|只保留|仅保留|只做|只投|只发|只用|只留|只要|仅做|仅投|仅发|仅用|仅留|改|换/iu;
const REPLACE_CHANNEL_PARTS_PATTERN = /^(.*)(?:改成|改为|改到|改用|改做|换成|换为|换用|转到|转为|只保留|仅保留|只做|只投|只发|只用|只留|只要|仅做|仅投|仅发|仅用|仅留|改|换)(.+)$/iu;
const CONTENT_EDIT_PATTERN = /文案|海报|标题|素材|视觉|话术|内容|主题|风格/iu;
const EXPLICIT_CHANNEL_CONTEXT_PATTERN = /渠道|传播|投放|发布(?!会)|触达|推送|宣传|平台|阵地/iu;
const EXPLICIT_CHANNEL_FIELD_PATTERN = /渠道|平台|阵地/iu;
const CHANNEL_FIELD_BOUNDARY_PATTERN = /渠道(?:是|为|做|包括|选择)?/iu;
const CHANNEL_ACTION_BOUNDARY_PATTERN = /通过|经由/iu;
const SCOPE_FIELD_PATTERN = /活动范围|适用范围|适用于|地域范围|门店范围|覆盖范围|地区|地点|区域|覆盖/iu;
const SCOPE_BOUNDARY_PATTERN = /适用于|活动范围|适用范围|地域范围|门店范围|覆盖范围|覆盖/iu;
const NON_CHANNEL_FIELD_PATTERN = /^(?:面向|受众|人群|客群|目标|活动目标|主题|活动主题|针对)/iu;
const EXPLICIT_CONTENT_CHANNEL_ADD_PATTERN = /也(?:在|发|投|做|用|要)|同时(?:在)?|同步(?:发|投|上|推)|再加|再上|只加|加上|增加|新增|添加|还要|外加/iu;
const NEGATED_CHANNEL_CHANGE_PATTERN = /不用改|不要改|别改|无需改|不必改|不要只(?:发|做|投|用|留)|别只(?:发|做|投|用|留)|无需只(?:发|做|投|用|留)|不必只(?:发|做|投|用|留)/iu;
const KEEP_CHANNEL_PATTERN = /不变|保留|保持|维持|继续|照旧|除.+外/iu;
const KEEP_ONLY_NAMED_PATTERN = /^(.*?)(?:其他|其余)(?:渠道)?(?:都|全部)?(?:取消|删除|去掉|移除|不要|不用)(?:了)?\s*[。！!？?]?$/iu;
const ABSOLUTE_CHANNEL_PATTERN = /(?:改成|改为|换成|换为)?只(?:做|投|发|用|留|保留)|仅(?:做|投|发|用|留|保留)/iu;
const CLAUSE_SEPARATOR_PATTERN = /[，,；;。！!？?\n]|但是|不过|然后|并且|但|(?=而且|同时|以及)/iu;

export function channelsFromQuote(quote: string): CampaignChannel[] {
  return CHANNEL_PATTERNS.filter(({ pattern }) => pattern.test(quote)).map(({ channel }) => channel);
}

function sameChannels(left: readonly CampaignChannel[], right: readonly CampaignChannel[]): boolean {
  return left.length === right.length && left.every((channel, index) => channel === right[index]);
}

function channelMutationScope(text: string, quote: string): string {
  // 短 quote 只借用它所在的最小子句判断“不要增加”等否定语义，不能把同句无关的文案编辑一起带进渠道变更。
  if (CLAUSE_SEPARATOR_PATTERN.test(quote)) return quote;
  return text.split(CLAUSE_SEPARATOR_PATTERN).find((clause) => clause.includes(quote))?.trim() || quote;
}

function globalMatches(text: string, pattern: RegExp): Array<{ index: number; end: number }> {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].map((match) => ({
    index: match.index,
    end: match.index + match[0].length,
  }));
}

function splitCompoundChannelClause(clause: string): string[] {
  const negativeAddRanges = globalMatches(clause, NEGATED_ADD_CHANNEL_PATTERN);
  const negatedRemoveRanges = globalMatches(clause, NEGATED_REMOVE_CHANNEL_PATTERN);
  const negatedChangeRanges = globalMatches(clause, NEGATED_CHANNEL_CHANGE_PATTERN);
  const protectedRanges = [...negativeAddRanges, ...negatedRemoveRanges, ...negatedChangeRanges];
  const scopeBoundaryIndexes = new Set(globalMatches(clause, SCOPE_BOUNDARY_PATTERN).map(({ index }) => index));
  const channelFieldBoundaryIndexes = new Set(globalMatches(clause, CHANNEL_FIELD_BOUNDARY_PATTERN).map(({ index }) => index));
  const channelActionBoundaryIndexes = new Set(globalMatches(clause, CHANNEL_ACTION_BOUNDARY_PATTERN).map(({ index }) => index));
  const boundaries = [
    ...negativeAddRanges.map(({ index }) => index),
    ...negatedRemoveRanges.map(({ index }) => index),
    ...negatedChangeRanges.map(({ index }) => index),
    ...globalMatches(clause, ADD_CHANNEL_PREFIX_PATTERN)
      .filter(({ index }) => !protectedRanges.some((range) => index >= range.index && index < range.end))
      .map(({ index }) => index),
    ...globalMatches(clause, REMOVE_CHANNEL_PATTERN)
      .filter(({ index }) => !protectedRanges.some((range) => index >= range.index && index < range.end))
      .map(({ index }) => index),
    ...globalMatches(clause, REPLACE_CHANNEL_MARKER_PATTERN)
      .filter(({ index }) => !protectedRanges.some((range) => index >= range.index && index < range.end))
      .map(({ index }) => index),
    ...scopeBoundaryIndexes,
    ...channelFieldBoundaryIndexes,
    ...channelActionBoundaryIndexes,
  ].sort((left, right) => left - right);
  const parts: string[] = [];
  let start = 0;
  for (const boundary of boundaries) {
    if (boundary <= start) continue;
    const before = clause.slice(start, boundary).trim();
    const hasPriorAction = NEGATED_ADD_CHANNEL_PATTERN.test(before) || REMOVE_CHANNEL_PATTERN.test(before) ||
      ADD_CHANNEL_PATTERN.test(before) || REPLACE_CHANNEL_PATTERN.test(before) ||
      (scopeBoundaryIndexes.has(boundary) && EXPLICIT_CHANNEL_CONTEXT_PATTERN.test(before)) ||
      (channelFieldBoundaryIndexes.has(boundary) && (SCOPE_FIELD_PATTERN.test(before) || NON_CHANNEL_FIELD_PATTERN.test(before))) ||
      (channelActionBoundaryIndexes.has(boundary) && (SCOPE_FIELD_PATTERN.test(before) || NON_CHANNEL_FIELD_PATTERN.test(before)));
    if (!hasPriorAction || !channelsFromQuote(before).length) continue;
    parts.push(before);
    start = boundary;
  }
  const tail = clause.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function channelMutationClauses(scope: string): string[] {
  return scope
    .split(CLAUSE_SEPARATOR_PATTERN)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .flatMap(splitCompoundChannelClause);
}

function resolveChannelMutation(
  existing: readonly CampaignChannel[],
  quote: string,
  text: string,
): { ok: true; value: CampaignChannel[]; changed: boolean } | { ok: false; reason: string } {
  const scope = channelMutationScope(text, quote);
  const keepOnly = scope.match(KEEP_ONLY_NAMED_PATTERN);
  if (keepOnly && /保留|除了|除/iu.test(keepOnly[1] ?? "")) {
    const target = channelsFromQuote(keepOnly[1] ?? "");
    if (target.length) return { ok: true, value: target, changed: !sameChannels(existing, target) };
  }
  let value = [...existing];
  let sawSupportedChannel = false;
  let explicitMutationBefore = false;
  let standaloneDeclarationBefore = false;
  for (const trimmedClause of channelMutationClauses(scope)) {
    const mentioned = channelsFromQuote(trimmedClause);
    if (!mentioned.length) continue;
    const quoteRelated = trimmedClause.includes(quote) || quote.includes(trimmedClause);
    const scopeOnly = SCOPE_FIELD_PATTERN.test(trimmedClause) && !EXPLICIT_CHANNEL_CONTEXT_PATTERN.test(trimmedClause);

    // “不再加小红书”表达的是维持现状，不能退化成一次裸渠道声明。
    if (NEGATED_ADD_CHANNEL_PATTERN.test(trimmedClause)) {
      sawSupportedChannel = true;
      continue;
    }

    if (NEGATED_REMOVE_CHANNEL_PATTERN.test(trimmedClause)) {
      sawSupportedChannel = true;
      value = [...new Set([...value, ...mentioned])];
      continue;
    }

    const replacement = trimmedClause.match(REPLACE_CHANNEL_PARTS_PATTERN);
    const target = replacement ? channelsFromQuote(replacement[2] ?? "") : [];

    // “微信不用改”“不要只发微信”是保留现状，不是删除或整体替换。
    if (NEGATED_CHANNEL_CHANGE_PATTERN.test(trimmedClause)) {
      sawSupportedChannel = true;
      value = [...new Set([...value, ...mentioned])];
      continue;
    }

    if (scopeOnly) continue;

    // “只做/仅发”始终是完整集合声明，优先级高于前面子句的增删。
    if (ABSOLUTE_CHANNEL_PATTERN.test(trimmedClause) && target.length) {
      sawSupportedChannel = true;
      value = target;
      explicitMutationBefore = true;
      standaloneDeclarationBefore = false;
      continue;
    }

    if (NEGATED_KEEP_CHANNEL_PATTERN.test(trimmedClause)) {
      sawSupportedChannel = true;
      const removed = new Set(mentioned);
      value = value.filter((channel) => !removed.has(channel));
      explicitMutationBefore = true;
      continue;
    }

    // 内容中明确说“也发/同时在”仍是渠道新增；普通的“修改微信发布文案”不改变渠道。
    if (CONTENT_EDIT_PATTERN.test(trimmedClause) && EXPLICIT_CONTENT_CHANNEL_ADD_PATTERN.test(trimmedClause)) {
      sawSupportedChannel = true;
      value = [...new Set([...value, ...mentioned])];
      explicitMutationBefore = true;
      continue;
    }
    if (CONTENT_EDIT_PATTERN.test(trimmedClause) && !EXPLICIT_CHANNEL_FIELD_PATTERN.test(trimmedClause)) continue;

    // “小红书不变”“微信保留”只确保点名渠道仍在，不能覆盖刚处理好的其他渠道。
    if (KEEP_CHANNEL_PATTERN.test(trimmedClause)) {
      sawSupportedChannel = true;
      value = [...new Set([...value, ...mentioned])];
      continue;
    }

    // 替换只在当前子句内取来源和目标，避免“改一下微信文案，小红书也发”跨子句误删微信。
    if (replacement && target.length) {
      sawSupportedChannel = true;
      const source = channelsFromQuote(replacement[1] ?? "");
      // “把微信改成小红书”只换被点名的渠道；前一子句已做显式增减时，“改用小红书”接着修改当前集合。
      const next = source.length
        ? [...new Set([...value.filter((channel) => !source.includes(channel)), ...target])]
        : explicitMutationBefore
          ? [...new Set([...value, ...target])]
          : target;
      value = next;
      explicitMutationBefore = true;
      continue;
    }

    if (REMOVE_CHANNEL_PATTERN.test(trimmedClause)) {
      sawSupportedChannel = true;
      const removed = new Set(mentioned);
      value = value.filter((channel) => !removed.has(channel));
      explicitMutationBefore = true;
      continue;
    }
    if (ADD_CHANNEL_PATTERN.test(trimmedClause)) {
      sawSupportedChannel = true;
      value = [...new Set([...value, ...mentioned])];
      explicitMutationBefore = true;
      continue;
    }

    // 子句出现了“改/只要”等词但没有可识别的新渠道时，它不是一条完整的渠道替换指令。
    if (REPLACE_CHANNEL_PATTERN.test(trimmedClause)) continue;

    // 宽 quote 可能同时带受众、目标或主题；这些子句里的“会员/小红书/发布会”不是传播渠道。
    if (NON_CHANNEL_FIELD_PATTERN.test(trimmedClause) && !EXPLICIT_CHANNEL_CONTEXT_PATTERN.test(trimmedClause)) continue;

    // 没有增减词时视为用户给出的完整渠道集合；首次填写和“渠道是……”都走这里。
    // 同一句里可能只是说“修改微信文案”，而 quote 指向另一段新增渠道；这类旁支不能覆盖旧集合。
    if (!quoteRelated) continue;
    sawSupportedChannel = true;
    const next = standaloneDeclarationBefore
      ? [...new Set([...value, ...mentioned])]
      : mentioned;
    value = next;
    standaloneDeclarationBefore = true;
  }
  if (!sawSupportedChannel) return { ok: false, reason: "原话片段里没有支持的渠道" };
  return { ok: true, value, changed: !sameChannels(existing, value) };
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
      const existing = brief.channels?.value ?? [];
      const mutation = resolveChannelMutation(existing, quote, context.text);
      if (!mutation.ok) {
        dropped.push({ key: write.key, quote, reason: mutation.reason });
        continue;
      }
      if (!mutation.changed) {
        dropped.push({ key: write.key, quote, reason: "当前渠道没有变化" });
        continue;
      }
      // 增量修改复用之前已确认的渠道，不要求模型在本轮伪造旧原话；quote 表示最近一次变更依据。
      brief.channels = mutation.value.length ? { value: mutation.value, quote, via } : null;
    } else {
      brief[write.key] = { value: quote, quote, via };
    }
    applied.push(write.key);
  }

  return { brief, applied: [...new Set(applied)], dropped };
}
