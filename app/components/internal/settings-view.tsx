"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { internalGet, internalPost } from "../../lib/internal/client";
import { CHANNEL_LABEL, timeText } from "../../lib/internal/format";
import type { InternalChannel } from "../../lib/internal/format";
import { DataTable, InternalShell, Notice, Panel } from "./internal-shell";
import { PagedRows } from "./pager";

type ChannelState = {
  active: InternalChannel;
  channels: Array<{ channel: InternalChannel; label: string; configured: boolean; active: boolean; model: string | null }>;
  history: Array<{ at: number; from: InternalChannel; to: InternalChannel; by: string }>;
};

// 模型渠道切换：切换后从下一轮问答起生效，已经在跑的回答不受影响；选择在重启和重新部署后保持。
export function SettingsView() {
  const [state, setState] = useState<ChannelState>();
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState<InternalChannel | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    internalGet<ChannelState>("channel", controller.signal).then(setState, (failure: Error) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, []);
  const choose = async (channel: InternalChannel) => {
    setBusy(channel); setError(""); setNotice("");
    try { setState(await internalPost<ChannelState>("channel", { channel })); setNotice(`已切换到${CHANNEL_LABEL[channel]}，下一轮问答起生效。`); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "切换失败"); }
    finally { setBusy(null); }
  };
  return (
    <InternalShell active="/internal/settings" title="设置">
      <div className="space-y-5">
        {!state && !error ? <Notice>正在读取…</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {notice ? <Notice>{notice}</Notice> : null}
        {state ? (
          <>
            <Panel title="模型渠道" note="切换后下一轮问答起生效，正在回答的不受影响；重启和重新部署后保持">
              <div className="grid gap-3 md:grid-cols-2">
                {state.channels.map((item) => (
                  <div key={item.channel} className={`rounded-xl border p-4 ${item.active ? "border-[#2470cc] bg-[#eaf4ff]" : "border-[#d9e7f6] bg-white"}`}>
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-[#20314d]">{item.label}</p>
                      {item.active ? <span className="rounded bg-[#2470cc] px-1.5 py-0.5 text-[12px] text-white">使用中</span> : null}
                      {!item.configured ? <span className="rounded bg-[#f1f7ff] px-1.5 py-0.5 text-[12px] text-[#71869f]">未配置</span> : null}
                    </div>
                    <p className="mt-1 text-[13px] text-[#637a95]">{item.configured ? <>模型 <span className="font-mono">{item.model}</span></> : "还没有配置 key，需要先在部署环境变量里配好"}</p>
                    <Button size="sm" className="mt-3" variant={item.active ? "outline" : "default"} disabled={item.active || !item.configured || busy !== null} onClick={() => { void choose(item.channel); }}>
                      {item.active ? "正在使用" : busy === item.channel ? "正在切换…" : "切换到这个渠道"}
                    </Button>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel title="切换记录" note="共用一个管理密码，操作人记为管理员">
              {state.history.length ? (
                <PagedRows rows={state.history} render={(pageRows) => (
                <DataTable head={["时间", "从", "切到", "操作人"]}>
                  {pageRows.map((item) => (
                    <tr key={item.at}>
                      <td className="whitespace-nowrap">{timeText(item.at)}</td>
                      <td>{CHANNEL_LABEL[item.from]}</td>
                      <td>{CHANNEL_LABEL[item.to]}</td>
                      <td>{item.by}</td>
                    </tr>
                  ))}
                </DataTable>
                )} />
              ) : <p className="text-[13px] text-[#71869f]">还没有切换过。</p>}
            </Panel>
          </>
        ) : null}
      </div>
    </InternalShell>
  );
}
