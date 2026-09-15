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
  const start = async (body: { entryMode: "new"; text: string } | { entryMode: "example" }) => {
    if (body.entryMode === "new" && body.text.trim().length < 4) {
      setError("请用一句话说明活动，例如日期、门店和优惠");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const snapshot = await createSessionRequest(body);
      notifySessionsChanged();
      router.push(`/c/${snapshot.session.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "活动暂时无法创建，请重试");
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[calc(100dvh-4rem)] items-center px-4 py-10 md:min-h-screen md:px-8">
      <div data-testid="chat" className="mx-auto w-full max-w-[760px]">
        <span className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-[#8b6b3b]">
          <span className="h-px w-8 bg-[#b99050]" />
          1811 开单助手
        </span>
        <h1 className="text-[clamp(2rem,4.5vw,3.6rem)] font-semibold leading-[1.08] tracking-[-0.04em] text-[#2c1720]">今天要建什么优惠活动？</h1>
        <p className="mt-3 text-base leading-7 text-[#766b6d]">说清日期、门店、优惠和货类，Agent 最多追问两轮，复述确认后给出 ICS-1811 的逐项填写值。</p>

        <div className="mt-7">
          <Composer
            value={text}
            onChange={setText}
            onSubmit={() => void start({ entryMode: "new", text })}
            busy={busy}
            placeholder="例如：5 月 1 日到 5 日，闽深区 7590 门店，一般足金类黄金按实际克重每克减 15 元"
          />
        </div>
        {error ? (
          <p role="alert" className="mt-3 rounded-xl border border-[#efc8bb] bg-[#fff2ec] px-4 py-3 text-sm text-[#8f2f1d]">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void start({ entryMode: "example" })}
            className="inline-flex h-10 items-center gap-2 rounded-full border border-[#d8cbbd] bg-[#fbf8f3] px-4 text-sm text-[#5d4a4f] transition hover:border-[#b89561] hover:bg-white disabled:opacity-60"
          >
            <Sparkles className="size-4 text-[#9c6b2f]" />
            看一个完整示例
          </button>
        </div>

        <p className="mt-12 rounded-xl border border-[#e4d9cd] bg-[#fbf8f3] px-4 py-3 text-[13px] leading-6 text-[#766b6d]">
          <strong className="font-semibold text-[#4b3037]">1811 填写值</strong>
          ：在周大福 ICS 系统「1811 优惠开单活动新增」页面上逐项要填的内容，包括活动信息和每条明细。本工具不连接 ICS，代码表为演示编造，由你照着录入。
        </p>
      </div>
    </div>
  );
}
