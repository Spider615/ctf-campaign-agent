import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAgentHttpHandler } from "./http-handler.ts";
import { createAgentRunner } from "./run-turn.ts";
import { createAnalyticsRunner } from "./analytics-run-turn.ts";
import { createPlanAnalyticsRunner } from "./analysis-plan-run-turn.ts";
import { createMysqlAnalyticsDatabase } from "./analytics-database.ts";
import { createAttachmentStore } from "./attachments/store.ts";
import { createAttachmentsHttpHandler } from "./attachments/http.ts";
import { createConversationRunner } from "./attachments/run-turn.ts";
import { createInsightGraphService } from "./insight-graph.ts";
import { createInsightAskRunner } from "./insight-ask.ts";
import { modelConfigFromEnv } from "./model-gateway.ts";
import mysql from "mysql2/promise";

const envFile = fileURLToPath(new URL("../.dev.vars", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const HOST = process.env.AGENT_HOST || "127.0.0.1";
const PORT = Number(process.env.AGENT_PORT || 8788);
const TOKEN = process.env.AGENT_SERVICE_TOKEN || "";
// SDK 只会说 Anthropic 协议，公司模型网关是 OpenAI 兼容接口：本机回环起一个转换层，SDK 的 ANTHROPIC_BASE_URL 指向它。
const { model: MODEL, modelBaseUrl: MODEL_BASE_URL, apiKey: API_KEY } = await modelConfigFromEnv();
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

const database = process.env.CTF_MYSQL_HOST ? createMysqlAnalyticsDatabase({ host: process.env.CTF_MYSQL_HOST, port: Number(process.env.CTF_MYSQL_PORT || 3306), user: process.env.CTF_MYSQL_USER || "root", password: process.env.CTF_MYSQL_PASSWORD || "", database: process.env.CTF_MYSQL_DATABASE || "ctf_sales_202508", table: process.env.CTF_MYSQL_TABLE || "sales_detail_202508", evidenceDir: process.env.CTF_MYSQL_EVIDENCE_DIR || join(homedir(), "Library/Application Support/ctf-campaign-agent/mysql-evidence") }) : undefined;
const runAnalyticsTurn = createAnalyticsRunner({ model: MODEL, modelBaseUrl: MODEL_BASE_URL, apiKey: API_KEY, runtimeDir: RUNTIME_DIR,
  pluginDir: fileURLToPath(new URL("./analytics-plugin/", import.meta.url)), historyDirectory: process.env.ANALYTICS_HISTORY_DIR || undefined, database });
const runPlanAnalyticsTurn = createPlanAnalyticsRunner({ model: MODEL, modelBaseUrl: MODEL_BASE_URL, apiKey: API_KEY, runtimeDir: RUNTIME_DIR,
  pluginDir: fileURLToPath(new URL("./analytics-plugin/", import.meta.url)), auditDirectory: process.env.ANALYTICS_AUDIT_DIR || undefined, database });
const installedAttachmentPython = join(homedir(), "Library/Application Support/ctf-campaign-agent/attachment-python/bin/python3");
const attachmentStore = createAttachmentStore({ directory: process.env.ATTACHMENTS_DIR || join(homedir(), "Library/Application Support/ctf-campaign-agent/attachments"), python: process.env.ATTACHMENTS_PYTHON || (existsSync(installedAttachmentPython) ? installedAttachmentPython : "python3") });
const runConversation = createConversationRunner({ model: MODEL, modelBaseUrl: MODEL_BASE_URL, apiKey: API_KEY, runtimeDir: RUNTIME_DIR, pluginDir: PLUGIN_DIR, store: attachmentStore, runAnalytics: runPlanAnalyticsTurn, visionModel: process.env.ATTACHMENTS_VISION_MODEL });
// 洞察图谱默认读源表：问答用的投影表没有回收金标识和 sku 年龄。
const insight = process.env.CTF_MYSQL_HOST ? createInsightGraphService({ table: process.env.CTF_INSIGHT_TABLE || "sales_detail_202508", evidenceDir: process.env.CTF_MYSQL_EVIDENCE_DIR || join(homedir(), "Library/Application Support/ctf-campaign-agent/mysql-evidence"),
  cacheDir: process.env.CTF_INSIGHT_CACHE_DIR || join(homedir(), "Library/Application Support/ctf-campaign-agent/insight-cache"),
  connect: () => mysql.createConnection({ host: process.env.CTF_MYSQL_HOST, port: Number(process.env.CTF_MYSQL_PORT || 3306), user: process.env.CTF_MYSQL_USER || "root", password: process.env.CTF_MYSQL_PASSWORD || "", database: process.env.CTF_MYSQL_DATABASE || "ctf_sales_202508", charset: "utf8mb4", connectTimeout: 5000, supportBigNumbers: true, bigNumberStrings: true }) }) : undefined;
const insightAsk = createInsightAskRunner({ model: MODEL, modelBaseUrl: MODEL_BASE_URL, apiKey: API_KEY, runtimeDir: RUNTIME_DIR });
const server = createServer(createAgentHttpHandler({ runAgentTurn, runAnalyticsTurn, runPlanAnalyticsTurn, database, token: TOKEN, model: MODEL, attachmentHandler: createAttachmentsHttpHandler({ store: attachmentStore, runConversation }), insight, insightAsk }));

if (!API_KEY) {
  console.error("缺少 JUZI_MODELS_KEY（公司模型网关 key）：本地在仓库根目录的 .dev.vars 里填写，容器部署时配成环境变量。");
  process.exit(1);
}
if (!TOKEN && !["127.0.0.1", "::1", "localhost"].includes(HOST)) {
  console.error("对外监听的 Agent 服务必须配置 AGENT_SERVICE_TOKEN，附件不能匿名公开。"); process.exit(1);
}
// 数据准备在后台启动；连接、范围和口径校验不进入客户首页。
if (database) void database.inspect().then(() => console.log("历史营销资料已完成后台校验"), () => console.error("历史营销资料准备暂未完成，请在后台检查数据源"));
server.listen(PORT, HOST, () => console.log(`Agent 服务已启动：http://${HOST}:${PORT}（模型 ${MODEL}）`));
// 后台预热一次分析会话：读出维度取值并缓存，首个问题不用等这一步；失败不影响启动。
void database?.openAnalysisSession?.().then((session) => session.close(), () => undefined);
// 后台预热全部洞察图谱：查询结果落盘，只有第一次（或数据变了）要查库，之后重启直接读盘，打开洞察即出图。
void insight?.warm().catch(() => console.error("洞察图谱预热失败，打开洞察时会重试"));
