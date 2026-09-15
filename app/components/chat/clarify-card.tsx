"use client";

import { Check, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { StoredMessage } from "../../lib/campaign/ics1811/messages";
import { QUESTION_EXAMPLE } from "../../lib/campaign/ics1811/questions";
import type { Gap, Ics1811Draft } from "../../lib/campaign/ics1811/types";
import { initialRaw, QuestionControl, toAnswer, type RawAnswer } from "./question-controls";

type RoundCard = Extract<StoredMessage, { kind: "agent_round_card" }>;

type ClarifyCardProps = {
  message: RoundCard;
  // 这一轮还没答的题（快照的 flow.openQuestions）；这一轮结束后为空。
  pending: Gap[];
  draft: Ics1811Draft;
  open: boolean;
  busy: boolean;
  onSubmit: (answers: Record<string, unknown>) => void;
};

// 追问以对话为主：问题直接写在对话里，用户打字回答；选项只是快捷方式，默认收起。
export function ClarifyCard({ message, pending, draft, open, busy, onSubmit }: ClarifyCardProps) {
  const [showOptions, setShowOptions] = useState(false);
  const [raws, setRaws] = useState<Record<string, RawAnswer>>({});
  const pendingIds = new Set(pending.map((gap) => gap.id));
  // 题面用快照里的最新版本，候选和提示会随回答更新；「上一轮没回答」以出卡时为准
  const questions = message.questions.map((gap) => {
    const latest = pending.find((item) => item.id === gap.id);
    return latest ? { ...latest, repeated: gap.repeated } : gap;
  });
  const rawOf = (gap: Gap) => raws[gap.id] ?? initialRaw(gap, draft);
  const results = questions.filter((gap) => pendingIds.has(gap.id)).map((gap) => ({ gap, ...toAnswer(gap, rawOf(gap)) }));
  const error = results.find((item) => item.error)?.error ?? null;
  const answers = Object.fromEntries(results.flatMap((item) => (item.answer ? [[item.gap.id, item.answer]] : [])));
  const example = pending.map((gap) => QUESTION_EXAMPLE[gap.id]).filter(Boolean).join("，");
  const disabled = !open || busy;

  return (
    <div data-testid="round-questions" className={`pt-1 text-[15px] leading-7 ${open ? "text-[#35262a]" : "text-[#8a7d80]"}`}>
      <p>
        {message.round === 1 ? "还需要你告诉我这几件事：" : "还差这几项，这是最后一轮追问："}
        <span className="ml-2 whitespace-nowrap rounded-full bg-[#f5efe7] px-2 py-0.5 align-middle text-[11px] text-[#8b6b3b]">第 {message.round} 轮 · 最多 2 轮</span>
      </p>
      <ol className="mt-1 space-y-1">
        {questions.map((gap, index) => {
          const answered = open && !pendingIds.has(gap.id);
          return (
            <li key={gap.id} className={`flex gap-2 ${answered ? "text-[#a1969a]" : ""}`}>
              <span className="w-5 shrink-0 text-right tabular-nums text-[#9a7442]">{answered ? <Check className="mt-1.5 inline size-4 text-[#4f7a4a]" /> : `${index + 1}.`}</span>
              <span className="min-w-0">
                <span className={answered ? "line-through" : ""}>{gap.title}</span>
                {gap.repeated && !answered && open ? <span className="ml-2 text-[12px] text-[#9c642b]">上一轮没回答</span> : null}
                {gap.hint && !answered && open ? <span className="block text-[13px] leading-6 text-[#9a3f24]">{gap.hint}</span> : null}
                {gap.candidates?.length && !answered && open ? <span className="block text-[13px] leading-6 text-[#8a7d80]">可能是：{gap.candidates.join("、")}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>

      {open ? (
        <>
          <p className="mt-2 text-[13px] leading-6 text-[#8a7d80]">
            直接回复就行{example ? `，比如「${example}」` : ""}。{message.round === 1 ? "暂时不知道的可以先不说，下一轮会再问。" : "没补齐的会列在复述里，补齐之前不能生成填写值。"}
          </p>
          <button
            type="button"
            onClick={() => setShowOptions((value) => !value)}
            className="mt-1 inline-flex items-center gap-1 text-[13px] text-[#8b6b3b] underline-offset-4 hover:underline"
          >
            {showOptions ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {showOptions ? "收起选项" : "不想打字？用选项填写"}
          </button>

          {showOptions ? (
            <div className="mt-2 rounded-2xl border border-[#e1d6ca] bg-[#fffdfa] px-4 pb-3 shadow-[0_8px_24px_rgba(65,32,39,0.04)]">
              {results.map(({ gap }) => (
                <div key={gap.id} className="border-b border-[#efe7de] py-3 last:border-b-0">
                  <p className="text-sm font-medium text-[#35262a]">{gap.title}</p>
                  <div className="mt-2">
                    <QuestionControl gap={gap} raw={rawOf(gap)} disabled={disabled} onChange={(patch) => setRaws((current) => ({ ...current, [gap.id]: { ...(current[gap.id] ?? initialRaw(gap, draft)), ...patch } }))} />
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap items-center justify-end gap-3 pt-3">
                {error ? <p className="mr-auto text-[12px] text-[#9a3f24]">{error}</p> : null}
                <Button type="button" disabled={disabled || Boolean(error)} onClick={() => onSubmit(answers)} className="h-10 rounded-xl bg-[#651427] px-5 text-white hover:bg-[#791a30]">
                  {busy ? <Loader2 className="animate-spin" /> : <Check />}
                  提交这些选项
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <p className="mt-1 text-[12px] text-[#9a8d8f]">这一轮已经结束</p>
      )}
    </div>
  );
}
