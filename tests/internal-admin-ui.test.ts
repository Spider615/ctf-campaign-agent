import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CHANNEL_LABEL, durationText, groupByChannel, requestStatusText, tokenText, turnStatusText } from "../app/lib/internal/format.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Token 为 null 显示「未提供」，0 照常显示", () => {
  assert.equal(tokenText(null), "未提供");
  assert.equal(tokenText(undefined), "未提供");
  assert.equal(tokenText(0), "0");
  assert.equal(tokenText(1234567), "1,234,567");
});

test("请求和轮次状态文案", () => {
  assert.equal(requestStatusText("incomplete"), "不完整");
  assert.equal(requestStatusText("interrupted"), "中断");
  assert.equal(turnStatusText("cancelled"), "已取消");
  assert.equal(turnStatusText("interrupted"), "中断");
  assert.equal(durationText(undefined), "—");
  assert.equal(durationText(1530), "1.5 秒");
  assert.equal(durationText(125_000), "2 分 5 秒");
});

test("按渠道分组，不产生跨渠道合计", () => {
  const groups = groupByChannel([
    { channel: "juzi", day: "2026-10-20", inputTokens: 5 },
    { channel: "deepseek", day: "2026-10-20", inputTokens: 3 },
    { channel: "deepseek", day: "2026-10-21", inputTokens: 4 },
  ]);
  assert.deepEqual(groups.map((group) => [group.channel, group.rows.length]), [["deepseek", 2], ["juzi", 1]]);
  assert.equal(CHANNEL_LABEL.deepseek, "DeepSeek 官方");
  assert.equal(CHANNEL_LABEL.juzi, "句子互动网关");
});

test("总览按渠道各一张表，费用列为「来源未接入」，没有合计行", () => {
  const page = read("app/components/internal/stats-view.tsx");
  assert.match(page, /groupByChannel\(/);
  assert.match(page, /来源未接入/);
  assert.doesNotMatch(page, /合计|总计/);
});

test("Token 都经 tokenText 渲染，401 跳到登录页", () => {
  for (const file of ["app/components/internal/stats-view.tsx", "app/components/internal/conversations-view.tsx", "app/components/internal/conversation-detail.tsx"]) {
    const source = read(file);
    assert.doesNotMatch(source, /\{(?:row|item|request|turn|model)\.(?:input|output|cacheRead|cacheWrite)Tokens\}/, `${file} 不能直接渲染 Token 原值`);
  }
  const api = read("app/lib/internal/client.ts");
  assert.match(api, /status === 401/);
  assert.match(api, /\/internal\/login/);
});

test("会话详情展示真实厂商和模型，SDK 别名放在技术详情里", () => {
  const detail = read("app/components/internal/conversation-detail.tsx");
  assert.match(detail, /sentModel/);
  assert.match(detail, /upstreamModel/);
  assert.match(detail, /<details[\s\S]*sdkModel/);
});

test("管理端页面不套客户侧栏", () => {
  assert.match(read("app/components/app-shell.tsx"), /pathname\.startsWith\("\/internal\/stats"\)/);
});

test("管理端用左侧菜单导航，退出放在菜单底部", () => {
  const shell = read("app/components/internal/internal-shell.tsx");
  assert.match(shell, /<aside[\s\S]*<nav[\s\S]*NAV\.map[\s\S]*退出[\s\S]*<\/aside>/);
  assert.doesNotMatch(shell, /<header[\s\S]*<nav/, "菜单不再放在顶部");
});
