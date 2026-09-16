// 事实层 → 1811 填写模型（设计文档第 3、5 节）。纯函数，每轮重算，结果不接受写入。

import { byCode, categoryByCode, CODEBOOK, storeByCode } from "./codebook.ts";
import { FIXED_CATEGORY_PATTERNS, FLOAT_PARAMS, OFFER_TYPES, offerTypeFor, type ParamSpec } from "./offer-spec.ts";
import type { ActivityInfo, Detail, DetailParam, DetailRestriction, Field, FillModel, Ics1811Draft, Note, OfferItem, PostAction, RestrictionKey, Source } from "./types.ts";

const field = <T>(value: T, source: Source, basis: string, tbc?: string): Field<T> => (tbc ? { value, source, basis, tbc } : { value, source, basis });
const pending = <T>(value: T, basis = "还没问"): Field<T> => field(value, "pending", basis);

export const RESTRICTION_LABEL: Record<RestrictionKey, { label: string; baseVersion: boolean }> = {
  allowModel: { label: "允许模号", baseVersion: true },
  denyModel: { label: "不允许模号", baseVersion: true },
  allowSeries: { label: "允许产品系列", baseVersion: true },
  denySeries: { label: "不允许产品系列", baseVersion: true },
  priceCap: { label: "牌仔价价位上限", baseVersion: true },
  priceFloor: { label: "牌仔价价位下限", baseVersion: true },
  allowInlay: { label: "允许镶嵌原料", baseVersion: true },
  denyInlay: { label: "不允许镶嵌原料", baseVersion: true },
  allowModelCategory: { label: "允许模号货类", baseVersion: true },
  denyGoodsGroup: { label: "不允许货组", baseVersion: false },
  orderAmountMin: { label: "整单金额下限", baseVersion: false },
};

// 0.9 → "9"，0.95 → "95"
export function discountText(value: number): string {
  const hundredths = Math.round(value * 100);
  return hundredths % 10 === 0 ? String(hundredths / 10) : String(hundredths);
}

// 名称、内容只保留汉字、字母、数字、小数点和百分号（特殊字符集合 SOP 未说明，见设计文档 13.2 节 P3）。
export const sanitizeCopy = (text: string) => text.replace(/[^\p{Script=Han}A-Za-z0-9.%]/gu, "");

// 货类槽位：买钻石享黄金克减分钻石、黄金两组；铂金以旧换新、钻石以小换大货类固定；其余共用一组。
export function categorySlots(draft: Ics1811Draft): string[] {
  const offer = draft.facts.offer?.value;
  if (!offer) return ["all"];
  if (offer.pattern === "unsupported" || FIXED_CATEGORY_PATTERNS.includes(offer.pattern)) return [];
  if (offer.pattern === "diamond_gold_gram") return ["diamond", "gold"];
  if (offer.items.length > 1 && offer.items.every((item) => item.categories?.length)) return [];
  return ["all"];
}

export function slotCategories(draft: Ics1811Draft, slot: string): string[] | null {
  const map = draft.facts.categories?.value ?? {};
  if (map[slot]?.length) return map[slot];
  if ((slot === "diamond" || slot === "gold") && map.all?.length) {
    const picked = map.all.filter((code) => (slot === "diamond" ? code === "钻石类" : code !== "钻石类"));
    return picked.length ? picked : null;
  }
  return null;
}

