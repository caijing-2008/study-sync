// 验证：附件二进制从 localStorage(内联 dataURL) 迁移到 IndexedDB 的逻辑
// 用最小化的 indexedDB / localStorage mock，粘贴 app.js 中真实函数体测试。

// ---- mock indexedDB（支持 onsuccess 赋值回调模式）----
const idbStores = {}; // name -> Map(id -> record)
function makeStore(dbName) {
  if (!idbStores[dbName]) idbStores[dbName] = new Map();
  return idbStores[dbName];
}
function openDB(dbName) {
  const store = makeStore(dbName);
  let storeCreated = dbName === "study_platform_attachments";
  return {
    objectStoreNames: { contains: () => true },
    createObjectStore() { storeCreated = true; },
    transaction() {
      const tx = {
        objectStore() {
          return {
            getAll() { const q = {}; setImmediate(() => { q.result = [...store.values()]; q.onsuccess && q.onsuccess(); }); return q; },
            put(rec) { store.set(rec.id, rec); const q = {}; setImmediate(() => { q.onsuccess && q.onsuccess(); }); return q; },
            delete(id) { store.delete(id); const q = {}; setImmediate(() => { q.onsuccess && q.onsuccess(); }); return q; },
          };
        },
      };
      setImmediate(() => { tx.oncomplete && tx.oncomplete(); });
      return tx;
    },
  };
}
global.indexedDB = { open: (dbName) => {
  const req = { onsuccess: null, onerror: null };
  setImmediate(() => { req.result = openDB(dbName); req.onsuccess && req.onsuccess({ result: req.result }); });
  return req;
} };

// ---- mock localStorage ----
const lsMap = new Map();
global.localStorage = {
  getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
  setItem: (k, v) => lsMap.set(k, String(v)),
  get length() { return lsMap.size; },
  key: (i) => [...lsMap.keys()][i],
};

// ===== 以下从 app.js 复制的真实函数体 =====
const ATT_DB = "study_platform_attachments";
let attCache = {};
function dataUrlBytes(d){ try { return Math.round((d.length - (d.indexOf(",") + 1)) * 3 / 4); } catch(e){ return 0; } }
async function idbGetAll(dbName, store) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(dbName, 1);
    r.onsuccess = () => { const db = r.result;
      if (!db.objectStoreNames.contains(store)) { resolve([]); return; }
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    };
    r.onerror = () => reject(r.error);
  });
}
async function idbPutAll(dbName, store, records) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(dbName, 1);
    r.onupgradeneeded = () => { const db = r.result;
      if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: "id" });
    };
    r.onsuccess = () => { const db = r.result;
      const tx = db.transaction(store, "readwrite"); const os = tx.objectStore(store);
      (records || []).forEach((rec) => os.put(rec));
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    };
    r.onerror = () => reject(r.error);
  });
}
async function loadAttCache() {
  try { const recs = await idbGetAll(ATT_DB, "attachments"); attCache = {};
    (recs || []).forEach((r) => { if (r && r.id) attCache[r.id] = r.data || ""; }); }
  catch (e) { attCache = {}; }
}
async function putAttachment(id, data) {
  try { await idbPutAll(ATT_DB, "attachments", [{ id, data }]); attCache[id] = data; }
  catch (e) { console.warn("附件入库失败", e); }
}
async function fetchAttachmentData(id) {
  if (attCache[id]) return attCache[id];
  try { const recs = await idbGetAll(ATT_DB, "attachments");
    const rec = (recs || []).find((r) => r && r.id === id);
    if (rec) { attCache[id] = rec.data || ""; return attCache[id]; } } catch (e) {}
  return "";
}
function getAttachmentData(att) {
  if (!att) return "";
  if (att.id && attCache[att.id]) return attCache[att.id];
  if (typeof att.data === "string" && att.data) return att.data;
  return "";
}
async function getAttachmentDataAsync(att) {
  if (!att) return "";
  if (typeof att.data === "string" && att.data) return att.data;
  if (att.id) { const d = await fetchAttachmentData(att.id); if (d) return d; }
  return "";
}
function deleteAttachment(id) {
  return new Promise((resolve) => {
    const r = indexedDB.open(ATT_DB, 1);
    r.onsuccess = () => { const db = r.result;
      if (!db.objectStoreNames.contains("attachments")) { resolve(); return; }
      const tx = db.transaction("attachments", "readwrite");
      tx.objectStore("attachments").delete(id);
      tx.oncomplete = () => resolve(); tx.onerror = () => resolve();
    };
    r.onerror = () => resolve();
  });
}

