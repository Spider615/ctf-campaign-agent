"use client";

import { Check, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { StoredMessage } from "../../lib/campaign/ics1811/messages";
import type { Gap, Ics1811Draft } from "../../lib/campaign/ics1811/types";
import { initialRaw, QuestionControl, toAnswer, type RawAnswer } from "./question-controls";

type RoundCard = Extract<StoredMessage, { kind: "agent_round_card" }>;

type ClarifyCardProps = {
  message: RoundCard;
  // 卡片开着时只显示还没答的题（快照的 flow.openQuestions）；关闭后只列出当时问过什么。
  questions: Gap[];
  draft: Ics1811Draft;
  open: boolean;
  busy: boolean;
  onSubmit: (answers: Record<string, unknown>) => void;
};

export function ClarifyCard({ message, questions, draft, open, busy, onSubmit }: ClarifyCardProps) {
  const [raws, setRaws] = useState<Record<string, RawAnswer>>({});
  const rawOf = (gap: Gap) => raws[gap.id] ?? initialRaw(gap, draft);
  const results = questions.map((gap) => ({ gap, ...toAnswer(gap, rawOf(gap)) }));
  const error = results.find((item) => item.error)?.error ?? null;
  const answers = Object.fromEntries(results.flatMap((item) => (item.answer ? [[item.gap.id, item.answer]] : [])));
  const disabled = !open || busy;

  return (
    <div className="rounded-2xl border border-[#e1d6ca] bg-[#fffdfa] p-4 shadow-[0_8px_24px_rgba(65,32,39,0.04)]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-[#35262a]">{message.round === 1 ? "还需要你补充这几项" : "还差这几项"}</p>
        <span className="shrink-0 rounded-full bg-[#f5efe7] px-2 py-0.5 text-[11px] text-[#8b6b3b]">第 {message.round} 轮 · 最多 2 轮</span>
      </div>

      {open ? (
        <div className="mt-2">
          {results.map(({ gap }) => (
            <div key={gap.id} className="border-t border-[#efe7de] py-3">
              <p className="text-sm font-medium text-[#35262a]">
                {gap.title}
                {gap.repeated ? <span className="ml-2 text-[11px] font-normal text-[#9c642b]">上一轮没回答</span> : null}
              </p>
              {gap.hint ? <p className="mt-0.5 text-[12px] leading-5 text-[#9a3f24]">{gap.hint}</p> : null}
              {gap.candidates?.length ? <p className="mt-0.5 text-[12px] leading-5 text-[#8a7d80]">可能是：{gap.candidates.join("、")}</p> : null}
              <div className="mt-2">
                <QuestionControl gap={gap} raw={rawOf(gap)} disabled={disabled} onChange={(patch) => setRaws((current) => ({ ...current, [gap.id]: { ...(current[gap.id] ?? initialRaw(gap, draft)), ...patch } }))} />
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#efe7de] pt-3">
            <p className="max-w-[440px] text-[12px] leading-5 text-[#8a7d80]">
              {message.round === 1 ? "暂时不知道的可以先空着，第 2 轮会再问；也可以直接在下面打字补充。" : "这是最后一轮。没补齐的项会列在复述里，补齐之前不能生成填写值。"}
            </p>
            <Button type="button" disabled={disabled || Boolean(error)} onClick={() => onSubmit(answers)} className="h-10 rounded-xl bg-[#651427] px-5 text-white hover:bg-[#791a30]">
              {busy ? <Loader2 className="animate-spin" /> : <Check />}
              提交
            </Button>
          </div>
          {error ? <p className="mt-2 text-[12px] text-[#9a3f24]">{error}</p> : null}
        </div>
      ) : (
        <p className="mt-2 text-[12px] leading-5 text-[#9a8d8f]">已处理：{message.questions.map((gap) => gap.title).join("；")}</p>
      )}
    </div>
  );
}
