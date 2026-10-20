import assert from "node:assert/strict";
import test from "node:test";
import { focusContext, focusOf, locateAnswer, parseSelection, selectionLabel, selectionSearch } from "../app/lib/insight/context.ts";
import { fakeGraph } from "./helpers/insight-fixture.ts";

test("URL 参数互相还原，不认识的节点整条丢掉", () => {
  for (const s of [{ kind: "node", id: "image" }, { kind: "edge", from: "promo", to: "mix" }, { kind: "source", source: "inferred" }] as const) assert.deepEqual(parseSelection(selectionSearch(s)), s);
  assert.equal(parseSelection("node=nope"), null);
  assert.equal(parseSelection("edge=promo>nope"), null);
  assert.equal(parseSelection(""), null);
  assert.equal(selectionSearch(null), "");
});

test("问答上下文写清在看哪个节点或哪条线；来源筛选不带过去", () => {
  const g = fakeGraph();
  assert.equal(focusOf(g, { kind: "source", source: "field" }), null);
  const edge = focusOf(g, { kind: "edge", from: "promo", to: "mix" })!;
  assert.match(focusContext(edge), /连线「活动和力度 → 货品结构」（图上依据：同一家店、同一天/);
  assert.match(focusContext(focusOf(g, { kind: "node", id: "region" })!), /选中了节点「大区 \/ 区域」.*没有明确改变时沿用/);
  assert.equal(selectionLabel(g, null), "整张图");
});

test("问答用到的语义层维度定位到图上的节点", () => {
  assert.equal(locateAnswer(["store", "imageLevel"]), "image");
  assert.equal(locateAnswer(["offer"]), "promo");
  assert.equal(locateAnswer(["store", "day"]), null);
});

test("问答上下文的指代说明能进到计划复核", async () => {
  const { planReviewPrompt } = await import("../app/lib/analytics/plan/prompt.ts");
  const context = focusContext(focusOf(fakeGraph(), { kind: "node", id: "region" })!);
  assert.match(planReviewPrompt("你帮我分析一下这个因素", "{}", undefined, [context]), /原问题里的指代按这里理解[\s\S]*大区 \/ 区域/);
});
