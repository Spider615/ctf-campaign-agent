"use client";

import { ArrowUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  placeholder: string;
};

// 等待状态由对话里的思考动画表达，输入框只负责禁用发送。
export function Composer({ value, onChange, onSubmit, busy, placeholder }: ComposerProps) {
  const canSend = !busy && value.trim().length > 0;
  return (
    <div className="rounded-2xl border border-[#cfc3b6] bg-[#fffdfa] p-2 shadow-[0_12px_40px_rgba(57,24,31,0.06)] focus-within:border-[#a98452]">
      <Textarea
        aria-label="输入框"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          if (canSend) onSubmit();
        }}
        className="max-h-40 min-h-12 resize-none border-0 bg-transparent px-3 py-2.5 text-[15px] leading-6 shadow-none focus-visible:ring-0"
      />
      <div className="flex items-center justify-between gap-3 px-2 pb-1">
        <span className="text-[12px] text-[#9a8d8f]">Enter 发送，Shift + Enter 换行</span>
        <Button
          type="button"
          size="icon"
          aria-label="发送"
          disabled={!canSend}
          onClick={onSubmit}
          className="size-9 rounded-xl bg-[#651427] text-white hover:bg-[#791a30]"
        >
          <ArrowUp />
        </Button>
      </div>
    </div>
  );
}
