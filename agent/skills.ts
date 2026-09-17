import { existsSync, realpathSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { AgentRequest } from "../app/lib/agent/protocol.ts";
import {
  SKILL_TRACE_TOOL,
  finishTraceEvent,
  startTraceEvent,
  type AgentTraceEvent,
} from "../app/lib/tool-trace.ts";

export const PLUGIN_NAME = "ics1811";

export const BASELINE_SKILL_NAMES = [
  "campaign-sop",
  "offer-entry-guide",
  "field-explainer",
  "settlement-guide",
  "promo-copy-guide",
] as const;

export type BaselineSkillName = typeof BASELINE_SKILL_NAMES[number];

const FIELD_TOPIC = /计折上折|折上折|固定(?:折扣)?模式|浮动(?:折扣)?模式|固定(?:折扣)?(?:模式)?(?:和|与|、|还是|或)浮动(?:折扣)?(?:模式)?|浮动(?:折扣)?(?:模式)?(?:和|与|、|还是|或)固定(?:折扣)?(?:模式)?|让扣点|回款率|货品范围|货类明细|货类|售价类型|限制条件|餐牌|活动分组/;
const EXPLAIN_INTENT = /什么意思|是什么意思|什么含义|怎么理解|如何理解|有什么区别|区别是什么|有什么差别|差别是什么|为什么(?:要|需要)?(?:问|填|确认)|解释|含义|指什么/;
const OFFER_TOPIC = /折扣|打(?:\d+(?:\.\d+)?)?折|满减|克减|每克减|以旧换新|以小换大|换购|outlet|转餐牌|累加|抽奖|签到|优惠玩法|活动玩法|优惠开单|1811/;
const ENTRY_INTENT = /怎么录|如何录|怎样录|怎么填|如何填|怎样填|怎么建|如何建|怎样建|怎么创建|如何创建|该选|应该选|选哪个|怎么选|如何选择|是否支持|支不支持|能不能(?:做|录|建)|可以(?:做|录|建)吗|适不适用|怎么处理|如何处理/;
const SUPPORT_INTENT = /是否支持|支不支持|支持.{0,12}吗|能不能|能(?:做|录|建)吗|可以吗|可不可以|适不适用|是不是超出|是否超出/;
const SETTLEMENT_TOPIC = /结算说明函|说明函|跨区域|跨区|多门店|多家(?:门店|店)|两家(?:门店|店)|单店|文件命名|上传流程/;
const SETTLEMENT_INTENT = /要不要|是否|需不需要|需要吗|怎么|如何|怎样|什么时候|何时|是什么|指什么|什么(?:规则|要求|格式|内容|材料)|规则(?:是什么|怎么|如何|怎样|呢|吗)|解释|说明(?!函)|可以吗|能否|必须.{0,12}吗|是不是必须/;
const PROMO_TOPIC = /宣传文案|活动文案|对外文案|推广文案|主标题|卖点|标语|宣传语/;
const PROMO_INTENT = /帮我|请写|起草|写一版|写个|改写|修改|润色|优化|评价|点评|看看|讨论|建议|怎么写|如何写|要不要|是否合适|怎么样/;
const EXPLAIN_TERMS = ["解释", "说明"] as const;
const DIFFERENCE_TERMS = ["区别", "差别"] as const;
const HOW_TERMS = ["怎么", "如何", "怎样"] as const;
const ENTRY_ACTION_TERMS = ["录", "填", "建", "创建"] as const;
const EXPLAIN_THEN_ENTER_ORDERS = [
  [EXPLAIN_TERMS, DIFFERENCE_TERMS, HOW_TERMS, ENTRY_ACTION_TERMS],
  [HOW_TERMS, ENTRY_ACTION_TERMS, EXPLAIN_TERMS, DIFFERENCE_TERMS],
] as const;

function hasTermsInOrder(text: string, groups: readonly (readonly string[])[]): boolean {
  let cursor = 0;
  for (const group of groups) {
    let nextIndex = -1;
    let nextCursor = -1;
    for (const term of group) {
      const index = text.indexOf(term, cursor);
      if (index >= 0 && (nextIndex < 0 || index < nextIndex)) {
        nextIndex = index;
        nextCursor = index + term.length;
      }
    }
    if (nextIndex < 0) return false;
    cursor = nextCursor;
  }
  return true;
}

export function requiredSkillsForTurn(
  request: Pick<AgentRequest, "trigger">,
): BaselineSkillName[] {
  const text = request.trigger.text.replace(/\s+/g, "").toLowerCase();
  const required = new Set<BaselineSkillName>(["campaign-sop"]);
  const fieldTopic = FIELD_TOPIC.test(text);
  const explanation = EXPLAIN_INTENT.test(text);
  const offerTopic = OFFER_TOPIC.test(text);
  const entry = ENTRY_INTENT.test(text);
  const explainThenEnter = EXPLAIN_THEN_ENTER_ORDERS.some(
    (groups) => hasTermsInOrder(text, groups),
  );

  if ((fieldTopic && explanation) || explainThenEnter) required.add("field-explainer");
  if (
    explainThenEnter
    || (entry && (offerTopic || fieldTopic))
    || (offerTopic && SUPPORT_INTENT.test(text))
    || (offerTopic && explanation && !fieldTopic)
  ) {
    required.add("offer-entry-guide");
  }
  if (SETTLEMENT_TOPIC.test(text) && SETTLEMENT_INTENT.test(text)) {
    required.add("settlement-guide");
  }
  if (PROMO_TOPIC.test(text) && PROMO_INTENT.test(text)) {
    required.add("promo-copy-guide");
  }

  return BASELINE_SKILL_NAMES.filter((name) => required.has(name));
}

export type SkillSource = {
  id: string;
  path: string;
  note?: string;
};

export type SkillInfo = {
  name: string;
  qualifiedName: string;
  title: string;
  description: string;
  relativePath: string;
  sources: readonly SkillSource[];
};

export type SkillLoadState = {
  pending: Map<string, { skill: SkillInfo | null; started: AgentTraceEvent }>;
  loadedSkills: Set<string>;
  skillLoadFailed: boolean;
};

export class SkillCatalogError extends Error {
  readonly relativePath: string;
  readonly detail: string;

  constructor(relativePath: string, detail: string) {
    super(`${relativePath}：${detail}`);
    this.name = "SkillCatalogError";
    this.relativePath = relativePath;
    this.detail = detail;
  }
}

const REQUIRED_SECTIONS = [
  "适用场景",
  "回答原则",
  "业务知识",
  "不能做什么",
  "冲突处理",
  "出处",
] as const;

const SKILL_NAME_PATTERN = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_SUFFIX = /(?:\s*\[S[1-9]\d*\])+\s*$/;
const SOURCE_PATTERN = /^- \[(S[1-9]\d*)\] `([^`]+)`(?: — (.+))?$/;
const SOURCE_REFERENCE_PATTERN = /\[(S\d+)\]/g;
const PLACEHOLDER_PATTERN = /TODO|TBD|以后补/i;

type ParsedFrontmatter = {
  name: string;
  description: string;
  bodyLines: string[];
};

type ParsedSkill = {
  directoryName: string;
  info: SkillInfo;
};

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readText(path: string, relativePath: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new SkillCatalogError(relativePath, `读取失败：${errorDetail(error)}`);
  }
}

function readDirectory(path: string, relativePath: string) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    throw new SkillCatalogError(relativePath, `读取目录失败：${errorDetail(error)}`);
  }
}

function validateManifest(pluginDir: string): void {
  const relativePath = ".claude-plugin/plugin.json";
  const manifestPath = resolve(pluginDir, relativePath);
  const text = readText(manifestPath, relativePath);
  let manifest: unknown;

  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new SkillCatalogError(relativePath, `不是有效 JSON：${errorDetail(error)}`);
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new SkillCatalogError(relativePath, "插件清单必须是 JSON 对象");
  }
  if ((manifest as { name?: unknown }).name !== PLUGIN_NAME) {
    throw new SkillCatalogError(relativePath, `插件 name 必须是 ${PLUGIN_NAME}`);
  }
}

function parseFrontmatter(lines: string[], relativePath: string): ParsedFrontmatter {
  if (lines[0] !== "---") {
    throw new SkillCatalogError(relativePath, "缺少起始 frontmatter 分隔线");
  }
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex < 0) {
    throw new SkillCatalogError(relativePath, "缺少结束 frontmatter 分隔线");
  }

  const values = new Map<string, string>();
  for (const line of lines.slice(1, closingIndex)) {
    if (line.trim() === "") {
      throw new SkillCatalogError(relativePath, "frontmatter 不能包含空白行");
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!match) {
      throw new SkillCatalogError(relativePath, `frontmatter 字段必须是单行 key: value：${line}`);
    }
    const key = match[1].trim();
    if (key !== "name" && key !== "description") {
      throw new SkillCatalogError(relativePath, `frontmatter 包含未知字段 ${key}`);
    }
    if (values.has(key)) {
      throw new SkillCatalogError(relativePath, `frontmatter 字段 ${key} 重复`);
    }
    values.set(key, match[2].trim());
  }

  if (!values.has("name")) {
    throw new SkillCatalogError(relativePath, "frontmatter 缺少 name");
  }
  if (!values.has("description")) {
    throw new SkillCatalogError(relativePath, "frontmatter 缺少 description");
  }

  validatePlainDescription(values.get("description")!, relativePath);

  return {
    name: values.get("name")!,
    description: values.get("description")!,
    bodyLines: lines.slice(closingIndex + 1),
  };
}

function validatePlainDescription(description: string, relativePath: string): void {
  if (!description) {
    throw new SkillCatalogError(relativePath, "frontmatter description 不能为空");
  }
  const firstCodePoint = Array.from(description)[0] ?? "";
  if (!/^[\p{L}\p{N}]$/u.test(firstCodePoint)) {
    throw new SkillCatalogError(relativePath, "frontmatter description 必须以字母或数字开头的未加引号 YAML 字符串");
  }
  if (/:\s|\s#|:$/.test(description)) {
    throw new SkillCatalogError(relativePath, "frontmatter description 不能包含 YAML 保留的冒号空格、注释或行尾冒号");
  }
  if (/^(?:~|null|true|false|yes|no|on|off)$/i.test(description)
    || /^(?:[-+]?(?:(?:\d[\d_]*)(?:\.(?:\d[\d_]*)?)?|\.\d[\d_]*)(?:[eE][-+]?\d[\d_]*)?|[-+]?0x[\da-f_]+|[-+]?0o[0-7_]+|[-+]?0b[01_]+)$/i.test(description)
    || /^\d{4}-\d{2}-\d{2}(?:$|[Tt ]\d)/.test(description)) {
    throw new SkillCatalogError(relativePath, "frontmatter description 必须解析为字符串，不能是 YAML 标量值");
  }
}

function parseBody(
  bodyLines: string[],
  description: string,
  relativePath: string,
): { title: string; sources: readonly SkillSource[] } {
  const h1Lines = bodyLines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^#(?:\s|$)/.test(line) && !/^##(?:\s|$)/.test(line));
  if (h1Lines.length !== 1 || !/^# \S.*$/.test(h1Lines[0]?.line ?? "")) {
    throw new SkillCatalogError(relativePath, "正文必须且只能包含一个非空 H1 标题");
  }
  const h1 = h1Lines[0];
  if (bodyLines.slice(0, h1.index).some((line) => line.trim() !== "")) {
    throw new SkillCatalogError(relativePath, "H1 标题前不能出现正文");
  }

  const h2Lines = bodyLines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^##(?:\s|$)/.test(line) && !/^###(?:\s|$)/.test(line));
  const actualSections = h2Lines.map(({ line }) => /^## (.+)$/.exec(line)?.[1] ?? "");
  if (
    actualSections.length !== REQUIRED_SECTIONS.length
    || actualSections.some((section, index) => section !== REQUIRED_SECTIONS[index])
  ) {
    throw new SkillCatalogError(
      relativePath,
      `H2 章节必须按顺序且只包含：${REQUIRED_SECTIONS.join("、")}`,
    );
  }
  if (h2Lines[0].index <= h1.index) {
    throw new SkillCatalogError(relativePath, "六个 H2 章节必须位于 H1 标题之后");
  }
  if (bodyLines.slice(h1.index + 1, h2Lines[0].index).some((line) => line.trim() !== "")) {
    throw new SkillCatalogError(relativePath, "H1 与第一个章节之间不能出现正文");
  }

  const usedSourceIds = new Set<string>();
  let firstUsageRule: string | null = null;
  for (let sectionIndex = 0; sectionIndex < REQUIRED_SECTIONS.length - 1; sectionIndex += 1) {
    const start = h2Lines[sectionIndex].index + 1;
    const end = h2Lines[sectionIndex + 1].index;
    const rules = bodyLines.slice(start, end).filter((line) => line.trim() !== "");
    if (rules.length === 0) {
      throw new SkillCatalogError(
        relativePath,
        `${REQUIRED_SECTIONS[sectionIndex]}必须至少包含一条非空规则`,
      );
    }
    for (const rule of rules) {
      const suffix = SOURCE_SUFFIX.exec(rule)?.[0];
      const ruleText = suffix ? rule.slice(2).replace(SOURCE_SUFFIX, "").trim() : "";
      if (!rule.startsWith("- ") || !suffix || ruleText === "") {
        throw new SkillCatalogError(
          relativePath,
          `${REQUIRED_SECTIONS[sectionIndex]}中的每条规则都必须是单行列表项，并以一个或多个 [S#] 来源标签结尾`,
        );
      }
      if (firstUsageRule === null && sectionIndex === 0) firstUsageRule = ruleText;
      for (const tag of rule.matchAll(SOURCE_REFERENCE_PATTERN)) usedSourceIds.add(tag[1]);
    }
  }

  if (firstUsageRule !== description) {
    throw new SkillCatalogError(relativePath, "适用场景第一条规则必须与 frontmatter description 完全一致");
  }

  const sourceStart = h2Lines[REQUIRED_SECTIONS.length - 1].index + 1;
  const sourceLines = bodyLines.slice(sourceStart).filter((line) => line.trim() !== "");
  const sourceById = new Map<string, SkillSource>();
  for (const line of sourceLines) {
    const match = SOURCE_PATTERN.exec(line);
    if (!match) {
      throw new SkillCatalogError(
        relativePath,
        "来源定义格式必须是 - [S#] `repo/relative/path`，可选追加非空的 — 定位说明",
      );
    }
    const [, id, sourcePath, rawNote] = match;
    if (sourceById.has(id)) {
      throw new SkillCatalogError(relativePath, `来源 ${id} 重复定义`);
    }
    const note = rawNote?.trim();
    if (rawNote !== undefined && !note) {
      throw new SkillCatalogError(relativePath, "来源定位说明不能为空");
    }
    validateSourceDeclaration(sourcePath, note, relativePath);
    const source: SkillSource = note === undefined ? { id, path: sourcePath } : { id, path: sourcePath, note };
    sourceById.set(id, Object.freeze(source));
  }

  for (const id of usedSourceIds) {
    if (!sourceById.has(id)) {
      throw new SkillCatalogError(relativePath, `规则使用的来源 ${id} 没有定义`);
    }
  }
  for (const id of sourceById.keys()) {
    if (!usedSourceIds.has(id)) {
      throw new SkillCatalogError(relativePath, `来源 ${id} 已定义但未使用`);
    }
  }

  return {
    title: h1.line.slice(2).trim(),
    sources: Object.freeze([...sourceById.values()]),
  };
}

