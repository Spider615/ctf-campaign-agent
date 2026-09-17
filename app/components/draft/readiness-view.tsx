import { CheckCircle2, CircleDashed, CircleMinus, Clock3, ShieldAlert, ShieldCheck } from "lucide-react";

import type { CampaignReadinessGate, CampaignWorkspace } from "../../lib/campaign/types";

const GATE_STATUS = {
  pending: { label: "待前置完成", icon: Clock3, tone: "text-[#8d7f7a]", rail: "bg-[#c8beb8]" },
  needs_confirmation: { label: "待人工确认", icon: ShieldAlert, tone: "text-[#93506a]", rail: "bg-[#9f3451]" },
  blocked: { label: "阻断", icon: ShieldAlert, tone: "text-[#a14b3f]", rail: "bg-[#b85246]" },
  passed: { label: "材料已备", icon: CheckCircle2, tone: "text-[#4f7b57]", rail: "bg-[#5c8c64]" },
  not_applicable: { label: "不适用", icon: CircleMinus, tone: "text-[#9a918c]", rail: "bg-[#c8c0bb]" },
} satisfies Record<CampaignReadinessGate["status"], { label: string; icon: typeof CheckCircle2; tone: string; rail: string }>;

export function ReadinessView({ workspace }: { workspace: CampaignWorkspace }) {
  const gates = workspace.readiness.gates;
  const passed = gates.filter((gate) => gate.status === "passed" || gate.status === "not_applicable").length;
  const blocked = gates.filter((gate) => gate.status === "blocked").length;
  const needsHuman = gates.filter((gate) => gate.status === "needs_confirmation").length;

  return (
    <div className="space-y-5 text-[#34292b]">
      <section className={`border px-4 py-4 ${workspace.readiness.status === "blocked" ? "border-[#e5c5bc] bg-[#fff8f5]" : "border-[#ddcbd1] bg-[#fff8fa]"}`}>
        <div className="flex items-start gap-3">
          <div className={`grid size-10 shrink-0 place-items-center rounded-full border ${workspace.readiness.status === "blocked" ? "border-[#ddb0a7] text-[#a14b3f]" : "border-[#d8b5c1] text-[#8f3b57]"}`}>
            {workspace.readiness.status === "blocked" ? <ShieldAlert className="size-5" aria-hidden="true" /> : <ShieldCheck className="size-5" aria-hidden="true" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold tracking-[0.2em] text-[#9a7650]">LAUNCH READINESS</p>
            <h3 className="mt-1.5 font-serif text-xl text-[#431e28]">{workspace.readiness.status === "blocked" ? "上线前仍有阻断" : "已进入人工确认阶段"}</h3>
            <p className="mt-2 text-[11px] leading-5 text-[#796b6d]">这里判断材料是否具备，不代替法务、审批、库存、渠道或门店系统里的真实确认。</p>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-3 divide-x divide-[#e7dcd5] border-y border-[#e7dcd5] py-3 text-center">
          <div><dt className="text-[10px] text-[#988983]">已备</dt><dd className="mt-1 font-serif text-xl text-[#4f7b57]">{passed}</dd></div>
          <div><dt className="text-[10px] text-[#988983]">待人工</dt><dd className="mt-1 font-serif text-xl text-[#8f3b57]">{needsHuman}</dd></div>
          <div><dt className="text-[10px] text-[#988983]">阻断</dt><dd className="mt-1 font-serif text-xl text-[#a14b3f]">{blocked}</dd></div>
        </dl>
      </section>

      <section aria-labelledby="readiness-gates-title">
        <div className="mb-3 flex items-center justify-between">
          <h4 id="readiness-gates-title" className="text-[11px] font-semibold tracking-[0.16em] text-[#6b5559]">上线闸门</h4>
          <span className="text-[10px] text-[#9b8c87]">逐项看依据与动作</span>
        </div>
        <div className="space-y-2.5" role="list">
          {gates.map((gate, index) => {
            const status = GATE_STATUS[gate.status];
            const Icon = status.icon;
            return (
              <article key={gate.id} role="listitem" className="relative overflow-hidden border border-[#e8dfd8] bg-[#fffdfb] pl-4 pr-3 py-3.5">
                <span className={`absolute inset-y-0 left-0 w-0.5 ${status.rail}`} aria-hidden="true" />
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span className="mt-0.5 font-serif text-[11px] text-[#b29d92]">{String(index + 1).padStart(2, "0")}</span>
                    <div className="min-w-0">
                      <h5 className="text-[13px] font-semibold text-[#3e3033]">{gate.title}</h5>
                      {gate.basis.length ? (
                        <ul className="mt-1.5 space-y-1 text-[10px] leading-4 text-[#8b7b77]">
                          {gate.basis.map((basis) => <li key={basis}>依据 · {basis}</li>)}
                        </ul>
                      ) : null}
                    </div>
                  </div>
                  <span className={`inline-flex shrink-0 items-center gap-1 text-[10px] font-medium ${status.tone}`}>
                    <Icon className="size-3.5" aria-hidden="true" />
                    {status.label}
                  </span>
                </div>
                {gate.nextAction ? (
                  <div className="mt-3 ml-6 flex items-start gap-2 border-t border-[#eee6e0] pt-2.5 text-[11px] leading-4 text-[#5e4f52]">
                    <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-[#a68162]" aria-hidden="true" />
                    <p><span className="mr-1 font-medium text-[#8b6748]">下一步</span>{gate.nextAction}</p>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
