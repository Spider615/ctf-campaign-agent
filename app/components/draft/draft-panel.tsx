"use client";

import { AlertTriangle, CheckCircle2, Clipboard, Download, Maximize2, PencilLine, RotateCcw, ShieldCheck } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { calculateOrderCount } from "../../lib/campaign/split-orders";
import { FIELD_TOPIC, missingFields, noIcsOrders, type FieldKey, type TopicId } from "../../lib/campaign/topics";
import type { CampaignDraft, FieldValue } from "../../lib/campaign/types";
import type { Snapshot } from "../../lib/server/turns";
import { QuestionCard } from "../chat/question-card";
import { SourceBadge } from "../source-badge";

type BriefKey = "title" | "externalName" | "icsName" | "content" | "slogan";

type Row = {
  id: string;
  label: string;
  value: string;
  source?: FieldValue<unknown>;
  edit?: FieldKey;
  brief?: BriefKey;
  missing?: boolean;
  muted?: boolean;
};

const NOT_NEEDED = "不建 ICS 单，无需填写";
const list = (values: string[]) => (values.length ? values.join("、") : "未填");

function groups(draft: CampaignDraft): Array<{ title: string; rows: Row[] }> {
  const missing = new Set(missingFields(draft));
  const onlySee = draft.intent.customerAction.value === "只看到";
  const noIcs = noIcsOrders(draft);
  const mechanism = draft.offer.mechanism.value;
  const batch = draft.schedule.batches[0];
  const choice = (field: FieldValue<string>) => (field.value === "还没定" || (field.provenance === "pending" && !field.suggested) ? "未填" : field.value);

  return [
    {
      title: "顾客动作与由头",
      rows: [
        { id: "customerAction", label: "顾客动作", value: choice(draft.intent.customerAction), source: draft.intent.customerAction, edit: "customerAction", missing: missing.has("customerAction") },
        { id: "occasion", label: "由头类型", value: choice(draft.intent.occasion), source: draft.intent.occasion, edit: "occasion", missing: missing.has("occasion") },
        { id: "reason", label: "由头原话", value: draft.intent.reason || "未填" },
      ],
    },
    {
      title: "让利",
      rows: onlySee
        ? [{ id: "offer", label: "让利", value: NOT_NEEDED, muted: true }]
        : [
            { id: "mechanism", label: "让利机制", value: choice(draft.offer.mechanism), source: draft.offer.mechanism, edit: "mechanism", missing: missing.has("mechanism") },
            ...(mechanism === "无让利"
              ? []
              : [
                  {
                    id: "tier",
                    label: "优惠力度",
                    value: draft.offer.tiers.length ? draft.offer.tiers.map((tier) => tier.label).join("、") : "未填",
                    edit: mechanism === "门槛型" || mechanism === "直接价格" ? ("tier" as const) : undefined,
                    missing: missing.has("tier"),
                  },
                  {
                    id: "stacking",
                    label: "能否叠加",
                    value: draft.offer.stacking.value === "是" ? "可以叠加" : draft.offer.stacking.value === "否" ? "不能叠加" : "未填",
                    source: draft.offer.stacking,
                    edit: "stacking" as const,
                    missing: missing.has("stacking"),
                  },
                ]),
          ],
    },
    {
      title: "范围",
      rows: [
        { id: "level", label: "范围层级", value: choice(draft.scope.level), source: draft.scope.level, edit: "level", missing: missing.has("level") },
        {
          id: "scopeCode",
          label: "具体范围",
          value: draft.scope.regionCode || draft.scope.divisionCode || (draft.scope.stores.length ? draft.scope.stores.map((store) => `${store.code} ${store.name}`).join("、") : draft.scope.level.value === "全国" || draft.scope.level.value === "电商平台" ? "—" : "未填"),
          edit: "scopeCode",
          missing: missing.has("scopeCode"),
        },
        noIcs
          ? { id: "markets", label: "覆盖市场", value: NOT_NEEDED, muted: true }
          : { id: "markets", label: "覆盖市场", value: list(draft.scope.markets.value), source: draft.scope.markets, edit: "markets", missing: missing.has("markets") },
        noIcs
          ? { id: "channels", label: "渠道", value: NOT_NEEDED, muted: true }
          : { id: "channels", label: "渠道", value: list(draft.scope.channels.value), source: draft.scope.channels, edit: "channels", missing: missing.has("channels") },
      ],
    },
    {
      title: "档期",
      rows: [{ id: "dates", label: "起止日期", value: `${batch?.startDate || "未填"} 至 ${batch?.endDate || "未填"}`, edit: "dates", missing: missing.has("dates") }],
    },
    {
      title: "人群与货品",
      rows: [
        { id: "segments", label: "人群", value: list(draft.audience.segments.value), source: draft.audience.segments, edit: "segments", missing: missing.has("segments") },
        { id: "categories", label: "业务大类", value: list(draft.products.categories.value), source: draft.products.categories, edit: "categories", missing: missing.has("categories") },
        {
          id: "membership",
          label: "会员限制",
          value: draft.audience.membership.value === "限" ? `限会员${draft.audience.membershipDescription ? `：${draft.audience.membershipDescription}` : ""}` : choice(draft.audience.membership),
          source: draft.audience.membership,
          edit: "membership",
          missing: missing.has("membership"),
        },
      ],
    },
    {
      title: "只有你知道的数",
      rows: noIcs
        ? [{ id: "operations", label: "让扣点、回款率、支付方式", value: NOT_NEEDED, muted: true }]
        : [
            { id: "concession", label: "让扣点", value: draft.operations.concessionRate.value === null ? "未填" : String(draft.operations.concessionRate.value), source: draft.operations.concessionRate, edit: "rates", missing: missing.has("rates") },
            { id: "collection", label: "回款率", value: draft.operations.collectionRate.value === null ? "未填" : String(draft.operations.collectionRate.value), source: draft.operations.collectionRate, edit: "rates", missing: missing.has("rates") },
            {
              id: "payment",
              label: "支付方式限制",
              value: draft.operations.paymentRestricted.provenance === "user" ? (draft.operations.paymentRestricted.value ? "有限制" : "不限制") : "未填",
              source: draft.operations.paymentRestricted,
              edit: "paymentRestricted",
              missing: missing.has("paymentRestricted"),
            },
          ],
    },
    {
      title: "文案",
      rows: [
        { id: "title", label: "活动标题", value: draft.title, brief: "title" },
        { id: "externalName", label: "对外传播名", value: draft.brief.externalName || "生成方案后填入", brief: "externalName" },
        { id: "icsName", label: "ICS 开单名", value: draft.brief.icsName || "生成方案后填入", brief: "icsName" },
        { id: "content", label: "活动内容", value: draft.brief.content || "生成方案后填入", brief: "content" },
        { id: "slogan", label: "活动标语", value: draft.brief.slogan || "生成方案后填入", brief: "slogan" },
      ],
    },
    {
      title: "系统默认与待界面选择",
      rows: [
        { id: "cycle", label: "周内循环日", value: draft.schedule.cycleWeekdays.value.join(","), source: draft.schedule.cycleWeekdays },
        { id: "productScope", label: "货品范围", value: `${draft.products.productScope.value}（全部货品）`, source: draft.products.productScope },
        { id: "outlet", label: "转换餐牌", value: draft.products.outletTagConversion ? "1" : "0（不转餐牌）" },
        { id: "offerType", label: "优惠类型编号", value: draft.offer.offerType === null ? "待界面选择" : String(draft.offer.offerType) },
        { id: "brand", label: "品牌线与审批流", value: draft.operations.brandLine.value || "待界面选择" },
        { id: "group", label: "活动分组", value: draft.operations.activityGroup ?? "待定" },
      ],
    },
  ];
}

