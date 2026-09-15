// 验收用例 T1–T10 的夹具（设计文档第 12 节）。writes 模拟模型从原话里抽出的内容，数值仍由守卫从片段重算。
// 测试用它驱动整条对话；示例会话也从这里取 T1。

import type { FactWrite } from "./facts.ts";
import type { QuestionId } from "./types.ts";

export const EXAMPLE_TODAY = "2026-09-16";

export type ExampleTurn =
  | { kind: "text"; text: string; writes: FactWrite[] }
  | { kind: "card"; answers: Partial<Record<QuestionId, Record<string, unknown>>> };

export type Example = { id: string; title: string; first: string; firstWrites: FactWrite[]; turns: ExampleTurn[] };

const w = (key: FactWrite["key"], quote: string, value?: unknown): FactWrite => (value === undefined ? { key, quote } : { key, quote, value });
const noRates = w("rates", "没有让扣点回款率");
const actualPrice = w("commission", "提成按实际售价算");
const noSlogan = w("slogan", "不要标语");
const ROUND_ANSWER = "没有让扣点回款率，提成按实际售价算，不要标语。";

export const EXAMPLES: Example[] = [
  {
    id: "T1",
    title: "黄金每克减15（信息齐全）",
    first: "2027年5月1日到5月5日，闽深区7590门店，一般足金类黄金按实际克重每克减15元。没有让扣点和回款率，销售提成按实际售价算，不加活动标语。",
    firstWrites: [
      w("dates", "2027年5月1日到5月5日"),
      w("stores", "闽深区7590门店", ["7590门店"]),
      w("categories", "一般足金类黄金", ["一般足金类"]),
      w("offer", "一般足金类黄金按实际克重每克减15元"),
      w("rates", "没有让扣点和回款率"),
      w("commission", "销售提成按实际售价算"),
      w("slogan", "不加活动标语"),
    ],
    turns: [],
  },
  {
    id: "T2",
    title: "铂金以旧换新 2 倍",
    first: "7590门店做铂金以旧换新，2倍，开单9折。",
    firstWrites: [w("stores", "7590门店", ["7590门店"]), w("offer", "铂金以旧换新，2倍，开单9折")],
    turns: [
      {
        kind: "text",
        text: "2026年10月1日到10月7日。没有让扣点回款率。提成按实际售价乘折扣算。不要标语。",
        writes: [w("dates", "2026年10月1日到10月7日"), noRates, w("commission", "提成按实际售价乘折扣算"), noSlogan],
      },
    ],
  },
  {
    id: "T3",
    title: "黄金以旧换新，两档换大比例",
    first: "国庆在7590门店做黄金以旧换新，换大50%的工费打8折，换大100%的免工费。",
    firstWrites: [w("dates", "国庆"), w("stores", "7590门店", ["7590门店"]), w("offer", "黄金以旧换新，换大50%的工费打8折，换大100%的免工费")],
    turns: [
      {
        kind: "text",
        text: `2026年10月1日到10月7日，一般足金类。${ROUND_ANSWER}`,
        writes: [w("dates", "2026年10月1日到10月7日"), w("categories", "一般足金类", ["一般足金类"]), noRates, actualPrice, noSlogan],
      },
    ],
  },
  {
    id: "T4",
    title: "买钻石享黄金克减（卡片作答）",
    first: "2026年10月10日到10月20日，7590门店做买钻石享黄金克减：钻石不打折，黄金每克减20元。",
    firstWrites: [w("dates", "2026年10月10日到10月20日"), w("stores", "7590门店", ["7590门店"]), w("offer", "买钻石享黄金克减：钻石不打折，黄金每克减20元")],
    turns: [
      {
        kind: "card",
        answers: {
          Q4: { slots: { diamond: ["钻石类"], gold: ["一般足金类"] } },
          Q5a: { none: true },
          Q5b: { commission: "actual_price" },
          Q6a: { wanted: false },
        },
      },
    ],
  },
  {
    id: "T5",
    title: "纯 9 折，第二轮问浮动还是固定",
    first: "7590门店钻石类做个打折活动，2026年11月1日到11月11日。",
    firstWrites: [w("stores", "7590门店", ["7590门店"]), w("categories", "钻石类", ["钻石类"]), w("dates", "2026年11月1日到11月11日")],
    turns: [
      { kind: "text", text: `打9折。${ROUND_ANSWER}`, writes: [w("offer", "打9折"), noRates, actualPrice, noSlogan] },
      { kind: "text", text: "可以改。", writes: [w("discountEditable", "可以改")] },
    ],
  },
  {
    id: "T6",
    title: "满减没说是否累加",
    first: "2026年12月1日到12月31日，7590门店钻石类满5000减500。",
    firstWrites: [w("dates", "2026年12月1日到12月31日"), w("stores", "7590门店", ["7590门店"]), w("categories", "钻石类", ["钻石类"]), w("offer", "钻石类满5000减500")],
    turns: [{ kind: "text", text: `每满5000都减500。${ROUND_ANSWER}`, writes: [w("thresholdRepeat", "每满5000都减500"), noRates, actualPrice, noSlogan] }],
  },
  {
    id: "T7",
    title: "Outlet 活动",
    first: "2026年10月15日到10月31日，7590门店做个折扣活动，打7折，门店可以在这个基础上改价。",
    firstWrites: [w("dates", "2026年10月15日到10月31日"), w("stores", "7590门店", ["7590门店"]), w("offer", "打7折，门店可以在这个基础上改价")],
    turns: [
      {
        kind: "text",
        text: `只做outlet货品里的钻石类。${ROUND_ANSWER}`,
        writes: [w("productScope", "outlet货品"), w("categories", "钻石类", ["钻石类"]), noRates, actualPrice, noSlogan],
      },
      { kind: "text", text: "要转。", writes: [w("menuConversion", "要转")] },
    ],
  },
  {
    id: "T8",
    title: "多家门店",
    first: "2026年11月1日到11月30日，闽深区A区的7590、3145、3154三家店，一般足金类每克减10元，没有让扣点和回款率。",
    firstWrites: [
      w("dates", "2026年11月1日到11月30日"),
      w("stores", "7590、3145、3154三家店", ["7590", "3145", "3154"]),
      w("categories", "一般足金类", ["一般足金类"]),
      w("offer", "一般足金类每克减10元"),
      w("rates", "没有让扣点和回款率"),
    ],
    turns: [
      {
        kind: "text",
        text: "按实际克重。提成按实际售价算。结算说明函有，每家店一份。不要标语。",
        writes: [w("gramBasis", "按实际克重"), actualPrice, w("settlementLetter", "结算说明函有，每家店一份"), noSlogan],
      },
    ],
  },
  {
    id: "T9",
    title: "标语没说法务确认（确认过）",
    first: "2026年10月1日到10月7日，7590门店一般足金类按实际克重每克减15元，没有让扣点和回款率，提成按实际售价算，活动标语用：足金每克立减十五元。",
    firstWrites: [
      w("dates", "2026年10月1日到10月7日"),
      w("stores", "7590门店", ["7590门店"]),
      w("categories", "一般足金类", ["一般足金类"]),
      w("offer", "一般足金类按实际克重每克减15元"),
      w("rates", "没有让扣点和回款率"),
      actualPrice,
      w("slogan", "活动标语用：足金每克立减十五元"),
    ],
    turns: [{ kind: "text", text: "法务确认过了。", writes: [w("slogan", "法务确认过了")] }],
  },
  {
    id: "T10",
    title: "纯打折且限定售价类型",
    first: "2026年10月1日到10月31日，7590门店钻石类一口价货品打95折，没有让扣点和回款率，提成按实际售价算，不要标语。",
    firstWrites: [
      w("dates", "2026年10月1日到10月31日"),
      w("stores", "7590门店", ["7590门店"]),
      w("categories", "钻石类", ["钻石类"]),
      w("priceTypes", "一口价货品"),
      w("offer", "打95折"),
      w("rates", "没有让扣点和回款率"),
      actualPrice,
      noSlogan,
    ],
    turns: [{ kind: "text", text: "门店要能改价，用浮动。", writes: [w("discountEditable", "门店要能改价，用浮动")] }],
  },
];
