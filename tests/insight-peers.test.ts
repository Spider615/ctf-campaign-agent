import assert from "node:assert/strict";
import test from "node:test";
import { comparePeers, findOutliers, mainPart, peerGroups, type PeerMetric, type PeerStore } from "../app/lib/insight/peers.ts";
import { fakeGraph } from "./helpers/insight-fixture.ts";

const store = (i: number, over: Partial<PeerStore> = {}): PeerStore => ({ id: `S${i}`, name: `店${i}`, image: "重奢场", shopType: "购物中心", region: "华南", bigRegion: "南区",
  days: 31, sales: 3.1e6, gp: 6e5, revEx: 2.7e6, orders: 310, items: 400, gold: 2e6, baseGold: 1e6, heavyGold: 5e5, goldGrams: 2000, goldQty: 250, promoDays: 10, ...over });
const share: PeerMetric = { label: "计价金占比", of: (s) => s.gold / s.sales * 100, kind: "pp", fmt: (v) => `${v.toFixed(1)}%` };
const gm: PeerMetric = { label: "毛利率", of: (s) => s.gp / s.revEx * 100, kind: "pp", fmt: (v) => `${v.toFixed(1)}%` };
const sales: PeerMetric = { label: "月销售额", of: (s) => s.sales, kind: "log", fmt: (v) => `${v}` };

test("同类店分组：一格不到 20 家并到大区，并完还不够的不比", () => {
  const stores = [...Array.from({ length: 25 }, (_, i) => store(i)),
    ...Array.from({ length: 12 }, (_, i) => store(100 + i, { region: "江苏" })), ...Array.from({ length: 10 }, (_, i) => store(200 + i, { region: "浙江" })),
    ...Array.from({ length: 5 }, (_, i) => store(300 + i, { shopType: "百货" }))];
  const groups = peerGroups(stores.map((s, i) => i >= 25 && i < 47 ? { ...s, bigRegion: "东区" } : s));
  assert.deepEqual(groups.map((g) => [g.label, g.stores.length]).sort(), [["重奢场 · 购物中心 · 东区", 22], ["重奢场 · 购物中心 · 华南", 25]]);
});

test("同类店对比：三种结论都按数据给，落后的店只在关系成立时给", () => {
  // 计价金占比越高毛利率越低：图上方向是 -1，结论成立。
  const works = Array.from({ length: 40 }, (_, i) => store(i, { gold: 1e6 + i * 5e4, gp: 8e5 - i * 1e4 }));
  const a = comparePeers(peerGroups(works), share, gm, -1)!;
  assert.equal(a.verdict, "works"); assert.equal(a.agree, 1); assert.match(a.text, /低 \d/); assert.ok(a.laggards.length > 0);
  assert.equal(a.example.k, 10); assert.ok(a.example.hi.value < a.example.lo.value);
  // 同一份数据说成「越高越好」就是方向相反，不给落后名单。
  const r = comparePeers(peerGroups(works), share, gm, 1)!; assert.equal(r.verdict, "reverse"); assert.deepEqual(r.laggards, []);
  // 毛利率和计价金占比无关：不明显。
  const flat = Array.from({ length: 40 }, (_, i) => store(i, { gold: 1e6 + i * 5e4, gp: 6e5 + (i % 2) * 1e3 }));
  const f = comparePeers(peerGroups(flat), share, gm, -1)!; assert.equal(f.verdict, "flat"); assert.match(f.text, /关系不明显/);
  assert.equal(comparePeers([], share, gm, -1), null);
});

test("离群店：按同类中位数和 MAD 找，拆出主因；营业天数少的归为数据不完整", () => {
  const stores = Array.from({ length: 40 }, (_, i) => store(i, { sales: 3e6 + (i % 5) * 5e4, orders: 300 + (i % 5) * 5 }));
  stores[0] = store(0, { sales: 3e5, orders: 30 });             // 单量低
  stores[1] = store(1, { sales: 4e5, orders: 40, days: 4 });     // 只有 4 天
  const parts = mainPart([{ label: "营业天数", of: (s) => s.days, fmt: (v) => `${v} 天`, incomplete: true }, { label: "日均订单数", of: (s) => s.orders / s.days, fmt: (v) => `${v.toFixed(1)} 单` }, { label: "客单价", of: (s) => s.sales / s.orders, fmt: (v) => `${v.toFixed(0)} 元` }]);
  const lines = findOutliers(peerGroups(stores), { metric: sales, explain: parts });
  assert.match(lines[0], /有 2 家：偏高 0 家、偏低 2 家/);
  assert.ok(lines.some((l) => l.startsWith("店0（S0）") && l.includes("主要是日均订单数低")));
  assert.match(lines.at(-1)!, /另有 1 家主要是营业天数少.*店1（S1） 只有 4 天/);
  assert.deepEqual(findOutliers(peerGroups(stores.slice(2)), { metric: sales, explain: parts }), []);
});

test("图谱：门店层面的线带同类店对比，离群店写进异常", () => {
  const g = fakeGraph(); const e = (k: string) => g.edges.find((x) => `${x.from}>${x.to}` === k)!;
  for (const k of ["mix>gm", "threshold>promo", "promo>aov", "promo>orders", "depth>promo", "shift>promo"]) assert.ok(e(k).peers, k);
  for (const x of g.edges) if (x.peers) { assert.ok(x.peers.groups >= 1); assert.ok(x.peers.example.n >= 20); if (x.peers.verdict !== "works") assert.deepEqual(x.peers.laggards, []); }
  assert.equal(e("orders>sales").peers, undefined);
});

test("图上三步讲解：和三句结论一一对应，链路上的节点都在图上、相邻两点之间都有线", () => {
  const g = fakeGraph();
  assert.equal(g.stories.length, g.summary.length);
  g.stories.forEach((s, i) => {
    assert.equal(s.text, g.summary[i]); assert.ok(s.title.length <= 8, s.title);
    for (const id of s.path) assert.ok(g.nodes.some((n) => n.id === id), id);
    const ends = new Set(s.path.slice(1));
    for (const id of s.path.slice(0, -1)) assert.ok(g.edges.some((e) => e.from === id && ends.has(e.to)), `${id} 没有连到链路上的下一站`);
  });
  for (const id of ["orders", "aov", "gm", "qty", "sales", "gp"]) assert.ok(g.nodes.find((n) => n.id === id)?.value, id);
});
