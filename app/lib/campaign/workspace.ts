// Campaign 父层的兼容适配、确定性路由与工作台投影。
// 这些状态每轮从事实和 1811 确定性领域函数重算，不作为新的业务事实保存。

import { createEmptyCampaignBrief } from "./brief.ts";
import type {
  CampaignBriefItem,
  CampaignBriefKey,
  CampaignDraft,
  CampaignExecutionTrack,
  CampaignRouting,
  CampaignTrackKind,
  CampaignWorkspace,
} from "./types.ts";
import { renderCommunicationPlan } from "./communication.ts";
import { checkDraft } from "./ics1811/checks.ts";
import { deriveFill } from "./ics1811/derive.ts";
import { createEmptyDraft } from "./ics1811/facts.ts";
import { detectPattern } from "./ics1811/offer-spec.ts";
import { planNext } from "./ics1811/questions.ts";
import type { Ics1811Draft } from "./ics1811/types.ts";

const BRAND_PATTERN = /品牌|新品|新系列|系列发布|发布会|联名|内容传播|品牌传播|宣传|展览|展会|快闪|线下体验/iu;
const MEMBER_PATTERN = /会员|CRM|私域|积分|社群|会员中心|会员触达/iu;
const TRANSACTION_PATTERN = /成交优惠|优惠开单/iu;

const BRIEF_LABEL: Record<CampaignBriefKey, string> = {
  name: "活动名称",
  objective: "活动目标",
  audience: "目标受众",
  theme: "活动主题",
  channels: "传播渠道",
  timing: "活动时机",
  scope: "活动范围",
};

const BRIEF_KEYS = Object.keys(BRIEF_LABEL) as CampaignBriefKey[];
const REQUIRED_BRIEF_KEYS: readonly CampaignBriefKey[] = ["objective", "audience", "theme", "channels"];

function hasTransactionSignal(text: string): boolean {
  if (TRANSACTION_PATTERN.test(text)) return true;
  const detected = detectPattern(text);
  return detected !== null && detected.unsupportedType !== "积分加倍";
}

// 判「要不要 1811」和判「走不走优惠轨」必须用同一套输入，否则会出现路由说要配 1811、子草稿却建不出来，
// 执行轨、上线检查和 1811 页签三处互相打架，而且用户没有任何入口把它建起来。
// 所以这里和 routeCampaign 一样读首句 + 已记下的 Brief 原话，再加上用户当前这一轮的话。
function briefQuotes(draft: CampaignDraft): string {
  return BRIEF_KEYS.flatMap((key) => draft.brief[key]?.quote ?? []).join("。 ");
}

function icsSignalText(draft: CampaignDraft, text: string): string {
  return [draft.requestText, briefQuotes(draft), text].filter(Boolean).join("。 ");
}

export function ensureIcs1811Child(draft: CampaignDraft, text: string, newId: () => string): CampaignDraft {
  if (draft.ics1811 || !hasTransactionSignal(icsSignalText(draft, text))) return draft;
  // 子草稿的 requestText 用用户这一轮的话；这一轮没话（模型刚写完 Brief）就退回首句。
  return { ...draft, ics1811: createEmptyDraft(newId(), text || draft.requestText) };
}

export function createCampaignDraft(id: string, requestText: string): CampaignDraft {
  return {
    schema: "campaign/v1",
    id,
    requestText,
    brief: createEmptyCampaignBrief(),
    ics1811: hasTransactionSignal(requestText) ? createEmptyDraft(`${id}:ics1811`, requestText) : null,
    communication: null,
  };
}

export function normalizeCampaignDraft(input: CampaignDraft | Ics1811Draft): CampaignDraft {
  if (input.schema === "campaign/v1") return structuredClone(input);
  return {
    schema: "campaign/v1",
    id: `campaign:${input.id}`,
    requestText: input.requestText,
    brief: createEmptyCampaignBrief(),
    ics1811: structuredClone(input),
    communication: null,
  };
}

