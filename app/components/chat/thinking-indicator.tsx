"use client";

import { AgentRow } from "./message-view";

export function ThinkingIndicator({ label }: { label: string }) {
  return (
    <AgentRow>
      <div role="status" aria-live="polite" className="inline-flex items-center gap-3 rounded-2xl border border-[#e1d6ca] bg-[#fffdfa] px-4 py-3 shadow-[0_8px_24px_rgba(65,32,39,0.04)]">
        <span className="flex h-4 items-end gap-1" aria-hidden="true">
          <span className="size-1.5 animate-bounce rounded-full bg-[#9c6b2f] [animation-delay:-0.3s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-[#b8894e] [animation-delay:-0.15s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-[#d2a85e]" />
        </span>
        <span className="text-sm text-[#6d5d5f]">{label}…</span>
      </div>
    </AgentRow>
  );
}
