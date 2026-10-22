// 洞察图谱测试用的合成数据：形状和 Agent 查回来的一样，数值让各条关系有确定的强弱。
// 120 家店 × 31 天；形象级别决定门店规模，金色星期二在周二、克减从 8/22 起全国铺开，七夕在 8/29。
import { buildDriverGraph } from "../../app/lib/insight/drivers.ts";
import { toDriverData } from "../../agent/insight-graph.ts";

const IMAGES = ["重奢场", "时尚购物场/核心珠宝商业街区", "社区生活场/非核心珠宝商业街区"];
const days = Array.from({ length: 31 }, (_, i) => `202508${String(i + 1).padStart(2, "0")}`);
const dowOf = (d: string) => new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T00:00:00Z`).getUTCDay();
// 确定性的伪随机，免得测试结果飘。
const noise = (seed: number) => { const x = Math.sin(seed * 9301 + 49297) * 233280; return x - Math.floor(x) - 0.5; };

export function fakeResults() {
  // 区域和铺型跟着店号奇偶走：形象 × 铺型 × 区域正好 6 组，每组 20 家，够做同类店对比。
  const stores = Array.from({ length: 120 }, (_, i) => ({ store: `S${i}`, big_region: ["北区", "南区"][i % 2], region: ["京津", "华南"][i % 2], city_tier: ["一线城市", "二线城市"][(i >> 1) % 2],
    image: IMAGES[i % 3], shop_type: ["购物中心", "百货"][i % 2], nature: ["自营", "加盟(寄售)"][(i >> 1) % 2], area: ["60-100平方米", "100-149平方米"][(i >> 2) % 2], experience: i % 7 === 0 ? "周大福荟馆" : "周大福主流店（旧）", age: String(i % 12), name: `测试店${i}` }));
  const panel = []; const daily = []; const gold = [];
  for (const d of days) {
    const dow = dowOf(d); const qixi = d === "20250829"; const promo = d >= "20250822"; const tue = dow === 2;
    let daySales = 0; let dayOrders = 0; let dayGold = 0;
    for (const [i, s] of stores.entries()) {
      const scale = [5, 2, 1][i % 3] * (qixi ? 6 : tue ? 2.5 : promo ? 1.8 : 1) * (1 + 0.3 * noise(i * 100 + Number(d)));
      const orders = Math.max(1, Math.round(20 * scale)); const sales = orders * (9000 + 3000 * (i % 3 === 0 ? 1 : 0));
      const goldShare = 0.45 + 0.45 * ((i * 7) % 10) / 9 + (promo || tue ? 0.05 : 0) + 0.02 * noise(i + Number(d));
      const revEx = sales / 1.13; const gp = revEx * (0.4 - 0.25 * goldShare);
      const k50 = promo && i % 2 === 1; const gt = tue;
      const goldAmt = sales * goldShare; const goldQty = Math.round(orders * 1.1); const gramsPerItem = 7 + (k50 ? 6 : 0) + (gt ? 4 : 0) + noise(i * 7 + Number(d));
      panel.push({ store: s.store, d, sales: String(sales), gp: String(gp), rev_ex: String(revEx), items: String(Math.round(orders * 1.3)), orders: String(orders), gold: String(goldAmt),
        base_gold: String(goldAmt * (promo ? 0.3 : 0.85) * (1 + 0.1 * noise(i + 3 * Number(d)))), heavy_gold: String(goldAmt * (0.3 + (k50 ? 0.3 : 0) + 0.05 * noise(i + 5 * Number(d)))),
        gold_grams: String(goldQty * gramsPerItem), gold_qty: String(goldQty),
        k50: promo && i % 2 ? "1" : "0", k30: promo ? "1" : "0", gt: tue ? "1" : "0" });
      daySales += sales; dayOrders += orders; dayGold += sales * goldShare;
    }
    const promoGold = promo ? dayGold * 0.7 : dayGold * 0.1; const baseGold = promo ? dayGold * 0.25 : dayGold * 0.8;
    daily.push({ d, dow: String(dow), festival: d >= "20250823" && d <= "20250829" ? "七夕节" : null, sales: String(daySales), orders: String(dayOrders), gold: String(dayGold), base_gold: String(baseGold), promo_gold: String(promoGold) });
    gold.push({ d, g: "base", amount: String(1000 * 1000), grams: "1000", qty: "120", ge20: String(1000 * 300) });
    if (promo) gold.push({ d, g: "k30", amount: String(976 * 800), grams: "800", qty: "120", ge20: String(976 * 150) }, { d, g: "k50", amount: String(946 * 900), grams: "900", qty: "66", ge20: String(946 * 540) });
    if (tue) gold.push({ d, g: "gt", amount: String(997 * 700), grams: "700", qty: "56", ge20: String(997 * 360) });
  }
  return {
    scope: [{ first_day: "20250801", last_day: "20250831", n: "1287840", member_share: "97.7" }],
    panel, stores, daily, gold,
    ptype: [{ ptype: "计价金", sales: "6400", gp: "1100", rev_ex: "5660", items: "700", grams: "6100" }, { ptype: "一口价黄金", sales: "1000", gp: "330", rev_ex: "885", items: "240", grams: "640" }, { ptype: "镶嵌及其他", sales: "1300", gp: "490", rev_ex: "1150", items: "200", grams: "580" }],
    threshold: Array.from({ length: 10 }, (_, i) => ({ gram: String(15 + i), k50: String(15 + i >= 20 ? 1400 - i * 20 : 1000 + i * 10), base: String(1200 - i * 20) })),
    tradein: [{ g: "base", orders: "400", trade_in: "45", sales: "3600", recycle: "400" }, { g: "gt", orders: "100", trade_in: "99", sales: "950", recycle: "550" }, { g: "k30", orders: "200", trade_in: "1", sales: "1700", recycle: "1" }, { g: "k50", orders: "60", trade_in: "0", sales: "1100", recycle: "0" }],
  };
}

export const fakeGraph = () => buildDriverGraph(toDriverData(fakeResults(), "v-test"), "2026-10-20T00:00:00.000Z");
