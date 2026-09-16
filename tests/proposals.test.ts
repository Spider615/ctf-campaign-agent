import assert from "node:assert/strict";
import test from "node:test";

import { EXAMPLES } from "../app/lib/campaign/ics1811/examples.ts";
import { applyFactWrites, createEmptyDraft } from "../app/lib/campaign/ics1811/facts.ts";
import { acceptProposals, checkProposal, liveProposals, PROPOSABLE } from "../app/lib/campaign/ics1811/proposals.ts";
import type { Proposal } from "../app/lib/campaign/ics1811/types.ts";

const today = "2026-09-16";
const t2 = EXAMPLES.find((example) => example.id === "T2")!;
// T2 首句后缺日期、让扣点回款率、提成口径、标语。
const t2Draft = () => applyFactWrites(createEmptyDraft("t2", t2.first), t2.firstWrites, { text: t2.first, today }).draft;

const proposalOf = (id: Proposal["id"], answer: Record<string, unknown>): Proposal => {
  const checked = checkProposal(t2Draft(), id, answer);
  if (!checked.ok) throw new Error(checked.reason);
  return checked.proposal;
};

test("提议的文字由代码按事实层渲染，不照搬模型的说法", () => {
  assert.equal(proposalOf("Q5a", { none: true }).text, "让扣点和回款率：让扣点 0，回款率 0");
  assert.equal(proposalOf("Q5b", { commission: "actual_price" }).text, "提成口径：按实际售价算提成");
  assert.equal(proposalOf("Q6a", { wanted: false }).text, "活动标语：不加");
  assert.equal(proposalOf("Q1", { start: "2026-10-01", end: "2026-10-07" }).text, "活动日期：2026-10-01 至 2026-10-07");
});

test("只能提议现在确实缺、且允许提议的项，值要过代码表和取值范围", () => {
  const draft = t2Draft();
  const reason = (id: Proposal["id"], answer: unknown) => {
    const checked = checkProposal(draft, id, answer);
    return checked.ok ? null : checked.reason;
  };
  // 优惠是活动本身、法务确认只能用户说，不在可提议名单里。
  for (const id of ["Q3", "Q3a", "Q3e", "Q6b"] as const) assert.equal(PROPOSABLE.includes(id), false, id);
  assert.match(reason("Q3", { pattern: "discount", items: [{ discount: 0.9 }] }) ?? "", /不能提议/);
  assert.match(reason("Q6b", { legalConfirmed: true }) ?? "", /不能提议/);
  // 标语原文只能用户给。
  assert.match(reason("Q6a", { wanted: true, text: "足金闪耀", legalConfirmed: true }) ?? "", /标语只能提议不加/);
  // 门店已经说过了：和现在一样的不用提议；改成别的可以提议（建好后替用户换算的改动），用户点头才记。
  assert.match(reason("Q2", { stores: ["7590"] }) ?? "", /和现在的值一样/);
  assert.equal(reason("Q2", { stores: ["7590", "3810"] }), null);
  // 结算说明函只能提议「有」。
  assert.match(reason("Q5c", { has: false }) ?? "", /只能提议「有」/);
  // 值不合法：回款率大于 1、日期颠倒。
  assert.ok(reason("Q5a", { concession: 2, collection: 0.98 }));
  assert.ok(reason("Q1", { start: "2026-10-07", end: "2026-10-01" }));
  assert.ok(reason("Q5b", "actual_price"), "answer 不是对象");
});

test("草稿变了以后，已经补上的提议不再有效，文字按当前草稿重算", () => {
  const proposals = [proposalOf("Q5a", { none: true }), proposalOf("Q5b", { commission: "actual_price" })];
  const text = "提成按实际售价乘折扣算";
  const answered = applyFactWrites(t2Draft(), [{ key: "commission", quote: text }], { text, today }).draft;
  assert.deepEqual(liveProposals(answered, proposals).map((item) => item.id), ["Q5a"]);
  assert.deepEqual(liveProposals(t2Draft(), proposals).map((item) => item.id), ["Q5a", "Q5b"]);
});

test("点头时按提议的结构化值记下，来源是 proposal，quote 是用户原话；only 限定只采纳哪几项", () => {
  const proposals = [proposalOf("Q5a", { none: true }), proposalOf("Q5b", { commission: "actual_price" }), proposalOf("Q6a", { wanted: false })];

  const all = acceptProposals(t2Draft(), proposals, "行");
  assert.deepEqual(all.accepted.map((item) => item.id), ["Q5a", "Q5b", "Q6a"]);
  assert.deepEqual(all.keys.sort(), ["commission", "rates", "slogan"]);
  assert.deepEqual(all.draft.facts.rates?.value, { concession: 0, collection: 0 });
  assert.deepEqual([all.draft.facts.rates?.via, all.draft.facts.rates?.quote], ["proposal", "行"]);
  assert.equal(all.draft.facts.commission?.value, "actual_price");

  const some = acceptProposals(t2Draft(), proposals, "对", ["Q5a"]);
  assert.deepEqual(some.accepted.map((item) => item.id), ["Q5a"]);
  assert.equal(some.draft.facts.commission, null, "没点头的提议不能记");
  assert.equal(some.draft.facts.slogan, null);

  // 已经补上的项不会被提议覆盖。
  const text = "提成按实际售价乘折扣算";
  const answered = applyFactWrites(t2Draft(), [{ key: "commission", quote: text }], { text, today }).draft;
  const stale = acceptProposals(answered, proposals, "行");
  assert.equal(stale.draft.facts.commission?.value, "price_times_discount");
  assert.deepEqual(stale.accepted.map((item) => item.id), ["Q5a", "Q6a"]);
});

test("给了今天的日期时，已经过去的活动日期不能提议；没给时只做格式校验", () => {
  assert.equal(checkProposal(t2Draft(), "Q1", { start: "2026-05-01", end: "2026-05-05" }, today).ok, false);
  assert.equal(checkProposal(t2Draft(), "Q1", { start: "2026-10-01", end: "2026-10-07" }, today).ok, true);
  assert.equal(checkProposal(t2Draft(), "Q1", { start: "2026-05-01", end: "2026-05-05" }).ok, true);
  const past = [proposalOf("Q1", { start: "2026-10-01", end: "2026-10-07" })];
  assert.deepEqual(liveProposals(t2Draft(), past, "2026-10-02"), [], "隔天再看，已经开始的日期提议就不再适用");
});

test("不存在的日期不能提议", () => {
  assert.equal(checkProposal(t2Draft(), "Q1", { start: "2026-09-31", end: "2026-10-07" }).ok, false);
});

test("货类提议要按这个活动的槽位：买钻石享黄金克减分钻石和黄金，不能用 all 拍平", () => {
  const t4 = EXAMPLES.find((example) => example.id === "T4")!;
  const draft = applyFactWrites(createEmptyDraft("t4", t4.first), t4.firstWrites, { text: t4.first, today }).draft;
  const flat = checkProposal(draft, "Q4", { slots: { all: ["一般足金类"] } });
  assert.equal(flat.ok, false);
  const split = checkProposal(draft, "Q4", { slots: { diamond: ["钻石类"], gold: ["一般足金类"] } });
  assert.equal(split.ok && split.proposal.text, "货类：钻石：钻石类；黄金：一般足金类");
  // 货类固定的特殊活动（铂金以旧换新）不用提议货类。
  assert.equal(checkProposal(t2Draft(), "Q4", { slots: { all: ["其他铂金类"] } }).ok, false);
});
