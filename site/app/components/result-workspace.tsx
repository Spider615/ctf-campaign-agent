"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clipboard,
  Download,
  History,
  Loader2,
  MessageSquareText,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { calculateOrderCount } from "../lib/campaign/split-orders";
import type { CampaignDraft, DraftVersion, FieldDiff, IcsOrderDraft, PatchOperation, ValidationIssue } from "../lib/campaign/types";
import { SourceBadge } from "./source-badge";

export type PendingPatch = {
  instruction: string;
  nextDraft: CampaignDraft;
  orders: IcsOrderDraft[];
  issues: ValidationIssue[];
  ops: PatchOperation[];
  diffs: FieldDiff[];
};

type ResultWorkspaceProps = {
  draft: CampaignDraft;
  orders: IcsOrderDraft[];
  issues: ValidationIssue[];
  versions: DraftVersion[];
  saveState: "saved" | "local" | "saving";
  patchBusy: boolean;
  patchError: string;
  pendingPatch: PendingPatch | null;
  onBack: () => void;
  onRequestPatch: (instruction: string) => void;
  onApplyPatch: () => void;
  onCancelPatch: () => void;
  onRollback: (seq: number) => void;
};

const pathLabels: Record<string, string> = {
  "/brief/externalName": "对外传播名",
  "/brief/icsName": "ICS 开单名",
  "/brief/content": "活动内容",
  "/brief/slogan": "活动标语",
  "/offer/tiers/0/discountRate": "折扣率",
  "/offer/tiers/0/amountOff": "减免额",
  "/offer/tiers/0/thresholdAmount": "判断金额",
  "/schedule/batches/0/startDate": "开始日期",
  "/schedule/batches/0/endDate": "结束日期",
};

