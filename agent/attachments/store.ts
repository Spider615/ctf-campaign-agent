import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import { ATTACHMENT_LIMITS, validAttachmentId, type AttachmentSummary, type ParsedAttachment } from "../../app/lib/attachments/types.ts";
import { throwIfTurnCancelled } from "../../app/lib/cancellation.ts";
import { parseAttachment } from "./parser.ts";

export type AttachmentScope = { owner: string; conversationId: string };
type Config = { directory: string; python?: string; clock?: () => number };
type Upload = { name: string; body: AsyncIterable<Uint8Array>; signal?: AbortSignal };
type Job = { scope: AttachmentScope; id: string; controller: AbortController; waiters: Set<symbol>; run: Promise<void> | null };
const rootPath = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const retention = ATTACHMENT_LIMITS.retentionDays * 86400000;
const PARSER_VERSION = "attachments/4";
const id = (value: unknown) => { if (!validAttachmentId(value)) throw new Error("附件标识不正确"); return value; };

function privateDirectory(directory: string) {
  const requested = resolve(directory); let parent = requested; const tail: string[] = [];
  while (!existsSync(parent)) { tail.unshift(parent.slice(dirname(parent).length + 1)); parent = dirname(parent); }
  const actual = resolve(realpathSync(parent), ...tail); const path = relative(rootPath, actual);
  if (!path || !path.startsWith(`..${sep}`) && !isAbsolute(path)) throw new Error("附件必须存放在仓库之外");
  mkdirSync(actual, { recursive: true, mode: 0o700 }); return realpathSync(actual);
}

