import { DIMENSION_LABELS, type AnalysisReport, type AdvisorField, type AdvisorItem, type AdvisorSource, type Metrics } from "./types.ts";

const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
const number = (v: number) => v.toLocaleString("zh-CN", { maximumFractionDigits: 6 });

function businessPeriod(value: string): string {
  const month = /^(\d{4})-(\d{2})-01至\1-\2-(\d{2})$/.exec(value);
  return month && Number(month[3]) === new Date(Date.UTC(Number(month[1]), Number(month[2]), 0)).getUTCDate() ? `${month[1]}年${Number(month[2])}月` : value;
}

export function sourceStatement(label: string, fields: AdvisorField[]): string {
  return `${label}：${fields.filter((f) => f.value !== null).map((f) => `${f.label}${typeof f.value === "number" ? number(f.value) : f.value}${f.unit ?? ""}`).join("，")}。`;
}

function metricFields(metrics: Metrics): AdvisorField[] {
  return [
    { label: "明细", value: metrics.rows, unit: "条" },
    { label: "净销售额", value: metrics.sales, unit: "元" },
    { label: "净件数", value: metrics.quantity },
    { label: "毛利", value: metrics.grossProfit, unit: "元" },
    { label: "毛利率", value: metrics.grossMargin, unit: "%" },
    { label: "金重", value: metrics.weightGrams, unit: "克" },
    { label: "订单数", value: metrics.orders },
    { label: "独立会员数", value: metrics.members },
  ];
}

export function reportSource(report: AnalysisReport, evidenceId: string, prefix = "report", kind: AdvisorSource["kind"] = "report"): AdvisorSource {
  const group = report.groups.find((g) => g.id === evidenceId);
  if (evidenceId !== "overall" && !group) throw new Error("没有这条数据证据");
  const current = group ? group.current : report.metrics;
  const baseline = group ? group.baseline : report.baseline;
  const title = group ? `${DIMENSION_LABELS[group.dimension]}：${group.value}` : report.datasetName;
  const rows: AdvisorSource["rows"] = [];
  if (current?.rows) rows.push({ label: "分析期", fields: metricFields(current) });
  if (baseline?.rows) rows.push({ label: "比较期", fields: metricFields(baseline) });
  const change = group ? group.salesChangePercent : report.salesChangePercent;
  if (change !== null) rows.push({ label: "比较结果，仅为观测", fields: [{ label: "净销售额变化", value: change, unit: "%" }] });
  const statements = rows.map((r) => sourceStatement(r.label, r.fields));
  return {
    id: `${prefix}:${evidenceId}`, kind, title, provenance: report.provenance, datasetVersion: report.datasetVersion,
    periodLabel: `${report.query.period.start}至${report.query.period.end}${report.query.comparison ? `；比较${report.query.comparison.start}至${report.query.comparison.end}` : ""}`,
    scope: Object.entries(report.query.filters).filter(([, values]) => values?.length).map(([key, values]) => `${({ stores: "门店", regions: "区域", categories: "货类", campaignIds: "活动", memberSegments: "会员分组" } as Record<string, string>)[key]}：${values!.join("、")}`).join("；") || "当前授权数据，未附加筛选",
    definition: "净销售额按分汇总并扣退货；毛利为净销售额减成本，成本不完整时不计算；金重使用提供字段；差异不证明因果。",
    recordId: `${report.id || prefix}/${evidenceId}`, rows, statements, limitations: report.limitations,
    ...(kind === "report" ? { reportEvidenceId: evidenceId } : {}),
  };
}