function BriefEditor({ initial, busy, onSave, onCancel }: { initial: string; busy: boolean; onSave: (value: string) => void; onCancel: () => void }) {
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

type DraftPanelProps = {
  snapshot: Snapshot;
  busy: boolean;
  tab: string;
  onTabChange: (tab: string) => void;
  onAnswer: (topic: TopicId, values: Record<string, unknown>) => Promise<boolean>;
  onRollback: (seq: number) => void;
};

export function DraftPanel({ snapshot, busy, tab, onTabChange, onAnswer, onRollback }: DraftPanelProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const { draft, orders, issues } = snapshot.latest;
  const split = calculateOrderCount(draft);
  const noIcs = noIcsOrders(draft);
  const missingCount = missingFields(draft).length;
  const blockers = issues.filter((issue) => issue.severity === "blocker");
  const icsName = draft.brief.icsName || "（生成方案后填入）";

  const submit = async (topic: TopicId, values: Record<string, unknown>) => {
    if (await onAnswer(topic, values)) setEditing(null);
  };

  const copyChecklist = async () => {
    const text = orders.map((order) => [
      `ICS ${order.activitySequence}`,
      `活动名称：${icsName}`,
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
    link.download = `${draft.brief.icsName || draft.title || "campaign"}-evidence.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[#e4dbd2] p-5">
        <p className="text-[12px] text-[#8e7f82]">活动草稿</p>
        <h2 className="mt-1 line-clamp-2 text-lg font-semibold text-[#2d1d22]">{draft.brief.externalName || snapshot.session.title}</h2>
        <div className="mt-4 flex items-end justify-between gap-4">
          <div>
            {noIcs ? (
              <p className="text-2xl font-semibold text-[#651427]">不建 ICS 单</p>
            ) : (
              <>
                <p className="flex items-end gap-1.5">
                  <strong className="text-4xl font-semibold tracking-[-0.05em] text-[#651427]">{split.total}</strong>
                  <span className="pb-1 text-sm text-[#75676a]">条 ICS 单</span>
                </p>
                <p className="mt-1 text-[12px] text-[#8a7d80]">
                  {split.factors.batches} 批次 × {split.factors.markets} 市场 × {split.factors.channels} 渠道 × {split.factors.scopeUnits} 范围 × {split.factors.offerTiers} 档
                </p>
              </>
            )}
          </div>
          <div className="text-right">
            <p className="text-[12px] text-[#8a7d80]">还差</p>
            <p className={`text-xl font-semibold ${missingCount ? "text-[#a15a24]" : "text-[#47704f]"}`}>{missingCount} 项</p>
          </div>
        </div>
      </div>

      <Tabs value={tab} onValueChange={onTabChange} className="flex min-h-0 flex-1 flex-col">
        <TabsList variant="line" className="flex w-full shrink-0 justify-start overflow-x-auto border-b border-[#e4dbd2] px-3">
          <TabsTrigger value="fields" className="flex-none px-2.5">字段</TabsTrigger>
          <TabsTrigger value="ics" className="flex-none px-2.5">ICS {orders.length}</TabsTrigger>
          <TabsTrigger value="pending" className="flex-none px-2.5">待选 {draft.unresolved.length}</TabsTrigger>
          <TabsTrigger value="validation" className="flex-none px-2.5">校验</TabsTrigger>
          <TabsTrigger value="versions" className="flex-none px-2.5">版本 {snapshot.versions.length}</TabsTrigger>
        </TabsList>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TabsContent value="fields" className="space-y-5">
            {groups(draft).map((group) => (
              <section key={group.title}>
                <p className="mb-2 text-[12px] font-semibold tracking-[0.08em] text-[#8b6b3b]">{group.title}</p>
                <div className="divide-y divide-[#efe7de] rounded-xl border border-[#e7ddd2] bg-white">
                  {group.rows.map((row) => (
                    <div key={row.id} className={`px-3 py-2.5 ${row.missing ? "bg-[#fff8ec]" : ""}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-[12px] text-[#8a7d80]">{row.label}</p>
                          <p className={`mt-0.5 break-words text-[13px] ${row.muted || row.value === "未填" ? "text-[#a1969a]" : "text-[#35262a]"}`}>{row.value}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {row.source && !row.muted ? <SourceBadge field={row.source} /> : null}
                          {row.edit || row.brief ? (
                            <button
                              type="button"
                              aria-label={`修改${row.label}`}
                              disabled={busy}
                              onClick={() => setEditing(editing === row.id ? null : row.id)}
                              className="grid size-7 place-items-center rounded-lg text-[#8a7d80] hover:bg-[#f3ece4] hover:text-[#651427] disabled:opacity-50"
                            >
                              <PencilLine className="size-3.5" />
                            </button>
                          ) : null}
                        </div>
                      </div>
                      {editing === row.id && row.edit ? (
                        <div className="mt-3">
                          <QuestionCard
                            key={`${row.id}-${snapshot.latest.seq}`}
                            compact
                            topic={FIELD_TOPIC[row.edit]}
                            fields={[row.edit]}
                            draft={draft}
                            busy={busy}
                            onSubmit={(values) => void submit(FIELD_TOPIC[row.edit!], values)}
                          />
                        </div>
                      ) : null}
                      {editing === row.id && row.brief ? (
                        <BriefEditor
                          key={`${row.id}-${snapshot.latest.seq}`}
                          initial={row.brief === "title" ? draft.title : draft.brief[row.brief]}
                          busy={busy}
                          onCancel={() => setEditing(null)}
                          onSave={(value) => void submit("brief", { [row.brief!]: value })}
                        />
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </TabsContent>

          <TabsContent value="ics" className="space-y-3">
            <p className="rounded-xl bg-[#f7f2eb] p-3 text-[13px] leading-6 text-[#6d5d5f]">
              每一条 = 要在 ICS 新建优惠活动界面（1811）录入的一条优惠规则。本工具不连接 ICS，请照此手工录入。
            </p>
            {orders.length ? (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" className="h-8 bg-white" onClick={() => void copyChecklist()}><Clipboard />{copied ? "已复制" : "复制清单"}</Button>
                  <Button type="button" variant="outline" size="sm" className="h-8 bg-white" onClick={downloadEvidence}><Download />下载证据包</Button>
                  <Button type="button" variant="outline" size="sm" className="h-8 bg-white" onClick={() => setTableOpen(true)}><Maximize2 />展开为表格</Button>
                </div>
                {orders.map((order) => (
                  <div key={order.id} className="rounded-xl border border-[#e7ddd2] bg-white p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[13px] text-[#4b3037]">ICS {order.activitySequence} · {icsName}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ${order.status === "ready" ? "bg-[#e5f1e8] text-[#47704f]" : "bg-[#f6e5d5] text-[#935321]"}`}>
                        {order.status === "ready" ? "字段已齐" : "有项待界面选"}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[13px] text-[#5f5256]">{order.batch.startDate || "未定"} 至 {order.batch.endDate || "未定"} · {order.market} · {order.channel}</p>
                    <p className="text-[13px] text-[#5f5256]">{order.scopeUnit} · {order.offerTier.label}</p>
                  </div>
                ))}
              </>
            ) : (
              <div className="rounded-xl bg-[#f5eee4] p-6 text-center text-sm text-[#6f5b49]">{noIcs ? "本次活动不生成 ICS 开单草稿。" : "范围、市场、渠道补齐后，这里会列出要录入的每一条单。"}</div>
            )}
            <p className="text-[12px] text-[#8e8184]">1816 核对表仅供核对，不可上传。</p>
          </TabsContent>

          <TabsContent value="pending" className="space-y-2">
            {draft.unresolved.length ? draft.unresolved.map((item, index) => (
              <div key={item} className="flex gap-3 rounded-xl border border-[#ead7c4] bg-[#fcf5ec] p-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#9c642b] text-[12px] text-white">{index + 1}</span>
                <div>
                  <p className="text-sm font-medium text-[#5a4030]">{item}</p>
                  <p className="mt-1 text-[12px] text-[#8a7567]">以 ICS 生产界面为准，Agent 不猜内部码。</p>
                </div>
              </div>
            )) : (
              <div className="flex items-center gap-2 rounded-xl bg-[#eaf3ec] p-4 text-sm text-[#47704f]"><CheckCircle2 className="size-4" />没有待界面选择的项</div>
            )}
          </TabsContent>

          <TabsContent value="validation" className="space-y-2">
            <div className="flex items-center gap-2 rounded-xl bg-[#eaf3ec] p-3 text-sm font-medium text-[#47704f]">
              <ShieldCheck className="size-4" />
              已执行 17 条开单规则 · {blockers.length} 条阻断
            </div>
            {issues.length ? issues.map((issue, index) => (
              <div key={`${issue.ruleId}-${issue.path}-${index}`} className={`flex gap-2 rounded-xl border p-3 ${issue.severity === "blocker" ? "border-[#efc8bb] bg-[#fff2ec]" : "border-[#ead7c4] bg-[#fcf5ec]"}`}>
                <AlertTriangle className={`mt-0.5 size-4 shrink-0 ${issue.severity === "blocker" ? "text-[#a33a25]" : "text-[#9c642b]"}`} />
                <p className="text-[13px] text-[#4b3037]">{issue.ruleId} · {issue.message}</p>
              </div>
            )) : <p className="rounded-xl border p-4 text-sm text-[#667469]">没有发现规则冲突。</p>}
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

      <Dialog open={tableOpen} onOpenChange={setTableOpen}>
        <DialogContent className="max-w-[min(1100px,calc(100vw-2rem))] sm:max-w-[min(1100px,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>ICS 开单清单</DialogTitle>
            <DialogDescription>每一行是一条要在 ICS 1811 界面录入的优惠规则。</DialogDescription>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-auto rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="bg-[#f6f1ea]">
                  <TableHead>序号</TableHead>
                  <TableHead>活动名称</TableHead>
                  <TableHead>档期</TableHead>
                  <TableHead>市场 / 渠道</TableHead>
                  <TableHead>范围</TableHead>
                  <TableHead>优惠规则</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-mono text-[13px]">{order.activitySequence}</TableCell>
                    <TableCell>{icsName}</TableCell>
                    <TableCell>{order.batch.startDate} 至 {order.batch.endDate}</TableCell>
                    <TableCell>{order.market} / {order.channel}</TableCell>
                    <TableCell>{order.scopeUnit}</TableCell>
                    <TableCell>{order.offerTier.label}</TableCell>
                    <TableCell>{order.status === "ready" ? "字段已齐" : "有项待界面选"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
