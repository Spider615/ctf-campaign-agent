import type { AnalysisFact } from "../analysis-v2-types.ts";
import { ANALYSIS_FILTER_DIMENSIONS, SEMANTIC_DIMENSIONS, SEMANTIC_METRICS } from "../semantic/model.ts";
import type { NodeResult, NodeRole, NodeRow, PlanExecution } from "./execute.ts";
import type { PlanNode, PlanScope } from "./types.ts";

// 结论绑定：模型只写带占位的措辞并指向计划节点，数字、方向和可信度都由代码查出来。
export type Claim = { node: string; select?: Record<string, string>; metric: string; role?: NodeRole; assert: "value" | "up" | "down" | "flat" | "higher" | "lower" | "largest" | "smallest" | "unavailable"; text: string };
export type ClaimDraft = { headline: Claim; claims: Claim[]; actions: Array<{ text: string; claim: number }>; cannotConclude: string[]; questions: string[] };
// keyFigure：措辞里第一个占位填入的数，界面把它作为这条结论的重点数字放大显示。
export type BoundClaim = Claim & { factIds: string[]; rendered: string; confidence: "kept" | "flipped" | "unchecked"; keyFigure?: { value: string; factId: string } };
// actions[].claim 指向保留后 claims 中的序号；指向 headline 或被丢弃结论的行动会被丢弃。
// droppedText 记录被丢弃的行动、不能下的结论和追问（它们不是 Claim）。
export type DroppedText = { kind: "action" | "cannotConclude" | "question"; text: string; reason: string };
export type Binding = { headline?: BoundClaim; claims: BoundClaim[]; actions: Array<{ text: string; claim: number }>; dropped: Array<{ claim: Claim; reason: string }>; droppedText: DroppedText[]; cannotConclude: string[]; questions: string[] };

const MAX_CLAIMS = 5;
const MAX_ACTIONS = 3;
const MAX_CANNOT = 5;
const PLACEHOLDERS = ["value", "target", "reference", "delta", "change", "deviation"] as const;
const DIRECTIONAL: NodeRole[] = ["delta", "change", "deviation"];
const NO_DIGITS = "措辞中不能直接写算出来的数字，请用占位符";
const NO_PLACEHOLDER = "建议和说明不绑定数据，不能写占位符，请用文字指向对应发现";
// 措辞里允许出现的数字只来自原话和业务名称，其余数字一律当作算出来的值拒绝：
// - 业务名称（维度取值、计划筛选值，如「H-克减30元」「东区/B区」）整段出现时，先从措辞里抹掉再检查；
// - 问题原文里的日期和时长（2025年、8月23日、7天）原样出现可以保留。
// 所以「克减30元档」可以写，「高了30元」不行。
const TIME_TOKEN = /\d+(?:\.\d+)?\s*(?:年|月|日|号|天|周)/g;
// 返回措辞里不被允许的数字片段；为空表示可以通过。片段原样回给模型，便于它知道改哪里。
export function digitGuard(literals: readonly string[], names: readonly string[] = []): (text: string) => string[] {
  const allowedTimes = new Set((literals.join("\n").normalize("NFKC").match(TIME_TOKEN) ?? []).map((token) => token.replace(/\s+/g, "")));
  // 名称按长度降序抹掉，避免短名称先截断长名称。
  // 同时接受去掉编号前缀的简称：「H-克减30元」也可写作「克减30元」。
  const variants = names.flatMap((name) => { const full = name.normalize("NFKC"); return [full, ...full.split(/[-－]/).slice(1).map((part) => part.trim()).filter((part) => part.length >= 3)]; });
  const known = [...new Set(variants.filter((name) => /\d/.test(name)))].sort((a, b) => b.length - a.length);
  // 简称：数字连同前面两个字原样出现在业务名称或问题原文里（「克减50档」里的「克减50」），也按名称处理。
  // 档位简称：「50元档」里的「50元」原样出现在业务名称或原文里（「H-克减50元」）时按名称处理；「高50元」仍算算出来的数。
  // 名称比较不区分大小写（价位段写作 30K-50K，措辞里常写 30k-50k）。
  const nameText = [...known, ...literals].join("\n").normalize("NFKC").toLowerCase();
  return (raw: string) => {
    let text = raw.normalize("NFKC");
    const lower = text.toLowerCase();
    for (const name of known) { const target = name.toLowerCase(); let at = lower.indexOf(target); while (at >= 0) { text = text.slice(0, at) + " ".repeat(name.length) + text.slice(at + name.length); at = lower.indexOf(target, at + name.length); } }
    // 「50元档」「50档」：数字（连同单位）出现在业务名称或原文里时是档位简称。
    text = text.replace(/(\d+(?:\.\d+)?)([^\d\s{}]?)(?=档)/g, (token, number: string, unit: string) => nameText.includes(`${number}${unit || "元"}`.toLowerCase()) || unit && nameText.includes(token.toLowerCase()) ? " " : token);
    text = text.replace(TIME_TOKEN, (token) => allowedTimes.has(token.replace(/\s+/g, "")) ? " " : token);
    text = text.replace(/([^\d\s{}]{2})(\d+(?:\.\d+)?)/g, (token, prefix: string) => /^[\p{L}]{2}$/u.test(prefix) && nameText.includes(token) ? `${prefix} ` : token);
    return [...new Set(text.match(/\d+(?:[.,]\d+)*\s*(?:%|个百分点|[^\s\d{}，。；、（）()]?)/g) ?? [])].map((item) => item.trim());
  };
}

