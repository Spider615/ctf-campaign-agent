// 同类店对比和离群店：商圈形象、铺型、区域都相同的门店放一组（不到 20 家的放宽到大区），在组内比。
// 跨类型比会把商圈、铺型带来的差异混进来，组内比才看得出这个参数本身和结果的关系。
// 纯函数，文字是模板，数字全部出自门店汇总。
import { median } from "./stats.ts";
import type { InsightOutliers, InsightPeers } from "./types.ts";

// 一家店一个月的汇总（来自门店日面板）。promoDays：有克减 50 / 克减 30 / 金色星期二成交的天数。
export type PeerStore = {
  id: string; name: string; image: string; shopType: string; region: string; bigRegion: string;
  days: number; sales: number; gp: number; revEx: number; orders: number; items: number;
  gold: number; baseGold: number; heavyGold: number; goldGrams: number; goldQty: number; promoDays: number;
};
export type PeerGroup = { label: string; stores: PeerStore[] };
export const MIN_GROUP = 20;
// 离群门槛：离同类中位数超过 3.5 个 MAD（中位数绝对偏差，× 1.4826 换成和标准差同一尺度）。
export const OUTLIER_Z = 3.5;

const n0 = (v: number) => Math.round(v).toLocaleString("zh-CN");
const n1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const short = (k: string) => k.split("/")[0];
export const storeName = (s: PeerStore) => s.name && s.name !== s.id ? `${s.name}（${s.id}）` : `门店 ${s.id}`;

// 先按形象 × 铺型 × 区域分；那一格不到 20 家的店，按形象 × 铺型 × 大区再并一次；还不到 20 家的不比。
export function peerGroups(stores: readonly PeerStore[], min = MIN_GROUP): PeerGroup[] {
  const fine = (s: PeerStore) => `${s.image}\u0000${s.shopType}\u0000${s.region}`;
  const count = new Map<string, number>(); for (const s of stores) count.set(fine(s), (count.get(fine(s)) ?? 0) + 1);
  const groups = new Map<string, PeerGroup>();
  for (const s of stores) {
    const narrow = (count.get(fine(s)) ?? 0) >= min;
    const key = narrow ? fine(s) : `${s.image}\u0000${s.shopType}\u0000${s.bigRegion}\u0000*`;
    const group = groups.get(key) ?? { label: `${short(s.image)} · ${s.shopType} · ${narrow ? s.region : s.bigRegion}`, stores: [] };
    group.stores.push(s); groups.set(key, group);
  }
  return [...groups.values()].filter((g) => g.stores.length >= min);
}

// 一个门店指标：log 指标按倍数比（销售额、客单价这类），pp 指标按百分点比（毛利率、占比）。
export type PeerMetric = { label: string; of: (s: PeerStore) => number; kind: "log" | "pp"; fmt: (v: number) => string };
const ok = (v: number, m: PeerMetric) => Number.isFinite(v) && (m.kind === "pp" || v > 0);

