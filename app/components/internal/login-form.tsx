"use client";

import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { internalLogin } from "../../lib/internal/client";

export function LoginForm() {
  const params = useSearchParams();
  const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    const failure = await internalLogin(password).catch(() => "连不上服务，请稍后重试");
    setBusy(false);
    if (failure) { setError(failure); return; }
    const next = params.get("next");
    window.location.href = next?.startsWith("/internal/") ? next : "/internal/stats";
  };
  return (
    <div className="mx-auto mt-24 w-full max-w-[360px] px-4">
      <form onSubmit={submit} className="rounded-2xl border border-[#d6e6f7] bg-white/80 p-6 shadow-[0_14px_40px_rgba(43,94,151,0.07)]">
        <p className="text-[12px] font-semibold tracking-[0.12em] text-[#2470cc]">内部管理</p>
        <h1 className="mt-1 text-xl font-semibold text-[#20314d]">登录管理端</h1>
        <Input type="password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} placeholder="管理端密码" className="mt-5" />
        {error ? <p className="mt-2 text-sm text-[#b2443b]">{error}</p> : null}
        <Button type="submit" className="mt-4 w-full" disabled={busy || !password}>{busy ? "正在登录…" : "登录"}</Button>
      </form>
    </div>
  );
}