function validateSourceDeclaration(sourcePath: string, note: string | undefined, relativePath: string): void {
  if (PLACEHOLDER_PATTERN.test(sourcePath) || (note !== undefined && PLACEHOLDER_PATTERN.test(note))) {
    throw new SkillCatalogError(relativePath, "来源定义不能包含 TODO、TBD 或以后补等占位文字");
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(sourcePath)) {
    throw new SkillCatalogError(relativePath, "来源路径不能使用 URL 或其他协议");
  }
  if (note !== undefined) {
    const schemePattern = /(?:^|[^A-Za-z0-9+.-])([a-z][a-z\d+.-]*:)(?=\/|[^\s\\/])/gi;
    for (const match of note.matchAll(schemePattern)) {
      const scheme = match[1];
      const isWindowsDrive = /^[a-z]:$/i.test(scheme)
        && note.slice((match.index ?? 0) + match[0].length - scheme.length, (match.index ?? 0) + match[0].length + 1).match(/[\\/]/);
      if (!isWindowsDrive) {
        throw new SkillCatalogError(relativePath, "来源定位说明不能使用 URL 或其他协议");
      }
    }
  }
  if (isAbsolute(sourcePath) || sourcePath.startsWith("\\\\")) {
    throw new SkillCatalogError(relativePath, "来源路径必须是仓库相对路径，不能是绝对路径");
  }
  if (
    sourcePath !== sourcePath.trim()
    || sourcePath.includes("\\")
    || sourcePath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new SkillCatalogError(relativePath, "来源必须使用规范的仓库相对路径，不能包含空段、.、.. 或反斜线");
  }
}

