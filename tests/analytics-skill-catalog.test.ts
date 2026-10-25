import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AnalyticsSkillCatalogError, loadAnalyticsSkillCatalog } from "../agent/analytics-skill-catalog.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "analytics-skill-catalog-"));
test.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
const pluginDirectory = fileURLToPath(new URL("../agent/analytics-plugin/", import.meta.url));
const names = ["ctf-qa", "marketing-theory"] as const;
let sequence = 0;

function markdown(name: string): string {
  return `---\nname: ${name}\ndescription: 需要解释经营问题时参考\n---\n\n# ${name} 指引\n\n按当前问题选择证据和表达。\n`;
}

function writeSkill(plugin: string, name: string, content = markdown(name)): void {
  mkdirSync(join(plugin, "skills", name), { recursive: true });
  writeFileSync(join(plugin, "skills", name, "SKILL.md"), content);
}

function fixture(): string {
  const plugin = join(fixtureRoot, `plugin-${++sequence}`);
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "analytics" }));
  for (const name of names) writeSkill(plugin, name);
  return plugin;
}

function rejectsCatalog(plugin: string, path: string, reason: RegExp): void {
  assert.throws(() => loadAnalyticsSkillCatalog(plugin), (error: unknown) => {
    assert.ok(error instanceof AnalyticsSkillCatalogError);
    assert.equal(error.relativePath, path);
    assert.match(error.detail, reason);
    assert.ok(error.message.includes(path));
    return true;
  });
}

test("目录提供 SDK 可用的两份独立 Skill 元信息，不要求执行插件的章节或来源格式", () => {
  const catalog = loadAnalyticsSkillCatalog(fixture());
  assert.deepEqual(catalog.map((entry) => entry.name), names);
  assert.deepEqual(catalog.map((entry) => entry.qualifiedName), names.map((name) => `analytics:${name}`));
  for (const entry of catalog) {
    assert.equal(entry.title, `${entry.name} 指引`);
    assert.equal(entry.description, "需要解释经营问题时参考");
    assert.equal(entry.relativePath, `skills/${entry.name}/SKILL.md`);
    assert.ok(Object.isFrozen(entry));
  }
  assert.ok(Object.isFrozen(catalog));
});

test("允许名单只来自两份新 Skill；损坏的旧 Skill 和其他插件不会进入或阻塞新目录", () => {
  const plugin = fixture();
  for (const name of ["ctf-marketing-advisor", "analysis-review", "campaign-orchestrator", "untrusted"]) {
    writeSkill(plugin, name, "这不是有效的 Skill，且不应被新会话读取。\n");
  }
  assert.deepEqual(loadAnalyticsSkillCatalog(plugin).map((entry) => entry.qualifiedName), [
    "analytics:ctf-qa", "analytics:marketing-theory",
  ]);
});

test("实际打包目录可独立识别两份新 Skill 的中文标题与适用描述", () => {
  const catalog = loadAnalyticsSkillCatalog(pluginDirectory);
  assert.deepEqual(catalog.map((entry) => entry.name), names);
  for (const entry of catalog) {
    assert.ok(entry.title.length > 0);
    assert.ok(entry.description.length > 0);
    assert.ok(readFileSync(join(pluginDirectory, entry.relativePath), "utf8").length > 100);
  }
});

for (const name of names) {
  test(`缺少 ${name} 时明确指出未打包的文件`, () => {
    const plugin = fixture();
    rmSync(join(plugin, "skills", name, "SKILL.md"));
    rejectsCatalog(plugin, `skills/${name}/SKILL.md`, /读取|不存在/);
  });
}

for (const [label, manifest, reason] of [
  ["错误插件", '{"name":"ics1811"}', /analytics/],
  ["损坏清单", "{", /JSON/],
  ["空清单", "null", /对象|analytics/],
  ["数组清单", '[{"name":"analytics"}]', /对象|analytics/],
] as const) {
  test(`${label} 不得开放 Skill`, () => {
    const plugin = fixture();
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), manifest);
    rejectsCatalog(plugin, ".claude-plugin/plugin.json", reason);
  });
}

