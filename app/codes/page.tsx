import { Badge } from "@/components/ui/badge";
import { CODEBOOK, type Entry, type Origin } from "../lib/campaign/ics1811/codebook";
import { OFFER_TYPES } from "../lib/campaign/ics1811/offer-spec";

type Row = { key: string; display: string; origin: Origin; note: string };
type Table = { name: string; rows: Row[] };

const ORIGIN_STYLE: Record<Origin, string> = {
  截图: "border-[#bfd8fa] bg-[#eaf4ff] text-[#2470cc]",
  指引文字: "border-[#c9d9f5] bg-[#eef3ff] text-[#536fa8]",
  导入模板: "border-[#bfe7d8] bg-[#e8f7f1] text-[#26785e]",
  编造: "border-[#f1cbc5] bg-[#fff4f2] text-[#b2443b]",
};

const SUPPORT_TEXT = { A: "有录入截图", B: "参数栏是推断的", C: "提示人工录入", D: "SOP 明确不支持" } as const;

const rows = (entries: readonly Entry[], note: (entry: Entry) => string = (entry) => entry.evidence ?? ""): Row[] =>
  entries.map((entry) => ({ key: entry.code, display: entry.display, origin: entry.origin, note: note(entry) }));

const TABLES: Table[] = [
  { name: "区域", rows: rows(CODEBOOK.regions) },
  {
    name: "门店（分行）",
    rows: CODEBOOK.stores.map((store) => ({
      key: store.code,
      display: store.display,
      origin: store.origin,
      note: `区域 ${store.region}${store.division ? ` · ${store.division}` : ""}${store.city ? ` · ${store.city}` : ""} · 简称「${store.shortName}」；${store.evidence ?? ""}`,
    })),
  },
  {
    name: "货类",
    rows: CODEBOOK.categories.map((category) => ({
      key: category.code,
      display: category.display,
      origin: category.origin,
      note: `号头 ${category.headCodes.join("、") || "—"} · 业务大类 ${category.businessCategory || "—"}；${category.evidence ?? ""}`,
    })),
  },
  {
    name: "明细优惠类型",
    rows: Object.values(OFFER_TYPES).map((spec) => ({
      key: spec.name,
      display: spec.pageLabel,
      // 类型名称都来自 §9(五) 的下拉截图；参数栏是否有截图依据看支持级别
      origin: "截图",
      note: `${SUPPORT_TEXT[spec.support]} · 参数：${spec.params.map((param) => param.label).join("、") || "—"} · 活动分组 ${spec.group}；${spec.sop}`,
    })),
  },
  { name: "品牌", rows: rows(CODEBOOK.brands, (entry) => `审批流 ${(entry as Entry & { approvalFlow?: string }).approvalFlow ?? ""}；${entry.evidence ?? ""}`) },
  { name: "审批流", rows: rows(CODEBOOK.approvalFlows) },
  { name: "活动分组", rows: rows(CODEBOOK.activityGroups) },
  { name: "线上 / 线下", rows: rows(CODEBOOK.channels) },
  { name: "活动级优惠类型", rows: rows(CODEBOOK.offerNatures) },
  { name: "货品范围", rows: rows(CODEBOOK.productScopes) },
  { name: "转换餐牌", rows: rows(CODEBOOK.menuConversions) },
  { name: "会员级别", rows: rows(CODEBOOK.memberLevels) },
  { name: "售价类型", rows: rows(CODEBOOK.priceTypes) },
  { name: "分区", rows: rows(CODEBOOK.divisions) },
  { name: "小区", rows: rows(CODEBOOK.subAreas) },
  { name: "城市", rows: rows(CODEBOOK.cities) },
];

const ORIGINS: Origin[] = ["截图", "指引文字", "导入模板", "编造"];

function OriginBadge({ origin }: { origin: Origin }) {
  return (
    <Badge variant="outline" className={ORIGIN_STYLE[origin]}>
      {origin}
    </Badge>
  );
}

export default function CodesPage() {
  const all = TABLES.flatMap((table) => table.rows);
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-8 md:px-8 md:py-10">
      <header className="rounded-3xl border border-[#d6e6f7] bg-white/70 p-5 shadow-[0_14px_40px_rgba(43,94,151,0.07)] backdrop-blur md:p-7">
        <p className="text-[12px] font-semibold tracking-[0.12em] text-[#2470cc]">规则资料</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-[#20314d] md:text-3xl">ICS 演示代码表</h1>
        <p className="mt-3 text-[15px] leading-7 text-[#4f6681]">
          Agent 生成 1811 填写值时只用这里的取值（{CODEBOOK.version}）。取值优先来自 SOP 第九部分和截图；SOP 没给的对应关系是演示编造的，录入时以 ICS 系统为准。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px] text-[#6f849d]">
          {ORIGINS.map((origin) => (
            <span key={origin} className="inline-flex items-center gap-1.5">
              <OriginBadge origin={origin} />
              {all.filter((row) => row.origin === origin).length} 个
            </span>
          ))}
        </div>
      </header>

      <div className="mt-8 space-y-5">
        {TABLES.map((table) => (
          <section key={table.name} className="rounded-2xl border border-[#d6e6f7] bg-white/78 p-4 shadow-[0_8px_26px_rgba(43,94,151,0.05)] backdrop-blur md:p-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 className="text-lg font-semibold text-[#20314d]">{table.name}</h2>
              <span className="text-[13px] text-[#71869f]">
                {table.rows.length} 个取值{table.rows.some((row) => row.origin === "编造") ? ` · ${table.rows.filter((row) => row.origin === "编造").length} 个编造` : ""}
              </span>
            </div>
            <div className="mt-3 overflow-x-auto rounded-xl border border-[#d9e7f6] bg-white">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[#d9e7f6] bg-[#f1f7ff] text-[13px] text-[#637a95]">
                    <th className="px-3 py-2 font-medium">页面上显示</th>
                    <th className="px-3 py-2 font-medium">来源</th>
                    <th className="px-3 py-2 font-medium">说明与出处</th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row) => (
                    <tr key={row.key} className="border-b border-[#e5eef8] transition-colors last:border-b-0 hover:bg-[#f8fbff]">
                      <td className="px-3 py-2.5 align-top font-medium whitespace-nowrap text-[#293b54]">{row.display}</td>
                      <td className="px-3 py-2.5 align-top">
                        <OriginBadge origin={row.origin} />
                      </td>
                      <td className="px-3 py-2.5 align-top text-[13px] leading-6 text-[#566d88]">{row.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
