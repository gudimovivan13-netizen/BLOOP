#!/usr/bin/env python3
"""Индекс знаний BLOOP AI: разбиваем статьи/книги/код на фрагменты,
каждому — стем-ключевые слова; итог (текст + ключи) пишем в
public/vendor/bloop-knowledge.json. Поиск по индексу — src/ai/knowledge.js
(IDF-взвешенное пересечение стемов, чистый JS, без внешних API).
"""
import json
import os
import re
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
KNOWLEDGE = os.path.join(HERE, "data", "knowledge.txt")
OUT = os.path.join(HERE, "..", "..", "public", "vendor", "bloop-knowledge.json")

# Тот же стеммер, что в src/ai/text.js (JS) — совместимость стемов.
SUFFIXES = ["ами", "ями", "ому", "ему", "ого", "его", "ыми", "ими", "ах", "ях", "ам",
            "ям", "ая", "яя", "ое", "ее", "ый", "ий", "ой", "ей", "ым", "им", "ом",
            "ем", "ий", "ешь", "ишь", "ет", "ют", "ут", "ат", "ят", "ит", "ал", "ял",
            "ел", "ил", "ла", "ли", "ло", "ся", "ть", "ы", "и", "а", "я", "о", "е",
            "у", "ю", "ь", "й"]
STOP = {"и", "в", "во", "не", "на", "я", "с", "со", "как", "а", "то", "все", "но",
        "да", "ты", "к", "у", "же", "вы", "за", "бы", "по", "или", "если", "уже",
        "мне", "меня", "тебя", "он", "она", "они", "оно", "это", "эти", "тут",
        "там", "твой", "мой", "его", "ее", "их", "для", "от", "до", "из", "при",
        "об", "быть", "был", "была", "было", "будет", "также", "когда", "чтобы"}

def normalize(s):
    s = s.lower().replace("ё", "е")
    return re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE)

def stem(w):
    for suf in SUFFIXES:
        if len(w) - len(suf) >= 3 and w.endswith(suf):
            w = w[: len(w) - len(suf)]
            break
    return w

def tokens(text):
    out = []
    for raw in normalize(text).split():
        if len(raw) < 2 or raw in STOP:
            continue
        st = stem(raw)
        if len(st) >= 2:
            out.append(st)
    return out

def split_chunks(text, limit=420):
    """Абзацы → фрагменты ~2-3 предложения."""
    paras = [p.strip() for p in re.split(r"\n+", text) if len(p.strip()) > 80]
    chunks = []
    for p in paras:
        sents = re.split(r"(?<=[.!?])\s+", p)
        cur = ""
        for s in sents:
            if len(cur) + len(s) + 1 > limit:
                if cur:
                    chunks.append(cur.strip())
                cur = s
            else:
                cur = f"{cur} {s}".strip()
        if cur:
            chunks.append(cur.strip())
    return chunks

MAX_CHUNKS = 14000

def main():
    raw = open(KNOWLEDGE, encoding="utf-8").read()
    docs = [b.strip() for b in raw.split("<doc>") if b.strip()]
    print("документов в knowledge.txt:", len(docs))

    chunks = []  # (title, type, text)
    for d in docs:
        m = re.match(r"(Научная статья|Книга \(Викитека\)|Код на \w+) [^\n]*", d)
        head = d.split("\n", 1)[0]
        body = d.split("\n", 1)[1] if "\n" in d else ""
        if head.startswith("Научная статья"):
            ty, title = "wiki", re.sub(r"^Научная статья «|»\.$", "", head).strip(" «».")
        elif head.startswith("Книга"):
            ty, title = "book", re.sub(r"^Книга \(Викитека\): «|»\.$", "", head).strip(" «».")
        elif head.startswith("Код"):
            ty, title = "code", re.sub(r"^Код на \w+ \(файл (\w[\w.]*)\):$", r"\1", head).strip()
        else:
            ty, title = "text", head[:60]
        for c in split_chunks(body):
            chunks.append((title, ty, c))
    print("фрагментов:", len(chunks))

    # IDF по фрагментам
    tfs = []
    for _, _, c in chunks:
        tfs.append(Counter(tokens(c)[:120]))
    df = Counter()
    for tf in tfs:
        df.update(tf.keys())
    import math
    N = max(len(chunks), 1)
    idf = {t: math.log(N / (1 + n)) for t, n in df.items()}

    # отбор: самые информативные фрагменты (сумма tf*idf топ-ключей)
    scored = []
    for i, (title, ty, text) in enumerate(chunks):
        keys = [(t, n * idf.get(t, 0.0)) for t, n in tfs[i].items()]
        keys.sort(key=lambda x: -x[1])
        score = sum(v for _, v in keys[:8]) / 8.0
        top = [t for t, _ in keys[:36]]
        scored.append((score, i, title, ty, text, top))
    scored.sort(key=lambda x: -x[0])
    scored = scored[:MAX_CHUNKS]

    chunks_out = []
    post = {}
    for score, i, title, ty, text, top in scored:
        ci = len(chunks_out)
        chunks_out.append({"t": title[:70], "ty": ty, "s": text})
        for t in top:
            post.setdefault(t, []).append(ci)

    out = {"chunks": chunks_out, "post": post}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(OUT)
    print(f"bloop-knowledge.json: {len(chunks_out)} фрагментов, {len(post)} термов, {size/1e6:.1f} МБ")

if __name__ == "__main__":
    main()
