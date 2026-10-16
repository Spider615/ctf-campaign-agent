import { isPlainAcknowledgement, quickAnalyticsReply } from "./dialogue.ts";

// 分析历史效果时，提到的优惠和人群不是新的执行决定。
export function isAnalyticsIntent(text: string): boolean {
  const cleaned = text.replace(/(?:先)?(?:不需要|无需|不要再|不要|不用|别|不)(?:去)?(?:创建|建单|开单|配置)(?:活动)?/g, "");
  const currentTask = cleaned.split(/结束后|后续|然后复盘|之后复盘/)[0];
  const executionAt = currentTask.search(/做(?:一场|一个|一次)|创建|建单|开单|生成活动|策划|开展|发起|执行|启动/);
  const analysisAt = currentTask.search(/复盘|同比|环比|洞察|分析|比较|对比/);
  if (executionAt >= 0 && (analysisAt < 0 || executionAt < analysisAt)) return false;
  return /复盘|同比|环比|洞察/.test(cleaned) ||
    /分析|比较|对比/.test(cleaned) && /销售|销量|毛利|利润|会员|效果|克减|每克减|折扣/.test(cleaned);
}


// 页面入口统一；分析不会自动形成执行事实，明确执行才衔接原 Campaign。
export function conversationRoute(text: string, hasCampaign = false, analysisWasLast = false): "analysis" | "execution" {
  if (isPlainAcknowledgement(text)) return hasCampaign && !analysisWasLast ? "execution" : "analysis";
  if (quickAnalyticsReply(text) || isAnalyticsIntent(text)) return "analysis";
  const cleaned = text.replace(/(?:不需要|无需|不要|不用|别|不)(?:去)?(?:创建|新建|做|执行|启动|开展|发起)(?:活动)?/g, "");
  if (/先[\s\S]{0,12}(?:分析|评估|复盘|查询)|帮我(?:看看|分析|评估|复盘)|有什么(?:风险|建议|问题)|是否合理|合不合适/.test(cleaned)) return "analysis";
  const creation = /(?:创建|新建|做(?:一场|一个|一次)|开展|发起|执行|启动)[\s\S]{0,30}(?:活动|方案)|(?:按|照)[\s\S]{0,16}执行|(?:创建|新建)Campaign/i.test(cleaned);
  if (creation) return "execution";
  if (/查询|筛选|查数|历史|统计|报表/.test(cleaned) && /改成|改为|调整|只看/.test(cleaned)) return "analysis";
  const explicitChange = /撤销|恢复|生成传播/.test(cleaned) || /改成|改为|调整为|设为|设置|设成/.test(cleaned) && /活动|优惠|折扣|标语|主题|渠道|让扣|回款|提成|传播|结算/.test(cleaned);
  if (hasCampaign && analysisWasLast && !explicitChange) return "analysis";
  if (/为什么|原因|怎么回事|怎么理解/.test(cleaned)) return "analysis";
  if (!hasCampaign || /历史|数据|报表|复盘|分析|洞察|比较|对比|建议|优化|风险|销量|销售额|毛利|查询|多少/.test(cleaned) && !/改成|改为|调整为|设为|设置|设成|目标.*(?:定为|改)/.test(cleaned)) return "analysis";
  return "execution";
}
