export type CodeValue = {
  label: string;
  raw: string;
  slide: number;
  image: string;
  year: number | null;
  yearBasis: string | null;
};

export type UsableCodeTable = {
  key: string;
  name: string;
  completeness: "complete" | "truncated";
  note: string;
  values: CodeValue[];
};

export type UnusableCodeTable = {
  name: string;
  reason: string;
  handling: string;
};

export const SOURCE_NOTE =
  "资料来自《营销活动优惠开单操作指引》，由资讯及通讯应用中心与营销管理部业务规划科编写，封面更新日期 2024/04/22。指引里的截图拍摄于 2019–2025 年，和 2026 年的生产系统可能不一样。";

type Evidence = Pick<CodeValue, "slide" | "image" | "year" | "yearBasis">;

// 每个取值只记一处证据：优先选有年份依据、且年份最新的截图；都没有年份时，选下拉完整展开的那张。
// 年份依据只认 research-gaps.json 里该截图的代际，或该截图上能看到的活动日期；
// 放大图、取值表这类本身看不出年份的截图，year 为 null，不借用同页其他截图的年份。
const SLIDE29_IMAGE52: Evidence = { slide: 29, image: "image52", year: 2025, yearBasis: "截图代际 2025" };
const SLIDE30_IMAGE56: Evidence = {
  slide: 30,
  image: "image56",
  year: 2022,
  yearBasis: "截图代际 2022，截图内活动日期 2022/02/09",
};
const SLIDE30_IMAGE57: Evidence = { slide: 30, image: "image57", year: null, yearBasis: null };
const SLIDE14_IMAGE27: Evidence = {
  slide: 14,
  image: "image27",
  year: 2021,
  yearBasis: "截图代际 2020–2021，截图内活动日期 2021/04/19–2021/04/29",
};
// 第 15 页的抽取条目没有写截图编号。第 14 页止于 image27、第 16 页始于 image29，
// research-gaps.json 列出的六张品牌下拉截图里也有 28，据此推定为 image28。
const SLIDE15_IMAGE28: Evidence = {
  slide: 15,
  image: "image28",
  year: 2021,
  yearBasis: "截图内活动日期 2021/05/28–2021/06/05",
};
const SLIDE19_IMAGE35: Evidence = { slide: 19, image: "image35", year: null, yearBasis: null };
const SLIDE16_IMAGE30: Evidence = { slide: 16, image: "image30", year: null, yearBasis: null };
const SLIDE20_IMAGE36: Evidence = { slide: 20, image: "image36", year: null, yearBasis: null };

const value = (label: string, raw: string, evidence: Evidence): CodeValue => ({ label, raw, ...evidence });

