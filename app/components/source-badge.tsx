import { CircleAlert, CircleHelp, Sparkles, UserRound } from "lucide-react";

import type { FieldValue } from "../lib/campaign/types";

const CONFIG = {
  user: { label: "你说的", icon: UserRound, className: "bg-[#f0e9df] text-[#65564e]" },
  ai: { label: "AI 推断", icon: Sparkles, className: "bg-[#f3e8d3] text-[#78531e]" },
  default: { label: "系统默认", icon: CircleAlert, className: "bg-[#e8eee9] text-[#4e6654]" },
  suggested: { label: "待你确认", icon: CircleHelp, className: "bg-[#fbe8df] text-[#9a3f24]" },
  pending: { label: "待补", icon: CircleAlert, className: "bg-[#fbeee0] text-[#935321]" },
} as const;

export function SourceBadge({ field }: { field: FieldValue<unknown> }) {
  const key = field.provenance === "pending" ? (field.suggested ? "suggested" : "pending") : field.provenance;
  const config = CONFIG[key];
  const Icon = config.icon;

  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${config.className}`}>
      <Icon className="size-3" aria-hidden="true" />
      {config.label}
    </span>
  );
}
