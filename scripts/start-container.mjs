import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectRoot } from "./sites-env.mjs";

// 容器入口（butler 单容器多进程）：页面用 wrangler 本地模式对外监听 0.0.0.0；
// Agent 服务只听容器内回环地址，页面按 runtime.ts 的默认地址 http://127.0.0.1:8788 连它，
// 所以容器里不需要 AGENT_SERVICE_URL / AGENT_SERVICE_TOKEN。
const PORT = process.env.PORT || "8787";
// 本地 D1 的数据目录，要挂持久卷，否则重新部署后会话全部丢失。
const PERSIST_DIR = process.env.D1_PERSIST_DIR || "/data/d1";
const WRANGLER = path.join(projectRoot, "node_modules/wrangler/bin/wrangler.js");
const SERVER_DIR = path.join(projectRoot, "dist/server");

mkdirSync(PERSIST_DIR, { recursive: true });

// 迁移沿用构建产物的 wrangler 配置，只补上 migrations_dir，保证和页面读写的是同一个本地 D1；已应用的迁移会跳过。
const config = JSON.parse(readFileSync(path.join(SERVER_DIR, "wrangler.json"), "utf8"));
config.d1_databases = config.d1_databases.map((db) => ({ ...db, migrations_dir: "../../drizzle" }));
const migrateConfig = path.join(SERVER_DIR, "wrangler.migrate.json");
writeFileSync(migrateConfig, JSON.stringify(config));
for (const { binding } of config.d1_databases) {
  const migrated = spawnSync(process.execPath, [
    WRANGLER, "d1", "migrations", "apply", binding, "--local",
    "--config", migrateConfig, "--persist-to", PERSIST_DIR,
  ], { stdio: "inherit" });
  if (migrated.status !== 0) process.exit(migrated.status ?? 1);
}

const children = [
  // 地址和端口固定成页面的默认值；口令清空，回环地址外面连不到，留着反而会和页面对不上。
  spawn(process.execPath, [
    "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "agent/server.ts",
  ], {
    stdio: "inherit",
    env: { ...process.env, AGENT_HOST: "127.0.0.1", AGENT_PORT: "8788", AGENT_SERVICE_TOKEN: "" },
  }),
  spawn(process.execPath, [
    WRANGLER, "dev", "--config", "dist/server/wrangler.json", "--local",
    "--persist-to", PERSIST_DIR, "--ip", "0.0.0.0", "--port", PORT,
  ], { stdio: "inherit" }),
];

// 任意一个进程退出就停掉另一个并以非零码退出，交给平台重启整个容器。
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  process.exitCode = code;
}

for (const child of children) child.on("exit", (code) => stop(code || 1));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
