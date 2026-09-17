import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

test("等待圆点用独立延迟形成从左到右的波浪", async () => {
  const result = await build({
    entryPoints: ["app/components/chat/thinking-indicator.tsx"],
    bundle: true, write: false, format: "esm", jsx: "automatic",
    plugins: [{ name: "agent-row", setup(build) {
      build.onResolve({ filter: /^\.\/message-view$/ }, () => ({ path: "row", namespace: "test" }));
      build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export const AgentRow = ({children}) => children;" }));
    } }],
  });
  const { ThinkingIndicator } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  const row = ThinkingIndicator({ label: "正在理解" });
  const dots = row.props.children.props.children[0].props.children;
  assert.equal(dots.length, 3);
  assert.deepEqual(dots.map((dot: { props: { style?: { animationDelay?: string } } }) => dot.props.style?.animationDelay), ["-240ms", "-120ms", "0ms"]);
});
