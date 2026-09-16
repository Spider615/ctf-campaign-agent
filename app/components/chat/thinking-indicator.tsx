"use client";

import { AgentRow } from "./message-view";

export function ThinkingIndicator({ label }: { label: string }) {
  return (
    <AgentRow>
      <div role="status" aria-live="polite" className="inline-flex items-center gap-3 rounded-2xl border border-[#c9ddf6] bg-white/80 px-4 py-3 shadow-[0_10px_28px_rgba(36,124,255,0.08)]">
        <span className="flex h-4 items-end gap-1" aria-hidden="true">
          <span className="size-1.5 animate-bounce rounded-full bg-[#247cff] [animation-delay:-0.3s] motion-reduce:animate-none" />
          <span className="size-1.5 animate-bounce rounded-full bg-[#5b9cff] [animation-delay:-0.15s] motion-reduce:animate-none" />
          <span className="size-1.5 animate-bounce rounded-full bg-[#8dc0ff] motion-reduce:animate-none" />
        </span>
        <span className="text-sm text-[#59718d]">{label}…</span>
      </div>
    </AgentRow>
  );
}
