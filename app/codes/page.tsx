import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import {
  SOURCE_NOTE,
  UNUSABLE_CODE_TABLES,
  USABLE_CODE_TABLES,
  type CodeValue,
  type UsableCodeTable,
} from "../lib/reference/code-tables";

const UNKNOWN_YEAR = "年份未知（PPT 更新于 2024/04/22，截图跨 2019–2025）";

function EvidenceYear({ value }: { value: CodeValue }) {
  if (value.year === null) {
    return <span className="text-[13px] leading-5 text-[#817578]">{UNKNOWN_YEAR}</span>;
  }
  return (
    <div>
      <span className="font-medium text-[#2c1720]">{value.year}</span>
      <p className="mt-0.5 text-[12px] leading-5 text-[#817578]">{value.yearBasis}</p>
    </div>
  );
}

function UsableTableCard({ table }: { table: UsableCodeTable }) {
  const datedCount = table.values.filter((value) => value.year !== null).length;
  const complete = table.completeness === "complete";

  return (
    <section className="rounded-2xl border border-[#ded5cb] bg-[#fffdfa] p-4 md:p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-lg font-semibold text-[#2c1720]">{table.name}</h3>
        <Badge
          variant="outline"
          className={complete ? "border-[#d9c7a6] bg-[#f6efe2] text-[#8b6b3b]" : "border-[#ded5cb] bg-[#f4efe9] text-[#817578]"}
        >
          {complete ? "列表已见底" : "只见到部分取值"}
        </Badge>
        <span className="text-[13px] text-[#817578]">
          {table.values.length} 个取值 · {datedCount} 个有年份
        </span>
      </div>
      <p className="mt-2 text-sm leading-6 text-[#2f2226]">{table.note}</p>

      <div className="mt-4 overflow-x-auto rounded-xl border border-[#ded5cb] bg-white">
        <Table>
          <TableHeader>
            <TableRow className="bg-[#f6f1ea] hover:bg-[#f6f1ea]">
              <TableHead className="px-3 text-[#817578]">取值</TableHead>
              <TableHead className="px-3 text-[#817578]">原文</TableHead>
              <TableHead className="px-3 text-[#817578]">页码 · 截图</TableHead>
              <TableHead className="px-3 text-[#817578]">证据年份</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {table.values.map((value) => (
              <TableRow key={value.raw} className="border-[#ece5dc] hover:bg-[#fbf8f3]">
                <TableCell className="px-3 py-2.5 align-top font-medium text-[#2c1720]">{value.label}</TableCell>
                <TableCell className="px-3 py-2.5 align-top text-[#2f2226]">{value.raw}</TableCell>
                <TableCell className="px-3 py-2.5 align-top text-[#817578]">
                  第 {value.slide} 页 · {value.image}
                </TableCell>
                <TableCell className="min-w-56 px-3 py-2.5 align-top whitespace-normal">
                  <EvidenceYear value={value} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

export default function CodesPage() {
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 md:px-8">
      <header>
        <p className="text-[12px] font-medium tracking-[0.12em] text-[#8b6b3b]">资料</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-[#2c1720] md:text-3xl">码表与证据</h1>
        <p className="mt-3 text-[15px] leading-7 text-[#2f2226]">
          这些取值来自操作指引里的截图。Agent 只用这里有证据的取值，其余字段由运营在 ICS 界面上选。
        </p>
        <p className="mt-2 text-[13px] leading-6 text-[#817578]">{SOURCE_NOTE}</p>
      </header>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-[#2c1720]">可用码表</h2>
        <div className="mt-4 space-y-5">
          {USABLE_CODE_TABLES.map((table) => (
            <UsableTableCard key={table.key} table={table} />
          ))}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold text-[#2c1720]">不可用码表</h2>
        <p className="mt-1 text-sm leading-6 text-[#817578]">这些字段在资料里看不全或对不上，Agent 不给具体值，只写业务意图。</p>
        <div className="mt-4 overflow-hidden rounded-2xl border border-[#ded5cb] bg-[#fffdfa]">
          <div className="hidden grid-cols-[190px_minmax(0,1fr)_minmax(0,1fr)] gap-5 border-b border-[#ded5cb] bg-[#f6f1ea] px-5 py-2.5 text-[13px] font-medium text-[#817578] md:grid">
            <span>名称</span>
            <span>为什么不可用</span>
            <span>产品怎么处理</span>
          </div>
          <ul>
            {UNUSABLE_CODE_TABLES.map((table) => (
              <li
                key={table.name}
                className="grid gap-2 border-b border-[#ece5dc] px-4 py-4 last:border-b-0 md:grid-cols-[190px_minmax(0,1fr)_minmax(0,1fr)] md:gap-5 md:px-5"
              >
                <p className="font-medium text-[#2c1720]">{table.name}</p>
                <div>
                  <p className="text-[12px] text-[#8b6b3b] md:hidden">为什么不可用</p>
                  <p className="text-sm leading-6 text-[#2f2226]">{table.reason}</p>
                </div>
                <div>
                  <p className="text-[12px] text-[#8b6b3b] md:hidden">产品怎么处理</p>
                  <p className="text-sm leading-6 text-[#2f2226]">{table.handling}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