export function templateCopy(draft: Ics1811Draft): { name: string; content: string } {
  const offer = draft.facts.offer?.value;
  const first = offer?.items[0];
  const categories = (slotCategories(draft, "all") ?? []).map(categoryByCode).filter((entry) => entry !== undefined);
  const label = categories.map((entry) => entry.label).join("和");
  const short = categories[0]?.shortName ?? "";
  const rate = (value: number | null | undefined) => (value === null || value === undefined ? "" : discountText(value));
  let copy: { name: string; content: string };
  switch (offer?.pattern) {
    case "per_gram": {
      const unit = draft.facts.gramBasis?.value === "whole" ? "每整克减" : "每克减";
      copy = { name: `${short}${unit}${first?.amount ?? ""}`, content: `${label}${short}${unit}${first?.amount ?? ""}元` };
      break;
    }
    case "discount": {
      const outlet = draft.facts.productScope?.value === "1";
      copy = { name: `${outlet ? "Outlet" : ""}${short}${rate(first?.discount)}折`, content: `${outlet ? "outlet货品" : ""}${label}${rate(first?.discount)}折` };
      break;
    }
    case "threshold": {
      const rule = first ? `${draft.facts.thresholdRepeat?.value === "every" ? "每满" : "满"}${first.threshold ?? ""}减${first.amount ?? ""}` : "";
      copy = { name: `${short}${rule}`, content: `${label}${rule}` };
      break;
    }
    case "platinum_tradein":
      copy = { name: `铂金以旧换新${first?.multiple ?? ""}倍`, content: `铂金以旧换新${first?.multiple ?? ""}倍换购开单${rate(first?.discount)}折` };
      break;
    case "diamond_upgrade":
      copy = { name: "钻石以小换大", content: `钻石以小换大开单${rate(first?.discount)}折` };
      break;
    case "gold_tradein": {
      const tiers = (offer.items ?? []).map((item) => `换大${item.upgradeRatio !== null ? `${Number((item.upgradeRatio * 100).toFixed(2))}%` : ""}${item.discount === 0 ? "免工费" : `工费${rate(item.discount)}折`}`).join("");
      copy = { name: "黄金以旧换新", content: `${label}以旧换新${tiers}` };
      break;
    }
    case "diamond_gold_gram": {
      const diamond = first?.discount === 1 ? "钻石不打折" : first?.discount != null ? `钻石${rate(first.discount)}折` : "";
      copy = { name: "买钻石享黄金克减", content: `买钻石享黄金每克减${first?.amount ?? ""}元${diamond}` };
      break;
    }
    default:
      copy = { name: draft.requestText, content: "" };
  }
  return { name: sanitizeCopy(copy.name).slice(0, 13), content: sanitizeCopy(copy.content) };
}