// 与出处面板一致的显示规则；计划式答案的数字格式只在这里定义。
export function displayUnit(unit: string): string {
  return /^(?:CNY|人民币|RMB)(?:(?:\/|每).+)?$/.test(unit) ? unit.replace(/^(?:CNY|人民币|RMB)/, "元").replace("每", "/")
    : unit === "百分比" || unit === "％" ? "%" : unit === "百分点" ? "个百分点" : unit === "unknown" ? "（单位待核对）" : unit;
}

export function formatValue(fact: AnalysisFact, signed: boolean): string {
  if (fact.value === null) return "暂无可计算值";
  const unit = fact.unit;
  const money = /^(?:CNY|人民币|RMB|元|USD|美元|HKD|港元|EUR|欧元)(?:(?:\/|每).+)?$/.test(unit);
  const perGram = /(?:\/|每)克$/.test(unit);
  const percent = unit === "%" || unit === "％" || unit === "百分比" || unit === "个百分点" || unit === "百分点";
  const min = perGram ? 0 : money || percent ? 2 : 0;
  // 情景假设保留原样；其余观察值最多两位小数，整数仍按整数显示。
  const max = fact.assumption && !fact.scenario ? 12 : 2;
  const rendered = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: true }).format(Object.is(fact.value, -0) ? 0 : fact.value);
  // 差额、变化和偏离带明确正负号，读者一眼分得清涨跌。
  const sign = signed && fact.value > 0 && !rendered.startsWith("-") ? "+" : "";
  return `${sign}${rendered}${displayUnit(unit)}`;
}

// 百分比指标（毛利率、折扣率等）的差额是百分点，不是百分比变化，显示时写明。
export function formatRoleValue(fact: AnalysisFact, role: NodeRole): string {
  const text = formatValue(fact, DIRECTIONAL.includes(role));
  return role === "delta" && displayUnit(fact.unit) === "%" ? text.replace(/%$/, "个百分点") : text;
}

// ---- 口径检查 ----
// 两段范围的日历天数不同，或节庆、日类型、日期筛选不同时，覆盖的天数不同，合计值不能直接比较；
// 同样长度的两段（今年八月对去年八月）可以比合计。
const TIME_FILTERS = Object.entries(ANALYSIS_FILTER_DIMENSIONS).filter(([, dimension]) => SEMANTIC_DIMENSIONS[dimension].entity === "time").map(([key]) => key);
const calendarDays = (scope: PlanScope) => Math.round((Date.parse(`${scope.period.end}T00:00:00Z`) - Date.parse(`${scope.period.start}T00:00:00Z`)) / 86400000) + 1;
const timeOf = (scope: PlanScope) => JSON.stringify([calendarDays(scope), ...TIME_FILTERS.map((key) => [...((scope.filters as Record<string, string[] | undefined>)?.[key] ?? [])].sort())]);
const isTotal = (metric: string) => Boolean((SEMANTIC_METRICS as Record<string, { additive?: boolean }>)[metric]?.additive);
// 合计类指标（实收、件数、克重、毛利等）在时间不同的两段之间比较时为真；日均、单均、每店等比率不受影响。
export function totalAcrossWindows(node: PlanNode, metric: string, role: NodeRole): boolean {
  return node.op === "contrast" && timeOf(node.target) !== timeOf(node.reference) && isTotal(metric) && ["target", "reference", "delta", "change"].includes(role);
}
const TOTAL_ACROSS_WINDOWS = "两段时间天数不同，合计值不能直接比较；请改用日均类指标（如日均实收、日均订单）";

