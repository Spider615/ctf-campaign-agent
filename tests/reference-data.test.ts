import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { USABLE_CODE_TABLES } from "../app/lib/reference/code-tables.ts";
import { DESIGN_DEFAULTS, SOP_QUESTIONS } from "../app/lib/reference/open-questions.ts";

type ExtractionField = { label: string; enum_values?: string[] };
type ExtractionEntry = { slide: number; fields?: ExtractionField[] };

const extraction: ExtractionEntry[] = JSON.parse(
  readFileSync(new URL("../references/ppt-field-extraction.json", import.meta.url), "utf8"),
);
const researchGapsText = readFileSync(new URL("../references/research-gaps.json", import.meta.url), "utf8");

const allValues = USABLE_CODE_TABLES.flatMap((table) => table.values.map((value) => ({ table: table.name, ...value })));

const entriesOnSlide = (slide: number) => extraction.filter((entry) => entry.slide === slide);
const slideText = (slide: number) => entriesOnSlide(slide).map((entry) => JSON.stringify(entry)).join("\n");

// research-gaps.json 里截图代际的写法：2019（image43）、2020-2021（image10/13/23/27/41）……
function screenshotGenerations(text: string): Map<string, { from: number; to: number }> {
  const generations = new Map<string, { from: number; to: number }>();
  for (const match of text.matchAll(/(\d{4})(?:-(\d{4}))?（image(\d+(?:\/\d+)*)）/g)) {
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    for (const id of match[3].split("/")) generations.set(`image${id}`, { from, to });
  }
  return generations;
}

test("usable code tables are the seven evidenced tables, each with values", () => {
  assert.deepEqual(
    USABLE_CODE_TABLES.map((table) => table.name),
    ["审批流", "货品范围", "转换餐牌", "活动分组", "线上线下", "优惠性质", "优惠类型名称"],
  );
  assert.equal(new Set(USABLE_CODE_TABLES.map((table) => table.key)).size, 7);
  for (const table of USABLE_CODE_TABLES) {
    assert.ok(table.values.length >= 1, `${table.name} 没有取值`);
  }
});

test("every raw value appears verbatim in enum_values on its cited slide", () => {
  // 目前所有取值都能在 enum_values 里逐字找到，不需要退回到 rules 文本比对。
  // 以后如果有码表只在 rules 文本里出现，应单独列出并注明原因，不要放宽这条断言。
  for (const value of allValues) {
    const entries = entriesOnSlide(value.slide);
    assert.ok(entries.length > 0, `${value.table}「${value.raw}」引用的第 ${value.slide} 页没有抽取条目`);
    const found = entries.some((entry) =>
      (entry.fields ?? []).some((field) => (field.enum_values ?? []).includes(value.raw)),
    );
    assert.ok(found, `${value.table}「${value.raw}」不在第 ${value.slide} 页任何字段的 enum_values 里`);
  }
});

test("every cited screenshot is named on its slide, except the documented inference", () => {
  // 第 15 页的抽取条目没写截图编号，code-tables.ts 按前后页编号推定为 image28（见该文件注释）。
  const inferred = new Set(["15:image28"]);
  for (const value of allValues) {
    if (inferred.has(`${value.slide}:${value.image}`)) continue;
    assert.match(
      slideText(value.slide),
      new RegExp(`${value.image}(?!\\d)`),
      `${value.table}「${value.raw}」引用的 ${value.image} 没出现在第 ${value.slide} 页的抽取条目里`,
    );
  }
});

test("evidence years come from a screenshot generation or a date on the cited slide", () => {
  const generations = screenshotGenerations(researchGapsText);
  assert.deepEqual(generations.get("image43"), { from: 2019, to: 2019 });
  assert.deepEqual(generations.get("image27"), { from: 2020, to: 2021 });

  for (const value of allValues) {
    const label = `${value.table}「${value.raw}」`;
    if (value.year === null) {
      assert.equal(value.yearBasis, null, `${label} 没有年份却写了年份依据`);
      continue;
    }
    assert.ok(value.yearBasis, `${label} 有年份但没写依据`);
    assert.ok(value.yearBasis.includes(String(value.year)), `${label} 的年份依据里没有 ${value.year}`);

    const generation = generations.get(value.image);
    const inGeneration = generation !== undefined && value.year >= generation.from && value.year <= generation.to;
    const datedOnSlide = new RegExp(`${value.year}[-/]\\d{1,2}[-/]\\d{1,2}`).test(slideText(value.slide));
    assert.ok(inGeneration || datedOnSlide, `${label} 的年份 ${value.year} 在截图代际和第 ${value.slide} 页日期里都找不到`);
  }
});

test("the open-questions page lists the twelve SOP gaps and P1–P12, each with how the demo handles it", () => {
  assert.deepEqual(SOP_QUESTIONS.map((item) => item.id), Array.from({ length: 12 }, (_, index) => index + 1));
  for (const item of SOP_QUESTIONS) {
    assert.ok(item.question.trim(), `第 ${item.id} 项缺少要确认的内容`);
    assert.ok(item.handling.trim(), `第 ${item.id} 项缺少 demo 的处理方式`);
    assert.match(item.sop, /§\d/, `第 ${item.id} 项缺少 SOP 出处`);
  }
  assert.deepEqual(DESIGN_DEFAULTS.map((item) => item.id), Array.from({ length: 12 }, (_, index) => `P${index + 1}`));
});
