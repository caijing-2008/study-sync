# 部署到网上（技术速查）

本目录是一个**零依赖 Node 服务**：`sync-server.js` 同时托管前端网页和 `/api/sync` 同步 API。
把它跑在任意一台"有公网 IP 的电脑"（云主机）上，平板和电脑就能用同一个网址同步。

## 本地先验证（在你自己电脑上）
```bat
cd /d D:\数分学习平台
node sync-server.js
:: 浏览器打开 http://127.0.0.1:8137 应看到平台首页
```

## 一键部署到云平台（以 Render / Railway 为例，二者都支持从 GitHub 仓库部署）
1. 把这些文件（sync-server.js、package.json、Dockerfile、study-platform/）上传到一个 GitHub 仓库。
   - 最简单：GitHub 网页上 New repository → 直接把文件夹拖进去上传。
2. 打开 https://render.com （或 https://railway.app），用 GitHub 登录。
3. New → Web Service → 选中你的仓库 → 部署。
   - Render：不需要写启动命令，它会用 `npm start`（来自 package.json）。
   - 端口：平台会自动注入 `PORT` 环境变量，服务器已支持。
4. 部署完会给你一个形如 `https://xxx.onrender.com` 的网址。
5. 平板 / 电脑浏览器打开该网址 → 数据弹窗「同步服务器地址」留空（默认同源）即可。

## 环境变量（云平台一般在设置里可改，默认值已可用）
- `PORT`：监听端口（默认 8137，云平台自动覆盖）
- `STATIC_DIR`：前端目录（默认 `./study-platform`）
- `SYNC_DIR`：同步数据存放目录（默认 `./sync-data`，每个 token 一个 json）

## Docker 方式（任意支持容器的云）
```bat
docker build -t study-sync .
docker run -p 8137:8137 study-sync
```

## 说明
- 云端是一份"独立副本"，和你在电脑上本地跑的互不影响。
- 想让电脑和云端互通：在电脑端「同步服务器地址」填云端网址即可。
- 免费云的磁盘在"重新部署"时可能清空；同步数据以你各端浏览器本地为准，云端只是中转站，清空不影响本地数据。
