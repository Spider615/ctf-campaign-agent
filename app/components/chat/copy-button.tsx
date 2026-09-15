"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 剪贴板权限被拒时退回旧方法。
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  return copied;
}

export function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    const copied = await writeClipboard(text);
    setState(copied ? "copied" : "failed");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1500);
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={state === "copied" ? "已复制" : "复制消息"}
      className={`inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-[#9a8d8f] transition hover:bg-[#efe8df] hover:text-[#651427] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9c6b2f] ${className}`}
    >
      {state === "copied" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {state === "copied" ? "已复制" : state === "failed" ? "复制失败" : "复制"}
    </button>
  );
}
