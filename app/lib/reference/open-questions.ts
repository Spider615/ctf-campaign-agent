// 待确认清单（设计文档第 13 节）：SOP 本身没说清的问题，和 demo 自己定的默认值。

export type SopQuestion = {
  id: number;
  question: string;
  sop: string;
  // demo 现在怎么处理；确认后要改的就是这里描述的行为
  handling: string;
};

export type DesignDefault = {
  id: string;
  value: string;
  modules: string;
};

export const SOP_QUESTIONS: SopQuestion[] = [
  {
    id: 1,
    question: "1811 点「完成新增」后是否自动发起 OA 审批，怎么确认已经提交？",
    sop: "§8(1)",
    handling: "填写值的建完后待办里提示「确认 OA 审批是否已发起」。",
  },
  {
    id: 2,
    question: "ICS-1815 什么时候可以修改？",
    sop: "§8(2)",
    handling: "铂金、钻石回购和黄金以旧换新要在 1815 改活动分组（17 / 19），待办里写「改不了先请 OA 审批人拒绝，改完再重新提交」。",
  },
  {
    id: 3,
    question: "是否参与打折、预售时间、是否凭券使用分别是什么意思，还有哪些选项？",
    sop: "§8(3)、§9(四)",
    handling: "按页面默认填「可参加活动货类」「0」「否」，复述和填写值里标待确认。",
  },
  {
    id: 4,
    question: "业务大类能填哪些值？指引文字是 4 项，截图里还有钻石类、钻石、翡翠。",
    sop: "§8(4)、§9(四)",
    handling: "按代码表里货类对应的业务大类填（镶嵌类、素金类、黄金类、赠品），明细里标待确认。",
  },
  {
    id: 5,
    question: "线上 / 线下按什么区分？活动级优惠类型「一般销售」和「营销活动」怎么选？",
    sop: "§9(四)",
    handling: "原话提到线上或电商选线上，否则选线下；活动级优惠类型一律选「1)营销活动」，都标待确认。",
  },
  {
    id: 6,
    question: "判断金额和整单金额下限怎么分工？",
    sop: "§9(四)",
    handling: "满减、每满减把门槛填在判断金额；整单金额下限填 0，并注明部分版本页面才有这一栏。",
  },
  {
    id: 7,
    question: "满减、每满减、金价每整克减免、售价固定折扣、黄金工费打折、满件折、满折、每满返、联单这 9 种类型的参数栏长什么样？补一张录入截图就能定。",
    sop: "§9(四)、§9(五)",
    handling: "前 4 种按推断的栏位输出，标「栏位推断，以页面为准」；后 5 种不出填写值，提示人工在 1811 录入。",
  },
  {
    id: 8,
    question: "限制条件栏各版本不同，以哪个版本为准？售价类型「只在固定折扣模式有」是模式规则还是版本差异？",
    sop: "§9(四)",
    handling: "只列两个版本都有的限制条件；浮动折扣模式下提示售价类型的限定录不进去。",
  },
  {
    id: 9,
    question: "区域 214 叫什么（03h 是「深惠區」，05b 是「閩深區」）？会员级别两套名单以哪套为准？勾「全选」和不勾是否等价？",
    sop: "§9(五)",
    handling: "区域用「214)闽深区」，会员级别用 §9(五) 的名单；不限会员时不勾。",
  },
  {
    id: 10,
    question: "只选区域、不勾分行，是不是等于全部分行？分区、小区、城市什么时候要选？",
    sop: "§3(一)、§9(二)2",
    handling: "分行至少选 1 家；只说了区域就追问具体门店。分区、小区、城市不选。",
  },
  {
    id: 11,
    question: "单家门店要不要结算说明函？命名规则「区域+分区+简写店名+店号+月份」和示例「闽深A区3319东门茂业4月」的店号位置不一致；跨月活动取哪个月份？",
    sop: "§3(二)",
    handling: "两家及以上门店才问；文件名按示例的顺序（区域、分区、店号、简写店名、月份），月份取开始月份。",
  },
  {
    id: 12,
    question: "什么时候选「电商审批」？",
    sop: "§3(一)",
    handling: "不自动选电商审批，审批流按品牌对应。",
  },
];

export const DESIGN_DEFAULTS: DesignDefault[] = [
  { id: "P1", value: "首句已经触发的追问放在第 1 轮一起问", modules: "questions.ts" },
  { id: "P2", value: "复述之后的修改引出的新缺项，计入两轮上限", modules: "questions.ts、turns.ts" },
  { id: "P3", value: "活动名称按字符数计 13 个；只允许汉字、字母、数字、小数点和百分号；超限阻断", modules: "checks.ts、draft_copy" },
  { id: "P4", value: "让扣点、回款率大于 1 阻断", modules: "checks.ts" },
  { id: "P5", value: "周期里的 0 不和 1–7 混填", modules: "checks.ts" },
  { id: "P6", value: "日期输出 YYYY-MM-DD；只写月日时取今天之后最近的日期", modules: "phrases.ts、fill-sheet.ts" },
  { id: "P7", value: "用户对标语回答「不知道要不要」仍算缺项", modules: "questions.ts" },
  { id: "P8", value: "业务大类对照表取代码表里的默认值", modules: "codebook.ts" },
  { id: "P9", value: "结算说明函按示例顺序命名，月份取开始月份", modules: "fill-sheet.ts" },
  { id: "P10", value: "用选项提交这一轮、也不需要起草名称时，不调模型", modules: "turns.ts" },
  { id: "P11", value: "面板只能改人定字段和名称、内容；AI 定字段引导到对话里改", modules: "draft-panel.tsx" },
  { id: "P12", value: "本地 D1 的旧会话清库，读到旧结构时提示新建", modules: "session-store.ts" },
];
