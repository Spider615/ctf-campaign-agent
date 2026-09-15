// demo 阶段唯一的代码表（SOP §9(一)）。取值优先用 §9(五) 和截图里出现的真实值；SOP 没给的对应关系标 origin「编造」。
// 换成系统真实数据时只替换这里的数据，结构不变。

export type Origin = "截图" | "指引文字" | "导入模板" | "编造";

export type Entry = { code: string; label: string; display: string; aliases?: string[]; origin: Origin; evidence?: string };
export type StoreEntry = Entry & { shortName: string; region: string; division: string | null; city: string | null };
export type CategoryEntry = Entry & { shortName: string; headCodes: string[]; businessCategory: string };
export type BrandEntry = Entry & { approvalFlow: string };

const same = (label: string, origin: Origin, evidence?: string, aliases?: string[]): Entry => ({ code: label, label, display: label, origin, evidence, aliases });
const paren = (code: string, label: string, origin: Origin, evidence?: string, aliases?: string[]): Entry => ({ code, label, display: `${code})${label}`, origin, evidence, aliases });
const spaced = (code: string, label: string, origin: Origin, evidence?: string, aliases?: string[]): Entry => ({ code, label, display: `${code} ${label}`, origin, evidence, aliases });

const regions: Entry[] = [
  paren("0", "全国", "截图", "03a"),
  paren("201", "华南区", "截图", "03a"),
  paren("202", "华东区", "截图", "03a"),
  paren("203", "华中区", "截图", "03a"),
  paren("204", "华北区", "截图", "03a"),
  paren("205", "西北区", "截图", "03a"),
  paren("206", "东北区", "截图", "03a"),
  paren("209", "沪浙区", "截图", "§9(五)"),
  paren("210", "新城区", "截图", "§9(五)"),
  paren("211", "展销会", "截图", "§9(五)"),
  paren("212", "电子商务区", "截图", "§9(五)"),
  paren("213", "渠道运营区", "截图", "§9(五)"),
  paren("214", "闽深区", "截图", "§9(五)、05b；03h/03i 显示「深惠區」", ["深惠区"]),
  paren("230", "藏品区", "截图", "§9(五)"),
];

const store = (code: string, label: string, shortName: string, region: string, division: string | null, city: string | null, origin: Origin, evidence: string): StoreEntry => ({
  code, label, display: `${code} ${label}`, shortName, region, division, city, origin, evidence,
});

const stores: StoreEntry[] = [
  store("7590", "深圳东门解放路鸿展珠宝店", "东门鸿展", "214", "A区", "深圳", "截图", "§9(五)、05b「214)閩深區 7590」；分区、简称为编造"),
  store("3319", "深圳东门茂业珠宝店", "东门茂业", "214", "A区", "深圳", "指引文字", "§3(二) 文件名示例「闽深A区3319东门茂业4月」；店名为编造"),
  store("3810", "深圳福田中心城珠宝店", "福田中心城", "214", "B区", "深圳", "编造", "§9(五) 只有店号"),
  store("3145", "东莞国贸珠宝店", "东莞国贸", "214", "A区", "东莞", "编造", "§9(五) 只有店号"),
  store("3154", "惠州华贸珠宝店", "惠州华贸", "214", "A区", "惠州", "编造", "§9(五) 只有店号"),
  store("5021", "上海南京东路珠宝店", "南京东路", "209", null, null, "编造", "演示用"),
  store("6108", "广州天河城珠宝店", "天河城", "201", null, null, "编造", "演示用"),
];

const category = (label: string, shortName: string, headCodes: string[], businessCategory: string, origin: Origin, evidence: string, aliases?: string[]): CategoryEntry => ({
  code: label, label, display: label, shortName, headCodes, businessCategory, origin, evidence, aliases,
});

// 货类名称来自截图；号头归属只有「不适用」「钻石类」在截图里看得到，其余为编造；业务大类对照全部为编造（§9(四)）。
const categories: CategoryEntry[] = [
  category("不适用", "", ["HA", "HP"], "", "截图", "05a/05c"),
  category("钻石类", "钻石", ["A", "ARA", "ARU", "AS", "AU", "AYA", "AYU", "CA", "CU", "U"], "镶嵌类", "截图", "03c/03f/05e；业务大类为编造", ["钻石"]),
  category("一般足金类", "黄金", ["F", "FF", "LF"], "黄金类", "截图", "05f；号头、业务大类为编造", ["足金", "黄金"]),
  category("一般金条/金章", "金条", ["ODF"], "黄金类", "截图", "§9(五)；号头、业务大类为编造", ["金条", "金章", "黄金"]),
  category("其他铂金类", "铂金", ["EAD"], "素金类", "截图", "03c；号头、业务大类为编造", ["铂金"]),
  category("金箱（铂金/K金类）", "K金", ["AYF", "EOF"], "素金类", "截图", "§9(五)；号头、业务大类为编造", ["K金", "金箱"]),
  category("西金类", "西金", ["DU"], "素金类", "截图", "§9(五)；号头、业务大类为编造", ["西金"]),
  category("素银类", "素银", [], "素金类", "截图", "03c；业务大类为编造", ["素银", "银饰"]),
  category("银镶嵌类", "银镶嵌", [], "镶嵌类", "截图", "03c；业务大类为编造", ["银镶嵌"]),
  category("珍珠类", "珍珠", [], "镶嵌类", "截图", "03c；业务大类为编造", ["珍珠"]),
  category("其他收入", "", [], "赠品", "截图", "03c；业务大类为编造"),
];

