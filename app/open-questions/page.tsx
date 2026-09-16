import { DESIGN_DEFAULTS, SOP_QUESTIONS } from "../lib/reference/open-questions";

export default function OpenQuestionsPage() {
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-8 md:px-8 md:py-10">
      <header className="rounded-3xl border border-[#d6e6f7] bg-white/70 p-5 shadow-[0_14px_40px_rgba(43,94,151,0.07)] backdrop-blur md:p-7">
        <p className="text-[12px] font-semibold tracking-[0.12em] text-[#2470cc]">规则资料</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-[#20314d] md:text-3xl">待确认清单</h1>
        <p className="mt-3 text-[15px] leading-7 text-[#4f6681]">
          《优惠开单活动创建 SOP》没说清的地方，demo 先按下面的方式处理，并在填写值里标「待确认」。确认之后改对应的处理即可。
        </p>
      </header>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-[#20314d]">SOP 没说清的问题</h2>
        <p className="mt-1 text-sm leading-6 text-[#71869f]">找熟悉 ICS 的同事确认。</p>
        <ol className="mt-4 space-y-4">
          {SOP_QUESTIONS.map((item) => (
            <li key={item.id} className="rounded-2xl border border-[#d6e6f7] bg-white/78 p-4 shadow-[0_8px_26px_rgba(43,94,151,0.05)] backdrop-blur md:p-5">
              <div className="flex gap-3 md:gap-4">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#247cff] text-[13px] font-medium text-white shadow-[0_5px_14px_rgba(36,124,255,0.22)]">{item.id}</span>
                <div className="grid min-w-0 flex-1 gap-4 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] md:gap-6">
                  <div>
                    <p className="text-[12px] font-medium text-[#2470cc]">要确认什么 · {item.sop}</p>
                    <h3 className="mt-1 text-[15px] leading-7 font-medium text-[#293b54]">{item.question}</h3>
                  </div>
                  <div>
                    <p className="text-[12px] font-medium text-[#2470cc]">demo 现在怎么处理</p>
                    <p className="mt-1 text-sm leading-6 text-[#4f6681]">{item.handling}</p>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold text-[#20314d]">设计默认值</h2>
        <p className="mt-1 text-sm leading-6 text-[#71869f]">由产品确认；改动只影响列出的模块。</p>
        <div className="mt-4 overflow-x-auto rounded-2xl border border-[#d6e6f7] bg-white/78 shadow-[0_8px_26px_rgba(43,94,151,0.05)] backdrop-blur">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-[#d9e7f6] bg-[#f1f7ff] text-[13px] text-[#637a95]">
                <th className="px-4 py-2.5 font-medium">编号</th>
                <th className="px-4 py-2.5 font-medium">默认值</th>
                <th className="px-4 py-2.5 font-medium">影响模块</th>
              </tr>
            </thead>
            <tbody>
              {DESIGN_DEFAULTS.map((item) => (
                <tr key={item.id} className="border-b border-[#e5eef8] transition-colors last:border-b-0 hover:bg-[#f8fbff]">
                  <td className="px-4 py-3 align-top font-medium text-[#2470cc]">{item.id}</td>
                  <td className="px-4 py-3 align-top leading-6 text-[#293b54]">{item.value}</td>
                  <td className="px-4 py-3 align-top text-[13px] leading-6 text-[#71869f]">{item.modules}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