export function createAttachmentStore(config: Config) {
  const directory = privateDirectory(config.directory); const clock = config.clock ?? Date.now;
  const jobs = new Map<string, Job>(); const listeners = new Set<(scope: AttachmentScope, id: string) => void>(); let running = 0; let closed = false;
  let serial: Promise<unknown> = Promise.resolve();
  const locked = <T>(action: () => Promise<T>): Promise<T> => { const next = serial.then(action, action); serial = next.catch(() => {}); return next; };
  const folder = (scope: AttachmentScope, attachmentId?: string) => join(directory, id(scope.owner), id(scope.conversationId), ...(attachmentId ? [id(attachmentId)] : []));
  const key = (scope: AttachmentScope, attachmentId: string) => `${scope.owner}/${scope.conversationId}/${attachmentId}`;
  const save = async (scope: AttachmentScope, item: AttachmentSummary) => {
    const destination = join(folder(scope, item.id), "metadata.json"); const temp = destination + "." + crypto.randomUUID();
    await writeFile(temp, JSON.stringify(item), { mode: 0o600 }); await rename(temp, destination);
  };
  const raw = async (scope: AttachmentScope, attachmentId: string): Promise<AttachmentSummary> => {
    const path = folder(scope, attachmentId);
    try { const stat = await lstat(path); if (stat.isSymbolicLink()) throw new Error(); return JSON.parse(await readFile(join(path, "metadata.json"), "utf8")) as AttachmentSummary; }
    catch { throw new Error("附件不存在、已删除或无权读取"); }
  };
  const remove = async (scope: AttachmentScope, attachmentId: string) => {
    const job = jobs.get(key(scope, attachmentId)); job?.controller.abort();
    for (const listener of listeners) listener(scope, attachmentId);
    if (job?.run) await job.run.catch(() => {}); else jobs.delete(key(scope, attachmentId));
    await locked(() => rm(folder(scope, attachmentId), { recursive: true, force: true, maxRetries: 3, retryDelay: 10 }));
  };
  const pump = () => {
    if (closed) return;
    const perOwner = new Map<string, number>(); for (const job of jobs.values()) if (job.run) perOwner.set(job.scope.owner, (perOwner.get(job.scope.owner) ?? 0) + 1);
    for (const [jobKey, job] of jobs) {
      if (running >= 4) break;
      if (job.run || job.controller.signal.aborted || (perOwner.get(job.scope.owner) ?? 0) >= 2) continue;
      running++; perOwner.set(job.scope.owner, (perOwner.get(job.scope.owner) ?? 0) + 1);
      job.run = (async () => {
        const path = folder(job.scope, job.id);
        try {
          await locked(async () => { throwIfTurnCancelled(job.controller.signal); const item = await raw(job.scope, job.id); await save(job.scope, { ...item, status: "processing" }); });
          const document = await parseAttachment(join(path, "original"), join(path, "parsed"), (await raw(job.scope, job.id)).name, job.controller.signal, config.python);
          throwIfTurnCancelled(job.controller.signal);
          await locked(async () => {
            const item = await raw(job.scope, job.id);
            const failed = ["failed", "unsupported", "encrypted"].includes(document.status);
            await save(job.scope, { ...item, status: document.status, mime: document.mime, blockCount: document.blocks.length, tableCount: document.tables.length, imageCount: document.images.length, warnings: document.warnings.slice(0, 100), entries: document.entries.slice(0, 102), ...(failed ? { error: document.warnings.at(-1) ?? "文件无法读取" } : {}) });
          });
          // 转换与解包临时产物不作为持久文件保留。
          for (const name of await readdir(join(path, "parsed"))) if (!["parsed.json", "parser-details.txt", ...(document.tables.some((table) => table.rowStore) ? ["tables.sqlite"] : [])].includes(name) && !/^i\d+\.(?:jpg|png)$/.test(name)) await rm(join(path, "parsed", name), { recursive: true, force: true });
        } catch (error) {
          await locked(async () => {
            try {
              const item = await raw(job.scope, job.id);
              if (job.controller.signal.aborted) {
                if (["queued", "processing"].includes(item.status)) {
                  await rm(join(path, "parsed"), { recursive: true, force: true });
                  await save(job.scope, { ...item, status: "uploaded", error: undefined });
                }
              } else await save(job.scope, { ...item, status: "failed", error: error instanceof Error ? error.message : "文件解析未完成" });
            } catch { /* 删除已完成时不再写回。 */ }
          });
        } finally { jobs.delete(jobKey); running--; pump(); }
      })();
    }
  };
  const enqueue = (scope: AttachmentScope, attachmentId: string, waiter: symbol) => {
    const jobKey = key(scope, attachmentId);
    if (!jobs.has(jobKey)) jobs.set(jobKey, { scope, id: attachmentId, controller: new AbortController(), waiters: new Set(), run: null });
    const job = jobs.get(jobKey)!; job.waiters.add(waiter); pump(); return job;
  };
  const get = async (scope: AttachmentScope, attachmentId: string): Promise<AttachmentSummary> => {
    const item = await raw(scope, attachmentId);
    if (Date.parse(item.expiresAt) <= clock()) { await remove(scope, attachmentId); throw new Error("附件已过期，请重新上传"); }
    if (["queued", "processing"].includes(item.status) && !jobs.has(key(scope, attachmentId))) {
      return locked(async () => {
        const current = await raw(scope, attachmentId);
        if (jobs.has(key(scope, attachmentId)) || !["queued", "processing"].includes(current.status)) return current;
        const restored = current.parserVersion !== PARSER_VERSION
          ? { ...current, status: "failed" as const, error: "文件解析程序已更新，请重试以创建新版本，原文件仍保留" }
          : { ...current, status: "uploaded" as const, error: undefined };
        await save(scope, restored); return restored;
      });
    }
    return item;
  };
  const list = async (scope: AttachmentScope) => {
    let names: string[]; try { names = await readdir(folder(scope)); } catch { return []; }
    const items = await Promise.all(names.filter(validAttachmentId).map((attachmentId) => get(scope, attachmentId).catch(() => null)));
    return items.filter((item): item is AttachmentSummary => item !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  };
  const upload = async (scope: AttachmentScope, input: Upload): Promise<AttachmentSummary> => locked(async () => {
    if (closed) throw new Error("附件服务已停止");
    if (!input.name.trim() || input.name.length > 255 || /[\x00-\x1f]/.test(input.name)) throw new Error("文件名称无效");
    throwIfTurnCancelled(input.signal);
    const names = await readdir(folder(scope)).catch(() => []);
    const files = (await Promise.all(names.filter(validAttachmentId).map((attachmentId) => raw(scope, attachmentId).catch(() => null)))).filter((item): item is AttachmentSummary => item !== null && Date.parse(item.expiresAt) > clock());
    let size = 0; const attachmentId = crypto.randomUUID(); const path = folder(scope, attachmentId); const hash = createHash("sha256");
    await mkdir(path, { recursive: true, mode: 0o700 }); const output = await open(join(path, "original.part"), "wx", 0o600);
    try {
      for await (const chunk of input.body) {
        throwIfTurnCancelled(input.signal); size += chunk.byteLength;
        if (size > ATTACHMENT_LIMITS.fileBytes) throw new Error("单个文件不能超过 25 MiB");
        if (files.reduce((sum, item) => sum + item.size, 0) + size > ATTACHMENT_LIMITS.conversationBytes) throw new Error("本会话附件已达到 500 MiB 限额");
        hash.update(chunk); await output.write(chunk);
      }
      if (!size) throw new Error("不能上传空文件");
      throwIfTurnCancelled(input.signal); await output.close();
      const contentHash = hash.digest("hex"); const version = createHash("sha256").update(`${contentHash}/${PARSER_VERSION}`).digest("hex"); const duplicate = files.find((item) => item.version === version && item.name === input.name && !["failed", "unsupported", "encrypted"].includes(item.status));
      if (duplicate) { await rm(path, { recursive: true, force: true }); return duplicate; }
      await rename(join(path, "original.part"), join(path, "original"));
      const item: AttachmentSummary = { id: attachmentId, conversationId: scope.conversationId, name: input.name, size, mime: "application/octet-stream", version, contentHash, parserVersion: PARSER_VERSION, status: "uploaded", createdAt: new Date(clock()).toISOString(), expiresAt: new Date(clock() + retention).toISOString(), blockCount: 0, tableCount: 0, imageCount: 0, warnings: [], entries: [] };
      await save(scope, item); return item;
    } catch (error) { await output.close().catch(() => {}); await rm(path, { recursive: true, force: true }); throw error; }
  });
  const document = async (scope: AttachmentScope, attachmentId: string) => {
    const item = await get(scope, attachmentId);
    if (!["ready", "partial"].includes(item.status)) throw new Error(item.error ?? "文件仍在解析，请稍后重试");
    const parsed = JSON.parse(await readFile(join(folder(scope, attachmentId), "parsed", "parsed.json"), "utf8")) as ParsedAttachment;
    await locked(async () => { const current = await raw(scope, attachmentId); await save(scope, { ...current, expiresAt: new Date(clock() + retention).toISOString() }); });
    return { summary: item, document: parsed };
  };
  const cleanup = async () => {
    for (const owner of (await readdir(directory)).filter(validAttachmentId)) for (const conversationId of (await readdir(join(directory, owner))).filter(validAttachmentId)) {
      const scope = { owner, conversationId };
      for (const attachmentId of (await readdir(folder(scope))).filter(validAttachmentId)) {
        try { const item = await raw(scope, attachmentId); if (Date.parse(item.expiresAt) <= clock()) await remove(scope, attachmentId); }
        catch { const stat = await lstat(folder(scope, attachmentId)).catch(() => null); if (stat && stat.mtimeMs < clock() - 3600000) await remove(scope, attachmentId); }
      }
    }
  };
  const prepare = async (scope: AttachmentScope, attachmentIds: readonly string[], signal?: AbortSignal) => {
    throwIfTurnCancelled(signal);
    const items = await Promise.all(attachmentIds.map((attachmentId) => get(scope, attachmentId)));
    const failure = (item: AttachmentSummary) => new Error(`文件「${item.name}」暂时无法分析：${item.error ?? "请重新上传后重试"}`);
    for (const item of items) {
      if (!["uploaded", "queued", "processing", "ready", "partial"].includes(item.status)) throw failure(item);
      if (item.status === "uploaded" && item.parserVersion !== PARSER_VERSION) throw new Error("文件处理程序已更新，请重新上传这个附件");
    }
    const waiter = Symbol(); const acquired = new Set<Job>();
    try {
      for (const item of items) while (true) {
        const stopping = await locked(async () => {
          throwIfTurnCancelled(signal); if (closed) throw new Error("附件服务已停止");
          const current = await raw(scope, item.id);
          if (["ready", "partial"].includes(current.status)) return null;
          const previous = jobs.get(key(scope, item.id));
          if (previous?.controller.signal.aborted) return { run: previous.run };
          if (!["uploaded", "queued", "processing"].includes(current.status)) throw failure(current);
          if (current.status === "uploaded") await save(scope, { ...current, status: "queued", error: undefined });
          acquired.add(enqueue(scope, item.id, waiter)); return null;
        });
        if (!stopping) break;
        await stopping.run;
      }
      while (true) {
        throwIfTurnCancelled(signal); if (closed) throw new Error("附件服务已停止");
        const current = await Promise.all(attachmentIds.map((attachmentId) => get(scope, attachmentId)));
        const failed = current.find((item) => !["queued", "processing", "ready", "partial"].includes(item.status));
        if (failed) throw failure(failed);
        if (current.every((item) => item.status === "ready" || item.status === "partial")) return;
        try { await wait(100, undefined, { signal }); } catch (error) { throwIfTurnCancelled(signal); throw error; }
      }
    } finally {
      const stopping: Promise<void>[] = [];
      await locked(async () => {
        for (const job of acquired) {
          job.waiters.delete(waiter);
          if (job.waiters.size || jobs.get(key(job.scope, job.id)) !== job) continue;
          job.controller.abort();
          if (job.run) stopping.push(job.run);
          else {
            jobs.delete(key(job.scope, job.id));
            const current = await raw(job.scope, job.id); await save(job.scope, { ...current, status: "uploaded", error: undefined });
          }
        }
      });
      await Promise.allSettled(stopping); pump();
    }
  };
  async function* rows(scope: AttachmentScope, attachmentId: string, tableId: string, offset = 0, limit: number = ATTACHMENT_LIMITS.tableRows) {
    const { document: parsed } = await document(scope, attachmentId);
    const table = parsed.tables.find((item) => item.id === tableId); if (!table) throw new Error("表格不存在");
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || offset < 0 || limit < 0 || offset > ATTACHMENT_LIMITS.tableRows || limit > ATTACHMENT_LIMITS.tableRows) throw new Error("文件分页参数不正确");
    if (!table.rowStore) {
      for (let index = offset; index < Math.min(table.rows.length, offset + limit); index++) yield { values: table.rows[index], rowNumber: table.rowNumbers[index], rowEndNumber: table.rowEndNumbers?.[index] };
      return;
    }
    const { rowCount, firstPosition } = table.rowStore;
    if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > ATTACHMENT_LIMITS.tableRows || !Number.isSafeInteger(firstPosition) || firstPosition < 0 || firstPosition > 12) throw new Error("文件表格索引不正确");
    const path = join(folder(scope, attachmentId), "parsed", "tables.sqlite");
    const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error("文件表格存储不正确");
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const statement = database.prepare("SELECT row_number, cells FROM attachment_rows WHERE table_id = ? AND position >= ? AND position < ? ORDER BY position");
      for (const row of statement.iterate(table.id, firstPosition + offset, firstPosition + Math.min(rowCount, offset + limit))) {
        const values = JSON.parse(String(row.cells)) as Array<string | null>;
        while (values.length < table.columns.length) values.push(null);
        yield { values, rowNumber: Number(row.row_number), rowEndNumber: undefined };
      }
    } finally { database.close(); }
  }
  const timer = setInterval(() => void cleanup().catch(() => {}), 3600000); timer.unref(); void cleanup().catch(() => {});
  return {
    upload, list, get, remove, document, rows, prepare, cleanup,
    async retry(scope: AttachmentScope, attachmentId: string) {
      const item = await get(scope, attachmentId);
      // 已发布的读取结果保持不可变，重试只恢复未成功的解析。
      if (["uploaded", "ready", "partial"].includes(item.status) || jobs.has(key(scope, attachmentId))) return item;
      if (item.parserVersion !== PARSER_VERSION) return upload(scope, { name: item.name, body: createReadStream(join(folder(scope, attachmentId), "original")) });
      await locked(() => save(scope, { ...item, status: "uploaded", error: undefined }));
      return { ...item, status: "uploaded" as const, error: undefined };
    },
    async content(scope: AttachmentScope, attachmentId: string) { return { summary: await get(scope, attachmentId), path: join(folder(scope, attachmentId), "original") }; },
    async image(scope: AttachmentScope, attachmentId: string, imageId: string) { if (!/^i\d+$/.test(imageId)) throw new Error("图片标识不正确"); const { summary, document: parsed } = await document(scope, attachmentId); const image = parsed.images.find((item) => item.id === imageId); if (!image) throw new Error("图片不存在"); return { summary, image, path: join(folder(scope, attachmentId), "parsed", imageId + (image.mime === "image/png" ? ".png" : ".jpg")) }; },
    onRemove(listener: (scope: AttachmentScope, id: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async close() { closed = true; clearInterval(timer); for (const job of jobs.values()) job.controller.abort(); await Promise.allSettled([...jobs.values()].flatMap((job) => job.run ? [job.run] : [])); },
  };
}

export type AttachmentStore = ReturnType<typeof createAttachmentStore>;
