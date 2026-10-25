import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// 仅用于新问答的 SDK 发现范围，不表示每回合必须加载。
export const ANALYTICS_SKILL_NAMES = Object.freeze(["ctf-qa", "marketing-theory"] as const);
export type AnalyticsSkillName = typeof ANALYTICS_SKILL_NAMES[number];
export type AnalyticsSkillInfo = Readonly<{
  name: AnalyticsSkillName;
  qualifiedName: `analytics:${AnalyticsSkillName}`;
  title: string;
  description: string;
  relativePath: string;
}>;

export class AnalyticsSkillCatalogError extends Error {
  readonly relativePath: string;
  readonly detail: string;

  constructor(relativePath: string, detail: string) {
    super(`${relativePath}：${detail}`);
    this.name = "AnalyticsSkillCatalogError";
    this.relativePath = relativePath;
    this.detail = detail;
  }
}

function readPluginFile(root: string, path: string): string {
  try {
    const actualPath = realpathSync(resolve(root, path));
    const fromRoot = relative(root, actualPath);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      throw new AnalyticsSkillCatalogError(path, "文件真实路径超出插件目录，拒绝读取");
    }
    if (!statSync(actualPath).isFile()) {
      throw new AnalyticsSkillCatalogError(path, "必须是可读取的文件");
    }
    return readFileSync(actualPath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if (error instanceof AnalyticsSkillCatalogError) throw error;
    throw new AnalyticsSkillCatalogError(path, "文件不存在或读取失败");
  }
}

function frontmatterString(value: string, field: string, path: string): string {
  let decoded: string;
  const invalid = () => new AnalyticsSkillCatalogError(path, `frontmatter ${field} 必须是非空单行 YAML 字符串`);
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string") throw invalid();
      decoded = parsed;
    } catch { throw invalid(); }
  } else if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) throw invalid();
    decoded = value.slice(1, -1).replace(/''/g, "'");
  } else {
    // 限定为单行字符串；不将 YAML 数字、布尔、集合或块标量误当作描述。
    if (!value || /^[\[\]{},&*!|>@`%#?"']/.test(value) || /^[-:](?:\s|$)/.test(value)
      || /:\s|\s#/.test(value) || /^(?:true|false|null|~|[-+]?\.(?:inf|nan))$/i.test(value)
      || !Number.isNaN(Number(value.replaceAll("_", ""))) || /^\d{4}-\d{2}-\d{2}(?:$|[Tt\s])/.test(value)) throw invalid();
    decoded = value;
  }
  if (!decoded.trim() || /[\r\n\u0000]/.test(decoded)) throw invalid();
  return decoded;
}

function parseSkill(text: string, name: AnalyticsSkillName): AnalyticsSkillInfo {
  const path = `skills/${name}/SKILL.md`;
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") throw new AnalyticsSkillCatalogError(path, "缺少起始 frontmatter 分隔线");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new AnalyticsSkillCatalogError(path, "缺少结束 frontmatter 分隔线");
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    if (!line.trim()) continue;
    const match = /^(name|description):[ \t]*(.*)$/.exec(line);
    if (!match) throw new AnalyticsSkillCatalogError(path, "frontmatter 只能包含 name、description 两个单行字段");
    const [, key, value] = match;
    if (fields.has(key)) throw new AnalyticsSkillCatalogError(path, `frontmatter 字段 ${key} 重复`);
    fields.set(key, frontmatterString(value.trim(), key, path));
  }
  for (const key of ["name", "description"]) {
    if (!fields.has(key)) throw new AnalyticsSkillCatalogError(path, `frontmatter 缺少 ${key}`);
  }
  if (fields.get("name") !== name) {
    throw new AnalyticsSkillCatalogError(path, `Skill name 必须与受管目录 ${name} 一致`);
  }

  const titles: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const line of lines.slice(end + 1)) {
    const fenced = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (fenced && fenced[1][0] === fence.marker && fenced[1].length >= fence.length && !fenced[2].trim()) fence = undefined;
      continue;
    }
    if (fenced) {
      fence = { marker: fenced[1][0], length: fenced[1].length };
      continue;
    }
    const heading = /^ {0,3}#(?:[ \t]+(.*))?[ \t]*$/.exec(line);
    if (heading) titles.push((heading[1] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim());
  }
  if (titles.length !== 1 || !titles[0]) {
    throw new AnalyticsSkillCatalogError(path, "正文必须且只能包含一个非空 H1 标题");
  }
  return Object.freeze({ name, qualifiedName: `analytics:${name}`, title: titles[0], description: fields.get("description")!, relativePath: path });
}

export function loadAnalyticsSkillCatalog(pluginDir: string): readonly AnalyticsSkillInfo[] {
  let root: string;
  try {
    root = realpathSync(pluginDir);
  } catch {
    throw new AnalyticsSkillCatalogError(".", "插件目录不存在或读取失败");
  }
  const manifestPath = ".claude-plugin/plugin.json";
  const manifestText = readPluginFile(root, manifestPath);
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new AnalyticsSkillCatalogError(manifestPath, "插件清单不是有效 JSON");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !("name" in manifest) || manifest.name !== "analytics") {
    throw new AnalyticsSkillCatalogError(manifestPath, "插件清单必须是 name 为 analytics 的 JSON 对象");
  }
  // 不遍历旧分析 Skill，也不复用执行插件的六节及仓库来源校验。
  return Object.freeze(ANALYTICS_SKILL_NAMES.map((name) => parseSkill(readPluginFile(root, `skills/${name}/SKILL.md`), name)));
}