function deriveInfo(draft: Ics1811Draft, notes: Note[]): ActivityInfo {
  const f = draft.facts;
  const template = templateCopy(draft);
  const copyBasis = draft.copy?.source === "user" ? "用户改的" : "模型起草";
  const pattern = f.offer?.value.pattern;

  const slogan = f.slogan?.value;
  const sloganField = !f.slogan
    ? pending("")
    : !slogan?.wanted
      ? field("", "user", `用户说不加标语：${f.slogan.quote}`)
      : slogan.legalConfirmed === true
        ? field(slogan.text, "user", "法务确认过的原文")
        : slogan.legalConfirmed === false
          ? field("", "user", "法务还没确认，这次不填")
          : pending("", "给了标语原文，还没说法务确认");

  const brands = f.brands?.value ?? [];
  if (brands.length > 1) notes.push({ id: "multi_brand", kind: "multi_brand", blocking: true, sop: "§9(三)", text: `原话提到多个品牌（${brands.join("、")}），品牌栏只能选一个且建完后 1815 改不了，请指定品牌` });
  const brandEntry = brands.length === 1 ? byCode(CODEBOOK.brands, brands[0]) : undefined;
  const flow = brandEntry ? byCode(CODEBOOK.approvalFlows, brandEntry.approvalFlow) : brands.length === 0 ? byCode(CODEBOOK.approvalFlows, "1") : undefined;

  const scope = f.productScope ? byCode(CODEBOOK.productScopes, f.productScope.value) : undefined;
  const outlet = scope?.code === "1";

  const storeCodes = f.stores?.value ?? [];
  const regions = [...new Set(storeCodes.map((code) => storeByCode(code)?.region).filter((code): code is string => Boolean(code)))];
  if (regions.length > 1) notes.push({ id: "stores_multi_region", kind: "needs_split", blocking: true, sop: "§3(一)", text: "门店分属不同区域，1811 一次只能选一个区域，需要按区域分开建" });
  const region = regions.length === 1 ? byCode(CODEBOOK.regions, regions[0]) : undefined;

  const removed = f.paymentRemove?.value ?? [];
  const added = f.paymentAdd?.value ?? [];
  const payments = [...CODEBOOK.paymentMethods.defaults.filter((name) => !removed.includes(name)), ...added.filter((name) => !CODEBOOK.paymentMethods.defaults.includes(name))];

  return {
    name: draft.copy ? field(draft.copy.name, draft.copy.source, copyBasis) : field(template.name, "ai", "按需求模板生成"),
    slogan: sloganField,
    content: draft.copy ? field(draft.copy.content, draft.copy.source, copyBasis) : field(template.content, "ai", "按需求模板生成"),
    startDate: f.dates ? field(f.dates.value.start, "user", f.dates.quote) : pending(null),
    endDate: f.dates ? field(f.dates.value.end, "user", f.dates.quote) : pending(null),
    channel: f.online?.value
      ? field("1)线上活动", "ai", `原话提到线上：${f.online.quote}`, "线上 / 线下的真实区分标准待确认（§9(四)）")
      : field("2)线下活动", "default", "原话没提线上或电商", "线上 / 线下的真实区分标准待确认（§9(四)）"),
    offerNature: field(
      "1)营销活动",
      "default",
      "§9(四) demo 一律选营销活动",
      pattern === "platinum_tradein" || pattern === "diamond_upgrade" ? "活动级优惠类型：截图示例里这类测试活动选的是 0)一般销售，待确认" : "活动级优惠类型「一般销售」和「营销活动」怎么区分待确认",
    ),
    brand: brandEntry ? field(brandEntry.label, "ai", `原话提到：${f.brands?.quote}`) : brands.length > 1 ? pending(null, "多个品牌待指定") : field("周大福", "default", "需求没写品牌，用页面默认值"),
    commission: f.commission ? field(f.commission.value === "actual_price" ? "不计算折上折" : "计算折上折", "user", f.commission.quote) : pending(null, "还没问，页面默认值不能直接用"),
    joinDiscount: field("可参加活动货类", "default", "页面默认值", "是否参与打折的其他选项和作用待确认（§9(四)）"),
    presaleDays: field(0, "default", "§9(四) demo 填 0", "预售时间的字段含义待确认（§9(四)）"),
    cycle: f.weekdays ? field(f.weekdays.value.join(","), "ai", `原话提到每周：${f.weekdays.quote}`) : field("0", "ai", "需求没提每周几生效"),
    approvalFlow: flow ? field(flow.display, "ai", brandEntry ? `按品牌 ${brandEntry.label}` : "按默认品牌周大福") : field(null, "ai", "涉及多个品牌，不选，由系统取最高审批等级"),
    productScope: scope ? field(scope.display, "ai", `原话提到：${f.productScope?.quote}`) : field("0 全部货品", "ai", "需求没提货品池"),
    menuConversion: outlet
      ? f.menuConversion
        ? field(f.menuConversion.value ? "1 outlet餐牌" : "0 不转餐牌", "user", f.menuConversion.quote)
        : pending(null, "outlet 货品要问是否转餐牌")
      : field("0 不转餐牌", "ai", "货品范围不是 outlet 货品时只能不转餐牌"),
    couponOnly: field("否", "default", "§9(四) demo 填否", "是否凭券使用的字段含义待确认（§9(四)）"),
    region: region ? field(region.display, "user", "由门店换算") : pending(null, storeCodes.length ? "门店分属不同区域" : "还没问"),
    division: field(null, "default", "§3(一) 截图示例只选了区域和分行"),
    subArea: field(null, "default", "§3(一) 截图示例只选了区域和分行"),
    city: field(null, "default", "§3(一) 截图示例只选了区域和分行"),
    branches: f.stores ? field(storeCodes, "user", f.stores.quote) : pending([]),
    paymentMethods: field(payments, "ai", removed.length || added.length ? "按原话调整默认付款方式组" : "默认付款方式组（含 GLP 积分抵现）"),
  };
}