// 主结论要说整体或有代表性的规律：分组只占所在维度样本不到 1% 时属个案，只能作为发现之一。
const HEADLINE_MIN_SHARE = 0.01;
function sampleShare(result: NodeResult, selected: NodeRow): number | undefined {
  if (selected.sampleRows === undefined || !Object.keys(selected.key).length) return undefined;
  const dimensions = JSON.stringify(Object.keys(selected.key).sort());
  const sizes = new Map<string, number>();
  for (const row of result.rows) if (row.sampleRows !== undefined && JSON.stringify(Object.keys(row.key).sort()) === dimensions) sizes.set(JSON.stringify(row.key), row.sampleRows);
  const total = [...sizes.values()].reduce((sum, value) => sum + value, 0);
  return total > 0 ? selected.sampleRows / total : undefined;
}
function headlineIssue(claim: Claim, execution: PlanExecution): string | undefined {
  const result = execution.results.get(claim.node); if (!result) return undefined;
  const role = claim.role ?? defaultRole(result); const key = claim.select ?? {};
  const selected = result.rows.find((row) => row.metric === claim.metric && row.role === role && sameKey(row, key));
  const share = selected && sampleShare(result, selected);
  if (share === undefined || share >= HEADLINE_MIN_SHARE) return undefined;
  return `主结论要说整体或有代表性的规律：这一组只占该维度样本的 ${(share * 100).toFixed(2)}%，属个案，请把它写成发现之一，主结论改用整体或覆盖面更大的分组`;
}

// 填值自带单位；紧跟着的同一单位（个个、条条、元元、家家）只留一个。
const UNIT_WORDS = ["个百分点", "元/日", "元/家", "元/件", "元/单", "元/克", "单/日", "个", "条", "家", "件", "单", "克", "元", "日", "%"];
function dedupeUnits(text: string): string {
  let result = text;
  for (const unit of UNIT_WORDS) result = result.split(`${unit}${unit}`).join(unit);
  return result.replace(/(\d[\d,.]*)(元\/[日家件单克]|个百分点|[个条家件单克%])\s*\2/g, "$1$2");
}

// 计划节点里写到的筛选值和日期，也是用户语境里的业务名称。
function nodeLiterals(node: NodeResult["node"]): string[] {
  const scopes = node.op === "measure" ? [node.scope] : node.op === "contrast" ? [node.target, node.reference] : [];
  return scopes.flatMap((scope) => [scope.period.start, scope.period.end, ...Object.values(scope.filters ?? {}).flat()]);
}

function defaultRole(result: NodeResult): NodeRole {
  const op = result.node.op;
  return op === "contrast" ? "delta" : op === "drill" || op === "scan" ? "deviation" : "value";
}

const sameKey = (row: NodeRow, key: Record<string, string>) => {
  const names = Object.keys(key);
  return Object.keys(row.key).length === names.length && names.every((name) => row.key[name] === key[name]);
};

// 稳健性检查只核对所指节点的一个指标；可信度只作用于同节点、同指标的结论。
function confidenceOf(node: string, metric: string, execution: PlanExecution): BoundClaim["confidence"] {
  const checks: Array<boolean | null> = [];
  for (const result of execution.results.values()) {
    if (result.node.op === "robust" && result.node.of === node) for (const item of result.robust ?? []) if (item.metric === metric) checks.push(item.kept);
  }
  if (checks.includes(false)) return "flipped";
  // 全部检查都保住才算 kept；有未能判断（null）的或没有检查，只算 unchecked。
  return checks.length > 0 && checks.every((item) => item === true) ? "kept" : "unchecked";
}

