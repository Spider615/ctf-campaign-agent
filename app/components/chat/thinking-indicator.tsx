"use client";

import { AgentRow } from "./message-view";

// 等待时只留三个圆点：文字和白色卡片会跟正文抢注意力，而这一行本来就是临时的。
// 说明文字改成只给读屏软件，视觉上不出现——看不见不等于不播报。
// py-2.5 让 h-4 的圆点行落在 size-8 头像的竖直中线上。
export function ThinkingIndicator({ label, continued = false }: { label: string; continued?: boolean }) {
  return (
    <AgentRow continued={continued}>
      <div role="status" aria-live="polite" className="inline-flex items-center py-2.5">
        <span className="flex h-4 items-center gap-1" aria-hidden="true">
          <span className="thinking-wave-dot size-1.5 rounded-full bg-[#247cff]" style={{ animationDelay: "-240ms" }} />
          <span className="thinking-wave-dot size-1.5 rounded-full bg-[#5b9cff]" style={{ animationDelay: "-120ms" }} />
          <span className="thinking-wave-dot size-1.5 rounded-full bg-[#8dc0ff]" style={{ animationDelay: "0ms" }} />
        </span>
        <span className="sr-only">{label}…</span>
      </div>
    </AgentRow>
  );
}
