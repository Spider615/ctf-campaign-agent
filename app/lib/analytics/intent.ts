// 分析历史效果时，提到的优惠和人群不是新的执行决定。
export function isAnalyticsIntent(text: string): boolean {
  const cleaned = text.replace(/(?:先)?(?:不需要|无需|不要再|不要|不用|别|不)(?:去)?(?:创建|建单|开单|配置)(?:活动)?/g, "");
  const currentTask = cleaned.split(/结束后|后续|然后复盘|之后复盘/)[0];
  const executionAt = currentTask.search(/做(?:一场|一个|一次)|创建|建单|开单|生成活动|策划|开展|发起/);
  const analysisAt = currentTask.search(/复盘|同比|环比|洞察|分析|比较|对比/);
  if (executionAt >= 0 && (analysisAt < 0 || executionAt < analysisAt)) return false;
  return /复盘|同比|环比|洞察/.test(cleaned) ||
    /分析|比较|对比/.test(cleaned) && /销售|销量|毛利|利润|会员|效果|克减|每克减|折扣/.test(cleaned);
}
