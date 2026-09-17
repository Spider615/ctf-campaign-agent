import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

test("开发和构建共用的 Workers 配置启用请求取消信号", async () => {
  const result = await build({
    entryPoints: ["vite.config.ts"], bundle: true, write: false, format: "esm", platform: "node",
    plugins: [{ name: "capture-plugin-options", setup(build) {
      build.onResolve({ filter: /^(vite|vinext|@cloudflare\/vite-plugin)$|sites-vite-plugin$|execution-profile\.mjs$/ }, ({ path }) => ({ path, namespace: "config-test" }));
      build.onLoad({ filter: /.*/, namespace: "config-test" }, ({ path }) => ({ contents:
        path === "vite" ? "export const defineConfig = value => value;"
          : path === "vinext" ? "export default () => ({name: 'vinext'});"
            : path === "@cloudflare/vite-plugin" ? "export const cloudflare = options => ({name: 'cloudflare', options});"
              : path.endsWith("execution-profile.mjs") ? "export const readExecutionProfile = () => 'portable';"
                : "export const sites = () => ({name: 'sites'});",
      }));
    } }],
  });
  const config = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  for (const command of ["serve", "build"]) {
    const resolved = await config.default({ command });
    const cloudflare = resolved.plugins.find((plugin: { name: string }) => plugin.name === "cloudflare");
    assert.ok(cloudflare.options.config.compatibility_flags.includes("enable_request_signal"), command);
  }
});