// 「不适用」货类的业务大类按优惠类型覆盖。
const businessCategoryOverrides: Array<{ offerType: string; category: string; value: string; origin: Origin; evidence: string }> = [
  { offerType: "铂金换购特殊营销折扣", category: "不适用", value: "素金类", origin: "截图", evidence: "05a" },
  { offerType: "钻石以小换大", category: "不适用", value: "镶嵌类", origin: "编造", evidence: "05c 页面填的是「钻石」" },
];

const brand = (label: string, approvalFlow: string): BrandEntry => ({ code: label, label, display: label, approvalFlow, origin: "编造", evidence: "由审批流名称对应" });

export const CODEBOOK = {
  version: "demo-2026-09",
  regions,
  divisions: ["0区", "A区", "B区", "C区", "D区", "Z区"].map((label) => same(label, "截图", "§9(五)")),
  subAreas: ["WA01", "WA02", "WA03", "WA04", "WA05", "WA06"].map((label) => same(label, "截图", "§9(五)")),
  cities: ["深圳", "潮州", "东莞", "福州", "河源", "惠州"].map((label) => same(label, "截图", "§9(五)")),
  stores,
  categories,
  businessCategories: ["镶嵌类", "素金类", "黄金类", "赠品"],
  businessCategoryOverrides,
  memberLevels: ["Fans-Member", "挚友", "翡红会员", "白银会员", "黄金会员", "铂金会员", "钻石会员", "贵宾会员", "星级会员", "尊尚会员"].map((label) => same(label, "截图", "§9(五)")),
  priceTypes: ["一口价", "尊享价", "一口价(定)", "高奖励", "一口价(1)", "一口价(HOF)", "OUTLET_50"].map((label) => same(label, "截图", "03d")),
  paymentMethods: {
    defaults: ["现金", "银行卡", "支票", "外币卡", "购物卡", "消费券", "抵扣券", "折扣券", "礼品券", "微信", "支付宝", "会员积分抵扣", "积分券", "GLP积分抵现"],
    others: ["3个月分期", "6个月分期", "9个月分期", "12个月分期", "18个月分期", "24个月分期", "VIP积分消费券", "农行一体机", "对公转账", "银商一体机", "K分赏积分抵现"],
  },
  brands: [brand("周大福", "1"), brand("SOINLOVE", "2"), brand("Monologue", "3"), brand("HOF", "4"), brand("Juvi", "6"), brand("Enzo", "7"), brand("EJ", "8")],
  approvalFlows: [
    spaced("1", "周大福审批", "截图", "§9(五)"),
    spaced("2", "SOINLOVE审批", "截图", "§9(五)"),
    spaced("3", "Monologue审批", "截图", "§9(五)"),
    spaced("4", "HOF", "截图", "§9(五)"),
    spaced("5", "电商审批", "截图", "§9(五)"),
    spaced("6", "Juvi审批", "截图", "§9(五)"),
    spaced("7", "Enzo审批", "截图", "§9(五)"),
    spaced("8", "EJ审批", "截图", "§9(五)"),
  ],
  activityGroups: [paren("3", "其它优惠", "截图", "05b"), paren("17", "货品回购", "截图", "05b"), paren("19", "增值服务", "截图", "05b")],
  channels: [paren("1", "线上活动", "截图", "§9(五)"), paren("2", "线下活动", "截图", "05g")],
  offerNatures: [paren("0", "一般销售", "截图", "05b"), paren("1", "营销活动", "截图", "§9(五)")],
  productScopes: [
    spaced("0", "全部货品", "导入模板", "§9(五)"),
    spaced("1", "outlet货品", "导入模板", "§9(五)、05g", ["outlet", "奥特莱斯"]),
    spaced("2", "高奖励", "导入模板", "§9(五)"),
    spaced("3", "尊享钻石", "导入模板", "§9(五)"),
    spaced("4", "HJ货品", "导入模板", "§9(五)"),
    spaced("5", "心悦之选", "导入模板", "§9(五)"),
    spaced("6", "奥莱专供", "导入模板", "§9(五)", ["奥莱"]),
  ],
  menuConversions: [spaced("0", "不转餐牌", "导入模板", "§9(五)"), spaced("1", "outlet餐牌", "导入模板", "§9(五)；05g 页面显示「OUTLETS貨品」", ["OUTLETS货品"])],
  offerTypes: [
    "金价每克减免", "金价每整克减免", "黄金工费打折", "售价固定折扣", "每满减", "满减", "满件折", "每满返", "满折", "联单",
    "分克重段每整克优惠", "铂金换购特殊营销折扣", "钻石以小换大", "买钻石享黄金克减", "黄金以旧换新",
  ],
  pageDefaults: { brand: "周大福", commission: "不计算折上折", joinDiscount: "可参加活动货类", presaleDays: 0, couponOnly: "否", channel: "2", offerNature: "1" },
};

export function storeByCode(code: string): StoreEntry | undefined {
  return CODEBOOK.stores.find((entry) => entry.code === code);
}

export function categoryByCode(code: string): CategoryEntry | undefined {
  return CODEBOOK.categories.find((entry) => entry.code === code);
}

export function byCode<T extends Entry>(entries: readonly T[], code: string): T | undefined {
  return entries.find((entry) => entry.code === code);
}
