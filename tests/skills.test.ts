import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as skillModule from "../agent/skills.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "ics1811-skills-"));
test.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const BASELINE = [
  "offer-entry-guide",
  "field-explainer",
  "settlement-guide",
  "promo-copy-guide",
] as const;

const MANIFEST = {
  name: "ics1811",
  version: "0.1.0",
  description: "周大福 ICS-1811 优惠开单活动的业务规则，按场景由 Agent 加载",
};

let fixtureSequence = 0;

function skillMarkdown(
  name: string,
  options: {
    description?: string;
    title?: string;
    sourcePath?: string;
    sourceLocator?: string;
  } = {},
): string {
  const description = options.description ?? `解释 ${name} 的测试规则。`;
  const title = options.title ?? `${name} 测试指引`;
  const sourcePath = options.sourcePath ?? "docs/source.md";
  const sourceLocator = options.sourceLocator === undefined ? "测试夹具" : options.sourceLocator;
  const locator = sourceLocator ? ` — ${sourceLocator}` : "";

  return `---
name: ${name}
description: ${description}
---

# ${title}

## 适用场景

- ${description}[S1]

## 回答原则

- 来源编号只用于内部维护和审计，不能向用户朗读。[S1]

## 业务知识

- 业务规则来自已列明的资料。[S1]

## 不能做什么

- 不编造资料之外的内容。[S1]

## 冲突处理

- 与工具冲突时以工具结果为准。[S1]

## 出处

- [S1] \`${sourcePath}\`${locator}
`;
}

function createPlugin(names: readonly string[] = BASELINE): string {
  fixtureSequence += 1;
  const pluginDir = join(fixtureRoot, `plugin-${fixtureSequence}`);
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(pluginDir, "skills"), { recursive: true });
  writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  for (const name of names) writeSkill(pluginDir, name, skillMarkdown(name));
  return pluginDir;
}

function writeSkill(pluginDir: string, directory: string, markdown: string): void {
  const skillDir = join(pluginDir, "skills", directory);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), markdown);
}

function replaceSkill(pluginDir: string, name: string, markdown: string): void {
  writeFileSync(join(pluginDir, "skills", name, "SKILL.md"), markdown);
}

function expectCatalogError(action: () => unknown, relativePath: string, reason: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof skillModule.SkillCatalogError);
    assert.equal(error.relativePath, relativePath);
    assert.match(error.detail, reason);
    assert.match(error.message, new RegExp(relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    return true;
  });
}

function requiredSkills(text: string) {
  return skillModule.requiredSkillsForTurn({
    trigger: { kind: "user_message", text },
  });
}

test("按知识请求保守选择基线 Skill，并保持基线顺序", () => {
  const cases: Array<[string, readonly string[]]> = [
    ["计折上折是什么意思", ["field-explainer"]],
    ["黄金以旧换新在 1811 怎么录", ["offer-entry-guide"]],
    ["两家店要不要说明函", ["settlement-guide"]],
    ["帮我写一版宣传文案", ["promo-copy-guide"]],
    ["浮动和固定有什么区别", ["field-explainer"]],
    ["固定折扣模式是什么意思", ["field-explainer"]],
    ["浮动折扣和固定折扣有什么区别", ["field-explainer"]],
    ["浮动折扣模式和固定折扣模式有什么区别", ["field-explainer"]],
    ["这个活动该选浮动还是固定，1811 怎么录", ["offer-entry-guide"]],
    ["先解释浮动和固定的区别，再告诉我这个活动怎么录", ["offer-entry-guide", "field-explainer"]],
    ["满减是什么意思", ["offer-entry-guide"]],
  ];

  for (const [text, expected] of cases) {
    assert.deepEqual(requiredSkills(text), expected, text);
  }
});

