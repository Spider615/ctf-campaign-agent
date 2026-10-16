import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// 在 Node strip-types 测试中加载真实组件及其 TSX 依赖，不替换业务渲染器。
export async function loadReactComponent(t: { after(fn: () => void): void }, entry: string) {
  const directory = mkdtempSync(resolve("node_modules/.cache-visualization-ui-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const compiled = new Map<string, string>();
  const visit = (path: string): string => {
    if (extname(path) !== ".tsx") return pathToFileURL(path).href;
    const existing = compiled.get(path); if (existing) return existing;
    const target = resolve(directory, `component-${compiled.size}.mjs`); const url = pathToFileURL(target).href; compiled.set(path, url);
    const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    writeFileSync(target, code.replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_match, quote: string, relative: string) => {
      let dependency = resolve(dirname(path), relative); if (!existsSync(dependency)) dependency += existsSync(dependency + ".ts") ? ".ts" : ".tsx";
      return `from ${quote}${visit(dependency)}${quote}`;
    }));
    return url;
  };
  return import(visit(resolve(entry)));
}
