import { CircleAlert, CircleHelp, Sparkles, UserRound } from "lucide-react";

import type { Source } from "../lib/campaign/ics1811/types";

const CONFIG = {
  user: { label: "你说的", icon: UserRound, className: "bg-[#f0e9df] text-[#65564e]" },
  ai: { label: "AI 定", icon: Sparkles, className: "bg-[#f3e8d3] text-[#78531e]" },
  default: { label: "默认", icon: CircleAlert, className: "bg-[#e8eee9] text-[#4e6654]" },
  pending: { label: "待补", icon: CircleHelp, className: "bg-[#fbeee0] text-[#935321]" },
} as const;

// tbc：含义待确认（§9(四)）的 demo 默认值。
export function SourceBadge({ source, tbc = false }: { source: Source; tbc?: boolean }) {
  const config = CONFIG[source];
  const Icon = config.icon;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${tbc ? "bg-[#fbe8df] text-[#9a3f24]" : config.className}`}>
      <Icon className="size-3" aria-hidden="true" />
      {tbc ? `${config.label} · 待确认` : config.label}
    </span>
  );
}