export function isAdvisorSource(value: unknown): value is AdvisorSource {
  if (!object(value) || !text(value.id, 160) || !/^[\w:-]+$/.test(value.id as string) || !["report", "snapshot", "historical", "database"].includes(value.kind as string) ||
    !["imported", "sample"].includes(value.provenance as string) || !text(value.title, 300) || !text(value.datasetVersion, 160) ||
    !text(value.periodLabel, 300) || !text(value.scope, 12000) || !text(value.definition, 1600) || !text(value.recordId, 180) ||
    !Array.isArray(value.rows) || value.rows.length > 30 || !Array.isArray(value.statements) || value.statements.length > 30 ||
    value.statements.some((s) => !text(s, 2000)) || !Array.isArray(value.limitations) || value.limitations.length > 30 || value.limitations.some((s) => !text(s, 1200)) ||
    value.reportEvidenceId !== undefined && (value.kind !== "report" || !text(value.reportEvidenceId, 160)) ||
    value.capturedAt !== undefined && (!text(value.capturedAt, 40) || !Number.isFinite(Date.parse(value.capturedAt as string))) ||
    value.kind === "database" && (value.provenance !== "imported" || typeof value.capturedAt !== "string" || !/^[a-f0-9]{64}$/.test(value.datasetVersion as string))) return false;
  return value.rows.every((r) => object(r) && text(r.label, 300) && Array.isArray(r.fields) && r.fields.length <= 30 && r.fields.every((f) => object(f) && text(f.label, 180) &&
    (f.value === null || typeof f.value === "number" && Number.isFinite(f.value) || text(f.value, 300)) && (f.unit === undefined || text(f.unit, 40))));
}

class AdviceValidationError extends Error {}

const normalizeReference = (value: string) => value.normalize("NFKC").replace(/[\s\u200B-\u200D\uFEFF]/g, "");
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function withoutSourceReferences(value: string, sources: readonly AdvisorSource[]): string {
  let remainder = value;
  const names = new Set(sources.flatMap((source) => [source.title, ...source.rows.map((row) => row.label), ...source.scope.split("；").flatMap((part) => {
    const filter = /^(?:门店|分店|店号|区域|大区|分区|货类|活动|开单优惠名称|材料|商品|会员分组|是否会员销售|分店性质)[:：](.+)$/.exec(part);
    return filter ? filter[1].split("、") : [];
  })]).map(normalizeReference).filter(Boolean));
  // 仅豁免本条实际引用的对象；纯数字编号必须带对象称谓，后接数量或金额单位仍核验。
  const units = new Set(["个百分点", "百分点", "百分比", "元", "块", "克", "公斤", "千克", "件", "单", "人", "名", "家", "店", "折", "成", "倍", "价", "年", "月", "日", "个", "条", "笔", "次", "位", "间", "组", "份", "套", "对", "支", "双", "批", "项", "斤", "吨", "天", "周", "小时", "分钟", "秒", "点", "基点",
    ...sources.flatMap((source) => source.rows.flatMap((row) => row.fields.flatMap((field) => field.unit ? [normalizeReference(field.unit)] : [])))]);
  const tail = `(?![0-9零〇一二两三四五六七八九十百千万亿%]|(?:余|多|来|左右|上下)?(?:${[...units].map(escapePattern).join("|")}))`;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    const pattern = escapePattern(name);
    const quoted = `(?:「${pattern}」|“${pattern}”|"${pattern}"|\`${pattern}\`)`;
    const named = /[^0-9零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟萬億半年月日元块克公斤千件单人名家店折成倍价%.,，:/-]/.test(name);
    const reference = named ? `(?:${quoted}|${pattern})` : `(?:门店|分店|店号|活动|优惠|货类|货品|商品|区域|分区|大区)[:：]?(?:${quoted}|${pattern})`;
    remainder = remainder.replace(new RegExp(`${reference}${tail}`, "g"), "来源对象");
  }
  const dates = new Set(sources.flatMap((source) => [businessPeriod(source.periodLabel), ...(source.periodLabel.match(/\d{4}-\d{2}-\d{2}/g) ?? []).flatMap((date) => {
    const [year, month, day] = date.split("-").map(Number);
    return [date, `${year}年${month}月${day}日`, `${year}年${month}月`];
  })]).map(normalizeReference));
  for (const date of [...dates].sort((a, b) => b.length - a.length)) remainder = remainder.replace(new RegExp(`${escapePattern(date)}${tail}`, "g"), "来源周期");
  return remainder;
}

