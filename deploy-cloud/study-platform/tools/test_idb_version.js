// 验证 IndexedDB store 缺失导致的 NotFoundError 修复。
// 用「版本感知」的 mock indexedDB：transaction() 在 store 不存在时同步抛出 NotFoundError，
// 并真实模拟 onupgradeneeded 仅在「新建/版本升高」时触发 —— 精准复现原 bug 与修复。

const dbs = {}; // name -> { version, stores: { storeName: Map(id->rec) } }
let ASYNC_ERRORS = [];

function makeDB(name) {
  const stores = dbs[name].stores;
  return {
    objectStoreNames: { contains: (s) => !!stores[s] },
    createObjectStore: (s) => { stores[s] = new Map(); return { keyPath: "id" }; },
    transaction: (s) => {
      if (!stores[s]) { const e = new Error("One of the specified object stores was not found"); e.name = "NotFoundError"; throw e; }
      const m = stores[s];
      const tx = {
        objectStore: () => ({
          getAll: () => { const q = {}; setImmediate(() => { q.result = [...m.values()]; q.onsuccess && q.onsuccess(); }); return q; },
          put: (rec) => { m.set(rec.id, rec); const q = {}; setImmediate(() => { q.onsuccess && q.onsuccess(); }); return q; },
          delete: (id) => { m.delete(id); const q = {}; setImmediate(() => { q.onsuccess && q.onsuccess(); }); return q; },
        }),
        oncomplete: null,
      };
      setImmediate(() => { tx.oncomplete && tx.oncomplete(); }); // 模拟事务完成
      return tx;
    },
  };
}
global.indexedDB = {
  open: (name, version) => {
    const req = { onsuccess: null, onupgradeneeded: null, onerror: null };
    setImmediate(() => {
      const existing = dbs[name];
      let needsUpgrade = false;
      if (!existing) { dbs[name] = { version, stores: {} }; needsUpgrade = true; } // 新建库也要触发 onupgradeneeded（真实浏览器行为）
      else if (existing.version < version) { existing.version = version; needsUpgrade = true; }
      else if (existing.version > version) { const e = new Error("VersionError"); e.name = "VersionError"; req.onerror && req.onerror({ error: e }); return; }
      req.result = makeDB(name); // 真实浏览器把 result 挂到 request 上，代码里读 r.result
      try {
        if (needsUpgrade) req.onupgradeneeded && req.onupgradeneeded({ result: req.result });
        req.onsuccess && req.onsuccess({ result: req.result });
      } catch (err) { ASYNC_ERRORS.push(err); } // 复现「同步抛出 → 变 window.onerror」的行为
    });
    return req;
  },
};
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 旧（buggy）实现：idbGetAll 无 onupgradeneeded，idbPutAll 与 idbGetAll 同为 v1 =====
async function buggyGetAll(dbName, store) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(dbName, 1);
    r.onsuccess = () => { const db = r.result;
      if (!db.objectStoreNames.contains(store)) { resolve([]); return; }
      const tx = db.transaction(store, "readonly"); const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []); req.onerror = () => reject(req.error); };
    r.onerror = () => reject(r.error);
  });
}
async function buggyPutAll(dbName, store, records) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(dbName, 1);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: "id" }); };
    r.onsuccess = () => { const db = r.result;
      const tx = db.transaction(store, "readwrite"); const os = tx.objectStore(store); // ← 原报错点
      (records || []).forEach((rec) => os.put(rec)); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); };
    r.onerror = () => reject(r.error);
  });
}

// ===== 新（fixed）实现：统一 IDB_VER=2，idbGetAll 也建 store =====
const IDB_VER = 2;
function ensureStoreInUpgrade(db, store) { if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: "id" }); }
async function fixedGetAll(dbName, store) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(dbName, IDB_VER);
    r.onupgradeneeded = () => ensureStoreInUpgrade(r.result, store);
    r.onsuccess = () => { const db = r.result;
      if (!db.objectStoreNames.contains(store)) { resolve([]); return; }
      const tx = db.transaction(store, "readonly"); const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []); req.onerror = () => reject(req.error); };
    r.onerror = () => reject(r.error);
  });
}
async function fixedPutAll(dbName, store, records) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(dbName, IDB_VER);
    r.onupgradeneeded = () => ensureStoreInUpgrade(r.result, store);
    r.onsuccess = () => { const db = r.result;
      if (!db.objectStoreNames.contains(store)) { resolve(); return; }
      const tx = db.transaction(store, "readwrite"); const os = tx.objectStore(store);
      (records || []).forEach((rec) => os.put(rec)); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); };
    r.onerror = () => reject(r.error);
  });
}

