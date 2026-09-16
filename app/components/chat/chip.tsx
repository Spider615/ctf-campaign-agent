"use client";

import { Check } from "lucide-react";

export function Chip({ selected, disabled, onClick, children }: { selected: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`min-h-11 rounded-full border px-3.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#247cff] disabled:cursor-not-allowed disabled:opacity-55 ${
        selected ? "border-[#78adf8] bg-[#e9f3ff] font-medium text-[#1769c5]" : "border-[#cfdeee] bg-white text-[#536b87] hover:border-[#8dbafa] hover:bg-[#f5f9ff]"
      }`}
    >
      {selected ? <Check className="mr-1 inline size-3.5" /> : null}
      {children}
    </button>
  );
}
