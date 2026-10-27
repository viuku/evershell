# 自建版同步服务。构建：docker build -t evershell-sync services/sync
# 运行和配置见 docs/handbook/sync-service.md。
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production PORT=8790 DB_PATH=/data/sync.db

# 运行时只需要 hono；不跑任何安装脚本
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY schema.sql ./
COPY src ./src

# 官方镜像自带的 node 用户（非 root）；数据卷的目录要先交给它
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8790

# Node 24 直接运行 .ts（自带去类型）；node:sqlite 每次启动都会打印“实验性功能”的提示，关掉
CMD ["node", "--disable-warning=ExperimentalWarning", "src/node.ts"]
