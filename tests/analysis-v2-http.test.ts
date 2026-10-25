import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SDKMessage } from "../agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts";
import { createAgentHttpHandler } from "../agent/http-handler.ts";
import { createAnalyticsSkillRunner } from "../agent/analytics-skill-run-turn.ts";
import { analyticsAnswerText, consumeAnalyticsStream } from "../app/lib/analytics/stream.ts";
import { httpAnalyticsDatabase } from "./helpers/analytics-http.ts";

test("v3/v4 HTTP 请求将问候、致谢、身份、明确月份总额都送入新 SDK 会话", async (t) => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-qa-http-"));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const database = httpAnalyticsDatabase(); let opens = 0;
  const open = database.openAnalysisSession!;
  database.openAnalysisSession = (signal) => { opens++; return open(signal); };
  const questions: string[] = [];
  const runPlanAnalyticsTurn = createAnalyticsSkillRunner({ model: "test", apiKey: "test", modelBaseUrl: "https://example.invalid", runtimeDir, pluginDir: join(process.cwd(), "agent/analytics-plugin"), auditDirectory: join(runtimeDir, "audit"), database }, {
    query: async function* ({ prompt }) {
      assert.equal(typeof prompt, "string");
      const request = JSON.parse(prompt as string) as { question: string; history: unknown[]; context: string[] };
      questions.push(request.question);
      assert.deepEqual(request.history, [{ role: "user", text: "只看历史数据" }]);
      assert.deepEqual(request.context, ["洞察关注：大区与货类的联系"]);
      const text = `模型自主回答「${request.question}」，正文保留 9,876.54 元。`;
      yield { type: "assistant", message: { content: [{ type: "text", text }], stop_reason: "end_turn" } } as SDKMessage;
      yield { type: "result", subtype: "success", is_error: false, result: text } as SDKMessage;
    },
  });
  const server = createServer(createAgentHttpHandler({ token: "test", model: "test", database, runPlanAnalyticsTurn, runAgentTurn: async () => { throw new Error("不能调用执行工具"); }, runAnalyticsTurn: async () => { throw new Error("不能回退旧分析运行器"); } }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/analytics/database/explain/stream`;
  const inputs = ["你好", "谢谢", "你是谁", "2025年8月销售额是多少？"];
  for (const schema of ["analysis-answer/v3", "analysis-answer/v4"]) for (const question of inputs) {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test", "x-analytics-answer-schema": schema }, body: JSON.stringify({ mode: "database", question, history: [{ role: "user", text: "只看历史数据" }], context: ["洞察关注：大区与货类的联系"] }) });
    assert.equal(response.status, 200);
    const answer = await consumeAnalyticsStream(response);
    assert.equal("schema" in answer && answer.schema, "analysis-answer/v4");
    assert.equal(analyticsAnswerText(answer), `模型自主回答「${question}」，正文保留 9,876.54 元。`);
  }
  assert.deepEqual(questions, [...inputs, ...inputs]);
  assert.equal(opens, 0, "模型没有调用数据工具时，HTTP 不应主动连接数据库");
});
