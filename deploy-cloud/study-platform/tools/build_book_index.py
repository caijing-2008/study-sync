import fitz, os, json, re, shutil

SRC = r"C:/Users/22690/Desktop/数学分析讲义（第一册）_9787040510331(OCR).pdf"
OUT = r"C:/Users/22690/LearnBuddy/2026-10-12-17-57-26/study-platform"
PDF_DIR = os.path.join(OUT, "pdf")
DATA_DIR = os.path.join(OUT, "data")
os.makedirs(PDF_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)

doc = fitz.open(SRC)
n = doc.page_count
pages = []
chapters = []
seen = {}
chap_re = re.compile(r"第\s*([一二三四五六七八九十百\d]+)\s*章")

for i in range(n):
    txt = doc[i].get_text()
    txt_clean = re.sub(r"\s+", " ", txt).strip()
    pages.append({"page": i + 1, "text": txt_clean})
    for m in chap_re.finditer(txt):
        key = m.group(0)
        if key not in seen:
            seen[key] = i + 1
            line = next((ln.strip() for ln in txt.splitlines() if m.group(0) in ln), key)
            chapters.append({"title": line, "page": i + 1})

index = {
    "meta": {
        "title": "数学分析讲义（第一册）",
        "totalPages": n,
        "source": "桌面 OCR 版 PDF",
        "note": "文字由 PDF 内嵌 OCR 文本层提取，个别字可能有误；搜索按子串匹配。",
    },
    "chapters": chapters,
    "pages": pages,
}
idx_path = os.path.join(DATA_DIR, "book-index.json")
with open(idx_path, "w", encoding="utf-8") as f:
    json.dump(index, f, ensure_ascii=False, separators=(",", ":"))

dst = os.path.join(PDF_DIR, "textbook.pdf")
shutil.copy2(SRC, dst)
print("pages:", n, "chapters:", len(chapters))
print("index KB:", round(os.path.getsize(idx_path) / 1024, 1))
print("pdf copied KB:", round(os.path.getsize(dst) / 1024, 1))
