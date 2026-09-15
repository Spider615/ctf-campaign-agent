// 名称 → 代码表条目（§9(二)2、4：AI 负责门店名称、商品名称换算成代码）。

import { CODEBOOK, type CategoryEntry, type Entry, type StoreEntry } from "./codebook.ts";

// 截图里的繁体字只处理出现过的这些。
const TRADITIONAL: Record<string, string> = {
  區: "区", 閩: "闽", 華: "华", 東: "东", 門: "门", 鑽: "钻", 類: "类", 貨: "货", 價: "价", 優: "优", 銷: "销", 線: "线",
  動: "动", 審: "审", 會: "会", 員: "员", 銀: "银", 鑲: "镶", 條: "条", 專: "专", 萊: "莱", 獎: "奖", 勵: "励", 悅: "悦",
  選: "选", 轉: "转", 單: "单", 贈: "赠", 紅: "红", 摯: "挚", 貴: "贵", 賓: "宾", 級: "级", 尊: "尊", 當: "当",
};

export function normalizeName(text: string): string {
  return [...text].map((char) => TRADITIONAL[char] ?? char).join("").replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")");
}

export type Resolution<T> = { status: "ok"; entry: T } | { status: "ambiguous"; candidates: T[] } | { status: "none" };

type Named = Entry & { shortName?: string };

const pick = <T>(found: T[]): Resolution<T> | null =>
  found.length === 1 ? { status: "ok", entry: found[0] } : found.length > 1 ? { status: "ambiguous", candidates: found } : null;

// 按优先级逐级匹配：代码 → 全名 → 简称或别名 → 说法里包含全名（取最长）→ 全名包含说法 → 说法里包含别名。
export function resolveEntry<T extends Named>(entries: readonly T[], mention: string): Resolution<T> {
  const m = normalizeName(mention);
  if (!m) return { status: "none" };
  const aliasesOf = (entry: T) => [entry.shortName ?? "", ...(entry.aliases ?? [])].map(normalizeName).filter(Boolean);

  const stages: Array<() => T[]> = [
    () => entries.filter((entry) => normalizeName(entry.code) === m),
    () => entries.filter((entry) => normalizeName(entry.label) === m || normalizeName(entry.display) === m),
    () => entries.filter((entry) => aliasesOf(entry).includes(m)),
    () => {
      const inside = entries.filter((entry) => m.includes(normalizeName(entry.label)));
      const longest = Math.max(0, ...inside.map((entry) => normalizeName(entry.label).length));
      return inside.filter((entry) => normalizeName(entry.label).length === longest);
    },
    () => (m.length >= 2 ? entries.filter((entry) => normalizeName(entry.label).includes(m)) : []),
    () => entries.filter((entry) => aliasesOf(entry).some((alias) => alias.length >= 2 && m.includes(alias))),
  ];
  for (const stage of stages) {
    const result = pick(stage());
    if (result) return result;
  }
  return { status: "none" };
}

export function resolveStore(mention: string): Resolution<StoreEntry> {
  const codes = [...normalizeName(mention).matchAll(/(?<!\d)(\d{4})(?!\d)/g)].map((match) => match[1]);
  const byCode = CODEBOOK.stores.filter((entry) => codes.includes(entry.code));
  if (byCode.length === 1) return { status: "ok", entry: byCode[0] };
  if (byCode.length > 1) return { status: "ambiguous", candidates: byCode };
  return resolveEntry(CODEBOOK.stores, mention);
}

export function resolveCategory(mention: string): Resolution<CategoryEntry> {
  return resolveEntry(CODEBOOK.categories, mention);
}

export function resolveRegion(mention: string): Resolution<Entry> {
  const m = normalizeName(mention).replace(/(大区|区域|地区)$/, "区");
  return resolveEntry(CODEBOOK.regions, m.endsWith("区") ? m : `${m}区`);
}

// Q2 的候选：说法有歧义时给候选门店；说的是区域时给该区域的门店。
export function storeCandidates(mention: string): StoreEntry[] {
  const store = resolveStore(mention);
  if (store.status === "ambiguous") return store.candidates;
  const region = resolveRegion(mention);
  return region.status === "ok" ? CODEBOOK.stores.filter((entry) => entry.region === region.entry.code) : [];
}

// 在一段话里找出提到的条目：长名字优先，已经被长名字占用的字不再匹配短名字。
export function findInText<T extends Entry>(entries: readonly T[], text: string, useAliases = true): T[] {
  const t = normalizeName(text);
  const names = entries
    .flatMap((entry) => [entry.label, ...(useAliases ? entry.aliases ?? [] : [])].map((name) => ({ entry, name: normalizeName(name) })))
    .filter((item) => item.name.length > 0)
    .sort((a, b) => b.name.length - a.name.length);
  const taken = new Array<boolean>(t.length).fill(false);
  const found: T[] = [];
  for (const { entry, name } of names) {
    for (let index = t.indexOf(name); index >= 0; index = t.indexOf(name, index + 1)) {
      const span = Array.from({ length: name.length }, (_, offset) => index + offset);
      if (span.some((position) => taken[position])) continue;
      span.forEach((position) => (taken[position] = true));
      if (!found.includes(entry)) found.push(entry);
    }
  }
  return found;
}

export function storesInText(text: string): StoreEntry[] {
  const t = normalizeName(text);
  const byCode = [...t.matchAll(/(?<!\d)(\d{4})(?!\d)/g)].flatMap((match) => CODEBOOK.stores.filter((entry) => entry.code === match[1]));
  const byName = CODEBOOK.stores.filter((entry) => t.includes(normalizeName(entry.label)) || t.includes(normalizeName(entry.shortName)));
  return [...new Set([...byCode, ...byName])];
}

export function paymentMethodsInText(text: string): string[] {
  const t = normalizeName(text);
  return [...CODEBOOK.paymentMethods.defaults, ...CODEBOOK.paymentMethods.others].filter((name) => t.includes(normalizeName(name)));
}

export function headCodesInText(text: string): string[] {
  if (!/号头|货类明细/.test(text)) return [];
  const all = [...new Set(CODEBOOK.categories.flatMap((entry) => entry.headCodes))];
  return all.filter((code) => new RegExp(`(?<![A-Za-z])${code}(?![A-Za-z])`).test(text));
}
