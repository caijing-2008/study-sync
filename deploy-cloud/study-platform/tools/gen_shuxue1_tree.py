# -*- coding: utf-8 -*-
"""Generate the cleaned textbook knowledge tree for shuxue1 (pages 14-17)
and emit both a JSON file and a self-contained browser-console injector."""
import json, os, sys

TOC = [
    ("第2章 单变量函数的连续性", [
        ("2.1 连续函数的基本概念", [
            "2.1.1 连续的定义",
            "2.1.2 左(右)连续与间断",
            "2.1.3 连续函数的运算",
            "2.1.4 初等函数连续性",
        ]),
        ("2.2 闭区间上连续函数的性质", [
            "2.2.1 零点定理与介值定理",
            "2.2.2 有界性与最大最小值定理",
            "2.2.3 一致连续性",
        ]),
    ]),
    ("第3章 单变量函数的微分学", [
        ("3.1 导数", [
            "3.1.1 导数的定义",
            "3.1.2 导数的四则运算",
            "3.1.3 复合函数的求导法则",
            "3.1.4 反函数的求导法则",
            "3.1.5 基本初等函数的导数",
            "3.1.6 高阶导数",
            "3.1.7 参数方程表示的函数的导数",
        ]),
        ("3.2 微分", [
            "3.2.1 微分的定义",
            "3.2.2 微分的运算与一阶微分形式的不变性",
        ]),
        ("3.3 微分中值定理", [
            "3.3.1 Fermat 定理和 Rolle 定理",
            "3.3.2 微分中值定理",
            "3.3.3 导函数的介值性质",
        ]),
        ("3.4 未定式的极限", [
            "3.4.1 0/0 型未定式的极限",
            "3.4.2 ∞/∞ 型未定式的极限",
            "3.4.3 其他类型的未定式的极限",
        ]),
        ("3.5 函数的单调性和凸性", [
            "3.5.1 函数的单调性与极值",
            "3.5.2 函数的凸性和拐点",
            "3.5.3 平面曲线的曲率",
        ]),
        ("3.6 Taylor 展开", [
            "3.6.1 Taylor 公式",
            "3.6.2 余项的表示与估计",
        ]),
    ]),
    ("第4章 不定积分", [
        ("4.1 不定积分及其基本计算方法", [
            "4.1.1 基本概念",
            "4.1.2 换元积分法",
            "4.1.3 分部积分法",
        ]),
        ("4.2 有理函数的不定积分", [
            "4.2.1 有理函数的不定积分",
            "4.2.2 三角函数有理式的不定积分",
            "4.2.3 其他类型的初等函数的不定积分",
        ]),
    ]),
    ("第5章 单变量函数的积分学", [
        ("5.1 积分", [
            "5.1.1 积分的定义",
            "5.1.2 可积函数类",
            "5.1.3 积分的初等例子",
            "5.1.4 积分的基本性质",
            "5.1.5 微积分基本定理",
            "5.1.6 积分的计算",
            "5.1.7 用积分定义函数",
            "5.1.8 Taylor 展开中余项的积分表示",
        ]),
        ("5.2 函数的可积性", [
            "5.2.1 函数的可积性",
            "5.2.2 可积函数类有关定理和性质的证明",
        ]),
        ("5.3 积分的应用", [
            "5.3.1 平面曲线的弧长",
            "5.3.2 平面图形的面积",
            "5.3.3 旋转体的体积",
            "5.3.4 旋转体的侧面积",
            "5.3.5 变力做功和引力",
        ]),
        ("5.4 反常积分", [
            "5.4.1 无穷区间上的积分",
            "5.4.2 瑕积分",
            "5.4.3 反常积分的换元积分和分部积分",
        ]),
    ]),
    ("第6章 常微分方程初步", [
        ("6.1 一阶微分方程", [
            "6.1.1 分离变量法",
            "6.1.2 齐次方程",
            "6.1.3 一阶线性方程",
            "6.1.4 可降阶微分方程",
        ]),
        ("6.2 二阶线性微分方程", [
            "6.2.1 二阶线性方程解的结构",
            "6.2.2 常数变易法",
            "6.2.3 二阶常系数齐次线性微分方程",
            "6.2.4 振动方程的解",
        ]),
    ]),
    ("第7章 无穷级数", [
        ("7.1 数项级数", [
            "7.1.1 基本概念与性质",
            "7.1.2 正项级数的收敛性及其判别法",
            "7.1.3 一般级数的收敛性及其判别法",
            "7.1.4 级数的乘积",
            "7.1.5 无穷乘积",
        ]),
        ("7.2 函数项级数", [
            "7.2.1 收敛性",
            "7.2.2 一致收敛性",
            "7.2.3 一致收敛级数的性质",
        ]),
        ("7.3 幂级数和 Taylor 展开式", [
            "7.3.1 幂级数的收敛区域",
            "7.3.2 收敛半径的计算",
            "7.3.3 幂级数的性质",
            "7.3.4 幂级数的运算",
            "7.3.5 函数的 Taylor 展开式",
        ]),
        ("7.4 级数的应用", [
            "7.4.1 用级数方法计算积分",
            "7.4.2 近似计算",
            "7.4.3 微分方程的幂级数解",
            "7.4.4 Stirling 公式",
        ]),
    ]),
]