function displayValue(value: unknown) {
  if (value === null) return "未填写";
  if (value === undefined) return "不存在";
  if (Array.isArray(value)) return value.length ? value.join("、") : "空数组 []";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

export function ResultWorkspace({
  draft,
  orders,
  issues,
  versions,
  saveState,
  patchBusy,
  patchError,
  pendingPatch,
  onBack,
  onRequestPatch,
  onApplyPatch,
  onCancelPatch,
  onRollback,
}: ResultWorkspaceProps) {
  const [instruction, setInstruction] = useState("");
  const [copied, setCopied] = useState(false);
  const split = calculateOrderCount(draft);
  const blockers = issues.filter((entry) => entry.severity === "blocker");
  const blockedOrders = blockers.length || draft.unresolved.length ? orders.length : 0;
  const readyOrders = orders.length - blockedOrders;

  const copyChecklist = async () => {
    const text = orders.map((order) => [
      `ICS ${order.activitySequence}`,
      `活动名称：${order.name}`,
      `档期：${order.batch.startDate} 至 ${order.batch.endDate}`,
      `市场：${order.market}`,
      `渠道：${order.channel}`,
      `范围：${order.scopeUnit}`,
      `优惠：${order.offerTier.label}`,
    ].join("\n")).join("\n\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const downloadEvidence = () => {
    const blob = new Blob([JSON.stringify({ draft, orders, issues }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${draft.brief.icsName || "campaign"}-evidence.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="soft-in min-h-[calc(100vh-72px)] px-4 py-5 md:px-6">
      <div className="mx-auto max-w-[1360px]">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <button type="button" onClick={onBack} className="mb-2 inline-flex items-center gap-1.5 text-sm text-[#7d6f72] hover:text-[#651427]"><ArrowLeft className="size-4" /> 回到确认页</button>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-[-0.025em] text-[#2d1d22] md:text-3xl">{draft.brief.externalName || draft.title}</h1>
              <span className={`rounded-full px-2.5 py-1 text-[12px] font-medium ${saveState === "saved" ? "bg-[#e5f1e8] text-[#47704f]" : "bg-[#f5e6d3] text-[#8b5d25]"}`}>
                {saveState === "saving" ? "正在保存" : saveState === "saved" ? "已保存版本" : "仅保存在当前页面"}
              </span>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={copyChecklist} className="h-10 bg-white"><Clipboard />{copied ? "已复制" : "复制清单"}</Button>
            <Button variant="outline" onClick={downloadEvidence} className="h-10 bg-white"><Download />下载证据包</Button>
            <Sheet>
              <SheetTrigger asChild><Button variant="outline" className="h-10 bg-white"><History />版本 {versions.length}</Button></SheetTrigger>
              <SheetContent className="w-full overflow-y-auto bg-[#fffdfa] sm:max-w-md">
                <SheetHeader className="border-b px-5 py-5"><SheetTitle>版本记录</SheetTitle><SheetDescription>每次修改都是不可变快照，可随时恢复。</SheetDescription></SheetHeader>
                <div className="space-y-3 p-5">
                  {[...versions].reverse().map((version, index) => (
                    <div key={`${version.seq}-${version.createdAt}`} className="rounded-xl border bg-white p-4">
                      <div className="flex items-center justify-between gap-3"><strong className="text-sm">版本 {version.seq}</strong><span className="text-[12px] text-[#8a7e80]">{index === 0 ? "当前" : new Date(version.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span></div>
                      <p className="mt-2 text-sm leading-5 text-[#6f6265]">{version.reason}</p>
                      <p className="mt-2 text-[12px] text-[#928689]">{version.source === "ai" ? "对话修改" : version.source === "rollback" ? "版本恢复" : "人工确认"} · {version.diffs.length} 处变化</p>
                      {index !== 0 ? <Button variant="ghost" size="sm" onClick={() => onRollback(version.seq)} className="mt-2 px-0 text-[#651427]"><RotateCcw />恢复此版本</Button> : null}
                    </div>
                  ))}
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>

        <section className={`mb-5 rounded-2xl border p-5 md:p-6 ${split.total === 0 ? "border-[#cbb99f] bg-[#f5ede1]" : "border-[#d8c8bd] bg-[#fffdfa]"}`}>
          {split.total === 0 ? (
            <div className="flex gap-4"><ShieldCheck className="mt-1 size-7 text-[#8b6330]" /><div><p className="text-xl font-semibold text-[#412d21]">本次不建 ICS 单</p><p className="mt-2 text-sm leading-6 text-[#736150]">顾客动作只到“只看到”。成交规则不应硬塞进 ICS，报名、互动与到场交给 CRM 或活动系统。</p></div></div>
          ) : (
            <div className="grid grid-cols-[auto_1fr_auto] items-center gap-5 max-md:grid-cols-1">
              <div><span className="text-[13px] text-[#8e7f82]">需要拆成</span><div className="mt-1 flex items-end gap-2"><strong className="text-5xl font-semibold tracking-[-0.05em] text-[#651427]">{split.total}</strong><span className="pb-1 text-sm text-[#75676a]">条 ICS 单</span></div></div>
              <div className="border-x border-[#e7ded5] px-5 max-md:border-x-0 max-md:border-y max-md:py-4"><p className="text-sm font-medium text-[#49373c]">{split.factors.batches} 批次 × {split.factors.markets} 市场 × {split.factors.channels} 渠道 × {split.factors.scopeUnits} 范围 × {split.factors.offerTiers} 档优惠</p><p className="mt-1.5 text-[13px] text-[#84777a]">拆单由表单确定，模型不参与计算。</p></div>
              <div className="min-w-36 space-y-2 text-sm"><div className="flex justify-between gap-5"><span className="text-[#7c7072]">字段已齐</span><strong className="text-[#47704f]">{readyOrders} 条</strong></div><div className="flex justify-between gap-5"><span className="text-[#7c7072]">等待确认</span><strong className="text-[#a15a24]">{blockedOrders} 条</strong></div></div>
            </div>
          )}
        </section>

        <div className="grid grid-cols-[minmax(0,1fr)_330px] items-start gap-5 max-xl:grid-cols-1">
          <Tabs defaultValue="brief" className="rounded-2xl border border-[#ded5cb] bg-[#fffdfa] p-4 md:p-6">
            <TabsList variant="line" className="mb-5 flex w-full justify-start border-b border-[#e4dbd2] pb-3">
              <TabsTrigger value="brief" className="flex-none px-3">活动方案</TabsTrigger>
              <TabsTrigger value="ics" className="flex-none px-3">ICS 开单清单 <span className="rounded-full bg-[#eee6dc] px-1.5 text-[11px]">{orders.length}</span></TabsTrigger>
              <TabsTrigger value="pending" className="flex-none px-3">待界面选择 <span className="rounded-full bg-[#f3dfca] px-1.5 text-[11px]">{draft.unresolved.length}</span></TabsTrigger>
              <TabsTrigger value="validation" className="flex-none px-3">校验结果</TabsTrigger>
            </TabsList>

            <TabsContent value="brief">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-xl bg-[#f7f2eb] p-5 md:col-span-2"><p className="text-[12px] font-medium uppercase tracking-[0.12em] text-[#9a7442]">活动主张</p><h2 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-[#38242a]">{draft.brief.slogan || "未生成"}</h2><p className="mt-3 text-[15px] leading-7 text-[#6d6063]">{draft.brief.content || "活动内容未生成"}</p></div>
                <div className="rounded-xl border p-4"><p className="text-[13px] text-[#8b7f81]">对外传播名</p><p className="mt-2 font-semibold text-[#3f2d32]">{draft.brief.externalName || "未生成"}</p><div className="mt-3"><SourceBadge field={{ value: draft.brief.externalName, provenance: "ai" }} /></div></div>
                <div className="rounded-xl border p-4"><p className="text-[13px] text-[#8b7f81]">ICS 开单名</p><p className="mt-2 font-semibold text-[#3f2d32]">{draft.brief.icsName || "未生成"}</p><div className="mt-3"><SourceBadge field={{ value: draft.brief.icsName, provenance: "ai" }} /></div></div>
                <div className="rounded-xl border p-4"><p className="text-[13px] text-[#8b7f81]">活动由头</p><p className="mt-2 font-medium">{draft.intent.occasion.value} · {draft.intent.reason || "未填写"}</p><div className="mt-3"><SourceBadge field={draft.intent.occasion} /></div></div>
                <div className="rounded-xl border p-4"><p className="text-[13px] text-[#8b7f81]">目标与衡量</p><p className="mt-2 font-medium">{draft.metric.name || "未填写"}{draft.metric.target === null ? " · 目标值未填" : ` · ${draft.metric.target}`}</p></div>
              </div>
            </TabsContent>

            <TabsContent value="ics">
              {orders.length ? (
                <div className="overflow-x-auto rounded-xl border">
                  <Table>
                    <TableHeader><TableRow className="bg-[#f6f1ea]"><TableHead>序号</TableHead><TableHead>档期</TableHead><TableHead>市场 / 渠道</TableHead><TableHead>范围</TableHead><TableHead>优惠规则</TableHead><TableHead>状态</TableHead></TableRow></TableHeader>
                    <TableBody>{orders.map((order) => <TableRow key={order.id}><TableCell className="font-mono text-[13px]">{order.activitySequence}</TableCell><TableCell className="min-w-44">{order.batch.startDate}<br/><span className="text-[#918588]">至 {order.batch.endDate}</span></TableCell><TableCell>{order.market}<br/><span className="text-[#918588]">{order.channel}</span></TableCell><TableCell className="min-w-48">{order.scopeUnit}</TableCell><TableCell>{order.offerTier.label}</TableCell><TableCell><span className={`inline-flex rounded-full px-2 py-1 text-[12px] ${order.status === "ready" ? "bg-[#e5f1e8] text-[#47704f]" : "bg-[#f6e5d5] text-[#935321]"}`}>{order.status === "ready" ? "字段已齐" : "待确认"}</span></TableCell></TableRow>)}</TableBody>
                  </Table>
                </div>
              ) : <div className="rounded-xl bg-[#f5eee4] p-8 text-center text-[#6f5b49]">本次活动不生成 ICS 开单草稿。</div>}
              <p className="mt-4 text-[12px] text-[#8e8184]">1816 核对表仅供核对，不可上传。</p>
            </TabsContent>

            <TabsContent value="pending">
              <div className="space-y-3">{draft.unresolved.length ? draft.unresolved.map((item, index) => <div key={item} className="flex gap-3 rounded-xl border border-[#ead7c4] bg-[#fcf5ec] p-4"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#9c642b] text-[12px] text-white">{index + 1}</span><div><p className="text-sm font-medium text-[#5a4030]">{item}</p><p className="mt-1 text-[12px] text-[#8a7567]">以 2026 年生产界面为准，Agent 不猜内部码。</p></div></div>) : <div className="flex items-center gap-2 rounded-xl bg-[#eaf3ec] p-4 text-sm text-[#47704f]"><CheckCircle2 className="size-4" />没有待界面选择的字段</div>}</div>
            </TabsContent>

            <TabsContent value="validation">
              <div className="mb-4 flex items-center gap-2 rounded-xl bg-[#eaf3ec] p-4 text-sm font-medium text-[#47704f]"><ShieldCheck className="size-4" />已执行 17 条确定性规则 · {blockers.length} 条阻断</div>
              <div className="space-y-2">{issues.length ? issues.map((entry, index) => <div key={`${entry.ruleId}-${entry.path}-${index}`} className={`flex gap-3 rounded-xl border p-4 ${entry.severity === "blocker" ? "border-[#efc8bb] bg-[#fff2ec]" : "border-[#ead7c4] bg-[#fcf5ec]"}`}><AlertTriangle className={`mt-0.5 size-4 shrink-0 ${entry.severity === "blocker" ? "text-[#a33a25]" : "text-[#9c642b]"}`} /><div><p className="text-sm font-medium">{entry.ruleId} · {entry.message}</p><code className="mt-1 block text-[12px] text-[#8c7d80]">{entry.path}</code></div></div>) : <p className="rounded-xl border p-5 text-sm text-[#667469]">没有发现规则冲突。</p>}</div>
            </TabsContent>
          </Tabs>

          <aside className="sticky top-5 rounded-2xl border border-[#d7cdc3] bg-[#fffdfa] p-5 shadow-[0_16px_45px_rgba(65,32,39,0.06)] max-xl:static">
            <div className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-lg bg-[#f1e5d4] text-[#7b5525]"><Sparkles className="size-4" /></span><div><h2 className="font-semibold text-[#3b2930]">继续修改</h2><p className="text-[12px] text-[#8c7f82]">只改你点名的字段</p></div></div>
            <Textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：把活动名改得更克制，优惠保持不变" className="mt-4 min-h-28 resize-none bg-white text-sm leading-6" />
            {patchError ? <p role="alert" className="mt-3 rounded-lg bg-[#fff0eb] p-3 text-[13px] leading-5 text-[#983523]">{patchError}</p> : null}
            <Button onClick={() => onRequestPatch(instruction)} disabled={patchBusy || !instruction.trim()} className="mt-3 h-10 w-full"><>{patchBusy ? <Loader2 className="animate-spin" /> : <MessageSquareText />}</>{patchBusy ? "正在检查修改" : "预览修改"}</Button>

            {pendingPatch ? (
              <div className="mt-4 rounded-xl border border-[#d9c4a5] bg-[#faf2e5] p-4">
                <div className="flex items-center justify-between"><p className="text-sm font-semibold text-[#513b29]">修改预览</p><button type="button" aria-label="关闭修改预览" onClick={onCancelPatch}><X className="size-4 text-[#8b7767]" /></button></div>
                <div className="mt-3 space-y-3">{pendingPatch.diffs.map((diff) => <div key={diff.path} className="text-[13px]"><p className="font-medium text-[#4d383d]">{pathLabels[diff.path] || diff.path}</p><p className="mt-1 line-through text-[#9a8d8f]">{displayValue(diff.before)}</p><p className="mt-0.5 text-[#651427]">→ {displayValue(diff.after)}</p></div>)}</div>
                <div className="mt-4 flex gap-2"><Button variant="outline" onClick={onCancelPatch} className="flex-1 bg-white">取消</Button><Button onClick={onApplyPatch} className="flex-1"><Check />应用</Button></div>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}

