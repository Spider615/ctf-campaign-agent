# butler 部署：单容器跑两个进程，入口见 scripts/start-container.mjs。
# 页面是 vinext 构建的 Workers 应用，用 wrangler 本地模式（workerd + 本地 D1）运行；
# Agent 服务跑 Claude Agent SDK。workerd 和 SDK 自带的可执行文件都依赖 glibc，不能换 alpine。
FROM node:22-bookworm-slim

WORKDIR /app

# 先装依赖再拷源码，只改代码时不用重装。根目录和 agent/ 是两套独立依赖；
# wrangler 在 devDependencies 里，但运行时要用，所以不裁剪开发依赖。
COPY package.json package-lock.json .npmrc ./
COPY scripts ./scripts
RUN npm run install:ci && npm cache clean --force
COPY agent/package.json agent/package-lock.json ./agent/
RUN npm ci --prefix agent --no-audit --no-fund && npm cache clean --force

COPY . .
RUN npm run build

ENV PORT=8787
EXPOSE 8787
CMD ["node", "scripts/start-container.mjs"]
