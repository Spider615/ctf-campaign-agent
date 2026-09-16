"use client";

import { Check } from "lucide-react";

import type { CampaignStep } from "../../lib/campaign/ics1811/steps";

// 活动是一步步搭起来的，但对话把这个过程摊平了：这条窄带把「现在走到哪一步」一直摆在眼前。
// 刻意做得克制——对话仍是主体，它只是一条参照，不抢视线（见「以对话为主」）。
export function StepRail({ steps }: { steps: CampaignStep[] }) {
  return (
    <ol
      aria-label="活动搭建进度"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[#dce9f6] bg-white/52 px-4 py-2.5 backdrop-blur md:px-8"
    >
      {steps.map((step, index) => {
        const done = step.state === "done";
        const current = step.state === "current";
        return (
          <li key={step.key} className="flex shrink-0 items-center gap-1">
            {index > 0 ? <span aria-hidden="true" className={`mx-1 h-px w-4 ${done || current ? "bg-[#9ec6ff]" : "bg-[#d9e7f6]"}`} /> : null}
            <span
              aria-current={current ? "step" : undefined}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] leading-5 ${
                current ? "bg-[#247cff] font-medium text-white shadow-[0_5px_14px_rgba(36,124,255,0.22)]" : done ? "bg-[#edf5ff] text-[#376b9f]" : "text-[#93a6bb]"
              }`}
            >
              <span
                aria-hidden="true"
                className={`grid size-4 shrink-0 place-items-center rounded-full text-[10px] ${
                  current ? "bg-white/20 text-white" : done ? "bg-[#d7e9ff] text-[#247cff]" : "bg-[#edf3f9] text-[#93a6bb]"
                }`}
              >
                {done ? <Check className="size-2.5" /> : index + 1}
              </span>
              {step.label}
              {current && step.detail ? <span className="text-white/75">· {step.detail}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
