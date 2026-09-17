"use client";

import { AlertTriangle, CheckCircle2, Info, PencilLine, RotateCcw, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { factText } from "../../lib/campaign/ics1811/messages";
import { draftCompletion } from "../../lib/campaign/ics1811/progress";
import { QUESTION_TITLE } from "../../lib/campaign/ics1811/questions";
import { highlightedFields, recentlyFilled } from "../../lib/campaign/ics1811/recent-fill";
import type { FactKey, Gap, QuestionId } from "../../lib/campaign/ics1811/types";
import type { Snapshot } from "../../lib/server/turns";
import { initialRaw, QuestionControl, toAnswer, type RawAnswer } from "../chat/question-controls";
import { FillSheetView } from "./fill-sheet-view";

export type PanelEdit = { answers?: Record<string, unknown>; copy?: { name?: string; content?: string } };

type DraftPanelProps = {
  snapshot: Snapshot;
  busy: boolean;
  tab: string;
  onTabChange: (tab: string) => void;
  onEdit: (edit: PanelEdit) => Promise<boolean>;
  // 换算不出代码的限制条件，用户可以选「不限定」跳过。
  onDismiss: (noteId: string) => void;
  onRollback: (seq: number) => void;
  // 点填写值里的「出处」跳回对话中说这句话的那条消息。
  onShowSource: (messageId: string) => void;
};

export const PHASE_LABEL: Record<Snapshot["flow"]["phase"], string> = {
  interpreting: "理解中",
  collecting: "收集中",
  blocked: "待处理",
  ready: "已建好",
  out_of_scope: "不在 1811 范围",
};

// 面板里能直接改的人定项；优惠、货类这类会牵动明细拆分的，在对话里改。
const EDITABLE: Array<{ id: QuestionId; fact: FactKey }> = [
  { id: "Q1", fact: "dates" },
  { id: "Q2", fact: "stores" },
  { id: "Q5a", fact: "rates" },
  { id: "Q5b", fact: "commission" },
  { id: "Q6a", fact: "slogan" },
];

function AnswerEditor({ gap, snapshot, busy, onSave, onCancel }: { gap: Gap; snapshot: Snapshot; busy: boolean; onSave: (answers: Record<string, unknown>) => void; onCancel: () => void }) {
  const [raw, setRaw] = useState<RawAnswer>(() => initialRaw(gap, snapshot.latest.draft));
  const { answer, error } = toAnswer(gap, raw);
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-[#d5e5f5] bg-[#f5f9ff] p-3">
      <QuestionControl gap={gap} raw={raw} disabled={busy} onChange={(patch) => setRaw((current) => ({ ...current, ...patch }))} />
      {error ? <p className="text-[12px] text-[#b2443b]">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy || !answer} onClick={() => answer && onSave({ [gap.id]: answer })} className="h-11 bg-[#247cff] text-white hover:bg-[#176bea]">保存</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} className="h-11 bg-white">取消</Button>
      </div>
    </div>
  );
}

function CopyEditor({ initial, busy, onSave, onCancel }: { initial: string; busy: boolean; onSave: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="mt-2 space-y-2">
      <Textarea value={value} onChange={(event) => setValue(event.target.value)} className="min-h-20 bg-white text-sm" />
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy || !value.trim()} onClick={() => onSave(value.trim())} className="h-11 bg-[#247cff] text-white hover:bg-[#176bea]">保存</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} className="h-11 bg-white">取消</Button>
      </div>
    </div>
  );
}

