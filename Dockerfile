# butler 部署：单容器跑两个进程，入口见 scripts/start-container.mjs。
# 页面是 vinext 构建的 Workers 应用，用 wrangler 本地模式（workerd + 本地 D1）运行；
# Agent 服务跑 Claude Agent SDK。workerd 和 SDK 自带的可执行文件都依赖 glibc，不能换 alpine。
# 内置的只读历史库：从官方 MySQL 镜像（同为 Debian bookworm）拷可执行文件和私有库，不走 apt 源。
FROM mysql:8.0.46-debian AS mysql

FROM node:22-bookworm-slim

WORKDIR /app

# 文档转换与中文识别随镜像交付；解析进程使用内核文件隔离和禁网规则。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    python3 python3-venv libarchive13 libreoffice-writer libreoffice-calc libreoffice-impress \
    poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
COPY agent/attachments/requirements.txt /tmp/attachment-requirements.txt
RUN python3 -m venv /opt/attachment-python \
    && /opt/attachment-python/bin/pip install --no-cache-dir -r /tmp/attachment-requirements.txt \
    && rm /tmp/attachment-requirements.txt
COPY agent/attachments/office-socket.c /tmp/attachment-office-socket.c
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends gcc libc6-dev \
    && cc -shared -fPIC -O2 /tmp/attachment-office-socket.c \
       -o /opt/attachment-python/lib/python3.11/site-packages/attachment_office_socket.so -ldl \
    && apt-get purge -y --auto-remove gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/* /tmp/attachment-office-socket.c
COPY --from=mysql /usr/sbin/mysqld /usr/sbin/mysqld
COPY --from=mysql /usr/bin/mysql /usr/bin/mysqladmin /usr/bin/
COPY --from=mysql /usr/lib/mysql /usr/lib/mysql
COPY --from=mysql /usr/share/mysql-8.0 /usr/share/mysql-8.0
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends libaio1 libnuma1 git \
    && rm -rf /var/lib/apt/lists/* \
    && mysqld --version
ENV ATTACHMENTS_PYTHON=/opt/attachment-python/bin/python3
ENV ATTACHMENTS_DIR=/data/attachments
ENV USAGE_DB_PATH=/data/usage/usage.sqlite

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
