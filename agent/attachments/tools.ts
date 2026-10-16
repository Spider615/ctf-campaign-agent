import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AttachmentSource, DocumentBlock } from "../../app/lib/attachments/types.ts";
import type { AttachmentScope, AttachmentStore } from "./store.ts";
import type { AttachmentCalculation } from "../../app/lib/analytics/visualization-types.ts";

export type ReadAttachmentInput = { attachmentId: string; offset?: number; limit?: number; tableId?: string };
export type TableCalculationInput = { attachmentId: string; tableId: string; operation: "sum" | "count" | "distinct" | "average" | "min" | "max"; column?: string; filters?: Array<{ column: string; operator: "equals" | "contains" | "gte" | "lte"; value: string }>; groupBy?: string[]; offset?: number; limit?: number };
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
  const allowed = new Set(attachmentIds); const sourceMap = new Map<string, AttachmentSource>(); const sourceKeys = new Map<string, string>();
  const readBlocks = new Set<string>(); const readImages = new Set<string>();
  const authorized = async (attachmentId: string) => { if (!allowed.has(attachmentId)) throw new Error("无权读取本轮未授权的附件"); return store.document(scope, attachmentId); };
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
      const rows = table.rows.slice(start, start + size).map((row, index) => {
        const rowNumber = table.rowNumbers[start + index]; const rowEnd = table.rowEndNumbers?.[start + index];
        const location = `${table.archivePath ? table.archivePath + " · " : ""}${table.location} · 原始行 ${rowNumber}${rowEnd && rowEnd !== rowNumber ? "—" + rowEnd : ""}`;
        return { rowNumber: table.rowNumbers[start + index], values: row, sourceId: register(summary, location, "table", table.columns.map((name, column) => `${name}：${row[column] ?? "未提供"}`).join("；")).id };
      });
      return { name: summary.name, columns: table.columns, rows, paging: { offset: start, total: table.rows.length, nextOffset: start + size < table.rows.length ? start + size : null }, warnings: table.warnings, mergedCells: table.mergedCells, calculationBlocked: table.calculationBlocked };
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
    const groups = new Map<string, { labels: string[]; rows: Array<Array<string | null>> }>();
    for (const row of table.rows) {
      const matches = filters.every((filter) => {
        const value = row[filter.index]; if (value === null || value === undefined) return false;
        if (filter.operator === "equals") return value === filter.value;
        if (filter.operator === "contains") return value.includes(filter.value);
        if (filter.operator !== "gte" && filter.operator !== "lte") throw new Error("表格筛选方法不正确");
        const left = decimal(value); const right = decimal(filter.value); if (!left || !right) throw new Error("范围筛选需要可识别的数字，不能猜测文字含义");
        const pair = align(left, right); return filter.operator === "gte" ? pair.a >= pair.b : pair.a <= pair.b;
      });
      if (!matches) continue;
      const labels = groupIndexes.map((index) => row[index] ?? "未提供"); const key = JSON.stringify(labels);
      if (!groups.has(key)) groups.set(key, { labels, rows: [] });
      groups.get(key)!.rows.push(row);
      if (groups.size > 10000) throw new Error("表格分组超过 10000 组，请缩小分组范围");
    }
    if (!groups.size && !groupIndexes.length) groups.set("[]", { labels: [], rows: [] });
    const offset = integer(input.offset, 0, 10000); const limit = Math.max(1, integer(input.limit, 30, 100));
    const selected = groupIndexes.length && !options.captureCalculations ? [...groups.values()].slice(offset, offset + limit) : [...groups.values()];
    const results = selected.map(({ labels, rows }, index) => {
      const present = target < 0 ? [] : rows.map((row) => row[target]).filter((value): value is string => value !== null && value !== undefined && value.trim() !== "");
      const missingRows = target < 0 ? 0 : rows.length - present.length; let value: string | null;
      if (input.operation === "count") value = String(target < 0 ? rows.length : present.length);
      else if (input.operation === "distinct") value = String(new Set(present).size);
      else {
        const numbers = present.map(decimal); if (numbers.some((number) => number === null)) throw new Error("所选列包含非数字内容，不能自动忽略或转成零");
        const values = numbers as Decimal[];
        if (!values.length) value = null;
        else if (input.operation === "min" || input.operation === "max") value = format(values.reduce((a, b) => { const pair = align(a, b); return input.operation === "min" ? pair.a <= pair.b ? a : b : pair.a >= pair.b ? a : b; }));
        else {
          let total = values.reduce(add, { value: BigInt(0), scale: 0 });
          if (input.operation === "average") {
            const scale = 6; const numerator = total.value * power(scale); const divisor = BigInt(values.length) * power(total.scale); const sign = numerator < BigInt(0) ? -BigInt(1) : BigInt(1);
            total = { value: (numerator * sign + divisor / BigInt(2)) / divisor * sign, scale };
          }
          value = format(total);
        }
      }
      const operationLabels = { sum: "求和", count: "计数", distinct: "去重计数", average: "均值（最多保留六位小数）", min: "最小值", max: "最大值" };
      const location = `${table.archivePath ? table.archivePath + " · " : ""}${table.location} · ${operationLabels[input.operation]}`;
      const excerpt = `${input.groupBy?.map((name, index) => `${name}：${labels[index]}`).join("；") ?? "全部选定记录"}；列：${input.column ?? "记录"}；${operationLabels[input.operation]}：${value ?? "未提供"}；全表记录：${table.rows.length}；满足筛选：${rows.length}；缺失：${missingRows}；${filters.length ? `筛选：${JSON.stringify(input.filters)}；` : ""}${missingRows ? "计算仅覆盖非空有效值，不能称为含缺失项的完整总额；" : ""}${table.warnings.join("；")}`;
      return { labels, value, matchedRows: rows.length, missingRows, sourceId: !options.captureCalculations || !groupIndexes.length || index >= offset && index < offset + limit ? register(summary, location, "table", excerpt).id : "" };
    });
    let calculationId: string | undefined;
    if (options.captureCalculations) {
      calculationId = "calc-" + createHash("sha256").update(JSON.stringify([summary.id, summary.version, input.tableId, input.operation, input.column, input.filters ?? [], input.groupBy ?? []])).digest("hex");
      if (!calculations.has(calculationId) && calculations.size >= 100) throw new Error("本轮表格计算记录较多，请复用已有结果");
      const unit = input.operation === "count" || input.operation === "distinct" ? "条" : input.column?.match(/[（(](元|CNY|人民币|USD|美元|HKD|港元|克|件|%|％)[）)]/)?.[1]?.replace(/^(?:CNY|人民币)$/, "元") ?? "原表数值，单位未提供";
      const computationSource = register(summary, `${table.location} · 完整分组计算`, "table", `完整表格计算；列：${input.column ?? "记录"}；方法：${input.operation}；分组：${(input.groupBy ?? []).join("、")}；共 ${results.length} 组；源表 ${table.rows.length} 行。具体精确值由绑定的结构化计算结果保存。`, { calculationId });
      calculations.set(calculationId, { id: calculationId, attachmentId: summary.id, version: summary.version, tableId: table.id, name: summary.name, location: `${table.archivePath ? table.archivePath + " · " : ""}${table.location}`, operation: input.operation, ...(input.column ? { column: input.column } : {}), groupBy: [...(input.groupBy ?? [])], unit, filters: structuredClone(input.filters ?? []), groupCount: results.length, groups: results.map(({ labels, value, matchedRows, missingRows }) => ({ labels, value, matchedRows, missingRows, sourceId: computationSource.id })), warnings: [...table.warnings] });
    }
    const captured = calculationId ? { calculationId } : {};
    if (!groupIndexes.length) return { ...results[0], warnings: table.warnings, fullTableRows: table.rows.length, ...captured };
    return { groups: options.captureCalculations ? results.slice(offset, offset + limit) : results, groupCount: groups.size, paging: { offset, total: groups.size, nextOffset: offset + limit < groups.size ? offset + limit : null }, warnings: table.warnings, fullTableRows: table.rows.length, ...captured };
  };
  return {
    read, calculate,
    async list() { return Promise.all([...allowed].map(async (attachmentId) => { const { summary, document } = await authorized(attachmentId); return { ...summary, tables: document.tables.map((table) => ({ id: table.id, name: table.name, location: table.location, archivePath: table.archivePath, columns: table.columns, rows: table.rows.length, warnings: table.warnings, mergedCells: table.mergedCells, calculationBlocked: table.calculationBlocked })), images: document.images, sections: document.blocks.filter((block) => block.kind === "heading").slice(0, 100), totalBlocks: document.blocks.length }; })); },
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
    async recordDatabase(answer: import("../../app/lib/analytics/analysis-v2-types.ts").AnalysisAnswer) { const first = [...allowed][0]; const { summary } = await authorized(first); return answer.evidence.facts.map((fact) => register(summary, `${answer.task.question} · ${fact.label}`, "database", `${fact.label}：${fact.value ?? "未提供"}${fact.unit}；${fact.definition}；${fact.limitations.join("；")}`, { name: "历史经营数据", databaseRunId: answer.task.runId, databaseFactId: fact.id })); },
    sources: () => [...sourceMap.values()],
    visualizationEvidence: () => ({ calculations: structuredClone([...calculations.values()]), sources: [...sourceMap.values()] }),
    async coverage() { return Promise.all([...allowed].map(async (attachmentId) => { const { summary, document } = await authorized(attachmentId); return { name: summary.name, status: summary.status, entries: summary.entries, textBlocks: document.blocks.filter((block) => block.kind !== "image").length, readTextBlocks: document.blocks.filter((block) => readBlocks.has(`${attachmentId}/${block.id}`)).length, images: document.images.length, readImages: document.images.filter((image) => readImages.has(`${attachmentId}/${image.id}`)).length, warnings: summary.warnings }; })); },
    async assertActive() { for (const attachmentId of allowed) await store.get(scope, attachmentId); },
  };
}

export type AttachmentTools = ReturnType<typeof createAttachmentTools>;