function parseSkill(pluginDir: string, directory: string): ParsedSkill {
  const skillDirectoryRelativePath = `skills/${directory}`;
  const skillDirectoryPath = resolve(pluginDir, "skills", directory);
  const entries = readDirectory(skillDirectoryPath, skillDirectoryRelativePath);
  const relativePath = `${skillDirectoryRelativePath}/SKILL.md`;
  if (entries.length !== 1 || entries[0].name !== "SKILL.md" || !entries[0].isFile()) {
    const hasSkillFile = entries.some((entry) => entry.name === "SKILL.md" && entry.isFile());
    if (!hasSkillFile) {
      throw new SkillCatalogError(relativePath, "Skill 目录必须包含一个可读取的 SKILL.md 文件");
    }
    throw new SkillCatalogError(skillDirectoryRelativePath, "Skill 目录只能包含 SKILL.md，不能有额外文件");
  }

  const text = readText(resolve(skillDirectoryPath, "SKILL.md"), relativePath);
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const parsed = parseFrontmatter(lines, relativePath);

  if (!SKILL_NAME_PATTERN.test(parsed.name)) {
    throw new SkillCatalogError(relativePath, "Skill name 格式无效");
  }
  if (parsed.description.length === 0) {
    throw new SkillCatalogError(relativePath, "frontmatter description 不能为空");
  }
  if ([...parsed.description].length > 1024) {
    throw new SkillCatalogError(relativePath, "frontmatter description 不能超过 1024 个 Unicode code point");
  }

  const { title, sources } = parseBody(parsed.bodyLines, parsed.description, relativePath);
  if (lines.length > 500) {
    throw new SkillCatalogError(relativePath, "SKILL.md 不能超过 500 行");
  }
  if (PLACEHOLDER_PATTERN.test(text)) {
    throw new SkillCatalogError(relativePath, "SKILL.md 不能包含 TODO、TBD 或以后补等占位文字");
  }

  return {
    directoryName: directory,
    info: Object.freeze({
      name: parsed.name,
      qualifiedName: `${PLUGIN_NAME}:${parsed.name}`,
      title,
      description: parsed.description,
      relativePath,
      sources,
    }),
  };
}