function businessCategoryOf(typeName: string | null, codes: string[]): string {
  const values = codes.map((code) => CODEBOOK.businessCategoryOverrides.find((item) => item.offerType === typeName && item.category === code)?.value ?? categoryByCode(code)?.businessCategory ?? "");
  return [...new Set(values.filter(Boolean))].join(",");
}

function deriveDetails(draft: Ics1811Draft, notes: Note[]): Detail[] {
  const f = draft.facts;
  const offer = f.offer?.value;
  if (!offer || !f.offer) return [];
  if (offer.pattern === "unsupported") {
    const text = offer.unsupportedType && OFFER_TYPES[offer.unsupportedType]
      ? `「${offer.unsupportedType}」在指引里没有录入说明，demo 暂不支持，需要人工在 1811 录入`
      : `「${offer.unsupportedType}」在 1811 明细优惠类型里没有对应选项，需先确认 ICS 是否支持`;
    notes.push({ id: "unsupported_offer", kind: "unsupported_offer", blocking: true, sop: "§9(四)、§9(五)", text });
    return [];
  }
  const offerQuote = f.offer.quote;
  const { types, float } = offerTypeFor(offer.pattern, { discountEditable: f.discountEditable?.value ?? null, thresholdRepeat: f.thresholdRepeat?.value ?? null, gramBasis: f.gramBasis?.value ?? null });
  const items: OfferItem[] = offer.items.length ? offer.items : [{ discount: null, upgradeRatio: null, multiple: null, threshold: null, amount: null, categories: null }];
  const restrictions: DetailRestriction[] = (f.restrictions?.value ?? []).flatMap((mention) =>
    mention.field && mention.value ? [{ key: mention.field, ...RESTRICTION_LABEL[mention.field], value: field(mention.value, "ai", `原话：${mention.text}`) }] : [],
  );
  (f.restrictions?.value ?? []).forEach((mention, index) => {
    if (!mention.field || !mention.value) {
      notes.push({ id: `restriction:${index}`, kind: "restriction_unresolved", blocking: true, sop: "§9(三)", text: `「${mention.text}」换算不出代码或页面没有对应栏，请给出代码或选「不限定」` });
    }
  });

  const paramValue = (value: number | null) => (value === null ? pending<number | null>(null) : field<number | null>(value, "user", offerQuote));
  const categoriesField = (codes: string[] | null, fixed?: string[]): Field<string[]> =>
    fixed ? field(fixed, "ai", "特殊活动固定货类（§5 表）") : codes?.length ? field(codes, "user", f.categories?.quote ?? offerQuote) : pending<string[]>([]);

  const build = (index: number, typeName: string | null, params: Array<{ spec: ParamSpec; value: number | null }>, codes: string[] | null): Detail => {
    const spec = typeName ? OFFER_TYPES[typeName] : undefined;
    const isFloat = offer.pattern === "discount" && float === true;
    const categories = categoriesField(codes, spec?.fixedCategories);
    const detailParams: DetailParam[] = params.map(({ spec: param, value }) => ({ key: param.key, label: param.label, value: paramValue(value), inferred: spec?.support === "B" }));
    const extra: DetailRestriction[] = offer.pattern === "threshold" ? [{ key: "orderAmountMin", ...RESTRICTION_LABEL.orderAmountMin, value: field("0", "ai", "§9(四)：「满 X 元」填判断金额，整单金额下限填 0") }] : [];
    return {
      index,
      mode: offer.pattern === "discount" && float === null
        ? pending(null, "纯打折要问门店能不能改价")
        : isFloat
          ? field("浮动折扣模式", "user", f.discountEditable?.quote ?? offerQuote)
          : field("固定折扣模式", "ai", offer.pattern === "discount" ? "门店不能改价，选固定模式" : "这类优惠只在固定折扣模式下可选"),
      offerType: isFloat ? field(null, "ai", "浮动折扣模式没有优惠类型") : typeName ? field(typeName, "ai", "按优惠描述映射") : pending(null, "要等用户说清计算方式"),
      params: detailParams,
      categories,
      headCodes: spec?.fixedHeadCodes ? field(spec.fixedHeadCodes, "ai", "特殊活动固定号头（§5 表）") : f.headCodes ? field(f.headCodes.value, "ai", f.headCodes.quote) : field([], "ai", "需求没限定号头，不勾（不限）"),
      memberLevels: f.memberLevels ? field(f.memberLevels.value, "ai", f.memberLevels.quote) : field([], "ai", "需求没限定会员级别，不勾（不限）"),
      priceTypes: isFloat ? null : f.priceTypes ? field(f.priceTypes.value, "ai", f.priceTypes.quote) : field([], "ai", "需求没限定售价类型，不勾（不限）"),
      businessCategory: categories.value.length ? field(businessCategoryOf(typeName, categories.value), "default", "按编造的「货类 → 业务大类」对照表", "业务大类可填值待确认（§8(4)）") : pending("", "货类定了才能对照"),
      concessionRate: f.rates ? field<number | null>(f.rates.value.concession, "user", f.rates.quote) : pending<number | null>(null),
      collectionRate: f.rates ? field<number | null>(f.rates.value.collection, "user", f.rates.quote) : pending<number | null>(null),
      restrictions: [...extra, ...restrictions],
    };
  };

  const shared = slotCategories(draft, "all");
  const paramsOf = (typeName: string | null, item: OfferItem, fallback: ParamSpec[]): Array<{ spec: ParamSpec; value: number | null }> => {
    const specs = typeName ? OFFER_TYPES[typeName].params : fallback;
    const valueOf: Record<ParamSpec["key"], number | null> = {
      discount: item.discount,
      billingDiscount: item.discount,
      upgradeRatio: item.upgradeRatio,
      judgeAmount: offer.pattern === "platinum_tradein" ? item.multiple : item.threshold,
      offerAmount: item.amount,
    };
    return specs.map((spec) => ({ spec, value: valueOf[spec.key] }));
  };

  let details: Detail[];
  switch (offer.pattern) {
    case "discount":
      details = items.map((item, index) => build(index + 1, float === false ? "售价固定折扣" : null, paramsOf(float === false ? "售价固定折扣" : null, item, FLOAT_PARAMS), item.categories ?? shared));
      break;
    case "diamond_gold_gram":
      details = [
        build(1, "买钻石享黄金克减", paramsOf("买钻石享黄金克减", items[0], []), slotCategories(draft, "diamond")),
        build(2, "金价每克减免", paramsOf("金价每克减免", items[0], []), slotCategories(draft, "gold")),
      ];
      break;
    case "threshold":
    case "per_gram":
    case "gold_tradein":
    case "platinum_tradein":
    case "diamond_upgrade": {
      const typeName = types[0] ?? null;
      const fallback: ParamSpec[] = offer.pattern === "threshold"
        ? OFFER_TYPES.满减.params
        : offer.pattern === "per_gram"
          ? OFFER_TYPES.金价每克减免.params
          : OFFER_TYPES[offer.pattern === "gold_tradein" ? "黄金以旧换新" : offer.pattern === "platinum_tradein" ? "铂金换购特殊营销折扣" : "钻石以小换大"].params;
      details = items.map((item, index) => build(index + 1, typeName, paramsOf(typeName, item, fallback), item.categories ?? shared));
      break;
    }
  }

  for (const typeName of new Set(details.map((detail) => detail.offerType.value).filter((name): name is string => Boolean(name)))) {
    if (OFFER_TYPES[typeName]?.support === "B") {
      notes.push({ id: `inferred:${typeName}`, kind: "inferred_columns", blocking: false, sop: "设计决策 D3", text: `「${typeName}」的参数栏是按 SOP 推断的，录入时以页面为准` });
    }
  }
  if (f.priceTypes && details.some((detail) => detail.priceTypes === null)) {
    notes.push({ id: "price_type_lost", kind: "price_type_lost", blocking: false, sop: "§9(三)", text: `浮动折扣模式没有售价类型栏，「${f.priceTypes.value.join("、")}」这条限定录不进去` });
  }
  return details;
}

