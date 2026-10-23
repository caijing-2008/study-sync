/* 课本学习交互平台 —— 前端逻辑（纯静态，无后端） */
(function () {
  "use strict";

  // 必须放在最顶部：normalizeChatSessions 在读取聊天历史时（约第 34 行）就会被调用，
  // 早于下面「多书」段落的声明，const 在 TDZ 内会抛 ReferenceError 导致整页卡死。
  const LEGACY_BOOK_ID = "shuxue1";

  // IndexedDB 统一版本号（含 books/exams/attachments 三个库）。升到 2 是为了让
  // "v44 首次加载时误建了无 store 的 v1 数据库"的那批用户，在下次打开时触发
  // onupgradeneeded 自动补建 store（停在同一版本不会触发升级 → store 永远缺失 → NotFoundError）。
  const IDB_VER = 2;

  // pdf.js 改为按需懒加载：首屏不再硬塞 320KB 主库 + 1MB worker，等用户首次载入 PDF 时才拉取
  let pdfjsLib = null;
  let pdfJsLoading = null;
  function ensurePdfJs() {
    if (pdfjsLib) return Promise.resolve();
    if (pdfJsLoading) return pdfJsLoading;
    pdfJsLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "vendor/pdfjs/pdf.min.js";
      s.onload = () => {
        pdfjsLib = window.pdfjsLib || null;
        if (pdfjsLib) {
          try { pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js"; } catch (e) {}
          resolve();
        } else { reject(new Error("pdf.js 加载完成但未找到全局对象")); }
      };
      s.onerror = () => reject(new Error("pdf.js 脚本加载失败"));
      document.head.appendChild(s);
    });
    return pdfJsLoading;
  }

  const PROGRESS_KEY = "study_progress_v1";
  const STREAK_KEY = "study_streak_v1";
  const CHAT_HISTORY_KEY = "chat_history_v1";
  const WEEKLY_REPORT_KEY = "weekly_report_v1";

  let problems = [];
  let meta = {};
  let exams = [];
  let bookIndex = null;
  let pdfDoc = null;
  let currentRender = null;
  let curPage = 1;
  let curFilter = "all";
  let progress = loadJSON(PROGRESS_KEY, {});
  let streak = loadJSON(STREAK_KEY, { last: null, count: 0 });
  let userProblems = loadJSON("user_problems_v1", []);
  let userExamsMap = {};   // { [bookId]: [exam, ...] }，按书本命名空间隔离（与 notes/tree/redo 一致）
  function userExamsForBook() { if (!userExamsMap[activeBookId]) userExamsMap[activeBookId] = []; return userExamsMap[activeBookId]; }
  function loadUserExams() {
    try { userExamsMap = JSON.parse(localStorage.getItem("user_exams_v1")); } catch (e) { userExamsMap = {}; }
    if (!userExamsMap || typeof userExamsMap !== "object" || Array.isArray(userExamsMap)) {
      // 旧版扁平数组 → 整体迁入默认书（shuxue1），避免丢失
      const legacy = Array.isArray(userExamsMap) ? userExamsMap : [];
      userExamsMap = {}; userExamsMap[LEGACY_BOOK_ID] = legacy;
    }
  }
  function saveUserExams() {
    try { localStorage.setItem("user_exams_v1", JSON.stringify(userExamsMap)); }
    catch (e) { alert("考卷保存失败，可能是浏览器存储已满。"); }
    markSyncDirty();
  }
  loadUserExams();
  let chatConfig = loadJSON("chat_config_v1", { base: "https://api.deepseek.com/v1", key: "", model: "deepseek-chat", visionBase: "", visionKey: "", visionModel: "" });
  // 对话角色：讲师/教练/考官/分析师；旧版引导模式迁移为教练/讲师
  const ROLE_KEY = "chat_role_v1";
  let chatRole = localStorage.getItem(ROLE_KEY) || (localStorage.getItem("socratic_mode_v1") === "0" ? "lecturer" : "coach");
  const ROLE_NAMES = { lecturer: "📖 讲解员", coach: "🎯 教练", examiner: "📝 考官", analyst: "🔍 分析师" };
  const ROLE_HINTS = {
    lecturer: "直接讲定理、公式与推导，像教辅答案册。",
    coach: "苏格拉底式引导，一步步追问，不直接给答案；卡住可说「给我答案」。",
    examiner: "针对当前知识点出题、给变式，检验你是否真会。",
    analyst: "复盘错题与薄弱点，帮你找知识漏洞并补全。"
  };
  // 研讨模式：4 智能体联动（关闭时回到单人角色答疑）
  let discussionMode = localStorage.getItem("discussion_mode_v1") === "on";
  let discIntensity = localStorage.getItem("disc_intensity_v1") || "light";
  // 错题归因表：id -> { type, chapterId, sectionId, pointId, theorem, chapter, note }
  let attrMap = loadJSON("user_attr_v1", {});
  // 三级教材树（按书命名空间）：{ [bookId]: { chapters:[{id,title,sections:[{id,title,points:[{id,title,desc}]}]}] } }
  let studyTree = loadJSON("study_tree_v1", {});
  // 重做回路队列：{ [bookId]: { [problemId]: { pointKey, due, status, attempts, pass, fail, last } } }
  let redoMap = loadJSON("study_redo_v1", {});
  // 错误类型（归因第 1 层）
  const ERR_TYPES = [
    { key: "concept", label: "概念不清", emoji: "🧠" },
    { key: "calc", label: "计算失误", emoji: "🔢" },
    { key: "method", label: "方法不当", emoji: "🛠" },
    { key: "misread", label: "审题偏差", emoji: "👀" },
    { key: "stuck", label: "思路卡壳", emoji: "🌫" }
  ];
  function bookTree() { if (!studyTree[activeBookId]) studyTree[activeBookId] = { chapters: [] }; return studyTree[activeBookId]; }
  function saveTree() { try { localStorage.setItem("study_tree_v1", JSON.stringify(studyTree)); } catch (e) {} markSyncDirty(); }
  function bookRedo() { if (!redoMap[activeBookId]) redoMap[activeBookId] = {}; return redoMap[activeBookId]; }
  function saveRedo() { try { localStorage.setItem("study_redo_v1", JSON.stringify(redoMap)); } catch (e) {} markSyncDirty(); }
  function uid(p) { return p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }
  function treePointKeys() {
    const s = new Set();
    bookTree().chapters.forEach((c) => c.sections.forEach((se) => se.points.forEach((pt) => s.add(c.id + ":" + se.id + ":" + pt.id))));
    return s;
  }
  function findPoint(chapterId, sectionId, pointId) {
    const c = bookTree().chapters.find((x) => x.id === chapterId); if (!c) return null;
    const se = c.sections.find((x) => x.id === sectionId); if (!se) return null;
    return se.points.find((x) => x.id === pointId) || null;
  }
  function pointLabel(chapterId, sectionId, pointId) {
    const pt = findPoint(chapterId, sectionId, pointId); if (!pt) return "";
    const c = bookTree().chapters.find((x) => x.id === chapterId);
    const se = c && c.sections.find((x) => x.id === sectionId);
    return (c ? c.title : "") + " / " + (se ? se.title : "") + " / " + pt.title;
  }
  // 各知识点聚合：错题数 / 归因数 / 重做通过 / 重做失败
  function pointAgg() {
    const agg = {};
    const inc = (k, f) => { if (!agg[k]) agg[k] = { wrong: 0, attrs: 0, pass: 0, fail: 0 }; agg[k][f]++; };
    const valid = treePointKeys();
    allProblems().forEach((p) => {
      if (statusOf(p) !== "wrong") return;
      const a = getAttr(p.id);
      if (a && a.pointId && a.chapterId && a.sectionId) {
        const k = a.chapterId + ":" + a.sectionId + ":" + a.pointId;
        if (valid.has(k)) { inc(k, "wrong"); inc(k, "attrs"); }
      }
    });
    const rm = bookRedo();
    Object.keys(rm).forEach((pid) => {
      const r = rm[pid];
      if (r && r.pointKey && valid.has(r.pointKey)) {
        if (!agg[r.pointKey]) agg[r.pointKey] = { wrong: 0, attrs: 0, pass: 0, fail: 0 };
        agg[r.pointKey].pass += (r.pass || 0); agg[r.pointKey].fail += (r.fail || 0);
      }
    });
    return agg;
  }
  // 掌握度：错题/失败拉低，重做通过拉高（0-100）
  function masteryOf(stat) {
    const wrong = (stat && stat.wrong) || 0, fail = (stat && stat.fail) || 0, pass = (stat && stat.pass) || 0;
    const weakness = wrong * 12 + fail * 18 - pass * 10;
    return Math.max(0, Math.min(100, Math.round(100 - weakness)));
  }
  function masteryColor(m) { return m >= 70 ? "var(--green)" : (m >= 40 ? "var(--amber)" : "var(--red)"); }
  function masteryText(m) { return m >= 70 ? "掌握" : (m >= 40 ? "薄弱" : "危急"); }
  // 答疑会话：按"每题一个会话"持久化到本地，用于错题归因留痕
  // 结构：[{ id, title, topic:{page,number,question}, messages:[{role,content,ts}], updated }]
  let chatSessions = normalizeChatSessions(loadJSON(CHAT_HISTORY_KEY, []));
  let currentSessionId = chatSessions.length ? chatSessions[chatSessions.length - 1].id : null;
  // 待发送的图片（截图）：dataURL 数组，随下一条消息一起发给模型，发送后清空
  let pendingImages = [];

  // 考卷 PDF（原图展示 + 答疑）相关状态
  let pendingExamPdfBuf = null;          // 添加考卷时暂存的 PDF ArrayBuffer
  let pendingExamPdfMeta = null;         // { fileName, pageCount }
  let examPdfDoc = null;                 // 已载入的考卷 PDF（独立 pdf.js 文档，不覆盖课本 pdfDoc）
  let examPdfLoadedId = null;            // 当前 examPdfDoc 对应的考卷 id
  let examCurPage = 1;                   // 考卷详情页当前浏览页
  let examCurrentRender = null;          // 考卷页渲染任务（用于取消）
  let examQaExamId = null;               // 当前正处于「针对考卷答疑」的考卷 id
  let examQaTitle = null;                // 对应标题

  const $ = (id) => document.getElementById(id);

  function showInitError(label, err) {
    try {
      const el = $("globalError");
      if (!el) return;
      el.classList.remove("hidden");
      const msg = err && (err.stack || err.message || String(err)) || String(err);
      el.textContent += "[" + label + "] " + msg + "\n";
    } catch (e) {}
  }
  window.onerror = (msg, url, line, col, err) => { showInitError("window.onerror " + line + ":" + col, err || msg); };
  window.addEventListener("unhandledrejection", (e) => { showInitError("unhandledrejection", e.reason); });
  function on(id, type, fn) {
    try { const el = $(id); if (el) el.addEventListener(type, fn); else showInitError("missing-id", "#" + id + " not found for " + type); }
    catch (e) { showInitError("on(" + id + ")", e); }
  }

  function normalizeChatSessions(raw) {
    if (!Array.isArray(raw) || !raw.length) return [];
    // 旧版：扁平消息数组 {role,content,ts} —— 兼容迁移为单个会话
    if (raw[0] && raw[0].role && !raw[0].messages) {
      return [{ id: "s-mig", title: "旧对话", topic: null, messages: raw, updated: Date.now() }];
    }
      return raw
      .filter((s) => s && Array.isArray(s.messages))
      .map((s) => ({
        id: s.id || "s" + Date.now() + Math.floor(Math.random() * 1000),
        title: s.title || "新对话",
        bookId: s.bookId || LEGACY_BOOK_ID,
        topic: s.topic || null,
        messages: Array.isArray(s.messages) ? s.messages : [],
        updated: s.updated || Date.now()
      }));
  }

  function saveChatSessions() {
    const trimmed = chatSessions.slice(-60); // 最多保留最近 60 个会话
    chatSessions = trimmed;
    const write = (arr) => { chatSessions = arr; localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(arr)); };
    try {
      write(trimmed);
    } catch (e) {
      // 配额超限（多为图片过大）：先剥离图片，再层层缩减，确保对话文本绝不丢失
      let stripped = false;
      chatSessions.forEach((s) => s.messages.forEach((m) => {
        if (m.images && m.images.length) { m.images = []; stripped = true; }
      }));
      if (stripped) { try { write(chatSessions); return; } catch (e2) {} }
      try { write(trimmed.slice(-30)); return; } catch (e3) {}
      try {
        write(trimmed.slice(-10).map((s) => ({ id: s.id, title: s.title, topic: s.topic, updated: s.updated, messages: s.messages.slice(-12) })));
      } catch (e4) {}
    }
    markSyncDirty();
  }

  function currentSession() {
    return chatSessions.find((s) => s.id === currentSessionId) || null;
  }

  function ensureSession() {
    let s = currentSession();
    if (s && (s.bookId || LEGACY_BOOK_ID) === activeBookId) return s;
    // 当前会话不属于当前书：切换到该书最近的会话，或新建
    const sessionsForBook = chatSessions.filter((x) => (x.bookId || LEGACY_BOOK_ID) === activeBookId);
    if (sessionsForBook.length) {
      currentSessionId = sessionsForBook[sessionsForBook.length - 1].id;
      renderSessions();
      return currentSession();
    }
    s = { id: "s" + Date.now() + Math.floor(Math.random() * 1000), title: "新对话", bookId: activeBookId, topic: null, messages: [], updated: Date.now() };
    chatSessions.push(s);
    currentSessionId = s.id;
    saveChatSessions();
    renderSessions();
    return s;
  }

  function deriveTitle(session, text) {
    const t = session && session.topic;
    if (t && t.page) return "P" + t.page + (t.number ? " 第" + t.number + "题" : "");
    const first = (text || "").replace(/\s+/g, " ").trim();
    if (first) return first.length > 14 ? first.slice(0, 14) + "…" : first;
    return "新对话";
  }

  function loadJSON(key, def) {
    try { return JSON.parse(localStorage.getItem(key)) || def; }
    catch (e) { return def; }
  }

  /* ---------- 公式渲染（MathJax，按需懒加载） ---------- */
  let mathjaxLoading = null;
  function ensureMathJax() {
    // index.html 头部已设置 window.MathJax 配置；这里只在首次需要公式时再拉取 2.1MB 的 tex-svg.js
    if (window.MathJax && window.MathJax.typesetPromise) return Promise.resolve();
    if (mathjaxLoading) return mathjaxLoading;
    mathjaxLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "vendor/mathjax/tex-svg.js";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("MathJax 脚本加载失败"));
      document.head.appendChild(s);
    });
    return mathjaxLoading;
  }
  // v50: \boldsymbol 是独立扩展包，本地化时扩展加载易失败（红字"未知命令"甚至启动卡死）。
  // 改用 base 包内置、离线必渲染的 \mathbf 作为等价替代：渲染前把文本节点里的 \boldsymbol 预处理成 \mathbf。
  // 注意只替换后接非字母的写法（\boldsymbol{...} / \boldsymbol x），避免误伤 \boldsymbolalpha 这类（极少见）。
  function rewriteBoldSymbol(el) {
    if (!el) return;
    const walk = (node) => {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) {
          if (c.data && c.data.indexOf("\\boldsymbol") >= 0) c.data = c.data.replace(/\\boldsymbol(?![A-Za-z])/g, "\\mathbf");
        } else if (c.nodeType === 1 && c.tagName !== "SCRIPT" && c.tagName !== "STYLE") {
          walk(c);
        }
      }
    };
    walk(el);
  }
  function typeset(el) {
    if (!el) return;
    rewriteBoldSymbol(el);
    if (window.MathJax && window.MathJax.tex2svgPromise) {
      // 用 tex2svgPromise 逐公式渲染：该接口每次新建文档，粗体（\mathbf/\boldsymbol 预处理后）渲染稳定；
      // 而 typesetPromise（共享文档）在本环境渲染粗体会抛 "Cannot read properties of null (reading '4')"，故不用它。
      typesetByTex2svg(el).catch(() => {});
    } else if (window.MathJax && window.MathJax.typesetPromise) {
      try { window.MathJax.typesetPromise([el]).catch(() => {}); } catch (e) {}
    } else {
      ensureMathJax().then(() => typeset(el)).catch(() => {});
    }
  }
  // 把元素里文本节点中的 $...$（行内）和 $$...$$（独立）用 tex2svgPromise 替换为 SVG 容器
  async function typesetByTex2svg(root) {
    const textNodes = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) textNodes.push(c);
        else if (c.nodeType === 1 && c.tagName !== "SCRIPT" && c.tagName !== "STYLE") walk(c);
      }
    };
    walk(root);
    for (const node of textNodes) {
      const s = node.data;
      // v51: 以前只跳过"无 $"的文本节点，导致模型用 \(...\) / \[...\] 写的公式整段裸显。
      // 现改为：只要含 $ / \( / \[ 任一公式定界符才尝试渲染。
      if (s.indexOf("$") < 0 && s.indexOf("\\(") < 0 && s.indexOf("\\[") < 0) continue;
      const re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$(?!\$)([^$\n]+?)\$(?!\$)|\\\(([\s\S]+?)\\\)/g;
      let m, last = 0, changed = false;
      const out = [];
      while ((m = re.exec(s))) {
        const disp = m[1] !== undefined || m[2] !== undefined;
        const tex = disp ? (m[1] !== undefined ? m[1] : m[2]) : (m[3] !== undefined ? m[3] : m[4]);
        out.push(s.slice(last, m.index));
        try {
          const container = await window.MathJax.tex2svgPromise(tex, { display: disp });
          out.push(container.outerHTML);
        } catch (e) {
          out.push(s.slice(m.index, re.lastIndex)); // 出错则保留原文
        }
        last = re.lastIndex;
        changed = true;
      }
      if (!changed) continue;
      out.push(s.slice(last));
      const frag = document.createElement("div");
      frag.innerHTML = out.join("");
      const parent = node.parentNode;
      if (!parent) continue;
      while (frag.firstChild) parent.insertBefore(frag.firstChild, node);
      parent.removeChild(node);
    }
  }
  function renderRich(s) {
    // v51: 先保护公式内的换行（避免下方 \n→<br> 把跨行显示公式拆到不同文本节点），
    // 渲染/转 <br> 完成后再还原，保证 tex2svgPromise 能把 \[...\] / $$...$$ 整体匹配。
    let t = protectMathNewlines(s || "");
    t = escapeHtml(t);
    t = t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    t = t.replace(/\n/g, "<br/>");
    t = restoreMathNewlines(t);
    return t;
  }

  /* ---------- 多书：书架 / 活动书 ---------- */
  const ACTIVE_BOOK_KEY = "active_book_v1";
  let activeBookId = LEGACY_BOOK_ID;
  let activeBook = null;
  let userBooks = [];
  let allBooks = [];

  /* IndexedDB：存放用户上传的书（PDF 存本机浏览器，无需后端） */
  const BOOK_DB = "study_platform_books";
  function openBookDB() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(BOOK_DB, IDB_VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function saveUserBook(book) {
    const db = await openBookDB();
    return new Promise((res, rej) => {
      const tx = db.transaction("books", "readwrite");
      tx.objectStore("books").put(book);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function getUserBooks() {
    try {
      const db = await openBookDB();
      return await new Promise((res, rej) => {
        const tx = db.transaction("books", "readonly");
        const req = tx.objectStore("books").getAll();
        req.onsuccess = () => res((req.result || []).map((b) => ({ id: b.id, title: b.title, color: b.color })));
        req.onerror = () => rej(req.error);
      });
    } catch (e) { return []; }
  }
  async function getUserBookPdf(id) {
    try {
      const db = await openBookDB();
      return await new Promise((res, rej) => {
        const tx = db.transaction("books", "readonly");
        const req = tx.objectStore("books").get(id);
        req.onsuccess = () => res(req.result ? req.result.pdf : null);
        req.onerror = () => rej(req.error);
      });
    } catch (e) { return null; }
  }

  /* IndexedDB：存放用户上传的考卷 PDF（原图展示 + 答疑用，存本机浏览器，不上传服务器） */
  const EXAM_DB = "study_platform_exams";
  function openExamDB() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(EXAM_DB, IDB_VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("exams")) db.createObjectStore("exams", { keyPath: "id" });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function saveExamPdf(rec) {
    const db = await openExamDB();
    return new Promise((res, rej) => {
      const tx = db.transaction("exams", "readwrite");
      tx.objectStore("exams").put(rec);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function getExamPdf(id) {
    try {
      const db = await openExamDB();
      return await new Promise((res, rej) => {
        const tx = db.transaction("exams", "readonly");
        const req = tx.objectStore("exams").get(id);
        req.onsuccess = () => res(req.result ? req.result.pdf : null);
        req.onerror = () => rej(req.error);
      });
    } catch (e) { return null; }
  }

  /* 进度/错因键加 bookId 命名空间，实现按书隔离 */
  function pk(id) { return activeBookId + ":" + id; }

  function migrateProgressForBook(bookId) {
    if (bookId !== LEGACY_BOOK_ID) return;
    let migrated = false;
    Object.keys(progress).forEach((k) => {
      if (k.indexOf(":") >= 0) return;
      const npk = bookId + ":" + k;
      if (!(npk in progress)) progress[npk] = progress[k];
      delete progress[k];
      migrated = true;
    });
    if (migrated) localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  }

  async function loadBook(book) {
    activeBook = book;
    activeBookId = book.id;
    if (book.index && typeof book.index === "string") {
      try {
        const ri = await fetch(book.index, { cache: "no-store" });
        bookIndex = await ri.json();
      } catch (e) { bookIndex = null; }
    } else { bookIndex = null; }
    if (book.problems && typeof book.problems === "string") {
      try {
        const rp = await fetch(book.problems, { cache: "no-store" });
        const dp = await rp.json();
        meta = dp.meta || {};
        problems = dp.problems || [];
      } catch (e) { problems = []; meta = {}; }
    } else { problems = []; meta = {}; }
    $("bookName").textContent = (meta && meta.book) || book.title || "未命名课本";
    if (book.exams && typeof book.exams === "string") {
      try {
        const re = await fetch(book.exams, { cache: "no-store" });
        const de = await re.json();
        exams = de.exams || [];
      } catch (e) { exams = []; }
    } else { exams = []; }
    renderList();
    renderSummary();
    renderEncourage();
    renderExamList();
    migrateProgressForBook(book.id);
  }

  async function autoLoadBook(book) {
    book = book || activeBook;
    if (!book) return;
    try {
      let buf = null;
      if (book.pdf) {
        const res = await fetch(book.pdf);
        if (!res.ok) return;
        buf = await res.arrayBuffer();
      } else {
        buf = await getUserBookPdf(book.id);
        if (!buf) return;
      }
      await loadPdfArrayBuffer(buf);
    } catch (e) {}
  }

  async function loadBookManifest() {
    let seedBooks = [];
    try {
      const r = await fetch("data/books.json", { cache: "no-store" });
      const d = await r.json();
      seedBooks = d.books || [];
      const persistedActive = localStorage.getItem(ACTIVE_BOOK_KEY);
      activeBookId = persistedActive || d.active || (seedBooks[0] && seedBooks[0].id) || LEGACY_BOOK_ID;
    } catch (e) { seedBooks = []; }
    try { userBooks = await getUserBooks(); } catch (e) { userBooks = []; }
    const all = seedBooks.concat(userBooks);
    populateBookSelect(all);
    const active = all.find((b) => b.id === activeBookId) || all[0];
    if (active) { await loadBook(active); await autoLoadBook(active); }
    refreshBookViews();
  }

  function populateBookSelect(all) {
    allBooks = all;
    const sel = $("bookSelect");
    if (!sel) return;
    sel.innerHTML = all.map((b) => `<option value="${b.id}">${escapeHtml(b.title || b.id)}</option>`).join("");
    sel.value = activeBookId;
    sel.onchange = () => {
      const b = all.find((x) => x.id === sel.value);
      if (b) {
        localStorage.setItem(ACTIVE_BOOK_KEY, b.id);
        loadBook(b).then(() => {
          autoLoadBook(b);
          refreshBookViews();
        });
      }
    };
  }

  /* ---------- 题目列表 ---------- */
  function statusOf(p) { return progress[pk(p.id)] || "unstudied"; }

  function allProblems() {
    const up = userProblems.filter((p) => (p.bookId || LEGACY_BOOK_ID) === activeBookId);
    return problems.concat(up);
  }

  function visibleProblems() {
    return allProblems().filter((p) => {
      const st = statusOf(p);
      if (curFilter === "all") return true;
      if (curFilter === "unstudied") return st === "unstudied";
      if (curFilter === "wrong") return st === "wrong";
      if (curFilter === "mastered") return st === "mastered" || st === "learned";
      return true;
    });
  }

  const STATUS_LABEL = { unstudied: "未学", learned: "已学会", mastered: "已掌握", wrong: "错题" };

  function renderList(list) {
    const items = list || visibleProblems();
    const box = $("problemList");
    if (!items.length) {
      box.innerHTML = `<div class="empty"><div class="big">🗒️</div>
        <p>还没有题目数据。</p>
        <p>在 LearnBuddy 对话里问一道题（如「P127 第5题不会」），<br/>讲解会自动写进平台。</p></div>`;
      return;
    }
    box.innerHTML = items.map((p) => {
      const st = statusOf(p);
      const pageLabel = p.page ? `P${p.page}` : "未定位";
      const numLabel = p.number ? `第${p.number}题` : (p.page ? "（未编号）" : "");
      return `<div class="problem-item" data-id="${p.id}">
        <div class="pi-top">
          <span class="pi-page">${pageLabel}</span>
          <span class="pi-title">${numLabel}</span>
          <span class="badge ${st}">${STATUS_LABEL[st]}</span>
        </div>
        <div class="pi-concept">${escapeHtml(p.concept || "")}</div>
      </div>`;
    }).join("");
    box.querySelectorAll(".problem-item").forEach((el) => {
      el.addEventListener("click", () => openDetail(el.dataset.id));
    });
  }

  function makeSnippet(text, kw) {
    const lower = (text || "").toLowerCase();
    const i = lower.indexOf(kw.toLowerCase());
    if (i < 0) return escapeHtml((text || "").slice(0, 80));
    const s = Math.max(0, i - 30);
    const e = Math.min(text.length, i + kw.length + 30);
    let snip = (s > 0 ? "…" : "") + text.slice(s, e) + (e < text.length ? "…" : "");
    const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    snip = snip.replace(re, (m) => `<mark>${escapeHtml(m)}</mark>`);
    return snip;
  }

  function renderSearchResults(probHits, bookHits) {
    const box = $("problemList");
    let html = "";
    if (probHits.length) {
      html += `<div class="res-group">题目（${probHits.length}）</div>`;
      html += probHits.map((p) => {
        const st = statusOf(p);
        const pageLabel = p.page ? `P${p.page}` : "未定位";
        const numLabel = p.number ? `第${p.number}题` : (p.page ? "（未编号）" : "");
        return `<div class="problem-item" data-id="${p.id}">
          <div class="pi-top"><span class="pi-page">${pageLabel}</span><span class="pi-title">${numLabel}</span><span class="badge ${st}">${STATUS_LABEL[st]}</span></div>
          <div class="pi-concept">${escapeHtml(p.concept || "")}</div></div>`;
      }).join("");
    }
    if (bookHits.length) {
      html += `<div class="res-group">课本（${bookHits.length} 页匹配）</div>`;
      html += bookHits.slice(0, 50).map((b) => `
        <div class="book-item" data-page="${b.page}">
          <div class="bi-page">P${b.page}</div>
          <div class="bi-snippet">${b.snippet}</div>
        </div>`).join("");
    }
    if (!html) html = `<div class="empty"><div class="big">🔍</div><p>没有匹配结果。</p></div>`;
    box.innerHTML = html;
    box.querySelectorAll(".problem-item").forEach((el) => el.addEventListener("click", () => openDetail(el.dataset.id)));
    box.querySelectorAll(".book-item").forEach((el) => el.addEventListener("click", () => {
      switchTab("problems");
      const pg = parseInt(el.dataset.page, 10);
      if (pdfDoc) { gotoPage(pg); }
      else {
        autoLoadBook().then(() => {
          if (pdfDoc) gotoPage(pg);
          else alert("课本 PDF 还没载入，请点右上「载入课本PDF」选文件，或刷新让平台自动载入后再试。");
        });
      }
    }));
  }

  /* ---------- 题目详情（教辅答案册式） ---------- */
  function openDetail(id) {
    const p = allProblems().find((x) => x.id === id);
    if (!p) return;
    $("listView").classList.add("hidden");
    $("detailView").classList.remove("hidden");

    const st = statusOf(p);
    const steps = (p.explanation || []);
    const solution = steps.map((s, i) => {
      const alreadyHasSolution = i === 0 && /^\s*(解|解答|证|证明)\s*[:：]/.test(s || "");
      return `<p>${i === 0 && !alreadyHasSolution ? "<b>解：</b>" : ""}${renderRich(s)}</p>`;
    }).join("");

    const vars = (p.variations || []).map((v, i) => `
      <div class="var-card">
        <div class="var-no">变式 ${i + 1}</div>
        <div class="var-prompt">${renderRich(v.prompt || "")}</div>
        <div class="var-toggle" data-i="${i}">▸ 看提示</div>
        <div class="var-hint hidden" id="vh-${id}-${i}">${renderRich(v.hint || "")}</div>
      </div>`).join("");

    const numTitle = p.number ? `第${p.number}题` : (p.page ? "（未编号）" : "题目");
    const pageTitle = p.page ? `（P${p.page}）` : "";
    $("detailContent").innerHTML = `
      <h3>${numTitle} <span class="dh-page">${pageTitle}</span></h3>
      <span class="detail-concept">${escapeHtml(p.concept || "")}</span>
      <div class="block-title">题目</div>
      <div class="q-text">${renderRich(p.question || "（无原题描述）")}</div>
      <div class="block-title">解答</div>
      <div class="solution">${solution || '<div class="muted">暂无解答</div>'}</div>
      <div class="block-title">举一反三</div>
      <div class="var-section">${vars || '<div class="muted" style="padding:4px 2px">暂无变式题，可回「答疑」让我补上。</div>'}</div>
      ${p.easyMistakes ? `<div class="block-title">易错提醒</div><div class="easy">⚠️ ${renderRich(p.easyMistakes)}</div>` : ""}
      ${p.chatTrace && p.chatTrace.length ? `
        <div class="block-title">📜 答疑留痕</div>
        <details class="raw-box"><summary>展开查看该题的答疑对话记录（${p.chatTrace.length} 条）</summary>
        <div class="raw-text">${escapeHtml(p.chatTrace.map((m) => `${m.role === "user" ? "我" : (m.role === "assistant" ? ("连小理") : m.role)}：${m.content}`).join("\n\n"))}</div></details>` : ""}
      <div class="actions">
        <button class="act learn ${st === "learned" || st === "mastered" ? "done" : ""}" data-st="learned">✓ 已学会</button>
        <button class="act master ${st === "mastered" ? "done" : ""}" data-st="mastered">⭐ 已掌握</button>
        <button class="act wrong ${st === "wrong" ? "done" : ""}" data-st="wrong">✗ 加入错题（填归因）</button>
        ${p.source === "chat" ? `<button class="act delete" data-st="delete">🗑 删除</button>` : ""}
      </div>`;

    $("detailContent").querySelectorAll(".var-toggle").forEach((t) => {
      t.addEventListener("click", () => {
        const h = $(`vh-${id}-${t.dataset.i}`);
        h.classList.toggle("hidden");
        t.textContent = h.classList.contains("hidden") ? "▸ 看提示" : "▾ 收起提示";
      });
    });
    $("detailContent").querySelectorAll(".act").forEach((b) => {
      b.addEventListener("click", () => {
        if (b.dataset.st === "wrong") { openAttrModal(id); return; }
        if (b.dataset.st === "delete") { deleteUserProblem(id); return; }
        setStatus(p.id, b.dataset.st);
        renderList();
        openDetail(id);
        renderSummary();
      });
    });

    if (pdfDoc && p.page) gotoPage(p.page);
    typeset($("detailContent"));
  }

  function setStatus(id, st) {
    const k = pk(id);
    if (progress[k] === st) delete progress[k];
    else progress[k] = st;
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    touchStreak();
    renderEncourage();
  }

  /* ---------- 错题归因（→ 教材定理/定义） ---------- */
  function renderAttrTypeRow(activeType) {
    const row = $("attrTypeRow");
    if (!row) return;
    row.innerHTML = ERR_TYPES.map((t) =>
      `<span class="et-chip${t.key === activeType ? " active" : ""}" data-type="${t.key}">${t.emoji} ${t.label}</span>`).join("");
    row.querySelectorAll(".et-chip").forEach((el) => el.addEventListener("click", () => {
      row.querySelectorAll(".et-chip").forEach((x) => x.classList.remove("active"));
      el.classList.add("active");
    }));
  }
  function populateAttrTreeSel(activeChapter, activeSection, activePoint) {
    const cs = $("attrChapterSel"), ss = $("attrSectionSel"), ps = $("attrPointSel");
    if (!cs || !ss || !ps) return;
    const t = bookTree();
    cs.innerHTML = '<option value="">— 章 —</option>' + t.chapters.map((c) => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join("");
    cs.value = activeChapter || "";
    const c = t.chapters.find((x) => x.id === activeChapter);
    ss.innerHTML = '<option value="">— 节 —</option>' + (c ? c.sections.map((s) => `<option value="${s.id}">${escapeHtml(s.title)}</option>`).join("") : "");
    ss.value = activeSection || "";
    const s = c && c.sections.find((x) => x.id === activeSection);
    ps.innerHTML = '<option value="">— 知识点 —</option>' + (s ? s.points.map((p) => `<option value="${p.id}">${escapeHtml(p.title)}</option>`).join("") : "");
    ps.value = activePoint || "";
    updateAttrPointLabel();
  }
  function updateAttrPointLabel() {
    const cs = $("attrChapterSel"), ss = $("attrSectionSel"), ps = $("attrPointSel"), lab = $("attrPointLabel");
    if (!cs || !ss || !ps || !lab) return;
    if (cs.value && ss.value && ps.value) {
      lab.textContent = "已选：" + pointLabel(cs.value, ss.value, ps.value);
      lab.classList.remove("empty");
    } else {
      lab.textContent = "未选择知识点（将归入「未关联知识点」）";
      lab.classList.add("empty");
    }
  }
  function openAttrModal(id) {
    const p = allProblems().find((x) => x.id === id);
    if (!p) return;
    $("attrId").value = id;
    const a = getAttr(id);
    renderAttrTypeRow(a && a.type);
    populateAttrTreeSel(a && a.chapterId, a && a.sectionId, a && a.pointId);
    $("attrNote").value = (a && a.note) || (p.easyMistakes || "");
    $("attrTheorem").value = (a && a.theorem) || p.concept || "";
    $("attrChapter").value = (a && a.chapter) || "";
    const legacy = $("attrLegacy");
    if (legacy) {
      if (a && a.theorem && !a.pointId) { legacy.classList.remove("hidden"); legacy.textContent = "（旧版归因，仅记录「" + (a.theorem || "") + (a.chapter ? " · " + a.chapter : "") + "」，建议上方选知识点以纳入图谱）"; }
      else legacy.classList.add("hidden");
    }
    $("attrAIStatus").textContent = "";
    // 展示答疑留痕，让归因有上下文依据
    const traceBox = $("attrTraceBox");
    const traceEl = $("attrTrace");
    if (p.chatTrace && p.chatTrace.length) {
      traceBox.classList.remove("hidden");
      traceEl.textContent = p.chatTrace.map((m) => {
        const who = m.role === "user" ? "我" : (m.agent && DISC_AGENTS[m.agent] ? DISC_AGENTS[m.agent].name : (m.role === "assistant" ? ("连小理") : m.role));
        return `${who}：${m.content}`;
      }).join("\n\n");
    } else {
      traceBox.classList.add("hidden");
      traceEl.textContent = "";
    }
    $("attrModal").classList.remove("hidden");
  }
  function closeAttrModal() { $("attrModal").classList.add("hidden"); }

  async function aiAttribute() {
    if (!chatConfig.key) { openChatSettings(); return; }
    const id = $("attrId").value;
    const p = allProblems().find((x) => x.id === id);
    if (!p) return;
    const statusEl = $("attrAIStatus");
    statusEl.textContent = "连小理正在归因…";
    let traceText = "";
    if (p.chatTrace && p.chatTrace.length) {
      traceText = "\n\n【该生在答疑时的真实对话记录】\n" + p.chatTrace.map((m) => {
        const who = m.role === "user" ? "学生" : (m.agent && DISC_AGENTS[m.agent] ? DISC_AGENTS[m.agent].name : "辅导老师");
        return `${who}：${m.content}`;
      }).join("\n");
    }
    const typeHint = ERR_TYPES.map((t) => t.key + "=" + t.label).join("、");
    const prompt = `你是数学分析辅导老师。请判断下面这道错题：① 学生的错误类型（从 ${typeHint} 中选一个英文 key）；② 最可能的知识根因（一句话）；③ 一句话错因。\n题目：${p.question || ""}\n讲解：${(p.explanation || []).join("\n")}${traceText}\n\n请优先结合对话记录里学生暴露的真实卡点进行归因。只输出 JSON：{"type":"错误类型key","chapter":"所属章节（如 第2章 极限）","note":"一句话错因"}。`;
    try {
      const ans = await callLLM([{ role: "system", content: "你是严谨的数理老师，只输出要求的 JSON，不要多余解释。" }, { role: "user", content: prompt }]);
      const m = ans.match(/\{[\s\S]*\}/);
      const obj = m ? JSON.parse(m[0]) : null;
      if (obj) {
        if (obj.type && ERR_TYPES.some((t) => t.key === obj.type)) renderAttrTypeRow(obj.type);
        $("attrChapter").value = obj.chapter || "";
        $("attrNote").value = obj.note || "";
        statusEl.textContent = "✓ 已自动填入类型与错因，请在上方选知识点后保存";
      } else {
        statusEl.textContent = "未能解析，请手动填写";
      }
    } catch (e) {
      statusEl.textContent = "归因失败：" + e.message;
    }
  }

  function enqueueRedo(id, chapterId, sectionId, pointId) {
    if (!chapterId || !sectionId || !pointId) return;
    const rm = bookRedo();
    const key = chapterId + ":" + sectionId + ":" + pointId;
    if (!rm[id]) rm[id] = { pointKey: key, due: Date.now(), status: "pending", attempts: 0, pass: 0, fail: 0, last: null, variant: "" };
    else rm[id].pointKey = key;
    saveRedo();
  }
  function saveAttr() {
    const id = $("attrId").value;
    progress[pk(id)] = "wrong";
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    touchStreak();
    renderEncourage();
    const typeEl = document.querySelector("#attrTypeRow .et-chip.active");
    const type = typeEl ? typeEl.dataset.type : "";
    const cid = $("attrChapterSel").value, sid = $("attrSectionSel").value, pid = $("attrPointSel").value;
    const label = (cid && sid && pid) ? pointLabel(cid, sid, pid) : "";
    const chapterTitle = (bookTree().chapters.find((c) => c.id === cid) || {}).title || "";
    setAttr(id, {
      type: type,
      chapterId: cid || "", sectionId: sid || "", pointId: pid || "",
      theorem: label || $("attrTheorem").value.trim(),
      chapter: chapterTitle || $("attrChapter").value.trim(),
      note: $("attrNote").value.trim()
    });
    enqueueRedo(id, cid, sid, pid);
    closeAttrModal();
    renderList();
    renderSummary();
    renderWeak();
    if ($("detailView") && !$("detailView").classList.contains("hidden")) openDetail(id);
  }

  function markWrongOnly() {
    const id = $("attrId").value;
    progress[pk(id)] = "wrong";
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    touchStreak();
    renderEncourage();
    closeAttrModal();
    renderList();
    renderSummary();
    renderWeak();
    if ($("detailView") && !$("detailView").classList.contains("hidden")) openDetail(id);
  }

  function removeAttr() {
    const id = $("attrId").value;
    if (progress[pk(id)] === "wrong") { delete progress[pk(id)]; localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); }
    delete attrMap[pk(id)];
    localStorage.setItem("user_attr_v1", JSON.stringify(attrMap));
    closeAttrModal();
    renderList();
    renderSummary();
    renderWeak();
  }

  /* ---------- 考点库 ---------- */
  function allExams() { return exams.concat(userExamsForBook()); }

  function renderExamList() {
    const box = $("examList");
    const list = allExams();
    $("examCount").textContent = `共 ${list.length} 份考卷`;
    if (!list.length) {
      box.innerHTML = `<div class="empty"><div class="big">📝</div>
        <p>考点库还是空的。</p>
        <p>把一份考卷（PDF/图片）发给 LearnBuddy，<br/>它会读卷并沉淀考点总结到这里；<br/>也可点右上「＋ 添加考卷」自己录入。</p></div>`;
      return;
    }
    box.innerHTML = list.map((e) => `
      <div class="exam-item" data-id="${e.id}">
        <div class="ei-title">${escapeHtml(e.title || "未命名考卷")}${e.source === "user" ? ' <span class="ei-tag">本地</span>' : ""}${e.hasPdf ? ' <span class="ei-tag pdf">PDF</span>' : ""}</div>
        <div class="ei-sub">${e.points ? e.points.length + " 个考点" : ""}${(e.hasPdf && e.pageCount) ? " · " + e.pageCount + " 页原图" : ""}</div>
      </div>`).join("");
    box.querySelectorAll(".exam-item").forEach((el) => {
      el.addEventListener("click", () => openExam(el.dataset.id));
    });
  }

  function openExam(id) {
    const e = allExams().find((x) => x.id === id);
    if (!e) return;
    const points = e.points || [];
    const maxFreq = Math.max(1, ...points.map((p) => p.freq || 0));
    const rows = points.map((p) => `
      <div class="point-row">
        <div class="point-top">
          <span class="point-name">${escapeHtml(p.name || "")}</span>
          <span class="point-chapter">${escapeHtml(p.chapter || "")}</span>
          <span class="point-freq">频次 ${p.freq || 0}</span>
        </div>
        <div class="freq-bar"><div class="freq-fill" style="width:${(100 * (p.freq || 0) / maxFreq).toFixed(0)}%"></div></div>
        ${p.note ? `<div class="point-note">${renderRich(p.note)}</div>` : ""}
      </div>`).join("");

    const hasPdf = !!e.hasPdf;
    // 考卷原图（PDF）查看器：有 PDF 时作为主呈现，OCR 原文降级为折叠备用
    const pdfBlock = hasPdf ? `
      <div class="block-title">考卷原图（PDF）</div>
      <div class="exam-pdf-viewer">
        <div class="pdf-toolbar exam-toolbar">
          <button id="examPrev" class="ghost">‹</button>
          <span id="examPageInfo">— / —</span>
          <button id="examNext" class="ghost">›</button>
          <span class="pdf-divider"></span>
          <input id="examJump" type="number" min="1" placeholder="页码" title="输入页码按回车跳转" class="jump-page-input" />
        </div>
        <div class="exam-pdf-canvas-wrap">
          <canvas id="examCanvas"></canvas>
          <div id="examPdfPlaceholder" class="pdf-placeholder">
            <div class="big">📄</div>
            <p>正在载入考卷原图…</p>
          </div>
        </div>
      </div>` : "";

    const raw = (e.rawText && e.rawText.trim())
      ? (hasPdf
        ? `<details class="raw-box"><summary>展开 OCR 原文（备用，原图更清晰）</summary>
            <div class="raw-text">${escapeHtml(e.rawText)}</div></details>`
        : `<details class="raw-box"><summary>展开查看提取的原文（${e.rawText.length} 字）</summary>
            <div class="raw-text">${escapeHtml(e.rawText)}</div></details>`)
      : "";

    $("examDetail").classList.remove("hidden");
    $("examDetail").innerHTML = `
      <div class="back-wrap"><button id="examBack" class="ghost back">‹ 返回列表</button></div>
      <div class="exam-detail-head">
        <h3>${escapeHtml(e.title || "")}</h3>
        ${hasPdf ? '<button id="examQaBtn" class="primary">💬 针对此考卷答疑</button>' : '<span class="muted">未上传 PDF，暂不支持针对考卷答疑（添加考卷时上传 PDF 即可）</span>'}
      </div>
      <div class="block-title">总体分析</div>
      <div class="q-text">${renderRich(e.summary || "（无总结）")}</div>
      <div class="block-title">考点分布</div>
      ${rows || '<div class="muted">暂无考点</div>'}
      ${pdfBlock}
      ${raw ? `<div class="block-title">考卷原文</div>${raw}` : ""}`;
    $("examBack").addEventListener("click", () => $("examDetail").classList.add("hidden"));
    typeset($("examDetail"));

    if (hasPdf) wireExamViewer(e);
    const qaBtn = $("examQaBtn");
    if (qaBtn) qaBtn.addEventListener("click", () => startExamQa(e.id));
  }

  /* 考卷 PDF 原图查看器：把考卷 PDF 渲染进独立 examPdfDoc，不覆盖课本 viewer */
  async function wireExamViewer(e) {
    const canvas = $("examCanvas");
    const placeholder = $("examPdfPlaceholder");
    if (!canvas) return;
    try { await ensurePdfJs(); } catch (err) { if (placeholder) placeholder.querySelector("p").textContent = "PDF 组件加载失败，无法显示原图。"; return; }
    if (!examPdfDoc || examPdfLoadedId !== e.id) {
      const buf = await getExamPdf(e.id);
      if (!buf) { if (placeholder) placeholder.querySelector("p").textContent = "考卷原图未找到（可能未上传或已清除）。"; return; }
      try {
        examPdfDoc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
        examPdfLoadedId = e.id;
      } catch (err) {
        if (placeholder) placeholder.querySelector("p").textContent = "考卷原图解析失败：" + err.message;
        return;
      }
    }
    if (placeholder) placeholder.style.display = "none";
    examCurPage = 1;
    await renderExamPage(1);
    on("examPrev", "click", () => gotoExamPage(examCurPage - 1));
    on("examNext", "click", () => gotoExamPage(examCurPage + 1));
    const jpi = $("examJump");
    if (jpi) {
      const doJump = () => { const n = parseInt(jpi.value, 10); if (n >= 1) gotoExamPage(n); };
      jpi.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); doJump(); } });
      jpi.addEventListener("blur", doJump);
    }
  }

  async function renderExamPage(n) {
    if (!examPdfDoc) return;
    n = Math.min(Math.max(1, n), examPdfDoc.numPages);
    examCurPage = n;
    const page = await examPdfDoc.getPage(n);
    const canvas = $("examCanvas");
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const base = page.getViewport({ scale: 1 });
    const availW = (wrap && (wrap.clientWidth || wrap.offsetWidth)) || 600;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.max(0.5, (availW - 24) / base.width);
    const viewport = page.getViewport({ scale: scale * dpr });
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = (base.width * scale) + "px";
    canvas.style.height = (base.height * scale) + "px";
    if (examCurrentRender && examCurrentRender.cancel) { try { examCurrentRender.cancel(); } catch (e) {} }
    const task = page.render({ canvasContext: ctx, viewport });
    examCurrentRender = task;
    try { await task.promise; }
    catch (e) { if (e && e.name !== "RenderingCancelled") console.warn(e); }
    const pi = $("examPageInfo"); if (pi) pi.textContent = `${n} / ${examPdfDoc.numPages}`;
  }

  function gotoExamPage(n) {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => renderExamPage(n));
    else renderExamPage(n);
  }

  /* 针对考卷答疑：把考卷 PDF 载入 examPdfDoc，切到答疑，开/选一个考卷会话 */
  async function startExamQa(id) {
    const e = allExams().find((x) => x.id === id);
    if (!e || !e.hasPdf) return;
    try { await ensurePdfJs(); } catch (err) { alert("PDF 组件加载失败，无法针对考卷答疑：" + err.message); return; }
    if (!chatConfig.key) { alert("请先在 ⚙ 设置里填好 API Key，再针对考卷答疑。"); openChatSettings(); return; }
    if (!examPdfDoc || examPdfLoadedId !== id) {
      const buf = await getExamPdf(id);
      if (!buf) { alert("考卷原图未找到，无法答疑。"); return; }
      try { examPdfDoc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise; examPdfLoadedId = id; examCurPage = 1; }
      catch (err) { alert("考卷原图解析失败：" + err.message); return; }
    }
    examQaExamId = id;
    examQaTitle = e.title || "考卷";
    switchTab("chat");
    // 复用该考卷已有的会话，否则新建
    let s = chatSessions.find((x) => (x.bookId || LEGACY_BOOK_ID) === activeBookId && x.examId === id);
    if (s) { currentSessionId = s.id; }
    else {
      s = {
        id: "s" + Date.now() + Math.floor(Math.random() * 1000),
        title: "考卷：" + (e.title || "未命名"),
        bookId: activeBookId, examId: id,
        topic: { page: examCurPage, number: null, question: "考卷答疑" },
        messages: [], updated: Date.now()
      };
      chatSessions.push(s); currentSessionId = s.id; saveChatSessions();
    }
    renderSessions(); renderCurrentSession();
    syncExamQaState();
    const ti = $("chatInput"); if (ti) ti.focus();
  }

  function showExamQaBanner() {
    const b = $("examQaBanner");
    if (!b) return;
    b.classList.remove("hidden");
    b.innerHTML = `📄 正在针对考卷《${escapeHtml(examQaTitle || "")}》答疑：翻到想问的页后，直接说「P页码 第X题」（图片会自动发给连小理）。<button id="examQaExit" class="ghost" type="button" style="margin-left:auto">退出考卷答疑</button>`;
    const ex = $("examQaExit");
    if (ex) ex.addEventListener("click", exitExamQa);
  }

  function exitExamQa() {
    examQaExamId = null; examQaTitle = null;
    examPdfDoc = null; examPdfLoadedId = null;
    const b = $("examQaBanner"); if (b) b.classList.add("hidden");
  }

  function buildExamSystemPrompt(title) {
    const t = title || "考卷";
    return `你是一个严谨的辅导老师，面向大学生。
当前用户正在针对一份考卷《${t}》答疑。对话中会附上该考卷某一页的**图像**，请基于图像中的题目内容讲解，不要凭空编造题目。
回答风格必须像「教辅答案册」：
- 以「解：」开头，分步给出推导，关键步骤用 **加粗**。
- 数学公式一律用 LaTeX：行内用 $...$，独立公式用 $$...$$。
- 讲清思路，必要时指出易错点，但每轮回复控制在 3-5 个要点内，保持对话节奏。
只回答与学习相关的问题。`;
  }

  function buildExamSocraticPrompt(title) {
    const t = title || "考卷";
    return `你叫「连小理」，是一名大学辅导老师，面对理工科大一学生。当前用户正在针对考卷《${t}》答疑，对话中会附上该考卷某一页的**图像**，请基于图像中的题目内容引导，不要凭空编造题目。
你的核心教学法是「苏格拉底式引导」：不直接把最终答案喂给学生，而是通过循序渐进的追问让学生自己走通思路。

规则：
1. 收到题目后先不要给完整解答。先确认这题要求什么，再问学生目前想到了哪一步、卡在哪里。如果学生说"不会/没思路/不知道"，先给一个最小提示。
2. 每次回复只往前推一小步，用一个具体反问或小提示把球踢回给学生。回复要简短、有对话感。
3. 允许学生随时说"跳过/下一步/给点提示"来推进节奏。
4. 把学生注意力引回考卷题目本身的图像内容，帮他建立"知识点→题目"的映射。
5. 只有当学生明确说「给我答案 / 直接讲 / 完整解答 / 告诉我答案」时，才放弃追问，改用「教辅答案册」式给出完整分步解答：以「解：」开头，关键步 **加粗**，公式用 LaTeX。
6. 全程耐心、鼓励；保持回复在 3-5 个要点内。
7. 只回答与学习相关的问题。`;
  }

  /* ---------- 搜索 / 定位 ---------- */
  function parseSearch(q) {
    q = (q || "").trim();
    let page = null, number = null;
    const pm = q.match(/P\s*(\d+)/i);
    if (pm) page = parseInt(pm[1], 10);
    const nm = q.match(/第\s*(\d+)\s*题/i);
    if (nm) number = parseInt(nm[1], 10);
    if (page === null) {
      const bm = q.match(/^\s*(\d+)\s*$/);
      if (bm) page = parseInt(bm[1], 10);
    }
    const kw = q.replace(/P\s*\d+/i, "").replace(/第\s*\d+\s*题/i, "").replace(/^\s*\d+\s*$/, "").trim();
    return { page, number, kw };
  }

  function doSearch() {
    const { page, number, kw } = parseSearch($("searchInput").value);
    $("detailView").classList.add("hidden");
    $("listView").classList.remove("hidden");

    if (page !== null && number !== null) {
      const hit = allProblems().find((p) => p.page === page && p.number === number);
      if (hit) { openDetail(hit.id); return; }
      alert("平台里还没有这道题的讲解。\n\n这个搜索框只能找到「已经写进平台」的题，或搜课本原文，它联系不到我。\n\n想要讲解 → 用顶部「答疑」标签页直接问我，或回 LearnBuddy 对话说「P" + page + " 第" + number + "题不会」，讲完可一键存进题库。");
      return;
    }
    if (page !== null) {
      const list = allProblems().filter((p) => p.page === page);
      renderList(list);
      if (!list.length) alert(`第 ${page} 页还没有已入库的题目。\n用「答疑」标签页直接问我，或回 LearnBuddy 对话说「P${page} 第X题不会」。`);
      return;
    }
    if (kw) {
      const kwL = kw.toLowerCase();
      const probHits = allProblems().filter((p) =>
        [p.concept, p.question, p.title].some((f) => (f || "").toLowerCase().includes(kwL))
      );
      const bookHits = ((bookIndex && bookIndex.pages) || [])
        .filter((p) => p.text && p.text.toLowerCase().includes(kwL))
        .map((p) => ({ page: p.page, snippet: makeSnippet(p.text, kw) }));
      renderSearchResults(probHits, bookHits);
      if (!probHits.length && !bookHits.length) alert(`没搜到「${kw}」相关内容。`);
      return;
    }
    renderList();
  }

  /* ---------- 进度 / 鼓励 ---------- */
  function touchStreak() {
    const today = new Date().toISOString().slice(0, 10);
    const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (streak.last !== today) {
      streak.count = streak.last === yest ? (streak.count || 0) + 1 : 1;
      streak.last = today;
      localStorage.setItem(STREAK_KEY, JSON.stringify(streak));
    }
    return streak;
  }

  function renderSummary() {
    const ids = allProblems().map((p) => p.id);
    let learned = 0, wrong = 0;
    ids.forEach((id) => {
      const s = progress[pk(id)];
      if (s === "learned" || s === "mastered") learned++;
      if (s === "wrong") wrong++;
    });
    $("progressSummary").textContent = `已学会 ${learned} · 错题 ${wrong} · 连续 ${streak.count} 天`;
  }

  const TIPS = [
    "每天搞定 3 道不会的题，一学期就是几百道。",
    "错题不是失败，是大脑在长新突触。",
    "举一反三做一题，胜过原题刷十遍。",
    "卡住就问，平台会替你记住每一道题。",
    "今天也比昨天多会了一点点，真的。"
  ];
  function renderEncourage() {
    const tip = TIPS[new Date().getDate() % TIPS.length];
    const s = touchStreak();
    $("encourage").innerHTML = `🔥 连续学习 <b>${s.count}</b> 天　·　${tip}`;
  }

  /* ---------- PDF ---------- */
  async function loadPdfArrayBuffer(buf) {
    try { await ensurePdfJs(); } catch (err) { alert("PDF 组件加载失败：" + err.message); return; }
    try {
      pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
      curPage = 1;
      $("pdfPlaceholder").style.display = "none";
      await renderPage(curPage);
    } catch (e) {
      alert("PDF 解析失败：" + e.message);
    }
  }

  async function renderPage(n) {
    if (!pdfDoc) return;
    n = Math.min(Math.max(1, n), pdfDoc.numPages);
    curPage = n;
    const page = await pdfDoc.getPage(n);
    const wrap = document.querySelector(".pdf-canvas-wrap");
    const base = page.getViewport({ scale: 1 });
    // 按宽度撑满（字最大最清晰），高度超出时由左栏内部滚动
    const availW = (wrap && (wrap.clientWidth || wrap.offsetWidth)) || 600;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.max(0.5, (availW - 28) / base.width);
    // 用 dpr 放大渲染分辨率，根除高分屏模糊
    const viewport = page.getViewport({ scale: scale * dpr });
    const canvas = $("pdfCanvas");
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = (base.width * scale) + "px";
    canvas.style.height = (base.height * scale) + "px";
    if (currentRender && currentRender.cancel) { try { currentRender.cancel(); } catch (e) {} }
    const task = page.render({ canvasContext: ctx, viewport });
    currentRender = task;
    try { await task.promise; }
    catch (e) { if (e && e.name !== "RenderingCancelled") console.warn(e); }
    $("pageInfo").textContent = `${n} / ${pdfDoc.numPages}`;
  }

  function gotoPage(n) {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => renderPage(n));
    else renderPage(n);
  }

  /* ---------- 视图切换 ---------- */
  function switchTab(tab) {
    const showP = tab === "problems";
    const showE = tab === "exams";
    const showW = tab === "weak";
    const showC = tab === "chat";
    const showR = tab === "report";
    const showN = tab === "notes";
    const showD = tab === "daily";
    $("mainView").classList.toggle("hidden", !showP);
    $("examView").classList.toggle("hidden", !showE);
    $("weakView").classList.toggle("hidden", !showW);
    $("chatView").classList.toggle("hidden", !showC);
    $("reportView").classList.toggle("hidden", !showR);
    $("notesView").classList.toggle("hidden", !showN);
    $("dailyView").classList.toggle("hidden", !showD);
    $("tabProblems").classList.toggle("active", showP);
    $("tabExams").classList.toggle("active", showE);
    $("tabWeak").classList.toggle("active", showW);
    $("tabChat").classList.toggle("active", showC);
    $("tabReport").classList.toggle("active", showR);
    $("tabNotes").classList.toggle("active", showN);
    $("tabDaily").classList.toggle("active", showD);
    if (showE) typeset($("examView"));
    if (showW) renderWeak();
    if (showR) onReportTabOpen();
    if (showN) renderNotes();
    if (showD) renderDaily();
  }

  // 切课本后，把"依赖当前课本"的所有视图一次性重刷，避免只有题解区切换、其他区（薄弱点图谱/笔记/会话等）不同步
  function refreshBookViews() {
    renderList();
    renderSummary();
    renderEncourage();
    renderExamList();
    renderWeak();          // 掌握度统计 + 教材树 + 重做回路 + 错题归因列表
    reloadBookNotes();
    renderNotes();
    renderSessions();
    ensureSession();
    renderCurrentSession();
    if ($("reportView") && !$("reportView").classList.contains("hidden")) onReportTabOpen();
  }

  /* ---------- 周报：跨会话长期记忆驱动 ---------- */
  let _chapterMap = null;
  function getChapterMap() {
    if (_chapterMap) return _chapterMap;
    if (!bookIndex || !bookIndex.chapters) { _chapterMap = []; return _chapterMap; }
    _chapterMap = bookIndex.chapters
      .filter((c) => /第\s*\d+\s*章/.test(c.title || ""))
      .map((c) => ({ page: c.page, label: cleanChapterTitle(c.title) }))
      .sort((a, b) => a.page - b.page);
    return _chapterMap;
  }
  function cleanChapterTitle(raw) {
    let t = (raw || "").replace(/^\d+/, "").trim();
    const m = t.match(/第\s*(\d+)\s*章/);
    if (m) {
      const n = parseInt(m[1], 10);
      // 针对本教材 OCR 噪声做定向纠错，未知章节退化为原文
      const CORR = { 1: "极限", 2: "一元函数的连续性", 3: "一元函数的微分学", 4: "不定积分", 5: "综合习题", 7: "无穷级数" };
      if (CORR[n]) return "第" + n + "章 " + CORR[n];
    }
    return t || "未命名章节";
  }
  function mapPageToChapter(page) {
    if (!page) return null;
    const cmap = getChapterMap();
    let pick = null;
    for (const c of cmap) { if (c.page <= page) pick = c; else break; }
    return pick;
  }

  // 汇总长期记忆：答疑会话（按页→章映射）、错题归因、进度、连续天数
  function aggregate(rangeDays) {
    const now = Date.now();
    const since = rangeDays > 0 ? now - rangeDays * 86400000 : 0;
    const sessionsIn = chatSessions.filter((s) => s.messages.some((m) => m.ts >= since));
    const chapterCount = {};
    sessionsIn.forEach((s) => {
      let label = "未定位章节（提问时未带 P页码）";
      if (s.topic && s.topic.page) {
        const ch = mapPageToChapter(s.topic.page);
        if (ch) label = ch.label;
      }
      if (!chapterCount[label]) chapterCount[label] = { sessions: 0, messages: 0 };
      chapterCount[label].sessions += 1;
      chapterCount[label].messages += s.messages.filter((m) => m.ts >= since).length;
    });
    const weak = [];
    allProblems().forEach((p) => {
      if (statusOf(p) === "wrong") {
        const a = getAttr(p.id);
        weak.push({ id: p.id, page: p.page, number: p.number, theorem: a ? a.theorem : "（未归因）", chapter: a ? a.chapter : "", note: a ? a.note : "" });
      }
    });
    const theoremCount = {};
    weak.forEach((w) => {
      if (!theoremCount[w.theorem]) theoremCount[w.theorem] = { count: 0, items: [] };
      theoremCount[w.theorem].count++;
      theoremCount[w.theorem].items.push(w);
    });
    const ids = allProblems().map((p) => p.id);
    let learned = 0, mastered = 0, wrong = 0;
    ids.forEach((id) => { const st = progress[pk(id)]; if (st === "learned" || st === "mastered") learned++; if (st === "mastered") mastered++; if (st === "wrong") wrong++; });
    return {
      rangeDays, since, now,
      totalSessions: sessionsIn.length,
      totalAllSessions: chatSessions.length,
      chapterCount,
      theoremCount,
      weak,
      learned, mastered, wrong,
      streak: streak.count,
      totalProblems: ids.length
    };
  }

  function onReportTabOpen() {
    const saved = loadJSON(WEEKLY_REPORT_KEY, null);
    const box = $("reportContent");
    if (saved && saved.html) {
      box.innerHTML = saved.html;
      typeset(box);
    } else {
      box.innerHTML = '<div class="empty"><div class="big">📊</div><p>还没有周报。点右上「✨ 生成周报」，连小理会基于你的长期学习记忆自动汇总。</p></div>';
    }
  }

  function buildDataOnlyReport(agg) {
    const lines = [];
    const span = agg.rangeDays ? `近 ${agg.rangeDays} 天` : "全部时间";
    lines.push("# 数分学习周报（" + span + "）");
    lines.push("");
    lines.push("## 一、本周概览");
    lines.push(`在 **${span}** 内共进行了 **${agg.totalSessions}** 次答疑会话（历史累计 ${agg.totalAllSessions} 次）。当前累计已学会 ${agg.learned} 道、已掌握 ${agg.mastered} 道、错题 ${agg.wrong} 道，连续学习 **${agg.streak}** 天。保持这个节奏，你已经在变强了。`);
    lines.push("");
    lines.push("## 二、本周学了哪些章节");
    const chs = Object.keys(agg.chapterCount).sort((a, b) => agg.chapterCount[b].sessions - agg.chapterCount[a].sessions);
    if (!chs.length) lines.push("- 暂无会话数据");
    else chs.forEach((c) => lines.push(`- **${c}**：会话 ${agg.chapterCount[c].sessions} 次，消息 ${agg.chapterCount[c].messages} 条`));
    lines.push("");
    lines.push("## 三、错题集中在哪些定理");
    const ths = Object.keys(agg.theoremCount).sort((a, b) => agg.theoremCount[b].count - agg.theoremCount[a].count);
    if (!ths.length) lines.push("- 暂无错题归因，记得把错题归因到教材定理/定义");
    else ths.forEach((t) => {
      const items = agg.theoremCount[t].items.map((w) => (w.page ? "P" + w.page : "") + (w.number ? " 第" + w.number + "题" : "")).filter(Boolean);
      lines.push(`- **${t}**：错题 ${agg.theoremCount[t].count} 道${items.length ? "（" + items.slice(0, 3).join("、") + "）" : ""}`);
    });
    lines.push("");
    lines.push("## 四、进步亮点");
    lines.push(`累计已学会 ${agg.learned} 道、已掌握 ${agg.mastered} 道，连续学习 ${agg.streak} 天——这些实打实的积累就是进步。`);
    lines.push("");
    lines.push("## 五、下周攻坚计划");
    const top = ths.slice(0, 3);
    if (!top.length) {
      lines.push("- 维持当前节奏，每天搞定 3 道不会的题，并养成给错题归因的习惯。");
    } else {
      lines.push(`下周主攻 **${top[0]}**，这是目前最突出的薄弱点。具体行动：`);
      top.forEach((t, i) => {
        const items = agg.theoremCount[t].items;
        const sample = items.slice(0, 3).map((w) => (w.page ? "P" + w.page : "") + (w.number ? " 第" + w.number + "题" : "")).filter(Boolean).join("、") || "对应错题";
        lines.push(`${i + 1}. **重做「${t}」相关错题**：先盖住答案独立做 ${Math.min(items.length, 3)} 道（${sample}），再对照答案只标出卡壳的那一步，最后把错因用自己的话写一句话。`);
      });
      lines.push(`${top.length + 1}. **每日小目标**：每天抽 20 分钟，优先消化本周 top1 薄弱点，连续 3 天即可明显巩固。`);
    }
    return lines.join("\n");
  }

  async function generateWeeklyReport() {
    const box = $("reportContent");
    const rangeDays = parseInt($("reportRange").value, 10) || 7;
    const agg = aggregate(rangeDays);
    box.innerHTML = '<div class="report-loading">📊 连小理正在汇总你的长期学习记忆…</div>';

    const dataContext = JSON.stringify({
      统计周期: (agg.rangeDays ? "近" + agg.rangeDays + "天" : "全部"),
      范围内答疑会话数: agg.totalSessions,
      历史累计会话数: agg.totalAllSessions,
      各章节会话分布: agg.chapterCount,
      错题定理分布: Object.keys(agg.theoremCount).map((k) => ({
        定理定义: k, 错题数: agg.theoremCount[k].count,
        样例: agg.theoremCount[k].items.slice(0, 3).map((w) => (w.page ? "P" + w.page : "") + (w.number ? " 第" + w.number + "题" : ""))
      })),
      累计已学会: agg.learned, 已掌握: agg.mastered, 错题: agg.wrong,
      连续学习天数: agg.streak, 题库总数: agg.totalProblems
    }, null, 2);

    const sysPrompt = `你是「连小理」，一名亲切的大学《数学分析》辅导老师（学长/学姐风格）。下面是一名学生在本平台上的【跨会话长期学习记忆汇总数据】（浏览器本地保存的全部答疑会话、错题归因、学习进度）。
请基于这份真实数据，写一份给学生的「数分学习周报」（Markdown 格式），要求：

# 数分学习周报（YYYY-MM-DD 起 近 N 天）
## 一、本周概览
用 2-3 句话概括：共多少次答疑会话、覆盖哪些章节、当前错题数与连续学习天数，并给一句鼓励。
## 二、本周学了哪些章节
用**无序列表**（不要用表格）按会话数从高到低列出章节及对应会话数（基于"各章节会话分布"）。若大多是"未定位章节"，提醒学生以后提问带上 P页码 以便统计。
## 三、错题集中在哪些定理
用**无序列表**（不要用表格）列出高频定理/定义及错题数，点出最该优先补的 1-2 个薄弱点。
## 四、进步亮点
结合"已学会/已掌握/连续学习天数"给出积极反馈；数据很少时鼓励学生保持节奏。
## 五、下周攻坚计划
- 只针对最薄弱的 1-2 个定理制定计划，不要泛泛而谈。
- 每条建议必须具体：做什么、为什么、做多少、达到什么效果。
- 优先给出「重做对应错题」的建议，并列出具体题号（P页码·第X题）。
- 再给出「巩固知识点」和「检验方式」两条。
- 如果错题定理为空，给出「先建立错题归因习惯」的 3 条具体行动。

注意：
- 全部用中文，语气像学长/学姐一样亲切、鼓励。
- 公式用 LaTeX：行内 $...$，独立 $$...$。
- 用 **加粗** 强调重点。
- 不要编造数据里没有的章节或定理；数据缺失处如实说明。
- 只输出周报 Markdown，不要额外解释。`;

    if (!chatConfig.key) {
      const md = buildDataOnlyReport(agg);
      box.innerHTML = renderMarkdown(md);
      typeset(box);
      saveWeeklyReport(box.innerHTML, agg, md);
      return;
    }
    try {
      const ans = await callLLM([
        { role: "system", content: sysPrompt },
        { role: "user", content: "这是我的学习记忆数据，请据此生成周报：\n" + dataContext }
      ]);
      const html = renderMarkdown(ans);
      box.innerHTML = html;
      typeset(box);
      saveWeeklyReport(html, agg, ans);
    } catch (e) {
      const md = buildDataOnlyReport(agg);
      box.innerHTML = '<div class="report-error">⚠️ 连小理生成失败：' + escapeHtml(e.message) + '<br/>已为你生成纯数据版周报：</div>' + renderMarkdown(md);
      typeset(box);
      saveWeeklyReport(box.innerHTML, agg, md);
    }
  }

  function saveWeeklyReport(html, agg, raw) {
    try {
      localStorage.setItem(WEEKLY_REPORT_KEY, JSON.stringify({
        html, raw: raw || "", meta: { rangeDays: agg.rangeDays, generatedAt: new Date().toISOString() }
      }));
    } catch (e) {}
  }

  function exportReport() {
    const saved = loadJSON(WEEKLY_REPORT_KEY, null);
    if (!saved) { alert("还没有可导出的周报，请先点「生成周报」。"); return; }
    const md = saved.raw || "# 数分学习周报\n（无原始 Markdown，请在应用内查看渲染版）";
    downloadBlob("数分学习周报.md", md, "text/markdown;charset=utf-8");
  }

  // 极简 Markdown → HTML（支持 #/##/###、无序/有序列表、引用、加粗、行内代码），交给 MathJax 渲染 $...$
  function renderMarkdown(md) {
    // v51: 先把公式块内的换行保护起来，避免按行拆分把跨行 \[...\] / $$...$$ 拆到不同 <p>
    const lines = protectMathNewlines(md || "").split("\n");
    let html = "";
    let inUl = false, inOl = false;
    const closeLists = () => { if (inUl) { html += "</ul>"; inUl = false; } if (inOl) { html += "</ol>"; inOl = false; } };
    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, "");
      let m;
      if ((m = line.match(/^###\s+(.*)$/))) { closeLists(); html += "<h3>" + mdInline(m[1]) + "</h3>"; continue; }
      if ((m = line.match(/^##\s+(.*)$/))) { closeLists(); html += "<h2>" + mdInline(m[1]) + "</h2>"; continue; }
      if ((m = line.match(/^#\s+(.*)$/))) { closeLists(); html += "<h1>" + mdInline(m[1]) + "</h1>"; continue; }
      if ((m = line.match(/^>\s?(.*)$/))) { closeLists(); html += "<blockquote>" + mdInline(m[1]) + "</blockquote>"; continue; }
      if ((m = line.match(/^[-*]\s+(.*)$/))) {
        if (!inUl) { closeLists(); html += "<ul>"; inUl = true; }
        html += "<li>" + mdInline(m[1]) + "</li>"; continue;
      }
      if ((m = line.match(/^\d+\.\s+(.*)$/))) {
        if (!inOl) { closeLists(); html += "<ol>"; inOl = true; }
        html += "<li>" + mdInline(m[1]) + "</li>"; continue;
      }
      if (line.trim() === "") { closeLists(); continue; }
      closeLists();
      html += "<p>" + mdInline(line) + "</p>";
    }
    closeLists();
    return restoreMathNewlines(html);
  }
  function mdInline(s) {
    let t = escapeHtml(s);
    t = t.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    t = t.replace(/`([^`]+?)`/g, "<code>$1</code>");
    return t;
  }

  /* ---------- 对话答疑（浏览器直连大模型，无后端） ---------- */
  function buildSystemPrompt(bookTitle) {
    const bt = bookTitle || "当前课本";
    return `你是一个严谨的辅导老师，面向大学生。
当前学习的课本是《${bt}》。请基于当前课本回答用户问题，若用户提到「P页码 / 第X题」，默认指当前课本的对应位置。
回答风格必须像「教辅答案册」：
- 以「解：」开头，分步给出推导，关键步骤用 **加粗**。
- 数学公式一律用 LaTeX：行内用 $...$，独立公式用 $$...$$（例如极限写 $\\lim\\limits_{x\\to 0}\\dfrac{\\sin x}{x}$）。
- 讲清思路，必要时指出易错点，但每轮回复控制在 3-5 个要点内，保持对话节奏。
- 若用户引用「P页码 第X题」，对话中可能附上该页课本原文或图像，请基于当前课本内容讲解。
只回答与学习相关的问题。`;
  }

  // 苏格拉底引导式：连小理，当前课本辅导老师，追问不直给答案
  function buildSocraticPrompt(bookTitle) {
    const bt = bookTitle || "当前课本";
    return `你叫「连小理」，是一名大学辅导老师，面对理工科大一学生。当前学习的课本是《${bt}》，请基于当前课本回答，若用户提到「P页码 / 第X题」，默认指当前课本的对应位置。
你的核心教学法是「苏格拉底式引导」：不直接把最终答案喂给学生，而是通过循序渐进的追问让学生自己走通思路。

规则：
1. 收到题目后先不要给完整解答。先确认这题要求什么，再问学生目前想到了哪一步、卡在哪里。如果学生说"不会/没思路/不知道"，不要逼问，先给一个最小提示（如"这题和哪个定理/概念有关？"或"先把式子/代码变形试试？"）。
2. 每次回复只往前推一小步，用一个具体反问或小提示把球踢回给学生。回复要简短、有对话感，不要一次抛多个提示或整段讲解。如果学生连续两轮都没有进展、或反复说不会/卡住，主动给出下一步提示或部分答案，不要死磕同一个问题。
3. 允许学生随时说"跳过/下一步/给点提示/有点思路了"来推进节奏；不要要求他们按固定套路回答。
4. 把学生注意力引回教材的具体定义/定理/概念，帮他建立"知识点→题目"的映射。
5. 只有当学生明确说「给我答案 / 直接讲 / 完整解答 / 告诉我答案」时，才放弃追问，改用「教辅答案册」式给出完整分步解答：以「解：」开头，关键步 **加粗**，公式用 LaTeX（行内 $...$，独立 $$...$$）。
6. 全程耐心、鼓励；不要输出大段重复内容、错误堆栈或与技术调试无关的信息；保持回复在 3-5 个要点内。
7. 若学生引用「P页码 第X题」，对话中可能附上该页课本原文或图像，请基于当前课本内容引导。
8. 只回答与学习相关的问题。`;
  }

  // 学生明确要答案时的关键词（命中则本轮回退到直给答案）
  const GIVE_ANSWER_RE = /(给我答案|直接讲|直接给|给.{0,3}答案|我卡住了|完整解答|告诉我答案|给解答|讲.{0,3}答案|不想想了)/;

  // 四位一体角色提示词：讲解员 / 教练 / 考官 / 分析师
  function buildBookRolePrompt(role, bookTitle) {
    const bt = bookTitle || "当前课本";
    if (role === "coach") return buildSocraticPrompt(bt);
    if (role === "examiner") {
      return `你是一名严格的数学习题考官，面向理工科大一学生。当前课本《${bt}》。
任务：基于当前内容出高质量的「举一反三变式题」，检验用户是否真掌握该知识点。
【出题铁律】
1. 禁止"只替换数字、保留完全相同证明框架"的伪变式；变式必须让学生的思路发生实质变化。
2. 改编方向三选一（可组合）：① 改变前提条件——删减 / 增强题目条件，考察定理适用范围；② 转换命题形式——把原命题改成逆命题 / 否命题 / 逆否命题，让用户判断真假并证明；③ 提升综合度——融合 2 个及以上知识点，加长逻辑链条。
3. 每道变式后附【出题说明】：相比原题改动了哪些条件、考察的新能力是什么。
4. 难度分级：请分别给出【基础变式 / 进阶变式 / 挑战变式】三档（各 1 道），由用户按需自选。
格式：用 LaTeX（行内 $...$ 独立 $$...$$）。先只给题目与出题说明，不给答案；若用户说"给我答案 / 完整解答"再给。保持对话节奏，不要大段空话。只回答学习相关问题。`;
    }
    if (role === "analyst") {
      return `你是一名学习分析师，面向理工科大一学生。当前学习的课本是《${bt}》。\n你的任务是帮用户复盘错题 / 薄弱点：找出知识漏洞、总结错因、给出补全建议。\n规则：\n- 先分析用户卡在哪里，指出具体定理 / 概念 / 步骤的缺失。\n- 用简洁的结构化回复：1. 问题诊断  2. 对应知识点  3. 补全建议。\n- 保持耐心、鼓励；不要输出错误堆栈或与技术调试无关的信息。`;
    }
    return buildSystemPrompt(bt);
  }

  function buildExamRolePrompt(role, title) {
    const t = title || "考卷";
    if (role === "coach") return buildExamSocraticPrompt(t);
    if (role === "examiner") {
      return `你是一名数学习题考官，面向理工科大一学生。当前用户正针对考卷《${t}》答疑，对话会附该考卷某页**图像**。
任务：基于图像中的题目出「举一反三变式题」，检验真实掌握；不要凭空编造题目。
【出题铁律】（同书本考官）
1. 禁止只替换数字、保留相同证明框架。
2. 改编方向三选一：① 改前提条件 ② 转换命题形式（逆 / 否 / 逆否）③ 提升综合度（融合多知识点）。
3. 每道变式附【出题说明】：改动点 + 考察新能力。
4. 难度分【基础 / 进阶 / 挑战】三档各 1 道，由用户自选。
格式：LaTeX（行内 $...$ 独立 $$...$$），先给题与说明不给答案；用户要答案才给。保持节奏。`;
    }
    if (role === "analyst") {
      return `你是一名学习分析师，面向理工科大一学生。当前用户正在针对考卷《${t}》答疑，对话中会附上该考卷某一页的**图像**。\n请基于图像中的题目内容复盘：分析用户可能的错因、指出知识漏洞、给出补全建议；不要凭空编造题目。\n规则：\n- 结构化回复：1. 错因诊断  2. 对应知识点 / 定理  3. 下一步练习建议。\n- 保持简洁、鼓励。\n- 不要输出错误堆栈或与技术调试无关的信息。`;
    }
    return buildExamSystemPrompt(t);
  }

  function buildRolePrompt(role, bookTitle, isExam, title) {
    return isExam ? buildExamRolePrompt(role, title) : buildBookRolePrompt(role, bookTitle);
  }

  /* ---------- 研讨模式：4 智能体联动 ---------- */
  // 研讨智能体：主讲员 / 质疑官 / 诊断师 / 总结师（贴近真实数分课堂、自然有交锋）
  const DISC_AGENTS = {
    lecturer: {
      key: "lecturer", name: "主讲员", emoji: "📖", color: "#3b6cf6",
      prompt: (bt) => `你是数学研讨小组的「主讲员」，面向理工科大一学生，当前课本《${bt}》。
你的职责：作为主讲，把用户这道题/知识点的核心思路讲透——但注意：
- 推导必须**严谨**：优先把"证明逻辑"和"定理 / 公式的适用前提"讲清楚，而不只是算出结果；用到的每个定理都要点明它的适用条件。
- 主动**暴露思维陷阱**：指出学生容易在哪里想歪、哪个条件容易被忽略、哪一步是题眼。
- **不要直接给出"标准答案"的一步到位写法**；应给出思路骨架与关键引理，引导学生自己推完最后几步。若用户明确要求"直接给答案 / 完整解答"，再给。
- 你身处教学研讨小组，同组还有「质疑官」「诊断师」「总结师」。你只做主讲的部分，不替别人发言；后续成员会在你的基础上接力、质疑、补充。
- 控制篇幅（4-6 个要点、有对话感），用数学 LaTeX：行内 $...$ 与独立 $$...$$。只回答学习相关问题。`
    },
    critic: {
      key: "critic", name: "质疑官", emoji: "🤔", color: "#e6932b",
      prompt: (bt) => `你是数学研讨小组的「质疑官」，面向理工科大一学生，当前课本《${bt}》。
你的职责：对主讲员的讲解进行质疑、找漏洞、举反例、追问边界条件与易混淆点。你应当像真实课堂里较真的同学一样**打断式诘问**：
- 哪一步推导跳得太快、缺少依据？
- 哪个定理的适用前提没验证就用了？
- 哪个条件被默认成立，其实需要讨论 / 分类？
- 哪里可能让学生误解、栽跟头？
要求：不重复讲解本身，聚焦"哪里不严谨 / 哪里是易错点"。可以抛 1-2 个有启发性的追问。语气有锋芒但不刻薄，简短。只回答学习相关问题。`
    },
    diagnostic: {
      key: "diagnostic", name: "诊断师", emoji: "🔍", color: "#e05656",
      prompt: (bt) => `你是数学研讨小组的「诊断师」，面向理工科大一学生，当前课本《${bt}》。
你的职责：基于前面的研讨，随时捕捉对话 / 题目中的思维错误，把"现象"归因到"知识根因"（具体教材定理或定义）。
- 不必等轮到自己才发言；一旦发现明显错因就标记。
- 结构化输出：1. 典型错因 / 卡点  2. 对应的教材定理 / 定义（说清名称与适用前提）  3. 一句补全建议。
- 聚焦根因，不展开新讲解。只回答学习相关问题。`
    },
    summarist: {
      key: "summarist", name: "总结师", emoji: "💡", color: "#1faa6b",
      prompt: (bt) => `你是数学研讨小组的「总结师」，面向理工科大一学生，当前课本《${bt}》。
你的职责：等一轮讨论到阶段性收尾，再把前面（主讲员 / 质疑官 / 诊断师）的讨论收敛成可记忆的要点：
- 提炼通用方法、解题套路、需要牢记的结论，以及"一眼识别"的题眼。
- 用结构化清单（3-5 条），每条一句。不要重复完整推导，不要抢话，不要频繁插话。
- 若前面已讲透，可只点出最该记住的 1-2 条。只回答学习相关问题。`
    }
  };
  const DISC_ORDER = ["lecturer", "critic", "diagnostic", "summarist"]; // 仅作成员列表/兜底用，实际发言顺序由协调员动态决定
  const DISC_AT_RE = /^\s*@(主讲员|主讲解|主讲|讲解|质疑官|质疑|思辨|诊断师|归因|诊断|总结师|总结|提炼|lecturer|critic|diagnostic|summarist)(?=[\s,，。、!?！？:：()\[\]"']|$)/i;
  function resolveAgentByAlias(alias) {
    const a = (alias || "").replace(/^@/, "").toLowerCase();
    if (/主讲员|主讲解|主讲|讲解|lecturer/.test(a)) return "lecturer";
    if (/质疑官|质疑|思辨|critic/.test(a)) return "critic";
    if (/诊断师|归因|诊断|diagnostic/.test(a)) return "diagnostic";
    if (/总结师|总结|提炼|summarist/.test(a)) return "summarist";
    return null;
  }

  function getAttr(id) { return attrMap[pk(id)] || null; }
  function setAttr(id, attr) { attrMap[pk(id)] = attr; localStorage.setItem("user_attr_v1", JSON.stringify(attrMap)); }

  /* ---------- 会话侧栏（每题一个会话） ---------- */
  function renderSessions() {
    const box = $("chatSessions");
    if (!box) return;
    box.innerHTML = "";
    const list = chatSessions.filter((s) => (s.bookId || LEGACY_BOOK_ID) === activeBookId).slice().reverse(); // 最新在上
    list.forEach((s) => {
      const item = document.createElement("div");
      item.className = "chat-session-item" + (s.id === currentSessionId ? " active" : "");
      const sub = (s.topic && s.topic.page)
        ? (s.topic.number ? "第" + s.topic.number + "题" : "P" + s.topic.page)
        : (s.messages.length ? s.messages.length + " 条" : "空会话");
      const examBadge = s.examId ? ' <span class="cs-tag">考卷</span>' : "";
      item.innerHTML = '<span class="cs-title">' + escapeHtml(s.title || "新对话") + examBadge + '</span><span class="cs-sub">' + escapeHtml(sub) + '</span>';
      const del = document.createElement("button");
      del.className = "cs-del";
      del.textContent = "×";
      del.title = "删除此会话";
      del.addEventListener("click", (e) => { e.stopPropagation(); deleteSession(s.id); });
      item.appendChild(del);
      item.addEventListener("click", () => { currentSessionId = s.id; syncExamQaState(); renderCurrentSession(); renderSessions(); });
      box.appendChild(item);
    });
  }

  // 根据当前会话是否绑定考卷，同步「针对考卷答疑」提示条与全局标记
  function syncExamQaState() {
    const s = currentSession();
    if (s && s.examId && examPdfLoadedId === s.examId) {
      examQaExamId = s.examId;
      examQaTitle = s.title || "考卷";
      showExamQaBanner();
    } else {
      examQaExamId = null;
      examQaTitle = null;
      const b = $("examQaBanner"); if (b) b.classList.add("hidden");
    }
  }

  function renderCurrentSession() {
    const log = $("chatLog");
    if (!log) return;
    log.innerHTML = "";
    const s = currentSession();
    if (!s || !s.messages.length) {
      const e = document.createElement("div");
      e.id = "chatEmpty"; e.className = "chat-empty";
      e.innerHTML = '<div class="big">💬</div><p>直接问我吧，例如：</p><p>· P127 第5题不会<br/>· 帮我讲讲这一节的重点<br/>· 这道题卡住了，给我点提示</p><p class="muted">说「P页码」会自动带入当前课本对应页原文；也可直接粘贴题目截图，连小理会自动看图解答。</p>';
      log.appendChild(e);
      return;
    }
    s.messages.forEach((m) => {
      const id = "m" + Date.now() + Math.floor(Math.random() * 1000);
      const el = document.createElement("div");
      let cls = "msg " + m.role;
      let roleLabel = m.role === "assistant" ? ("连小理") : "我";
      if (m.agent && DISC_AGENTS[m.agent]) { cls += " agent-msg"; const a = DISC_AGENTS[m.agent]; roleLabel = a.emoji + " " + a.name; el.dataset.agent = a.key; el.style.setProperty("--agent-color", a.color); }
      el.className = cls;
      el.id = id;
      el.innerHTML = '<div class="msg-role">' + roleLabel + '</div>' +
        '<div class="msg-body">' + msgImgsHtml(m.images) + renderRich(m.content || "") + "</div>";
      log.appendChild(el);
      typeset(el);
    });
    log.scrollTop = log.scrollHeight;
  }

  function newBlankSession() {
    const s = { id: "s" + Date.now() + Math.floor(Math.random() * 1000), title: "新对话", bookId: activeBookId, topic: null, messages: [], updated: Date.now() };
    chatSessions.push(s);
    currentSessionId = s.id;
    saveChatSessions();
    syncExamQaState();
    renderCurrentSession();
    renderSessions();
  }

  function startNewSession(page, num, text) {
    const s = {
      id: "s" + Date.now() + Math.floor(Math.random() * 1000),
      title: "新对话",
      bookId: activeBookId,
      topic: (page || num) ? { page: page || null, number: num || null, question: text } : null,
      messages: [],
      updated: Date.now()
    };
    s.title = deriveTitle(s, text);
    chatSessions.push(s);
    currentSessionId = s.id;
    saveChatSessions();
    renderCurrentSession();
    renderSessions();
  }

  function deleteSession(id) {
    const s = chatSessions.find((x) => x.id === id);
    if (!s) return;
    if (!confirm("删除会话「" + (s.title || "未命名") + "」？该会话的问答记录会一并删除。")) return;
    chatSessions = chatSessions.filter((x) => x.id !== id);
    if (currentSessionId === id) currentSessionId = chatSessions.length ? chatSessions[chatSessions.length - 1].id : null;
    saveChatSessions();
    if (!currentSessionId) ensureSession();
    renderCurrentSession();
    renderSessions();
  }

  // 消息体中的图片缩略图（用于用户上传的截图）
  function msgImgsHtml(images) {
    if (!images || !images.length) return "";
    return '<div class="msg-imgs">' + images.map((src) =>
      '<img class="msg-img" src="' + escapeHtml(src) + '" alt="附图" />').join("") + '</div>';
  }

  function pushMsg(role, text, opts = {}) {
    const empty = $("chatEmpty");
    if (empty) empty.remove();
    const id = "m" + Date.now() + Math.floor(Math.random() * 1000);
    const el = document.createElement("div");
    let cls = "msg " + role;
    let roleLabel = role === "assistant" ? ("连小理") : "我";
    const agentKey = opts.agent || null;
    if (agentKey && DISC_AGENTS[agentKey]) { cls += " agent-msg"; const a = DISC_AGENTS[agentKey]; roleLabel = a.emoji + " " + a.name; el.dataset.agent = a.key; el.style.setProperty("--agent-color", a.color); }
    el.className = cls;
    el.id = id;
    el.innerHTML = '<div class="msg-role">' + roleLabel + '</div>' +
      '<div class="msg-body">' + msgImgsHtml(opts.images) + renderRich(text || "") + "</div>";
    $("chatLog").appendChild(el);
    $("chatLog").scrollTop = $("chatLog").scrollHeight;
    typeset(el);
    if (opts.save !== false) {
      const s = ensureSession();
      const msg = { role, content: text || "", ts: Date.now(), mid: id };
      if (opts.images && opts.images.length) msg.images = opts.images;
      if (agentKey) msg.agent = agentKey;
      s.messages.push(msg);
      s.updated = Date.now();
      saveChatSessions();
    }
    return id;
  }

  // 把消息映射成发给大模型的多模态格式（含截图则用 image_url）
  function msgToLLM(m) {
    if (m.images && m.images.length) {
      const content = [{ type: "text", text: m.content || "" }];
      m.images.forEach((img) => content.push({ type: "image_url", image_url: { url: img } }));
      return { role: m.role, content };
    }
    return { role: m.role, content: m.content };
  }

  function updateMsg(id, text) {
    const el = $(id);
    if (el) {
      const body = el.querySelector(".msg-body");
      const html = renderRich(text);
      if (body) body.innerHTML = html;
      else {
        const isA = el.className.indexOf("assistant") >= 0;
        el.innerHTML = (isA ? '<div class="msg-role">' + ("连小理") + '</div>' : '<div class="msg-role">我</div>') + '<div class="msg-body">' + html + "</div>";
      }
      $("chatLog").scrollTop = $("chatLog").scrollHeight;
      typeset(el);
    }
    // 持久化：按 mid 找到对应消息并写入真实内容；找不到（如"正在思考…"占位未入库）则补存一条，
    // 确保 AI 回复在任何情况下都不会丢失（刷新 / 切换会话后仍在）
    const s = currentSession();
    if (!s) return;
    const m = s.messages.find((x) => x.mid === id);
    if (m) { m.content = text; m.ts = Date.now(); }
    else     s.messages.push({ role: "assistant", content: text, ts: Date.now(), mid: id });
    saveChatSessions();
  }

  /* ---------- 截图 / 图片上传（比 OCR 更靠谱） ---------- */
  function clearAttachPreview() {
    pendingImages = [];
    const box = $("chatAttach");
    if (box) box.innerHTML = "";
  }

  function addAttachPreview(src) {
    const box = $("chatAttach");
    if (!box) return;
    // 若还没有提示，加一个「按 Enter 发送截图提问」
    if (!box.querySelector(".attach-hint")) {
      const hint = document.createElement("div");
      hint.className = "attach-hint";
      hint.textContent = "按 Enter 直接发送截图提问";
      box.appendChild(hint);
    }
    const item = document.createElement("div");
    item.className = "attach-item";
    const img = document.createElement("img");
    img.className = "attach-thumb";
    img.src = src;
    const x = document.createElement("button");
    x.className = "attach-del";
    x.type = "button";
    x.textContent = "×";
    x.title = "移除这张图";
    x.addEventListener("click", () => {
      pendingImages = pendingImages.filter((s) => s !== src);
      item.remove();
      if (!pendingImages.length) {
        const h = box.querySelector(".attach-hint");
        if (h) h.remove();
      }
    });
    item.appendChild(img);
    item.appendChild(x);
    box.appendChild(item);
    // 自动聚焦输入框，用户可直接按 Enter 发送
    const ta = $("chatInput");
    if (ta) ta.focus();
  }

  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try { resolve(downscaleImage(reader.result, 1000, 0.82)); }
        catch (e) { resolve(reader.result); } // 降级：用原图
      };
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(file);
    });
  }

  // 把图片压到最大边 1000px、JPEG 0.82，显著减小存储体积，避免撑爆 localStorage 配额
  function downscaleImage(dataUrl, maxW, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxW) { height = Math.round(height * maxW / width); width = maxW; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        try { resolve(canvas.toDataURL("image/jpeg", quality)); }
        catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  // 自动把当前 PDF 页渲染成图片，绕过 book-index.json 的 OCR 噪声 / 公式乱码
  // doc 可指定用哪份 PDF（默认课本 pdfDoc；针对考卷答疑时传 examPdfDoc）
  async function renderPdfPageToDataURL(pageNum, maxDim = 1200, quality = 0.85, doc = null) {
    const useDoc = doc || pdfDoc;
    if (!useDoc) return null;
    try {
      pageNum = Math.min(Math.max(1, pageNum), useDoc.numPages);
      const page = await useDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const scale = Math.min(Math.min(maxDim / Math.max(viewport.width, viewport.height), 2), 1.5);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width;
      canvas.height = vp.height;
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      return canvas.toDataURL("image/jpeg", quality);
    } catch (e) {
      console.warn("renderPdfPageToDataURL failed", e);
      return null;
    }
  }

  async function callLLM(messages, cfg) {
    cfg = cfg || chatConfig;
    if (!cfg.key) throw new Error("未配置 API Key");
    const url = (cfg.base || "").replace(/\/+$/, "") + "/chat/completions";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.key },
      body: JSON.stringify({ model: cfg.model || "deepseek-chat", messages: messages, temperature: 0.3 })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error("HTTP " + res.status + "：" + (t || res.statusText).slice(0, 200));
    }
    const data = await res.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  }

  // 全角数字 / 中文数字 → 半角阿拉伯数字（"１２３"→"123"，"二十三"→"23"）
  function normalizeNumStr(s) {
    if (!s) return "";
    s = String(s).replace(/[０-９]/g, (c) => String("０１２３４５６７８９".indexOf(c)));
    const CN = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (/^[零一二两三四五六七八九十]+$/.test(s)) {
      if (/十/.test(s)) {
        const parts = s.split("十");
        const tens = parts[0] === "" ? 1 : (CN[parts[0]] || 0);
        const ones = parts[1] ? (CN[parts[1]] || 0) : 0;
        return String(tens * 10 + ones);
      }
      return String(CN[s] !== undefined ? CN[s] : s);
    }
    return s;
  }
  // 从用户输入解析 P页码 + 题号。兼容：P123 / p123 / Ｐ123 / P 123 / 第123页 / 123页 / 页码123；题号支持 5、５、五、二十五
  function parseTopicRef(text) {
    const t = String(text || "");
    let page = null, number = null, m;
    if ((m = t.match(/[PpＰ]\s*([0-9０-９]+)/))) page = parseInt(normalizeNumStr(m[1]), 10);
    else if ((m = t.match(/第\s*([0-9０-９]+)\s*页/))) page = parseInt(normalizeNumStr(m[1]), 10);
    else if ((m = t.match(/页码\s*[:：]?\s*([0-9０-９]+)/))) page = parseInt(normalizeNumStr(m[1]), 10);
    else if ((m = t.match(/([0-9０-９]+)\s*页/))) page = parseInt(normalizeNumStr(m[1]), 10);
    if ((m = t.match(/第\s*([0-9０-９一二两三四五六七八九十]+)\s*题/))) number = parseInt(normalizeNumStr(m[1]), 10);
    if (page !== null && (!page || isNaN(page) || page <= 0)) page = null;
    if (number !== null && (!number || isNaN(number) || number <= 0)) number = null;
    return { page, number };
  }

  async function sendChat() {
    const text = $("chatInput").value.trim();
    const images = pendingImages.slice();
    if (!text && !images.length) return;
    if (!chatConfig.key) {
      openChatSettings();
      return;
    }
    // 自动：只传截图没打字时，连小理自动按图解题，不需要用户自己写提示词
    const promptText = text || (images.length ? "请根据附图解答这道数学题，给出完整推导过程与关键步骤。" : "");
    $("chatInput").value = "";
    clearAttachPreview();

    // 主题分支：若当前会话已"锁定"了某一 P页码，而新消息指向另一个 P页码，则另开新会话讲另一道题
    const ref = parseTopicRef(text);
    let newPage = ref.page;
    const newNum = ref.number;
    const cur = currentSession();
    if (cur && cur.messages.length && cur.topic && cur.topic.page && newPage && newPage !== cur.topic.page) {
      startNewSession(newPage, newNum, text);
    } else {
      ensureSession();
    }
    const session = currentSession();
    // 兜底定位：用户没打 P页码 时，用当前课本阅读页（"翻到那页问"）；考卷答疑除外（页码在打开考卷时已绑定）
    if (!newPage && !session.examId && pdfDoc && curPage && (!session.topic || !session.topic.page || newNum)) {
      newPage = curPage;
    }
    // 更新会话主题 / 标题
    if (newPage || newNum) {
      session.topic = session.topic || {};
      if (newPage) session.topic.page = newPage;
      if (newNum) session.topic.number = newNum;
      if (!session.topic.question) session.topic.question = text;
    }
    if (!session.title || session.title === "新对话") {
      session.title = deriveTitle(session, text) || (images.length ? "图片提问" : "新对话");
      renderSessions();
    }

    pushMsg("user", promptText, { images: images.length ? images : undefined });

    // 自动：若已载入 PDF，把对应页渲染成图片发给模型，绕过 book-index.json 的 OCR 噪声/公式乱码
    // 针对考卷答疑时，改用当前会话绑定的考卷 PDF（examPdfDoc）而不是课本 pdfDoc
    // v52: 用户本轮已贴截图时不再自动附课本页图——否则模型会把"预置"页图当成用户发的图
    // （用户实测：会话锁到 P1 封面后，每轮都被回复"你发的是课本封面"）。课本上下文改走下方 OCR 文本分支。
    const isExamQa = !!(session.examId && examPdfLoadedId === session.examId);
    // v54: 总结/复盘/分析今日所学类请求——不需要题目页图/OCR，且要注入跨会话档案
    const wantsSummary = SUMMARY_INTENT_RE.test(promptText);
    let pageImage = null;
    const qaDoc = isExamQa ? examPdfDoc : pdfDoc;
    if (session.topic && session.topic.page && qaDoc && !images.length && !wantsSummary) {
      pageImage = await renderPdfPageToDataURL(session.topic.page, 1200, 0.85, qaDoc);
    }

    const bookTitle = (activeBook && activeBook.title) || activeBookId || "当前课本";

    // 研讨模式：4 智能体联动（关闭时走下方单人角色答疑）
    if (discussionMode) {
      await runDiscussion({ session, promptText, images, pageImage, isExamQa, bookTitle, intensity: discIntensity });
      pendingImages = [];
      return;
    }

    // 角色模式：教练模式下用户明确要答案时，本轮回退到讲解员直给答案
    const effectiveRole = (chatRole === "coach" && GIVE_ANSWER_RE.test(text)) ? "lecturer" : chatRole;
    const sysContent = buildRolePrompt(effectiveRole, bookTitle, isExamQa, session.title);
    const hist = [{ role: "system", content: sysContent }];
    // 多模态：把最近会话（含截图）映射成模型可识别的格式
    hist.push(...session.messages.slice(-10).map(msgToLLM));
    // v52: 历史图片瘦身——只保留最后一条（当前）user 消息的图，历史轮次的图替换为占位文本。
    // 否则每轮的截图/课本页图 dataURL 都随历史反复发给模型：视觉 token 爆炸，且模型容易把
    // 旧图（如自动附过的课本封面页）当成"用户这次发的图"。
    for (let i = 0; i < hist.length - 1; i++) {
      const m = hist[i];
      if (!m || !Array.isArray(m.content)) continue;
      if (!m.content.some((c) => c && c.type === "image_url")) continue;
      m.content = m.content.filter((c) => !(c && c.type === "image_url"));
      m.content.push({ type: "text", text: "[此条历史消息附带的截图已省略；请以最新一条消息的附图为准]" });
    }
    // v54: 用户本轮贴了截图时，明确告诉模型以用户截图为准（防止与任何参考材料混淆）
    if (images.length && hist.length && hist[hist.length - 1].role === "user") {
      const last = hist[hist.length - 1];
      if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
      last.content.push({ type: "text", text: "（上面最新附的图是用户刚发的截图，请以此图为准作答；不要把它当成课本/考卷页面。）" });
    }
    // v54: 总结/复盘类请求 → 注入跨会话"今日学习档案"（真实会话记录+进度/错题），模型不得再声称"没有可总结的记录"
    if (wantsSummary) {
      const digest = buildTodayStudyDigest();
      if (digest) hist.splice(Math.max(1, hist.length - 1), 0, { role: "system", content: digest });
    }
    // 有 PDF 页图像时，把它追加到当前 user 消息里；没有图像才退化为 OCR 文本
    if (pageImage && hist.length) {
      const last = hist[hist.length - 1];
      if (last.role === "user") {
        if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
        const focus = session.topic.number ? `请重点回答第 ${session.topic.number} 题。` : "请结合下图回答。";
        const label = isExamQa ? "考卷" : "课本";
        last.content.push({ type: "text", text: `\n\n【${label} P${session.topic.page} 页图像】${focus}` });
        last.content.push({ type: "image_url", image_url: { url: pageImage } });
      }
    } else if (!isExamQa && !wantsSummary && session.topic && session.topic.page && bookIndex && bookIndex.pages) {
      const pg = bookIndex.pages.find((p) => p.page === session.topic.page);
      if (pg) {
        let ctx = `【课本 P${pg.page} 页原文】\n${pg.text}`;
        if (session.topic.number) ctx += `\n\n请重点回答上面第 ${session.topic.number} 题。`;
        hist.push({ role: "system", content: ctx });
      }
    }

    const aid = pushMsg("assistant", "正在思考…", { save: false });
    // 双模型：只要本轮带了图片（截图 or 自动渲染的 PDF 页），且配置了视觉模型，就改用视觉模型；否则用默认文本模型
    const hasImage = images.length > 0 || !!pageImage;
    const useVision = hasImage && chatConfig.visionModel;
    const activeCfg = useVision
      ? { base: chatConfig.visionBase || chatConfig.base, key: chatConfig.visionKey || chatConfig.key, model: chatConfig.visionModel }
      : chatConfig;
    try {
      const ans = await callLLM(hist, activeCfg);
      updateMsg(aid, ans);
      addMsgActions(aid, promptText, ans, images);
      if (useVision) addModelTag(aid, activeCfg.model);
    } catch (e) {
      updateMsg(aid, "⚠️ 调用失败：" + e.message +
        "\n\n常见原因：① 浏览器跨域(CORS)被接口方拦截；② Key/接口/模型填错；③ 当前模型不支持图片（截图问 / P页码 发图需选带视觉能力的模型，如 qwen-vl-max / glm-4v / gpt-4o，可在 ⚙ 设置里单独填「视觉模型」）。\n可换支持浏览器跨域的接口，或用本地代理。");
    }
    pendingImages = [];
  }

  // 研讨模式：多角色联动，但"谁有观点谁发言"，不强制固定轮流
  // v54: 总结/复盘/分析今日所学类请求 → 注入跨会话"今日学习档案"，否则模型只看当前一句话，会瞎说"没有可总结的记录"
  const SUMMARY_INTENT_RE = /(总结|复盘|梳理|汇报|所学|学到|学会了|不足|薄弱|掌握(得|的)?(怎么样|情况|如何)|检查|查漏|今天|今日)/;
  // 本会话此前的对话记录（user + assistant 全保留，不含本轮），供模型联系上下文
  function buildSessionHistoryText(session) {
    const msgs = (session && Array.isArray(session.messages) ? session.messages : []).slice(0, -1);
    if (!msgs.length) return "";
    const lines = msgs.slice(-14).map((m) => {
      const who = m.role === "user" ? "我" : (m.agent ? (DISC_AGENTS[m.agent] ? DISC_AGENTS[m.agent].name : m.agent) : "连小理");
      let t = String(m.content || "").replace(/\s+/g, " ").trim();
      if (!t && m.images && m.images.length) t = "（发了 " + m.images.length + " 张截图）";
      if (t.length > 400) t = t.slice(0, 400) + "…";
      return t ? (who + "：" + t) : "";
    }).filter(Boolean);
    return lines.join("\n");
  }
  // 跨会话"今日学习档案"：今天所有会话的真实提问记录 + 累计进度/错题分布
  function buildTodayStudyDigest() {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const since = d.getTime();
    const sessions = chatSessions.filter((s) => Array.isArray(s.messages) && s.messages.some((m) => (m.ts || 0) >= since));
    const fmt = (ts) => { const x = new Date(ts); const p = (n) => String(n).padStart(2, "0"); return p(x.getHours()) + ":" + p(x.getMinutes()); };
    const lines = [];
    if (sessions.length) {
      lines.push("【今日学习档案（跨会话真实记录；总结/分析必须以这些记录为据，禁止声称没有记录）】");
      sessions.forEach((s, i) => {
        const firstUser = s.messages.find((m) => m.role === "user");
        let q = firstUser ? String(firstUser.content || "").replace(/\s+/g, " ").trim() : "";
        if (q.length > 80) q = q.slice(0, 80) + "…";
        const ts = firstUser && firstUser.ts ? fmt(firstUser.ts) : "?";
        const topic = s.topic && s.topic.page ? ("P" + s.topic.page + (s.topic.number ? " 第" + s.topic.number + "题" : "")) : (s.title || "未定位");
        const bk = s.bookId ? allBooks.find((b) => b.id === s.bookId) : null;
        lines.push((i + 1) + ". " + ts + " 《" + (bk ? bk.title + "·" : "") + topic + "》 提问：" + (q || "（截图提问）"));
      });
    }
    const agg = aggregate(1);
    const statLine = "今日涉及会话 " + sessions.length + " 个；累计已学会 " + agg.learned + "、已掌握 " + agg.mastered + "、错题 " + agg.wrong + "、连续学习 " + agg.streak + " 天。";
    const ths = Object.keys(agg.theoremCount).sort((a, b) => agg.theoremCount[b].count - agg.theoremCount[a].count).slice(0, 5);
    const thLine = ths.length ? ("近期错题集中在：" + ths.map((t) => t + "（" + agg.theoremCount[t].count + "道）").join("、") + "。") : "暂无错题归因记录。";
    if (!lines.length) lines.push("【今日学习档案】今天此前没有答疑会话；" + statLine + thLine);
    else lines.push(statLine, thLine);
    return lines.join("\n");
  }

  async function runDiscussion({ session, promptText, images, pageImage, isExamQa, bookTitle, intensity }) {
    const hasImage = images.length > 0 || !!pageImage;
    const useVision = hasImage && chatConfig.visionModel;
    const cfg = useVision
      ? { base: chatConfig.visionBase || chatConfig.base, key: chatConfig.visionKey || chatConfig.key, model: chatConfig.visionModel }
      : chatConfig;

    // 用户用 @别名 指定只让某个智能体回应（单点追问）
    const aliasM = promptText.match(DISC_AT_RE);
    const targeted = aliasM ? resolveAgentByAlias(aliasM[1]) : null;

    // 本会话已有的研讨记录（上一轮 / 历史），作为接力上下文
    const panel = session.messages.slice(0, -1)
      .filter((m) => m.agent && m.role === "assistant")
      .map((m) => ({ agent: m.agent, content: m.content }));

    // v54: 上下文补全——本会话完整对话记录（此前被整段丢掉，模型只会说"没有先前记录"）+ 总结类请求注入跨会话档案
    const sessionHistory = buildSessionHistoryText(session);
    const studyDigest = SUMMARY_INTENT_RE.test(promptText) ? buildTodayStudyDigest() : "";
    const ctxExtra = { sessionHistory, studyDigest };

    pushNote("🗣 研讨模式：" + (targeted
      ? "你向 " + DISC_AGENTS[targeted].emoji + DISC_AGENTS[targeted].name + " 单点追问"
      : "多角色联动研讨（" + (intensity === "deep" ? "深度" : "轻度") + "）· 谁有观点谁发言，不强制轮流"));

    if (targeted) {
      const followUp = (promptText.replace(DISC_AT_RE, "").trim()) ||
        "（请基于上面的研讨记录，专门就你的角色视角补充，并预判、解答我可能还有的疑问）";
      await runSingleAgent(targeted, { promptText: followUp, panel, bookTitle, hasImage, images, pageImage, isExamQa, cfg, ...ctxExtra });
      return;
    }

    // 主讲员先开（若本会话已有历史则不必重开）
    const needOpening = panel.length === 0;
    if (needOpening) {
      await runSingleAgent("lecturer", { promptText, panel, bookTitle, hasImage, images, pageImage, isExamQa, cfg, isFirst: true, ...ctxExtra });
      pushLast(panel, session);
    }

    // 动态研讨：协调员（轻量 LLM）读研讨记录，决定下一步谁发言——允许质疑官打断、主讲员回应、诊断师随时标记、总结师收尾；部分角色本轮可不出声、同一角色可多次发言
    const maxTurns = intensity === "deep" ? 5 : 3;
    for (let t = 0; t < maxTurns; t++) {
      const decision = await coordinatorDecide({ panel, bookTitle, promptText, intensity, turn: t, maxTurns });
      if (!decision || decision.end) break;
      const speakers = (decision.speakers || []).filter((k) => DISC_AGENTS[k]).slice(0, 2);
      if (!speakers.length) break;
      for (const key of speakers) {
        await runSingleAgent(key, { promptText, panel, bookTitle, hasImage, images, pageImage, isExamQa, cfg, isFirst: false, ...ctxExtra });
        pushLast(panel, session);
      }
    }

    // 收尾：若讨论已展开而总结师尚未提炼，则由其收尾（不抢话、只在阶段末）
    const spokeKeys = panel.map((p) => p.agent);
    if (panel.length > 0 && !spokeKeys.includes("summarist")) {
      pushNote("— 收尾：由总结师提炼本轮要点 —");
      await runSingleAgent("summarist", { promptText, panel, bookTitle, hasImage, images, pageImage, isExamQa, cfg, isFirst: false, ...ctxExtra });
      pushLast(panel, session);
    }
  }

  // 把刚生成的智能体发言（若有且非报错）追加进接力 panel
  function pushLast(panel, session) {
    const last = session.messages[session.messages.length - 1];
    if (last && last.agent && !/^⚠️/.test(last.content || "")) panel.push({ agent: last.agent, content: last.content });
  }

  // 协调员：读研讨记录，决定下一步谁发言 + 是否收尾；返回 {speakers:[key], end:bool}；解析失败走脚本化兜底
  async function coordinatorDecide({ panel, bookTitle, promptText, intensity, turn, maxTurns }) {
    const transcript = panel.map((p) =>
      (DISC_AGENTS[p.agent] ? DISC_AGENTS[p.agent].emoji + " " + DISC_AGENTS[p.agent].name : p.agent) + "：" + p.content
    ).join("\n\n");
    const sys = `你是数学研讨小组的"主持人 / 调度"。小组四位成员：主讲员(lecturer)、质疑官(critic)、诊断师(diagnostic)、总结师(summarist)。当前课本《${bookTitle}》。
你的唯一任务：根据下面研讨记录，决定【下一步谁发言】与【是否该收尾】。你本人不解答题目。
严格遵循"自然研讨"规则：
- 禁止每轮强制四人依次输出，杜绝流水线式轮流。允许某个角色本轮不发言；允许同一角色多次发言（例如质疑官逼问后，主讲员再回应补充推导）。
- 谁有观点、疑问、漏洞就主动发言：质疑官可打断主讲员，针对证明逻辑 / 定理适用前提诘问；主讲员可回应质疑、补充更严谨推导；诊断师随时捕捉思维错误、标记错因到教材定理 / 定义；总结师不要频繁插话，只在讨论到阶段性收尾时提炼，不抢话。
- 每步聚焦 1 个最有价值的发言人（最多 2 个），不要安排特别长的发言序列。
- 当关键疑点已被质疑官点出、主讲员已回应、诊断师已标记错因，且讨论已较充分，就安排总结师收尾（speakers 含 summarist 且 end=true）；若总结师已发过言，直接 end=true。
- 讨论围绕当前题目知识点，不跑题。
只输出一个 JSON 对象，不要任何解释，格式：{"speakers":["角色key"],"end":false,"reason":"简短中文说明"}。角色key 只能取 lecturer/critic/diagnostic/summarist。`;
    const userText = `【用户原始问题】\n${promptText}\n\n【研讨记录（第 ${turn + 1} 步，计划最多 ${maxTurns} 步）】\n${transcript || "（暂无，刚开场，主讲员已发言）"}\n\n请决定下一步谁发言，以及是否收尾。`;
    try {
      const ans = await callLLM([{ role: "system", content: sys }, { role: "user", content: userText }], chatConfig);
      const s = (ans || "").trim();
      const st = s.indexOf("{"); const en = s.lastIndexOf("}");
      if (st >= 0 && en > st) {
        const obj = JSON.parse(s.slice(st, en + 1));
        const speakers = Array.isArray(obj.speakers) ? obj.speakers.map((x) => String(x).toLowerCase()).filter((k) => DISC_AGENTS[k]) : [];
        return { speakers: speakers.slice(0, 2), end: !!obj.end, reason: obj.reason || "" };
      }
    } catch (e) { /* 落到兜底 */ }
    return fallbackSchedule(turn, panel);
  }

  // 协调员解析失败时的脚本化兜底：质疑→主讲回应→诊断→结束（仍非固定四人轮转）
  function fallbackSchedule(turn, panel) {
    const seq = ["critic", "lecturer", "diagnostic"];
    if (turn < seq.length) return { speakers: [seq[turn]], end: false };
    return { speakers: [], end: true };
  }

  // 单个智能体发言：把用户问题 + 本会话历史 + 已有研讨记录拼成上下文，调用一次模型
  async function runSingleAgent(key, { promptText, panel, bookTitle, hasImage, images, pageImage, isExamQa, cfg, isFirst, sessionHistory, studyDigest }) {
    const a = DISC_AGENTS[key];
    let userText;
    if (panel.length === 0) {
      userText = "【用户问题】\n" + promptText;
    } else {
      userText = "【用户原始问题】\n" + promptText + "\n\n【研讨记录（请在已有讨论基础上接力，不要简单重复，重点补充你的角色视角）】\n" +
        panel.map((p) => (DISC_AGENTS[p.agent] ? DISC_AGENTS[p.agent].emoji + " " + DISC_AGENTS[p.agent].name : p.agent) + "：" + p.content).join("\n\n");
    }
    // v54: 本会话此前对话 + 跨会话学习档案（总结/分析类请求必须据此作答，不得声称"没有记录"）
    if (sessionHistory) userText += "\n\n【本会话此前的对话记录（联系上下文用）】\n" + sessionHistory;
    if (studyDigest) userText += "\n\n" + studyDigest;
    const messages = [{ role: "system", content: a.prompt(bookTitle) }];
    messages.push({ role: "user", content: buildUserContent(userText, hasImage, images, pageImage, isExamQa, isFirst) });

    const aid = pushMsg("assistant", a.emoji + " " + a.name + "：正在思考…", { agent: a.key });
    try {
      const ans = await callLLM(messages, cfg);
      updateMsg(aid, ans);
      addNoteBtn(aid, ans, images);
    } catch (e) {
      updateMsg(aid, "⚠️ " + a.name + " 调用失败：" + e.message +
        "\n\n常见原因：① 浏览器跨域(CORS)被接口方拦截；② Key/接口/模型填错；③ 带图但所选视觉模型不支持图片（可在 ⚙ 设置里单独填「视觉模型」）。");
    }
  }

  // 仅首个智能体（主讲员）接收真实图片；其余智能体看文字版研讨记录
  function buildUserContent(text, hasImage, images, pageImage, isExamQa, isFirst) {
    if (isFirst && hasImage) {
      const content = [{ type: "text", text: text }];
      (images || []).forEach((img) => content.push({ type: "image_url", image_url: { url: img } }));
      if (pageImage) {
        const label = isExamQa ? "考卷" : "课本";
        content.push({ type: "text", text: "\n\n【附 " + label + " 页图像，请结合解答】" });
        content.push({ type: "image_url", image_url: { url: pageImage } });
      }
      return content;
    }
    return text;
  }

  function pushNote(text) {
    const log = $("chatLog");
    if (!log) return;
    const e = document.getElementById("chatEmpty");
    if (e) e.remove();
    const el = document.createElement("div");
    el.className = "chat-note";
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function addModelTag(aid, modelName) {
    const el = $(aid);
    if (!el || !modelName) return;
    const tag = document.createElement("div");
    tag.className = "model-tag";
    tag.textContent = "📷 视觉模型：" + modelName;
    el.appendChild(tag);
  }

  function addMsgActions(aid, question, answer, imgs) {
    const el = $(aid);
    if (!el) return;
    const actions = document.createElement("div");
    actions.className = "msg-actions";

    const libBtn = document.createElement("div");
    libBtn.className = "msg-action";
    libBtn.textContent = "＋ 提取题目并存入题库";
    libBtn.addEventListener("click", async () => {
      libBtn.textContent = "正在提取题目…";
      try {
        const saved = await saveChatToLibrary(question, answer);
        if (saved) {
          libBtn.textContent = "✓ 已存入我的题库";
          libBtn.style.color = "var(--green)";
        } else {
          libBtn.textContent = "本轮无可用题目";
          libBtn.style.color = "var(--red)";
        }
      } catch (e) {
        libBtn.textContent = "提取失败";
        libBtn.style.color = "var(--red)";
      }
    });

    const noteBtn = document.createElement("div");
    noteBtn.className = "msg-action";
    noteBtn.textContent = "📝 加入笔记";
    noteBtn.addEventListener("click", () => {
      addAnswerToNote(answer, imgs);
      noteBtn.textContent = "✓ 已加入笔记";
      noteBtn.style.color = "var(--green)";
    });

    actions.appendChild(libBtn);
    actions.appendChild(noteBtn);
    el.appendChild(actions);
  }

  // 给某条消息加一个"加入笔记"按钮（研讨模式下每个智能体的发言都可用，方便存好讲解）
  function addNoteBtn(aid, answer, imgs) {
    const el = $(aid);
    if (!el) return;
    let actions = el.querySelector(".msg-actions");
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "msg-actions";
      el.appendChild(actions);
    }
    const noteBtn = document.createElement("div");
    noteBtn.className = "msg-action";
    noteBtn.textContent = "📝 加入笔记";
    noteBtn.addEventListener("click", () => {
      addAnswerToNote(answer, imgs);
      noteBtn.textContent = "✓ 已加入笔记";
      noteBtn.style.color = "var(--green)";
    });
    actions.appendChild(noteBtn);
  }

  function deriveNoteTitle(text) {
    const line = (text || "").split("\n").map((l) => l.trim()).find((l) => l) || "答疑笔记";
    return line.replace(/[#*`>\-]/g, "").replace(/\s+/g, " ").slice(0, 30) || "答疑笔记";
  }

  function addAnswerToNote(answerText, imgs) {
    const id = "note-" + Date.now();
    const now = new Date().toISOString();
    notesState.notes.unshift({
      id,
      title: deriveNoteTitle(answerText),
      content: answerText || "",
      images: (imgs && imgs.length) ? imgs.slice() : [],
      createdAt: now,
      updatedAt: now
    });
    notesState.activeId = id;
    notesPreviewMode = true;
    saveNotes();
    renderNotes();
    switchTab("notes");
  }

  async function extractProblemFromAnswer(answer) {
    if (!chatConfig.key) return { hasProblem: false };
    const prompt = `你是题库整理助手。请从下面的 AI 辅导回答中提取一道可以存入题库的"题目"（优先提取"举一反三"变式、例题或原题重述；如果没有明确题目，返回空）。

要求：
1. 只输出 JSON，不要任何解释。
2. 输出格式：{"hasProblem": true/false, "question": "题目原文（LaTeX 保留）", "hint": "一句话提示（如果有）", "explanation": "简要解答（如果有）", "page": 页码数字或null, "number": 题号数字或null}
3. 若回答里出现"Pxxx"或"第xx题"，请把 page/number 也解析出来；没有就填 null。

回答内容：
"""${answer.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 2000)}"""`;
    try {
      const res = await callLLM([{ role: "system", content: "你是一名严谨的题库整理助手，只输出合法 JSON。" }, { role: "user", content: prompt }]);
      const m = res.match(/\{[\s\S]*\}/);
      const obj = m ? JSON.parse(m[0]) : null;
      if (obj && obj.hasProblem && obj.question && obj.question.trim()) {
        const pageNum = obj.page ? parseInt(obj.page, 10) : null;
        const numberNum = obj.number ? parseInt(obj.number, 10) : null;
        return {
          hasProblem: true,
          question: obj.question.trim(),
          hint: (obj.hint || "").trim(),
          explanation: (obj.explanation || "").trim(),
          page: isNaN(pageNum) ? null : pageNum,
          number: isNaN(numberNum) ? null : numberNum
        };
      }
    } catch (e) {}
    return { hasProblem: false };
  }

  function isProblemLike(text) {
    if (!text) return false;
    return /[求证证明计算极限导数积分]\s*/.test(text) || /\$/.test(text) || /题/.test(text);
  }

  async function saveChatToLibrary(question, answer) {
    const extracted = await extractProblemFromAnswer(answer);
    const cs0 = currentSession();
    const topic = (cs0 && cs0.topic) || {};
    let saveQuestion, saveExplanation;
    if (extracted.hasProblem) {
      saveQuestion = extracted.question;
      const hint = extracted.hint ? `提示：${extracted.hint}` : "";
      const exp = extracted.explanation || answer;
      saveExplanation = hint ? [hint + "\n\n" + exp] : [exp];
    } else if (topic.question && isProblemLike(topic.question)) {
      saveQuestion = topic.question;
      saveExplanation = [answer];
    } else {
      alert("这轮回答里没有找到可保存的题目。\n\n请让连小理先给出一道完整题目（例如举一反三的变式），或在开头说明「Pxxx 第xx题」。");
      return false;
    }
    const qref = parseTopicRef(question || "");
    let page = topic.page || extracted.page || qref.page;
    let number = topic.number || extracted.number || qref.number;

    // 若定位信息缺失，弹窗让用户补全，避免保存出 Pnull / 第null题
    if (!page || !number) {
      const input = prompt(`保存题目需要定位信息（用于后续按“P页码 第X题”查找）。\n已识别：页码 ${page || "未识别"}，题号 ${number || "未识别"}\n\n请按“页码,题号”补充，例如 127,5（不确定可填 0）：`);
      if (input) {
        const parts = input.split(/[,，]/).map((s) => s.trim());
        if (!page) { const p = parseInt(parts[0], 10); page = isNaN(p) ? null : p; }
        if (!number) { const n = parseInt(parts[1], 10); number = isNaN(n) ? null : n; }
      }
      if ((!page && !number) && !confirm("页码和题号都未确定，确定要保存为未定位题目吗？\n（之后可在详情页删除重存）")) {
        return false;
      }
    }
    let id = (page && number) ? `P${page}-${number}` : (page ? `P${page}-U${Date.now()}` : `U${Date.now()}`);
    const concept = topic.question ? `对话生成（P${page || "?"}` + (number ? ` 第${number}题）` : ` 未编号）`) : "对话生成";
    // 留痕：把保存题目时所在会话的最近对话记录一起存入，用于后续归因
    const chatTrace = (cs0 ? cs0.messages : []).slice(-20).map(({ role, content, agent }) => ({ role, content, agent: agent || null }));
    const existing = userProblems.find((p) => p.id === id && (p.bookId || LEGACY_BOOK_ID) === activeBookId);
    if (existing) {
      if (!confirm(`已存在 ${id}，要覆盖它吗？`)) return false;
      existing.question = saveQuestion;
      existing.explanation = saveExplanation;
      existing.chatTrace = chatTrace;
    } else {
      userProblems.push({
        id, page, number, concept, source: "chat", bookId: activeBookId,
        question: saveQuestion, explanation: saveExplanation, variations: [], easyMistakes: "",
        chatTrace
      });
    }
    localStorage.setItem("user_problems_v1", JSON.stringify(userProblems));
    markSyncDirty();
    renderList();
    renderSummary();
    switchTab("problems");
    openDetail(id);
    return true;
  }

  function deleteUserProblem(id) {
    if (!confirm("确定删除这道题？它会从「我的题库」和错题归因中一并移除，不可恢复。")) return;
    const idx = userProblems.findIndex((p) => p.id === id && (p.bookId || LEGACY_BOOK_ID) === activeBookId);
    if (idx >= 0) userProblems.splice(idx, 1);
    if (progress[pk(id)]) { delete progress[pk(id)]; localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress)); }
    if (attrMap[pk(id)]) { delete attrMap[pk(id)]; localStorage.setItem("user_attr_v1", JSON.stringify(attrMap)); }
    localStorage.setItem("user_problems_v1", JSON.stringify(userProblems));
    renderList();
    renderSummary();
    renderWeak();
    if ($("detailView") && !$("detailView").classList.contains("hidden")) {
      $("detailView").classList.add("hidden");
      $("listView").classList.remove("hidden");
    }
  }

  function openChatSettings() {
    $("cfgBase").value = chatConfig.base || "";
    $("cfgKey").value = chatConfig.key || "";
    $("cfgModel").value = chatConfig.model || "";
    $("cfgVisionBase").value = chatConfig.visionBase || "";
    $("cfgVisionKey").value = chatConfig.visionKey || "";
    $("cfgVisionModel").value = chatConfig.visionModel || "";
    $("chatSettingsModal").classList.remove("hidden");
  }

  /* ---------- 数据备份 / 迁移（导出导入 localStorage + IndexedDB） ---------- */
  function b64FromBuffer(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  function bufferFromB64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  // 把 ArrayBuffer / TypedArray 转成 JSON 安全的 {__bin: base64}
  function serBin(v) {
    if (v instanceof ArrayBuffer) return { __bin: b64FromBuffer(v) };
    if (v && v.buffer instanceof ArrayBuffer) return { __bin: b64FromBuffer(v.buffer) };
    if (Array.isArray(v)) return v.map(serBin);
    if (v && typeof v === "object") { const o = {}; for (const k in v) o[k] = serBin(v[k]); return o; }
    return v;
  }
  function deBin(v) {
    if (v && typeof v === "object" && !Array.isArray(v) && v.__bin) return bufferFromB64(v.__bin);
    if (Array.isArray(v)) return v.map(deBin);
    if (v && typeof v === "object") { const o = {}; for (const k in v) o[k] = deBin(v[k]); return o; }
    return v;
  }
  // 统一 IndexedDB 版本号见文件顶部 IDB_VER（=2）。
  function ensureStoreInUpgrade(db, store) {
    if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: "id" });
  }
  async function idbGetAll(dbName, store) {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(dbName, IDB_VER);
      r.onupgradeneeded = () => ensureStoreInUpgrade(r.result, store);
      r.onsuccess = () => {
        const db = r.result;
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
      const r = indexedDB.open(dbName, IDB_VER);
      r.onupgradeneeded = () => ensureStoreInUpgrade(r.result, store);
      r.onsuccess = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(store)) { resolve(); return; } // 极端情况下 store 仍缺失，直接放弃不抛错
        const tx = db.transaction(store, "readwrite");
        const os = tx.objectStore(store);
        (records || []).forEach((rec) => os.put(rec));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      };
      r.onerror = () => reject(r.error);
    });
  }
  /* 笔记附件二进制：存 IndexedDB，localStorage 只存轻量元数据，根治 >1MB 卡死 */
  const ATT_DB = "study_platform_attachments";
  let attCache = {};          // { [attId]: dataUrl } 内存缓存
  function dataUrlBytes(d) {
    try { return Math.round((d.length - (d.indexOf(",") + 1)) * 3 / 4); } catch (e) { return 0; }
  }
  async function loadAttCache() {
    try {
      const recs = await idbGetAll(ATT_DB, "attachments");
      attCache = {};
      (recs || []).forEach((r) => { if (r && r.id) attCache[r.id] = r.data || ""; });
    } catch (e) { attCache = {}; }
  }
  async function putAttachment(id, data) {
    try { await idbPutAll(ATT_DB, "attachments", [{ id, data }]); attCache[id] = data; }
    catch (e) { console.warn("附件入库失败", e); }
  }
  async function fetchAttachmentData(id) {
    if (attCache[id]) return attCache[id];
    try {
      const recs = await idbGetAll(ATT_DB, "attachments");
      const rec = (recs || []).find((r) => r && r.id === id);
      if (rec) { attCache[id] = rec.data || ""; return attCache[id]; }
    } catch (e) {}
    return "";
  }
  // 同步取值：优先内存缓存，其次 legacy 内联 data（迁移前）
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
      const r = indexedDB.open(ATT_DB, IDB_VER);
      r.onsuccess = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("attachments")) { resolve(); return; }
        const tx = db.transaction("attachments", "readwrite");
        tx.objectStore("attachments").delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      };
      r.onerror = () => resolve();
    });
  }
  // 启动后把仍内联在 localStorage 的附件二进制迁到 IndexedDB
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
            attCache[a.id] = a.data;                              // 进内存缓存
            if (typeof a.size !== "number") a.size = dataUrlBytes(a.data);
            delete a.data;                                       // 从 localStorage 剥离
            changed = true;
          }
        });
      });
    });
    if (changed) {
      const recs = Object.keys(attCache).map((id) => ({ id, data: attCache[id] })).filter((r) => r.data);
      try { await idbPutAll(ATT_DB, "attachments", recs); } catch (e) { console.warn("附件迁移入库失败", e); }
      saveNotes(); // 写入已剥离 data 的轻量元数据
    }
  }
  // 构建完整备份载荷（不触发下载），云同步与"导出为文件"共用
  async function buildBackupPayload() {
    const local = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      local[k] = localStorage.getItem(k);
    }
    const books = await idbGetAll(BOOK_DB, "books");
    const exams = await idbGetAll(EXAM_DB, "exams");
    const attachments = await idbGetAll(ATT_DB, "attachments");
    return {
      _type: "study-platform-backup",
      _version: 1,
      _exportedAt: new Date().toISOString(),
      localStorage: local,
      bookDB: { name: BOOK_DB, store: "books", records: books.map(serBin) },
      examDB: { name: EXAM_DB, store: "exams", records: exams.map(serBin) },
      attachDB: { name: ATT_DB, store: "attachments", records: attachments.map(serBin) },
    };
  }

  async function exportAllData() {
    const payload = await buildBackupPayload();
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "课本学习平台-数据备份-" + payload._exportedAt.slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return payload;
  }
  async function importAllData(payload) {
    if (!payload || payload._type !== "study-platform-backup") throw new Error("文件格式不正确");
    if (payload.localStorage) {
      for (const k in payload.localStorage) localStorage.setItem(k, payload.localStorage[k]);
    }
    if (payload.bookDB && payload.bookDB.records) {
      await idbPutAll(payload.bookDB.name, payload.bookDB.store, payload.bookDB.records.map(deBin));
    }
    if (payload.examDB && payload.examDB.records) {
      await idbPutAll(payload.examDB.name, payload.examDB.store, payload.examDB.records.map(deBin));
    }
    if (payload.attachDB && payload.attachDB.records) {
      await idbPutAll(payload.attachDB.name, payload.attachDB.store, payload.attachDB.records.map(deBin));
    }
  }

  /* ================= 云同步（Plan A：自建同步服务） ================= */
  const SYNC_TOKEN_KEY = "sync_token_v1";
  const SYNC_BASE_KEY = "sync_base_url_v1";
  const SYNC_LAST_KEY = "sync_last_updated_v1";   // 最近一次从服务器见到的 updatedAt
  const SYNC_AUTOSYNC_KEY = "sync_autosync_v1";
  const SYNC_WITHKEY_KEY = "sync_with_key_v1";     // 是否把 API Key 也同步上云（默认 true）

  function getSyncToken() { return (localStorage.getItem(SYNC_TOKEN_KEY) || "").trim(); }
  function getSyncBase() {
    // 返回「根地址」：自动剥掉末尾的 /api/sync 与斜杠，buildSyncURL 再统一拼回，
    // 这样用户填根地址(https://x.localhost.run)或填含 /api/sync 的完整基址都一样可用。
    let b = (localStorage.getItem(SYNC_BASE_KEY) || "").trim();
    if (!b) b = location.origin;
    b = b.replace(/\/api\/sync\/?$/i, "").replace(/\/+$/, "");
    return b;
  }
  function getSyncAuto() { return localStorage.getItem(SYNC_AUTOSYNC_KEY) === "1"; }
  function getSyncWithKey() { return localStorage.getItem(SYNC_WITHKEY_KEY) !== "0"; } // 默认包含

  let syncDirty = false;           // 本地有改动尚未推上云
  let syncTimer = null;
  function markSyncDirty() { syncDirty = true; }

  function buildSyncURL(token) { return getSyncBase() + "/api/sync/" + encodeURIComponent(token); }

  // 把常见同步错误翻译成可操作提示
  function syncErrHint(e, action) {
    const m = (e && e.message) || String(e);
    if (/Failed to fetch|NetworkError|TypeError|load failed/i.test(m)) {
      return action + "失败：无法连接同步服务器。请检查：① 电脑已开机且「课本学习交互平台.lnk」已启动（同步服务器在 8137）；② 隧道窗口(.bat)未关闭；③ 若在 https 网页里填了 http 开头的同步地址，会被浏览器拦截（改成 https 或直接在平板打开隧道网址）；④ 同步服务器地址填对（填根地址即可，如 https://xxxx.localhost.run）。";
    }
    if (/HTTP 404/i.test(m)) return action + "失败：同步服务器返回 404，地址可能填错（应指向带 /api/sync 的同步服务）。";
    if (/HTTP 405/i.test(m)) return action + "失败：该地址不支持同步接口（可能是普通静态服务器），请填真正的同步服务器地址。";
    if (/HTTP 400/i.test(m)) return action + "失败：令牌格式不合法。";
    return action + "失败：" + m;
  }

  async function syncUpload({ force = false } = {}) {
    const token = getSyncToken();
    const st = $("syncStatus");
    if (!token) { if (st) st.textContent = "请先填写并保存同步令牌。"; return; }
    if (location.protocol === "file:") { if (st) st.textContent = "用 file:// 打开无法同步，请用本地服务器或云端网址打开。"; return; }
    try {
      if (st) st.textContent = "正在上传到云…";
      const payload = await buildBackupPayload();
      if (!getSyncWithKey()) { delete payload.localStorage["chat_config_v1"]; }
      const base = force ? "0" : (localStorage.getItem(SYNC_LAST_KEY) || "0");
      const res = await fetch(buildSyncURL(token), {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Base-Updated-At": String(base) },
        body: JSON.stringify(payload),
      });
      if (res.status === 409) {
        const j = await res.json().catch(() => ({ serverUpdatedAt: 0 }));
        if (st) st.textContent = "⚠️ 云端已有更新的数据，请选择：下载覆盖本地，还是强制用本地覆盖云端？";
        await showSyncConflict(j.serverUpdatedAt);
        return;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      localStorage.setItem(SYNC_LAST_KEY, String(j.updatedAt));
      syncDirty = false;
      if (st) st.textContent = "✅ 已上传到云（" + new Date(Number(j.updatedAt)).toLocaleString() + "）。" + (getSyncWithKey() ? "" : "（已按设置排除 API Key）");
      updateSyncMeta();
    } catch (e) {
      if (st) st.textContent = syncErrHint(e, "上传");
    }
  }

  async function syncDownload() {
    const token = getSyncToken();
    const st = $("syncStatus");
    if (!token) { if (st) st.textContent = "请先填写并保存同步令牌。"; return; }
    if (location.protocol === "file:") { if (st) st.textContent = "用 file:// 打开无法同步，请用本地服务器或云端网址打开。"; return; }
    try {
      if (st) st.textContent = "正在从云下载…";
      const res = await fetch(buildSyncURL(token));
      if (res.status === 404) { if (st) st.textContent = "云端还没有该令牌的数据，请先在一台设备上「上传到云」。"; return; }
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      await importAllData(j.data);
      localStorage.setItem(SYNC_LAST_KEY, String(j.updatedAt));
      syncDirty = false;
      if (st) st.textContent = "✅ 已从云下载并合并（" + new Date(Number(j.updatedAt)).toLocaleString() + "），即将刷新…";
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      if (st) st.textContent = syncErrHint(e, "下载");
    }
  }

  // 冲突时让用户二选一
  async function showSyncConflict(serverUpdatedAt) {
    const t = serverUpdatedAt ? new Date(Number(serverUpdatedAt)).toLocaleString() : "未知时间";
    const ok = confirm("云端已有更新的数据（" + t + "）。\n\n点「确定」→ 下载云端覆盖本地；\n点「取消」→ 强制用本地覆盖云端。");
    if (ok) { await syncDownload(); }
    else { await syncUpload({ force: true }); }
  }

  async function updateSyncMeta() {
    const baseEl = $("syncBaseLabel");
    if (baseEl) baseEl.textContent = getSyncBase();
    const token = getSyncToken();
    const st = $("syncStatus");
    if (!token) { if (st) st.textContent = "尚未设置同步令牌。"; return; }
    try {
      const res = await fetch(buildSyncURL(token) + "/meta");
      if (res.status === 404) { if (st) st.textContent = "云端还没有该令牌的数据，上传一次即可创建。"; return; }
      const m = await res.json();
      if (st) st.textContent = "云端最新更新：" + new Date(Number(m.updatedAt)).toLocaleString() + "（" + Math.round(m.size / 1024) + " KB）。";
    } catch (e) {
      if (st) st.textContent = syncErrHint(e, "连接");
    }
  }

  // 自动同步：后台每 90 秒检查；开机自动拉取；冲突不自动覆盖（提示手动）
  async function autoSyncTick() {
    const token = getSyncToken();
    if (!token || !getSyncAuto()) return;
    try {
      const res = await fetch(buildSyncURL(token) + "/meta");
      if (res.status !== 200) return; // 空 -> 暂无可拉取
      const meta = await res.json();
      const last = Number(localStorage.getItem(SYNC_LAST_KEY) || "0");
      const remote = Number(meta.updatedAt);
      if (syncDirty && last && last === remote) {
        await syncUpload();                       // 本地改了、远端没动 -> 安全推送
      } else if (!syncDirty && last && last !== remote) {
        await syncDownload();                     // 远端改了、本地干净 -> 拉取
      } else if (syncDirty && (!last || last !== remote)) {
        const st = $("syncStatus");               // 两边都改了 -> 不自动覆盖，提示手动
        if (st) st.textContent = "⚠️ 云端有他人更新且与本地冲突，请手动点「上传」或「下载」处理。";
      }
    } catch (e) { /* 离线静默 */ }
  }

  function startAutoSync() {
    if (!getSyncAuto()) return;
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(autoSyncTick, 90000);
    autoSyncTick(); // 开机先拉一次
  }

  function stopAutoSync() {
    if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  }

  // 退出前尽力推送一次本地改动（best-effort，可能来不及）
  window.addEventListener("beforeunload", () => {
    if (getSyncAuto() && syncDirty && getSyncToken() && location.protocol !== "file:") {
      try {
        const token = getSyncToken();
        buildBackupPayload().then((payload) => {
          if (!getSyncWithKey()) delete payload.localStorage["chat_config_v1"];
          const base = localStorage.getItem(SYNC_LAST_KEY) || "0";
          fetch(buildSyncURL(token), {
            method: "PUT",
            headers: { "Content-Type": "application/json", "X-Base-Updated-At": String(base) },
            body: JSON.stringify(payload),
            keepalive: true,
          }).catch(() => {});
        }).catch(() => {});
      } catch (e) { /* ignore */ }
    }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) autoSyncTick(); });

  function refreshChatKeyHint() {
    const el = $("chatKeyHint");
    if (!el) return;
    if (chatConfig && chatConfig.key) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    el.innerHTML = "⚠️ 还没填 API Key，点 <b>⚙ 设置</b>（顶栏右上角 ⚙，或本页右上「⚙ 设置」）填入后即可对话。Key 只存在你浏览器本地，不外传。";
  }

  /* ---------- 添加考卷（站内录入考点库） ---------- */
  let pendingExamRaw = "";

  function addPointRow() {
    const wrap = $("pointRows");
    const row = document.createElement("div");
    row.className = "point-row-form";
    row.innerHTML = `
      <div class="pf-line">
        <input class="pf-name cfg-input" placeholder="考点名称" />
        <input class="pf-chapter cfg-input" placeholder="章节" />
        <input class="pf-freq cfg-input" type="number" min="0" placeholder="频次" />
        <button class="pf-del" type="button" title="删除">✕</button>
      </div>
      <textarea class="pf-note cfg-input" rows="1" placeholder="备注/说明（可选，支持 $LaTeX$ / **加粗**）"></textarea>`;
    row.querySelector(".pf-del").addEventListener("click", () => row.remove());
    wrap.appendChild(row);
  }

  function openAddExam() {
    $("examTitle").value = "";
    $("examSummary").value = "";
    $("examPdfFile").value = "";
    $("examPdfInfo").textContent = "";
    $("pointRows").innerHTML = "";
    pendingExamRaw = "";
    pendingExamPdfBuf = null;
    pendingExamPdfMeta = null;
    addPointRow();
    $("addExamModal").classList.remove("hidden");
  }
  function closeAddExam() { $("addExamModal").classList.add("hidden"); }

  async function extractPdfText(file) {
    try { await ensurePdfJs(); } catch (err) { alert("PDF 组件加载失败：" + err.message); return ""; }
    const buf = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = "";
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      const c = await pg.getTextContent();
      text += (c.items.map((it) => it.str || "").join(" ")) + "\n";
    }
    return text;
  }

  async function onExamPdfChange(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try { await ensurePdfJs(); } catch (err) { $("examPdfInfo").textContent = "PDF 组件加载失败，无法处理考卷。"; return; }
    $("examPdfInfo").textContent = "正在载入考卷 PDF…";
    try {
      const buf = await f.arrayBuffer();
      pendingExamPdfBuf = buf;
      pendingExamPdfMeta = { fileName: f.name, pageCount: 0, size: buf.byteLength };
      const doc = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise; // 用副本，避免原 buffer 被 pdf.js detach
      pendingExamPdfMeta.pageCount = doc.numPages;
      let txt = "";
      for (let i = 1; i <= doc.numPages; i++) {
        const pg = await doc.getPage(i);
        const c = await pg.getTextContent();
        txt += (c.items.map((it) => it.str || "").join(" ")) + "\n";
      }
      if (txt.length > 30000) txt = txt.slice(0, 30000);
      pendingExamRaw = txt;
      $("examPdfInfo").textContent = `已载入考卷 PDF（${doc.numPages} 页），详情页将以原图展示并支持答疑；另已提取原文 ${txt.length} 字作为备用。`;
    } catch (err) {
      $("examPdfInfo").textContent = "处理失败：" + err.message;
      pendingExamPdfBuf = null;
      pendingExamRaw = "";
    }
  }

  function saveExam() {
    const title = $("examTitle").value.trim();
    if (!title) { alert("请填写考卷标题"); return; }
    const summary = $("examSummary").value.trim();
    const points = [];
    $("pointRows").querySelectorAll(".point-row-form").forEach((row) => {
      const name = row.querySelector(".pf-name").value.trim();
      const chapter = row.querySelector(".pf-chapter").value.trim();
      const freq = parseInt(row.querySelector(".pf-freq").value, 10) || 0;
      const note = row.querySelector(".pf-note").value.trim();
      if (name || chapter || note) points.push({ name, chapter, freq, note });
    });
    const rec = {
      id: "exam-" + Date.now(), title, summary, points,
      rawText: pendingExamRaw || "", source: "user", createdAt: Date.now(),
      hasPdf: !!pendingExamPdfBuf, pageCount: (pendingExamPdfMeta && pendingExamPdfMeta.pageCount) || 0,
      bookId: activeBookId
    };
    if (pendingExamPdfBuf) {
      // PDF 本体存 IndexedDB（本机持久、不上传）；localStorage 只留元数据 hasPdf
      saveExamPdf({
        id: rec.id, title, pdf: pendingExamPdfBuf,
        pageCount: rec.pageCount,
        fileName: (pendingExamPdfMeta && pendingExamPdfMeta.fileName) || "",
        bookId: activeBookId
      }).catch((err) => console.warn("保存考卷 PDF 失败", err));
    }
    userExamsForBook().push(rec);
    saveUserExams();
    closeAddExam();
    renderExamList();
  }

  /* ---------- 薄弱点图谱（错题 → 定理/定义 归因） ---------- */
  function renderWeak() {
    renderWeakStats();
    renderTree();
    renderRedo();
    const box = $("weakList");
    if (!box) return;
    const items = allProblems().filter((p) => statusOf(p) === "wrong");
    if ($("weakCount")) $("weakCount").textContent = `共 ${items.length} 道错题归因`;
    const groups = {};
    items.forEach((p) => {
      const a = getAttr(p.id);
      const key = (a && a.pointId && a.chapterId && a.sectionId) ? pointLabel(a.chapterId, a.sectionId, a.pointId)
        : ((a && a.theorem) ? a.theorem : "（未关联知识点）");
      if (!groups[key]) groups[key] = { pointKey: (a && a.pointId) ? (a.chapterId + ":" + a.sectionId + ":" + a.pointId) : "", chapter: (a && a.chapter) || "", note: (a && a.note) || "", items: [] };
      groups[key].items.push(p);
    });
    const keys = Object.keys(groups).sort((a, b) => groups[b].items.length - groups[a].items.length);
    const max = keys.length ? groups[keys[0]].items.length : 1;
    if (!keys.length) {
      box.innerHTML = `<div class="empty"><div class="big">🧭</div>
        <p>还没有错题归因。</p>
        <p>在「题解」里打开一道题 → 点「✗ 加入错题」→ 选错误类型与知识点，<br/>这里就会长出你的个人薄弱点图谱与重做回路。</p></div>`;
      return;
    }
    const agg = pointAgg();
    box.innerHTML = keys.map((k) => {
      const g = groups[k];
      const pct = Math.max(6, Math.round(g.items.length / max * 100));
      const m = g.pointKey ? masteryOf(agg[g.pointKey]) : 50;
      return `<div class="weak-card">
        <div class="weak-top"><span class="weak-theorem">${escapeHtml(k)}</span><span class="weak-count">${g.items.length} 道</span></div>
        ${g.chapter ? `<div class="weak-chapter">📍 ${escapeHtml(g.chapter)}</div>` : ""}
        <div class="freq-bar"><div class="freq-fill" style="width:${pct}%;background:${masteryColor(m)}"></div></div>
        <div class="weak-mastery">掌握度 <b style="color:${masteryColor(m)}">${m}%</b> · ${masteryText(m)}</div>
        ${g.note ? `<div class="weak-note">${escapeHtml(g.note)}</div>` : ""}
        <div class="weak-items">${g.items.map((p) => `<span class="weak-item" data-id="${p.id}" title="点击查看 P${p.page} 第${p.number}题">P${p.page}·第${p.number}题</span>`).join("")}</div>
      </div>`;
    }).join("");
    box.querySelectorAll(".weak-item").forEach((el) => el.addEventListener("click", () => { switchTab("problems"); openDetail(el.dataset.id); }));
  }

  function renderWeakStats() {
    const box = $("weakStats"); if (!box) return;
    const t = bookTree();
    let points = 0; t.chapters.forEach((c) => c.sections.forEach((s) => points += s.points.length));
    const agg = pointAgg();
    const keys = Object.keys(agg);
    let weak = 0, sum = 0, due = 0; const now = Date.now();
    keys.forEach((k) => { const m = masteryOf(agg[k]); sum += m; if (m < 40) weak++; });
    const rm = bookRedo();
    Object.values(rm).forEach((r) => { if ((r.status === "pending" || r.status === "due") && r.due <= now) due++; });
    const avg = keys.length ? Math.round(sum / keys.length) : 0;
    box.innerHTML =
      `<div class="stat"><div class="stat-n">${points}</div><div class="stat-l">知识点</div></div>` +
      `<div class="stat"><div class="stat-n" style="color:var(--red)">${weak}</div><div class="stat-l">薄弱点(&lt;40%)</div></div>` +
      `<div class="stat"><div class="stat-n" style="color:${masteryColor(avg)}">${avg}%</div><div class="stat-l">平均掌握度</div></div>` +
      `<div class="stat"><div class="stat-n" style="color:var(--amber)">${due}</div><div class="stat-l">待重做</div></div>`;
  }

  function renderTree() {
    const box = $("treeBox"); if (!box) return;
    const t = bookTree();
    const agg = pointAgg();
    if (!t.chapters.length) {
      box.innerHTML = `<div class="empty small">还没有教材树。<br/>点上方「＋ 添加章」手动建，或「📥 从考点表导入」一键生成。</div>`;
      return;
    }
    box.innerHTML = t.chapters.map((c) => {
      const secs = c.sections.map((s) => {
        const pts = s.points.map((p) => {
          const k = c.id + ":" + s.id + ":" + p.id;
          const m = masteryOf(agg[k]);
          return `<div class="tp">
            <span class="tp-dot" style="background:${masteryColor(m)}" title="掌握度 ${m}%"></span>
            <span class="tp-title">${escapeHtml(p.title)}</span>
            <span class="tp-m">${agg[k] ? agg[k].wrong : 0}错</span>
            <button class="tp-del" data-c="${c.id}" data-s="${s.id}" data-k="${k}" data-kind="point" title="删除知识点">×</button>
          </div>`;
        }).join("");
        return `<div class="ts">
          <div class="ts-head"><span class="ts-title">${escapeHtml(s.title)}</span>
            <button class="ts-add" data-c="${c.id}" data-s="${s.id}">＋知识点</button>
            <button class="tp-del" data-c="${c.id}" data-s="${s.id}" data-kind="section" title="删除节">×</button></div>
          <div class="ts-points">${pts || '<span class="muted">（无知识点，点＋添加）</span>'}</div>
        </div>`;
      }).join("");
      return `<div class="tc">
        <div class="tc-head"><span class="tc-title">📖 ${escapeHtml(c.title)}</span>
          <button class="ts-add" data-c="${c.id}">＋节</button>
          <button class="tp-del" data-c="${c.id}" data-kind="chapter" title="删除章">×</button></div>
        <div class="tc-secs">${secs}</div>
      </div>`;
    }).join("");
    box.querySelectorAll(".tp-del").forEach((el) => el.addEventListener("click", (e) => { e.stopPropagation(); deleteTreeNode(el.dataset); }));
    box.querySelectorAll(".ts-add").forEach((el) => el.addEventListener("click", (e) => { e.stopPropagation(); addTreeNode(el.dataset); }));
  }

  function addTreeNode(d) {
    const t = bookTree();
    const c = t.chapters.find((x) => x.id === d.c); if (!c) return;
    if (d.s) {
      const s = c.sections.find((x) => x.id === d.s); if (!s) return;
      const title = prompt("新知识点标题"); if (!title) return;
      s.points.push({ id: uid("p_"), title: title.trim(), desc: "" });
    } else {
      const title = prompt("新节标题"); if (!title) return;
      c.sections.push({ id: uid("s_"), title: title.trim(), points: [] });
    }
    saveTree(); renderWeak();
  }
  function deleteTreeNode(d) {
    const t = bookTree();
    if (d.kind === "chapter") { t.chapters = t.chapters.filter((x) => x.id !== d.c); }
    else if (d.kind === "section") { const c = t.chapters.find((x) => x.id === d.c); if (c) c.sections = c.sections.filter((x) => x.id !== d.s); }
    else if (d.kind === "point") {
      const c = t.chapters.find((x) => x.id === d.c); const s = c && c.sections.find((x) => x.id === d.s);
      if (s) s.points = s.points.filter((x) => { return (c.id + ":" + s.id + ":" + x.id) !== d.k; });
    }
    saveTree(); renderWeak();
  }
  function seedTreeFromExams() {
    if (!exams || !exams.length) { alert("当前书没有考点表（exam-points）可导入。请手动添加，或先载入含考点的书。"); return; }
    const t = bookTree();
    if (t.chapters.length && !confirm("将把考点表合并进现有教材树（同名章会追加知识点，不覆盖）。继续？")) return;
    const byCh = {};
    exams.forEach((e) => (e.points || []).forEach((pt) => { const ch = pt.chapter || "未分类"; (byCh[ch] = byCh[ch] || []).push(pt.name); }));
    Object.keys(byCh).forEach((ch) => {
      let c = t.chapters.find((x) => x.title === ch);
      if (!c) { c = { id: uid("c_"), title: ch, sections: [] }; t.chapters.push(c); }
      let s = c.sections.find((x) => x.title === "本节知识点");
      if (!s) { s = { id: uid("s_"), title: "本节知识点", points: [] }; c.sections.push(s); }
      byCh[ch].forEach((name) => { if (name && !s.points.some((p) => p.title === name)) s.points.push({ id: uid("p_"), title: name, desc: "" }); });
    });
    saveTree(); renderWeak();
    alert("已从考点表导入 " + Object.keys(byCh).length + " 个章节的知识点。");
  }

  function exportAttribution(format) {
    const items = allProblems().filter((p) => statusOf(p) === "wrong");
    const rows = items.map((p) => {
      const a = getAttr(p.id) || {};
      const et = (a.type && ERR_TYPES.find((t) => t.key === a.type)) || null;
      return {
        题号: p.id, 页码: p.page, 题序: p.number,
        题目: (p.question || "").replace(/\s+/g, " ").slice(0, 80),
        错误类型: et ? et.label : "", 知识点: (a.pointId && a.chapterId && a.sectionId) ? pointLabel(a.chapterId, a.sectionId, a.pointId) : (a.theorem || ""),
        章节: a.chapter || "", 错因: a.note || ""
      };
    });
    if (!rows.length) { alert("还没有可导出的错题归因。"); return; }
    if (format === "json") {
      const t = bookTree();
      const agg = pointAgg();
      const treeExport = { tree: t, metrics: Object.keys(agg).map((k) => ({ key: k, mastery: masteryOf(agg[k]), stat: agg[k] })), redo: bookRedo() };
      downloadBlob("错题归因+图谱.json", JSON.stringify({ attribution: rows, graph: treeExport }, null, 2), "application/json");
    } else if (format === "csv") {
      const header = ["题号", "页码", "题目", "错误类型", "知识点", "章节", "错因"];
      const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
      const csv = "﻿" + [header.join(",")].concat(rows.map((r) => [r.题号, r.页码, esc(r.题目), esc(r.错误类型), esc(r.知识点), esc(r.章节), esc(r.错因)].join(","))).join("\n");
      downloadBlob("错题归因表.csv", csv, "text/csv;charset=utf-8");
    } else if (format === "md") {
      downloadBlob("薄弱点报告.md", buildAttrReportMd(rows), "text/markdown;charset=utf-8");
    }
  }
  function buildAttrReportMd(rows) {
    const agg = pointAgg();
    const t = bookTree();
    let points = 0; t.chapters.forEach((c) => c.sections.forEach((s) => points += s.points.length));
    let weak = 0, sum = 0; const keys = Object.keys(agg);
    keys.forEach((k) => { const m = masteryOf(agg[k]); sum += m; if (m < 40) weak++; });
    const avg = keys.length ? Math.round(sum / keys.length) : 0;
    const L = [];
    L.push("# 错题归因与薄弱点报告");
    L.push("");
    L.push("- 生成时间：" + new Date().toLocaleString("zh-CN"));
    L.push("- 课本：" + ((activeBook && activeBook.title) || activeBookId));
    L.push("");
    L.push("## 一、总体指标");
    L.push("");
    L.push("| 指标 | 数值 |");
    L.push("| --- | --- |");
    L.push("| 知识点总数 | " + points + " |");
    L.push("| 薄弱点(<40%) | " + weak + " |");
    L.push("| 平均掌握度 | " + avg + "% |");
    L.push("| 错题归因数 | " + rows.length + " |");
    L.push("");
    L.push("## 二、薄弱知识点排行（掌握度 < 70%）");
    L.push("");
    const ranked = keys.map((k) => ({ k, m: masteryOf(agg[k]), s: agg[k], label: (function () { const [c, s, p] = k.split(":"); return pointLabel(c, s, p); })() }))
      .filter((x) => x.m < 70).sort((a, b) => a.m - b.m);
    if (!ranked.length) L.push("_暂无薄弱知识点，继续保持！_");
    else { ranked.forEach((x) => L.push("- **" + x.label + "** — 掌握度 " + x.m + "%（错 " + x.s.wrong + " 次）")); }
    L.push("");
    L.push("## 三、逐题归因明细");
    L.push("");
    L.push("| 题号 | 错误类型 | 知识点 | 错因 |");
    L.push("| --- | --- | --- | --- |");
    rows.forEach((r) => L.push("| " + r.题号 + " | " + (r.错误类型 || "—") + " | " + (r.知识点 || "—") + " | " + (r.错因 || "—") + " |"));
    L.push("");
    L.push("## 四、建议");
    L.push("");
    L.push("1. 优先重做掌握度最低的知识点（见上文排行），用「重做回路」的「✓ 我会了 / ✗ 还不会」巩固。");
    L.push("2. 对反复出错的题型，回到对应教材定理/定义，结合「研讨模式」让 4 智能体重新拆解。");
    L.push("3. 每周回顾本报告，观察平均掌握度是否上升。");
    return L.join("\n");
  }
  function renderRedo() {
    const box = $("redoBox"); if (!box) return;
    const rm = bookRedo();
    const ids = Object.keys(rm);
    if (!ids.length) { box.innerHTML = `<div class="empty small">还没有待重做的题。<br/>在归因时选好知识点，会自动进入重做回路。</div>`; return; }
    const now = Date.now();
    const agg = pointAgg();
    box.innerHTML = ids.map((pid) => {
      const r = rm[pid];
      const p = allProblems().find((x) => x.id === pid);
      const ptLabel = r.pointKey ? pointLabel.apply(null, r.pointKey.split(":")) : "（未关联知识点）";
      const due = r.due <= now;
      const m = r.pointKey ? masteryOf(agg[r.pointKey]) : 0;
      const variantHtml = r.variant ? `<div class="redo-variant">${escapeHtml(r.variant)}</div>` : "";
      return `<div class="redo-item${due ? " due" : ""}">
        <div class="redo-top"><span class="redo-id">${p ? ("P" + p.page + "·第" + p.number + "题") : pid}</span><span class="redo-m" style="color:${masteryColor(m)}">掌握 ${m}%</span></div>
        <div class="redo-pt">🎯 ${escapeHtml(ptLabel)}</div>
        <div class="redo-meta">已练 ${r.attempts} 次 · 通过 ${r.pass} · 失败 ${r.fail} · ${due ? "<b style='color:var(--red)'>到期可重做</b>" : "未到期"}</div>
        ${variantHtml}
        <div class="redo-actions">
          <button class="redo-pass" data-id="${pid}">✓ 我会了</button>
          <button class="redo-fail" data-id="${pid}">✗ 还不会</button>
          <select class="redo-diff" data-id="${pid}" title="选择举一反三变式难度">
            <option value="basic">基础变式</option>
            <option value="advanced">进阶变式</option>
            <option value="challenge">挑战变式</option>
          </select>
          <button class="redo-ai" data-id="${pid}">🤖 AI 出变式</button>
        </div>
      </div>`;
    }).join("");
    box.querySelectorAll(".redo-pass").forEach((el) => el.addEventListener("click", () => redoPass(el.dataset.id)));
    box.querySelectorAll(".redo-fail").forEach((el) => el.addEventListener("click", () => redoFail(el.dataset.id)));
    box.querySelectorAll(".redo-ai").forEach((el) => el.addEventListener("click", () => {
      const sel = box.querySelector('.redo-diff[data-id="' + el.dataset.id + '"]');
      redoGenerateVariant(el.dataset.id, el, sel ? sel.value : "basic");
    }));
  }
  function redoPass(id) { const rm = bookRedo(); const r = rm[id]; if (!r) return; r.pass++; r.attempts++; r.status = "done"; r.last = "pass"; r.due = Date.now() + 7 * 864e5; saveRedo(); renderWeak(); }
  function redoFail(id) { const rm = bookRedo(); const r = rm[id]; if (!r) return; r.fail++; r.attempts++; r.status = "pending"; r.last = "fail"; r.due = Date.now() + 864e5; saveRedo(); renderWeak(); }
  async function redoGenerateVariant(id, btn, difficulty) {
    if (!chatConfig.key) { openChatSettings(); return; }
    const p = allProblems().find((x) => x.id === id); if (!p) return;
    const diffLabel = { basic: "基础变式", advanced: "进阶变式", challenge: "挑战变式" }[difficulty] || "基础变式";
    const old = btn.textContent; btn.textContent = "生成中…"; btn.disabled = true;
    try {
      const q = Array.isArray(p.question) ? p.question.join("\n") : (p.question || p.concept || "");
      const sys = buildBookRolePrompt("examiner", (activeBook && activeBook.title) || activeBookId);
      const userc = `请针对下面这道题，专门出 1 道【${diffLabel}】难度的举一反三变式题。\n要求：① 禁止只替换数字、保留相同证明框架；② 按"改变前提条件 / 转换命题形式 / 提升综合度"之一改编；③ 附【出题说明】（改动点 + 考察新能力）；④ 只给题目不给答案。\n\n原题：\n${q}`;
      const ans = await callLLM([{ role: "system", content: sys }, { role: "user", content: userc }]);
      const rm = bookRedo(); if (rm[id]) { rm[id].variant = ans; saveRedo(); }
      renderRedo();
    } catch (e) {
      btn.textContent = "生成失败"; setTimeout(() => renderRedo(), 1500);
    }
  }
  /* ---------- 每日一题（按薄弱点 / 旧错题自动出题） ---------- */
  const DAILY_QUIZ_KEY = "daily_quiz_v1";
  const DAILY_API = "/api/daily_quiz";   // 仅本地服务器(http://127.0.0.1:8137)有效；云端/file 打开时静默回退到 localStorage
  // 本地服务器会把该端点收到的 JSON 落盘到 study-platform/daily_quiz.json，供课表挂件轮询联动
  const DAILY_FILE = "daily_quiz.json";

  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function loadDailyQuizLocal() {
    try { return JSON.parse(localStorage.getItem(DAILY_QUIZ_KEY)) || null; }
    catch (e) { return null; }
  }
  function saveDailyQuizLocal(q) {
    try { localStorage.setItem(DAILY_QUIZ_KEY, JSON.stringify(q)); } catch (e) {}
    markSyncDirty();
  }
  async function pushDailyToFile(q) {
    try { await fetch(DAILY_API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(q) }); }
    catch (e) { /* 非本地服务器环境：仅 localStorage，仅影响课表挂件联动，不报错 */ }
  }
  function findProblemAnywhere(id) {
    let p = problems.find((x) => x.id === id);
    if (p) return p;
    return userProblems.find((x) => x.id === id) || null;
  }
  function pointLabelFor(bookId, chapterId, sectionId, pointId) {
    const tree = studyTree[bookId]; if (!tree) return "";
    const c = tree.chapters.find((x) => x.id === chapterId); if (!c) return "";
    const se = c.sections.find((x) => x.id === sectionId); if (!se) return c.title;
    const pt = se.points.find((x) => x.id === pointId); if (!pt) return c.title + " / " + se.title;
    return c.title + " / " + se.title + " / " + pt.title;
  }
  // 跨所有书挑「已到期待重做」的旧错题（优先每日一题来源）
  function pickDueRedo() {
    const now = Date.now();
    let best = null;
    Object.keys(redoMap).forEach((bid) => {
      const rm = redoMap[bid] || {};
      Object.keys(rm).forEach((pid) => {
        const r = rm[pid]; if (!r) return;
        const isDue = (r.status === "due") || (r.due && r.due <= now);
        if (!isDue) return;
        const overdue = r.due ? (now - r.due) : 0;
        if (!best || overdue > best.overdue) best = { bookId: bid, problemId: pid, record: r, overdue: overdue };
      });
    });
    return best;
  }
  // 跨所有书聚合薄弱点，返回掌握度最低(<40)的知识点
  function weakestPointAllBooks() {
    let worst = null;
    const bookIds = new Set();
    Object.keys(studyTree).forEach((b) => bookIds.add(b));
    Object.keys(redoMap).forEach((b) => bookIds.add(b));
    Object.keys(attrMap).forEach((k) => { if (attrMap[k] && attrMap[k].bookId) bookIds.add(attrMap[k].bookId); });
    Object.keys(progress).forEach((k) => bookIds.add(k.split(":")[0]));
    bookIds.forEach((bid) => {
      const tree = studyTree[bid];
      if (!tree || !tree.chapters || !tree.chapters.length) return;
      const valid = new Set();
      tree.chapters.forEach((c) => c.sections.forEach((s) => s.points.forEach((pt) => valid.add(c.id + ":" + s.id + ":" + pt.id))));
      const agg = {};
      const inc = (k, f) => { if (!agg[k]) agg[k] = { wrong: 0, attrs: 0, pass: 0, fail: 0 }; agg[k][f]++; };
      Object.keys(attrMap).forEach((pid) => {
        const a = attrMap[pid];
        if (a && a.bookId === bid && a.pointId && a.sectionId && a.chapterId) {
          const k = a.chapterId + ":" + a.sectionId + ":" + a.pointId;
          if (valid.has(k)) { inc(k, "wrong"); inc(k, "attrs"); }
        }
      });
      const rm = redoMap[bid] || {};
      Object.keys(rm).forEach((pid) => {
        const r = rm[pid];
        if (r && r.pointKey && valid.has(r.pointKey)) {
          if (!agg[r.pointKey]) agg[r.pointKey] = { wrong: 0, attrs: 0, pass: 0, fail: 0 };
          agg[r.pointKey].pass += (r.pass || 0);
          agg[r.pointKey].fail += (r.fail || 0);
        }
      });
      Object.keys(agg).forEach((k) => {
        const m = masteryOf(agg[k]);
        if (m < 40 && (!worst || m < worst.mastery)) {
          const parts = k.split(":");
          worst = { bookId: bid, pointKey: k, chapterId: parts[0], sectionId: parts[1], pointId: parts[2], mastery: m };
        }
      });
    });
    return worst;
  }
  async function generateDailyVariant(bookId, weak) {
    const book = (typeof allBooks !== "undefined") ? allBooks.find((b) => b.id === bookId) : null;
    const bookTitle = book ? book.title : (bookId === LEGACY_BOOK_ID ? "数学分析" : (bookId || "当前课本"));
    const label = pointLabelFor(bookId, weak.chapterId, weak.sectionId, weak.pointId);
    const sys = buildBookRolePrompt("examiner", bookTitle);
    const userc = `请针对下面这个薄弱知识点，出 **1 道**「每日一题」练习题。
知识点：${label}（当前课本《${bookTitle}》）
要求：
① 题目要能真正检验该知识点，禁止只替换数字、保留相同证明框架；
② 难度选【基础】即可，贴近课本、便于日常巩固；
③ 附【出题说明】：相比课本典型题改动了什么、考察的新能力是什么；
④ 只给题目与出题说明，先不要给答案；
⑤ 用 LaTeX（行内 $...$ 独立 $$...$$）。`;
    return await callLLM([{ role: "system", content: sys }, { role: "user", content: userc }]);
  }
  async function ensureDailyQuiz(force) {
    const today = todayStr();
    let q = loadDailyQuizLocal();
    if (q && q.date === today && !force) { renderDailyIfOpen(); updateDailyBadge(); return q; }
    // 1) 旧错题重做优先
    const due = pickDueRedo();
    if (due) {
      const p = findProblemAnywhere(due.problemId);
      const qtext = p ? (Array.isArray(p.question) ? p.question.join("\n") : (p.question || p.concept || "")) : "";
      q = {
        date: today, type: "redo", sourceId: due.problemId, bookId: due.bookId,
        question: qtext || ("重做题：" + due.problemId),
        difficulty: null, pointLabel: "", status: "pending", done: false, createdAt: Date.now()
      };
    } else {
      // 2) 无则针对最薄弱知识点 AI 出一道变式
      const weak = weakestPointAllBooks();
      if (!weak) {
        q = {
          date: today, type: "rest", sourceId: null, bookId: null,
          question: "今天暂时没有待重做的错题，也没有需要专门巩固的薄弱点。🎉 保持节奏，随时回来看题或问连小理！",
          difficulty: null, pointLabel: "", status: "done", done: true, createdAt: Date.now()
        };
      } else {
        try {
          const v = await generateDailyVariant(weak.bookId, weak);
          q = {
            date: today, type: "variant", sourceId: null, bookId: weak.bookId,
            question: v, difficulty: "basic",
            pointLabel: pointLabelFor(weak.bookId, weak.chapterId, weak.sectionId, weak.pointId),
            status: "pending", done: false, createdAt: Date.now()
          };
        } catch (e) {
          q = {
            date: today, type: "variant", sourceId: null, bookId: weak.bookId,
            question: "（自动出题暂失败：" + (e && e.message ? e.message : e) + "）建议今天复习这个薄弱点：" + pointLabelFor(weak.bookId, weak.chapterId, weak.sectionId, weak.pointId),
            difficulty: null,
            pointLabel: pointLabelFor(weak.bookId, weak.chapterId, weak.sectionId, weak.pointId),
            status: "pending", done: false, createdAt: Date.now()
          };
        }
      }
    }
    saveDailyQuizLocal(q);
    await pushDailyToFile(q);
    renderDailyIfOpen();
    updateDailyBadge();
    return q;
  }
  function updateDailyBadge() {
    const tab = $("tabDaily"); if (!tab) return;
    const q = loadDailyQuizLocal();
    const pending = q && q.date === todayStr() && !q.done;
    let dot = tab.querySelector(".tab-dot");
    if (pending) {
      if (!dot) { dot = document.createElement("span"); dot.className = "tab-dot"; tab.appendChild(dot); }
    } else if (dot) dot.remove();
  }
  function renderDaily() {
    const v = $("dailyView"); if (!v) return;
    const card = $("dailyCard"); if (!card) return;
    const q = loadDailyQuizLocal();
    const today = todayStr();
    if (!q || q.date !== today) {
      card.innerHTML = `<div class="empty"><div class="big">📅</div>
        <p>今天还没有生成「每日一题」。</p>
        <p class="muted">连小理会依据你的薄弱点 / 待重做错题自动出题，可在本标签页等待自动生成，或点下面手动生成。</p>
        <button class="primary" id="dailyGen">✨ 生成今日一题</button></div>`;
      const b = $("dailyGen"); if (b) b.addEventListener("click", () => ensureDailyQuiz(true));
      updateDailyBadge();
      return;
    }
    const tagClass = q.type === "redo" ? "wrong" : (q.type === "variant" ? "mastered" : "unstudied");
    const tagText = q.type === "redo" ? "旧错题重做" : (q.type === "variant" ? "薄弱点变式" : "今日无待巩固");
    let head = `<div class="daily-head"><span class="daily-date">${q.date}</span><span class="badge ${tagClass}">${tagText}</span></div>`;
    if (q.pointLabel) head += `<div class="daily-point">🎯 薄弱点：${escapeHtml(q.pointLabel)}</div>`;
    let body = `<div class="daily-q" id="dailyQ"></div>`;
    let actions = "";
    if (q.done) {
      if (q.type === "rest") {
        body += `<div class="daily-done ok">🎉 今天没有待巩固的错题 / 薄弱点，已自动打卡！保持节奏，随时回来看题或问连小理。</div>`;
        actions = `<div class="daily-actions">
          <button class="daily-ghost" id="dailyRegen">🔄 换一道</button>
        </div>`;
      } else {
        const ok = q.result === "done";
        body += `<div class="daily-done ${ok ? "ok" : "struggle"}">${ok ? "✅ 今日已打卡：你会了这道题！" : "📌 已记录：今天先放一放，建议去「薄弱点」复盘。"}</div>`;
        actions = `<div class="daily-actions">
          <button class="daily-ghost" id="dailyRegen">🔄 换一道</button>
        </div>`;
      }
    } else {
      actions = `<div class="daily-actions">
        <button class="redo-pass" id="dailyDone">✓ 我会了</button>
        <button class="redo-fail" id="dailyStruggle">✗ 还不会</button>
        <button class="daily-ghost" id="dailyHint">💡 要点提示</button>
        <button class="daily-ghost" id="dailyRegen">🔄 换一道</button>
        ${q.type === "redo" && q.sourceId ? '<button class="daily-ghost" id="dailyGoto">📖 看原题</button>' : ""}
      </div>`;
    }
    card.innerHTML = head + body + actions + `<div class="daily-hint" id="dailyHintBox" style="display:none"></div>`;
    const qEl = $("dailyQ");
    if (qEl) { qEl.innerHTML = renderMarkdown(q.question); typeset(qEl); }
    if (q.done) return;
    const done = $("dailyDone"); if (done) done.addEventListener("click", dailyMarkDone);
    const struggle = $("dailyStruggle"); if (struggle) struggle.addEventListener("click", dailyMarkStruggle);
    const hint = $("dailyHint"); if (hint) hint.addEventListener("click", dailyHint);
    const regen = $("dailyRegen"); if (regen) regen.addEventListener("click", () => ensureDailyQuiz(true));
    const goto = $("dailyGoto"); if (goto) goto.addEventListener("click", () => {
      if (q.bookId && q.bookId !== activeBookId) { localStorage.setItem(ACTIVE_BOOK_KEY, q.bookId); /* 切书后定位 */ }
      switchTab("problems"); openDetail(q.sourceId);
    });
  }
  function renderDailyIfOpen() {
    const v = $("dailyView"); if (v && !v.classList.contains("hidden")) renderDaily();
  }
  function dailySaveAndRender(q) { saveDailyQuizLocal(q); pushDailyToFile(q); renderDaily(); updateDailyBadge(); }
  function dailyMarkDone() {
    const q = loadDailyQuizLocal(); if (!q) return;
    q.done = true; q.status = "done"; q.result = "done"; dailySaveAndRender(q);
  }
  function dailyMarkStruggle() {
    const q = loadDailyQuizLocal(); if (!q) return;
    q.done = true; q.status = "done"; q.result = "struggle";
    if (q.type === "redo" && q.sourceId && redoMap[q.bookId] && redoMap[q.bookId][q.sourceId]) {
      const r = redoMap[q.bookId][q.sourceId];
      r.fail = (r.fail || 0) + 1; r.attempts = (r.attempts || 0) + 1; r.last = "fail";
      r.status = "pending"; r.due = Date.now() + 864e5; saveRedo();
      if (q.bookId === activeBookId) renderWeak();
    }
    dailySaveAndRender(q);
  }
  async function dailyHint() {
    const q = loadDailyQuizLocal(); if (!q) return;
    const box = $("dailyHintBox"); if (!box) return;
    if (!chatConfig.key) { box.style.display = "block"; box.innerHTML = "⚠️ 先到右上 ⚙ 设置里填好 API Key 才能生成提示。"; return; }
    box.style.display = "block"; box.innerHTML = "生成提示中…";
    try {
      const bookTitle = (typeof allBooks !== "undefined" && q.bookId) ? (allBooks.find((b) => b.id === q.bookId) || {}).title || "" : "";
      const sys = buildBookRolePrompt("coach", bookTitle || (activeBook && activeBook.title) || activeBookId);
      const ans = await callLLM([{ role: "system", content: sys }, { role: "user", content: "下面这道题我不会，请只给我 1-2 句**要点提示**（点出关键思路/定理，不要给完整解答）：\n" + q.question }]);
      box.innerHTML = renderMarkdown(ans); typeset(box);
    } catch (e) {
      box.innerHTML = "提示生成失败：" + (e && e.message ? e.message : e);
    }
  }
  // 后台定时：启动即补生成；每分钟检查（6:00–23:00 窗口）是否当天缺失
  function startDailyTimer() {
    ensureDailyQuiz();
    setInterval(() => {
      const h = new Date().getHours();
      if (h >= 6 && h <= 23) {
        const q = loadDailyQuizLocal();
        if (!q || q.date !== todayStr()) ensureDailyQuiz();
      }
    }, 60 * 1000);
  }

  function downloadBlob(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  // v51: 公式内换行保护。模型常输出跨行显示公式（\[...\] / $$...$$，如 pmatrix 矩阵），
  // 若直接被 \n→<br> 或按行拆 <p> 拆到不同文本节点，tex2svgPromise 无法整体匹配会裸显。
  // 把公式区块内部的 \n 临时换成私有占位符，渲染/拆分完成后再还原为 \n。
  const MATH_NL = "";
  function protectMathNewlines(s) {
    if (!s) return s;
    return s
      .replace(/\$\$([\s\S]+?)\$\$/g, (m) => m.replace(/\n/g, MATH_NL))
      .replace(/\\\[([\s\S]+?)\\\]/g, (m) => m.replace(/\n/g, MATH_NL))
      .replace(/\$(?!\$)([^$\n]+?)\$(?!\$)/g, (m) => m.replace(/\n/g, MATH_NL))
      .replace(/\\\(([\s\S]+?)\\\)/g, (m) => m.replace(/\n/g, MATH_NL));
  }
  function restoreMathNewlines(s) {
    return s ? s.split(MATH_NL).join("\n") : s;
  }

  /* ---------- 上课笔记（按科目/书本隔离） ---------- */
  const NOTES_KEY = "study_notes_v1";
  let notesMap = {}; // { [bookId]: { notes:[...], activeId } }
  let notesState = { notes: [], activeId: null };
  let notesPreviewMode = false;

  // 取当前科目(书本)的笔记切片，缺失则建空对象
  function bookNotes() {
    if (!notesMap[activeBookId]) notesMap[activeBookId] = { notes: [], activeId: null };
    return notesMap[activeBookId];
  }
  function normalizeNote(n) {
    if (!n || typeof n !== "object") return;
    if (!n.id) n.id = "note-" + Math.random().toString(36).slice(2);
    if (typeof n.title !== "string") n.title = "";
    if (typeof n.content !== "string") n.content = "";
    if (!Array.isArray(n.attachments)) {
      if (Array.isArray(n.images)) {
        // 旧版：image dataURL 数组 → 统一为 attachments
        n.attachments = n.images.map((d) => ({ kind: "image", name: "", type: "image/*", data: d }));
      } else {
        n.attachments = [];
      }
      n.images = []; // 已并入 attachments，清空避免重复占用存储
    }
    if (!Array.isArray(n.images)) n.images = [];
    // 给每个附件补齐稳定 id（迁移到 IndexedDB 后用它做主键）
    (n.attachments || []).forEach((a) => {
      if (!a.id) a.id = "att-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    });
  }
  function loadNotes() {
    try {
      const raw = localStorage.getItem(NOTES_KEY);
      if (raw) notesMap = JSON.parse(raw);
    } catch (e) { notesMap = {}; }
    if (!notesMap || typeof notesMap !== "object" || Array.isArray(notesMap)) notesMap = {};
    // 兼容旧版扁平结构 {notes:[...], activeId}：整体迁入当前科目
    if (Array.isArray(notesMap.notes)) {
      const legacy = notesMap;
      notesMap = {};
      notesMap[activeBookId] = legacy;
    }
    // 统一每张笔记的附件结构（旧 image 数组 → attachments）
    Object.keys(notesMap).forEach((bid) => {
      const slice = notesMap[bid];
      if (slice && Array.isArray(slice.notes)) slice.notes.forEach(normalizeNote);
    });
    notesState = bookNotes();
  }
  function saveNotes() {
    notesMap[activeBookId] = notesState;
    try {
      localStorage.setItem(NOTES_KEY, JSON.stringify(notesMap));
    } catch (e) {
      alert("笔记保存失败，可能是图片太多导致浏览器存储满了。建议导出备份后减少图片。");
    }
    markSyncDirty();
  }
  // 切换科目后，把 notesState 重新指向当前科目的切片
  function reloadBookNotes() {
    notesState = bookNotes();
    notesPreviewMode = false;
  }
  function formatNoteTime(iso) {
    try { return new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch (e) { return iso; }
  }
  function createNote() {
    const id = "note-" + Date.now();
    const now = new Date().toISOString();
    notesState.notes.unshift({ id, title: "", content: "", images: [], attachments: [], createdAt: now, updatedAt: now });
    notesState.activeId = id;
    notesPreviewMode = false;
    saveNotes();
    renderNotes();
    setTimeout(() => { const el = $("noteTitle"); if (el) el.focus(); }, 0);
  }
  function deleteNote() {
    const id = notesState.activeId;
    if (!id) return;
    if (!confirm("确定删除这条笔记吗？（含图片）")) return;
    notesState.notes = notesState.notes.filter((n) => n.id !== id);
    notesState.activeId = notesState.notes[0] ? notesState.notes[0].id : null;
    saveNotes();
    renderNotes();
  }
  function activeNote() {
    return notesState.notes.find((n) => n.id === notesState.activeId) || null;
  }
  function updateActiveNoteFromDOM() {
    const note = activeNote();
    if (!note) return;
    const titleEl = $("noteTitle");
    const contentEl = $("noteContent");
    note.title = (titleEl && titleEl.value || "").trim();
    note.content = (contentEl && contentEl.value || "").trim();
    note.updatedAt = new Date().toISOString();
    saveNotes();
  }
  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  function compressImage(dataUrl, maxSide = 1200, quality = 0.85) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let w = img.width, h = img.height;
        if (w > maxSide || h > maxSide) {
          if (w > h) { h = Math.round(h * maxSide / w); w = maxSide; }
          else { w = Math.round(w * maxSide / h); h = maxSide; }
        }
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }
  async function addAttachmentsToActiveNote(files) {
    const note = activeNote();
    if (!note) return;
    for (const file of files) {
      try {
        const dataUrl = await readFileAsDataURL(file);
        const id = "att-" + Date.now().toString(36) + Math.random().toString(36).slice(2);
        let kind;
        if (file.type.startsWith("image/")) kind = "image";
        else if (file.type === "application/pdf") kind = "pdf";
        else kind = "file";
        // localStorage 只存轻量元数据；二进制 dataUrl 存入 IndexedDB（按 id 定位）
        const att = { id, kind, name: file.name || "附件", type: file.type || "", size: dataUrlBytes(dataUrl) };
        note.attachments.push(att);
        attCache[id] = dataUrl;            // 进内存缓存，渲染立即可用
        await putAttachment(id, dataUrl);  // 二进制落 IndexedDB，根治 >1MB 卡死
      } catch (e) { /* ignore single failure */ }
    }
    note.updatedAt = new Date().toISOString();
    saveNotes();
    renderNoteAttachments();
    renderNotesList();
  }
  async function removeAttachment(idx) {
    const note = activeNote();
    if (!note) return;
    const att = note.attachments[idx];
    if (att && att.id) {
      delete attCache[att.id];           // 清内存缓存
      await deleteAttachment(att.id);    // 清 IndexedDB 二进制
    }
    note.attachments.splice(idx, 1);
    note.updatedAt = new Date().toISOString();
    saveNotes();
    renderNoteAttachments();
  }
  function renderNotePreviewHtml(text) {
    const paras = (text || "").split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p);
    if (!paras.length) return '<p class="muted">（暂无内容，点「编辑」输入）</p>';
    return paras.map((p) => {
      let s = escapeHtml(p);
      s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
      s = s.replace(/\n/g, "<br>");
      return `<p>${s}</p>`;
    }).join("");
  }
  function renderNotePreview() {
    const box = $("notePreview");
    const note = activeNote();
    if (!box) return;
    box.innerHTML = renderNotePreviewHtml(note ? note.content : "");
    typeset(box);
  }
  function setNoteMode(mode) {
    notesPreviewMode = mode === "preview";
    const editBtn = $("noteEditBtn");
    const previewBtn = $("notePreviewBtn");
    const ta = $("noteContent");
    const pv = $("notePreview");
    if (editBtn) editBtn.classList.toggle("active", !notesPreviewMode);
    if (previewBtn) previewBtn.classList.toggle("active", notesPreviewMode);
    if (ta) ta.classList.toggle("hidden", notesPreviewMode);
    if (pv) {
      pv.classList.toggle("hidden", !notesPreviewMode);
      if (notesPreviewMode) renderNotePreview();
    }
  }
  function renderNotesSubject() {
    const el = $("notesSubject");
    if (!el) return;
    const t = (activeBook && activeBook.title) || activeBookId || "当前课本";
    const n = (notesState.notes || []).length;
    el.textContent = "📘 " + t + " · " + n + " 条";
  }
  function renderNotes() {
    renderNotesList();
    renderNoteEditor();
    renderNotesSubject();
  }
  function renderNotesList() {
    const box = $("notesList");
    if (!box) return;
    const term = (($("notesSearch") && $("notesSearch").value) || "").trim().toLowerCase();
    let list = notesState.notes;
    if (term) {
      list = list.filter((n) =>
        (n.title || "").toLowerCase().includes(term) ||
        (n.content || "").toLowerCase().includes(term) ||
        (n.attachments || []).some((a) => (a.name || "").toLowerCase().includes(term))
      );
    }
    if (!list.length) {
      box.innerHTML = term
        ? '<div class="notes-empty">没有匹配的笔记。</div>'
        : '<div class="notes-empty">还没有笔记，点右上角「＋ 新建」开始记录。</div>';
      return;
    }
    box.innerHTML = list.map((n) => {
      const active = n.id === notesState.activeId;
      const title = escapeHtml(n.title || "未命名笔记");
      const atts = (n.attachments || []).length;
      const attLabel = atts ? " · " + atts + " 附件" : "";
      return `<div class="notes-item ${active ? "active" : ""}" data-id="${n.id}">
        <div class="notes-item-title">${title}</div>
        <div class="notes-item-meta">${formatNoteTime(n.updatedAt)}${attLabel}</div>
      </div>`;
    }).join("");
    box.querySelectorAll(".notes-item").forEach((el) => {
      el.addEventListener("click", () => {
        notesState.activeId = el.dataset.id;
        renderNotes();
      });
    });
    typeset(box);
  }
  function renderNoteEditor() {
    const note = activeNote();
    const titleEl = $("noteTitle");
    const contentEl = $("noteContent");
    const deleteBtn = $("deleteNoteBtn");
    const saveBtn = $("saveNoteBtn");
    const addImgBtn = $("addNoteImageBtn");
    if (!titleEl) return;
    if (!note) {
      titleEl.value = "";
      contentEl.value = "";
      if (titleEl) titleEl.disabled = true;
      if (contentEl) contentEl.disabled = true;
      if (deleteBtn) deleteBtn.disabled = true;
      if (saveBtn) saveBtn.disabled = true;
      if (addImgBtn) addImgBtn.disabled = true;
      $("noteImages").innerHTML = "";
      return;
    }
    titleEl.disabled = false;
    contentEl.disabled = false;
    deleteBtn.disabled = false;
    saveBtn.disabled = false;
    addImgBtn.disabled = false;
    titleEl.value = note.title || "";
    contentEl.value = note.content || "";
    renderNoteAttachments();
    setNoteMode(notesPreviewMode ? "preview" : "edit");
  }
  function attIcon(kind) { return kind === "pdf" ? "📄" : (kind === "image" ? "🖼️" : "📎"); }
  function formatSize(dataUrl) {
    try {
      const b = Math.round((dataUrl.length - (dataUrl.indexOf(",") + 1)) * 3 / 4);
      if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
      if (b >= 1024) return (b / 1024).toFixed(0) + " KB";
      return b + " B";
    } catch (e) { return ""; }
  }
  function formatSizeBytes(b) {
    if (typeof b !== "number" || b <= 0) return "";
    if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
    if (b >= 1024) return (b / 1024).toFixed(0) + " KB";
    return b + " B";
  }
  function renderNoteAttachments() {
    const note = activeNote();
    const box = $("noteImages");
    if (!box) return;
    const atts = (note && note.attachments) || [];
    if (!atts.length) {
      box.innerHTML = '<p class="muted" style="font-size:12px;margin:0">暂无附件，可点「📎 添加附件」或粘贴图片（老师 PPT / PDF / 板书截图都可）。</p>';
      return;
    }
    box.innerHTML = atts.map((a, idx) => {
      if (a.kind === "image") {
        return `<div class="att-thumb" data-idx="${idx}" title="点击放大">
          <img data-attid="${escapeHtml(a.id || "")}" src="" class="att-img" alt="附件" />
          <button class="note-img-del" data-idx="${idx}" title="删除" type="button">×</button>
        </div>`;
      }
      return `<div class="att-file" data-idx="${idx}" title="点击放大查看">
        <span class="att-icon">${attIcon(a.kind)}</span>
        <span class="att-meta"><span class="att-name">${escapeHtml(a.name || "附件")}</span><span class="att-size">${formatSizeBytes(a.size)}</span></span>
        <button class="note-img-del" data-idx="${idx}" title="删除" type="button">×</button>
      </div>`;
    }).join("");
    // 图片二进制在 IndexedDB，按 id 取缓存/异步回填，避免一次性把所有大图塞进 localStorage
    atts.forEach((a, idx) => {
      if (a.kind !== "image") return;
      const el = box.querySelector('.att-thumb[data-idx="' + idx + '"] .att-img');
      if (!el) return;
      const data = getAttachmentData(a);
      if (data) { el.src = data; }
      else if (a.id) { fetchAttachmentData(a.id).then((d) => { if (d) el.src = d; }); }
    });
    box.querySelectorAll(".att-thumb, .att-file").forEach((el) => {
      el.addEventListener("click", () => openLightbox(parseInt(el.dataset.idx, 10)));
    });
    box.querySelectorAll(".note-img-del").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        removeAttachment(parseInt(btn.dataset.idx, 10));
      });
    });
  }

  /* ---------- 附件全屏放大查看（支持滚轮缩放 / 拖拽平移） ---------- */
  let lbScale = 1, lbTx = 0, lbTy = 0, lbDragging = false, lbLastX = 0, lbLastY = 0;
  function lbApply() {
    const img = $("lbImg");
    if (img && !img.classList.contains("hidden")) {
      img.style.transform = `translate(${lbTx}px, ${lbTy}px) scale(${lbScale})`;
    }
    const z = $("lbZoom"); if (z) z.textContent = Math.round(lbScale * 100) + "%";
  }
  async function openLightbox(idx) {
    const note = activeNote();
    if (!note || !note.attachments || !note.attachments[idx]) return;
    const a = note.attachments[idx];
    const img = $("lbImg"), frame = $("lbFrame"), msg = $("lbMsg"), nameEl = $("lbName"), dl = $("lbDownload");
    lbScale = 1; lbTx = 0; lbTy = 0;
    if (nameEl) nameEl.textContent = a.name || (a.kind === "image" ? "图片" : "附件");
    img.classList.add("hidden"); frame.classList.add("hidden"); msg.classList.add("hidden");
    frame.removeAttribute("src");
    const data = await getAttachmentDataAsync(a);
    if (a.kind === "image") {
      img.src = data; img.classList.remove("hidden");
    } else if (a.kind === "pdf") {
      frame.src = data; frame.classList.remove("hidden");
    } else {
      msg.innerHTML = "此文件类型（" + escapeHtml(a.type || "未知") + "）无法在平台内直接预览。<br/>请点右上「⬇ 下载」保存到本机后用对应软件打开。";
      msg.classList.remove("hidden");
    }
    if (dl) { dl.href = data; dl.setAttribute("download", a.name || "attachment"); }
    lbApply();
    const lb = $("noteLightbox"); if (lb) lb.classList.remove("hidden");
  }
  function closeLightbox() {
    const lb = $("noteLightbox"); if (lb) lb.classList.add("hidden");
    const frame = $("lbFrame"); if (frame) frame.removeAttribute("src");
  }
  function lbZoomBy(f) { lbScale = Math.max(0.2, Math.min(8, lbScale * f)); lbApply(); }
  function lbBind() {
    const stage = $("lbStage");
    if (!stage) return;
    stage.addEventListener("wheel", (e) => { e.preventDefault(); lbZoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    stage.addEventListener("pointerdown", (e) => { lbDragging = true; lbLastX = e.clientX; lbLastY = e.clientY; try { stage.setPointerCapture(e.pointerId); } catch (_) {} });
    stage.addEventListener("pointermove", (e) => {
      if (!lbDragging) return;
      lbTx += e.clientX - lbLastX; lbTy += e.clientY - lbLastY;
      lbLastX = e.clientX; lbLastY = e.clientY; lbApply();
    });
    stage.addEventListener("pointerup", (e) => { lbDragging = false; try { stage.releasePointerCapture(e.pointerId); } catch (_) {} });
    stage.addEventListener("dblclick", () => { const fit = lbScale > 1.5 ? 1 : 2; lbScale = fit; lbTx = 0; lbTy = 0; lbApply(); });
    const lb = $("noteLightbox");
    if (lb) lb.addEventListener("click", (e) => { if (e.target === lb) closeLightbox(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && lb && !lb.classList.contains("hidden")) closeLightbox(); });
    on("lbClose", "click", closeLightbox);
    on("lbZoomIn", "click", () => lbZoomBy(1.2));
    on("lbZoomOut", "click", () => lbZoomBy(1 / 1.2));
    on("lbFit", "click", () => { lbScale = 1; lbTx = 0; lbTy = 0; lbApply(); });
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    on("tabProblems", "click", () => switchTab("problems"));
    on("tabExams", "click", () => switchTab("exams"));
    on("tabWeak", "click", () => switchTab("weak"));
    on("tabChat", "click", () => switchTab("chat"));
    on("tabReport", "click", () => switchTab("report"));
    on("tabNotes", "click", () => switchTab("notes"));
    on("tabDaily", "click", () => switchTab("daily"));
    on("genReportBtn", "click", generateWeeklyReport);
    on("exportReportBtn", "click", exportReport);

    /* 上课笔记 */
    on("newNoteBtn", "click", createNote);
    on("saveNoteBtn", "click", updateActiveNoteFromDOM);
    on("deleteNoteBtn", "click", deleteNote);
    on("noteEditBtn", "click", () => setNoteMode("edit"));
    on("notePreviewBtn", "click", () => { updateActiveNoteFromDOM(); setNoteMode("preview"); });
    on("addNoteImageBtn", "click", () => { const input = $("noteImageInput"); if (input) input.click(); });
    on("noteImageInput", "change", async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length) await addAttachmentsToActiveNote(files);
      e.target.value = "";
    });
    const notesView = $("notesView");
    if (notesView) {
      notesView.addEventListener("paste", async (e) => {
        if (!activeNote()) return;
        const items = Array.from(e.clipboardData.items || []);
        const files = items.filter((it) => it.kind === "file" && it.type.startsWith("image/")).map((it) => it.getAsFile()).filter(Boolean);
        if (files.length) {
          e.preventDefault();
          await addAttachmentsToActiveNote(files);
        }
      });
    }
    on("notesSearch", "input", renderNotesList);
    lbBind();

    on("searchBtn", "click", doSearch);
    on("searchInput", "keydown", (e) => { if (e.key === "Enter") doSearch(); });
    on("backBtn", "click", () => {
      const dv = $("detailView"); if (dv) dv.classList.add("hidden");
      const lv = $("listView"); if (lv) lv.classList.remove("hidden");
      renderList();
    });
    document.querySelectorAll(".chip").forEach((c) => {
      c.addEventListener("click", () => {
        document.querySelectorAll(".chip").forEach((x) => x.classList.remove("active"));
        c.classList.add("active");
        curFilter = c.dataset.filter;
        renderList();
      });
    });

    on("loadPdfBtn", "click", () => { const pf = $("pdfFile"); if (pf) pf.click(); });
    on("pdfFile", "change", (e) => {
      const f = e.target.files[0];
      if (f) f.arrayBuffer().then(loadPdfArrayBuffer);
    });
    const drop = $("pdfDrop");
    if (drop) {
      drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.style.outline = "2px dashed var(--brand)"; });
      drop.addEventListener("dragleave", () => { drop.style.outline = "none"; });
      drop.addEventListener("drop", (e) => {
        e.preventDefault(); drop.style.outline = "none";
        const f = e.dataTransfer.files[0];
        if (f && f.type === "application/pdf") f.arrayBuffer().then(loadPdfArrayBuffer);
      });
    }

    /* 添加书籍（上传 PDF → IndexedDB） */
    on("addBookBtn", "click", () => { const m = $("addBookModal"); if (m) m.classList.remove("hidden"); });
    on("closeAddBook", "click", () => { const m = $("addBookModal"); if (m) m.classList.add("hidden"); });
    on("addBookFile", "change", (e) => {
      const f = e.target.files[0];
      const info = $("addBookInfo"); if (info) info.textContent = f ? ("已选：" + f.name + "（" + (f.size / 1048576).toFixed(1) + " MB）") : "";
    });
    on("saveAddBook", "click", async () => {
      const titleEl = $("addBookTitle"); const fileEl = $("addBookFile");
      const title = titleEl ? titleEl.value.trim() : "";
      const f = fileEl ? fileEl.files[0] : null;
      if (!f) { alert("请先选择一本 PDF"); return; }
      const id = "ub_" + Date.now();
      const buf = await f.arrayBuffer();
      const bookTitle = title || f.name.replace(/\.pdf$/i, "");
      try {
        await saveUserBook({ id, title: bookTitle, pdf: buf, color: "#16a34a" });
      } catch (e) { alert("保存到本机失败：" + e.message); return; }
      if (titleEl) titleEl.value = "";
      if (fileEl) fileEl.value = "";
      const info = $("addBookInfo"); if (info) info.textContent = "";
      const m = $("addBookModal"); if (m) m.classList.add("hidden");
      await loadBookManifest();
      const nb = allBooks.find((b) => b.id === id);
      if (nb) {
        localStorage.setItem(ACTIVE_BOOK_KEY, id);
        await loadBook(nb);
        await autoLoadBook(nb);
        populateBookSelect(allBooks);
        refreshBookViews();
      }
    });

    on("prevPage", "click", () => gotoPage(curPage - 1));
    on("nextPage", "click", () => gotoPage(curPage + 1));
    /* 跳到指定页码：输入后按回车（或失焦）跳转 */
    const jpi = $("jumpPageInput");
    if (jpi) {
      const doJump = () => {
        const n = parseInt(jpi.value, 10);
        if (pdfDoc && n >= 1 && n <= pdfDoc.numPages) { gotoPage(n); jpi.value = ""; }
        else if (pdfDoc) { jpi.value = ""; }
      };
      jpi.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doJump(); } });
      jpi.addEventListener("blur", doJump);
    }

    on("helpBtn", "click", () => { const m = $("helpModal"); if (m) m.classList.remove("hidden"); });
    on("closeHelp", "click", () => { const m = $("helpModal"); if (m) m.classList.add("hidden"); });

    on("chatSend", "click", sendChat);
    on("chatInput", "keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
    /* 截图 / 图片上传：比 OCR 更靠谱 */
    on("chatAttachBtn", "click", () => { const fi = $("chatFileInput"); if (fi) fi.click(); });
    on("chatFileInput", "change", async (e) => {
      const files = Array.from(e.target.files || []);
      for (const f of files) {
        if (!f.type.startsWith("image/")) continue;
        try { const src = await readImageFile(f); pendingImages.push(src); addAttachPreview(src); } catch (err) {}
      }
      e.target.value = "";
    });
    on("chatInput", "paste", async (e) => {
      const items = Array.from((e.clipboardData || {}).items || []);
      for (const it of items) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) { try { const src = await readImageFile(f); pendingImages.push(src); addAttachPreview(src); } catch (err) {} }
        }
      }
    });
    on("chatSettingsBtn", "click", openChatSettings);
    on("chatClear", "click", () => {
      const s = currentSession();
      if (!s || !s.messages.length) { renderCurrentSession(); return; }
      if (!confirm("清空当前这轮对话？该会话的问答记录会被删除（其他会话不受影响）。")) return;
      s.messages = [];
      s.topic = null;
      s.title = "新对话";
      saveChatSessions();
      clearAttachPreview();
      renderCurrentSession();
      renderSessions();
    });
    on("newChatBtn", "click", newBlankSession);
    on("topSettingsBtn", "click", openChatSettings);
    on("chatKeyHint", "click", openChatSettings);
    /* 数据备份 / 迁移弹窗 */
    on("dataBtn", "click", () => { const m = $("dataModal"); if (m) m.classList.remove("hidden"); });
    on("closeData", "click", () => { const m = $("dataModal"); if (m) m.classList.add("hidden"); });
    on("exportDataBtn", "click", async () => {
      const st = $("dataStatus");
      try {
        if (st) st.textContent = "正在导出…";
        const p = await exportAllData();
        if (st) st.textContent = "已导出 " + Object.keys(p.localStorage).length + " 项本地数据 + " + p.bookDB.records.length + " 本书 + " + p.examDB.records.length + " 份考卷 + " + p.attachDB.records.length + " 个附件。导入到另一个网址即可恢复。";
      } catch (e) { if (st) st.textContent = "导出失败：" + e.message; }
    });
    on("importDataBtn", "click", () => { const f = $("importDataFile"); if (f) f.click(); });
    on("importDataFile", "change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const st = $("dataStatus");
      try {
        if (st) st.textContent = "正在导入…";
        const payload = JSON.parse(await file.text());
        await importAllData(payload);
        if (st) st.textContent = "导入完成，即将刷新页面以加载数据…";
        setTimeout(() => location.reload(), 600);
      } catch (err) {
        if (st) st.textContent = "导入失败：" + err.message;
      }
      e.target.value = "";
    });

    /* ---- 云同步面板（v55） ---- */
    on("saveSyncToken", "click", () => {
      const v = ($("syncToken").value || "").trim();
      if (!v) { if ($("syncStatus")) $("syncStatus").textContent = "令牌不能为空。"; return; }
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(v)) { if ($("syncStatus")) $("syncStatus").textContent = "令牌需 4-64 位字母/数字/下划线/连字符。"; return; }
      localStorage.setItem(SYNC_TOKEN_KEY, v);
      if ($("syncBase").value.trim()) localStorage.setItem(SYNC_BASE_KEY, $("syncBase").value.trim().replace(/\/+$/, ""));
      else localStorage.removeItem(SYNC_BASE_KEY);
      localStorage.setItem(SYNC_WITHKEY_KEY, $("syncWithKey").checked ? "1" : "0");
      localStorage.setItem(SYNC_AUTOSYNC_KEY, $("syncAuto").checked ? "1" : "0");
      if ($("syncStatus")) $("syncStatus").textContent = "已保存同步令牌。";
      updateSyncMeta();
      if ($("syncAuto").checked) startAutoSync(); else stopAutoSync();
    });
    on("saveSyncBase", "click", () => {
      const b = ($("syncBase").value || "").trim().replace(/\/+$/, "");
      if (b) localStorage.setItem(SYNC_BASE_KEY, b); else localStorage.removeItem(SYNC_BASE_KEY);
      if ($("syncStatus")) $("syncStatus").textContent = b ? ("已保存同步服务器地址：" + b) : "已恢复为当前网址 /api/sync。";
      updateSyncMeta();
    });
    on("syncWithKey", "change", () => { localStorage.setItem(SYNC_WITHKEY_KEY, $("syncWithKey").checked ? "1" : "0"); });
    on("syncAuto", "change", () => {
      localStorage.setItem(SYNC_AUTOSYNC_KEY, $("syncAuto").checked ? "1" : "0");
      if ($("syncAuto").checked) startAutoSync(); else stopAutoSync();
    });
    on("syncUploadBtn", "click", () => syncUpload());
    on("syncDownloadBtn", "click", () => syncDownload());
    on("closeCfg", "click", () => { const m = $("chatSettingsModal"); if (m) m.classList.add("hidden"); });
    on("saveCfg", "click", () => {
      chatConfig = {
        base: (($("cfgBase") && $("cfgBase").value) || "").trim() || "https://api.deepseek.com/v1",
        key: (($("cfgKey") && $("cfgKey").value) || "").trim(),
        model: (($("cfgModel") && $("cfgModel").value) || "").trim() || "deepseek-chat",
        visionBase: (($("cfgVisionBase") && $("cfgVisionBase").value) || "").trim(),
        visionKey: (($("cfgVisionKey") && $("cfgVisionKey").value) || "").trim(),
        visionModel: (($("cfgVisionModel") && $("cfgVisionModel").value) || "").trim()
      };
      localStorage.setItem("chat_config_v1", JSON.stringify(chatConfig));
      markSyncDirty();
      const m = $("chatSettingsModal"); if (m) m.classList.add("hidden");
      refreshChatKeyHint();
    });

    on("addExamBtn", "click", openAddExam);
    on("addPointRow", "click", addPointRow);
    on("closeExam", "click", closeAddExam);
    on("saveExam", "click", saveExam);
    on("examPdfFile", "change", onExamPdfChange);

    window.addEventListener("resize", () => { if (pdfDoc) renderPage(curPage); });

    /* 答疑角色切换（四人组小人头像） */
    document.querySelectorAll(".ra-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        chatRole = btn.dataset.role || "lecturer";
        localStorage.setItem(ROLE_KEY, chatRole);
        refreshRole();
        btn.classList.add("ra-pulse");
        setTimeout(() => btn.classList.remove("ra-pulse"), 260);
      });
    });
    refreshRole();
    applyDiscussionUI();

    /* 研讨模式开关 + 深度 */
    on("discToggle", "click", toggleDiscussion);
    on("discIntensity", "change", (e) => { discIntensity = e.target.value; localStorage.setItem("disc_intensity_v1", discIntensity); });

    /* 错题归因弹窗 */
    on("aiAttr", "click", aiAttribute);
    on("markAttr", "click", markWrongOnly);
    on("saveAttr", "click", saveAttr);
    on("removeAttr", "click", removeAttr);
    on("closeAttr", "click", closeAttrModal);
    // 归因弹窗：三级树级联选择
    on("attrChapterSel", "change", () => {
      const cs = $("attrChapterSel"), ss = $("attrSectionSel"), ps = $("attrPointSel");
      const c = bookTree().chapters.find((x) => x.id === cs.value);
      ss.innerHTML = '<option value="">— 节 —</option>' + (c ? c.sections.map((s) => `<option value="${s.id}">${escapeHtml(s.title)}</option>`).join("") : "");
      ss.value = ""; ps.innerHTML = '<option value="">— 知识点 —</option>'; ps.value = "";
      updateAttrPointLabel();
    });
    on("attrSectionSel", "change", () => {
      const cs = $("attrChapterSel"), ss = $("attrSectionSel"), ps = $("attrPointSel");
      const c = bookTree().chapters.find((x) => x.id === cs.value);
      const s = c && c.sections.find((x) => x.id === ss.value);
      ps.innerHTML = '<option value="">— 知识点 —</option>' + (s ? s.points.map((p) => `<option value="${p.id}">${escapeHtml(p.title)}</option>`).join("") : "");
      ps.value = "";
      updateAttrPointLabel();
    });
    on("attrPointSel", "change", updateAttrPointLabel);

    /* 薄弱点导出 */
    on("exportAttrJson", "click", () => exportAttribution("json"));
    on("exportAttrCsv", "click", () => exportAttribution("csv"));
    on("exportAttrMd", "click", () => exportAttribution("md"));
    /* 教材树编辑 / 重做回路 */
    on("importTreeBtn", "click", seedTreeFromExams);
    on("addChapterBtn", "click", () => {
      const title = prompt("新章节标题（如：第2章 极限）");
      if (!title) return;
      bookTree().chapters.push({ id: uid("c_"), title: title.trim(), sections: [] });
      saveTree(); renderWeak();
    });
  }

  function refreshRole() {
    const hint = $("roleHint");
    if (hint) hint.textContent = (ROLE_NAMES[chatRole] || "📖 讲解员") + "：" + ROLE_HINTS[chatRole];
    document.querySelectorAll(".ra-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.role === chatRole);
    });
  }

  function toggleDiscussion() {
    discussionMode = !discussionMode;
    localStorage.setItem("discussion_mode_v1", discussionMode ? "on" : "off");
    applyDiscussionUI();
  }
  function applyDiscussionUI() {
    const t = $("discToggle");
    if (t) t.classList.toggle("active", discussionMode);
    const sel = $("discIntensity");
    if (sel) { sel.classList.toggle("hidden", !discussionMode); sel.value = discIntensity; }
    const banner = $("discBanner");
    if (banner) banner.classList.toggle("hidden", !discussionMode);
    const avatars = $("roleAvatars");
    if (avatars) avatars.classList.toggle("hidden", discussionMode);
  }

  function restoreSessions() {
    if (!chatSessions.length) {
      ensureSession();
      renderCurrentSession();
    } else {
      const s = currentSession();
      if (!currentSessionId || !s || (s.bookId || LEGACY_BOOK_ID) !== activeBookId) {
        const sessionsForBook = chatSessions.filter((x) => (x.bookId || LEGACY_BOOK_ID) === activeBookId);
        if (sessionsForBook.length) currentSessionId = sessionsForBook[sessionsForBook.length - 1].id;
        else ensureSession();
      }
      renderCurrentSession();
    }
    renderSessions();
  }

  /* ---------- 启动 ---------- */
  bind();
  refreshChatKeyHint();
  loadBookManifest();
  loadNotes();
  // 附件二进制在 IndexedDB：先载入缓存，再把仍内联在 localStorage 的旧附件迁过去
  loadAttCache()
    .then(migrateLegacyAttachments)
    .then(() => { renderNotes(); })
    .catch((e) => console.warn("附件缓存/迁移失败", e));
  restoreSessions();
  // 每日一题：启动即补生成（当天缺失时），并挂后台定时检查
  try { startDailyTimer(); } catch (e) { console.warn("每日一题初始化失败", e); }

  // 云同步：恢复令牌/勾选状态，展示服务器地址，开启自动同步
  try {
    const _tok = getSyncToken();
    if ($("syncToken")) $("syncToken").value = _tok;
    if ($("syncBase")) $("syncBase").value = localStorage.getItem(SYNC_BASE_KEY) || "";
    if ($("syncWithKey")) $("syncWithKey").checked = getSyncWithKey();
    if ($("syncAuto")) $("syncAuto").checked = getSyncAuto();
    updateSyncMeta();
    if (getSyncAuto()) startAutoSync();
  } catch (e) { console.warn("云同步初始化失败", e); }

  // 首屏只加载 index+style+app（≈130KB）；pdf.js / MathJax 在浏览器空闲时后台预热，
  // 用户真正点开 PDF 或公式时基本已就位，首次按需也能 ensure* 立即拉取。
  if (window.requestIdleCallback) {
    requestIdleCallback(() => { ensurePdfJs().catch(() => {}); ensureMathJax().catch(() => {}); }, { timeout: 4000 });
  } else {
    setTimeout(() => { ensurePdfJs().catch(() => {}); ensureMathJax().catch(() => {}); }, 1200);
  }
})();
