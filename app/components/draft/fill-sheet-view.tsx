"use client";

import { Quote } from "lucide-react";

import { fillSheetText, type FillSheet, type SelfCheckItem, type SheetRow } from "../../lib/campaign/ics1811/fill-sheet";
import type { ChatMessage } from "../../lib/campaign/ics1811/messages";
import { findQuoteSource } from "../../lib/campaign/ics1811/quote-source";
import { CopyButton } from "../chat/copy-button";
import { SourceBadge } from "../source-badge";

type SourceJump = { messages: readonly ChatMessage[]; onShowSource: (messageId: string) => void };

function Heading({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-[12px] font-semibold tracking-[0.08em] text-[#2470cc]">{children}</p>;
}

// highlighted：这一轮刚填上的字段。活动是一步步搭起来的，但面板只显示最终态，
// 看不出某一格是刚填的还是一直都在——标出来，过程才看得见。
function Rows({ rows, highlighted, freshFacts, jump }: { rows: SheetRow[]; highlighted?: ReadonlySet<string>; freshFacts?: ReadonlySet<string>; jump?: SourceJump }) {
  return (
    <div className="divide-y divide-[#e5eef8] overflow-hidden rounded-xl border border-[#d7e6f5] bg-white">
      {rows.map((row, index) => {
        // 活动信息行按页面字段标，明细行按驱动它的事实标。
        const fresh = Boolean((row.field && highlighted?.has(row.field)) || (row.factKey && freshFacts?.has(row.factKey)));
        return (
          <div
            key={`${row.label}-${index}`}
            className={`px-3 py-2.5 transition-colors ${fresh ? "bg-[#e9f4ff]" : row.source === "pending" ? "bg-[#fff8eb]" : ""}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[12px] text-[#71869f]">
                  {row.label}
                  <span className="text-[#9aadc1]"> · {row.control}</span>
                  {fresh ? <span className="ml-1.5 rounded-full bg-[#247cff] px-1.5 py-0.5 text-[10px] text-white">刚填</span> : null}
                </p>
                <p className={`mt-0.5 break-words text-[13px] ${row.source === "pending" ? "text-[#b36b16]" : "text-[#293b54]"}`}>{row.value}</p>
                {row.note ? <p className="mt-0.5 text-[11px] leading-4 text-[#8ca0b7]">{row.note}</p> : null}
                {(() => {
                  // 只有用户自己说出来的值才谈得上「出处」；代码推导和页面默认没有原话可跳。
                  if (row.source !== "user" || !row.basis || !jump) return null;
                  const messageId = findQuoteSource(jump.messages, row.basis);
                  if (!messageId) return null;
                  return (
                    <button
                      type="button"
                      onClick={() => jump.onShowSource(messageId)}
                      className="mt-1 inline-flex min-h-11 max-w-full items-center gap-1 rounded-md px-1 text-left text-[11px] leading-4 text-[#2470cc] underline-offset-4 hover:bg-[#edf5ff] hover:underline md:min-h-8"
                    >
                      <Quote className="size-3 shrink-0" />
                      <span className="truncate">你说的：{row.basis}</span>
                    </button>
                  );
                })()}
              </div>
              <SourceBadge source={row.source} tbc={Boolean(row.note?.includes("待确认"))} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const STATUS_CLASS: Record<SelfCheckItem["status"], string> = {
  通过: "text-[#168660]",
  不通过: "text-[#b2443b]",
  需注意: "text-[#b36b16]",
  需人工: "text-[#5f7690]",
  不适用: "text-[#91a4ba]",
};

// ready 只表示 1811 所需信息和校验已就绪，不代表整体活动已审批或可上线。
export function FillSheetView({ sheet, ready, highlighted, freshFacts, jump }: { sheet: FillSheet; ready: boolean; highlighted?: ReadonlySet<string>; freshFacts?: ReadonlySet<string>; jump?: SourceJump }) {
  return (
    <div className="space-y-5">
      <div className={`flex items-start justify-between gap-2 rounded-xl border p-3 text-[13px] leading-5 ${ready ? "border-[#bfe7d8] bg-[#e8f7f1] text-[#26785e]" : "border-[#f0d7b1] bg-[#fff8eb] text-[#9a5d16]"}`}>
        <span>{ready ? "1811 填写值已准备，可照此录入；是否可上线请以上线检查为准。" : "1811 草稿：信息补齐后自动生成最终填写值。"}{sheet.banner}。</span>
        <CopyButton text={fillSheetText(sheet)} />
      </div>

      <section>
        <Heading>一、活动信息（按页面从上到下）</Heading>
        <Rows rows={sheet.info} highlighted={highlighted} freshFacts={freshFacts} jump={jump} />
        <p className="mt-2 text-[12px] text-[#607690]">{sheet.afterAdd.join("；")}</p>
      </section>

      {sheet.settlement ? (
        <section>
          <Heading>二、结算说明函</Heading>
          <ul className="space-y-1 rounded-xl border border-[#d7e6f5] bg-white p-3 text-[13px] text-[#293b54]">
            {sheet.settlement.fileNames.map((name) => <li key={name} className="font-mono">{name}</li>)}
          </ul>
          <p className="mt-2 text-[12px] leading-5 text-[#607690]">{sheet.settlement.steps.join("；")}</p>
        </section>
      ) : null}

      {sheet.details.map((detail) => (
        <section key={detail.index}>
          <Heading>明细 {detail.index}</Heading>
          <Rows rows={detail.rows} freshFacts={freshFacts} jump={jump} />
          <p className="mt-2 text-[12px] text-[#607690]">{detail.restNote}，{detail.action}</p>
        </section>
      ))}

      <section>
        <Heading>完成新增</Heading>
        <ol className="list-inside list-decimal space-y-1 text-[13px] text-[#293b54]">{sheet.finish.map((step) => <li key={step}>{step}</li>)}</ol>
      </section>

      <section>
        <Heading>建完后待办</Heading>
        <ul className="space-y-1.5 text-[13px] leading-5 text-[#293b54]">
          {sheet.postActions.map((action) => (
            <li key={action.id} className="rounded-lg bg-[#eef6ff] px-3 py-2">{action.text}<span className="ml-1 text-[11px] text-[#8ca0b7]">（{action.sop}）</span></li>
          ))}
        </ul>
      </section>

      <section>
        <Heading>自查清单</Heading>
        <ul className="divide-y divide-[#e5eef8] rounded-xl border border-[#d7e6f5] bg-white text-[13px]">
          {sheet.selfCheck.map((item) => (
            <li key={item.item} className="flex items-center justify-between px-3 py-2">
              <span className="text-[#293b54]">{item.item}</span>
              <span className={`text-[12px] font-medium ${STATUS_CLASS[item.status]}`}>{item.status}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