function deriveSettlement(draft: Ics1811Draft): FillModel["settlement"] {
  const codes = draft.facts.stores?.value ?? [];
  if (codes.length < 2) return null;
  const letter = draft.facts.settlementLetter;
  const month = draft.facts.dates ? Number(draft.facts.dates.value.start.slice(5, 7)) : null;
  // 命名顺序先按示例「闽深A区3319东门茂业4月」（区域+分区+店号+简写店名+月份），与规则文字的顺序不一致，见设计文档 13.1 节。
  const fileNames = letter?.value && month
    ? codes.map((code) => {
        const store = storeByCode(code);
        const region = store ? byCode(CODEBOOK.regions, store.region)?.label.replace(/区$/, "") ?? "" : "";
        return `${region}${store?.division ?? ""}${code}${store?.shortName ?? ""}${month}月`;
      })
    : [];
  return { has: letter ? field<boolean | null>(letter.value, "user", letter.quote) : pending<boolean | null>(null, "多家门店要问有没有结算说明函"), fileNames };
}

function derivePostActions(pattern: string | undefined, settlement: FillModel["settlement"], details: Detail[]): PostAction[] {
  const actions: PostAction[] = [
    { id: "finish_add", text: "核对「已添加折扣」，点「完成新增」，必须看到「上传服务器成功」", sop: "§3(四)、§7" },
    { id: "check_oa", text: "确认 OA 审批是否已发起（指引没写明 1811 完成新增后是否自动发起）", sop: "§8(1)" },
  ];
  if (pattern === "platinum_tradein" || pattern === "diamond_upgrade") {
    actions.push({ id: "group_17", text: "进 ICS-1815，输入审批编号，点「修改」，活动分组改为「17)货品回购」并点「确定」；改不了先请 OA 审批人拒绝，改完再重新提交", sop: "§5(一)7、§5(二)7" });
  }
  if (pattern === "gold_tradein") {
    actions.push({ id: "group_19", text: "进 ICS-1815，活动分组改为「19)增值服务」，否则无法录入旧金；改不了先请 OA 审批人拒绝，改完再重新提交", sop: "§5(三)7" });
  }
  if (settlement?.has.value) actions.push({ id: "upload_settlement", text: "点「新增」后上传每家门店的结算说明函，每个文件都要看到「上传成功」", sop: "§3(二)" });
  if (details.some((detail) => detail.headCodes.value.length)) actions.push({ id: "rows_by_head_code", text: "完成新增后结果表会按号头展开成多行，行数会多于明细条数", sop: "03h" });
  return actions;
}

