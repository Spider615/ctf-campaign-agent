// 提交前校验（设计文档第 7 节）：全部由代码判定，不交给模型（§9(三) 末行）。

import { categoryByCode, CODEBOOK, storeByCode } from "./codebook.ts";
import { FIXED_ONLY_PATTERNS, OFFER_TYPES, paramProblem } from "./offer-spec.ts";
import type { Check, FillModel, Ics1811Draft } from "./types.ts";

const SPECIAL = /[^\p{Script=Han}A-Za-z0-9.%]/u;
const PLATINUM_DISCOUNTS = [0.8, 0.9, 1];
const PLATINUM_MULTIPLES = [1.5, 2, 2.5];

export function checkDraft(draft: Ics1811Draft, fill: FillModel, today: string): Check[] {
  const checks: Check[] = [];
  const add = (id: string, severity: Check["severity"], message: string, sop: string) => checks.push({ id, severity, message, sop });
  const { info, details } = fill;
  const f = draft.facts;
  const offer = f.offer?.value;

  // ---- 活动信息 ----
  const nameLength = [...info.name.value].length;
  if (!nameLength || nameLength > 13) add("V-A01", "blocker", `活动名称要有，且不超过 13 个字（现在 ${nameLength} 个字）`, "§2、§3(一)、§7、§9(三)");
  if (SPECIAL.test(info.name.value) || SPECIAL.test(info.content.value)) add("V-A02", "blocker", "活动名称、活动内容不能含特殊字符", "§3(一)、§9(三)");
  const slogan = f.slogan?.value;
  if (info.slogan.value && !(slogan?.wanted && slogan.legalConfirmed === true && slogan.text === info.slogan.value)) {
    add("V-A03", "blocker", "标语只能填法务确认过的用户原文", "§3(一)、§7、§9(二)6");
  }
  if (info.startDate.value && info.endDate.value && info.startDate.value > info.endDate.value) add("V-A04", "blocker", "开始日期不能晚于结束日期", "§9(三)");
  if (info.startDate.value && info.startDate.value < today) add("V-A05", "warning", "开始日期早于今天", "SOP 未说明");
  const cycleDays = info.cycle.value.split(",");
  if (!/^(0|[1-7](,[1-7])*)$/.test(info.cycle.value) || new Set(cycleDays).size !== cycleDays.length) add("V-A06", "blocker", "周期只能填 0，或 1–7 用英文逗号隔开且不重复", "§3(一)、§7");
  if (!Number.isInteger(info.presaleDays.value) || info.presaleDays.value < 0 || info.presaleDays.value > 7) add("V-A07", "blocker", "预售时间要填 0–7 的整数", "03a 页面提示");

  const missing: string[] = [];
  if (info.startDate.source === "pending") missing.push("活动日期");
  if (info.branches.source === "pending") missing.push("门店");
  if (!offer) missing.push("优惠方式和力度");
  if (details.some((detail) => detail.params.some((param) => param.value.source === "pending"))) missing.push("优惠力度");
  if (details.some((detail) => detail.mode.source === "pending")) missing.push("门店能不能改价");
  if (details.some((detail) => detail.mode.value === "固定折扣模式" && detail.offerType.source === "pending")) missing.push("优惠的计算方式");
  if (details.some((detail) => detail.categories.source === "pending")) missing.push("参与货类");
  if (details.some((detail) => detail.concessionRate.source === "pending")) missing.push("让扣点和回款率");
  if (info.commission.source === "pending") missing.push("提成口径");
  if (info.slogan.source === "pending") missing.push("活动标语");
  if (info.menuConversion.source === "pending") missing.push("是否转 outlet 餐牌");
  if (fill.settlement?.has.source === "pending") missing.push("结算说明函");
  if (missing.length) add("V-A08", "blocker", `这些人定项还没有用户回答：${missing.join("、")}`, "§9 划分标准");

  const scopeCode = info.productScope.value.split(" ")[0];
  if (["0", "2", "3"].includes(scopeCode) && !info.menuConversion.value?.startsWith("0")) add("V-A11", "blocker", "货品范围是全部货品、高奖励或尊享钻石时，转换餐牌只能选不转餐牌", "§3(一)、§5(五)、§9(三)");
  const stores = f.stores?.value ?? [];
  if (stores.some((code) => !storeByCode(code))) add("V-A12", "blocker", "有门店不在代码表里", "§3(一)");
  if (f.paymentRemove?.value.includes("GLP积分抵现") && info.paymentMethods.value.includes("GLP积分抵现")) add("V-A13", "blocker", "活动不支持 GLP 积分抵现，付款方式里不能保留它", "§7、§3(一)");
  const allPayments = [...CODEBOOK.paymentMethods.defaults, ...CODEBOOK.paymentMethods.others];
  if (info.paymentMethods.value.some((name) => !allPayments.includes(name))) add("V-A13", "blocker", "有付款方式不在代码表里", "§3(一)");
  const files = fill.settlement?.fileNames ?? [];
  if (files.length > 30 || new Set(files).size !== files.length) add("V-A14", "blocker", "结算说明函最多 30 个，文件名不能重名", "§2、§3(二)");
  if (fill.settlement?.has.value === false) add("V-A15", "warning", "多家门店的活动没有结算说明函，指引要求多家分店活动上传", "§3(二)");
  if (info.channel.value.startsWith("1")) add("V-A16", "warning", "选了线上活动：线上 / 线下的真实区分标准待确认", "§9(四)");

  // ---- 明细 ----
  for (const detail of details) {
    const label = `明细 ${detail.index}`;
    const typeName = detail.offerType.value;
    if (offer && FIXED_ONLY_PATTERNS.includes(offer.pattern) && detail.mode.value !== "固定折扣模式") add("V-D02", "blocker", `${label}：这类优惠只能用固定折扣模式`, "§3(三)1、§9(三)");
    for (const param of detail.params) {
      if (param.value.value === null) continue;
      const problem = paramProblem(typeName, param.key, param.value.value);
      if (problem) add("V-D03", "blocker", `${label}：${param.label}${problem}`, "§5(三)4、§9(三)");
    }
    if (typeName === "铂金换购特殊营销折扣") {
      const discount = detail.params.find((param) => param.key === "billingDiscount")?.value.value;
      const multiple = detail.params.find((param) => param.key === "judgeAmount")?.value.value;
      if ((discount != null && !PLATINUM_DISCOUNTS.includes(discount)) || (multiple != null && !PLATINUM_MULTIPLES.includes(multiple))) {
        add("V-D04", "warning", `${label}：指引列举的开单折扣是 0.8、0.9、1.0，换大倍数是 1.5、2、2.5，请确认`, "§5(一)2");
      }
    }
    const spec = typeName ? OFFER_TYPES[typeName] : undefined;
    if (spec?.fixedCategories && (detail.categories.value.join() !== spec.fixedCategories.join() || detail.headCodes.value.join() !== (spec.fixedHeadCodes ?? []).join())) {
      add("V-D05", "blocker", `${label}：${typeName}的货类要选「${spec.fixedCategories.join("、")}」、货类明细选 ${spec.fixedHeadCodes?.join("、")}`, "§5 表、§9(三)");
    }
    const categories = detail.categories.value.map(categoryByCode);
    if (categories.some((entry) => !entry)) add("V-D08", "blocker", `${label}：有货类不在代码表里`, "§3(三)2");
    const allowedHeads = categories.flatMap((entry) => entry?.headCodes ?? []);
    if (detail.headCodes.value.some((code) => !allowedHeads.includes(code))) add("V-D08", "blocker", `${label}：货类明细（号头）不属于所选货类`, "§3(三)2");
    if (detail.memberLevels.value.some((level) => !CODEBOOK.memberLevels.some((entry) => entry.code === level))) add("V-D08", "blocker", `${label}：会员级别不在代码表里`, "§3(三)2");
    if (detail.priceTypes?.value.some((type) => !CODEBOOK.priceTypes.some((entry) => entry.code === type))) add("V-D08", "blocker", `${label}：售价类型不在代码表里`, "§3(三)2");
    if (detail.categories.value.length && (!detail.businessCategory.value || detail.businessCategory.value.split(",").some((value) => !CODEBOOK.businessCategories.includes(value)))) {
      add("V-D10", "blocker", `${label}：业务大类要填，且在对照表内`, "§3(三)3、§9(四)");
    }
    for (const rate of [detail.concessionRate, detail.collectionRate]) {
      if (rate.value !== null && (rate.value < 0 || rate.value > 1)) add("V-D11", "blocker", `${label}：让扣点、回款率要填 0 到 1 之间的小数，2% 填 0.02`, "§3(三)3、§7、§9(三)");
    }
    for (const restriction of detail.restrictions) {
      const value = restriction.value.value;
      if (/[，、\s]/.test(value)) add("V-R01", "blocker", `${label}：${restriction.label}多个值要用英文逗号隔开`, "§3(三)4");
      if (restriction.key === "allowModelCategory" && !/^[A-Z]{1,3}$/.test(value)) add("V-R02", "blocker", `${label}：允许模号货类只能填一个 1–3 位大写字母`, "§3(三)4");
      if (restriction.key === "denyGoodsGroup") {
        if (!value.split(",").every((item) => /^\d+[A-Z]+$/.test(item))) add("V-R02", "blocker", `${label}：不允许货组按「货组+货类」填，如 15A,16A`, "§3(三)4");
        add("V-R03", "warning", `${label}：设了不允许货组，这些货组不能再参加该活动，请确认范围不要过宽`, "§3(三)4、§7");
      }
    }
    const cap = Number(detail.restrictions.find((item) => item.key === "priceCap")?.value.value ?? "0");
    const floor = Number(detail.restrictions.find((item) => item.key === "priceFloor")?.value.value ?? "0");
    if (cap < 0 || floor < 0 || (cap > 0 && floor > cap)) add("V-R04", "blocker", `${label}：牌仔价上下限不能为负，下限不能大于上限`, "设计决策");
  }

  if (offer?.pattern === "diamond_gold_gram") {
    const typeNames = details.map((detail) => detail.offerType.value);
    if (!typeNames.includes("买钻石享黄金克减") || !typeNames.includes("金价每克减免")) add("V-D06", "blocker", "买钻石享黄金克减要和一条金价每克减免成对录入", "§5(四)、§9(三)");
  }
  if (offer?.pattern === "gold_tradein") {
    const ratios = offer.items.map((item) => item.upgradeRatio).filter((value) => value !== null);
    if (new Set(ratios).size !== ratios.length) add("V-D06", "blocker", "黄金以旧换新每个换大比例一条明细，比例不能重复", "§5(三)5");
  }

  // ---- 推导时记下的提示：阻断的进 blocker，其余进 warning ----
  for (const note of fill.notes) add(`note:${note.id}`, note.blocking ? "blocker" : "warning", note.text, note.sop);
  return checks;
}