export function routeCampaign(draft: CampaignDraft): CampaignRouting {
  const request = draft.requestText;
  const quotes = briefQuotes(draft);
  const combined = [request, quotes, draft.ics1811?.facts.offer?.quote ?? ""].filter(Boolean).join("。 ");
  const tracks: CampaignTrackKind[] = [];
  const basis: string[] = [];

  if (BRAND_PATTERN.test(combined)) {
    tracks.push("brand_launch");
    basis.push(BRAND_PATTERN.test(request) ? "原始需求提到新品、品牌或内容传播" : "Brief 原话提到新品、品牌或内容传播");
  }
  if (draft.ics1811 || hasTransactionSignal(combined)) {
    tracks.push("transaction_offer");
    basis.push(draft.ics1811 ? "已有 1811 优惠配置子草稿" : "活动原话提到成交优惠玩法");
  }
  if (MEMBER_PATTERN.test(combined) || draft.brief.channels?.value.includes("member_crm")) {
    tracks.push("member_crm");
    basis.push(MEMBER_PATTERN.test(request) ? "原始需求提到会员、私域、积分或 CRM 触达" : "Brief 原话提到会员、私域、积分或 CRM 触达");
  }

  return tracks.length
    ? { tracks, status: "decided", basis }
    : { tracks: [], status: "needs_confirmation", basis: ["当前信息不足，尚不能判断活动执行轨"] };
}

function briefItem(draft: CampaignDraft, key: CampaignBriefKey): CampaignBriefItem {
  const fact = draft.brief[key];
  const value = fact?.value ?? null;
  return {
    key,
    label: BRIEF_LABEL[key],
    required: REQUIRED_BRIEF_KEYS.includes(key),
    value: Array.isArray(value) ? value.join("、") : value,
    quote: fact?.quote ?? null,
    status: fact ? "confirmed" : "missing",
  };
}

function icsArtifact(draft: CampaignDraft, today: string): CampaignWorkspace["artifacts"]["ics1811"] {
  if (!draft.ics1811) return { status: "not_applicable", missingCount: 0, blockerCount: 0 };
  const fill = deriveFill(draft.ics1811);
  const checks = checkDraft(draft.ics1811, fill, today);
  const plan = planNext(draft.ics1811, fill, checks);
  const blockerCount = checks.filter((check) => check.severity === "blocker").length;
  if (plan.action === "ready") return { status: "sheet_ready", missingCount: 0, blockerCount };
  if (plan.action === "out_of_scope") return { status: "blocked", missingCount: 0, blockerCount: Math.max(1, blockerCount) };
  return {
    status: blockerCount ? "blocked" : "collecting",
    missingCount: plan.missing.length,
    blockerCount,
  };
}

