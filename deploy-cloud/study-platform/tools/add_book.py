#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
add_book.py —— 把一本新书接入「书架」（作为随站发布的种子书）。

用法：
  python tools/add_book.py --pdf "路径/到/课本.pdf" --id shuxue2 --title "数学分析（第二册）"

做了什么：
  1. 复制 PDF 到  books/<id>/textbook.pdf
  2. 用 PyMuPDF 提取每页内嵌 OCR 文本 → books/<id>/index.json
     （仅作「未载入 PDF 时」的检索回退；平台主要靠 pdf.js 实时渲染书页图，不依赖它）
  3. 生成空的  books/<id>/problems.json 和 books/<id>/exam-points.json
  4. 把该书条目追加进  data/books.json（书架清单）

依赖：pip install pymupdf
"""
import argparse
import fitz
import json
import os
import re
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)            # study-platform/
BOOKS_DIR = os.path.join(PROJECT, "books")
DATA_DIR = os.path.join(PROJECT, "data")

CHAP_RE = re.compile(r"第\s*([一二三四五六七八九十百\d]+)\s*章")


def extract_index(pdf_path):
    doc = fitz.open(pdf_path)
    n = doc.page_count
    pages, chapters, seen = [], [], {}
    for i in range(n):
        txt = doc[i].get_text()
        txt_clean = re.sub(r"\s+", " ", txt).strip()
        pages.append({"page": i + 1, "text": txt_clean})
        for m in CHAP_RE.finditer(txt):
            key = m.group(0)
            if key not in seen:
                seen[key] = i + 1
                line = next((ln.strip() for ln in txt.splitlines() if m.group(0) in ln), key)
                chapters.append({"title": line, "page": i + 1})
    doc.close()
    return {
        "meta": {
            "title": "课本",
            "totalPages": n,
            "note": "文字由 PDF 内嵌 OCR 文本层提取，个别字可能有误；搜索按子串匹配。",
        },
        "chapters": chapters,
        "pages": pages,
    }, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True, help="课本 PDF 路径")
    ap.add_argument("--id", required=True, help="唯一书 id，如 shuxue2")
    ap.add_argument("--title", required=True, help="书名，如 数学分析（第二册）")
    args = ap.parse_args()

    bdir = os.path.join(BOOKS_DIR, args.id)
    os.makedirs(bdir, exist_ok=True)

    # 1. 复制 PDF
    dst_pdf = os.path.join(bdir, "textbook.pdf")
    shutil.copy2(args.pdf, dst_pdf)

    # 2. 索引
    index, n = extract_index(dst_pdf)
    index_path = os.path.join(bdir, "index.json")
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

    # 3. 空题目 / 考点
    with open(os.path.join(bdir, "problems.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": {"book": args.title}, "problems": []}, f, ensure_ascii=False, indent=2)
    with open(os.path.join(bdir, "exam-points.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": {}, "exams": []}, f, ensure_ascii=False, indent=2)

    # 4. 注册到 books.json
    books_json = os.path.join(DATA_DIR, "books.json")
    if os.path.exists(books_json):
        with open(books_json, encoding="utf-8") as f:
            manifest = json.load(f)
    else:
        manifest = {"active": args.id, "books": []}
    manifest.setdefault("books", [])
    entry = {
        "id": args.id,
        "title": args.title,
        "pdf": f"books/{args.id}/textbook.pdf",
        "index": f"books/{args.id}/index.json",
        "problems": f"books/{args.id}/problems.json",
        "exams": f"books/{args.id}/exam-points.json",
        "color": "#4f7cff",
    }
    if not any(b["id"] == args.id for b in manifest["books"]):
        manifest["books"].append(entry)
    if not manifest.get("active"):
        manifest["active"] = args.id
    with open(books_json, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"✓ 已接入《{args.title}》(id={args.id})")
    print(f"  页数 {n}，章节 {len(index['chapters'])}，索引 {round(os.path.getsize(index_path)/1024,1)} KB")
    print(f"  已写入 data/books.json，重新部署后即可在书架看到。")


if __name__ == "__main__":
    main()