export function loadSkillCatalog(pluginDir: string): readonly SkillInfo[] {
  try {
    validateManifest(pluginDir);
    const skillsDirectoryPath = resolve(pluginDir, "skills");
    const entries = readDirectory(skillsDirectoryPath, "skills");
    if (entries.length === 0) {
      throw new SkillCatalogError("skills", "Skill 目录为空，缺少基线 Skill");
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        throw new SkillCatalogError(`skills/${entry.name}`, "skills 的直属内容必须全部是 Skill 目录");
      }
    }

    const parsed = entries.map((entry) => parseSkill(pluginDir, entry.name));
    const declaredNames = new Map<string, string>();
    for (const skill of parsed) {
      const previous = declaredNames.get(skill.info.name);
      if (previous) {
        throw new SkillCatalogError(
          skill.info.relativePath,
          `Skill name ${skill.info.name} 与 ${previous} 重复`,
        );
      }
      declaredNames.set(skill.info.name, skill.info.relativePath);
    }
    for (const skill of parsed) {
      if (skill.info.name !== skill.directoryName) {
        throw new SkillCatalogError(
          skill.info.relativePath,
          `Skill name 必须与目录名 ${skill.directoryName} 一致`,
        );
      }
    }
    for (const baselineName of BASELINE_SKILL_NAMES) {
      if (!declaredNames.has(baselineName)) {
        throw new SkillCatalogError("skills", `缺少基线 Skill ${baselineName}`);
      }
    }

    const catalog = parsed.map((skill) => skill.info);
    catalog.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    return Object.freeze(catalog);
  } catch (error) {
    if (error instanceof SkillCatalogError) throw error;
    throw new SkillCatalogError(".", `加载 Skill 目录失败：${errorDetail(error)}`);
  }
}

