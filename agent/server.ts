import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

import { createAgentHttpHandler } from "./http-handler.ts";
import { createAgentRunner } from "./run-turn.ts";

const envFile = fileURLToPath(new URL("../.dev.vars", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const HOST = process.env.AGENT_HOST || "127.0.0.1";
const PORT = Number(process.env.AGENT_PORT || 8788);
const TOKEN = process.env.AGENT_SERVICE_TOKEN || "";
const MODEL = process.env.AGENT_MODEL || "deepseek-flash";
const MODEL_BASE_URL = process.env.AGENT_MODEL_BASE_URL || "https://api.deepseek.com/anthropic";
const API_KEY = process.env.DEEPSEEK_API_KEY || "";
// AGENT_DEBUG=1 时打印每次工具调用的参数和结果；里面有活动内容，只在本地排查时打开。
const DEBUG = process.env.AGENT_DEBUG === "1";
// SDK 子进程的配置目录，和本机 ~/.claude 隔离：不读用户自己的设置、插件和钩子。
const RUNTIME_DIR = fileURLToPath(new URL("./.claude-runtime/", import.meta.url));
// 业务规则所在的本地插件（agent/plugin/skills/*/SKILL.md），每轮按需加载。
const PLUGIN_DIR = fileURLToPath(new URL("./plugin/", import.meta.url));

const runAgentTurn = createAgentRunner({
  model: MODEL,
  modelBaseUrl: MODEL_BASE_URL,
  apiKey: API_KEY,
  runtimeDir: RUNTIME_DIR,
  pluginDir: PLUGIN_DIR,
  debug: DEBUG,
});

const server = createServer(createAgentHttpHandler({ runAgentTurn, token: TOKEN, model: MODEL }));

if (!API_KEY) {
  console.error("缺少 DEEPSEEK_API_KEY：在仓库根目录的 .dev.vars 里填写。");
  process.exit(1);
}
server.listen(PORT, HOST, () => console.log(`Agent 服务已启动：http://${HOST}:${PORT}（模型 ${MODEL}）`));
