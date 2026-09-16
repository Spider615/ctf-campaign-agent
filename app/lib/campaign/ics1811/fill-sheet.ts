// 1811 填写值（设计文档 8.2、8.3 节）：按页面顺序渲染，活动信息齐了由代码直接生成，之后随改动重算。
// ACTIVITY_FIELDS 同时是字段登记表：每个活动信息字段的页面顺序、控件、归属，以及复述里必须出现的字样。

import { OFFER_TYPES } from "./offer-spec.ts";
import type { ActivityInfo, Check, FactKey, Field, FillModel, PostAction, Source } from "./types.ts";

export type Owner = "人定" | "AI 定" | "待确认";

export type FieldSpec = { key: keyof ActivityInfo; label: string; control: string; owner: Owner; pageNote?: string; readbackProbe: string };

// 顺序按截图 05g。
export const ACTIVITY_FIELDS: FieldSpec[] = [
  { key: "name", label: "活动名称", control: "文本框", owner: "AI 定", readbackProbe: "活动名称" },
  { key: "slogan", label: "活动标语", control: "文本框", owner: "人定", readbackProbe: "标语" },
  { key: "content", label: "活动内容", control: "文本框", owner: "AI 定", readbackProbe: "活动内容" },
  { key: "startDate", label: "活动日期（开始）", control: "日期", owner: "人定", readbackProbe: "至" },
  { key: "endDate", label: "活动日期（结束，当天有效）", control: "日期", owner: "人定", readbackProbe: "结束当天有效" },
  { key: "channel", label: "线上/线下", control: "下拉", owner: "待确认", readbackProbe: "线" },
  { key: "offerNature", label: "优惠类型（活动级）", control: "下拉", owner: "待确认", readbackProbe: "活动级优惠类型" },
  { key: "brand", label: "品牌", control: "下拉", owner: "AI 定", readbackProbe: "品牌" },
  { key: "commission", label: "计折上折", control: "下拉", owner: "人定", readbackProbe: "销售提成" },
  { key: "joinDiscount", label: "是否参与打折", control: "下拉", owner: "待确认", readbackProbe: "是否参与打折" },
  { key: "presaleDays", label: "预售时间（天）", control: "数字框", owner: "待确认", readbackProbe: "预售时间" },
  { key: "cycle", label: "周期", control: "文本框", owner: "AI 定", readbackProbe: "周期填" },
  { key: "approvalFlow", label: "审批流", control: "下拉", owner: "AI 定", readbackProbe: "审批流" },
  { key: "productScope", label: "货品范围", control: "下拉", owner: "AI 定", pageNote: "页面有此栏时", readbackProbe: "货品范围" },
  { key: "menuConversion", label: "转换餐牌", control: "下拉", owner: "AI 定", pageNote: "页面有此栏时", readbackProbe: "转换餐牌" },
  { key: "couponOnly", label: "是否凭券使用", control: "下拉", owner: "待确认", pageNote: "页面有此栏时", readbackProbe: "是否凭券使用" },
  { key: "region", label: "区域", control: "单选面板", owner: "人定", readbackProbe: "门店" },
  { key: "division", label: "分区", control: "面板", owner: "AI 定", readbackProbe: "分区" },
  { key: "subArea", label: "小区", control: "面板", owner: "AI 定", readbackProbe: "小区" },
  { key: "city", label: "城市", control: "面板", owner: "AI 定", readbackProbe: "城市" },
  { key: "branches", label: "分行", control: "多选面板，点分行栏下方「确定」", owner: "人定", readbackProbe: "门店" },
  { key: "paymentMethods", label: "支付方式", control: "多选面板", owner: "AI 定", readbackProbe: "付款方式" },
];

// 明细里由 AI 定、复述必须覆盖的字样。
export const DETAIL_READBACK_PROBES = ["折扣模式", "业务大类", "号头", "会员级别", "售价类型", "活动分组"];

// field：这一行对应活动信息里的哪个字段。界面靠它把「这一轮新填了什么」标到具体的行上。
// 明细行是就地拼的、没有对应字段，所以是可选的。
// field：活动信息行对应页面上的哪个字段。
// factKey：明细行由哪个事实驱动——明细行不走 ACTIVITY_FIELDS，只能自己带着来源，
// 否则「这一轮刚填了什么」标不到明细上。两条路径互不干扰。
// basis：这个值凭什么是这个值。source 为 user 时它就是用户那句原话，
// 界面靠它反查回对话里的出处（quote-source.ts），让填写值不像是凭空出现的。
export type SheetRow = { label: string; control: string; value: string; source: Source; note?: string; field?: keyof ActivityInfo; factKey?: FactKey; basis?: string };

export type SelfCheckItem = { item: string; status: "通过" | "不通过" | "需注意" | "需人工" | "不适用" };

export type FillSheet = {
  banner: string;
  info: SheetRow[];
  afterAdd: string[];
  settlement: { fileNames: string[]; steps: string[] } | null;
  details: Array<{ index: number; rows: SheetRow[]; restNote: string; action: string }>;
  finish: string[];
  postActions: PostAction[];
  selfCheck: SelfCheckItem[];
};

const EMPTY_TEXT: Partial<Record<keyof ActivityInfo, string>> = { slogan: "留空", brand: "待指定", approvalFlow: "不选", division: "不选", subArea: "不选", city: "不选" };

function valueText(value: unknown, empty = "待补"): string {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return empty;
  return Array.isArray(value) ? value.join("、") : String(value);
}