export function validateSkillSources(catalog: readonly SkillInfo[], repoRoot: string): void {
  let realRepoRoot: string;
  try {
    realRepoRoot = realpathSync(resolve(repoRoot));
  } catch (error) {
    throw new SkillCatalogError(".", `读取仓库根目录失败：${errorDetail(error)}`);
  }

  for (const skill of catalog) {
    for (const source of skill.sources) {
      const candidate = resolve(realRepoRoot, source.path);
      const lexicalRelative = relative(realRepoRoot, candidate);
      if (
        lexicalRelative === ".."
        || lexicalRelative.startsWith(`..${sep}`)
        || isAbsolute(lexicalRelative)
      ) {
        throw new SkillCatalogError(skill.relativePath, `来源路径超出仓库根目录：${source.path}`);
      }
      if (!existsSync(candidate)) {
        throw new SkillCatalogError(skill.relativePath, `来源路径不存在：${source.path}`);
      }

      let realCandidate: string;
      try {
        realCandidate = realpathSync(candidate);
      } catch (error) {
        throw new SkillCatalogError(
          skill.relativePath,
          `读取来源路径 ${source.path} 失败：${errorDetail(error)}`,
        );
      }
      const realRelative = relative(realRepoRoot, realCandidate);
      if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
        throw new SkillCatalogError(
          skill.relativePath,
          `来源路径通过符号链接超出仓库根目录：${source.path}`,
        );
      }
    }
  }
}

