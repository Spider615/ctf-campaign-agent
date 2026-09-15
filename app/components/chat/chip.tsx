"use client";

import { Check } from "lucide-react";

export function Chip({ selected, disabled, onClick, children }: { selected: boolean; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`min-h-9 rounded-full border px-3.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9c6b2f] disabled:cursor-not-allowed disabled:opacity-55 ${
        selected ? "border-[#7a2134] bg-[#f6e9ec] font-medium text-[#651427]" : "border-[#ddd4ca] bg-white text-[#5f5256] hover:border-[#bda998]"
      }`}
    >
      {selected ? <Check className="mr-1 inline size-3.5" /> : null}
      {children}
    </button>
  );
}
