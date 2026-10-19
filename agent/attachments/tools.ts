import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { attachmentTableRows, type AttachmentSource, type AttachmentTable, type DocumentBlock } from "../../app/lib/attachments/types.ts";
import type { AttachmentScope, AttachmentStore } from "./store.ts";
import type { AttachmentCalculation } from "../../app/lib/analytics/visualization-types.ts";

export type ReadAttachmentInput = { attachmentId: string; offset?: number; limit?: number; tableId?: string };
export type TableCalculationInput = { attachmentId: string; tableId: string; operation: "sum" | "count" | "distinct" | "average" | "min" | "max"; column?: string; filters?: Array<{ column: string; operator: "equals" | "not_equals" | "contains" | "gte" | "lte"; value: string }>; groupBy?: string[]; offset?: number; limit?: number };
export type DeriveInput = { operation: "ratio" | "difference" | "change_rate"; numeratorSourceId?: string; denominatorSourceId?: string; numeratorRef?: string; denominatorRef?: string; label?: string; offset?: number; limit?: number };
type Decimal = { value: bigint; scale: number };
const decimal = (value: string): Decimal | null => {
  const raw = value.trim();
  if (raw.includes(",") && !/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) throw new Error("表格数字的逗号分隔存在歧义，不能猜测小数点或千分位");
  const text = raw.replace(/,/g, "");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (whole.length + fraction.length > 40 || fraction.length > 18) throw new Error("表格数值精度超过受控计算范围");
  return { value: BigInt(whole + fraction), scale: fraction.length };
};
const power = (n: number) => BigInt(10) ** BigInt(n);
const align = (a: Decimal, b: Decimal) => { const scale = Math.max(a.scale, b.scale); return { a: a.value * power(scale - a.scale), b: b.value * power(scale - b.scale), scale }; };
const add = (a: Decimal, b: Decimal): Decimal => { const pair = align(a, b); return { value: pair.a + pair.b, scale: pair.scale }; };
const format = ({ value, scale }: Decimal) => { const sign = value < BigInt(0) ? "-" : ""; const digits = (value < BigInt(0) ? -value : value).toString().padStart(scale + 1, "0"); const text = scale ? digits.slice(0, -scale) + "." + digits.slice(-scale) : digits; return sign + text.replace(/\.0+$|(?<=\.[0-9]*?)0+$/g, ""); };
const integer = (value: number | undefined, fallback: number, max: number) => { const number = value ?? fallback; if (!Number.isSafeInteger(number) || number < 0 || number > max) throw new Error("文件分页参数不正确"); return number; };

