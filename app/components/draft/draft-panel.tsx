"use client";

import { AlertTriangle, CheckCircle2, Info, PencilLine, RotateCcw, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { factText } from "../../lib/campaign/ics1811/messages";
import { QUESTION_TITLE } from "../../lib/campaign/ics1811/questions";
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
  onRollback: (seq: number) => void;
};

export const PHASE_LABEL: Record<Snapshot["flow"]["phase"], string> = {
  interpreting: "理解中",
  asking: "追问中",
  readback: "待确认",
  blocked: "仍缺信息",
  confirmed: "已生成填写值",
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
    <div className="mt-3 space-y-2 rounded-xl border border-[#e8ddd1] bg-[#faf7f2] p-3">
      <QuestionControl gap={gap} raw={raw} disabled={busy} onChange={(patch) => setRaw((current) => ({ ...current, ...patch }))} />
      {error ? <p className="text-[12px] text-[#9a3f24]">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy || !answer} onClick={() => answer && onSave({ [gap.id]: answer })} className="h-8 bg-[#651427] text-white hover:bg-[#791a30]">保存</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} className="h-8 bg-white">取消</Button>
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
        <Button type="button" size="sm" disabled={busy || !value.trim()} onClick={() => onSave(value.trim())} className="h-8 bg-[#651427] text-white hover:bg-[#791a30]">保存</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} className="h-8 bg-white">取消</Button>
      </div>
    </div>
  );
}

