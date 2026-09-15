import type { CampaignDraft, DraftVersion, FieldDiff, PatchOperation } from "./types.ts";

const allowedRoots = new Set([
  "brief",
  "intent",
  "audience",
  "products",
  "offer",
  "scope",
  "schedule",
  "metric",
  "operations",
  "unresolved",
  "title",
]);
const deniedSegments = new Set(["__proto__", "prototype", "constructor"]);

function pathSegments(path: string): string[] {
  const segments = path.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (!path.startsWith("/") || !allowedRoots.has(segments[0]) || segments.some((segment) => deniedSegments.has(segment))) {
    throw new Error("不允许修改该字段");
  }
  return segments;
}

export function applyPatch(draft: CampaignDraft, ops: PatchOperation[]): CampaignDraft {
  const next = structuredClone(draft) as CampaignDraft;

  for (const operation of ops) {
    const segments = pathSegments(operation.path);
    let target: Record<string, unknown> | unknown[] = next as unknown as Record<string, unknown>;
    for (const segment of segments.slice(0, -1)) {
      const key = Array.isArray(target) ? Number(segment) : segment;
      const value = target[key as keyof typeof target];
      if ((Array.isArray(target) && (!Number.isInteger(key) || value === undefined)) || (!value || typeof value !== "object")) {
        throw new Error("补丁路径不存在");
      }
      target = value as Record<string, unknown> | unknown[];
    }

    const last = segments.at(-1)!;
    if (Array.isArray(target)) {
      const index = Number(last);
      if (!Number.isInteger(index)) throw new Error("补丁路径不存在");
      if (operation.op === "remove") {
        target.splice(index, 1);
        continue;
      }
      if (operation.op === "replace" && target[index] === undefined) throw new Error("补丁路径不存在");
      target[index] = structuredClone(operation.value);
    } else {
      if (operation.op === "remove") {
        delete target[last];
        continue;
      }
      if (operation.op === "replace" && target[last] === undefined) throw new Error("补丁路径不存在");
      target[last] = structuredClone(operation.value);
    }
  }

  return next;
}

function collectDiffs(before: unknown, after: unknown, path: string, diffs: FieldDiff[]) {
  if (Object.is(before, after)) return;
  if (
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) !== Array.isArray(after)
  ) {
    diffs.push({ path, before, after });
    return;
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    collectDiffs(
      (before as Record<string, unknown>)[key],
      (after as Record<string, unknown>)[key],
      `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      diffs,
    );
  }
}

export function diffDrafts(before: CampaignDraft, after: CampaignDraft): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  collectDiffs(before, after, "", diffs);
  return diffs;
}

export function rollbackTo(versions: DraftVersion[], seq: number): DraftVersion {
  const target = versions.find((version) => version.seq === seq);
  if (!target) throw new Error("找不到要恢复的版本");
  const latest = versions.at(-1);
  return {
    seq: (latest?.seq ?? 0) + 1,
    draft: structuredClone(target.draft),
    source: "rollback",
    reason: `恢复到版本 ${seq}`,
    createdAt: new Date().toISOString(),
    diffs: latest ? diffDrafts(latest.draft, target.draft) : [],
  };
}