// 同类店对比：每组按参数从高到低排，取最高、最低各四分之一，比两头结果的中位数；各组按店数加权汇总。
// sign：图上这条线说的方向，参数越高结果越好是 1，越差是 -1。结果都是越高越好。
export function comparePeers(groups: readonly PeerGroup[], param: PeerMetric, outcome: PeerMetric, sign: 1 | -1): InsightPeers | null {
  const rows = groups.flatMap((g) => {
    const valid = g.stores.filter((s) => ok(param.of(s), param) && ok(outcome.of(s), outcome)).sort((a, b) => param.of(b) - param.of(a));
    if (valid.length < MIN_GROUP) return [];
    const k = Math.floor(valid.length / 4); const hi = valid.slice(0, k); const lo = valid.slice(-k);
    const mh = median(hi.map(outcome.of))!; const ml = median(lo.map(outcome.of))!;
    if (outcome.kind === "log" && (mh <= 0 || ml <= 0)) return [];
    return [{ g, valid, k, hi, lo, mh, ml, d: outcome.kind === "log" ? Math.log(mh / ml) : mh - ml }];
  });
  if (!rows.length) return null;
  const stores = rows.reduce((a, r) => a + r.valid.length, 0);
  const d = rows.reduce((a, r) => a + r.d * r.valid.length, 0) / stores;
  const agree = rows.filter((r) => Math.sign(r.d) === Math.sign(d)).length;
  const size = outcome.kind === "log" ? Math.abs(Math.exp(d) - 1) * 100 : Math.abs(d);
  const notable = outcome.kind === "log" ? size >= 10 : size >= 2;
  const verdict = notable && agree / rows.length >= 0.7 ? (Math.sign(d) === sign ? "works" : "reverse") : "flat";
  const gap = outcome.kind === "log" ? `${n1(size)}%` : `${n1(size)} 个百分点`;
  const scope = `同类店里比（商圈形象、铺型、区域相同，${rows.length} 组 ${n0(stores)} 家店）`;
  const text = verdict === "flat"
    ? `${scope}：${param.label}高的店和低的店，${outcome.label}只差 ${gap}，${agree}/${rows.length} 组方向一致，看不出明显关系。`
    : `${scope}：${param.label}最高的 1/4 店，${outcome.label}比最低的 1/4 店${d > 0 ? "高" : "低"} ${gap}；${agree}/${rows.length} 组方向一致${verdict === "reverse" ? "，和图上这条线说的方向相反" : ""}。`;
  // 实例：店最多的一组，两头的参数和结果中位数。
  const ex = [...rows].sort((a, b) => b.valid.length - a.valid.length)[0];
  const example = { group: ex.g.label, n: ex.valid.length, k: ex.k, param: param.label, outcome: outcome.label,
    hi: { param: param.fmt(median(ex.hi.map(param.of))!), outcome: outcome.fmt(ex.mh), value: ex.mh },
    lo: { param: param.fmt(median(ex.lo.map(param.of))!), outcome: outcome.fmt(ex.ml), value: ex.ml } };
  // 落后的店：只在关系成立时给。参数落在不利的那四分之一、结果又低于同类中位数，按结果差多少排。
  const lag = verdict !== "works" ? [] : rows.flatMap((r) => {
    const om = median(r.valid.map(outcome.of))!; const pm = median(r.valid.map(param.of))!;
    return (sign > 0 ? r.lo : r.hi).filter((s) => outcome.of(s) < om).map((s) => ({ s, r, om, pm, gap: outcome.kind === "log" ? outcome.of(s) / om : outcome.of(s) - om }));
  }).sort((a, b) => a.gap - b.gap).slice(0, 5);
  const laggards = lag.map(({ s, r, om, pm }) => `${storeName(s)}（${r.g.label}）：${param.label} ${param.fmt(param.of(s))}（同类 ${param.fmt(pm)}），${outcome.label} ${outcome.fmt(outcome.of(s))}（同类 ${outcome.fmt(om)}）`);
  const lagRows = lag.map(({ s, om }) => ({ name: s.name && s.name !== s.id ? s.name : `门店 ${s.id}`, value: outcome.of(s), peer: om }));
  return { text, verdict, groups: rows.length, agree, stores, example, laggards, lagRows };
}

// 离群店的成因：把指标拆成几个乘数（log）或看一个对照量，说清主要偏在哪一项。
// incomplete：主要是营业天数少，属于数据不完整，单独归一类、先排除，不当成经营问题。
export type OutlierCause = { label: string; incomplete?: boolean };
// incomplete：不管拆出来是哪一项，都先算数据不完整的店（比如一个月只有几天有成交）。
export type OutlierSpec = { metric: PeerMetric; explain: (s: PeerStore, peers: readonly PeerStore[], high: boolean) => OutlierCause; incomplete?: (s: PeerStore) => boolean };

// 乘数拆解：metric = ∏ parts。偏低时取偏得最低的一项，偏高时取最高的一项。
export type Part = { label: string; of: (s: PeerStore) => number; fmt: (v: number) => string; incomplete?: boolean };
export function mainPart(parts: readonly Part[]) {
  return (s: PeerStore, peers: readonly PeerStore[], high: boolean): OutlierCause => {
    const devs = parts.map((p) => { const m = median(peers.map(p.of).filter((v) => v > 0)) ?? 0; const v = p.of(s); return { p, m, v, dev: v > 0 && m > 0 ? Math.log(v / m) : 0 }; });
    const top = devs.sort((a, b) => high ? b.dev - a.dev : a.dev - b.dev)[0];
    return { label: `${top.p.label}${high ? "高" : "低"}：${top.p.fmt(top.v)}（同类 ${top.p.fmt(top.m)}）`, incomplete: top.p.incomplete };
  };
}

// 页面上的店名：去掉品牌前缀（周大福荟馆、JEWELRIA 这类）和「珠宝店」后缀，留下城市和地标。
export const shortStoreName = (name: string) => name.replace(/^(周大福)?(荟馆|传承|奢华店)?\s*(JEWELRIA|MONOLOGUE|SOINLOVE|ENZO|HEARTS ON FIRE)?\s*/i, "").replace(/(珠宝)?店$/, "") || name;