function executionTracks(
  draft: CampaignDraft,
  routing: CampaignRouting,
  brief: CampaignWorkspace["brief"],
  artifact: CampaignWorkspace["artifacts"]["ics1811"],
  communicationReady: boolean,
): CampaignExecutionTrack[] {
  const tracks: CampaignExecutionTrack[] = [{
    id: "strategy",
    kind: "strategy",
    title: "活动策略",
    status: brief.status === "ready" ? "ready" : "in_progress",
    summary: brief.status === "ready" ? "活动 Brief 已完整记录" : `活动 Brief 还缺 ${brief.missing.length} 项`,
    nextAction: brief.status === "ready" ? null : `补充${brief.missing.map((key) => BRIEF_LABEL[key]).join("、")}`,
    ownerRole: "活动运营",
    basis: brief.items.filter((item) => item.quote).map((item) => `${item.label}：${item.quote}`),
  }];

  if (routing.tracks.includes("transaction_offer")) {
    const status = artifact.status === "sheet_ready" ? "ready" : artifact.status === "blocked" ? "blocked" : "in_progress";
    tracks.push({
      id: "transaction_offer",
      kind: "transaction_offer",
      title: "优惠配置",
      status,
      summary: artifact.status === "sheet_ready" ? "1811 填写值已准备" : artifact.status === "blocked" ? "1811 当前存在阻断" : `1811 还缺 ${artifact.missingCount} 项`,
      nextAction: artifact.status === "sheet_ready" ? null : "继续补齐 1811 的确定性缺项和阻断",
      ownerRole: "活动运营",
      basis: routing.basis,
    });
  }

  if (routing.tracks.includes("brand_launch") || routing.tracks.includes("member_crm") || draft.communication) {
    const staleCommunication = Boolean(draft.communication) && !communicationReady;
    tracks.push({
      id: "communications",
      kind: "communications",
      title: "内容传播",
      status: communicationReady ? "needs_confirmation" : staleCommunication ? "blocked" : "not_started",
      summary: communicationReady
        ? "传播方案已起草，仍需审核"
        : staleCommunication
          ? "传播方案与当前活动事实不一致"
          : "尚未起草传播方案",
      nextAction: communicationReady
        ? "审核各渠道内容和视觉方向"
        : staleCommunication
          ? "按当前 Brief 和活动事实重新生成传播方案"
          : "Brief 齐备后起草传播方案",
      ownerRole: "品牌与市场",
      basis: routing.tracks.includes("brand_launch") || routing.tracks.includes("member_crm")
        ? routing.basis
        : ["已有传播方案草稿，说明本活动启用了内容传播"],
    });
  }

  if (routing.tracks.includes("member_crm")) {
    tracks.push({
      id: "member_crm",
      kind: "member_crm",
      title: "会员触达",
      status: "needs_confirmation",
      summary: "系统不连接 CRM，实际人群与触达配置待人工确认",
      nextAction: "在 CRM 中确认会员人群、频次和发送配置",
      ownerRole: "会员运营",
      basis: routing.basis,
    });
  }

  if (draft.ics1811 || draft.brief.channels?.value.includes("store")) {
    const hasScope = Boolean(draft.brief.scope || draft.ics1811?.facts.stores);
    tracks.push({
      id: "store_readiness",
      kind: "store_readiness",
      title: "门店准备",
      status: hasScope ? "needs_confirmation" : "blocked",
      summary: hasScope ? "门店范围已有依据，库存、物料与人员准备待确认" : "还没有可执行的门店范围",
      nextAction: hasScope ? "人工确认库存、物料、培训与人员准备" : "先补充活动适用范围",
      ownerRole: "门店运营",
      basis: draft.brief.scope ? [draft.brief.scope.quote] : draft.ics1811?.facts.stores ? [draft.ics1811.facts.stores.quote] : [],
    });
  }

  return tracks;
}

