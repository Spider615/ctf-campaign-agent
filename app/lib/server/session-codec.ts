import type { CampaignDraft, IcsOrderDraft } from "../campaign/types.ts";

export type EncodedVersion = {
  seq: number;
  draftJson: string;
  ordersJson: string;
};

export function serializeVersion(draft: CampaignDraft, orders: unknown[], seq: number): EncodedVersion {
  return {
    seq,
    draftJson: JSON.stringify(draft),
    ordersJson: JSON.stringify(orders),
  };
}

export function deserializeVersion(encoded: EncodedVersion): {
  seq: number;
  draft: CampaignDraft;
  orders: IcsOrderDraft[];
} {
  return {
    seq: encoded.seq,
    draft: JSON.parse(encoded.draftJson) as CampaignDraft,
    orders: JSON.parse(encoded.ordersJson) as IcsOrderDraft[],
  };
}

