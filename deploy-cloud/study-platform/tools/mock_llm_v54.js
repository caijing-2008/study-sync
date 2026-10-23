// 端到端验证用 mock LLM：回显是否收到"今日学习档案"/"本会话历史"标记
const http = require("http");
http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*"
    });
    return res.end();
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let msgs = [];
    try { msgs = (JSON.parse(body).messages) || []; } catch (e) {}
    const all = JSON.stringify(msgs);
    const hasDigest = all.includes("今日学习档案");
    const hasHist = all.includes("本会话此前的对话记录");
    const hasSessionRecord = all.includes("P127 第5题不会");
    const content = "MOCK_OK digest=" + hasDigest + " sessionHist=" + hasHist + " oldQ=" + hasSessionRecord + " msgs=" + msgs.length;
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
}).listen(18138, () => console.log("mock llm on 18138"));
