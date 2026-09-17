// 营销活动父层领域模型。Campaign 只保存活动 Brief、可选的 1811 子草稿和传播创意；
// 路由、工作台状态和发布准备度都由纯函数实时推导，不落库。

import type { Fact, Ics1811Draft } from "./ics1811/types.ts";

export type CampaignChannel = "store" | "wechat" | "ecommerce" | "social" | "member_crm" | "event";

export type CampaignBrief = {
  name: Fact<string> | null;
  objective: Fact<string> | null;
  audience: Fact<string> | null;
  theme: Fact<string> | null;
  channels: Fact<CampaignChannel[]> | null;
  timing: Fact<string> | null;
  scope: Fact<string> | null;
};

export type CampaignBriefKey = keyof CampaignBrief;

export type CommunicationCreative = {
  concept: {
    headline: string;
    subheadline: string;
    coreMessage: string;
  };
  channelOutputs: Array<{
    channel: CampaignChannel;
    format: string;
    copy: string;
    cta: string;
  }>;
  visualDirection: string;
  source: "ai" | "user";
};

export type CommunicationPlanFacts = {
  name: string | null;
  objective: string;
  audience: string;
  theme: string;
  channels: CampaignChannel[];
  timing: string | null;
  scope: string | null;
  period: string | null;
  stores: string | null;
  offer: string[];
  slogan: string | null;
};

export type CommunicationPlan = {
  status: "needs_review";
  concept: CommunicationCreative["concept"];
  channelOutputs: CommunicationCreative["channelOutputs"];
  visualDirection: string;
  facts: CommunicationPlanFacts;
  reviewNotes: string[];
};

export type CampaignDraft = {
  schema: "campaign/v1";
  id: string;
  requestText: string;
  brief: CampaignBrief;
  ics1811: Ics1811Draft | null;
  communication: CommunicationCreative | null;
};

export type CampaignTrackKind = "brand_launch" | "transaction_offer" | "member_crm";

export type CampaignRouting = {
  tracks: CampaignTrackKind[];
  status: "decided" | "needs_confirmation";
  basis: string[];
};

export type CampaignWorkspaceStage = "briefing" | "planning" | "preparing" | "blocked" | "needs_confirmation";

export type CampaignBriefItem = {
  key: CampaignBriefKey;
  label: string;
  required: boolean;
  value: string | null;
  quote: string | null;
  status: "missing" | "confirmed";
};

export type CampaignExecutionTrack = {
  id: string;
  kind: "strategy" | CampaignTrackKind | "communications" | "store_readiness";
  title: string;
  status: "not_started" | "in_progress" | "blocked" | "needs_confirmation" | "ready" | "not_applicable";
  summary: string;
  nextAction: string | null;
  ownerRole: string;
  basis: string[];
};

export type CampaignReadinessGate = {
  id: string;
  title: string;
  status: "pending" | "needs_confirmation" | "blocked" | "passed" | "not_applicable";
  basis: string[];
  nextAction: string | null;
};

export type CampaignWorkspace = {
  routing: CampaignRouting;
  stage: CampaignWorkspaceStage;
  brief: {
    status: "draft" | "ready";
    items: CampaignBriefItem[];
    missing: CampaignBriefKey[];
    completeCount: number;
    totalCount: number;
  };
  executionTracks: CampaignExecutionTrack[];
  readiness: {
    status: "blocked" | "needs_confirmation";
    gates: CampaignReadinessGate[];
  };
  artifacts: {
    ics1811: {
      status: "not_applicable" | "collecting" | "blocked" | "sheet_ready";
      missingCount: number;
      blockerCount: number;
    };
    communications: {
      status: "not_started" | "draft" | "needs_review";
    };
  };
};