const row = (label: string, control: string, fieldValue: Field<unknown>, empty = "待补", note?: string): SheetRow => {
  const notes = [note, fieldValue.tbc].filter(Boolean).join("；");
  return {
    label,
    control,
    value: valueText(fieldValue.value, empty),
    source: fieldValue.source,
    ...(notes ? { note: notes } : {}),
    ...(fieldValue.basis ? { basis: fieldValue.basis } : {}),
  };
};

export function renderFillSheet(fill: FillModel, checks: readonly Check[]): FillSheet {
  const info = ACTIVITY_FIELDS.map((spec) => ({
    ...row(spec.label, spec.control, fill.info[spec.key] as Field<unknown>, EMPTY_TEXT[spec.key] ?? "待补", spec.pageNote),
    field: spec.key,
  }));

  const details = fill.details.map((detail) => {
    const typeSpec = detail.offerType.value ? OFFER_TYPES[detail.offerType.value] : undefined;
    // 每一行标出它由哪个事实驱动，界面才能把「这一轮刚填了什么」标到明细上。
    // 对照 derive.ts 里真实的推导关系，不臆造。
    const byFact = (item: SheetRow, factKey: FactKey): SheetRow => ({ ...item, factKey });

    const rows: SheetRow[] = [byFact(row("折扣模式", "单选钮", detail.mode, "待定"), "discountEditable")];
    if (detail.mode.value !== "浮动折扣模式") {
      rows.push(byFact({ ...row("优惠类型", "下拉", detail.offerType, "待定"), ...(typeSpec ? { value: typeSpec.pageLabel } : {}) }, "offer"));
    }
    rows.push(
      ...detail.params.map((param) => byFact(row(param.label, "文本框", param.value, "待补", param.inferred ? "栏位推断，以页面为准" : undefined), "offer")),
      byFact(row("货类", "多选面板，点「确定」", detail.categories), "categories"),
      byFact(row("货类明细（号头）", "多选面板，点「确定」", detail.headCodes, "不勾"), "headCodes"),
      byFact(row("会员级别", "多选面板，点「确定」", detail.memberLevels, "不勾"), "memberLevels"),
    );
    if (detail.priceTypes) rows.push(byFact(row("售价类型", "多选面板，点「确定」", detail.priceTypes, "不勾"), "priceTypes"));
    rows.push(
      // 业务大类是按货类对照出来的，所以跟着货类亮。
      byFact(row("业务大类", "文本框", detail.businessCategory), "categories"),
      byFact(row("让扣点", "文本框", detail.concessionRate), "rates"),
      byFact(row("回款率", "文本框", detail.collectionRate), "rates"),
      ...detail.restrictions.map((item) => byFact(row(item.label, "文本框", item.value, "留空", item.baseVersion ? undefined : "部分版本页面才有此栏"), "restrictions")),
    );
    return { index: detail.index, rows, restNote: "其余限制条件留空（数值栏保持 0）", action: "点「添加明细」" };
  });

  const has = (id: string) => checks.some((check) => check.id === id && check.severity === "blocker");
  const status = (failed: boolean): SelfCheckItem["status"] => (failed ? "不通过" : "通过");
  const special = fill.postActions.some((action) => action.id === "group_17" || action.id === "group_19");
  const denyGroup = fill.details.some((detail) => detail.restrictions.some((item) => item.key === "denyGoodsGroup"));

  return {
    banner: "代码表为演示编造，以系统为准",
    info,
    afterAdd: ["点「新增」，看到「新增成功,请添加活动明细!」"],
    settlement: fill.settlement?.has.value
      ? { fileNames: fill.settlement.fileNames, steps: ["在「结算说明函」处点「浏览」选择文件，再点「上传」", "每个文件都要看到「上传成功」，文件名不能重名，最多 30 个"] }
      : null,
    details,
    finish: ["在「已添加折扣」列表核对明细", "点页面最下方的「完成新增」，必须看到「上传服务器成功」"],
    postActions: fill.postActions,
    selfCheck: [
      { item: "活动名称", status: status(has("V-A01") || has("V-A02")) },
      { item: "活动标语", status: status(has("V-A03")) },
      { item: "支付方式", status: status(has("V-A13")) },
      { item: "周期", status: status(has("V-A06")) },
      { item: "让扣点、回款率", status: status(has("V-D11")) },
      { item: "不允许货组", status: denyGroup ? "需注意" : "通过" },
      { item: "完成新增", status: "需人工" },
      { item: "特殊活动分组", status: special ? "需人工" : "不适用" },
    ],
  };
}

const SOURCE_TEXT: Record<Source, string> = { user: "你说的", ai: "AI 定", default: "默认", pending: "待补" };

// 复制用的纯文本。
export function fillSheetText(sheet: FillSheet): string {
  const line = (item: SheetRow) => `${item.label}：${item.value}（${SOURCE_TEXT[item.source]}${item.note ? `；${item.note}` : ""}）`;
  const lines = [`【${sheet.banner}】`, "一、活动信息", ...sheet.info.map(line), ...sheet.afterAdd];
  if (sheet.settlement) lines.push("二、结算说明函", ...sheet.settlement.fileNames, ...sheet.settlement.steps);
  sheet.details.forEach((detail) => lines.push(`明细 ${detail.index}`, ...detail.rows.map(line), detail.restNote, detail.action));
  lines.push("完成", ...sheet.finish, "建完后待办", ...sheet.postActions.map((action) => `- ${action.text}`));
  return lines.join("\n");
}
