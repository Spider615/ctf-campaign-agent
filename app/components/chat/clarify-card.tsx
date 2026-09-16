"use client";

import { Check, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { StoredMessage } from "../../lib/campaign/ics1811/messages";
import { QUESTION_EXAMPLE } from "../../lib/campaign/ics1811/questions";
import { recordedSoFar } from "../../lib/campaign/ics1811/recorded";
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
  // 只问缺的，用户看不到已经攒下的部分；把已记下的摆出来，搭建过程才看得见。
  const recorded = recordedSoFar(draft);
  const disabled = !open || busy;

  return (
    <div data-testid="round-questions" className={`pt-1 text-[15px] leading-7 ${open ? "text-[#293b54]" : "text-[#72869e]"}`}>
      <p>
        {message.round === 1 ? "还需要你告诉我这几件事：" : "还差这几项，这是最后一轮追问："}
        <span className="ml-2 whitespace-nowrap rounded-full bg-[#e8f3ff] px-2 py-0.5 align-middle text-[11px] font-medium text-[#2470cc]">第 {message.round} 轮 · 最多 2 轮</span>
      </p>
      <ol className="mt-1 space-y-1">
        {questions.map((gap, index) => {
          const answered = open && !pendingIds.has(gap.id);
          return (
            <li key={gap.id} className={`flex gap-2 ${answered ? "text-[#9aacbf]" : ""}`}>
              <span className="w-5 shrink-0 text-right tabular-nums text-[#4d86c8]">{answered ? <Check className="mt-1.5 inline size-4 text-[#20a674]" /> : `${index + 1}.`}</span>
              <span className="min-w-0">
                <span className={answered ? "line-through" : ""}>{gap.title}</span>
                {gap.repeated && !answered && open ? <span className="ml-2 text-[12px] text-[#b36b16]">上一轮没回答</span> : null}
                {gap.hint && !answered && open ? <span className="block text-[13px] leading-6 text-[#b2443b]">{gap.hint}</span> : null}
                {gap.candidates?.length && !answered && open ? <span className="block text-[13px] leading-6 text-[#71869f]">可能是：{gap.candidates.join("、")}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>

      {open ? (
        <>
          {recorded.length ? (
            <p className="mt-2 text-[13px] leading-6 text-[#607690]">
              <span className="font-medium text-[#168660]">已经记下</span>：{recorded.join("、")}
            </p>
          ) : null}
          <p className="mt-2 text-[13px] leading-6 text-[#71869f]">
            直接回复就行{example ? `，比如「${example}」` : ""}。{message.round === 1 ? "暂时不知道的可以先不说，下一轮会再问。" : "没补齐的会列在复述里，补齐之前不能生成填写值。"}
          </p>
          <button
            type="button"
            onClick={() => setShowOptions((value) => !value)}
            className="mt-1 inline-flex min-h-11 items-center gap-1 rounded-lg px-1 text-[13px] text-[#2470cc] underline-offset-4 hover:bg-[#edf5ff] hover:underline md:min-h-9"
          >
            {showOptions ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            {showOptions ? "收起选项" : "不想打字？用选项填写"}
          </button>

          {showOptions ? (
            <div className="mt-2 rounded-2xl border border-[#cfe0f2] bg-white/80 px-4 pb-3 shadow-[0_10px_28px_rgba(43,94,151,0.07)]">
              {results.map(({ gap }) => (
                <div key={gap.id} className="border-b border-[#e4edf7] py-3 last:border-b-0">
                  <p className="text-sm font-medium text-[#293b54]">{gap.title}</p>
                  <div className="mt-2">
                    <QuestionControl gap={gap} raw={rawOf(gap)} disabled={disabled} onChange={(patch) => setRaws((current) => ({ ...current, [gap.id]: { ...(current[gap.id] ?? initialRaw(gap, draft)), ...patch } }))} />
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap items-center justify-end gap-3 pt-3">
                {error ? <p className="mr-auto text-[12px] text-[#b2443b]">{error}</p> : null}
                <Button type="button" disabled={disabled || Boolean(error)} onClick={() => onSubmit(answers)} className="h-11 rounded-xl bg-[#247cff] px-5 text-white shadow-[0_7px_18px_rgba(36,124,255,0.2)] hover:bg-[#176bea]">
                  {busy ? <Loader2 className="animate-spin" /> : <Check />}
                  提交这些选项
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <p className="mt-1 text-[12px] text-[#8ca0b7]">这一轮已经结束</p>
      )}
    </div>
  );
}
