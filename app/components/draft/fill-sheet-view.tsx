"use client";

import { fillSheetText, type FillSheet, type SelfCheckItem, type SheetRow } from "../../lib/campaign/ics1811/fill-sheet";
import { CopyButton } from "../chat/copy-button";
import { SourceBadge } from "../source-badge";

function Heading({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-[12px] font-semibold tracking-[0.08em] text-[#8b6b3b]">{children}</p>;
}

function Rows({ rows }: { rows: SheetRow[] }) {
  return (
    <div className="divide-y divide-[#efe7de] rounded-xl border border-[#e7ddd2] bg-white">
      {rows.map((row, index) => (
        <div key={`${row.label}-${index}`} className={`px-3 py-2 ${row.source === "pending" ? "bg-[#fff8ec]" : ""}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[12px] text-[#8a7d80]">{row.label}<span className="text-[#b3a8aa]"> · {row.control}</span></p>
              <p className={`mt-0.5 break-words text-[13px] ${row.source === "pending" ? "text-[#a15a24]" : "text-[#35262a]"}`}>{row.value}</p>
              {row.note ? <p className="mt-0.5 text-[11px] leading-4 text-[#9a8d8f]">{row.note}</p> : null}
            </div>
            <SourceBadge source={row.source} tbc={Boolean(row.note?.includes("待确认"))} />
          </div>
        </div>
      ))}
    </div>
  );
}

const STATUS_CLASS: Record<SelfCheckItem["status"], string> = {
  通过: "text-[#47704f]",
  不通过: "text-[#a33a25]",
  需注意: "text-[#9c642b]",
  需人工: "text-[#6d5d5f]",
  不适用: "text-[#a1969a]",
};

export function FillSheetView({ sheet, confirmed }: { sheet: FillSheet; confirmed: boolean }) {
  return (
    <div className="space-y-5">
      <div className={`flex items-start justify-between gap-2 rounded-xl p-3 text-[13px] leading-5 ${confirmed ? "bg-[#eaf3ec] text-[#47704f]" : "bg-[#fcf5ec] text-[#8b5d25]"}`}>
        <span>{confirmed ? "已确认，照此在 ICS-1811 录入。" : "草稿，确认复述后才是最终填写值。"}{sheet.banner}。</span>
        <CopyButton text={fillSheetText(sheet)} />
      </div>

      <section>
        <Heading>一、活动信息（按页面从上到下）</Heading>
        <Rows rows={sheet.info} />
        <p className="mt-2 text-[12px] text-[#6d5d5f]">{sheet.afterAdd.join("；")}</p>
      </section>

      {sheet.settlement ? (
        <section>
          <Heading>二、结算说明函</Heading>
          <ul className="space-y-1 rounded-xl border border-[#e7ddd2] bg-white p-3 text-[13px] text-[#35262a]">
            {sheet.settlement.fileNames.map((name) => <li key={name} className="font-mono">{name}</li>)}
          </ul>
          <p className="mt-2 text-[12px] leading-5 text-[#6d5d5f]">{sheet.settlement.steps.join("；")}</p>
        </section>
      ) : null}

      {sheet.details.map((detail) => (
        <section key={detail.index}>
          <Heading>明细 {detail.index}</Heading>
          <Rows rows={detail.rows} />
          <p className="mt-2 text-[12px] text-[#6d5d5f]">{detail.restNote}，{detail.action}</p>
        </section>
      ))}

      <section>
        <Heading>完成新增</Heading>
        <ol className="list-inside list-decimal space-y-1 text-[13px] text-[#35262a]">{sheet.finish.map((step) => <li key={step}>{step}</li>)}</ol>
      </section>

      <section>
        <Heading>建完后待办</Heading>
        <ul className="space-y-1.5 text-[13px] leading-5 text-[#35262a]">
          {sheet.postActions.map((action) => (
            <li key={action.id} className="rounded-lg bg-[#f7f2eb] px-3 py-2">{action.text}<span className="ml-1 text-[11px] text-[#9a8d8f]">（{action.sop}）</span></li>
          ))}
        </ul>
      </section>

      <section>
        <Heading>自查清单</Heading>
        <ul className="divide-y divide-[#efe7de] rounded-xl border border-[#e7ddd2] bg-white text-[13px]">
          {sheet.selfCheck.map((item) => (
            <li key={item.item} className="flex items-center justify-between px-3 py-2">
              <span className="text-[#35262a]">{item.item}</span>
              <span className={`text-[12px] font-medium ${STATUS_CLASS[item.status]}`}>{item.status}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
