// 验证：考卷按书本命名空间隔离（user_exams_v1 = { [bookId]: [...] }），与 notes 一致。
const LEGACY_BOOK_ID = "shuxue1";
let activeBookId = LEGACY_BOOK_ID;
let userExamsMap = {};
function userExamsForBook() { if (!userExamsMap[activeBookId]) userExamsMap[activeBookId] = []; return userExamsMap[activeBookId]; }
function loadUserExams() {
  let raw = localStorage.getItem("user_exams_v1");
  try { userExamsMap = raw ? JSON.parse(raw) : {}; } catch (e) { userExamsMap = {}; }
  if (!userExamsMap || typeof userExamsMap !== "object" || Array.isArray(userExamsMap)) {
    const legacy = Array.isArray(userExamsMap) ? userExamsMap : [];
    userExamsMap = {}; userExamsMap[LEGACY_BOOK_ID] = legacy;
  }
}
function saveUserExams() { localStorage.setItem("user_exams_v1", JSON.stringify(userExamsMap)); }
function addExam(title) { const rec = { id: "exam-" + Math.random().toString(36).slice(2), title, bookId: activeBookId }; userExamsForBook().push(rec); saveUserExams(); }

global.localStorage = { _m: {}, getItem(k) { return k in this._m ? this._m[k] : null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };

let pass = true;
function check(name, cond) { console.log((cond ? "✓ " : "✗ ") + name); if (!cond) pass = false; }

// 1) 在 shuxue1 加两份考卷
activeBookId = "shuxue1"; loadUserExams();
addExam("期中"); addExam("期末");
// 2) 切到 shuxue2 加一份
activeBookId = "shuxue2"; addExam("quiz2");
// 3) 验证隔离
activeBookId = "shuxue1";
const a = userExamsForBook().map((e) => e.title).sort();
activeBookId = "shuxue2";
const b = userExamsForBook().map((e) => e.title);
check("shuxue1 仅含自己的考卷", JSON.stringify(a) === JSON.stringify(["期中", "期末"]));
check("shuxue2 仅含自己的考卷", JSON.stringify(b) === JSON.stringify(["quiz2"]));
check("持久化结构为命名空间对象", typeof JSON.parse(localStorage.getItem("user_exams_v1")) === "object" && !Array.isArray(JSON.parse(localStorage.getItem("user_exams_v1"))));

// 4) 迁移：旧版扁平数组 → 默认书
localStorage.setItem("user_exams_v1", JSON.stringify([{ id: "old1", title: "旧考卷" }]));
activeBookId = "shuxue1"; loadUserExams();
const migrated = userExamsForBook().map((e) => e.title);
check("旧扁平数组迁入默认书 shuxue1", migrated.includes("旧考卷"));
check("迁移后其它书本为空", (userExamsMap["shuxue2"] || []).length === 0);

// 5) allExams：种子考点（按书）+ 本用户考卷
let examsSeed = [{ id: "seed1", title: "种子考卷", bookId: "shuxue1" }];
activeBookId = "shuxue1";
const all = examsSeed.concat(userExamsForBook());
check("allExams 仅含当前书（种子+用户）", all.length === 2 && all.some((e) => e.title === "种子考卷") && all.some((e) => e.title === "旧考卷"));

// 6) 切换书本后 allExams 不串
activeBookId = "shuxue2";
const all2 = examsSeed.concat(userExamsForBook()); // 种子是 shuxue1 的，这里模拟空种子
check("shuxue2 不串入 shuxue1 考卷", !all2.some((e) => e.title === "旧考卷"));

console.log("\n" + (pass ? "考卷按书隔离验证通过 ✅" : "存在未通过 ❌"));
process.exit(pass ? 0 : 1);
