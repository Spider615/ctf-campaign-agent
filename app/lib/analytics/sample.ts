import { importDataset } from "./import.ts";
import type { ImportDatasetInput } from "./types.ts";

// 演示数据完全虚构，走与用户导入相同的解析和计算路径。
export function sampleImport(): ImportDatasetInput {
  const lines = ["明细ID,日期,门店,货类,净销售额,件数,成本,会员分组,活动编号,区域,城市,商品编号,订单编号,会员编号,克重"];
  for (const year of [2025, 2026]) for (const month of [8, 9]) for (let day = 1; day <= 7; day++) {
    for (let store = 1; store <= 4; store++) for (const category of ["黄金", "镶嵌"]) for (const segment of ["新会员", "老会员"]) {
      const id = `${year}-${month}-${day}-${store}-${category}-${segment}`;
      const base = category === "黄金" ? 1500 : 2300;
      const factor = year === 2026 ? (segment === "新会员" ? 1.25 : 0.9) * (store <= 2 ? 1.1 : 0.95) : 1;
      const sales = Math.round(base * factor + day * 17);
      lines.push([id, `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, `示例门店${store}`, category, sales, 1, Math.round(sales * (category === "黄金" ? 0.8 : 0.55)), segment, `DEMO-${year}-${category}`, store <= 2 ? "示例华南" : "示例华东", store <= 2 ? "示例深圳" : "示例上海", `DEMO-${category}`, `ORDER-${id}`, `MEM-${id}`, category === "黄金" ? 3.5 : 0.8].join(","));
    }
  }
  return {
    name: "七夕销售复盘示例（全部数据虚构）", provenance: "sample", currency: "CNY",
    sales: { content: lines.join("\n"), format: "csv", fileName: "虚构销售明细.csv" },
    campaigns: { content: "活动编号,活动名称,优惠机制,优惠力度\nDEMO-2025-黄金,示例黄金活动2025,克减,40\nDEMO-2026-黄金,示例黄金活动2026,克减,50\nDEMO-2025-镶嵌,示例镶嵌活动2025,折扣,0.9\nDEMO-2026-镶嵌,示例镶嵌活动2026,折扣,0.85", format: "csv", fileName: "虚构活动规则.csv" },
  };
}
export function sampleDataset() { return { ...importDataset(sampleImport()), id: "sample", version: "sample/v1", createdAt: "2026-10-10" }; }