export function deriveFill(draft: Ics1811Draft): FillModel {
  const notes: Note[] = [];
  const info = deriveInfo(draft, notes);
  const details = deriveDetails(draft, notes);
  const settlement = deriveSettlement(draft);
  const pattern = draft.facts.offer?.value.pattern;
  const group = pattern === "platinum_tradein" || pattern === "diamond_upgrade" ? "17" : pattern === "gold_tradein" ? "19" : "3";
  const groupEntry = byCode(CODEBOOK.activityGroups, group);
  // 只有明确不带成交优惠的活动才不在范围；「搞个黄金活动」这种还没说怎么优惠的，按 Q3 追问（设计文档 4.3 节）。
  const outOfScope = !draft.facts.offer && /抽奖|签到|打卡|集赞|讲座|沙龙|(没有|不做|不给|不搞)(任何)?(优惠|折扣|让利)/.test(draft.requestText)
    ? "这像是不带成交优惠的活动，不在 1811 优惠开单范围。如果有打折、满减、每克减这类优惠，直接告诉我怎么优惠"
    : null;
  return {
    info,
    settlement,
    details,
    activityGroup: { value: groupEntry?.display ?? group, basis: group === "3" ? "保持默认" : "建完后在 ICS-1815 修改（§5 表）" },
    postActions: derivePostActions(pattern, settlement, details),
    notes: notes.filter((note) => !(note.kind === "restriction_unresolved" && draft.dismissedNotes.includes(note.id))),
    outOfScope,
  };
}