function qualitative(textValue: string, sources: readonly AdvisorSource[]): void {
  const normalized = normalizeReference(textValue);
  // 单独的“千克”是单位；带数量的“一千克”等仍属于经营数字。
  const quantities = withoutSourceReferences(normalized, sources).replace(/(?<![零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟萬億半])千克/g, "");
  if (/[0-9%]|百分之|一半|减半|翻(?:番|倍)|[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟萬億]+分之[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟萬億]+|[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟萬億半]+(?:余|多|来|左右|上下)?(?:个百分点|百分比|元|块|克|公斤|千克|件|单|人|名|家|店|折|成|倍|价)/.test(quantities)) throw new AdviceValidationError("模型不能补写经营数字，请引用代码生成的数据观察");
  if (/保证(?:收益|增长|增量)|必然(?:增长|提升)|已(?:经)?证明|全局最优/.test(normalized)) throw new AdviceValidationError("历史证据不能证明因果、最优力度或未来收益");
}

function composeAdviceStrict(value: unknown, availableSources: readonly AdvisorSource[], mode: "model" | "response" = "model") {
  if (!Array.isArray(value) || value.length > 9) throw new AdviceValidationError("营销回答格式不正确");
  const advice: AdvisorItem[] = []; const ids = new Set<string>();
  for (const entry of value) {
    if (!object(entry) || !["observation", "hypothesis", "recommendation", "question"].includes(entry.kind as string) || !text(entry.text, 8000) ||
      !Array.isArray(entry.evidenceIds) || entry.evidenceIds.length > 3 || entry.evidenceIds.some((id) => typeof id !== "string")) throw new AdviceValidationError("营销回答的条目格式不正确");
    let target = entry.target === null ? undefined : entry.target;
    if (target !== undefined) {
      if (!["recommendation", "observation"].includes(entry.kind as string) || !object(target) || !text(target.sourceId, 160) || !text(target.label, 300)) throw new AdviceValidationError("建议候选格式不正确");
      const candidate = target;
      const source = availableSources.find((s) => s.id === candidate.sourceId);
      if (!source || source.title !== candidate.label && !source.rows.some((r) => r.label === candidate.label) || /^(分析期|比较期|比较结果|结果\d+)/.test(candidate.label as string)) throw new AdviceValidationError("建议候选不是已经读取的真实对象");
      // 兼容旧输出合同中的重复对象；数字仍只从已经引用的证据生成。
      if (entry.kind === "observation") {
        if (!entry.evidenceIds.includes(target.sourceId)) throw new AdviceValidationError("数据观察的重复候选必须已经引用真实证据");
        target = undefined;
      }
    }
    const evidenceIds = [...new Set([...(entry.evidenceIds as string[]), ...(target ? [(target as { sourceId: string }).sourceId] : [])])];
    if (evidenceIds.length > 3) throw new AdviceValidationError("单条建议引用的数据来源过多，超过上限");
    const metricLabels = Array.isArray(entry.metricLabels) && !entry.metricLabels.length ? undefined : entry.metricLabels;
    if (metricLabels !== undefined && (entry.kind !== "observation" || !Array.isArray(metricLabels) || !metricLabels.length || metricLabels.length > 6 || metricLabels.some((label) => !text(label, 180)))) throw new AdviceValidationError("数据观察的指标选择无效");
    const sources = evidenceIds.map((id) => {
      const source = availableSources.find((s) => s.id === id);
      if (!source || !source.statements.length) throw new AdviceValidationError("营销回答引用了不存在或未读取的数据来源");
      ids.add(id); return source;
    });
    let itemText = entry.text as string;
    if (entry.kind === "observation") {
      if (!sources.length) throw new AdviceValidationError("数据观察需要真实证据来源");
      const canonical = sources.map((s) => {
        const requested = metricLabels as string[] | undefined;
        let statements = s.statements.slice(0, 3);
        if (requested) {
          if (requested.some((label) => !sources.some((source) => source.rows.some((r) => r.fields.some((f) => f.label === label))))) throw new AdviceValidationError("数据来源没有该指标，不能引用");
          const selected = s.rows.map((r) => ({ label: r.label, fields: r.fields.filter((f) => requested.includes(f.label) && f.value !== null) })).filter((r) => r.fields.length);
          if (!selected.length) throw new AdviceValidationError("该来源没有所选指标的有效值，不能补零");
          statements = selected.slice(0, 3).map((r) => sourceStatement(r.label, r.fields));
        }
        if (s.kind === "database") {
          const rows = s.rows.map((row) => row.fields.filter((field) => field.value !== null && (!requested || requested.includes(field.label)))).filter((fields) => fields.length).slice(0, 3);
          const facts = rows.map((fields) => fields.map((field) => `${field.label}为${typeof field.value === "number" ? number(field.value) : field.value}${field.unit === "人民币" ? "元" : field.unit ?? ""}`).join("，")).join("；");
          return `${businessPeriod(s.periodLabel)}${s.title.startsWith("整体：") ? "" : `，${s.title}`}：${facts}。`;
        }
        return `【${s.title}；${s.periodLabel}】${statements.join(" ")}`;
      }).join(" ");
      if (mode === "model" && itemText.trim() || mode === "response" && itemText !== canonical) throw new AdviceValidationError("已观测数字和事实句必须由数据证据生成");
      itemText = canonical;
    } else {
      if (!itemText.trim() || itemText.length > 500) throw new AdviceValidationError("请提供简短的解释或建议");
      qualitative(itemText, sources);
    }
    advice.push({ kind: entry.kind as AdvisorItem["kind"], text: itemText, evidenceIds, ...(metricLabels ? { metricLabels: [...new Set(metricLabels as string[])] } : {}), ...(target ? { target: { sourceId: String((target as Record<string, unknown>).sourceId), label: String((target as Record<string, unknown>).label) } } : {}) });
  }
  if (ids.size > 12) throw new AdviceValidationError("营销回答引用的数据来源过多，请先聚焦当前问题");
  return { advice, sources: availableSources.filter((s) => ids.has(s.id)) };
}

