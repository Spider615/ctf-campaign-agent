"use client";

import { AgentRow } from "./message-view";

export function ThinkingIndicator({ label, continued = false }: { label: string; continued?: boolean }) {
  return (
    <AgentRow continued={continued}>
      <div role="status" aria-live="polite" className="inline-flex items-center gap-3 rounded-2xl border border-[#c9ddf6] bg-white/80 px-4 py-3 shadow-[0_10px_28px_rgba(36,124,255,0.08)]">
        <span className="flex h-4 items-center gap-1" aria-hidden="true">
          <span className="thinking-wave-dot size-1.5 rounded-full bg-[#247cff]" style={{ animationDelay: "-240ms" }} />
          <span className="thinking-wave-dot size-1.5 rounded-full bg-[#5b9cff]" style={{ animationDelay: "-120ms" }} />
          <span className="thinking-wave-dot size-1.5 rounded-full bg-[#8dc0ff]" style={{ animationDelay: "0ms" }} />
        </span>
        <span className="text-sm text-[#59718d]">{label}…</span>
      </div>
    </AgentRow>
  );
}