export const USABLE_CODE_TABLES: UsableCodeTable[] = [
  {
    key: "approval_flow",
    name: "审批流",
    completeness: "complete",
    note: "8 项都能在第 30 页的审批流下拉放大图（image57）里看到，编号 1–8 连续。这张放大图很小，没标是哪个界面，也看不出年份；周大福审批和 SOINLOVE审批另在带年份的截图里出现过，年份按那两张算。电商审批(5) 是按渠道分的，品牌和审批流不完全一一对应，选审批流要运营确认。",
    values: [
      value("周大福审批(1)", "周大福審批(1)", SLIDE29_IMAGE52),
      value("SOINLOVE审批(2)", "SOINLOVE审批(2)", SLIDE30_IMAGE56),
      value("Monologue审批(3)", "Monologue审批(3)", SLIDE30_IMAGE57),
      value("HOF(4)", "HOF(4)", SLIDE30_IMAGE57),
      value("电商审批(5)", "电商审批(5)", SLIDE30_IMAGE57),
      value("Juvi审批(6)", "Juvi审批(6)", SLIDE30_IMAGE57),
      value("Enzo审批(7)", "Enzo审批(7)", SLIDE30_IMAGE57),
      value("EJ审批(8)", "EJ审批(8)", SLIDE30_IMAGE57),
    ],
  },
  {
    key: "product_scope",
    name: "货品范围",
    completeness: "complete",
    note: "取自第 19 页 1816 汇入模板的取值表（image35），编号 0–6 连续，表下是空行，已见底。1811 界面上同一个下拉只显示名称、不带编号。货品范围含 0、2、3 时，转换餐牌只能填 0，否则开单失败。取值表上看不出年份。",
    values: [
      value("0 全部货品", "0 全部货品", SLIDE19_IMAGE35),
      value("1 outlet货品", "1 outlet货品", SLIDE19_IMAGE35),
      value("2 高奖励", "2 高奖励", SLIDE19_IMAGE35),
      value("3 尊享钻石", "3 尊享鑽石", SLIDE19_IMAGE35),
      value("4 HJ货品", "4 HJ货品", SLIDE19_IMAGE35),
      value("5 心悦之选", "5 心悅之選", SLIDE19_IMAGE35),
      value("6 奥莱专供", "6 奧萊專供", SLIDE19_IMAGE35),
    ],
  },
  {
    key: "menu_conversion",
    name: "转换餐牌",
    completeness: "complete",
    note: "取自同一张取值表（第 19 页 image35），只有 0 和 1。同页的 1811 界面截图（image33）里这个下拉显示「OUTLETS貨品」，和取值表的「outlet餐牌」写法不一样，暂时不能确认是同一项。",
    values: [
      value("0 不转餐牌", "0 不转餐牌", SLIDE19_IMAGE35),
      value("1 outlet餐牌", "1 outlet餐牌", SLIDE19_IMAGE35),
    ],
  },
  {
    key: "activity_group",
    name: "活动分组",
    completeness: "truncated",
    note: "三项都在第 14 页 1815 修改弹窗的展开下拉里（image27），下拉已见底。但编号是 3、17、19，中间跳号，系统里应该还有别的分组，这里只收截图里见过的三项。指引要求：货品回购改成 17，黄金以旧换新改成增值服务。第 12 页同一个下拉把 19 写成简体的「增值服务」。",
    values: [
      value("3)其它优惠", "3)其它優惠", SLIDE30_IMAGE56),
      value("17)货品回购", "17)貨品回購", SLIDE14_IMAGE27),
      value("19)增值服务", "19)增值服務", SLIDE14_IMAGE27),
    ],
  },
  {
    key: "channel",
    name: "线上线下",
    completeness: "truncated",
    note: "所有截图里这个下拉都是收起的，只能看到当时选中的「1)線上活動」或「2)線下活動」，没见过完整列表，不能排除还有别的编号。",
    values: [
      value("1)线上活动", "1)線上活動", SLIDE15_IMAGE28),
      value("2)线下活动", "2)線下活動", SLIDE30_IMAGE56),
    ],
  },
  {
    key: "offer_nature",
    name: "优惠性质",
    completeness: "truncated",
    note: "1815 查询列表把这一列叫「优惠性质」，1811 和 1815 弹窗里同一个下拉却标成「優惠類型」，和明细行里的优惠类型不是一个字段。下拉在截图里都是收起的，只见过 0 和 1。",
    values: [
      value("0)一般销售", "0)一般銷售", SLIDE14_IMAGE27),
      value("1)营销活动", "1)營銷活動", SLIDE30_IMAGE56),
    ],
  },
  {
    key: "offer_type_name",
    name: "优惠类型名称",
    completeness: "truncated",
    note: "明细行里的优惠类型下拉。第 16 页的 image30 完整展开，列出 14 个名称，下沿闭合；「黃金以舊換新」只在第 20 页 image36 里出现，不在那 14 项中，下拉内容可能随条件变化。名称和系统编号对不上：只见过「钻石以小换大」回显为 31，指引正文提到的 12、14、17 不知道对应哪个名称。这几张截图都看不出年份。",
    values: [
      value("金价每克减免", "金價每克減免", SLIDE16_IMAGE30),
      value("金价每整克减免(按单件重量整数优惠)", "金价每整克减免(按单件重量整数优惠)", SLIDE16_IMAGE30),
      value("黄金工费打折", "黃金工費打折", SLIDE16_IMAGE30),
      value("售价固定折扣", "售價固定折扣", SLIDE16_IMAGE30),
      value("每满减", "每滿減", SLIDE16_IMAGE30),
      value("满减", "滿減", SLIDE16_IMAGE30),
      value("满件折", "滿件折", SLIDE16_IMAGE30),
      value("每满返", "每滿返", SLIDE16_IMAGE30),
      value("满折", "滿折", SLIDE16_IMAGE30),
      value("联单", "聯單", SLIDE16_IMAGE30),
      value("分克重段每整克优惠", "分克重段每整克优惠", SLIDE16_IMAGE30),
      value("铂金换购特殊营销折扣", "铂金换购特殊营销折扣", SLIDE16_IMAGE30),
      value("钻石以小换大", "钻石以小换大", SLIDE16_IMAGE30),
      value("买钻石享黄金克减", "买钻石享黄金克减", SLIDE16_IMAGE30),
      value("黄金以旧换新", "黃金以舊換新", SLIDE20_IMAGE36),
    ],
  },
];

export const UNUSABLE_CODE_TABLES: UnusableCodeTable[] = [
  {
    name: "会员级别",
    reason: "截图里有两套互斥的等级名单，不知道生产环境用哪一套。",
    handling: "只问限不限会员；要限时记下范围描述（比如“中高等级及以上”），具体等级由运营在 ICS 会员级别面板里勾选。",
  },
  {
    name: "售价类型",
    reason: "界面上是 7 个中文名，明细里是 26 个单字符代码，全篇没有两者的对照。",
    handling: "Agent 不写售价类型；需要限定时，由运营在 ICS 明细区勾选。",
  },
  {
    name: "货类",
    reason: "列表没有见底。",
    handling: "只收业务大类（镶嵌类、素金类、黄金类、赠品）；具体货类由运营在 ICS 货类面板里勾选。",
  },
  {
    name: "货类明细",
    reason: "跟着货类联动的二级字典，货类看不全，它也看不全。",
    handling: "Agent 不写；运营选好货类后在界面上勾明细。",
  },
  {
    name: "品牌",
    reason: "候选值是从审批流反推出来的，指引里没有一张品牌下拉展开的截图。",
    handling: "Agent 不给品牌取值，由运营在 ICS 界面上选；审批流也不从品牌自动推，要运营确认。",
  },
  {
    name: "支付方式",
    reason: "列表没有见底。",
    handling: "只问支付方式有没有限制；有限制时由运营在 ICS 支付方式面板里勾选。",
  },
  {
    name: "区域 / 分区 / 小区 / 城市 / 分行",
    reason: "列表没有见底，同一编号在不同截图里名称还不一样。",
    handling: "只收范围层级，以及运营给的区域、分区文字或门店行号、行名；Agent 不把名称翻成编码，编码在 ICS 界面上选。",
  },
];