export function buildCampaignWorkspace(draft: CampaignDraft, today: string): CampaignWorkspace {
  const routing = routeCampaign(draft);
  const items = BRIEF_KEYS.map((key) => briefItem(draft, key));
  const missing = REQUIRED_BRIEF_KEYS.filter((key) => !draft.brief[key]);
  const brief: CampaignWorkspace["brief"] = {
    status: missing.length ? "draft" : "ready",
    items,
    missing,
    completeCount: REQUIRED_BRIEF_KEYS.length - missing.length,
    totalCount: REQUIRED_BRIEF_KEYS.length,
  };
  const artifact = icsArtifact(draft, today);
  const communicationReady = renderCommunicationPlan(draft) !== null;
  const needsCommunication = routing.tracks.includes("brand_launch") || routing.tracks.includes("member_crm") || Boolean(draft.communication);
  const staleCommunication = Boolean(draft.communication) && !communicationReady;
  const needsStoreReadiness = Boolean(draft.ics1811 || draft.brief.channels?.value.includes("store"));
  const hasStoreScope = Boolean(draft.brief.scope || draft.ics1811?.facts.stores?.value.length);
  const machineReady = routing.status === "decided" && brief.status === "ready" &&
    (!routing.tracks.includes("transaction_offer") || artifact.status === "sheet_ready") &&
    (!needsCommunication || communicationReady) &&
    (!needsStoreReadiness || hasStoreScope);
  const readiness: CampaignWorkspace["readiness"] = {
    status: machineReady ? "needs_confirmation" : "blocked",
    gates: [
      {
        id: "routing",
        title: "活动类型",
        status: routing.status === "decided" ? "passed" : "needs_confirmation",
        basis: routing.basis,
        nextAction: routing.status === "decided" ? null : "说明这次活动是品牌发布、成交优惠还是会员触达",
      },
      {
        id: "brief",
        title: "活动 Brief",
        status: brief.status === "ready" ? "passed" : "blocked",
        basis: brief.items.filter((item) => item.quote).map((item) => `${item.label}：${item.quote}`),
        nextAction: brief.status === "ready" ? null : `补充${missing.map((key) => BRIEF_LABEL[key]).join("、")}`,
      },
      {
        id: "ics1811",
        title: "1811 优惠配置",
        status: !routing.tracks.includes("transaction_offer")
          ? "not_applicable"
          : artifact.status === "sheet_ready"
            ? "passed"
            : "blocked",
        basis: routing.tracks.includes("transaction_offer") ? routing.basis : ["当前活动没有成交优惠轨"],
        nextAction: artifact.status === "sheet_ready" || !routing.tracks.includes("transaction_offer") ? null : "继续补齐 1811 子流程",
      },
      {
        id: "communications",
        title: "传播方案",
        status: !needsCommunication
          ? "not_applicable"
          : communicationReady
            ? "needs_confirmation"
            : "blocked",
        basis: !needsCommunication
          ? ["当前活动没有品牌传播或会员触达轨"]
          : communicationReady
            ? ["传播方案已生成，但系统不会代替品牌与法务审核"]
            : staleCommunication
              ? ["已有传播草稿不再覆盖当前确认的渠道或活动事实"]
              : ["当前活动包含品牌传播或会员触达轨，尚未生成传播方案"],
        nextAction: !needsCommunication
          ? null
          : communicationReady
            ? "人工审核各渠道内容、视觉方向和活动事实"
            : staleCommunication
              ? "按当前 Brief 和活动事实重新生成传播方案"
              : "先生成覆盖已确认渠道的传播方案",
      },
      {
        id: "member_crm",
        title: "会员配置",
        status: routing.tracks.includes("member_crm") ? "needs_confirmation" : "not_applicable",
        basis: routing.tracks.includes("member_crm")
          ? ["当前活动包含会员触达轨；本系统不连接 CRM"]
          : ["当前活动没有会员触达轨"],
        nextAction: routing.tracks.includes("member_crm") ? "在 CRM 中人工确认会员人群、频次和发送配置" : null,
      },
      {
        id: "store_readiness",
        title: "门店准备",
        status: !needsStoreReadiness ? "not_applicable" : hasStoreScope ? "needs_confirmation" : "blocked",
        basis: !needsStoreReadiness
          ? ["当前活动没有门店渠道或 1811 子流程"]
          : hasStoreScope
            ? [draft.brief.scope?.quote ?? draft.ics1811?.facts.stores?.quote ?? "已有可执行的门店范围"]
            : ["活动涉及门店，但还没有可执行的门店范围"],
        nextAction: !needsStoreReadiness
          ? null
          : hasStoreScope
            ? "人工确认库存、物料、培训与人员准备"
            : "先补充活动适用的门店范围",
      },
      {
        id: "external_readiness",
        title: "外部执行准备",
        status: machineReady ? "needs_confirmation" : "pending",
        basis: ["本系统不连接 OA、CRM、投放、库存或门店生产系统"],
        nextAction: machineReady ? "如适用，人工确认审阅/审批、库存、物料、渠道配置和发布时间" : "先完成当前活动方案与适用子流程",
      },
    ],
  };

  let stage: CampaignWorkspace["stage"];
  if (routing.status === "needs_confirmation") stage = "needs_confirmation";
  else if (brief.status === "draft") stage = "briefing";
  else if (artifact.status === "blocked") stage = "blocked";
  else if (artifact.status === "collecting") stage = "planning";
  else if (needsStoreReadiness && !hasStoreScope) stage = "blocked";
  else if (needsCommunication && !communicationReady) stage = "preparing";
  else stage = "needs_confirmation";

  return {
    routing,
    stage,
    brief,
    executionTracks: executionTracks(draft, routing, brief, artifact, communicationReady),
    readiness,
    artifacts: {
      ics1811: artifact,
      communications: { status: communicationReady ? "needs_review" : draft.communication ? "draft" : "not_started" },
    },
  };
}
