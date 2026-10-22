import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

// 容器里自带的只读历史库（butler 单容器）：mysqld 只听回环地址，数据目录在持久卷上。
// 第一次启动从私有数据仓库拉 SQL 导出、校验、导入；之后重启直接用已导入的库。
// 没配 CTF_DATA_REPO_TOKEN 时什么都不做，洞察和问答按「没连数据库」运行。
const DATA_DIR = process.env.CTF_MYSQL_DATA_DIR || "/data/mysql";
const SOCKET = "/run/mysqld/mysqld.sock";
const PORT = "3306";
const DATABASE = process.env.CTF_MYSQL_DATABASE || "ctf_sales_202508";
const READY_MARK = path.join(DATA_DIR, ".ctf-imported");
const DUMP = "ctf_sales_202508.sql.gz";

const log = (text) => console.log(`[mysql] ${text}`);
const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"], ...options });
  if (result.status !== 0) throw new Error(`${cmd} ${args[0] ?? ""} 失败（退出码 ${result.status}）`);
  return result;
};
const sha256 = async (file) => { const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex"); };

async function waitReady(child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`mysqld 启动失败（退出码 ${child.exitCode}）`);
    if (spawnSync("mysqladmin", ["--socket", SOCKET, "-uroot", "ping"], { stdio: "ignore" }).status === 0) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("mysqld 两分钟内没有就绪");
}

// 拉数据仓库：只取最新一次提交；口令通过请求头传，不写进 URL、不落盘。
function fetchDump(work) {
  const repo = process.env.CTF_DATA_REPO || "https://gitlab.agents.juzibot.com/hackathon/ctf-campaign-data.git";
  const user = process.env.CTF_DATA_REPO_USER || "gitlab+deploy-token-4";
  const auth = Buffer.from(`${user}:${process.env.CTF_DATA_REPO_TOKEN}`).toString("base64");
  rmSync(work, { recursive: true, force: true });
  log("从数据仓库拉 SQL 导出");
  run("git", ["-c", `http.extraHeader=Authorization: Basic ${auth}`, "clone", "--depth", "1", "--quiet", repo, work]);
}

async function importDump(work) {
  const parts = readdirSync(work).filter((f) => f.startsWith(`${DUMP}.part`)).sort();
  if (!parts.length) throw new Error("数据仓库里没有 SQL 导出分片");
  const joined = path.join(work, DUMP);
  const out = createWriteStream(joined);
  for (const part of parts) await pipeline(createReadStream(path.join(work, part)), out, { end: false });
  out.end(); await new Promise((r) => out.on("finish", r));
  const expected = readFileSync(path.join(work, "SHA256SUMS"), "utf8").split(/\s+/)[0];
  if ((await sha256(joined)) !== expected) throw new Error("SQL 导出校验不一致");
  log(`导入 ${parts.length} 个分片（约 2–5 分钟）`);
  const client = spawn("mysql", ["--socket", SOCKET, "-uroot", "--default-character-set=utf8mb4"], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((resolve, reject) => client.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`导入失败（退出码 ${code}）`))));
  await pipeline(createReadStream(joined), createGunzip(), client.stdin);
  await done;
}

// 只读账号：应用只发 SELECT，用它连库。
function createReader(password) {
  const sql = `CREATE USER IF NOT EXISTS 'ctf_reader'@'127.0.0.1' IDENTIFIED BY '${password}';
ALTER USER 'ctf_reader'@'127.0.0.1' IDENTIFIED BY '${password}';
GRANT SELECT, SHOW VIEW ON \`${DATABASE}\`.* TO 'ctf_reader'@'127.0.0.1';
FLUSH PRIVILEGES;`;
  run("mysql", ["--socket", SOCKET, "-uroot", "-e", sql]);
}

// 返回 mysqld 子进程和应用该用的连接环境变量；没配数据仓库口令时返回 null。
export async function startContainerMysql() {
  if (!process.env.CTF_DATA_REPO_TOKEN) { log("没配 CTF_DATA_REPO_TOKEN，不启动内置数据库"); return null; }
  mkdirSync(DATA_DIR, { recursive: true }); mkdirSync(path.dirname(SOCKET), { recursive: true });
  const fresh = !existsSync(path.join(DATA_DIR, "mysql"));
  if (fresh) { log("初始化数据目录"); run("mysqld", ["--initialize-insecure", "--user=root", `--datadir=${DATA_DIR}`, "--secure-file-priv=NULL"]); }
  // 内存给得保守：容器里还跑着页面和 Agent。
  const mysqld = spawn("mysqld", ["--user=root", `--datadir=${DATA_DIR}`, `--socket=${SOCKET}`, "--bind-address=127.0.0.1", `--port=${PORT}`,
    "--innodb-buffer-pool-size=768M", "--tmp-table-size=128M", "--max-heap-table-size=128M", "--skip-log-bin", "--mysqlx=OFF",
    "--character-set-server=utf8mb4", "--collation-server=utf8mb4_0900_ai_ci", "--secure-file-priv=NULL"], { stdio: ["ignore", "inherit", "inherit"] });
  await waitReady(mysqld);
  if (!existsSync(READY_MARK)) {
    const work = path.join(DATA_DIR, "..", "ctf-data-download");
    fetchDump(work);
    await importDump(work);
    rmSync(work, { recursive: true, force: true });
    writeFileSync(READY_MARK, new Date().toISOString());
    log("导入完成");
  }
  const password = process.env.CTF_MYSQL_READER_PASSWORD || createHash("sha256").update(`${process.env.CTF_DATA_REPO_TOKEN}:reader`).digest("hex").slice(0, 32);
  createReader(password);
  return { mysqld, env: { CTF_MYSQL_HOST: "127.0.0.1", CTF_MYSQL_PORT: PORT, CTF_MYSQL_USER: "ctf_reader", CTF_MYSQL_PASSWORD: password, CTF_MYSQL_DATABASE: DATABASE } };
}