type Outcome = { bound: BoundClaim } | { reason: string };

// 说明哪几个数字不能写，以及可以怎么改。
const digitsReason = (items: string[]) => `${NO_DIGITS}：${items.slice(0, 4).map((item) => `「${item}」`).join("")}不能直接写；用占位符，或改成「最高」「多数」「约一倍」这类文字`;
function bindOne(claim: Claim, execution: PlanExecution, forbidden: (text: string) => string[]): Outcome {
  const stripped = claim.text.replace(/\{[^}]*\}/g, "");
  const digits = forbidden(stripped); if (digits.length) return { reason: digitsReason(digits) };
  const used = [...claim.text.matchAll(/\{([^}]*)\}/g)].map((match) => match[1]);
  const unknown = used.find((name) => !(PLACEHOLDERS as readonly string[]).includes(name));
  if (unknown !== undefined) return { reason: `未知占位符 {${unknown}}` };

  // 一条结论只绑一个指标的一组数：同一个数写两遍（含 {value} 与它本身角色的占位并用）多半是想说别的指标。
  const result = execution.results.get(claim.node);
  if (!result) return { reason: `计划节点「${claim.node}」不存在` };
  if (result.status !== "completed") return { reason: `计划节点「${claim.node}」未完成（${result.status === "unsupported" ? "不支持" : "失败"}）` };
  const role = claim.role ?? defaultRole(result);
  // 下钻、扫描沿用所指对比的范围，同样受这条限制。
  const scopeNode = "of" in result.node ? execution.results.get(result.node.of)?.node ?? result.node : result.node;
  const usedRoles = [role, ...used.filter((name) => name !== "value" && name !== "deviation")] as NodeRole[];
  if (usedRoles.some((wanted) => totalAcrossWindows(scopeNode, claim.metric, wanted))) return { reason: TOTAL_ACROSS_WINDOWS };
  // {value} 是所选那一行；如果所选角色已经用具名占位（如 {change}）写出，{value} 改指这一组的水平值
  // （对比类节点的目标值，汇总节点的值），避免同一个数写两遍。
  const named = new Set(used.filter((name) => name !== "value"));
  const level: NodeRole = result.rows.some((row) => row.metric === claim.metric && row.role === "target") ? "target" : "value";
  const valueRole: NodeRole = named.has(role) ? level : role;
  const resolved = used.map((name) => name === "value" ? valueRole : name);
  const repeated = resolved.find((name, index) => resolved.indexOf(name) !== index);
  if (repeated !== undefined) return { reason: `同一个数（{${repeated}}）在一条结论里出现了两次；一条结论只说一个指标，其他指标请另写一条` };
  const candidates = result.rows.filter((row) => row.metric === claim.metric && row.role === role);
  // 空 select 只选总体行（key 为空）；非空 select 要求键集合和取值完全一致，不做部分匹配。
  const key = claim.select ?? {};
  const matches = candidates.filter((row) => sameKey(row, key));
  const scopeText = Object.keys(key).length ? `分组 ${JSON.stringify(key)}` : "总体";
  if (matches.length === 0) return { reason: `找不到对应分组：节点「${claim.node}」没有匹配的数据行（指标 ${claim.metric}，角色 ${role}，${scopeText}）` };
  if (matches.length > 1) return { reason: `分组不唯一，请补全分组条件（节点「${claim.node}」，指标 ${claim.metric}，${scopeText}）` };
  const selected = matches[0];
  const factOf = (row: NodeRow) => execution.evidence.facts.find((item) => item.id === row.factId);
  const selectedFact = factOf(selected);
  if (!selectedFact) return { reason: `节点「${claim.node}」的数据行缺少事实 ${selected.factId}` };
  const sibling = (wanted: NodeRole) => result.rows.find((row) => row.metric === claim.metric && row.role === wanted && sameKey(row, selected.key));

  // 方向校验：声明的方向必须与事实一致。
  const value = selectedFact.value;
  const valueOf = (row: NodeRow | undefined) => (row ? factOf(row)?.value ?? null : null);
  // 方向依据的事实（所选行自身或同分组的兄弟行）也要进 factIds。
  const evidence: string[] = [];
  const directional = (): number | null => {
    // 拆解的贡献值本身就有正负方向。
    if ((DIRECTIONAL.includes(selected.role) || selected.role === "contribution") && value !== null) return value;
    for (const wanted of ["delta", "change", "deviation"] as const) {
      const row = sibling(wanted); const found = valueOf(row);
      if (row && found !== null) { evidence.push(row.factId); return found; }
    }
    return null;
  };
  const wrong = (detail: string): Outcome => ({ reason: `方向与事实不符：声明 ${claim.assert}，${detail}` });
  // value：只陈述这个数（如有多少个活动、本月实收多少），不判断方向；值要能算出来。
  if (claim.assert === "value") {
    if (value === null) return { reason: "所选行暂无可计算值" };
  } else if (claim.assert === "unavailable") {
    if (value !== null) return wrong("该值实际可以计算");
  } else if (claim.assert === "up" || claim.assert === "higher" || claim.assert === "down" || claim.assert === "lower") {
    const signal = directional();
    if (signal === null) return { reason: result.node.op === "measure" ? "汇总节点没有对比方向：分组排名请用 largest/smallest，高低比较请引用 contrast、drill 或 scan 节点" : "没有可比较方向的差额、变化或偏离值" };
    const up = claim.assert === "up" || claim.assert === "higher";
    if (up ? signal <= 0 : signal >= 0) return wrong(`实际${signal > 0 ? "为正" : signal < 0 ? "为负" : "为零"}`);
  } else if (claim.assert === "flat") {
    // 有变化行就只看它（值为空即无法判断）；没有时仅偏离行或百分比单位的所选行本身可当变化率。
    const changeRow = sibling("change");
    let change: number | null;
    if (changeRow) {
      change = valueOf(changeRow);
      if (change === null) return { reason: "变化率无法计算" };
      evidence.push(changeRow.factId);
    } else if (selected.role === "deviation" || ["%", "个百分点"].includes(displayUnit(selectedFact.unit))) {
      change = value;
      if (change === null) return { reason: "变化率无法计算" };
    } else return { reason: "缺少变化率，无法判断持平" };
    if (Math.abs(change) >= 1) return wrong("变化幅度不小于 1");
  } else {
    // largest / smallest：同节点、同指标、同角色的行里比较，空值不参与。
    if (value === null) return { reason: "所选行没有可计算值，无法排序" };
    const peers = candidates.map((row) => factOf(row)?.value ?? null).filter((item): item is number => item !== null);
    const best = claim.assert === "largest" ? Math.max(...peers) : Math.min(...peers);
    if (value !== best) return wrong(`实际不是${claim.assert === "largest" ? "最大" : "最小"}`);
  }

  // 占位填值：取同节点、同指标、同分组中对应角色的行。
  const factIds = [selectedFact.id];
  for (const id of evidence) if (!factIds.includes(id)) factIds.push(id);
  const failure: { reason?: string } = {}; let keyFigure: BoundClaim["keyFigure"];
  let rendered = claim.text.replace(/\{([^}]*)\}/g, (_match, name: string) => {
    const wanted: NodeRole = name === "value" ? valueRole : (name as NodeRole);
    const row = wanted === selected.role ? selected : sibling(wanted);
    const fact = row && factOf(row);
    if (!fact) { failure.reason ??= `占位符 {${name}} 在节点「${claim.node}」没有对应的数据行`; return ""; }
    if (fact.value === null && claim.assert !== "unavailable") { failure.reason ??= `占位符 {${name}} 的值暂无可计算值`; return ""; }
    if (!factIds.includes(fact.id)) factIds.push(fact.id);
    const text = formatRoleValue(fact, wanted); keyFigure ??= { value: text, factId: fact.id };
    return text;
  });
  if (failure.reason) return { reason: failure.reason };
  // 模型常在占位符后再写一遍单位（「{value}个」「{value}条」），填值后去掉重复的单位。
  rendered = dedupeUnits(rendered);
  // 重点数字只在问题的答案就是一个数时放大：只陈述数值的结论，或措辞里只有一个数。
  // 有好几个数的结论（目标、参照、变化并列），第一个不一定是重点，不放大。
  const single = claim.assert === "value" || used.length === 1;
  return { bound: { ...claim, factIds, rendered, confidence: confidenceOf(claim.node, claim.metric, execution), ...(keyFigure && single ? { keyFigure } : {}) } };
}

