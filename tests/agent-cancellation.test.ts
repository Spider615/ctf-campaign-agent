import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentRequest } from "../app/lib/agent/protocol.ts";
import { createCampaignDraft } from "../app/lib/campaign/workspace.ts";
import { createAgentRunner, type AgentQuery } from "../agent/run-turn.ts";

const request: AgentRequest = {
  today: "2026-09-17",
  campaign: createCampaignDraft("campaign-1", "你好"),
  draft: null,
  history: [],
  trigger: { kind: "first_message", text: "你好" },
  campaignStage: "briefing",
  ics1811Phase: null,
  openQuestions: [],
  proposals: [],
  canUndo: false,
};

for (const alreadyAborted of [false, true]) {
  test(`external cancellation aborts the SDK query (${alreadyAborted ? "before" : "during"} query)`, { timeout: 5000 }, async (t) => {
    const runtimeDir = mkdtempSync(join(tmpdir(), "ctf-agent-cancel-"));
    t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
    const started = Promise.withResolvers<AbortController>();
    const query: AgentQuery = async function* ({ options }) {
      const sdkController = options!.abortController!;
      started.resolve(sdkController);
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new DOMException("已停止", "AbortError"));
        if (sdkController.signal.aborted) abort();
        else sdkController.signal.addEventListener("abort", abort, { once: true });
      });
    };
    const runner = createAgentRunner({
      model: "test-model",
      modelBaseUrl: "http://127.0.0.1",
      apiKey: "test-key",
      runtimeDir,
      pluginDir: join(process.cwd(), "agent/plugin"),
    }, { query });
    const controller = new AbortController();
    if (alreadyAborted) controller.abort();
    const pending = runner(request, undefined, undefined, controller.signal);
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
    void rejected.catch(() => {});
    const sdkController = await started.promise;
    try {
      if (!alreadyAborted) {
        let settled = false;
        void pending.then(() => { settled = true; }, () => { settled = true; });
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(settled, false);
        controller.abort();
      }
      assert.equal(sdkController.signal.aborted, true);
      await rejected;
    } finally {
      sdkController.abort();
      await pending.catch(() => {});
    }
  });
}
