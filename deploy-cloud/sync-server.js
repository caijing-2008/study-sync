#!/usr/bin/env node
/**
 * 课本学习交互平台 —— 零依赖同步服务器
 *
 * 作用：
 *   1) 托管前端静态文件（study-platform/），平板/电脑用浏览器打开同一个网址即可。
 *   2) 提供云同步 API：/api/sync/:token  (GET 下载 / PUT 上传)
 *                          /api/sync/:token/meta (GET 仅取更新时间+大小，用于变更检测)
 *   3) 兼容课表挂件的 /api/daily_quiz (GET/POST)，数据落盘为 study-platform/daily_quiz.json。
 *
 * 设计要点：
 *   - token 就是"账号"，每个 token 一个独立命名空间（sync-data/<token>.json）。
 *   - 冲突检测：上传时带 X-Base-Updated-At，若服务端已存在更新的版本则返回 409，
 *     由前端决定"下载覆盖"还是"强制上传覆盖"（last-write-wins）。
 *   - 绑定 0.0.0.0：同 WiFi 下平板可直接用电脑局域网 IP 访问；要"任何地点访问"可加隧道
 *     （例如：ssh -R 80:localhost:8137 localhost.run）或部署到任意 Node 主机。
 *   - 零第三方依赖，仅用 Node 内置模块。
 *
 * 环境变量：PORT(默认8137) / STATIC_DIR / SYNC_DIR
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = process.env.STATIC_DIR || path.join(__dirname, "study-platform");
const SYNC_DIR = process.env.SYNC_DIR || path.join(__dirname, "sync-data");
const DAILY_FILE = path.join(ROOT, "daily_quiz.json");
const PORT = parseInt(process.env.PORT || "8137", 10);

fs.mkdirSync(ROOT, { recursive: true });
fs.mkdirSync(SYNC_DIR, { recursive: true });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function sendJSON(res, code, obj, extra) {
  const headers = Object.assign(
    { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
    extra || {}
  );
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let data = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (limitBytes && data.length > limitBytes) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => (tooBig ? reject(new Error("payload too large")) : resolve(data)));
    req.on("error", reject);
  });
}

// 令牌白名单：仅允许安全字符，长度 4-64，杜绝目录穿越/注入
function sanitizeToken(t) {
  return typeof t === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(t) ? t : null;
}
function syncFile(token) {
  return path.join(SYNC_DIR, token + ".json");
}
function readSync(token) {
  try {
    const f = syncFile(token);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(url.pathname);

  // CORS 预检
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Base-Updated-At",
    });
    return res.end();
  }

  // ---------- 课表挂件：每日一题 ----------
  if (p === "/api/daily_quiz") {
    if (req.method === "GET") {
      if (fs.existsSync(DAILY_FILE)) {
        try {
          const buf = fs.readFileSync(DAILY_FILE);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
          return res.end(buf);
        } catch (e) {
          sendJSON(res, 500, { error: String(e) });
          return;
        }
      }
      sendJSON(res, 404, { error: "no daily quiz yet" });
      return;
    }
    if (req.method === "POST") {
      try {
        const body = await readBody(req, 2 * 1024 * 1024);
        JSON.parse(body); // 校验
        fs.writeFileSync(DAILY_FILE, body);
        sendJSON(res, 200, { ok: true });
      } catch (e) {
        sendJSON(res, 400, { error: String(e) });
      }
      return;
    }
  }

  // ---------- 云同步 ----------
  const m = p.match(/^\/api\/sync\/([^/]+?)(\/meta)?$/);
  if (m) {
    const token = sanitizeToken(decodeURIComponent(m[1]));
    if (!token) {
      sendJSON(res, 400, { error: "invalid token (4-64 chars, [A-Za-z0-9_-])" });
      return;
    }
    const isMeta = !!m[2];

    if (req.method === "GET") {
      const cur = readSync(token);
      if (!cur) {
        sendJSON(res, 404, { error: "empty" });
        return;
      }
      const raw = fs.readFileSync(syncFile(token), "utf8");
      if (isMeta) {
        sendJSON(res, 200, { updatedAt: cur.updatedAt, size: raw.length });
      } else {
        sendJSON(res, 200, { updatedAt: cur.updatedAt, data: cur.data });
      }
      return;
    }

    if (req.method === "PUT" || req.method === "POST") {
      let body;
      try {
        body = await readBody(req, 200 * 1024 * 1024);
      } catch (e) {
        sendJSON(res, 400, { error: "read failed: " + e.message });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        sendJSON(res, 400, { error: "bad json" });
        return;
      }
      // 冲突检测：客户端声明它基于的版本，若服务端已有更新的则拒绝
      const baseHeader = req.headers["x-base-updated-at"];
      const cur = readSync(token);
      if (baseHeader && baseHeader !== "0" && cur && String(cur.updatedAt) !== String(baseHeader)) {
        sendJSON(res, 409, { error: "conflict", serverUpdatedAt: cur.updatedAt });
        return;
      }
      const updatedAt = Date.now();
      try {
        fs.writeFileSync(syncFile(token), JSON.stringify({ updatedAt, data: parsed }));
      } catch (e) {
        sendJSON(res, 500, { error: "write failed: " + e.message });
        return;
      }
      sendJSON(res, 200, { updatedAt });
      return;
    }
  }

  // ---------- 静态文件 ----------
  if (req.method === "GET" || req.method === "HEAD") {
    let rel = p;
    if (rel === "/" || rel === "") rel = "/index.html";
    const filePath = path.normalize(path.join(ROOT, rel));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      // 非资源路径回退到 index.html（前端路由用）
      if (!path.extname(rel)) {
        const idx = path.join(ROOT, "index.html");
        if (fs.existsSync(idx)) {
          res.writeHead(200, { "Content-Type": MIME[".html"] });
          return req.method === "HEAD" ? res.end() : res.end(fs.readFileSync(idx));
        }
      }
      res.writeHead(404);
      return res.end("not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(405);
  res.end("method not allowed");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[study-platform sync] static=${ROOT}`);
  console.log(`[study-platform sync] sync data=${SYNC_DIR}`);
  console.log(`[study-platform sync] listening on http://0.0.0.0:${PORT}  (本机 http://127.0.0.1:${PORT})`);
});