export function createAttachmentTools(store: AttachmentStore, scope: AttachmentScope, attachmentIds: readonly string[], options: { captureCalculations?: boolean } = {}) {
  const calculations = new Map<string, AttachmentCalculation>();
  const operands = new Map<string, { value: string; label: string; summary: Awaited<ReturnType<typeof store.get>> }>();
  const groupedResults = new Map<string, { summary: Awaited<ReturnType<typeof store.get>>; groupBy: string[]; label: string; unit: string; table?: { id: string; location: string }; groups: Array<{ labels: string[]; value: string | null }> }>();
  const calculatedGroups = new Map<string, Promise<Array<{ labels: string[]; value: string | null; matchedRows: number; missingRows: number }>>>();
  const allowed = new Set(attachmentIds); const sourceMap = new Map<string, AttachmentSource>(); const sourceKeys = new Map<string, string>();
  const readBlocks = new Set<string>(); const readImages = new Set<string>();
  const authorized = async (attachmentId: string) => { if (!allowed.has(attachmentId)) throw new Error("无权读取本轮未授权的附件"); return store.document(scope, attachmentId); };
  const tableRows = async function* (attachmentId: string, table: AttachmentTable, offset = 0, limit = 200000) {
    if (table.rowStore) { yield* store.rows(scope, attachmentId, table.id, offset, limit); return; }
    for (let index = offset; index < Math.min(table.rows.length, offset + limit); index++) yield { values: table.rows[index], rowNumber: table.rowNumbers[index], rowEndNumber: table.rowEndNumbers?.[index] };
  };
  const register = (summary: Awaited<ReturnType<typeof store.get>>, location: string, kind: AttachmentSource["kind"], excerpt: string, extra: Partial<AttachmentSource> = {}): AttachmentSource => {
    const key = createHash("sha256").update(JSON.stringify([summary.id, summary.version, location, kind, excerpt, extra])).digest("hex");
    const known = sourceKeys.get(key); if (known) return sourceMap.get(known)!;
    if (sourceMap.size >= 3000) throw new Error("本轮已读取较多文件依据，请围绕已读内容完成回答");
    const source: AttachmentSource = { id: "s" + (sourceMap.size + 1), attachmentId: summary.id, version: summary.version, name: summary.name, location, kind, excerpt: excerpt.slice(0, 12000), ...extra };
    sourceMap.set(source.id, source); sourceKeys.set(key, source.id); return source;
  };
  const bind = (summary: Awaited<ReturnType<typeof store.get>>, block: DocumentBlock) => {
    if (block.kind !== "image") readBlocks.add(`${summary.id}/${block.id}`);
    const location = `${block.archivePath ? block.archivePath + " · " : ""}${block.location}`;
    return { ...block, ...(block.kind !== "image" && block.text.trim() ? { sourceId: register(summary, location, "document", block.text).id } : {}) };
  };
  const read = async ({ attachmentId, offset, limit, tableId }: ReadAttachmentInput) => {
    const { summary, document } = await authorized(attachmentId); const start = integer(offset, 0, 200000); const size = Math.max(1, integer(limit, 8, 40));
    if (tableId) {
      const table = document.tables.find((item) => item.id === tableId); if (!table) throw new Error("表格不存在");
      const rows = [];
      for await (const { values: row, rowNumber, rowEndNumber: rowEnd } of tableRows(attachmentId, table, start, size)) {
        const location = `${table.archivePath ? table.archivePath + " · " : ""}${table.location} · 原始行 ${rowNumber}${rowEnd && rowEnd !== rowNumber ? "—" + rowEnd : ""}`;
        rows.push({ rowNumber, values: row, sourceId: register(summary, location, "table", table.columns.map((name, column) => `${name}：${row[column] ?? "未提供"}`).join("；")).id });
      }
      const total = attachmentTableRows(table);
      return { name: summary.name, columns: table.columns, rows, paging: { offset: start, total, nextOffset: start + size < total ? start + size : null }, warnings: table.warnings, mergedCells: table.mergedCells, calculationBlocked: table.calculationBlocked };
    }
    const blocks = document.blocks.slice(start, start + size).map((block) => bind(summary, block));
    return { name: summary.name, blocks, paging: { offset: start, total: document.blocks.length, nextOffset: start + size < document.blocks.length ? start + size : null }, warnings: summary.warnings };
  };
  const calculate = async (input: TableCalculationInput) => {
    const { summary, document } = await authorized(input.attachmentId); const table = document.tables.find((item) => item.id === input.tableId);
    if (!table) throw new Error("表格不存在");
    if (table.calculationBlocked) throw new Error(table.calculationBlocked);
    const column = (name: string | undefined) => { const index = name === undefined ? -1 : table.columns.indexOf(name); if (index < 0) throw new Error("请选择文件中的真实表格列名"); return index; };
    if (!["sum", "count", "distinct", "average", "min", "max"].includes(input.operation)) throw new Error("不支持这个表格计算方法");
    const target = input.column === undefined && input.operation === "count" ? -1 : column(input.column);
    if ((input.filters?.length ?? 0) > 12 || (input.groupBy?.length ?? 0) > 3) throw new Error("表格筛选或分组过多");
    const filters = (input.filters ?? []).map((filter) => ({ ...filter, index: column(filter.column) }));
    const groupIndexes = (input.groupBy ?? []).map(column);
    const offset = integer(input.offset, 0, 10000); const limit = Math.max(1, integer(input.limit, 30, 100));
    const calculationKey = "calc-" + createHash("sha256").update(JSON.stringify([summary.id, summary.version, input.tableId, input.operation, input.column, input.filters ?? [], input.groupBy ?? []])).digest("hex");
    let calculation = calculatedGroups.get(calculationKey);
    if (!calculation) {
      if (calculatedGroups.size >= 100) throw new Error("本轮表格计算记录较多，请复用已有结果");
      calculation = (async () => {
        type Group = { labels: string[]; matchedRows: number; missingRows: number; presentRows: number; total: Decimal; extreme?: Decimal; distinct: Set<string> };
        const groups = new Map<string, Group>();
        const emptyGroup = (labels: string[]): Group => ({ labels, matchedRows: 0, missingRows: 0, presentRows: 0, total: { value: BigInt(0), scale: 0 }, distinct: new Set() });
        for await (const { values: row } of tableRows(input.attachmentId, table)) {
          const matches = filters.every((filter) => {
            const value = row[filter.index]; if (value === null || value === undefined) return false;
            if (filter.operator === "equals") return value === filter.value;
            if (filter.operator === "not_equals") return value !== filter.value;
            if (filter.operator === "contains") return value.includes(filter.value);
            if (filter.operator !== "gte" && filter.operator !== "lte") throw new Error("表格筛选方法不正确");
            const left = decimal(value); const right = decimal(filter.value); if (!left || !right) throw new Error("范围筛选需要可识别的数字，不能猜测文字含义");
            const pair = align(left, right); return filter.operator === "gte" ? pair.a >= pair.b : pair.a <= pair.b;
          });
          if (!matches) continue;
          const labels = groupIndexes.map((index) => row[index] ?? "未提供"); const key = JSON.stringify(labels);
          if (!groups.has(key)) groups.set(key, emptyGroup(labels));
          if (groups.size > 10000) throw new Error("表格分组超过 10000 组，请缩小分组范围");
          const group = groups.get(key)!; group.matchedRows++;
          if (target < 0) continue;
          const present = row[target];
          if (present === null || present === undefined || present.trim() === "") { group.missingRows++; continue; }
          group.presentRows++;
          if (input.operation === "count") continue;
          if (input.operation === "distinct") { group.distinct.add(present); continue; }
          const value = decimal(present); if (!value) throw new Error("所选列包含非数字内容，不能自动忽略或转成零");
          if (input.operation === "min" || input.operation === "max") {
            const pair = group.extreme ? align(group.extreme, value) : undefined;
            if (!pair || (input.operation === "min" ? pair.b < pair.a : pair.b > pair.a)) group.extreme = value;
          } else group.total = add(group.total, value);
        }
        if (!groups.size && !groupIndexes.length) groups.set("[]", emptyGroup([]));
        return [...groups.values()].map(({ labels, matchedRows, missingRows, presentRows, total: sum, extreme, distinct }) => {
          let value: string | null;
          if (input.operation === "count") value = String(target < 0 ? matchedRows : presentRows);
          else if (input.operation === "distinct") value = String(distinct.size);
          else {
            if (!presentRows) value = null;
            else if (input.operation === "min" || input.operation === "max") value = format(extreme!);
            else {
              let total = sum;
              if (input.operation === "average") {
                const scale = 6; const numerator = total.value * power(scale); const divisor = BigInt(presentRows) * power(total.scale); const sign = numerator < BigInt(0) ? -BigInt(1) : BigInt(1);
                total = { value: (numerator * sign + divisor / BigInt(2)) / divisor * sign, scale };
              }
              value = format(total);
            }
          }
          return { labels, value, matchedRows, missingRows };
        });
      })();
      calculatedGroups.set(calculationKey, calculation);
      void calculation.catch(() => { calculatedGroups.delete(calculationKey); });
    }
    const computed = await calculation;
    const fullTableRows = attachmentTableRows(table);
    const operationLabels = { sum: "求和", count: "计数", distinct: "去重计数", average: "均值（最多保留六位小数）", min: "最小值", max: "最大值" };
    // 降序名次和组数写进来源，正文说「排第 2」「共 36 组」时有据可查。
    const ranked = computed.map((group, index) => ({ index, value: group.value === null ? null : decimal(group.value) })).filter((item): item is { index: number; value: Decimal } => item.value !== null)
      .sort((x, y) => { const pair = align(x.value, y.value); return pair.a === pair.b ? 0 : pair.a > pair.b ? -1 : 1; });
    const rankOf = new Map(ranked.map((item, position) => [item.index, position + 1]));
    const results = computed.map(({ labels, value, matchedRows, missingRows }, index) => {
      const location = `${table.archivePath ? table.archivePath + " · " : ""}${table.location} · ${operationLabels[input.operation]}`;
      const excerpt = `${input.groupBy?.map((name, index) => `${name}：${labels[index]}`).join("；") ?? "全部选定记录"}；列：${input.column ?? "记录"}；${operationLabels[input.operation]}：${value ?? "未提供"}；${groupIndexes.length ? `共 ${computed.length} 组；${rankOf.has(index) ? `降序第 ${rankOf.get(index)} 名；` : ""}` : ""}全表记录：${fullTableRows}；满足筛选：${matchedRows}；缺失：${missingRows}；${filters.length ? `筛选：${JSON.stringify(input.filters)}；` : ""}${missingRows ? "计算仅覆盖非空有效值，不能称为含缺失项的完整总额；" : ""}${table.warnings.join("；")}`;
      const sourceId = !groupIndexes.length || index >= offset && index < offset + limit ? register(summary, location, "table", excerpt).id : "";
      if (sourceId && value !== null) operands.set(sourceId, { value, label: `${labels.length ? labels.join("、") + " · " : ""}${input.column ?? "记录"}${operationLabels[input.operation]}`, summary });
      return { labels, value, matchedRows, missingRows, sourceId };
    });
    let calculationId: string | undefined;
    if (options.captureCalculations) {
      calculationId = calculationKey;
      if (!calculations.has(calculationId) && calculations.size >= 100) throw new Error("本轮表格计算记录较多，请复用已有结果");
      const unit = input.operation === "count" || input.operation === "distinct" ? "条" : /率|占比|比例/.test(input.column ?? "") && !/[（(_](元|克|件)[）)]?$/.test(input.column ?? "") && ["average", "min", "max"].includes(input.operation) ? "比率" : input.column?.match(/[（(](元|CNY|人民币|USD|美元|HKD|港元|克|件|%|％)[）)]/)?.[1]?.replace(/^(?:CNY|人民币)$/, "元") ?? "原表数值，单位未提供";
      const computationSource = register(summary, `${table.location} · 完整分组计算`, "table", `完整表格计算；列：${input.column ?? "记录"}；方法：${input.operation}；分组：${(input.groupBy ?? []).join("、")}；共 ${results.length} 组；源表 ${fullTableRows} 行。具体精确值由绑定的结构化计算结果保存。`, { calculationId });
      calculations.set(calculationId, { id: calculationId, attachmentId: summary.id, version: summary.version, tableId: table.id, name: summary.name, location: `${table.archivePath ? table.archivePath + " · " : ""}${table.location}`, operation: input.operation, ...(input.column ? { column: input.column } : {}), groupBy: [...(input.groupBy ?? [])], unit, filters: structuredClone(input.filters ?? []), groupCount: results.length, groups: results.map(({ labels, value, matchedRows, missingRows }) => ({ labels, value, matchedRows, missingRows, sourceId: computationSource.id })), warnings: [...table.warnings] });
    }
    groupedResults.set(calculationKey, { summary, groupBy: [...(input.groupBy ?? [])], label: `${input.column ?? "记录"}${operationLabels[input.operation]}`, unit: calculationId ? calculations.get(calculationId)!.unit : "原表数值，单位未提供", table: { id: table.id, location: `${table.archivePath ? table.archivePath + " · " : ""}${table.location}` }, groups: computed.map(({ labels, value }) => ({ labels, value })) });
    const captured = { ...(calculationId ? { calculationId } : {}), resultRef: calculationKey };
    if (!groupIndexes.length) return { ...results[0], warnings: table.warnings, fullTableRows, ...captured };
    return { groups: results.slice(offset, offset + limit), groupCount: computed.length, paging: { offset, total: computed.length, nextOffset: offset + limit < computed.length ? offset + limit : null }, warnings: table.warnings, fullTableRows, ...captured };
  };
  // 比值、差值、变化率由代码从已算出的结果推出，模型不用心算 ROI、占比、达成率。
  // 来源写明两个操作数和公式，正文里的派生数字就能绑定到它。
  const derive = async (input: DeriveInput) => {
    const ratioLike = input.operation !== "difference";
    const compute = (left: string, right: string): string | null => {
      const a = decimal(left); const b = decimal(right); if (!a || !b) return null;
      if (input.operation === "difference") { const pair = align(a, b); return format({ value: pair.a - pair.b, scale: pair.scale }); }
      const pair = align(a, b); if (pair.b === BigInt(0)) return null;
      const numerator = input.operation === "change_rate" ? pair.a - pair.b : pair.a;
      const scale = 6; const scaled = numerator * power(scale) * BigInt(2) / pair.b; const sign = scaled < BigInt(0) ? -BigInt(1) : BigInt(1);
      return format({ value: (scaled * sign + BigInt(1)) / BigInt(2) * sign, scale });
    };
    const names = { ratio: "比值", difference: "差值", change_rate: "变化率" } as const;
    const formula = input.operation === "ratio" ? "A ÷ B" : input.operation === "difference" ? "A − B" : "(A − B) ÷ B";
    const percent = (value: string) => { const parsed = decimal(value)!; return format({ value: parsed.value * BigInt(100), scale: parsed.scale }) + "%"; };
    const describe = (value: string | null) => value === null ? "无法计算（缺值或分母为零）" : ratioLike ? `${value}（即 ${percent(value)}）` : value;
    if (input.numeratorSourceId || input.denominatorSourceId) {
      const left = operands.get(input.numeratorSourceId ?? ""); const right = operands.get(input.denominatorSourceId ?? "");
      if (!left || !right) throw new Error("派生计算只接受本轮表格计算返回的 sourceId，且两个都要提供");
      const value = compute(left.value, right.value);
      const source = register(left.summary, `派生计算 · ${names[input.operation]}`, "table", `${names[input.operation]}（${formula}）：${describe(value)}；A：${left.label} ${left.value}；B：${right.label} ${right.value}；${input.label ? `含义：${input.label}；` : ""}由代码按完整计算结果推出`);
      if (value !== null) operands.set(source.id, { value, label: input.label ?? names[input.operation], summary: left.summary });
      return { value, sourceId: source.id };
    }
    const left = groupedResults.get(input.numeratorRef ?? ""); const right = groupedResults.get(input.denominatorRef ?? "");
    if (!left || !right) throw new Error("请二选一：单个数值传 numeratorSourceId 和 denominatorSourceId（计算结果里的 sourceId）；逐组派生传 numeratorRef 和 denominatorRef（计算结果里的 resultRef，分母可以是不分组的总数）");
    // 分母是不分组的总数时，每组都除以它（各组占比）；否则两边分组列必须相同，逐组对应。
    const broadcast = !right.groupBy.length && right.groups.length === 1;
    if (!broadcast && JSON.stringify(left.groupBy) !== JSON.stringify(right.groupBy)) throw new Error("两个分组计算的分组列必须相同，或分母是不分组的总数，才能逐组派生");
    const byLabel = new Map(right.groups.map((group) => [JSON.stringify(group.labels), group.value]));
    const rows = left.groups.map((group) => { const other = broadcast ? right.groups[0].value : byLabel.get(JSON.stringify(group.labels)); return { labels: group.labels, a: group.value, b: other ?? null, value: group.value !== null && other !== null && other !== undefined ? compute(group.value, other) : null }; });
    const ranked = rows.filter((row) => row.value !== null).sort((x, y) => { const pair = align(decimal(x.value!)!, decimal(y.value!)!); return pair.a === pair.b ? 0 : pair.a > pair.b ? -1 : 1; });
    const offset = integer(input.offset, 0, 10000); const limit = Math.max(1, integer(input.limit, 30, 100));
    const ordered = [...ranked, ...rows.filter((row) => row.value === null)];
    const groups = ordered.slice(offset, offset + limit).map((row, index) => {
      const location = `派生计算 · ${names[input.operation]} · 按${left.groupBy.join("、")}`;
      const source = register(left.summary, location, "table", `${left.groupBy.map((name, i) => `${name}：${row.labels[i]}`).join("；")}；${names[input.operation]}（${formula}）：${describe(row.value)}；A：${left.label} ${row.a ?? "未提供"}；B：${right.label} ${row.b ?? "未提供"}；${row.value !== null ? `降序第 ${offset + index + 1} 名；` : ""}共 ${rows.length} 组；${input.label ? `含义：${input.label}；` : ""}由代码按完整计算结果推出`);
      if (row.value !== null) operands.set(source.id, { value: row.value, label: `${row.labels.join("、")} · ${input.label ?? names[input.operation]}`, summary: left.summary });
      return { labels: row.labels, value: row.value, sourceId: source.id };
    });
    // 逐组派生的完整结果也登记成可画图的计算，图表能直接用 ROI、占比这类指标。
    let calculationId: string | undefined;
    if (options.captureCalculations && left.table) {
      calculationId = "calc-" + createHash("sha256").update(JSON.stringify(["derive", input.operation, input.numeratorRef, input.denominatorRef, input.label ?? ""])).digest("hex");
      if (!calculations.has(calculationId)) {
        if (calculations.size >= 100) throw new Error("本轮表格计算记录较多，请复用已有结果");
        const computationSource = register(left.summary, `派生计算 · ${names[input.operation]} · 完整分组`, "table", `派生计算；${input.label ?? names[input.operation]}（${formula}）；分组：${left.groupBy.join("、")}；共 ${rows.length} 组。具体精确值由绑定的结构化计算结果保存。`, { calculationId });
        calculations.set(calculationId, { id: calculationId, attachmentId: left.summary.id, version: left.summary.version, tableId: left.table.id, name: left.summary.name, location: left.table.location, operation: input.operation, column: input.label ?? names[input.operation], groupBy: [...left.groupBy], unit: ratioLike ? "比率" : left.unit, filters: [], groupCount: rows.length, groups: rows.map((row) => ({ labels: row.labels, value: row.value, matchedRows: 0, missingRows: row.value === null ? 1 : 0, sourceId: computationSource.id })), warnings: [] });
      }
    }
    return { ...(calculationId ? { calculationId } : {}), groups, groupCount: rows.length, order: "按派生值降序，无法计算的排末尾", paging: { offset, total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null } };
  };
  return {
    read, calculate, derive,
    async list() { return Promise.all([...allowed].map(async (attachmentId) => { const { summary, document } = await authorized(attachmentId); return { ...summary, tables: document.tables.map((table) => ({ id: table.id, name: table.name, location: table.location, archivePath: table.archivePath, columns: table.columns, rows: attachmentTableRows(table), warnings: table.warnings, mergedCells: table.mergedCells, calculationBlocked: table.calculationBlocked })), images: document.images, sections: document.blocks.filter((block) => block.kind === "heading").slice(0, 100), totalBlocks: document.blocks.length }; })); },
    async search({ query, attachmentId, limit }: { query: string; attachmentId?: string; limit?: number }) {
      if (!query.trim() || query.length > 200) throw new Error("请提供有效的文件检索词");
      const size = Math.max(1, integer(limit, 10, 30)); const chars = [...query.toLowerCase()]; const terms = [...new Set([...(query.toLowerCase().match(/[a-z0-9]+/g) ?? []), ...chars.flatMap((char, index) => /[\u3400-\u9fff]/.test(char) && chars[index + 1] && /[\u3400-\u9fff]/.test(chars[index + 1]) ? [char + chars[index + 1]] : [])])];
      const matches: Array<{ summary: Awaited<ReturnType<typeof store.get>>; block: DocumentBlock; score: number }> = [];
      for (const currentId of attachmentId ? [attachmentId] : allowed) {
        const { summary, document } = await authorized(currentId);
        for (const block of document.blocks.filter((block) => block.kind !== "image")) { const content = block.text.toLowerCase(); const score = (content.includes(query.toLowerCase()) ? 100 : 0) + terms.filter((term) => content.includes(term)).length; if (score) matches.push({ summary, block, score }); }
      }
      return { matches: matches.sort((a, b) => b.score - a.score).slice(0, size).map(({ summary, block }) => ({ attachmentId: summary.id, name: summary.name, ...bind(summary, block) })), totalMatches: matches.length, coverage: "检索命中不表示已读完全文或完整表格；汇总请调用表格计算" };
    },
    async image({ attachmentId, imageId }: { attachmentId: string; imageId: string }) { await authorized(attachmentId); const asset = await store.image(scope, attachmentId, imageId); return { ...asset, data: (await readFile(asset.path)).toString("base64") }; },
    async recordImage(attachmentId: string, imageId: string, description: string) { const { summary, document } = await authorized(attachmentId); const image = document.images.find((image) => image.id === imageId); if (!image) throw new Error("图片不存在"); readImages.add(`${attachmentId}/${imageId}`); return register(summary, `${image.archivePath ? image.archivePath + " · " : ""}${image.location} · 视觉观察（可能存在识别误差）`, "image", description, { imageId }); },
    async recordDatabase(answer: import("../../app/lib/analytics/analysis-v2-types.ts").PlanAnswerV4) { const first = [...allowed][0]; const { summary } = await authorized(first); return answer.evidence.facts.map((fact) => register(summary, `${answer.question} · ${fact.label}`, "database", `${fact.label}：${fact.value ?? "未提供"}${fact.unit}；${fact.definition}；${fact.limitations.join("；")}`, { name: "历史经营数据", databaseRunId: answer.runId, databaseFactId: fact.id })); },
    sources: () => [...sourceMap.values()],
    visualizationEvidence: () => ({ calculations: structuredClone([...calculations.values()]), sources: [...sourceMap.values()] }),
    async coverage() { return Promise.all([...allowed].map(async (attachmentId) => { const { summary, document } = await authorized(attachmentId); return { name: summary.name, status: summary.status, entries: summary.entries, textBlocks: document.blocks.filter((block) => block.kind !== "image").length, readTextBlocks: document.blocks.filter((block) => readBlocks.has(`${attachmentId}/${block.id}`)).length, images: document.images.length, readImages: document.images.filter((image) => readImages.has(`${attachmentId}/${image.id}`)).length, warnings: summary.warnings }; })); },
    async assertActive() { for (const attachmentId of allowed) await store.get(scope, attachmentId); },
  };
}

export type AttachmentTools = ReturnType<typeof createAttachmentTools>;