export function composeAdvice(value: unknown, availableSources: readonly AdvisorSource[], mode: "model" | "response" | "partial" = "model"): { advice: AdvisorItem[]; sources: AdvisorSource[]; partial?: boolean } {
  if (mode !== "partial") return composeAdviceStrict(value, availableSources, mode);
  if (!Array.isArray(value) || value.length > 9) throw new AdviceValidationError("营销回答格式不正确");
  const advice: AdvisorItem[] = []; const ids = new Set<string>(); let partial = false;
  for (const entry of value) {
    try {
      // 数据观察即使夹带手写数字，也只采用相同引用与指标选择下的代码生成结果。
      const repaired = object(entry) && entry.kind === "observation" && text(entry.text, 8000) && (entry.text as string).trim() ? { ...entry, text: "" } : entry;
      const result = composeAdviceStrict([repaired], availableSources);
      const combined = new Set([...ids, ...result.advice[0].evidenceIds]);
      if (combined.size > 12) throw new AdviceValidationError("营销回答引用的数据来源过多，请先聚焦当前问题");
      result.advice[0].evidenceIds.forEach((id) => ids.add(id)); advice.push(result.advice[0]);
      if (repaired !== entry) partial = true;
    } catch (error) {
      if (!(error instanceof AdviceValidationError)) throw error;
      partial = true;
    }
  }
  if (partial && !advice.some((item) => item.kind === "observation")) {
    const referenced = new Set(value.flatMap((entry) => object(entry) && Array.isArray(entry.evidenceIds) ? entry.evidenceIds : []));
    const candidates = availableSources.filter((source) => source.statements.length).sort((a, b) => Number(ids.has(b.id) || referenced.has(b.id)) - Number(ids.has(a.id) || referenced.has(a.id)));
    const fallback: AdvisorSource[] = [];
    for (const source of candidates) {
      if (fallback.length === 3) break;
      if (!ids.has(source.id) && ids.size === 12) continue;
      fallback.push(source); ids.add(source.id);
    }
    if (fallback.length) advice.unshift(...composeAdviceStrict([{ kind: "observation", text: "", evidenceIds: fallback.map((source) => source.id) }], fallback).advice);
  }
  return { ...composeAdviceStrict(advice, availableSources, "response"), ...(partial ? { partial: true } : {}) };
}

export function citationNumbers(advice: readonly AdvisorItem[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const item of advice) for (const id of item.evidenceIds) if (!result.has(id)) result.set(id, result.size + 1);
  return result;
}