(async () => {
  const fs = require("fs");
  const LOG = (m) => fs.appendFileSync("C:/Users/22690/dbg.txt", m + "\n");
  LOG("START");
  const ATT = "study_platform_attachments";

  // ---- 场景 A：旧代码，全新浏览器 → 复现 NotFoundError ----
  // 注意：旧代码在 onsuccess 里抛错会被浏览器变成 window.onerror，Promise 永不 settle，故这里不 await。
  dbs[ATT] = undefined; delete dbs[ATT]; ASYNC_ERRORS = [];
  LOG("A1 before buggyGetAll");
  await buggyGetAll(ATT, "attachments");
  LOG("A2 after buggyGetAll");
  await sleep(20);
  buggyPutAll(ATT, "attachments", [{ id: "x", data: "BIG" }]);
  await sleep(40);
  const bugReproduced = ASYNC_ERRORS.some((e) => e.name === "NotFoundError");
  LOG("A) 旧代码全新库 → 复现 NotFoundError: " + (bugReproduced ? "YES" : "NO"));

  // ---- 场景 B：新代码，全新浏览器 → 成功 ----
  dbs[ATT] = undefined; delete dbs[ATT]; ASYNC_ERRORS = [];
  await fixedGetAll(ATT, "attachments"); await sleep(20);
  await fixedPutAll(ATT, "attachments", [{ id: "x", data: "BIG" }]); await sleep(20);
  LOG("B-debug stores=" + JSON.stringify(Object.keys(dbs[ATT].stores)) + " hasX=" + (dbs[ATT].stores.attachments && dbs[ATT].stores.attachments.has("x")) + " errors=" + ASYNC_ERRORS.map(e=>e.name).join(","));
  const bOK = !ASYNC_ERRORS.some((e) => e.name === "NotFoundError") && dbs[ATT] && dbs[ATT].stores.attachments && dbs[ATT].stores.attachments.has("x");
  LOG("B) 新代码全新库 → 写入成功: " + (bOK ? "YES" : "NO") + " | DB版本: " + (dbs[ATT] && dbs[ATT].version));

  // ---- 场景 C：用户已坏状态（v44 误建了 v1 无 store 的库）→ 新代码升级修复 ----
  dbs[ATT] = { version: 1, stores: {} }; ASYNC_ERRORS = []; // 模拟用户当前坏库
  await fixedGetAll(ATT, "attachments"); await sleep(20); // 应以 v2 打开 → 触发升级建 store
  const upgraded = dbs[ATT].version === 2 && dbs[ATT].stores.attachments;
  await fixedPutAll(ATT, "attachments", [{ id: "y", data: "BIG2" }]); await sleep(20);
  const cOK = upgraded && dbs[ATT].stores.attachments.has("y") && !ASYNC_ERRORS.some((e) => e.name === "NotFoundError");
  LOG("C) 用户已坏 v1 库 → 新代码升级到 v2 并写入: " + (cOK ? "YES" : "NO") + " | DB版本: " + dbs[ATT].version);

  // ---- 场景 D：books/exams 从 v1 升级到 v2 不丢数据 ----
  dbs["study_platform_books"] = { version: 1, stores: { books: new Map([["b1", { id: "b1", pdf: "X" }]]) } };
  ASYNC_ERRORS = [];
  await fixedGetAll("study_platform_books", "books"); await sleep(20);
  const dOK = dbs["study_platform_books"].version === 2 && dbs["study_platform_books"].stores.books.has("b1");
  LOG("D) books 库 v1→v2 升级保留数据: " + (dOK ? "YES" : "NO"));

  const allPass = bugReproduced && bOK && cOK && dOK;
  LOG(allPass ? "ALL PASS" : "SOME FAIL");
  setTimeout(() => process.exit(allPass ? 0 : 1), 60);
})();
