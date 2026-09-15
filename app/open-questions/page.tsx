import { DESIGN_DEFAULTS, SOP_QUESTIONS } from "../lib/reference/open-questions";

export default function OpenQuestionsPage() {
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 md:px-8">
      <header>
        <p className="text-[12px] font-medium tracking-[0.12em] text-[#8b6b3b]">资料</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-[#2c1720] md:text-3xl">待确认清单</h1>
        <p className="mt-3 text-[15px] leading-7 text-[#2f2226]">
          《优惠开单活动创建 SOP》没说清的地方，demo 先按下面的方式处理，并在复述和填写值里标「待确认」。确认之后改对应的处理即可。
        </p>
      </header>

      <section className="mt-8">
        <h2 className="text-xl font-semibold text-[#2c1720]">SOP 没说清的问题</h2>
        <p className="mt-1 text-sm leading-6 text-[#817578]">找熟悉 ICS 的同事确认。</p>
        <ol className="mt-4 space-y-4">
          {SOP_QUESTIONS.map((item) => (
            <li key={item.id} className="rounded-2xl border border-[#ded5cb] bg-[#fffdfa] p-4 md:p-5">
              <div className="flex gap-3 md:gap-4">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#651427] text-[13px] font-medium text-white">{item.id}</span>
                <div className="grid min-w-0 flex-1 gap-4 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] md:gap-6">
                  <div>
                    <p className="text-[12px] font-medium text-[#8b6b3b]">要确认什么 · {item.sop}</p>
                    <h3 className="mt-1 text-[15px] leading-7 font-medium text-[#2c1720]">{item.question}</h3>
                  </div>
                  <div>
                    <p className="text-[12px] font-medium text-[#8b6b3b]">demo 现在怎么处理</p>
                    <p className="mt-1 text-sm leading-6 text-[#2f2226]">{item.handling}</p>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold text-[#2c1720]">设计默认值</h2>
        <p className="mt-1 text-sm leading-6 text-[#817578]">由产品确认；改动只影响列出的模块。</p>
        <div className="mt-4 overflow-x-auto rounded-2xl border border-[#ded5cb] bg-[#fffdfa]">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-[#ded5cb] bg-[#f6f1ea] text-[13px] text-[#817578]">
                <th className="px-4 py-2.5 font-medium">编号</th>
                <th className="px-4 py-2.5 font-medium">默认值</th>
                <th className="px-4 py-2.5 font-medium">影响模块</th>
              </tr>
            </thead>
            <tbody>
              {DESIGN_DEFAULTS.map((item) => (
                <tr key={item.id} className="border-b border-[#ece5dc] last:border-b-0">
                  <td className="px-4 py-3 align-top font-medium text-[#651427]">{item.id}</td>
                  <td className="px-4 py-3 align-top leading-6 text-[#2f2226]">{item.value}</td>
                  <td className="px-4 py-3 align-top text-[13px] leading-6 text-[#817578]">{item.modules}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