const invalidFrontmatter = [
  ["无起始分隔线", "name: ctf-qa\ndescription: 说明\n---\n", /frontmatter/],
  ["无结束分隔线", "---\nname: ctf-qa\ndescription: 说明\n", /frontmatter/],
  ["缺少名字", "---\ndescription: 说明\n---\n", /name/],
  ["缺少描述", "---\nname: ctf-qa\n---\n", /description/],
  ["空描述", "---\nname: ctf-qa\ndescription:   \n---\n", /description/],
  ["空引号描述", '---\nname: ctf-qa\ndescription: "  "\n---\n', /description/],
  ["重复名字", "---\nname: ctf-qa\nname: ctf-qa\ndescription: 说明\n---\n", /重复/],
  ["重复描述", "---\nname: ctf-qa\ndescription: 说明\ndescription: 另一段\n---\n", /重复/],
  ["未知字段", "---\nname: ctf-qa\ndescription: 说明\nallowed-tools: Bash\n---\n", /字段/],
  ["布尔描述", "---\nname: ctf-qa\ndescription: true\n---\n", /字符串/],
  ["数字描述", "---\nname: ctf-qa\ndescription: 123\n---\n", /字符串/],
  ["对象描述", "---\nname: ctf-qa\ndescription: {text: 说明}\n---\n", /字符串/],
  ["列表描述", "---\nname: ctf-qa\ndescription: [说明]\n---\n", /字符串/],
  ["嵌套映射", "---\nname: ctf-qa\ndescription: 说明: 嵌套\n---\n", /字符串|单行/],
  ["块描述", "---\nname: ctf-qa\ndescription: |\n  说明\n---\n", /字符串|单行/],
] as const;

for (const [label, header, reason] of invalidFrontmatter) {
  test(`损坏 frontmatter：${label}`, () => {
    const plugin = fixture();
    writeSkill(plugin, "ctf-qa", `${header}\n# 指引\n\n正文。\n`);
    rejectsCatalog(plugin, "skills/ctf-qa/SKILL.md", reason);
  });
}

test("单行带引号的 YAML 字符串、字段换序和 CRLF 不影响识别", () => {
  const plugin = fixture();
  writeSkill(plugin, "ctf-qa", '---\r\ndescription: "业务判断: 何时需要证据"\r\nname: \'ctf-qa\'\r\n---\r\n\r\n# 问答指引\r\n');
  const entry = loadAnalyticsSkillCatalog(plugin)[0];
  assert.equal(entry.name, "ctf-qa");
  assert.equal(entry.description, "业务判断: 何时需要证据");
  assert.equal(entry.title, "问答指引");
});

for (const name of ["marketing-theory", "../ctf-qa", "/tmp/ctf-qa", "analytics:ctf-qa"]) {
  test(`名字必须匹配受管目录：${name}`, () => {
    const plugin = fixture();
    writeSkill(plugin, "ctf-qa", markdown(name));
    rejectsCatalog(plugin, "skills/ctf-qa/SKILL.md", /name|目录|名称/);
  });
}

for (const [label, body] of [
  ["无 H1", "## 说明\n\n正文。"],
  ["空 H1", "#   \n\n正文。"],
  ["只有闭合井号的空 H1", "# ###\n\n正文。"],
  ["多个 H1", "# 说明\n\n# 第二标题"],
] as const) {
  test(`${label} 时不能生成时间线标题`, () => {
    const plugin = fixture();
    writeSkill(plugin, "ctf-qa", `---\nname: ctf-qa\ndescription: 说明\n---\n\n${body}\n`);
    rejectsCatalog(plugin, "skills/ctf-qa/SKILL.md", /H1/);
  });
}

test("代码块中的井号不冒充 Skill 标题，Markdown 标题的结尾井号不进入显示名", () => {
  const plugin = fixture();
  writeSkill(plugin, "ctf-qa", `${markdown("ctf-qa").replace("# ctf-qa 指引", "# 问答指引 ###")}\n\`\`\`markdown\n# 示例文本\n\`\`\`\n`);
  assert.equal(loadAnalyticsSkillCatalog(plugin)[0].title, "问答指引");
});

for (const path of [".claude-plugin/plugin.json", "skills/ctf-qa/SKILL.md", "skills/marketing-theory/SKILL.md"]) {
  test(`拒绝通过文件软链接读取插件外内容：${path}`, () => {
    const plugin = fixture();
    const outside = join(fixtureRoot, `outside-${++sequence}`);
    writeFileSync(outside, readFileSync(join(plugin, path)));
    rmSync(join(plugin, path));
    symlinkSync(outside, join(plugin, path));
    rejectsCatalog(plugin, path, /越界|超出/);
  });
}

for (const path of ["skills", "skills/ctf-qa", ".claude-plugin"]) {
  test(`拒绝通过目录软链接读取插件外内容：${path}`, () => {
    const plugin = fixture();
    const outside = fixture();
    rmSync(join(plugin, path), { recursive: true });
    symlinkSync(join(outside, path), join(plugin, path), "dir");
    const file = path === ".claude-plugin" ? ".claude-plugin/plugin.json" : "skills/ctf-qa/SKILL.md";
    rejectsCatalog(plugin, file, /越界|超出/);
  });
}

test("插件根目录自身可由调用方通过软链接指定，边界以真实根目录为准", () => {
  const plugin = fixture();
  const linked = join(fixtureRoot, `linked-${++sequence}`);
  symlinkSync(plugin, linked, "dir");
  assert.deepEqual(loadAnalyticsSkillCatalog(linked), loadAnalyticsSkillCatalog(plugin));
});
