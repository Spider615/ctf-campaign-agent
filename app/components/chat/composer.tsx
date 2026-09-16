"use client";

import { ArrowUp } from "lucide-react";
import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  placeholder: string;
};

// 水合与否之后不会再变，所以订阅是空实现：服务端直出和水合那一帧取 false，React 接管后取 true。
const subscribeHydration = () => () => {};
const hydratedOnClient = () => true;
const hydratedOnServer = () => false;

// 等待状态由对话里的思考动画表达，输入框只负责禁用发送。
export function Composer({ value, onChange, onSubmit, busy, placeholder }: ComposerProps) {
  // 服务端直出的这一版里 React 还没接管：原生 textarea 能打字，但 onChange 不会触发、
  // value 一直是空串，按 Enter 也没有处理函数。这段窗口要明说「正在载入」，
  // 否则界面看着能用、实际发不出去，会被当成功能坏了。
  const hydrated = useSyncExternalStore(subscribeHydration, hydratedOnClient, hydratedOnServer);
  const canSend = hydrated && !busy && value.trim().length > 0;
  return (
    <div className="blue-focus rounded-[20px] border border-[#bfd6ee] bg-white/95 p-2 shadow-[0_18px_50px_rgba(43,94,151,0.10)] backdrop-blur-xl">
      <Textarea
        aria-label="输入框"
        value={value}
        placeholder={placeholder}
        disabled={!hydrated}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          if (canSend) onSubmit();
        }}
        className="max-h-40 min-h-14 resize-none border-0 bg-transparent px-3 py-3 text-[15px] leading-6 text-[#21334d] shadow-none placeholder:text-[#9aadc3] focus-visible:ring-0"
      />
      <div className="flex items-center justify-between gap-3 px-2 pb-1.5">
        <span className="text-[12px] text-[#8397af]">{hydrated ? "Enter 发送 · Shift + Enter 换行" : "正在载入…"}</span>
        <Button
          type="button"
          size="icon"
          aria-label="发送"
          disabled={!canSend}
          onClick={onSubmit}
          className="size-11 rounded-xl bg-[#247cff] text-white shadow-[0_8px_20px_rgba(36,124,255,0.25)] transition hover:-translate-y-0.5 hover:bg-[#176bea] disabled:shadow-none"
        >
          <ArrowUp />
        </Button>
      </div>
    </div>
  );
}
