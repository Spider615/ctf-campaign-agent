"use client";

import {
  Archive,
  ChevronRight,
  CircleHelp,
  FileText,
  LayoutGrid,
  Menu,
  Plus,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { createMotherDaySeed } from "../lib/campaign/demo-seeds";
import { diffDrafts, rollbackTo } from "../lib/campaign/patcher";
import { buildIcsDrafts } from "../lib/campaign/split-orders";
import type { CampaignDraft, DraftVersion, IcsOrderDraft, ValidationIssue } from "../lib/campaign/types";
import { validateDraft } from "../lib/campaign/validator";
import { mergeInterpretation, rehydrateSessionVersions, type SavedVersionRecord } from "../lib/campaign/workspace-state";
import { registerCampaignTools, type CampaignWebMcpActions } from "../lib/webmcp";
import { ResultWorkspace, type PendingPatch } from "./result-workspace";
import { ReviewForm } from "./review-form";
import { type EntryMode, StartPanel } from "./start-panel";

type Stage = "start" | "review" | "result";

type RecentSession = {
  id: string;
  title: string;
  updated_at: string;
  status: string;
  versionCount: number;
};

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "请求失败，请重试");
  return body;
}

export function CampaignAgent() {
  const [stage, setStage] = useState<Stage>("start");
  const [prompt, setPrompt] = useState("下个月华东区做个母亲节满 3000 减 300 的线下活动");
  const [draft, setDraft] = useState<CampaignDraft | null>(null);
  const [orders, setOrders] = useState<IcsOrderDraft[]>([]);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [versions, setVersions] = useState<DraftVersion[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "local" | "saving">("local");
  const [patchBusy, setPatchBusy] = useState(false);
  const [patchError, setPatchError] = useState("");
  const [pendingPatch, setPendingPatch] = useState<PendingPatch | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const webMcpActionsRef = useRef<CampaignWebMcpActions | null>(null);

  useEffect(() => {
    void fetch("/api/sessions")
      .then((response) => responseJson<{ sessions: RecentSession[] }>(response))
      .then((body) => setRecentSessions(body.sessions))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [stage]);

  const beginWithSeed = (mode: EntryMode) => {
    if (mode === "new") {
      setStage("start");
      setPrompt("");
      setError("");
      return;
    }
    const next = createMotherDaySeed();
    next.id = crypto.randomUUID();
    if (mode === "copy") {
      next.title = `${next.title} · 副本`;
      next.brief.externalName = `${next.brief.externalName} · 新档期`;
    }
    if (mode === "rejected") {
      next.title = "母亲节活动 · 审批退回";
      next.unresolved = ["审批退回：活动日期与付款方式需修正", ...next.unresolved];
    }
    setDraft(next);
    setOrders([]);
    setIssues([]);
    setVersions([]);
    setSessionId(null);
    setSaveState("local");
    setError("");
    setStage("review");
  };

  const interpret = async () => {
    if (prompt.trim().length < 4) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/agent/interpret", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: prompt.trim() }),
      });
      const interpretation = await responseJson<Parameters<typeof mergeInterpretation>[1]>(response);
      setDraft(mergeInterpretation(prompt.trim(), interpretation));
      setStage("review");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "活动理解失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const openRecentSession = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      const body = await responseJson<{ versions: SavedVersionRecord[] }>(await fetch(`/api/sessions/${id}`));
      const records = body.versions;
      const latest = records.at(-1);
      if (!latest) throw new Error("活动还没有可打开的版本");
      setDraft(latest.draft);
      setOrders(latest.orders);
      setIssues(validateDraft(latest.draft, latest.orders));
      setVersions(rehydrateSessionVersions(records));
      setSessionId(id);
      setSaveState("saved");
      setStage("result");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "活动打开失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const preliminaryOrders = buildIcsDrafts(draft);
      const preliminaryIssues = validateDraft(draft, preliminaryOrders);
      if (preliminaryIssues.some((entry) => entry.severity === "blocker")) {
        setIssues(preliminaryIssues);
        throw new Error("还有字段违反 ICS 规则，请按提示修正");
      }
      const response = await fetch("/api/agent/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft }),
      });
      const copy = await responseJson<CampaignDraft["brief"]>(response);
      const nextDraft = structuredClone(draft) as CampaignDraft;
      nextDraft.brief = copy;
      const nextOrders = buildIcsDrafts(nextDraft);
      const nextIssues = validateDraft(nextDraft, nextOrders);
      const initialVersion: DraftVersion = {
        seq: 1,
        draft: structuredClone(nextDraft),
        source: "human",
        reason: "确认表单并生成方案",
        createdAt: new Date().toISOString(),
        diffs: [],
      };
      setDraft(nextDraft);
      setOrders(nextOrders);
      setIssues(nextIssues);
      setVersions([initialVersion]);
      setStage("result");
      setSaveState("saving");

      try {
        const saved = await responseJson<{ session?: { id?: string } }>(await fetch("/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ draft: nextDraft, orders: nextOrders, entryMode: "new", firstMessage: prompt }),
        }));
        setSessionId(saved.session?.id ?? null);
        setSaveState(saved.session?.id ? "saved" : "local");
      } catch {
        setSaveState("local");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "活动方案生成失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const requestPatch = async (instruction: string) => {
    if (!draft) return;
    setPatchBusy(true);
    setPatchError("");
    try {
      const body = await responseJson<{
        ops: PendingPatch["ops"];
        nextDraft: CampaignDraft;
        orders: IcsOrderDraft[];
        issues: ValidationIssue[];
      }>(await fetch("/api/agent/patch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft, instruction }),
      }));
      setPendingPatch({
        instruction,
        ops: body.ops,
        nextDraft: body.nextDraft,
        orders: body.orders,
        issues: body.issues,
        diffs: diffDrafts(draft, body.nextDraft),
      });
    } catch (caught) {
      setPatchError(caught instanceof Error ? caught.message : "修改失败，请重试");
    } finally {
      setPatchBusy(false);
    }
  };

  const persistVersion = async (version: DraftVersion, nextOrders: IcsOrderDraft[], ops?: PendingPatch["ops"]) => {
    if (!sessionId) return;
    try {
      await responseJson(await fetch(`/api/sessions/${sessionId}/versions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft: version.draft, orders: nextOrders, source: version.source, reason: version.reason, ops, message: version.reason }),
      }));
      setSaveState("saved");
    } catch {
      setSaveState("local");
    }
  };

  const applyPendingPatch = () => {
    if (!draft || !pendingPatch) return;
    const version: DraftVersion = {
      seq: (versions.at(-1)?.seq ?? 0) + 1,
      draft: structuredClone(pendingPatch.nextDraft),
      source: "ai",
      reason: pendingPatch.instruction,
      createdAt: new Date().toISOString(),
      diffs: pendingPatch.diffs,
    };
    setDraft(pendingPatch.nextDraft);
    setOrders(pendingPatch.orders);
    setIssues(pendingPatch.issues);
    setVersions((current) => [...current, version]);
    setPendingPatch(null);
    setSaveState(sessionId ? "saving" : "local");
    void persistVersion(version, pendingPatch.orders, pendingPatch.ops);
  };

  const rollback = (seq: number) => {
    if (!draft) return;
    const version = rollbackTo(versions, seq);
    const nextOrders = buildIcsDrafts(version.draft);
    setDraft(version.draft);
    setOrders(nextOrders);
    setIssues(validateDraft(version.draft, nextOrders));
    setVersions((current) => [...current, version]);
    setSaveState(sessionId ? "saving" : "local");
    void persistVersion(version, nextOrders);
  };

  useEffect(() => {
    webMcpActionsRef.current = {
      startCampaign: ({ mode, prompt: nextPrompt }) => {
        beginWithSeed(mode === "example" ? "example" : "new");
        if (nextPrompt !== undefined) setPrompt(nextPrompt);
        return mode === "example" ? "已打开母亲节完整演示草稿。" : "已打开新建活动输入页。";
      },
      updateFields: (updates) => {
        if (!draft) return "当前没有活动草稿，请先调用 start_campaign_draft。";
        const nextDraft = structuredClone(draft) as CampaignDraft;
        if (updates.title !== undefined) nextDraft.title = updates.title;
        if (updates.externalName !== undefined) nextDraft.brief.externalName = updates.externalName;
        if (updates.content !== undefined) nextDraft.brief.content = updates.content;
        if (updates.slogan !== undefined) nextDraft.brief.slogan = updates.slogan;
        if (updates.startDate !== undefined) nextDraft.schedule.batches[0].startDate = updates.startDate;
        if (updates.endDate !== undefined) nextDraft.schedule.batches[0].endDate = updates.endDate;
        const nextOrders = buildIcsDrafts(nextDraft);
        setDraft(nextDraft);
        setOrders(nextOrders);
        setIssues(validateDraft(nextDraft, nextOrders));
        return "已更新当前活动草稿，并重新计算拆单与校验结果。";
      },
      readSummary: () => ({
        stage,
        title: draft?.brief.externalName || draft?.title || null,
        orderCount: draft ? buildIcsDrafts(draft).length : 0,
        unresolved: draft?.unresolved ?? [],
        blockers: issues.filter((entry) => entry.severity === "blocker").map((entry) => entry.message),
      }),
    };
  });

  useEffect(() => registerCampaignTools({
    startCampaign: (input) => webMcpActionsRef.current!.startCampaign(input),
    updateFields: (input) => webMcpActionsRef.current!.updateFields(input),
    readSummary: () => webMcpActionsRef.current!.readSummary(),
  }), []);

  return (
    <main className="min-h-screen bg-transparent text-[#2f2226]">
      <header className="sticky top-0 z-40 flex h-[72px] items-center border-b border-[#ded5cb] bg-[#fffdfa]/92 px-4 backdrop-blur-xl md:hidden">
        <button type="button" aria-label="打开导航" onClick={() => setMobileNav(true)} className="mr-3 grid size-10 place-items-center rounded-lg hover:bg-[#f2ece5]"><Menu /></button>
        <Brand />
      </header>
      <div className="grid min-h-screen grid-cols-[230px_minmax(0,1fr)] max-md:block">
        <aside className={`fixed inset-y-0 left-0 z-50 flex w-[230px] flex-col bg-[#4a0c1b] text-white transition-transform md:sticky md:top-0 md:translate-x-0 ${mobileNav ? "translate-x-0" : "-translate-x-full"}`}>
          <div className="flex h-[88px] items-center justify-between border-b border-white/10 px-5"><Brand inverted /><button type="button" aria-label="关闭导航" onClick={() => setMobileNav(false)} className="grid size-9 place-items-center rounded-lg hover:bg-white/10 md:hidden"><X /></button></div>
          <nav className="flex-1 p-3" aria-label="主导航">
            <p className="px-3 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#caaeb5]">活动工作台</p>
            <NavItem active icon={LayoutGrid} label="营销活动" onClick={() => { setStage("start"); setMobileNav(false); }} />
            <NavItem icon={FileText} label="ICS 草稿" />
            <NavItem icon={Archive} label="历史版本" />
            <p className="px-3 pb-2 pt-7 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#caaeb5]">系统</p>
            <NavItem icon={Settings} label="码表与证据" />
            <NavItem icon={CircleHelp} label="待确认事项" />
          </nav>
          <div className="m-3 rounded-xl border border-white/10 bg-white/5 p-4"><div className="flex items-center gap-2 text-sm font-medium text-[#f4e9ec]"><Sparkles className="size-4 text-[#d9b36b]" />DeepSeek V4.1 Flash</div><p className="mt-2 text-[12px] leading-5 text-[#cbb6bc]">模型写文案，规则由代码校验。</p></div>
        </aside>

        <section className="min-w-0">
          <div className="hidden h-[72px] items-center justify-between border-b border-[#ded5cb] bg-[#fffdfa]/75 px-6 backdrop-blur md:flex">
            <div className="flex items-center gap-2 text-sm text-[#887c7f]"><span>营销活动</span>{stage !== "start" ? <><ChevronRight className="size-4" /><span className="text-[#45353a]">{stage === "review" ? "确认需求" : "活动结果"}</span></> : null}</div>
            <Button variant="outline" size="sm" onClick={() => beginWithSeed("new")} className="bg-white"><Plus />新建活动</Button>
          </div>

          {stage === "start" ? <StartPanel prompt={prompt} onPromptChange={setPrompt} onSubmit={interpret} onEntry={beginWithSeed} onOpenRecent={openRecentSession} busy={busy} error={error} recentSessions={recentSessions} /> : null}
          {stage === "review" && draft ? <ReviewForm draft={draft} onChange={setDraft} onBack={() => setStage("start")} onGenerate={generate} busy={busy} error={error} /> : null}
          {stage === "result" && draft ? <ResultWorkspace draft={draft} orders={orders} issues={issues} versions={versions} saveState={saveState} patchBusy={patchBusy} patchError={patchError} pendingPatch={pendingPatch} onBack={() => setStage("review")} onRequestPatch={requestPatch} onApplyPatch={applyPendingPatch} onCancelPatch={() => setPendingPatch(null)} onRollback={rollback} /> : null}
        </section>
      </div>
      {mobileNav ? <button type="button" aria-label="关闭导航遮罩" onClick={() => setMobileNav(false)} className="fixed inset-0 z-40 bg-black/35 md:hidden" /> : null}
    </main>
  );
}

function Brand({ inverted = false }: { inverted?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className={`grid size-9 place-items-center rounded-xl border ${inverted ? "border-[#b98152] bg-[#61172a]" : "border-[#d5c3ad] bg-[#f2e6d5]"}`}><span className={`text-lg font-semibold ${inverted ? "text-[#e1b76e]" : "text-[#651427]"}`}>周</span></span>
      <div><p className={`text-sm font-semibold tracking-wide ${inverted ? "text-white" : "text-[#3c2930]"}`}>周大福</p><p className={`text-[11px] ${inverted ? "text-[#c8aeb5]" : "text-[#8e8083]"}`}>营销活动 Agent</p></div>
    </div>
  );
}

function NavItem({ icon: Icon, label, active = false, onClick }: { icon: typeof LayoutGrid; label: string; active?: boolean; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`mb-1 flex h-11 w-full items-center gap-3 rounded-xl px-3 text-sm transition ${active ? "bg-[#7a1d32] font-medium text-white shadow-inner" : "text-[#d7c4c9] hover:bg-white/8 hover:text-white"}`}>
      <Icon className={`size-4 ${active ? "text-[#e2bb77]" : "text-[#b99fa6]"}`} />{label}
    </button>
  );
}