test("识别解释、录入、结算和文案请求的常用同义表达", () => {
  const cases: Array<[string, readonly string[]]> = [
    ["计折上折什么意思", ["field-explainer"]],
    ["让扣点是什么含义", ["field-explainer"]],
    ["回款率怎么理解", ["field-explainer"]],
    ["满减怎么填", ["offer-entry-guide"]],
    ["以旧换新如何录", ["offer-entry-guide"]],
    ["这个活动该选浮动还是固定", ["offer-entry-guide"]],
    ["抽奖是否支持", ["offer-entry-guide"]],
    ["说明函怎么上传", ["settlement-guide"]],
    ["说明函如何命名", ["settlement-guide"]],
    ["说明函必须上传吗", ["settlement-guide"]],
    ["请起草宣传文案", ["promo-copy-guide"]],
    ["修改活动文案", ["promo-copy-guide"]],
    ["润色宣传语", ["promo-copy-guide"]],
    ["评价这个标语", ["promo-copy-guide"]],
  ];

  for (const [text, expected] of cases) {
    assert.deepEqual(requiredSkills(text), expected, text);
  }
});

test("普通活动事实不因领域名词本身加载 Skill", () => {
  for (const text of [
    "10月1日到7日，7590店，钻石95折",
    "多店活动，门店是7590和7601",
    "让扣点2%，回款率98%",
  ]) {
    assert.deepEqual(requiredSkills(text), [], text);
  }
});

test("路由只归一化空白和大小写，首轮消息也使用同一规则", () => {
  assert.deepEqual(requiredSkills("  OUTLET   如何录  "), ["offer-entry-guide"]);
  assert.deepEqual(
    skillModule.requiredSkillsForTurn({
      trigger: { kind: "first_message", text: "计折上折是什么意思" },
    }),
    ["field-explainer"],
  );
});

test("发现基线和新增 Skill，并按短名称排序后生成精确限定名", () => {
  const pluginDir = createPlugin([...BASELINE, "additional-guide"]);
  const catalog = skillModule.loadSkillCatalog(pluginDir);
  const expected = [
    "additional-guide",
    "field-explainer",
    "offer-entry-guide",
    "promo-copy-guide",
    "settlement-guide",
  ];

  assert.deepEqual(catalog.map((skill) => skill.name), expected);
  assert.deepEqual(skillModule.qualifiedSkillNames(catalog), expected.map((name) => `ics1811:${name}`));
  assert.deepEqual(catalog[0], {
    name: "additional-guide",
    qualifiedName: "ics1811:additional-guide",
    title: "additional-guide 测试指引",
    description: "解释 additional-guide 的测试规则。",
    relativePath: "skills/additional-guide/SKILL.md",
    sources: [{ id: "S1", path: "docs/source.md", note: "测试夹具" }],
  });
});