function EditRow({ label, value, editing, onToggle, children }: { label: string; value: string; editing: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[12px] text-[#8a7d80]">{label}</p>
          <p className={`mt-0.5 break-words text-[13px] ${value === "未填" ? "text-[#a15a24]" : "text-[#35262a]"}`}>{value}</p>
        </div>
        <button type="button" aria-label={`修改${label}`} onClick={onToggle} className="grid size-7 shrink-0 place-items-center rounded-lg text-[#8a7d80] hover:bg-[#f3ece4] hover:text-[#651427]">
          <PencilLine className="size-3.5" />
        </button>
      </div>
      {editing ? children : null}
    </div>
  );
}

export function DraftPanel({ snapshot, busy, tab, onTabChange, onEdit, onRollback }: DraftPanelProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const { draft, fill, checks, sheet } = snapshot.latest;
  const { flow } = snapshot;
  const blockers = checks.filter((check) => check.severity === "blocker");
  const warnings = checks.filter((check) => check.severity === "warning");
  const tbc = [...new Set([...Object.values(fill.info), ...fill.details.map((detail) => detail.businessCategory)].flatMap((item) => (item.tbc ? [item.tbc] : [])))];
  const attentionCount = fill.notes.length + tbc.length;
  const save = async (edit: PanelEdit) => {
    if (await onEdit(edit)) setEditing(null);
  };
  const toggle = (key: string) => setEditing(editing === key ? null : key);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[#e4dbd2] p-5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] text-[#8e7f82]">1811 填写值</p>
          <span className="rounded-full bg-[#f5efe7] px-2 py-0.5 text-[11px] text-[#8b6b3b]">{PHASE_LABEL[flow.phase]}</span>
        </div>
        <h2 className="mt-1 line-clamp-2 text-lg font-semibold text-[#2d1d22]">{fill.info.name.value || snapshot.session.title}</h2>
        <p className="mt-2 text-[12px] leading-5 text-[#75676a]">
          1 个活动 · {fill.details.length} 条明细 · 仍缺 {flow.missing.length} 项 · 已追问 {flow.roundsUsed}/2 轮
        </p>
      </div>

      <Tabs value={tab} onValueChange={onTabChange} className="flex min-h-0 flex-1 flex-col">
        <TabsList variant="line" className="flex w-full shrink-0 justify-start overflow-x-auto border-b border-[#e4dbd2] px-3">
          <TabsTrigger value="sheet" className="flex-none px-2.5">填写值</TabsTrigger>
          <TabsTrigger value="edit" className="flex-none px-2.5">修改</TabsTrigger>
          <TabsTrigger value="tbc" className="flex-none px-2.5">待确认 {attentionCount}</TabsTrigger>
          <TabsTrigger value="checks" className="flex-none px-2.5">校验 {blockers.length}</TabsTrigger>
          <TabsTrigger value="versions" className="flex-none px-2.5">版本 {snapshot.versions.length}</TabsTrigger>
        </TabsList>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TabsContent value="sheet">
            <FillSheetView sheet={sheet} confirmed={flow.phase === "confirmed"} />
          </TabsContent>

          <TabsContent value="edit" className="space-y-3">
            <p className="rounded-xl bg-[#f7f2eb] p-3 text-[13px] leading-6 text-[#6d5d5f]">这里能直接改日期、门店、结算与标语，以及名称和内容。优惠方式、货类这类会影响明细拆分的，请在对话里说。</p>
            <div className="divide-y divide-[#efe7de] rounded-xl border border-[#e7ddd2] bg-white">
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
              <div key={note.id} className={`flex gap-2 rounded-xl border p-3 ${note.blocking ? "border-[#efc8bb] bg-[#fff2ec]" : "border-[#ead7c4] bg-[#fcf5ec]"}`}>
                {note.blocking ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[#a33a25]" /> : <Info className="mt-0.5 size-4 shrink-0 text-[#9c642b]" />}
                <p className="text-[13px] leading-5 text-[#4b3037]">{note.text}<span className="ml-1 text-[11px] text-[#9a8d8f]">（{note.sop}）</span></p>
              </div>
            ))}
            {tbc.map((item) => (
              <div key={item} className="flex gap-2 rounded-xl border border-[#e7ddd2] bg-white p-3">
                <Info className="mt-0.5 size-4 shrink-0 text-[#8b6b3b]" />
                <p className="text-[13px] leading-5 text-[#4b3037]">{item}</p>
              </div>
            ))}
            {attentionCount === 0 ? <div className="flex items-center gap-2 rounded-xl bg-[#eaf3ec] p-4 text-sm text-[#47704f]"><CheckCircle2 className="size-4" />没有需要确认的项</div> : null}
          </TabsContent>

          <TabsContent value="checks" className="space-y-2">
            <div className="flex items-center gap-2 rounded-xl bg-[#eaf3ec] p-3 text-sm font-medium text-[#47704f]">
              <ShieldCheck className="size-4" />
              代码校验：{blockers.length} 条阻断，{warnings.length} 条提醒
            </div>
            {[...blockers, ...warnings].map((check, index) => (
              <div key={`${check.id}-${index}`} className={`flex gap-2 rounded-xl border p-3 ${check.severity === "blocker" ? "border-[#efc8bb] bg-[#fff2ec]" : "border-[#ead7c4] bg-[#fcf5ec]"}`}>
                <AlertTriangle className={`mt-0.5 size-4 shrink-0 ${check.severity === "blocker" ? "text-[#a33a25]" : "text-[#9c642b]"}`} />
                <p className="text-[13px] leading-5 text-[#4b3037]">{check.message}<span className="ml-1 text-[11px] text-[#9a8d8f]">（{check.sop}）</span></p>
              </div>
            ))}
          </TabsContent>

          <TabsContent value="versions" className="space-y-2">
            {[...snapshot.versions].reverse().map((version, index) => (
              <div key={version.seq} className="rounded-xl border border-[#e7ddd2] bg-white p-3">
                <div className="flex items-center justify-between">
                  <strong className="text-sm text-[#35262a]">版本 {version.seq}</strong>
                  <span className="text-[12px] text-[#8a7e80]">{index === 0 ? "当前" : new Date(version.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <p className="mt-1 text-[13px] text-[#6f6265]">{version.source}{version.diffCount ? ` · ${version.diffCount} 处变化` : ""}</p>
                {index !== 0 ? (
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => onRollback(version.seq)} className="mt-1 h-8 px-0 text-[#651427]">
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
