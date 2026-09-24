"use client";

import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { createSessionRequest, notifySessionsChanged } from "../../lib/client/api";
import { Composer } from "./composer";

export function EmptyState() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 建会话只保存这句话，不等模型；理解过程在对话页里以思考动画展示。
  const start = async (body: { entryMode: "new"; text: string }) => {
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
        {error ? (
          <p role="alert" className="mx-auto mt-3 max-w-[760px] rounded-xl border border-[#f2c8c3] bg-[#fff4f2] px-4 py-3 text-left text-sm text-[#a43f37]">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
