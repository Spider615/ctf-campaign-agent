import assert from "node:assert/strict";
import test from "node:test";

import { formatMessageTime, messageTimeTitle } from "../app/lib/client/message-time.ts";

test("today's message timestamp only shows time in the campaign timezone", () => {
  const iso = "2026-09-17T03:05:00.000Z";
  const now = new Date("2026-09-17T15:59:00.000Z");
  assert.equal(formatMessageTime(iso, now), "11:05");
  assert.equal(messageTimeTitle(iso), "2026年9月17日 11:05:00");
});

test("historical message timestamp includes month and day", () => {
  const iso = "2026-09-16T16:05:00.000Z";
  const now = new Date("2026-09-17T01:00:00.000Z");
  assert.equal(formatMessageTime(iso, now), "00:05", "上海日期相同就仍算当天");
  assert.equal(formatMessageTime(iso, new Date("2026-09-18T01:00:00.000Z")), "9月17日 00:05");
});

test("invalid message timestamps show an explicit unknown-time label", () => {
  assert.equal(formatMessageTime("not-a-date", new Date("2026-09-17T01:00:00.000Z")), "时间未知");
  assert.equal(messageTimeTitle("not-a-date"), "时间未知");
});