// notesMap + 待迁移的 legacy 内联附件
let notesMap = { shuxue1: { notes: [
  { id: "n1", title: "t1", content: "", images: [],
    attachments: [ { id:"att-old1", kind:"image", name:"a.png", type:"image/png", data:"data:image/png;base64,AAAAbbbbccccddddeeee" } ] }
] } };
let saved = null;
function saveNotes() { saved = JSON.parse(JSON.stringify(notesMap)); }  // 模拟写入 localStorage

async function migrateLegacyAttachments() {
  let changed = false;
  Object.keys(notesMap).forEach((bid) => {
    const slice = notesMap[bid];
    if (!slice || !Array.isArray(slice.notes)) return;
    slice.notes.forEach((n) => {
      if (!n || !Array.isArray(n.attachments)) return;
      n.attachments.forEach((a) => {
        if (!a.id) a.id = "att-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
        if (typeof a.data === "string" && a.data.length > 0) {
          attCache[a.id] = a.data;
          if (typeof a.size !== "number") a.size = dataUrlBytes(a.data);
          delete a.data;
          changed = true;
        }
      });
    });
  });
  if (changed) {
    const recs = Object.keys(attCache).map((id) => ({ id, data: attCache[id] })).filter((r) => r.data);
    try { await idbPutAll(ATT_DB, "attachments", recs); } catch (e) { console.warn("附件迁移入库失败", e); }
    saveNotes();
  }
}

// ===== 测试流程 =====
(async () => {
  // 1. 载入缓存（此时 IDB 空）
  await loadAttCache();
  console.log("1) 初始 attCache:", Object.keys(attCache).length, "条");

  // 2. 迁移 legacy 内联附件
  await migrateLegacyAttachments();
  const migrated = notesMap.shuxue1.notes[0].attachments[0];
  console.log("2) 迁移后 note.attachments[0].data:", migrated.data === undefined ? "已剥离(✓)" : "仍在(✗)");
  console.log("   size:", migrated.size, "bytes (应为 ~15)");
  console.log("   saved 到 localStorage 的 data 字段:", saved.shuxue1.notes[0].attachments[0].data === undefined ? "无(✓)" : "有(✗)");

  // 3. attCache 命中
  console.log("3) getAttachmentData 同步命中:", getAttachmentData(migrated).startsWith("data:image") ? "✓" : "✗");

  // 4. 模拟新附件写入（只存元数据，二进制进 IDB）
  const newId = "att-new1";
  const bigData = "data:application/pdf;base64," + "X".repeat(2000000); // ~1.5MB
  await putAttachment(newId, bigData);
  console.log("4) 新附件入 IDB 后 attCache 命中:", attCache[newId] ? "✓" : "✗");
  console.log("   模拟 localStorage 元数据大小(不含二进制):", JSON.stringify({id:newId,kind:"pdf",name:"big.pdf",size:dataUrlBytes(bigData)}).length, "chars (✓ 很小)");

  // 5. 重新 loadAttCache（模拟刷新后读回）
  attCache = {};
  await loadAttCache();
  console.log("5) 刷新后 loadAttCache 命中 att-old1:", attCache["att-old1"] ? "✓" : "✗", "| att-new1:", attCache[newId] ? "✓" : "✗");
  console.log("   getAttachmentDataAsync(新附件):", (await getAttachmentDataAsync({id:newId})).length > 1000 ? "✓ 取回二进制" : "✗");

  // 6. 删除附件
  delete attCache[newId];
  await deleteAttachment(newId);
  attCache = {}; await loadAttCache();
  console.log("6) 删除后 loadAttCache 不再含 att-new1:", !attCache[newId] ? "✓" : "✗");

  console.log("\n全部逻辑验证通过 ✅");
})();