function EditRow({ label, value, editing, onToggle, children }: { label: string; value: string; editing: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[12px] text-[#71869f]">{label}</p>
          <p className={`mt-0.5 break-words text-[13px] ${value === "未填" ? "text-[#b36b16]" : "text-[#293b54]"}`}>{value}</p>
        </div>
        <button type="button" aria-label={`修改${label}`} onClick={onToggle} className="grid size-11 shrink-0 place-items-center rounded-lg text-[#71869f] hover:bg-[#eaf3ff] hover:text-[#2470cc]">
          <PencilLine className="size-3.5" />
        </button>
      </div>
      {editing ? children : null}
    </div>
  );
}

export function DraftPanel({ snapshot, busy, tab, onTabChange, onEdit, onDismiss, onRollback, onShowSource }: DraftPanelProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const { draft, fill, checks, sheet } = snapshot.latest;
  const { flow } = snapshot;
  // 这一轮刚填了哪些事实：活动信息行按页面字段标，明细行按事实本身标。
  const freshKeys = recentlyFilled(snapshot.messages, snapshot.latest.seq);
  const freshFacts = new Set<string>(freshKeys);
  const blockers = checks.filter((check) => check.severity === "blocker");
  const warnings = checks.filter((check) => check.severity === "warning");
  const tbc = [...new Set([...Object.values(fill.info), ...fill.details.map((detail) => detail.businessCategory)].flatMap((item) => (item.tbc ? [item.tbc] : [])))];
  const attentionCount = fill.notes.length + tbc.length;
  const filledCount = Object.values(draft.facts).filter(Boolean).length;
  const totalRequired = filledCount + flow.missing.length;
  const completion = draftCompletion(totalRequired, flow.missing.length);
  const save = async (edit: PanelEdit) => {
    if (await onEdit(edit)) setEditing(null);
  };
  const toggle = (key: string) => setEditing(editing === key ? null : key);

  return (
    <div className="flex h-full cursor-text select-text flex-col">
      <div className="border-b border-[#dce9f6] bg-white/55 p-5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] font-semibold tracking-[0.08em] text-[#2470cc]">ICS-1811 实时草稿</p>
          <span className="rounded-full bg-[#e8f3ff] px-2.5 py-1 text-[11px] font-medium text-[#2470cc]">{PHASE_LABEL[flow.phase]}</span>
        </div>
        <h2 className="mt-1.5 line-clamp-2 text-lg font-semibold text-[#21344d]">{fill.info.name.value || snapshot.session.title}</h2>
        <div className="mt-3 flex items-center justify-between text-[11px] font-medium text-[#69809b]">
          <span>草稿完整度</span>
          <span className="text-[#2470cc]">{completion}%</span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[#dceafb]" role="progressbar" aria-label="草稿完整度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={completion}>
          <div className="h-full rounded-full bg-[linear-gradient(90deg,#247cff,#5ea8ff)] transition-[width] duration-300" style={{ width: `${completion}%` }} />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-[#f2f7ff] px-2 py-2"><strong className="block text-sm text-[#294866]">{fill.details.length}</strong><span className="text-[10px] text-[#8296ad]">优惠明细</span></div>
          <div className="rounded-xl bg-[#f2f7ff] px-2 py-2"><strong className="block text-sm text-[#294866]">{flow.missing.length}</strong><span className="text-[10px] text-[#8296ad]">仍缺项目</span></div>
          <div className="rounded-xl bg-[#f2f7ff] px-2 py-2"><strong className="block text-sm text-[#294866]">{filledCount}</strong><span className="text-[10px] text-[#8296ad]">已记下</span></div>
        </div>
      </div>

      <Tabs value={tab} onValueChange={onTabChange} className="flex min-h-0 flex-1 flex-col">
        <TabsList variant="line" className="flex w-full shrink-0 justify-start overflow-x-auto border-b border-[#dce9f6] bg-white/45 px-3">
          <TabsTrigger value="sheet" className="flex-none px-2.5">填写值</TabsTrigger>
          <TabsTrigger value="promo" className="flex-none px-2.5">对外文案</TabsTrigger>
          <TabsTrigger value="edit" className="flex-none px-2.5">修改</TabsTrigger>
          <TabsTrigger value="tbc" className="flex-none px-2.5">待确认 {attentionCount}</TabsTrigger>
          <TabsTrigger value="checks" className="flex-none px-2.5">校验 {blockers.length}</TabsTrigger>
          <TabsTrigger value="versions" className="flex-none px-2.5">版本 {snapshot.versions.length}</TabsTrigger>
        </TabsList>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TabsContent value="sheet">
            <FillSheetView
              sheet={sheet}
              ready={flow.phase === "ready"}
              highlighted={highlightedFields(freshKeys)}
              freshFacts={freshFacts}
              jump={{ messages: snapshot.messages, onShowSource }}
            />
          </TabsContent>

          <TabsContent value="promo" className="space-y-3">
            {snapshot.latest.promo ? (
              <>
                <div className="rounded-xl border border-[#d8e6f5] bg-white p-3">
                  <p className="text-[11px] text-[#8296ad]">主标题</p>
                  <p className="mt-1 text-base font-semibold text-[#17243a]">{snapshot.latest.promo.headline}</p>
                  {snapshot.latest.promo.slogan ? <p className="mt-1 text-[13px] text-[#5f7690]">{snapshot.latest.promo.slogan}</p> : null}
                </div>
                <div className="space-y-2 rounded-xl border border-[#d8e6f5] bg-white p-3">
                  {snapshot.latest.promo.highlights.map((item) => (
                    <p key={item} className="text-[13px] leading-5 text-[#4b5f78]">· {item}</p>
                  ))}
                </div>
                <div className="space-y-1.5 rounded-xl border border-[#d8e6f5] bg-white p-3 text-[13px] leading-5 text-[#4b5f78]">
                  <p><span className="text-[#8296ad]">活动时间　</span>{snapshot.latest.promo.period || "待补"}</p>
                  <p><span className="text-[#8296ad]">适用门店　</span>{snapshot.latest.promo.stores || "待补"}</p>
                  {snapshot.latest.promo.offer.map((line) => (
                    <p key={line}><span className="text-[#8296ad]">优惠说明　</span>{line}</p>
                  ))}
                </div>
                {snapshot.latest.promo.notes.map((note) => (
                  <div key={note} className="flex gap-2 rounded-xl border border-[#f1d6ad] bg-[#fff8eb] p-3">
                    <Info className="mt-0.5 size-4 shrink-0 text-[#b36b16]" />
                    <p className="text-[13px] leading-5 text-[#4b5f78]">{note}</p>
                  </div>
                ))}
              </>
            ) : (
              <p className="rounded-xl bg-[#eef6ff] p-3 text-[13px] leading-6 text-[#5f7690]">
                还没有对外宣传文案。在对话里说「给我一份对外宣传文案」，AI 会按已经记下的活动信息起草主标题和卖点；活动时间、门店和优惠力度由系统按事实填，不让模型改写。这份文案是给运营的草稿，对外发布前要走法务确认。
              </p>
            )}
          </TabsContent>

          <TabsContent value="edit" className="space-y-3">
            <p className="rounded-xl bg-[#eef6ff] p-3 text-[13px] leading-6 text-[#5f7690]">这里能直接改日期、门店、结算与标语，以及名称和内容。优惠方式、货类这类会影响明细拆分的，请在对话里说。</p>
            <div className="divide-y divide-[#e4edf7] rounded-xl border border-[#d8e6f5] bg-white">
              {EDITABLE.map(({ id, fact }) => (
                <EditRow key={id} label={QUESTION_TITLE[id]} value={factText(fact, draft.facts[fact])} editing={editing === id} onToggle={() => toggle(id)}>
                  <AnswerEditor key={`${id}-${snapshot.latest.seq}`} gap={{ id, title: QUESTION_TITLE[id] }} snapshot={snapshot} busy={busy} onCancel={() => setEditing(null)} onSave={(answers) => void save({ answers })} />
                </EditRow>
              ))}
              {(["name", "content"] as const).map((key) => (
                <EditRow key={key} label={key === "name" ? "活动名称" : "活动内容"} value={fill.info[key].value || "未填"} editing={editing === key} onToggle={() => toggle(key)}>
                  <CopyEditor key={`${key}-${snapshot.latest.seq}`} initial={fill.info[key].value} busy={busy} onCancel={() => setEditing(null)} onSave={(value) => void save({ copy: { [key]: value } })} />
                </EditRow>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="tbc" className="space-y-2">
            {fill.notes.map((note) => (
              <div key={note.id} className={`flex gap-2 rounded-xl border p-3 ${note.blocking ? "border-[#f1cbc5] bg-[#fff4f2]" : "border-[#f1d6ad] bg-[#fff8eb]"}`}>
                {note.blocking ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[#b2443b]" /> : <Info className="mt-0.5 size-4 shrink-0 text-[#b36b16]" />}
                <p className="min-w-0 flex-1 text-[13px] leading-5 text-[#4b5f78]">{note.text}<span className="ml-1 text-[11px] text-[#8ca0b7]">（{note.sop}）</span></p>
                {/* 原来这个按钮在复述卡片上；没有复述了，挪到这里。它会挡着生成，所以要让用户能处理。 */}
                {note.kind === "restriction_unresolved" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onDismiss(note.id)}
                    className="min-h-11 shrink-0 self-start rounded-full border border-[#bcd6f3] bg-white px-3 py-1 text-[12px] text-[#3970ad] hover:bg-[#edf5ff] disabled:opacity-60 md:min-h-9"
                  >
                    不限定
                  </button>
                ) : null}
              </div>
            ))}
            {tbc.map((item) => (
              <div key={item} className="flex gap-2 rounded-xl border border-[#d8e6f5] bg-white p-3">
                <Info className="mt-0.5 size-4 shrink-0 text-[#2470cc]" />
                <p className="text-[13px] leading-5 text-[#4b5f78]">{item}</p>
              </div>
            ))}
            {attentionCount === 0 ? <div className="flex items-center gap-2 rounded-xl bg-[#e8f7f1] p-4 text-sm text-[#26785e]"><CheckCircle2 className="size-4" />没有需要确认的项</div> : null}
          </TabsContent>

          <TabsContent value="checks" className="space-y-2">
            <div className="flex items-center gap-2 rounded-xl bg-[#e8f7f1] p-3 text-sm font-medium text-[#26785e]">
              <ShieldCheck className="size-4" />
              代码校验：{blockers.length} 条阻断，{warnings.length} 条提醒
            </div>
            {[...blockers, ...warnings].map((check, index) => (
              <div key={`${check.id}-${index}`} className={`flex gap-2 rounded-xl border p-3 ${check.severity === "blocker" ? "border-[#f1cbc5] bg-[#fff4f2]" : "border-[#f1d6ad] bg-[#fff8eb]"}`}>
                <AlertTriangle className={`mt-0.5 size-4 shrink-0 ${check.severity === "blocker" ? "text-[#b2443b]" : "text-[#b36b16]"}`} />
                <p className="text-[13px] leading-5 text-[#4b5f78]">{check.message}<span className="ml-1 text-[11px] text-[#8ca0b7]">（{check.sop}）</span></p>
              </div>
            ))}
          </TabsContent>

          <TabsContent value="versions" className="space-y-2">
            {[...snapshot.versions].reverse().map((version, index) => (
              <div key={version.seq} className="rounded-xl border border-[#d8e6f5] bg-white p-3 shadow-[0_4px_14px_rgba(43,94,151,0.04)]">
                <div className="flex items-center justify-between">
                  <strong className="text-sm text-[#293b54]">版本 {version.seq}</strong>
                  <span className="text-[12px] text-[#8094ab]">{index === 0 ? "当前" : new Date(version.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <p className="mt-1 text-[13px] text-[#617790]">{version.source}{version.diffCount ? ` · ${version.diffCount} 处变化` : ""}</p>
                {index !== 0 ? (
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onRollback(version.seq)} className="mt-1 h-11 px-1 text-[#2470cc] hover:bg-[#edf5ff]">
                    <RotateCcw />
                    恢复此版本
                  </Button>
                ) : null}
              </div>
            ))}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