export function qualifiedSkillNames(catalog: readonly SkillInfo[]): string[] {
  return catalog.map((skill) => skill.qualifiedName);
}

export function skillOf(catalog: readonly SkillInfo[], requested: unknown): SkillInfo | null {
  if (typeof requested !== "string") return null;
  return catalog.find(
    (skill) => requested === skill.name || requested === skill.qualifiedName,
  ) ?? null;
}

export function createSkillLoadState(): SkillLoadState {
  return {
    pending: new Map(),
    loadedSkills: new Set(),
    skillLoadFailed: false,
  };
}

export function beginSkillLoad(
  catalog: readonly SkillInfo[],
  state: SkillLoadState,
  input: { id: string; requested: unknown; at: number },
): AgentTraceEvent {
  if (state.pending.has(input.id)) {
    state.skillLoadFailed = true;
    throw new Error(`业务规则工具调用编号重复：${input.id}`);
  }

  const skill = skillOf(catalog, input.requested);
  if (!skill) state.skillLoadFailed = true;
  const started = startTraceEvent({
    id: input.id,
    tool: SKILL_TRACE_TOOL,
    title: `加载业务规则：${skill?.title ?? "未知规则"}`,
    initiatedBy: "model",
    at: input.at,
  });
  state.pending.set(input.id, { skill, started });
  return started;
}

export function finishSkillLoad(
  state: SkillLoadState,
  input: { toolUseId: string; isError: boolean; at: number },
): AgentTraceEvent | null {
  const pending = state.pending.get(input.toolUseId);
  if (!pending) return null;

  state.pending.delete(input.toolUseId);
  const skill = pending.skill;
  const failed = input.isError || skill === null;
  if (failed) {
    state.skillLoadFailed = true;
  } else {
    state.loadedSkills.add(skill.name);
  }
  return finishTraceEvent(pending.started, {
    status: failed ? "warning" : "completed",
    summary: failed ? "规则没有加载成功" : "已读取这份规则",
    at: input.at,
  });
}

export function finishPendingSkillLoads(
  state: SkillLoadState,
  at: number,
): AgentTraceEvent[] {
  const events = [...state.pending.values()].map((pending) => finishTraceEvent(
    pending.started,
    {
      status: "warning",
      summary: "规则没有加载成功",
      at,
    },
  ));
  if (events.length) state.skillLoadFailed = true;
  state.pending.clear();
  return events;
}

export function assertSkillTurnContract(
  required: readonly BaselineSkillName[],
  state: SkillLoadState,
): void {
  if (state.pending.size || state.skillLoadFailed) {
    throw new Error("业务规则没有加载成功，请重试");
  }
  const missing = required.filter((name) => !state.loadedSkills.has(name));
  if (missing.length) {
    throw new Error(
      `本回合缺少必需的业务规则：${missing.map((name) => `${PLUGIN_NAME}:${name}`).join("、")}`,
    );
  }
}

export function finishSkillCheckedTurn<T>(
  required: readonly BaselineSkillName[],
  state: SkillLoadState,
  finish: () => T,
): T {
  assertSkillTurnContract(required, state);
  return finish();
}