// literals：问题原文和用户此前说过的话；维度取值从执行结果的分组键里自动收集。
export function bindClaims(draft: ClaimDraft, execution: PlanExecution, literals: readonly string[] = []): Binding {
  const keyValues = [...execution.results.values()].flatMap((result) => [...result.rows.flatMap((row) => Object.values(row.key)), ...nodeLiterals(result.node)]);
  const forbidden = digitGuard(literals, keyValues);
  const dropped: Binding["dropped"] = [];
  const droppedText: DroppedText[] = [];
  const attempt = (claim: Claim): BoundClaim | undefined => {
    const outcome = bindOne(claim, execution, forbidden);
    if ("reason" in outcome) { dropped.push({ claim, reason: outcome.reason }); return undefined; }
    return outcome.bound;
  };
  // 纯文本条目不能带数字；带数字的剔除并记录。
  // 行动、不能下的结论和追问没有绑定数据行，占位符不会被填值，原样留下的 {change} 一并剔除。
  const textIssue = (text: string) => { if (/\{[^}]*\}/.test(text)) return NO_PLACEHOLDER; const digits = forbidden(text); return digits.length ? digitsReason(digits) : undefined; };
  const cleanText = (kind: DroppedText["kind"], items: string[]): string[] => items.filter((text) => {
    const reason = textIssue(text); if (!reason) return true;
    droppedText.push({ kind, text, reason });
    return false;
  });
  let headline = attempt(draft.headline);
  if (headline) { const issue = headlineIssue(headline, execution); if (issue) { dropped.push({ claim: draft.headline, reason: issue }); headline = undefined; } }
  // 序号映射：草稿里的 claims 序号 → 保留后的序号；被提升为 headline 或被丢弃的不在映射里。
  // 和主结论绑同一个数、做同一判断（同节点、分组、指标、角色、方向）的发现只是把主结论再说一遍，去掉。
  const rowOf = (claim: Claim) => JSON.stringify([claim.node, claim.metric, Object.entries(claim.select ?? {}).sort(), claim.role ?? null, claim.assert]);
  const kept: BoundClaim[] = []; const remap = new Map<number, number>();
  draft.claims.slice(0, MAX_CLAIMS).forEach((claim, index) => {
    if (headline && rowOf(claim) === rowOf(headline)) { dropped.push({ claim, reason: "与主结论重复：同一组数据已经在主结论里说过" }); return; }
    const bound = attempt(claim);
    if (bound) { remap.set(index, kept.length); kept.push(bound); }
  });
  // 主结论缺失时，由第一条可以当主结论（不是个案）的发现顶上，其余重新编号。
  const promoted = headline ? -1 : kept.findIndex((claim) => !headlineIssue(claim, execution));
  if (promoted >= 0) {
    headline = kept.splice(promoted, 1)[0];
    for (const [index, mapped] of [...remap]) { if (mapped === promoted) remap.delete(index); else if (mapped > promoted) remap.set(index, mapped - 1); }
  }
  const actions: Binding["actions"] = [];
  for (const action of draft.actions) {
    const issue = textIssue(action.text); if (issue) { droppedText.push({ kind: "action", text: action.text, reason: issue }); continue; }
    const mapped = remap.get(action.claim);
    if (mapped === undefined) { droppedText.push({ kind: "action", text: action.text, reason: "指向的结论已被丢弃或提升为主结论，行动无处挂靠" }); continue; }
    actions.push({ text: action.text, claim: mapped });
  }
  return { headline, claims: kept, actions: actions.slice(0, MAX_ACTIONS), dropped, droppedText, cannotConclude: cleanText("cannotConclude", draft.cannotConclude).slice(0, MAX_CANNOT), questions: cleanText("question", draft.questions) };
}
