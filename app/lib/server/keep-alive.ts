// 文件问答的回答流原样透传时，线上（butler 的 traefik + wrangler）约 90 秒就断，和营销分析流一样在页面这一层补保活。
// 只在一行结束后插空行，不会切断被分块传来的 JSON 行；消费方会跳过空行。
export function withKeepAlive(source: ReadableStream<Uint8Array>, everyMs = 250): ReadableStream<Uint8Array> {
  const reader = source.getReader(); const newline = new Uint8Array([10]);
  let atLineEnd = true; let timer: ReturnType<typeof setInterval> | undefined; let closed = false;
  return new ReadableStream<Uint8Array>({
    start(output) {
      timer = setInterval(() => { if (!closed && atLineEnd && (output.desiredSize ?? 0) > 0) { try { output.enqueue(newline); } catch { closed = true; } } }, everyMs);
      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            if (value.length) { output.enqueue(value); atLineEnd = value[value.length - 1] === 10; }
          }
          if (!closed) { closed = true; output.close(); }
        } catch (error) { if (!closed) { closed = true; output.error(error); } }
        finally { clearInterval(timer); }
      })();
    },
    cancel(reason) { closed = true; clearInterval(timer); return reader.cancel(reason); },
  });
}
