import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function privateAnalyticsDirectory(directory: string): string {
  const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  let parent = resolve(directory); const suffix: string[] = [];
  while (!existsSync(parent)) { suffix.unshift(basename(parent)); parent = dirname(parent); }
  const actual = resolve(realpathSync(parent), ...suffix);
  const outside = (path: string) => { const value = relative(root, path); return value && (value.startsWith(`..${sep}`) || isAbsolute(value)); };
  if (!outside(actual)) throw new Error("分析私有记录必须保存在仓库之外");
  mkdirSync(actual, { recursive: true, mode: 0o700 });
  const final = realpathSync(actual);
  if (!outside(final)) throw new Error("分析私有记录必须保存在仓库之外");
  return final;
}
