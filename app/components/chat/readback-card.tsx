"use client";

import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { StoredMessage } from "../../lib/campaign/ics1811/messages";

type ReadbackMessage = Extract<StoredMessage, { kind: "agent_readback" }>;

type ReadbackCardProps = {
  message: ReadbackMessage;
  // 这张复述对应最新版本；旧复述不能再确认。
  current: boolean;
  busy: boolean;
  onConfirm: () => void;
  onDismiss: (noteId: string) => void;
  onOpenPanel: (tab: string) => void;
};

// 挡着确认的两类：仍缺的人定项、没通过的校验。这两块必须留在卡片里。
function Blocking({ title, items }: { title: string; items: React.ReactNode[] }) {
  return (
    <div className="mt-3 rounded-xl border border-[#f1cbc5] bg-[#fff4f2] px-3 py-2">
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-[#b2443b]">
        <AlertTriangle className="size-3.5" />
        {title}
      </p>
      <ul className="mt-1 space-y-1 text-[13px] leading-5 text-[#5f4a50]">{items}</ul>
    </div>
  );
}

// 复述是整个流程里唯一要用户拍板的地方，所以它保留卡片形态；但只放决定「确认不确认」的东西：
// 一句话结论、挡着确认的项、要用户选的提示。300 多字的完整复述折叠，纯说明的提示挪进面板。
export function ReadbackCard({ message, current, busy, onConfirm, onDismiss, onOpenPanel }: ReadbackCardProps) {
  const { readback } = message;
  const [open, setOpen] = useState(false);
  // 旧会话存下来的复述没有 summary，退回完整段落，不要显示一行空白。
  const summary = readback.summary || readback.paragraph;
  // 决定「要不要确认」的句子必须一直可见；只有按默认的那些才折叠。
  const essentials = readback.essentials ?? [];
  const defaults = readback.defaults ?? [];
  const layered = essentials.length > 0;
  // 能选「不限定」的要用户拍板，留在卡片里；其余纯说明的只报个数，点开面板看。
  const actionable = readback.attention.filter((item) => item.dismissible);
  const informational = readback.attention.length - actionable.length;

  return (
    // 不再套卡片外壳：复述是对话的一部分，套上边框、阴影和毛玻璃之后，
    // 它看起来像从对话里弹出来的系统面板，和「以对话为主」是反的。
    // 但它仍是全流程唯一要用户拍板的地方，所以留一条竖线做最轻的区隔——
    // 一点分隔都没有，用户就分不出哪句是闲聊、哪段是确认了就生成填写值的结论。
    <div className="border-l-2 border-[#c7ddff] pl-3.5">
      <p className="text-[15px] font-medium leading-7 text-[#263950]">{summary}</p>

      {layered ? (
        <>
          <ul className="mt-2 space-y-1 text-[14px] leading-7 text-[#425873]">
            {essentials.map((line) => <li key={line}>{line}</li>)}
          </ul>
          {defaults.length ? (
            <>
              <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                className="mt-1.5 inline-flex min-h-11 items-center gap-1 rounded-lg px-1 text-[13px] text-[#2470cc] underline-offset-4 hover:bg-[#edf5ff] hover:underline md:min-h-9"
              >
                {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                {open ? "收起按默认的项" : `另有 ${defaults.length} 项按默认填`}
              </button>
              {open ? (
                <ul className="mt-1.5 space-y-1 rounded-xl bg-[#f1f7ff] px-3 py-2 text-[13px] leading-6 text-[#5f7690]">
                  {defaults.map((line) => <li key={line}>{line}</li>)}
                </ul>
              ) : null}
            </>
          ) : null}
        </>
      ) : readback.summary ? (
        // 旧会话只有整段复述，保持原来的折叠方式。
        <>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="mt-1 inline-flex min-h-11 items-center gap-1 rounded-lg px-1 text-[13px] text-[#2470cc] underline-offset-4 hover:bg-[#edf5ff] hover:underline md:min-h-9"
          >
            {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {open ? "收起完整复述" : "展开完整复述"}
          </button>
          {open ? <p className="mt-2 whitespace-pre-wrap text-[14px] leading-7 text-[#566d88]">{readback.paragraph}</p> : null}
        </>
      ) : null}

      {readback.missing.length ? <Blocking title="仍缺，补齐前不能生成" items={readback.missing.map((item) => <li key={item}>{item}</li>)} /> : null}
      {readback.blockers.length ? <Blocking title="要先处理" items={readback.blockers.map((item) => <li key={item}>{item}</li>)} /> : null}

      {actionable.length ? (
        <ul className="mt-3 space-y-1 text-[13px] leading-5 text-[#425873]">
          {actionable.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-2">
              <span>{item.text}</span>
              {current ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onDismiss(item.id)}
                  className="min-h-11 shrink-0 rounded-full border border-[#bcd6f3] bg-white px-3 py-1 text-[12px] text-[#3970ad] hover:bg-[#edf5ff] disabled:opacity-60 md:min-h-9"
                >
                  不限定
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {current ? (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button type="button" disabled={busy || !readback.canConfirm} onClick={onConfirm} className="h-11 rounded-xl bg-[#247cff] px-5 text-white shadow-[0_8px_20px_rgba(36,124,255,0.22)] hover:bg-[#176bea]">
            {busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
            确认无误，生成填写值
          </Button>
          <span className="text-[12px] text-[#71869f]">
            {readback.canConfirm ? "有不对的地方，直接在下面打字改" : readback.missing.length ? "补齐仍缺的项后才能生成" : "先处理上面的问题"}
          </span>
          {informational ? (
            <button type="button" onClick={() => onOpenPanel("tbc")} className="min-h-11 rounded-lg px-1 text-[12px] text-[#2470cc] underline-offset-4 hover:bg-[#edf5ff] hover:underline md:min-h-9">
              另有 {informational} 条待确认说明
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-[12px] text-[#8ca0b7]">之后信息有改动，以最新的复述为准</p>
      )}
    </div>
  );
}
