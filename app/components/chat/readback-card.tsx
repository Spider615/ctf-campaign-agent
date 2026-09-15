"use client";

import { AlertTriangle, CheckCircle2, Info, Loader2 } from "lucide-react";

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
};

function Section({ title, tone, items }: { title: string; tone: "alert" | "warn"; items: React.ReactNode[] }) {
  return (
    <div className={`mt-3 rounded-xl px-3 py-2 ${tone === "alert" ? "bg-[#fff2ec]" : "bg-[#fcf5ec]"}`}>
      <p className={`flex items-center gap-1.5 text-[12px] font-medium ${tone === "alert" ? "text-[#8f2f1d]" : "text-[#8b5d25]"}`}>
        {tone === "alert" ? <AlertTriangle className="size-3.5" /> : <Info className="size-3.5" />}
        {title}
      </p>
      <ul className="mt-1 space-y-1 text-[13px] leading-5 text-[#4b3037]">{items}</ul>
    </div>
  );
}

export function ReadbackCard({ message, current, busy, onConfirm, onDismiss }: ReadbackCardProps) {
  const { readback } = message;
  return (
    <div className="rounded-2xl border border-[#e1d6ca] bg-[#fffdfa] p-4 shadow-[0_8px_24px_rgba(65,32,39,0.04)]">
      <p className="text-[12px] font-medium tracking-[0.08em] text-[#9a7442]">我的理解 · 版本 {message.versionSeq}</p>
      <p className="mt-2 text-[14px] leading-7 text-[#35262a]">{readback.paragraph}</p>

      {readback.missing.length ? <Section title="仍缺，补齐前不能生成" tone="alert" items={readback.missing.map((item) => <li key={item}>{item}</li>)} /> : null}
      {readback.blockers.length ? <Section title="要先处理" tone="alert" items={readback.blockers.map((item) => <li key={item}>{item}</li>)} /> : null}
      {readback.attention.length ? (
        <Section
          title="需要你注意"
          tone="warn"
          items={readback.attention.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-2">
              <span>{item.text}</span>
              {item.dismissible && current ? (
                <button type="button" disabled={busy} onClick={() => onDismiss(item.id)} className="shrink-0 rounded-full border border-[#d6c3a3] bg-white px-2 py-0.5 text-[12px] text-[#6b4f2c] hover:bg-[#faf2e5] disabled:opacity-60">
                  不限定
                </button>
              ) : null}
            </li>
          ))}
        />
      ) : null}

      {current ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="button" disabled={busy || !readback.canConfirm} onClick={onConfirm} className="h-10 rounded-xl bg-[#651427] px-5 text-white hover:bg-[#791a30]">
            {busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
            确认无误，生成填写值
          </Button>
          <span className="text-[12px] text-[#8a7d80]">{readback.canConfirm ? "有不对的地方，直接在下面打字改" : readback.missing.length ? "补齐仍缺的项后才能生成" : "先处理上面的问题"}</span>
        </div>
      ) : (
        <p className="mt-3 text-[12px] text-[#9a8d8f]">之后信息有改动，以最新的复述为准</p>
      )}
    </div>
  );
}