// 离群店：text 是原来的几句话（问答用），table 是同样内容一店一行（页面画表）。
export function findOutliers(groups: readonly PeerGroup[], spec: OutlierSpec, examples = 3): string[] {
  return outlierTable(groups, spec, examples)?.text ?? [];
}
export function outlierTable(groups: readonly PeerGroup[], spec: OutlierSpec, examples = 3): InsightOutliers | null {
  const { metric } = spec;
  const hits = groups.flatMap((g) => {
    const valid = g.stores.filter((s) => ok(metric.of(s), metric)); if (valid.length < MIN_GROUP) return [];
    const t = (s: PeerStore) => metric.kind === "log" ? Math.log(metric.of(s)) : metric.of(s);
    const m = median(valid.map(t))!; const mad = 1.4826 * median(valid.map((s) => Math.abs(t(s) - m)))!;
    if (!(mad > 0)) return [];
    const med = median(valid.map(metric.of))!;
    return valid.flatMap((s) => { const z = (t(s) - m) / mad; return Math.abs(z) > OUTLIER_Z ? [{ s, g, n: valid.length, z, med, cause: spec.incomplete?.(s) ? { label: "营业天数", incomplete: true } : spec.explain(s, valid, z > 0) }] : []; });
  });
  if (!hits.length) return null;
  const high = hits.filter((h) => h.z > 0).length;
  const incomplete = hits.filter((h) => h.cause.incomplete);
  const real = hits.filter((h) => !h.cause.incomplete).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  const kinds = new Map<string, number>(); for (const h of real) { const k = h.cause.label.split("：")[0]; kinds.set(k, (kinds.get(k) ?? 0) + 1); }
  const vs = (h: typeof hits[number]) => metric.kind === "log"
    ? `${metric.fmt(metric.of(h.s))}，${metric.of(h.s) >= h.med ? `是同类一般水平的 ${n1(metric.of(h.s) / h.med)} 倍` : `只有同类一般水平的 ${n1(metric.of(h.s) / h.med * 100)}%`}`
    : `${metric.fmt(metric.of(h.s))}，比同类一般水平 ${metric.fmt(h.med)} ${metric.of(h.s) >= h.med ? "高" : "低"} ${n1(Math.abs(metric.of(h.s) - h.med))} 个百分点`;
  const lines = [`同类店里${metric.label}和一般水平差得特别多的有 ${n0(hits.length)} 家：偏高 ${n0(high)} 家、偏低 ${n0(hits.length - high)} 家。${kinds.size ? `拆开看，${[...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n0(n)} 家`).join("，")}。` : ""}`];
  for (const h of real.slice(0, examples)) lines.push(`${storeName(h.s)}（${h.g.label}，同类 ${n0(h.n)} 家）${metric.label} ${vs(h)}；主要是${h.cause.label}。`);
  const foot = incomplete.length ? `另有 ${n0(incomplete.length)} 家主要是营业天数少（比如 ${storeName(incomplete[0].s)} 只有 ${n0(incomplete[0].s.days)} 天有成交），属于数据不完整，先从对比里排除。` : undefined;
  if (foot) lines.push(foot);
  // 表：店名（简称）、这家店的值、同类一般水平、主要原因。分组、店号、同类店数不进表，原因只留冒号后面的值。
  // 原因前面跟一句和同类比：「是同类的 0.1 倍」或「高 23.5 个点」。
  const ratio = (h: typeof hits[number]) => metric.kind === "log" ? `是同类的 ${n1(metric.of(h.s) / h.med)} 倍 ·` : `${metric.of(h.s) >= h.med ? "高" : "低"} ${n1(Math.abs(metric.of(h.s) - h.med))} 个点 ·`;
  const rows = real.slice(0, examples).map((h) => [shortStoreName(h.s.name || h.s.id), metric.fmt(metric.of(h.s)), metric.fmt(h.med), h.cause.label, ratio(h)]);
  const summary = `同类店里${metric.label}和一般水平差得特别多的有 ${n0(hits.length)} 家（偏高 ${n0(high)} 家、偏低 ${n0(hits.length - high)} 家）${kinds.size ? `，原因主要是${[...kinds].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${k}（${n0(n)} 家）`).join("、")}` : ""}。差得最多的几家：`;
  return { metric: metric.label, summary, head: ["门店", metric.label, "同类一般水平", "主要原因"], rows, ...(foot ? { foot } : {}), text: lines };
}
