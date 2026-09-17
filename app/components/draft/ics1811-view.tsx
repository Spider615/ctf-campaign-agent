"use client";

import { CheckCircle2, CircleAlert, CircleDashed, CircleMinus, Quote, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

import { fillSheetText, type SelfCheckItem, type SheetRow } from "../../lib/campaign/ics1811/fill-sheet";
import { findQuoteSource } from "../../lib/campaign/ics1811/quote-source";
import type { Source } from "../../lib/campaign/ics1811/types";
import type { Snapshot } from "../../lib/server/turns";
import { CopyButton } from "../chat/copy-button";

const SOURCE_LABEL: Record<Source, string> = { user: "你说的", ai: "AI 定", default: "页面默认", pending: "待补" };
const SOURCE_TONE: Record<Source, string> = {
  user: "border-[#d9d2ca] bg-[#faf8f5] text-[#665a56]",
  ai: "border-[#d8c7cd] bg-[#fff6f8] text-[#86435a]",
  default: "border-[#d4ddce] bg-[#f4f8f1] text-[#557059]",
  pending: "border-[#e3cfaa] bg-[#fff9eb] text-[#8a642c]",
};

const CHECK_TONE: Record<SelfCheckItem["status"], string> = {
  通过: "text-[#4f7b57]",
  不通过: "text-[#a14b3f]",
  需注意: "text-[#926626]",
  需人工: "text-[#8f4058]",
  不适用: "text-[#9a918c]",
};

type Ics1811ViewProps = {
  snapshot: Snapshot;
  onShowSource?: (messageId: string) => void;
};

function SheetRows({ rows, snapshot, onShowSource }: { rows: SheetRow[]; snapshot: Snapshot; onShowSource?: (messageId: string) => void }) {
  return (
    <div className="divide-y divide-[#eee5de] border-y border-[#e8ddd5] bg-white/65">
      {rows.map((row, index) => {
        const messageId = row.source === "user" && row.basis ? findQuoteSource(snapshot.messages, row.basis) : null;
        return (
          <div key={`${row.label}-${index}`} className={`grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-1 py-3 ${row.source === "pending" ? "bg-[#fffaf0]" : ""}`}>
            <div className="min-w-0">
              <p className="text-[10px] tracking-[0.04em] text-[#8f7f7a]">{row.label}<span className="ml-1 text-[#b0a29d]">· {row.control}</span></p>
              <p className={`mt-1 break-words text-[12px] leading-5 ${row.source === "pending" ? "text-[#976a2c]" : "text-[#3f3235]"}`}>{row.value}</p>
              {row.note ? <p className="mt-1 text-[10px] leading-4 text-[#9a8984]">{row.note}</p> : null}
              {messageId && onShowSource ? (
                <button type="button" onClick={() => onShowSource(messageId)} className="mt-1.5 inline-flex min-h-8 max-w-full items-center gap-1 text-left text-[10px] text-[#8f4058] underline-offset-4 hover:underline">
                  <Quote className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">回看原话：{row.basis}</span>
                </button>
              ) : null}
            </div>
            <span className={`mt-0.5 h-fit shrink-0 border px-1.5 py-0.5 text-[9px] ${SOURCE_TONE[row.source]}`}>{SOURCE_LABEL[row.source]}</span>
          </div>
        );
      })}
    </div>
  );
}

function SectionTitle({ index, children }: { index: string; children: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="font-serif text-sm text-[#9b7040]">{index}</span>
      <h4 className="text-[11px] font-semibold tracking-[0.12em] text-[#634e52]">{children}</h4>
      <span className="h-px flex-1 bg-[#e5d9cf]" aria-hidden="true" />
    </div>
  );
}

export function Ics1811View({ snapshot, onShowSource }: Ics1811ViewProps) {
  const { draft, sheet } = snapshot.latest;
  const artifact = snapshot.workspace.artifacts.ics1811;

  if (!draft || artifact.status === "not_applicable") {
    return (
      <div className="border border-[#e6ddd6] bg-[#fffdf9] px-6 py-10 text-center text-[#34292b] shadow-[0_18px_44px_rgba(74,36,37,0.05)]">
        <div className="mx-auto grid size-12 place-items-center rounded-full border border-[#ddd2c9] text-[#93857f]">
          <CircleMinus className="size-5" aria-hidden="true" />
        </div>
        <p className="mt-5 text-[10px] font-semibold tracking-[0.22em] text-[#9a7650]">ICS-1811</p>
        <h3 className="mt-2 font-serif text-[22px] text-[#431e28]">本活动不需要优惠配置</h3>
        <p className="mx-auto mt-3 max-w-[300px] text-[12px] leading-6 text-[#786a6c]">当前活动没有成交优惠执行轨，因此不会创建 1811 子草稿。后续如果明确加入优惠玩法，Agent 会再开启这条流程。</p>
      </div>
    );
  }

  const ready = artifact.status === "sheet_ready";
  const filledCount = Object.values(draft.facts).filter(Boolean).length;
  const blockerCount = artifact.blockerCount;

  return (
    <div className="space-y-5 text-[#34292b]">
      <section className={`border px-4 py-4 ${ready ? "border-[#cbdcc8] bg-[#f6faf4]" : blockerCount ? "border-[#e5c5bc] bg-[#fff8f5]" : "border-[#e5d4b3] bg-[#fffaf0]"}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className={`grid size-9 shrink-0 place-items-center rounded-full border ${ready ? "border-[#bdd2ba] text-[#4f7b57]" : blockerCount ? "border-[#dfb3aa] text-[#a14b3f]" : "border-[#dec99e] text-[#926626]"}`}>
              {ready ? <CheckCircle2 className="size-4" aria-hidden="true" /> : blockerCount ? <CircleAlert className="size-4" aria-hidden="true" /> : <CircleDashed className="size-4" aria-hidden="true" />}
            </div>
            <div>
              <p className="text-[10px] font-semibold tracking-[0.2em] text-[#9a7650]">TRANSACTION SUBFLOW</p>
              <h3 className="mt-1.5 font-serif text-xl text-[#431e28]">{ready ? "1811 填写值已准备" : blockerCount ? "1811 存在阻断" : "1811 信息收集中"}</h3>
              <p className="mt-1.5 text-[11px] leading-5 text-[#796b6d]">这是活动方案下的一条执行子流程，不代表整个活动已经上线。</p>
            </div>
          </div>
          {sheet ? <CopyButton text={fillSheetText(sheet)} /> : null}
        </div>
        <dl className="mt-4 grid grid-cols-3 divide-x divide-[#e2d8d0] border-t border-[#e2d8d0] pt-3 text-center">
          <div><dt className="text-[9px] text-[#9a8984]">已记录</dt><dd className="mt-1 font-serif text-lg text-[#5e4449]">{filledCount}</dd></div>
          <div><dt className="text-[9px] text-[#9a8984]">仍缺</dt><dd className="mt-1 font-serif text-lg text-[#95652c]">{artifact.missingCount}</dd></div>
          <div><dt className="text-[9px] text-[#9a8984]">阻断</dt><dd className="mt-1 font-serif text-lg text-[#9d493e]">{blockerCount}</dd></div>
        </dl>
      </section>

      {!sheet ? (
        <div className="border-l-2 border-[#b38b55] bg-[#faf6ef] px-4 py-3 text-[12px] leading-5 text-[#6f6260]">继续在对话里补充 1811 确定性缺项，系统会同步生成逐项填写值。</div>
      ) : (
        <>
          <section>
            <SectionTitle index="01">活动信息</SectionTitle>
            <SheetRows rows={sheet.info} snapshot={snapshot} onShowSource={onShowSource} />
            <p className="mt-2 text-[10px] leading-4 text-[#8d7c78]">{sheet.afterAdd.join("；")}</p>
          </section>

          {sheet.settlement ? (
            <section>
              <SectionTitle index="02">结算说明函</SectionTitle>
              <div className="border border-[#e8ddd5] bg-white/65 px-3 py-3">
                {sheet.settlement.fileNames.map((name) => <p key={name} className="break-all font-mono text-[11px] text-[#4e4144]">{name}</p>)}
                <p className="mt-2 text-[10px] leading-4 text-[#8d7c78]">{sheet.settlement.steps.join("；")}</p>
              </div>
            </section>
          ) : null}

          {sheet.details.map((detail) => (
            <section key={detail.index}>
              <SectionTitle index={String(detail.index + 2).padStart(2, "0")}>优惠明细 {detail.index}</SectionTitle>
              <SheetRows rows={detail.rows} snapshot={snapshot} onShowSource={onShowSource} />
              <p className="mt-2 text-[10px] leading-4 text-[#8d7c78]">{detail.restNote}；{detail.action}</p>
            </section>
          ))}

          <section>
            <SectionTitle index="✓">自查与后续动作</SectionTitle>
            <div className="divide-y divide-[#eee5de] border-y border-[#e8ddd5] bg-white/65">
              {sheet.selfCheck.map((item) => (
                <div key={item.item} className="flex items-center justify-between gap-3 px-1 py-2.5 text-[11px]">
                  <span className="text-[#514347]">{item.item}</span>
                  <span className={`font-medium ${CHECK_TONE[item.status]}`}>{item.status}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-2">
              {sheet.postActions.map((action) => <p key={action.id} className="border-l-2 border-[#b38b55] bg-[#faf6ef] px-3 py-2 text-[10px] leading-4 text-[#6c5d5f]">{action.text}</p>)}
            </div>
          </section>

          <p className="flex items-start gap-2 bg-[#fff7f0] px-3 py-2.5 text-[10px] leading-4 text-[#7b6257]">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[#936c44]" aria-hidden="true" />
            {sheet.banner}；实际录入、审批与上线结果仍以门店系统为准。
          </p>
        </>
      )}
    </div>
  );
}