test("缺少插件清单时报带相对路径的错误", () => {
  const pluginDir = createPlugin();
  rmSync(join(pluginDir, ".claude-plugin", "plugin.json"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(pluginDir),
    ".claude-plugin/plugin.json",
    /不存在|读取失败/,
  );
});

test("插件清单不是有效 JSON 或插件名错误时拒绝", () => {
  const malformed = createPlugin();
  writeFileSync(join(malformed, ".claude-plugin", "plugin.json"), "{");
  expectCatalogError(
    () => skillModule.loadSkillCatalog(malformed),
    ".claude-plugin/plugin.json",
    /JSON/,
  );

  const wrongName = createPlugin();
  writeFileSync(
    join(wrongName, ".claude-plugin", "plugin.json"),
    JSON.stringify({ ...MANIFEST, name: "another-plugin" }),
  );
  expectCatalogError(
    () => skillModule.loadSkillCatalog(wrongName),
    ".claude-plugin/plugin.json",
    /ics1811/,
  );
});

test("缺少 skills 目录时拒绝", () => {
  const pluginDir = createPlugin();
  rmSync(join(pluginDir, "skills"), { recursive: true, force: true });
  expectCatalogError(() => skillModule.loadSkillCatalog(pluginDir), "skills", /目录|读取/);
});

test("skills 为空时拒绝", () => {
  const pluginDir = createPlugin([]);
  expectCatalogError(() => skillModule.loadSkillCatalog(pluginDir), "skills", /为空|基线/);
});

for (const missing of BASELINE) {
  test(`缺少基线 Skill ${missing} 时拒绝`, () => {
    const pluginDir = createPlugin(BASELINE.filter((name) => name !== missing));
    expectCatalogError(() => skillModule.loadSkillCatalog(pluginDir), "skills", new RegExp(missing));
  });
}

test("Skill 目录缺少 SKILL.md 时拒绝", () => {
  const pluginDir = createPlugin();
  rmSync(join(pluginDir, "skills", "field-explainer", "SKILL.md"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(pluginDir),
    "skills/field-explainer/SKILL.md",
    /不存在|文件/,
  );
});

test("Skill 目录含额外文件时拒绝", () => {
  const pluginDir = createPlugin();
  writeFileSync(join(pluginDir, "skills", "field-explainer", "notes.md"), "extra");
  expectCatalogError(
    () => skillModule.loadSkillCatalog(pluginDir),
    "skills/field-explainer",
    /只能包含|额外/,
  );
});

test("skills 目录直属普通文件时拒绝", () => {
  const pluginDir = createPlugin();
  writeFileSync(join(pluginDir, "skills", "README.md"), "extra");
  expectCatalogError(() => skillModule.loadSkillCatalog(pluginDir), "skills/README.md", /目录/);
});

test("frontmatter 格式错误时拒绝", () => {
  const pluginDir = createPlugin();
  replaceSkill(pluginDir, "field-explainer", skillMarkdown("field-explainer").replace(/^---\n/, ""));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(pluginDir),
    "skills/field-explainer/SKILL.md",
    /frontmatter/,
  );
});

test("frontmatter 缺少结束分隔线或必要字段时拒绝", () => {
  const noClosing = createPlugin();
  replaceSkill(noClosing, "field-explainer", skillMarkdown("field-explainer").replace(/\n---\n\n#/, "\n\n#"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(noClosing),
    "skills/field-explainer/SKILL.md",
    /结束.*frontmatter|frontmatter.*结束/,
  );

  const noName = createPlugin();
  replaceSkill(noName, "field-explainer", skillMarkdown("field-explainer").replace("name: field-explainer\n", ""));
  expectCatalogError(() => skillModule.loadSkillCatalog(noName), "skills/field-explainer/SKILL.md", /缺少 name/);

  const noDescription = createPlugin();
  replaceSkill(noDescription, "field-explainer", skillMarkdown("field-explainer").replace(/description: .*\n/, ""));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(noDescription),
    "skills/field-explainer/SKILL.md",
    /缺少 description/,
  );
});

test("frontmatter 有未知、重复或空白字段时拒绝", () => {
  const unknown = createPlugin();
  replaceSkill(
    unknown,
    "field-explainer",
    skillMarkdown("field-explainer").replace("description:", "version: 1\ndescription:"),
  );
  expectCatalogError(
    () => skillModule.loadSkillCatalog(unknown),
    "skills/field-explainer/SKILL.md",
    /未知.*version|version.*未知/,
  );

  const duplicate = createPlugin();
  replaceSkill(
    duplicate,
    "field-explainer",
    skillMarkdown("field-explainer").replace("description:", "name: field-explainer\ndescription:"),
  );
  expectCatalogError(
    () => skillModule.loadSkillCatalog(duplicate),
    "skills/field-explainer/SKILL.md",
    /重复.*name|name.*重复/,
  );

  const blank = createPlugin();
  replaceSkill(
    blank,
    "field-explainer",
    skillMarkdown("field-explainer").replace("description:", "\ndescription:"),
  );
  expectCatalogError(
    () => skillModule.loadSkillCatalog(blank),
    "skills/field-explainer/SKILL.md",
    /空白|空行/,
  );

  const malformedKey = createPlugin();
  replaceSkill(
    malformedKey,
    "field-explainer",
    skillMarkdown("field-explainer").replace("name: field-explainer", " name: field-explainer"),
  );
  expectCatalogError(
    () => skillModule.loadSkillCatalog(malformedKey),
    "skills/field-explainer/SKILL.md",
    /单行|frontmatter/,
  );
});

test("description 遵守 YAML 安全未加引号字符串子集", () => {
  const invalidDescriptions = [
    "解释 ICS-1811: 字段和业务名词。",
    "内容 # 注释",
    "# 解释字段和业务名词。",
    "\"带引号的描述\"",
    "'带引号的描述'",
    "true",
    "123",
    "1.",
    "1.e2",
    "1.e+2",
    "0b1_0",
    ".inf",
    ".NaN",
    "2026-09-17",
  ];
  for (const description of invalidDescriptions) {
    const pluginDir = createPlugin();
    replaceSkill(pluginDir, "field-explainer", skillMarkdown("field-explainer", { description }));
    expectCatalogError(
      () => skillModule.loadSkillCatalog(pluginDir),
      "skills/field-explainer/SKILL.md",
      /description.*(?:YAML|字符串|标量)|YAML.*description/,
    );
  }

  for (const description of ["解释字段 \"计折上折\"", "1811 活动字段说明"]) {
    const valid = createPlugin();
    replaceSkill(valid, "field-explainer", skillMarkdown("field-explainer", { description }));
    assert.equal(skillModule.loadSkillCatalog(valid).find((skill) => skill.name === "field-explainer")?.description, description);
  }
});

test("Skill 名称格式错误或与目录不一致时拒绝", () => {
  const invalid = createPlugin();
  replaceSkill(invalid, "field-explainer", skillMarkdown("Field_Explainer"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(invalid),
    "skills/field-explainer/SKILL.md",
    /名称.*格式|name.*格式/,
  );

  const mismatch = createPlugin();
  replaceSkill(mismatch, "field-explainer", skillMarkdown("another-guide"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(mismatch),
    "skills/field-explainer/SKILL.md",
    /目录.*一致|一致.*目录/,
  );
});

test("Skill name 超过 64 个 Unicode code point 时拒绝", () => {
  const pluginDir = createPlugin();
  replaceSkill(pluginDir, "field-explainer", skillMarkdown("a".repeat(65)));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(pluginDir),
    "skills/field-explainer/SKILL.md",
    /name.*格式|名称.*格式/,
  );
});

test("SKILL.md 不是普通文件时拒绝", () => {
  const pluginDir = createPlugin();
  rmSync(join(pluginDir, "skills", "field-explainer", "SKILL.md"));
  mkdirSync(join(pluginDir, "skills", "field-explainer", "SKILL.md"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(pluginDir),
    "skills/field-explainer/SKILL.md",
    /可读取|文件/,
  );
});

test("普通 SKILL.md 读取失败时包装为带路径的 SkillCatalogError", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const pluginDir = createPlugin();
  const skillPath = join(pluginDir, "skills", "field-explainer", "SKILL.md");
  chmodSync(skillPath, 0o000);
  try {
    expectCatalogError(
      () => skillModule.loadSkillCatalog(pluginDir),
      "skills/field-explainer/SKILL.md",
      /读取失败/,
    );
  } finally {
    chmodSync(skillPath, 0o644);
  }
});

test("声明名称重复时拒绝", () => {
  const pluginDir = createPlugin([...BASELINE, "zz-extra-guide"]);
  replaceSkill(pluginDir, "zz-extra-guide", skillMarkdown("field-explainer"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(pluginDir),
    "skills/zz-extra-guide/SKILL.md",
    /重复/,
  );
});

test("description 为空或超过 1024 个 Unicode code point 时拒绝", () => {
  const empty = createPlugin();
  replaceSkill(empty, "field-explainer", skillMarkdown("field-explainer").replace(/description: .+/, "description: "));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(empty),
    "skills/field-explainer/SKILL.md",
    /description.*空|空.*description/,
  );

  const long = createPlugin();
  replaceSkill(long, "field-explainer", skillMarkdown("field-explainer", { description: "活".repeat(1025) }));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(long),
    "skills/field-explainer/SKILL.md",
    /description.*1024|1024.*description/,
  );
});

test("缺少、重复或乱序的六个 H2 章节时拒绝", () => {
  const missing = createPlugin();
  replaceSkill(missing, "field-explainer", skillMarkdown("field-explainer").replace("## 不能做什么", "### 不能做什么"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(missing),
    "skills/field-explainer/SKILL.md",
    /章节|H2/,
  );

  const duplicate = createPlugin();
  replaceSkill(duplicate, "field-explainer", skillMarkdown("field-explainer").replace("## 出处", "## 冲突处理\n\n## 出处"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(duplicate),
    "skills/field-explainer/SKILL.md",
    /章节|H2|重复/,
  );

  const reordered = createPlugin();
  replaceSkill(
    reordered,
    "field-explainer",
    skillMarkdown("field-explainer")
      .replace("## 回答原则", "## TEMP")
      .replace("## 业务知识", "## 回答原则")
      .replace("## TEMP", "## 业务知识"),
  );
  expectCatalogError(
    () => skillModule.loadSkillCatalog(reordered),
    "skills/field-explainer/SKILL.md",
    /顺序|章节|H2/,
  );
});

test("H1 缺失、重复、为空或章节前有正文时拒绝", () => {
  const missing = createPlugin();
  replaceSkill(missing, "field-explainer", skillMarkdown("field-explainer").replace(/^# .+$/m, ""));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(missing),
    "skills/field-explainer/SKILL.md",
    /H1/,
  );

  const duplicate = createPlugin();
  replaceSkill(duplicate, "field-explainer", skillMarkdown("field-explainer").replace("## 适用场景", "# 第二标题\n\n## 适用场景"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(duplicate),
    "skills/field-explainer/SKILL.md",
    /H1/,
  );

  const empty = createPlugin();
  replaceSkill(empty, "field-explainer", skillMarkdown("field-explainer").replace(/^# .+$/m, "# "));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(empty),
    "skills/field-explainer/SKILL.md",
    /H1/,
  );

  const textBeforeSections = createPlugin();
  replaceSkill(textBeforeSections, "field-explainer", skillMarkdown("field-explainer").replace("## 适用场景", "这段正文不应出现。\n\n## 适用场景"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(textBeforeSections),
    "skills/field-explainer/SKILL.md",
    /H1.*章节|章节.*正文|正文/,
  );
});

test("超过 500 行时拒绝", () => {
  const pluginDir = createPlugin();
  const base = skillMarkdown("field-explainer");
  replaceSkill(pluginDir, "field-explainer", `${base}${"\n".repeat(501)}`);
  expectCatalogError(
    () => skillModule.loadSkillCatalog(pluginDir),
    "skills/field-explainer/SKILL.md",
    /500/,
  );
});

test("前五节每条非空规则必须是单行列表项并以来源标签结尾", () => {
  const notAList = createPlugin();
  replaceSkill(notAList, "field-explainer", skillMarkdown("field-explainer").replace("- 业务规则来自已列明的资料。[S1]", "业务规则来自已列明的资料。[S1]"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(notAList),
    "skills/field-explainer/SKILL.md",
    /列表|规则/,
  );

  const continuation = createPlugin();
  replaceSkill(continuation, "field-explainer", skillMarkdown("field-explainer").replace("- 业务规则来自已列明的资料。[S1]", "- 业务规则来自已列明的资料\n  补充内容。[S1]"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(continuation),
    "skills/field-explainer/SKILL.md",
    /单行|列表|规则/,
  );

  const noTag = createPlugin();
  replaceSkill(noTag, "field-explainer", skillMarkdown("field-explainer").replace("- 业务规则来自已列明的资料。[S1]", "- 业务规则来自已列明的资料。"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(noTag),
    "skills/field-explainer/SKILL.md",
    /来源|S#/,
  );
});

test("前五节不能是空章节", () => {
  const pluginDir = createPlugin();
  replaceSkill(
    pluginDir,
    "field-explainer",
    skillMarkdown("field-explainer").replace(
      "- 业务规则来自已列明的资料。[S1]",
      "",
    ),
  );
  expectCatalogError(
    () => skillModule.loadSkillCatalog(pluginDir),
    "skills/field-explainer/SKILL.md",
    /至少.*一条|非空规则|空章节/,
  );
});

test("正文中非行尾来源引用也必须定义", () => {
  const pluginDir = createPlugin();
  replaceSkill(
    pluginDir,
    "field-explainer",
    skillMarkdown("field-explainer").replace(
      "- 业务规则来自已列明的资料。[S1]",
      "- 业务规则 [S99] 来自已列明的资料。[S1]",
    ),
  );
  expectCatalogError(
    () => skillModule.loadSkillCatalog(pluginDir),
    "skills/field-explainer/SKILL.md",
    /S99.*定义|定义.*S99/,
  );
});

test("一条规则可以在末尾引用多个带空格分隔的来源标签", () => {
  const pluginDir = createPlugin();
  replaceSkill(
    pluginDir,
    "field-explainer",
    skillMarkdown("field-explainer")
      .replace(
        "- 解释 field-explainer 的测试规则。[S1]",
        "- 解释 field-explainer 的测试规则。[S1] [S2]",
      )
      .replace("- [S1] `docs/source.md` — 测试夹具", "- [S1] `docs/source.md` — 测试夹具\n- [S2] `docs/other.md`"),
  );
  assert.doesNotThrow(() => skillModule.loadSkillCatalog(pluginDir));
});

test("使用过的来源必须恰好定义一次，定义的来源也必须被使用", () => {
  const missingDefinition = createPlugin();
  replaceSkill(missingDefinition, "field-explainer", skillMarkdown("field-explainer").replace("资料。[S1]", "资料。[S2]"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(missingDefinition),
    "skills/field-explainer/SKILL.md",
    /S2.*定义|定义.*S2/,
  );

  const duplicateDefinition = createPlugin();
  replaceSkill(duplicateDefinition, "field-explainer", `${skillMarkdown("field-explainer").trimEnd()}\n- [S1] \`docs/other.md\`\n`);
  expectCatalogError(
    () => skillModule.loadSkillCatalog(duplicateDefinition),
    "skills/field-explainer/SKILL.md",
    /S1.*重复|重复.*S1/,
  );

  const unusedDefinition = createPlugin();
  replaceSkill(unusedDefinition, "field-explainer", `${skillMarkdown("field-explainer").trimEnd()}\n- [S2] \`docs/other.md\`\n`);
  expectCatalogError(
    () => skillModule.loadSkillCatalog(unusedDefinition),
    "skills/field-explainer/SKILL.md",
    /S2.*未使用|未使用.*S2/,
  );
});

test("来源定义必须使用安全的仓库相对路径和可选非空定位说明", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["absolute", "/tmp/source.md", /相对路径|绝对路径/],
    ["parent", "../source.md", /\.\.|仓库/],
    ["url", "https://example.com/source", /URL|协议/],
    ["backslash", "docs\\source.md", /相对路径/],
    ["dot-segment", "docs/./source.md", /相对路径/],
    ["empty-segment", "docs//source.md", /相对路径/],
    ["whitespace", " docs/source.md", /相对路径/],
  ];
  for (const [, sourcePath, reason] of cases) {
    const pluginDir = createPlugin();
    replaceSkill(pluginDir, "field-explainer", skillMarkdown("field-explainer", { sourcePath }));
    expectCatalogError(
      () => skillModule.loadSkillCatalog(pluginDir),
      "skills/field-explainer/SKILL.md",
      reason,
    );
  }

  const emptyLocator = createPlugin();
  replaceSkill(
    emptyLocator,
    "field-explainer",
    skillMarkdown("field-explainer").replace(" — 测试夹具", " — "),
  );
  expectCatalogError(
    () => skillModule.loadSkillCatalog(emptyLocator),
    "skills/field-explainer/SKILL.md",
    /定位|说明|格式/,
  );

  const whitespaceLocator = createPlugin();
  replaceSkill(
    whitespaceLocator,
    "field-explainer",
    skillMarkdown("field-explainer").replace(" — 测试夹具", " —    "),
  );
  expectCatalogError(
    () => skillModule.loadSkillCatalog(whitespaceLocator),
    "skills/field-explainer/SKILL.md",
    /定位|说明|格式/,
  );

  for (const sourceLocator of [
    "https://example.com/source",
    "补充出处 https://example.com/source",
    "另见 mailto:outside@example.com",
    "https:/example.com/source",
  ]) {
    const externalLocator = createPlugin();
    replaceSkill(
      externalLocator,
      "field-explainer",
      skillMarkdown("field-explainer", { sourceLocator }),
    );
    expectCatalogError(
      () => skillModule.loadSkillCatalog(externalLocator),
      "skills/field-explainer/SKILL.md",
      /URL|协议/,
    );
  }

  const mailtoLocator = createPlugin();
  replaceSkill(
    mailtoLocator,
    "field-explainer",
    skillMarkdown("field-explainer", { sourceLocator: "mailto:outside@example.com" }),
  );
  expectCatalogError(
    () => skillModule.loadSkillCatalog(mailtoLocator),
    "skills/field-explainer/SKILL.md",
    /URL|协议/,
  );

  for (const placeholder of ["TODO", "TBD", "以后补"]) {
    const pluginDir = createPlugin();
    replaceSkill(pluginDir, "field-explainer", skillMarkdown("field-explainer", { sourceLocator: placeholder }));
    expectCatalogError(
      () => skillModule.loadSkillCatalog(pluginDir),
      "skills/field-explainer/SKILL.md",
      /占位|TODO|TBD|以后补/,
    );
  }
});

test("规则正文中的占位文字也会被拒绝", () => {
  const pluginDir = createPlugin();
  replaceSkill(
    pluginDir,
    "field-explainer",
    skillMarkdown("field-explainer").replace("业务规则来自已列明的资料。", "TODO 后续补充业务规则。"),
  );
  expectCatalogError(
    () => skillModule.loadSkillCatalog(pluginDir),
    "skills/field-explainer/SKILL.md",
    /占位|TODO/,
  );
});

test("来源定义必须严格匹配列表格式", () => {
  const pluginDir = createPlugin();
  replaceSkill(
    pluginDir,
    "field-explainer",
    skillMarkdown("field-explainer").replace("- [S1] `docs/source.md`", "* [S1] docs/source.md"),
  );
  expectCatalogError(
    () => skillModule.loadSkillCatalog(pluginDir),
    "skills/field-explainer/SKILL.md",
    /来源.*格式|格式.*来源/,
  );

  const zeroId = createPlugin();
  replaceSkill(zeroId, "field-explainer", skillMarkdown("field-explainer").replaceAll("S1", "S0"));
  expectCatalogError(
    () => skillModule.loadSkillCatalog(zeroId),
    "skills/field-explainer/SKILL.md",
    /来源|S#/,
  );
});

test("适用场景第一条去掉列表标记和来源标签后必须与 description 完全一致", () => {
  const pluginDir = createPlugin();
  replaceSkill(
    pluginDir,
    "field-explainer",
    skillMarkdown("field-explainer").replace("- 解释 field-explainer 的测试规则。[S1]", "- 解释另一个场景。[S1]"),
  );
  expectCatalogError(
    () => skillModule.loadSkillCatalog(pluginDir),
    "skills/field-explainer/SKILL.md",
    /description|适用场景/,
  );
});

test("加载目录时不要求来源文件存在，显式来源校验才检查缺失路径", () => {
  const pluginDir = createPlugin();
  const catalog = skillModule.loadSkillCatalog(pluginDir);
  assert.equal(catalog.length, BASELINE.length);

  const repoRoot = join(fixtureRoot, "empty-repo");
  mkdirSync(repoRoot);
  expectCatalogError(
    () => skillModule.validateSkillSources(catalog, repoRoot),
    "skills/field-explainer/SKILL.md",
    /docs\/source\.md.*不存在|不存在.*docs\/source\.md/,
  );
});

test("来源校验拒绝通过符号链接逃出仓库的路径", () => {
  const pluginDir = createPlugin();
  const catalog = skillModule.loadSkillCatalog(pluginDir);
  const repoRoot = join(fixtureRoot, `repo-${fixtureSequence}`);
  const outside = join(fixtureRoot, `outside-${fixtureSequence}.md`);
  mkdirSync(join(repoRoot, "docs"), { recursive: true });
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(repoRoot, "docs", "source.md"));

  expectCatalogError(
    () => skillModule.validateSkillSources(catalog, repoRoot),
    "skills/field-explainer/SKILL.md",
    /docs\/source\.md.*仓库|仓库.*docs\/source\.md/,
  );
});

test("来源文件存在于仓库内时显式校验通过", () => {
  const pluginDir = createPlugin();
  const catalog = skillModule.loadSkillCatalog(pluginDir);
  const repoRoot = join(fixtureRoot, `repo-${fixtureSequence}`);
  mkdirSync(join(repoRoot, "docs"), { recursive: true });
  writeFileSync(join(repoRoot, "docs", "source.md"), "source");
  assert.doesNotThrow(() => skillModule.validateSkillSources(catalog, repoRoot));
});

test("skillOf 只接受精确短名称或限定名", () => {
  const catalog = skillModule.loadSkillCatalog(createPlugin());
  const expected = catalog.find((skill) => skill.name === "field-explainer");
  assert.equal(skillModule.skillOf(catalog, "field-explainer"), expected);
  assert.equal(skillModule.skillOf(catalog, "ics1811:field-explainer"), expected);
  assert.equal(skillModule.skillOf(catalog, "ics1811:unknown"), null);
  assert.equal(skillModule.skillOf(catalog, "other-plugin:field-explainer"), null);
  assert.equal(skillModule.skillOf(catalog, "../field-explainer"), null);
  assert.equal(skillModule.skillOf(catalog, " field-explainer"), null);
  assert.equal(skillModule.skillOf(catalog, 42), null);
  assert.equal(skillModule.skillOf(catalog, null), null);
});

test("目录、条目、来源数组和来源对象全部冻结", () => {
  const catalog = skillModule.loadSkillCatalog(createPlugin());
  assert.ok(Object.isFrozen(catalog));
  for (const skill of catalog) {
    assert.ok(Object.isFrozen(skill));
    assert.ok(Object.isFrozen(skill.sources));
    assert.ok(skill.sources.every((source) => Object.isFrozen(source)));
  }
});

test("仓库内四份基线 Skill 通过严格目录和来源校验", () => {
  const pluginDir = join(repoRoot, "agent", "plugin");
  const manifest = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
  assert.deepEqual(manifest, MANIFEST);

  const catalog = skillModule.loadSkillCatalog(pluginDir);
  assert.deepEqual(catalog.map((skill) => skill.name), [
    "field-explainer",
    "offer-entry-guide",
    "promo-copy-guide",
    "settlement-guide",
  ]);
  assert.deepEqual(catalog.map((skill) => skill.title), [
    "ICS-1811 字段解释",
    "ICS-1811 优惠玩法与录入指引",
    "ICS-1811 对外宣传文案指引",
    "ICS-1811 结算说明函指引",
  ]);
  for (const skill of catalog) {
    const text = readFileSync(join(pluginDir, skill.relativePath), "utf8");
    assert.match(text, /来源编号[^\n]*内部维护[^\n]*审计[^\n]*不[^\n]*用户/);
  }
  assert.doesNotThrow(() => skillModule.validateSkillSources(catalog, repoRoot));
});
