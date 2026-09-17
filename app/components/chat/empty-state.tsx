"use client";

import { CircleCheck, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { EXAMPLES } from "../../lib/campaign/ics1811/examples";
import { createSessionRequest, notifySessionsChanged } from "../../lib/client/api";
import { CAMPAIGN_TOOL_NAMES } from "../../lib/tool-trace";
import { Composer } from "./composer";

// 从模板起步：通用营销方向只提供开放式讨论入口；优惠配置示例继续取验收夹具，
// 避免在快捷入口里编造门店、货类或其他代码表事实。
const TEMPLATE_LABEL: Record<string, string> = { T1: "每克减", T6: "满减", T5: "打折", T2: "以旧换新" };

const GENERAL_STARTERS = [
  { id: "brand", label: "品牌传播", first: "想做一场新品品牌传播活动，先帮我梳理目标、人群和渠道" },
  { id: "member", label: "会员运营", first: "想做一次会员唤醒活动，先帮我一起设计" },
];

const STARTERS = [
  ...GENERAL_STARTERS,
  ...Object.keys(TEMPLATE_LABEL)
  .map((id) => {
    const example = EXAMPLES.find((item) => item.id === id);
    return example ? { id: `offer-${id}`, label: TEMPLATE_LABEL[id], first: example.first } : null;
  })
  .filter((item): item is { id: string; label: string; first: string } => item !== null),
];

export function EmptyState() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 建会话只保存这句话，不等模型；理解过程在对话页里以思考动画展示。
  const start = async (body: { entryMode: "new"; text: string } | { entryMode: "example" }) => {
    setBusy(true);
    setError("");
    try {
      const snapshot = await createSessionRequest(body);
      notifySessionsChanged();
      router.push(`/c/${snapshot.session.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "对话暂时无法创建，请重试");
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-[calc(100dvh-4rem)] items-center overflow-hidden px-4 py-12 md:min-h-screen md:px-8">
      <div aria-hidden="true" className="pointer-events-none absolute left-[18%] top-[14%] size-56 rounded-full bg-[#75b8ff]/12 blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute bottom-[8%] right-[12%] size-64 rounded-full bg-[#b9dcff]/20 blur-3xl" />
      <div data-testid="chat" className="relative mx-auto w-full max-w-[820px] text-center">
        <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#cde1fb] bg-white/70 px-3 py-1.5 text-[13px] font-semibold text-[#247cff] shadow-[0_6px_20px_rgba(36,124,255,0.08)] backdrop-blur">
          <Sparkles className="size-3.5" />
          周大福营销活动 Agent
        </span>
        <h1 className="text-[clamp(2.15rem,5vw,4rem)] font-bold leading-[1.07] tracking-[-0.045em] text-[#17243a]">
          从一个想法开始
          <span className="block bg-gradient-to-r from-[#247cff] via-[#2d8cff] to-[#5ea8ff] bg-clip-text text-transparent">一起把营销活动做完整</span>
        </h1>
        <p className="mx-auto mt-4 max-w-[680px] text-[15px] leading-7 text-[#657a95] md:text-base">从一句“你好”开始也可以。品牌传播、会员运营、门店活动、优惠设计、系统配置和对外文案，都可以直接聊；Agent 会先理解你想做什么，再按需要整理 Brief、规划执行步骤和准备产物。</p>

        <div className="mx-auto mt-8 max-w-[760px] text-left">
          <Composer
            value={text}
            onChange={setText}
            onSubmit={() => void start({ entryMode: "new", text })}
            busy={busy}
            placeholder="什么都可以说，例如：国庆想做一场面向年轻情侣的新品传播活动"
          />
        </div>
        <div className="mt-3 inline-flex max-w-full items-center gap-2 rounded-full border border-[#d8e8f8] bg-white/60 px-3.5 py-1.5 text-[12px] font-medium text-[#607791] backdrop-blur">
          <CircleCheck className="size-3.5 shrink-0 text-[#20a674]" />
          <span>{CAMPAIGN_TOOL_NAMES.length} 个营销工具已连接 · 活动规则库 · 代码表 · 版本记录</span>
        </div>
        {error ? (
          <p role="alert" className="mx-auto mt-3 max-w-[760px] rounded-xl border border-[#f2c8c3] bg-[#fff4f2] px-4 py-3 text-left text-sm text-[#a43f37]">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void start({ entryMode: "example" })}
            className="inline-flex h-11 items-center gap-2 rounded-full border border-[#cbdff5] bg-white/75 px-4 text-sm font-medium text-[#49627f] shadow-[0_5px_16px_rgba(47,93,143,0.05)] transition hover:-translate-y-0.5 hover:border-[#94bfff] hover:bg-white hover:text-[#247cff] disabled:opacity-60"
          >
            <Sparkles className="size-4 text-[#247cff]" />
            看一个优惠配置示例
          </button>
        </div>

        <div className="mt-6">
          <p className="text-[12px] text-[#8093aa]">或者从一个常见方向开始，填进输入框后可以继续改</p>
          <div className="mt-2.5 flex flex-wrap justify-center gap-2">
            {STARTERS.map((template) => (
              <button
                key={template.id}
                type="button"
                disabled={busy}
                onClick={() => setText(template.first)}
                className="inline-flex h-11 items-center rounded-full border border-[#d6e5f5] bg-white/70 px-4 text-[13px] text-[#536b87] transition hover:border-[#9ac3fb] hover:bg-[#eef6ff] hover:text-[#1c65bf] disabled:opacity-60"
              >
                {template.label}
              </button>
            ))}
          </div>
        </div>

        <p className="mx-auto mt-10 max-w-[760px] rounded-2xl border border-[#dbe9f7] bg-white/55 px-4 py-3 text-left text-[12px] leading-6 text-[#72869e] backdrop-blur">
          <strong className="font-semibold text-[#385575]">关于 ICS-1811</strong>
          ：它只是交易优惠活动需要时才启用的一个配置子流程；品牌、会员和传播活动不会被强行套入 1811。本工具不连接生产系统，代码表为演示数据。
        </p>
      </div>
    </div>
  );
}
