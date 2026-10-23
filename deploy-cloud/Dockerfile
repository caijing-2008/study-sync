# 课本学习交互平台 —— 同步服务器镜像
# 零依赖：仅用 Node 内置模块，无需 npm install。
FROM node:18-alpine

WORKDIR /app

# 复制全部文件（含 study-platform/ 前端、sync-server.js、package.json）
COPY . .

# 云平台通常会注入 PORT 环境变量；本地默认 8137
ENV PORT=8137
EXPOSE 8137

# 启动同步服务器（前端 + /api/sync）
CMD ["node", "sync-server.js"]
