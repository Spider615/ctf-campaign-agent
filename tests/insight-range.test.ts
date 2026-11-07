import assert from "node:assert/strict";
import test from "node:test";
import { checkRange, festivalsOf, isFullRange, MIN_RANGE_DAYS, parseRangeParams, rangeDays, rangeFromSearch, rangeLabel, rangeSearch } from "../app/lib/insight/range.ts";

test("范围解析：都不给是全月；只给一个、格式错、日期不存在、倒序都拒绝", () => {
  assert.equal(parseRangeParams(null, null), null);
  assert.equal(parseRangeParams("", ""), null);
  assert.deepEqual(parseRangeParams("20250823", "20250829"), { from: "20250823", to: "20250829" });
  assert.throws(() => parseRangeParams("20250823", null), /起止日期要一起给/);
  assert.throws(() => parseRangeParams("2025-08-23", "20250829"), /日期格式/);
  assert.throws(() => parseRangeParams("20250231", "20250301"), /日期格式/);
  assert.throws(() => parseRangeParams("20250829", "20250823"), /开始日期不能晚于结束日期/);
});

test("范围校验：越界、短于 3 天拒绝；整段数据范围合法", () => {
  assert.equal(MIN_RANGE_DAYS, 3);
  assert.equal(rangeDays({ from: "20250823", to: "20250829" }), 7);
  assert.equal(rangeDays({ from: "20250831", to: "20250901" }), 2);
  assert.doesNotThrow(() => checkRange({ from: "20250801", to: "20250831" }, "20250801", "20250831"));
  assert.doesNotThrow(() => checkRange({ from: "20250829", to: "20250831" }, "20250801", "20250831"));
  assert.throws(() => checkRange({ from: "20250730", to: "20250805" }, "20250801", "20250831"), /超出数据范围（8\/1–8\/31）/);
  assert.throws(() => checkRange({ from: "20250830", to: "20250831" }, "20250801", "20250831"), /至少选 3 天/);
});

test("是否全月：不给范围或正好等于数据起止", () => {
  assert.equal(isFullRange(null, "20250801", "20250831"), true);
  assert.equal(isFullRange({ from: "20250801", to: "20250831" }, "20250801", "20250831"), true);
  assert.equal(isFullRange({ from: "20250802", to: "20250831" }, "20250801", "20250831"), false);
});

test("节日预设：按名字分组取起止，名字去掉「节」", () => {
  const days = [{ day: "20250822", festival: null }, { day: "20250823", festival: "七夕节" }, { day: "20250829", festival: "七夕节" }, { day: "20250830", festival: null }];
  assert.deepEqual(festivalsOf(days), [{ name: "七夕", from: "20250823", to: "20250829" }]);
  assert.deepEqual(festivalsOf([]), []);
});

test("URL：写出去再读回来一样；坏参数读成全月", () => {
  const r = { from: "20250823", to: "20250829" };
  assert.equal(rangeSearch(r), "from=20250823&to=20250829");
  assert.equal(rangeSearch(null), "");
  assert.deepEqual(rangeFromSearch(`?mode=insight&${rangeSearch(r)}`), r);
  assert.equal(rangeFromSearch("?from=20250829&to=20250823"), null);
  assert.equal(rangeFromSearch("?from=x"), null);
  assert.equal(rangeLabel(r), "8/23–8/29");
});
