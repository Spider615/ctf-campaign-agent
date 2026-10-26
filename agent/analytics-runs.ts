import type { AnalyticsStreamEvent } from "../app/lib/analytics/stream.ts";

// 直接问答按运行登记，运行不挂在某条连接上：浏览器刷新或断开只退订，分析继续跑完；
// 过程和结果在内存里保留一段时间，同一访问标识可以重新连上，从头补放再接着收。只有显式停止才中止。
// Agent 服务重启后登记丢失，重新连接得到「找不到」，由页面标为已中断。
type Listener = (event: AnalyticsStreamEvent) => void;
type Run = { owner: string; controller: AbortController; events: AnalyticsStreamEvent[]; done: boolean; listeners: Set<Listener>; timer?: ReturnType<typeof setTimeout> };
export type AnalyticsRunExecute = (signal: AbortSignal, emit: (event: AnalyticsStreamEvent) => void) => Promise<AnalyticsStreamEvent | null>;

export { ANALYTICS_RUN_ID } from "../app/lib/analytics/run-id.ts";
const STOPPED: AnalyticsStreamEvent = { type: "error", error: "本次回答已停止" };

export function createAnalyticsRuns({ retainMs = 30 * 60_000 }: { retainMs?: number } = {}) {
  const runs = new Map<string, Run>();
  const find = (id: string, owner: string) => { const run = runs.get(id); return run && run.owner === owner ? run : undefined; };
  const finish = (id: string, run: Run, terminal: AnalyticsStreamEvent) => {
    if (run.done) return;
    run.done = true; run.events.push(terminal);
    for (const listener of run.listeners) listener(terminal);
    run.listeners.clear();
    run.timer = setTimeout(() => { if (runs.get(id) === run) runs.delete(id); }, retainMs);
    run.timer.unref?.();
  };
  return {
    // 同一运行 id 只能开始一次，重复提交返回 false。
    start(id: string, owner: string, execute: AnalyticsRunExecute): boolean {
      if (runs.has(id)) return false;
      const run: Run = { owner, controller: new AbortController(), events: [], done: false, listeners: new Set() };
      runs.set(id, run);
      const emit = (event: AnalyticsStreamEvent) => {
        if (run.done) return;
        run.events.push(event);
        for (const listener of run.listeners) listener(event);
      };
      void execute(run.controller.signal, emit)
        .then((terminal) => finish(id, run, terminal ?? STOPPED), () => finish(id, run, STOPPED));
      return true;
    },
    has(id: string, owner: string) { return Boolean(find(id, owner)); },
    // 先补放已发生的全部事件，未结束时再接着推送；返回退订函数，找不到返回 null。
    subscribe(id: string, owner: string, listener: Listener): (() => void) | null {
      const run = find(id, owner); if (!run) return null;
      for (const event of [...run.events]) listener(event);
      if (run.done) return () => {};
      run.listeners.add(listener);
      return () => { run.listeners.delete(listener); };
    },
    cancel(id: string, owner: string): boolean {
      const run = find(id, owner); if (!run) return false;
      if (!run.done) { run.controller.abort(); finish(id, run, STOPPED); }
      return true;
    },
  };
}
export type AnalyticsRuns = ReturnType<typeof createAnalyticsRuns>;
