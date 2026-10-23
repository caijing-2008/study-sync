// 验证 v46 页码/题号解析器 parseTopicRef（从 app.js 同步拷贝，改完 app.js 记得同步）
// 运行：node tools/test_topicref_v46.js
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

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; } else { fail++; console.log("✗ " + label + "  实际=" + JSON.stringify(actual) + " 期望=" + JSON.stringify(expected)); }
}

eq(parseTopicRef("P127 第5题"), { page: 127, number: 5 }, "标准 P127 第5题");
eq(parseTopicRef("p127 第 5 题"), { page: 127, number: 5 }, "小写 p + 空格");
eq(parseTopicRef("Ｐ１２７ 第五题"), { page: 127, number: 5 }, "全角Ｐ+全角数字+中文题号");
eq(parseTopicRef("第127页 第25题不会"), { page: 127, number: 25 }, "第127页 写法");
eq(parseTopicRef("127页 的第3题"), { page: 127, number: 3 }, "127页 写法");
eq(parseTopicRef("页码 127,第 12 题"), { page: 127, number: 12 }, "页码 前缀");
eq(parseTopicRef("P127-5 帮我看"), { page: 127, number: null }, "P127-5 短横线（题号留给兜底/提取）");
eq(parseTopicRef("第5题看不懂"), { page: null, number: 5 }, "只有题号");
eq(parseTopicRef("第二十五题"), { page: null, number: 25 }, "中文数字 二十五");
eq(parseTopicRef("这道题怎么做"), { page: null, number: null }, "无定位信息");
eq(parseTopicRef(""), { page: null, number: null }, "空串");
eq(parseTopicRef("APP 里第2题"), { page: null, number: 2 }, "APP 不误判为页码");

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
