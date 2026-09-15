import { CircleAlert, Sparkles, UserRound } from "lucide-react";

import type { FieldValue } from "../lib/campaign/types";

export function SourceBadge({ field }: { field: FieldValue<unknown> }) {
  const config = {
    user: { label: "你提供的", icon: UserRound, className: "bg-[#f0e9df] text-[#65564e]" },
    ai: { label: "AI 理解", icon: Sparkles, className: "bg-[#f3e8d3] text-[#78531e]" },
    default: { label: "系统默认", icon: CircleAlert, className: "bg-[#e8eee9] text-[#4e6654]" },
    pending: { label: "待界面选择", icon: CircleAlert, className: "bg-[#fbe8df] text-[#9a3f24]" },
  }[field.provenance];
  const Icon = config.icon;

  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium ${config.className}`}>
      <Icon className="size-3" aria-hidden="true" />
      {config.label}
      {field.vintage ? ` · ${field.vintage.year}` : ""}
    </span>
  );
}

