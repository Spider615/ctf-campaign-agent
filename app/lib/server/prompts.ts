import { PATH_TABLE } from "../campaign/topics.ts";

// 业务规则：理解需求的提示词和 Agent 的系统提示词共用。
export const domainRules = `
优惠数值只能复述用户明确给出的数字，不能从历史活动推测。
不允许输出会员等级码、售价类型码、货类码、品牌码、支付方式码、区域码或审批流码。
客群按场合、关系和身份描述，不生成年龄和性别。
效果指标按由头切换口径，禁止写「预计销售额提升 X%」这类预估；不得把组合活动的效果单独归因给某一个活动或渠道。
活动名分两套：对外传播名不限长；ICS 开单名不超过 13 个字、不含特殊字符。活动标语会打在保证单上，需要法务确认。
遇到资料里没有的品类或玩法，先说明需要确认 ICS 是否支持，不硬套现有货类。
`.trim();

export const interpretationSystemPrompt = `你是周大福营销活动生成 Agent。只输出 JSON。
${domainRules}
遇到没有完整码表的字段，写入 unresolved，不要猜。
返回 {summary, fields, unresolved}。summary 是这次活动的简短主题名，不超过 20 字，不要写“待补”“待确认”这类状态词。
fields 只允许：occasion、reason、customerAction、audience、productCategories、offerMechanism、thresholdAmount、discountRate、amountOff、scopeLevel、region、divisionText、stores、markets、channels、stacking、membership、membershipDescription、concessionRate、collectionRate、paymentRestricted、startDate、endDate。
occasion 只允许：日历节点、品牌节点、外部节点、线下场、门店日常经营、私域日常运营。reason 只摘录用户原话里的由头词。
customerAction 只允许：只看到、参与互动、到场、留资、下单、带旧货来换。明确出现满减、折扣、换购等成交优惠时填“下单”或“带旧货来换”。
offerMechanism 只允许：无让利、以旧换新换购、门槛型、直接价格、赠品兑换、券核销。出现“满 X 减 Y”时填“门槛型”、thresholdAmount=X、amountOff=Y；“满 X 打 N 折”时 discountRate=N/10。
scopeLevel 只允许：全国、区域、分区、指定门店、电商平台。region 是区域名，divisionText 是分区名，stores 是 [{code, name}]。
markets 只使用内地、港澳；channels 只使用线上、线下；productCategories 只使用镶嵌类、素金类、黄金类、赠品。
stacking 只允许“是”“否”；membership 只允许“不限”“限”；paymentRestricted 为 true 或 false；concessionRate、collectionRate 用小数（12 个点填 0.12）。
不能确认的字段不要填进 fields，要用中文写入 unresolved。
示例：用户说“华南区做国庆黄金类线上活动，满 5000 减 500”，fields 应包含 occasion=日历节点、reason=国庆、customerAction=下单、productCategories=[黄金类]、offerMechanism=门槛型、thresholdAmount=5000、amountOff=500、scopeLevel=区域、region=华南区、markets=[内地]、channels=[线上]；未提供的日期和人群写入 unresolved。`;

export const GLOSSARY = [
  "ICS：周大福内部新建优惠活动规则的系统。操作指引中 1811 是新增优惠活动（需审批），1815 是维护，1816 是批量汇入。",
  "开单：在 ICS 里新建一条优惠活动规则。本工具不连接 ICS，只给出逐条要录入的草稿。",
  "拆单：一个活动方案按 批次 × 市场 × 线上线下 × 门店范围 × 优惠档位 拆成多条 ICS 单；任何一项为 0，就拆不出单。",
  "折上折：操作指引写明默认不计折上折；不计时销售提成按实际售价计算。",
  "只看到：顾客只需看到活动、不需要成交，本次不建 ICS 单；报名、互动、到场由 CRM 或活动系统承接。",
  "待界面选择：资料里没有完整码表的字段，由运营在 ICS 界面上选。",
  "让扣点、回款率：运营按合约填写的业务参数。",
];

// 草稿里允许模型改的路径，以及每个路径的取值约束。
export function pathTableLines(): string[] {
  return PATH_TABLE.map((entry) => {
    const detail = entry.options
      ? `，只允许：${entry.options.join("、")}`
      : entry.kind === "number" ? "，数字" : entry.kind === "boolean" ? "，true 或 false" : entry.kind === "enumArray" || entry.kind === "textArray" ? "，数组" : "";
    return `${entry.path}：${entry.label}${detail}`;
  });
}
