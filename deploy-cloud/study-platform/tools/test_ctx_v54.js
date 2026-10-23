// v54 仿真测试：验证上下文补全函数（总结意图正则 / 本会话历史 / 跨会话今日档案）
const fs = require("fs");
const src = fs.readFileSync("D:/数分学习平台/study-platform/app.js", "utf8");

// 从源码中切片：SUMMARY_INTENT_RE 起到 runDiscussion 定义前
const start = src.indexOf("const SUMMARY_INTENT_RE");
const end = src.indexOf("async function runDiscussion");
if (start < 0 || end < 0 || end <= start) { console.error("FAIL: slice not found"); process.exit(1); }
let slice = src.slice(start, end);
slice = slice.replace("const SUMMARY_INTENT_RE", "var SUMMARY_INTENT_RE"); // eval 中 const 不外泄
// 提供运行所需的全局 mock
const DISC_AGENTS = {
  lecturer: { key: "lecturer", name: "主讲员", emoji: "📖" },
  critic: { key: "critic", name: "质疑官", emoji: "🤔" }
};
const allBooks = [{ id: "shuxue1", title: "数学分析" }];
const chatSessions = [
  {
    id: "s1", bookId: "shuxue1", title: "P127 第5题", updated: Date.now(),
    topic: { page: 127, number: 5 },
    messages: [
      { role: "user", content: "P127 第5题不会", ts: Date.now() - 3600e3 },
      { role: "assistant", agent: "lecturer", content: "这道题用单调有界定理……", ts: Date.now() - 3500e3 },
      { role: "user", content: "还是不懂第二步为什么可以放缩", ts: Date.now() - 3000e3 }
    ]
  },
  {
    id: "s2", bookId: "shuxue1", title: "新对话", updated: Date.now(),
    topic: null,
    messages: [
      { role: "user", content: "", images: ["data:image/png;base64,xxx"], ts: Date.now() - 1800e3 },
      { role: "assistant", content: "看图这是一道一致连续的证明题……", ts: Date.now() - 1700e3 }
    ]
  },
  { // 昨天的会话，不应进今日档案
    id: "s3", bookId: "shuxue1", title: "旧的", updated: Date.now() - 30 * 86400e3,
    topic: { page: 50 },
    messages: [{ role: "user", content: "昨天的问题", ts: Date.now() - 30 * 86400e3 }]
  }
];
let aggregateCalls = 0;
function aggregate(rangeDays) {
  aggregateCalls++;
  return {
    rangeDays, learned: 12, mastered: 5, wrong: 3, streak: 4, totalProblems: 40,
    totalSessions: chatSessions.length, totalAllSessions: 30,
    chapterCount: {}, theoremCount: { "单调有界定理": { count: 2, items: [] }, "一致连续": { count: 1, items: [] } },
    weak: []
  };
}
eval(slice);

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log("  ✓ " + msg); } else { fail++; console.log("  ✗ " + msg); } }

console.log("== 1) SUMMARY_INTENT_RE 命中总结类请求 ==");
ok(SUMMARY_INTENT_RE.test("好的，今晚学习到此为止，你帮我总结一下所有对话，分析我今日所学和不足"), "命中：总结所有对话/今日所学/不足");
ok(SUMMARY_INTENT_RE.test("帮我复盘一下今天学到的东西"), "命中：复盘今天学到");
ok(SUMMARY_INTENT_RE.test("检查一下我的薄弱点"), "命中：检查/薄弱");
ok(!SUMMARY_INTENT_RE.test("P127 第5题不会，第二步为什么可以放缩"), "不命中：普通解题提问");

console.log("== 2) buildSessionHistoryText 保留 user+assistant、排除本轮（最后一条） ==");
const s1 = { messages: [
  { role: "user", content: "P127 第5题不会" },
  { role: "assistant", agent: "lecturer", content: "用单调有界定理……" },
  { role: "user", content: "第二步为什么可以放缩" },
  { role: "assistant", agent: "critic", content: "你放缩的依据是什么？" },
  { role: "user", content: "本轮新提问" } // 最后一条=本轮，应被排除
]};
const h = buildSessionHistoryText(s1);
ok(h.includes("我：P127 第5题不会"), "保留用户的旧提问");
ok(h.includes("我：第二步为什么可以放缩"), "保留用户第二条提问（旧版被整段丢弃的正是它）");
ok(h.includes("主讲员：用单调有界定理"), "保留智能体发言");
ok(h.includes("质疑官：你放缩的依据是什么"), "保留质疑官发言");
ok(!h.includes("本轮新提问"), "排除本轮消息");
ok(buildSessionHistoryText({ messages: [] }) === "", "空会话返回空串");

console.log("== 3) 纯图片消息显示为（发了 N 张截图） ==");
const h2 = buildSessionHistoryText({ messages: [
  { role: "user", content: "", images: ["a", "b"] },
  { role: "user", content: "本轮" }
]});
ok(h2.includes("（发了 2 张截图）"), "空文本+2图 → 显示（发了 2 张截图）");

console.log("== 4) buildTodayStudyDigest 跨会话真实汇总 ==");
const d = buildTodayStudyDigest();
ok(d.indexOf("今日学习档案") >= 0, "含档案头");
ok(d.includes("P127 第5题") && d.includes("P127 第5题不会"), "含会话1的定位与提问原文");
ok(d.includes("（发了 1 张截图）") || d.includes("截图提问"), "纯截图会话也有记录");
ok(!d.includes("昨天的问题"), "昨日会话不进今日档案");
ok(d.includes("1. ") && d.includes("2. "), "两个今日会话都有编号");
ok(d.includes("累计已学会 12"), "含累计进度");
ok(d.includes("单调有界定理（2道）"), "含错题定理分布");
ok(aggregateCalls >= 1, "aggregate 被调用");

console.log("== 5) 今日无会话时的降级文案 ==");
chatSessions.length = 0; // 清空
const d2 = buildTodayStudyDigest();
ok(d2.indexOf("今天此前没有答疑会话") >= 0, "无会话时如实说明（不编造）");
ok(d2.includes("累计已学会 12"), "仍含进度统计");

console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
process.exit(fail ? 1 : 0);
