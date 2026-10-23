// 验证 v45 研讨模式的关键纯逻辑：@别名解析 + 协调员兜底调度
// 运行：node tools/test_disc_v45.js
const DISC_AT_RE = /^\s*@(主讲员|主讲解|主讲|讲解|质疑官|质疑|思辨|诊断师|归因|诊断|总结师|总结|提炼|lecturer|critic|diagnostic|summarist)(?=[\s,，。、!?！？:：()\[\]"']|$)/i;
function resolveAgentByAlias(alias) {
  const a = (alias || "").replace(/^@/, "").toLowerCase();
  if (/主讲员|主讲解|主讲|讲解|lecturer/.test(a)) return "lecturer";
  if (/质疑官|质疑|思辨|critic/.test(a)) return "critic";
  if (/诊断师|归因|诊断|diagnostic/.test(a)) return "diagnostic";
  if (/总结师|总结|提炼|summarist/.test(a)) return "summarist";
  return null;
}
const DISC_AGENTS = { lecturer:1, critic:1, diagnostic:1, summarist:1 };
function fallbackSchedule(turn) {
  const seq = ["critic", "lecturer", "diagnostic"];
  if (turn < seq.length) return { speakers: [seq[turn]], end: false };
  return { speakers: [], end: true };
}

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; } else { fail++; console.log("✗ " + label + "  实际=" + JSON.stringify(actual) + " 期望=" + JSON.stringify(expected)); }
}

// 1) @别名解析（新名 + 旧名 + 英文）
eq(resolveAgentByAlias("@主讲员"), "lecturer", "@主讲员");
eq(resolveAgentByAlias("@质疑官"), "critic", "@质疑官");
eq(resolveAgentByAlias("@诊断师"), "diagnostic", "@诊断师");
eq(resolveAgentByAlias("@总结师"), "summarist", "@总结师");
eq(resolveAgentByAlias("@质疑"), "critic", "@质疑(旧)");
eq(resolveAgentByAlias("@总结"), "summarist", "@总结(旧)");
eq(resolveAgentByAlias("@讲解"), "lecturer", "@讲解(旧)");
eq(resolveAgentByAlias("@lecturer"), "lecturer", "@lecturer");
eq(resolveAgentByAlias("主讲员"), "lecturer", "无@前缀也兼容");
eq(resolveAgentByAlias("@乱码"), null, "无匹配返回 null");

// 2) 正则能正确从带前缀的消息里切出别名
eq("@质疑官 这道题为什么这样证".match(DISC_AT_RE)[1], "质疑官", "正则捕获质疑官");
eq("@总结师  收个尾".match(DISC_AT_RE)[1], "总结师", "正则捕获总结师");

// 3) 兜底调度：质疑→主讲回应→诊断→结束（非固定四人轮转，且不含总结师抢话）
eq(fallbackSchedule(0), { speakers:["critic"], end:false }, "兜底 turn0=质疑官");
eq(fallbackSchedule(1), { speakers:["lecturer"], end:false }, "兜底 turn1=主讲员回应");
eq(fallbackSchedule(2), { speakers:["diagnostic"], end:false }, "兜底 turn2=诊断师");
eq(fallbackSchedule(3), { speakers:[], end:true }, "兜底 turn3=结束");

// 4) 模拟协调员 JSON 解析（含 markdown 包裹与尾部废话）
function parseCoord(s) {
  const st = s.indexOf("{"); const en = s.lastIndexOf("}");
  if (st >= 0 && en > st) {
    const obj = JSON.parse(s.slice(st, en + 1));
    return { speakers: (Array.isArray(obj.speakers)?obj.speakers:[].map(x=>String(x).toLowerCase())).filter(k=>DISC_AGENTS[k]).slice(0,2), end: !!obj.end };
  }
  return null;
}
eq(parseCoord('```json\n{"speakers":["critic"],"end":false}\n```'), { speakers:["critic"], end:false }, "协调员JSON(代码块包裹)");
eq(parseCoord('{"speakers":["lecturer","criturer"],"end":true} 好的'), { speakers:["lecturer"], end:true }, "协调员JSON(尾部废话+非法角色被过滤)");

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