def parse_num(title):
    """Parse leading numbers like '2.1.3' from a title."""
    import re
    m = re.match(r"(\d+(?:\.\d+)*)", title)
    return m.group(1) if m else ""


def ch_num_from_title(title):
    """Extract chapter number from '第2章 ...'."""
    import re
    m = re.search(r"第\s*(\d+)\s*章", title)
    return m.group(1) if m else ""


def build_tree():
    chapters = []
    seen_ids = set()
    for ch_title, sections in TOC:
        ch_num = ch_num_from_title(ch_title)  # e.g. '2'
        c_id = f"c_{ch_num}"
        assert c_id not in seen_ids, c_id
        seen_ids.add(c_id)
        ch = {"id": c_id, "title": ch_title, "sections": []}
        for sec_title, points in sections:
            sec_num = parse_num(sec_title)  # e.g. '2.1'
            s_id = "s_" + sec_num.replace(".", "_")
            assert s_id not in seen_ids, s_id
            seen_ids.add(s_id)
            sec = {"id": s_id, "title": sec_title, "points": []}
            for pt_title in points:
                pt_num = parse_num(pt_title)  # e.g. '2.1.1'
                p_id = "p_" + pt_num.replace(".", "_")
                assert p_id not in seen_ids, p_id
                seen_ids.add(p_id)
                sec["points"].append({"id": p_id, "title": pt_title, "desc": ""})
            ch["sections"].append(sec)
        chapters.append(ch)
    return {"chapters": chapters}


def verify(tree):
    chs = len(tree["chapters"])
    secs = sum(len(c["sections"]) for c in tree["chapters"])
    pts = sum(len(s["points"]) for c in tree["chapters"] for s in c["sections"])
    ids = set()
    dupes = []
    for c in tree["chapters"]:
        ids.add(c["id"])
        for s in c["sections"]:
            ids.add(s["id"])
            for p in s["points"]:
                if p["id"] in ids:
                    dupes.append(p["id"])
                ids.add(p["id"])
    return {"chapters": chs, "sections": secs, "points": pts, "ids": len(ids), "dupes": dupes}


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    tree = build_tree()
    stats = verify(tree)
    if stats["dupes"]:
        print("Duplicate IDs:", stats["dupes"])
        sys.exit(1)
    print(f"Tree built: {stats['chapters']} chapters, {stats['sections']} sections, {stats['points']} points, {stats['ids']} unique ids")

    # 1. JSON tree file
    json_path = os.path.join(root, "data", "tree_shuxue1.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"shuxue1": tree}, f, ensure_ascii=False, indent=2)
    print("Wrote", json_path)

    # 2. Self-contained browser-console injector (preserves other books)
    tree_json = json.dumps(tree, ensure_ascii=False, indent=2)
    js = f'''// 将 shuxue1 教材树注入到当前 origin 的 localStorage
// 仅修改 study_tree_v1["shuxue1"]，不影响其他书本
(function(){{
  const KEY = "study_tree_v1";
  let data = {{}};
  try {{ data = JSON.parse(localStorage.getItem(KEY) || "{{}}"); }} catch(e){{}}
  const before = Object.keys(data).sort();
  data["shuxue1"] = {tree_json};
  try {{
    localStorage.setItem(KEY, JSON.stringify(data));
    console.log("✅ shuxue1 教材树已注入");
    console.log("books before:", before.join(", ") || "(none)");
    console.log("books after:", Object.keys(data).sort().join(", "));
    console.log("nodes:", data["shuxue1"].chapters.length, "章,",
                data["shuxue1"].chapters.reduce((a,c)=>a+c.sections.length,0), "节,",
                data["shuxue1"].chapters.reduce((a,c)=>a+c.sections.reduce((b,s)=>b+s.points.length,0),0), "知识点");
    alert("shuxue1 教材树已注入，共 " + data["shuxue1"].chapters.length + " 章。请刷新页面。");
  }} catch(e) {{
    console.error("注入失败", e);
    alert("注入失败：" + e.message);
  }}
}})();'''
    js_path = os.path.join(root, "shuxue1_tree_inject.js")
    with open(js_path, "w", encoding="utf-8") as f:
        f.write(js)
    print("Wrote", js_path)


if __name__ == "__main__":
    main()
