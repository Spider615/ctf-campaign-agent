import assert from "node:assert/strict";
import test from "node:test";
import { withKeepAlive } from "../app/lib/server/keep-alive.ts";

test("回答流透传时补保活空行：只插在行尾，不切断分块传来的 JSON 行", async () => {
  const encoder = new TextEncoder(); let push!: (text: string) => void; let end!: () => void;
  const source = new ReadableStream<Uint8Array>({ start(c) { push = (t) => c.enqueue(encoder.encode(t)); end = () => c.close(); } });
  const reader = withKeepAlive(source, 10).getReader(); const decoder = new TextDecoder(); let text = "";
  const pump = (async () => { while (true) { const { done, value } = await reader.read(); if (done) break; text += decoder.decode(value); } })();
  await new Promise((r) => setTimeout(r, 35));
  push('{"type":"phase",'); await new Promise((r) => setTimeout(r, 35));
  push('"phase":"analyzing"}\n'); await new Promise((r) => setTimeout(r, 35));
  push('{"type":"result"}\n'); end(); await pump;
  assert.ok(text.startsWith("\n"), "等待时就有保活");
  assert.ok(text.includes('{"type":"phase","phase":"analyzing"}\n'), "半行中间没插空行");
  assert.deepEqual(text.split("\n").filter((l) => l.trim()), ['{"type":"phase","phase":"analyzing"}', '{"type":"result"}']);
});
