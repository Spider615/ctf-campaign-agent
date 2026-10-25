import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadAnalyticsSkillCatalog } from "./analytics-skill-catalog.ts";

// 运行时只提供两份已校验Skill，旧文件继续留在原插件供附件使用。
// 既使用SDK发现过滤，也隔离物理插件目录，避免安装版本的发现清单差异。
export function prepareAnalyticsSkillPlugin(source: string, runtime: string) {
  const catalog = loadAnalyticsSkillCatalog(source);
  mkdirSync(runtime, { recursive: true });
  const path = mkdtempSync(join(runtime, "qa-plugin-"));
  try {
    mkdirSync(join(path, ".claude-plugin"));
    writeFileSync(join(path, ".claude-plugin/plugin.json"), JSON.stringify({ name: "analytics", version: "1.0.0", description: "经营问答的可选方法" }));
    for (const skill of catalog) {
      const target = join(path, skill.relativePath); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(source, skill.relativePath)));
    }
    const verified = loadAnalyticsSkillCatalog(path);
    return { path, catalog: verified, dispose: () => rmSync(path, { recursive: true, force: true }) };
  } catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
}
