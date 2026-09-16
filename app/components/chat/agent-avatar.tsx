import { Sparkles } from "lucide-react";

export function AgentAvatar() {
  return (
    <span
      aria-label="活动搭建 Agent"
      className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl border border-[#c8ddff] bg-gradient-to-br from-[#e9f3ff] to-white text-[#247cff] shadow-[0_5px_14px_rgba(36,124,255,0.12)]"
    >
      <Sparkles className="size-4" aria-hidden="true" />
    </span>
  );
}
