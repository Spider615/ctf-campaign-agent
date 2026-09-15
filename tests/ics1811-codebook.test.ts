import assert from "node:assert/strict";
import test from "node:test";

import { CODEBOOK } from "../app/lib/campaign/ics1811/codebook.ts";
import { OFFER_TYPES } from "../app/lib/campaign/ics1811/offer-spec.ts";
import { USABLE_CODE_TABLES } from "../app/lib/reference/code-tables.ts";

// SOP 第九部分（五）「编造代码表时可参考的真实值」。
const SOP_VALUES = {
  regions: ["0", "201", "202", "203", "204", "205", "206", "209", "210", "211", "212", "213", "214", "230"],
  divisions: ["0区", "A区", "B区", "C区", "D区", "Z区"],
  subAreas: ["WA01", "WA02", "WA03", "WA04", "WA05", "WA06"],
  cities: ["深圳", "潮州", "东莞", "福州", "河源", "惠州"],
  stores: ["7590", "3810", "3145", "3154"],
  categories: ["不适用", "钻石类", "其他收入", "素银类", "银镶嵌类", "珍珠类", "其他铂金类", "金箱（铂金/K金类）", "西金类", "一般足金类", "一般金条/金章"],
  headCodes: ["A", "ARA", "ARU", "AS", "AU", "AYA", "AYU", "CA", "CU", "DU", "EAD", "HA", "HP", "AYF", "EOF", "F", "LF", "ODF", "FF", "U"],
  memberLevels: ["Fans-Member", "挚友", "翡红会员", "白银会员", "黄金会员", "铂金会员", "钻石会员", "贵宾会员", "星级会员", "尊尚会员"],
  priceTypes: ["一口价", "尊享价", "一口价(定)", "高奖励", "一口价(1)", "一口价(HOF)", "OUTLET_50"],
  approvalFlows: ["1", "2", "3", "4", "5", "6", "7", "8"],
  activityGroups: ["3", "17", "19"],
  productScopes: ["0", "1", "2", "3", "4", "5", "6"],
};

const codes = (entries: Array<{ code: string }>) => entries.map((entry) => entry.code);

test("the codebook covers every real value listed in SOP §9(五)", () => {
  for (const key of ["regions", "divisions", "subAreas", "cities", "stores", "categories", "memberLevels", "priceTypes", "approvalFlows", "activityGroups", "productScopes"] as const) {
    const present = codes(CODEBOOK[key]);
    for (const value of SOP_VALUES[key]) assert.ok(present.includes(value), `${key} 缺少 ${value}`);
  }
  const assigned = CODEBOOK.categories.flatMap((entry) => entry.headCodes);
  for (const code of SOP_VALUES.headCodes) assert.ok(assigned.includes(code), `号头 ${code} 没有归属货类`);
  assert.equal(CODEBOOK.offerTypes.length, 15);
  assert.equal(CODEBOOK.paymentMethods.defaults.length, 14);
  assert.ok(CODEBOOK.paymentMethods.defaults.includes("GLP积分抵现"));
});

test("codebook references are internally consistent", () => {
  for (const store of CODEBOOK.stores) {
    assert.ok(codes(CODEBOOK.regions).includes(store.region), `${store.code} 的区域不存在`);
    if (store.division) assert.ok(codes(CODEBOOK.divisions).includes(store.division), `${store.code} 的分区不存在`);
    if (store.city) assert.ok(codes(CODEBOOK.cities).includes(store.city), `${store.code} 的城市不存在`);
    assert.ok(store.shortName, `${store.code} 缺少简写店名（结算说明函命名要用）`);
  }
  for (const category of CODEBOOK.categories) {
    if (category.code !== "不适用") assert.ok(CODEBOOK.businessCategories.includes(category.businessCategory), `${category.code} 的业务大类不在对照表内`);
  }
  for (const override of CODEBOOK.businessCategoryOverrides) {
    assert.ok(CODEBOOK.businessCategories.includes(override.value));
    assert.ok(CODEBOOK.offerTypes.includes(override.offerType));
  }
  for (const brand of CODEBOOK.brands) assert.ok(codes(CODEBOOK.approvalFlows).includes(brand.approvalFlow), `${brand.code} 的审批流不存在`);
  for (const name of CODEBOOK.offerTypes) assert.ok(OFFER_TYPES[name], `优惠类型 ${name} 没有规格`);
  const headOwners = CODEBOOK.categories.flatMap((entry) => entry.headCodes);
  assert.equal(new Set(headOwners).size, headOwners.length, "一个号头只属于一个货类");
});

test("every value is labelled with where it came from", () => {
  const entries = [...CODEBOOK.regions, ...CODEBOOK.stores, ...CODEBOOK.categories, ...CODEBOOK.brands, ...CODEBOOK.approvalFlows, ...CODEBOOK.productScopes, ...CODEBOOK.menuConversions];
  for (const entry of entries) assert.ok(["截图", "指引文字", "导入模板", "编造"].includes(entry.origin), entry.code);
  assert.ok(CODEBOOK.stores.some((entry) => entry.origin === "编造"), "编造的门店要标出来");
});

test("the seven evidenced tables in code-tables.ts agree with the codebook", () => {
  const table = (key: string) => USABLE_CODE_TABLES.find((item) => item.key === key)!.values.map((value) => value.label);
  assert.deepEqual(
    table("approval_flow").map((label) => /^(.*)\((\d+)\)$/.exec(label)!.slice(1, 3).reverse()),
    CODEBOOK.approvalFlows.map((entry) => [entry.code, entry.label]),
  );
  assert.deepEqual(table("product_scope"), CODEBOOK.productScopes.map((entry) => entry.display));
  assert.deepEqual(table("menu_conversion"), CODEBOOK.menuConversions.map((entry) => entry.display));
  assert.deepEqual(table("activity_group"), CODEBOOK.activityGroups.map((entry) => entry.display));
  assert.deepEqual(table("channel"), CODEBOOK.channels.map((entry) => entry.display));
  assert.deepEqual(table("offer_nature"), CODEBOOK.offerNatures.map((entry) => entry.display));
  for (const label of table("offer_type_name")) {
    assert.ok(Object.values(OFFER_TYPES).some((spec) => spec.pageLabel === label || spec.name === label), `优惠类型 ${label} 对不上`);
  }
});
