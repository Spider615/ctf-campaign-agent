import { OPEN_QUESTIONS } from "../lib/reference/open-questions";

export default function OpenQuestionsPage() {
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 md:px-8">
      <header>
        <p className="text-[12px] font-medium tracking-[0.12em] text-[#8b6b3b]">资料</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-[#2c1720] md:text-3xl">待确认清单</h1>
        <p className="mt-3 text-[15px] leading-7 text-[#2f2226]">
          这些问题需要周大福确认。确认之前，Agent 会把相关字段标为待界面选择，或者按保守口径处理。
        </p>
      </header>

      <ol className="mt-6 space-y-4">
        {OPEN_QUESTIONS.map((item) => (
          <li key={item.id} className="rounded-2xl border border-[#ded5cb] bg-[#fffdfa] p-4 md:p-5">
            <div className="flex gap-3 md:gap-4">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#651427] text-[13px] font-medium text-white">
                {item.id}
              </span>
              <div className="grid min-w-0 flex-1 gap-4 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_170px] md:gap-6">
                <div>
                  <p className="text-[12px] font-medium text-[#8b6b3b]">要确认什么</p>
                  <h2 className="mt-1 text-[15px] leading-7 font-medium text-[#2c1720]">{item.question}</h2>
                </div>
                <div>
                  <p className="text-[12px] font-medium text-[#8b6b3b]">不确认会怎样</p>
                  <p className="mt-1 text-sm leading-6 text-[#2f2226]">{item.impact}</p>
                </div>
                <div>
                  <p className="text-[12px] font-medium text-[#8b6b3b]">找谁确认</p>
                  <p className="mt-1 text-sm leading-6 font-medium text-[#651427]">{item.owner}</p>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
