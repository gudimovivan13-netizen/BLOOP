#!/usr/bin/env python3
"""Расширенный корпус BLOOP AI: научные статьи Википедии (~100 наук),
книги Викитеки (от древних текстов до модерна), реальный код проекта.
Диалоги (corpus.py) остаются основой «разговора как человек» — всё
объединяется в data/corpus.txt в перемешанном виде.

Никаких внешних AI-API: только открытое содержимое (CC BY-SA / PD).
"""
import concurrent.futures as cf
import json
import os
import random
import re
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
UA = {"User-Agent": "BLOOP-AI-training/1.0 (educational corpus build; contact: bloop@example.net)"}
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))

random.seed(42)

def fetch(url, timeout=25):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def api(base, params):
    q = urllib.parse.urlencode(params)
    d = json.loads(fetch(f"{base}/w/api.php?{q}").decode("utf-8", "ignore"))
    time.sleep(0.05)
    return d

def trim(text, limit):
    if len(text) <= limit:
        return text
    cut = text[:limit]
    i = cut.rfind("\n")
    return cut[:i] if i > limit // 2 else cut

CYR = re.compile("[а-яё]")

def mostly_ru(text):
    cyr = len(CYR.findall(text.lower()))
    lat = len(re.findall("[a-z]", text.lower()))
    return cyr > 300 and cyr > lat * 2

# ---------------- 1. Википедия: ~100 наук ----------------

SCIENCES = [
    "Физика", "Химия", "Биология", "Астрономия", "Математика", "Информатика",
    "Геология", "Медицина", "История", "Философия", "Экономика", "Психология",
    "Социология", "Лингвистика", "Антропология", "Археология", "Генетика",
    "Нейробиология", "Астрофизика", "Космология", "Квантовая механика",
    "Термодинамика", "Оптика", "Механика", "Электричество", "Органическая химия",
    "Ботаника", "Зоология", "Экология", "Палеонтология", "Микробиология",
    "Вирусология", "Иммунология", "Анатомия", "Физиология", "Фармакология",
    "Кардиология", "Неврология", "Онкология", "Психиатрия", "География",
    "Геофизика", "Метеорология", "Климатология", "Океанология", "Вулканология",
    "Минералогия", "Кристаллография", "Геодезия", "Картография", "Демография",
    "Политология", "Юриспруденция", "Педагогика", "Искусствоведение", "Музыка",
    "Литературоведение", "Логика", "Статистика", "Теория вероятностей",
    "Алгебра", "Геометрия", "Математический анализ", "Топология",
    "Теория чисел", "Криптография", "Теория алгоритмов", "Программирование",
    "Компьютерные сети", "База данных", "Искусственный интеллект",
    "Машинное обучение", "Робототехника", "Астронавтика", "Ядерная физика",
    "Физика элементарных частиц", "Материаловедение", "Нанотехнологии",
    "Биотехнология", "Агрономия", "Ветеринария", "Урбанистика", "Архитектура",
    "Метрология", "Машиностроение", "Электротехника", "Электроника",
    "Металлургия", "Горное дело", "Нефтехимия", "Транспорт", "Логистика",
    "Международные отношения", "Эконометрика", "Маркетинг", "Менеджмент",
    "Финансы", "Банковское дело", "Селекция", "Гидрология", "Почвоведение",
    "Энтология", "Орнитология", "Энтомология", "Альгология", "Микология",
]

WIKI = "https://ru.wikipedia.org"
PER_SCIENCE = 30

def wiki_titles():
    titles = set()
    for sci in SCIENCES:
        try:
            d = api(WIKI, {"action": "query", "format": "json",
                           "list": "categorymembers", "cmtitle": f"Категория:{sci}",
                           "cmlimit": PER_SCIENCE, "cmtype": "page"})
            members = [m["title"] for m in d.get("query", {}).get("categorymembers", [])]
            titles.add(sci)
            titles.update(members)
        except Exception as e:
            print(f"  категория {sci}: пропуск ({e})")
    return sorted(titles)

def wiki_extract(titles):
    """Полный текст — по одной статье за запрос (ограничение API extracts).
    3 воркера + ретраи: Wikimedia режет агрессивные параллельные запросы."""
    out = {}
    lock_at = [0.0]
    def one(t):
        for attempt in range(3):
            try:
                time.sleep(0.08)
                d = api(WIKI, {"action": "query", "format": "json", "prop": "extracts",
                               "explaintext": 1, "redirects": 1, "titles": t})
                pages = d.get("query", {}).get("pages", {})
                for p in pages.values():
                    ex = p.get("extract", "")
                    if ex:
                        return (t, ex)
                return (t, "")
            except Exception:
                time.sleep(1.5 * (attempt + 1))
        return (t, "")
    with cf.ThreadPoolExecutor(max_workers=3) as ex_pool:
        for i, (t, text) in enumerate(ex_pool.map(one, titles)):
            if len(text) >= 600 and not text.startswith("#"):
                out[t] = trim(text, 3500)
            if (i + 1) % 300 == 0:
                print(f"  статья {i + 1}/{len(titles)}, собрано {len(out)}", flush=True)
    return out

# ---------------- 2. Викитека: книги от старых до современных ----------------

WORKS = [
    # XII–XVIII век
    "Слово о полку Игореве", "Бедная Лиза", "Путешествие из Петербурга в Москву",
    # Пушкин
    "Капитанская дочка", "Пиковая дама", "Медный всадник", "Полтава",
    "Цыганы", "Руслан и Людмила",
    # Лермонтов и Гоголь
    "Мцыри", "Бородино", "Герой нашего времени",
    "Шинель", "Нос", "Вий", "Портрет", "Старосветские помещики",
    "Ночь перед Рождеством", "Тарас Бульба", "Мёртвые души",
    # Тургенев, Достоевский, Толстой, Чехов
    "Муму", "Ася", "Первая любовь", "Белые ночи", "Кроткая",
    "Кавказский пленник (Толстой)", "После бала", "Хамелеон",
    "Толстый и тонкий", "Каштанка", "Лошадиная фамилия", "Смерть чиновника",
    "Анна на шее", "Крыжовник", "Ионыч", "Студент",
    # Крылов, Грибоедов, поэты XX века
    "Волк и Ягнёнок", "Ворона и Лисица", "Квартет", "Горе от ума",
    "Двенадцать (поэма)", "Тёмные аллеи",
]

import html as html_mod

def clean_html(raw_html):
    """HTML Викитеки → чистый текст: убираем скрипты, теги, сущности,
    шапку страницы (автор, ссылки, «Источник:») — оставляем сам текст."""
    t = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw_html, flags=re.S)
    t = re.sub(r"<[^>]+>", " ", t)
    t = html_mod.unescape(t)
    t = t.replace("\u00a0", " ")
    t = re.sub(r"\s+", " ", t).strip()
    idx = t.find("Источник:")
    if 0 < idx < 1200:                # шапка Викитеки заканчивается источником
        t = t[idx + len("Источник:"):].strip()
    idx = t.find("Лицензия")
    if idx > 0:
        t = t[:idx]
    return t

def ws_page(title):
    """Текст страницы Викитеки (учитывая трансклюзии — через action=parse)."""
    d = api("https://ru.wikisource.org", {"action": "parse", "format": "json",
                                          "redirects": 1, "prop": "text", "page": title})
    html = d.get("parse", {}).get("text", {}).get("*", "")
    return clean_html(html)

def ws_extract_work(title):
    texts = []
    try:
        main = ws_page(title)
        if len(main) >= 800:
            texts.append(main)
        # подстраницы-главы: «Тарас Бульба/I» — реальные тексты там
        d = api("https://ru.wikisource.org", {"action": "query", "format": "json",
                                              "list": "allpages",
                                              "apprefix": f"{title}/", "aplimit": 80})
        subs = [p["title"] for p in d.get("query", {}).get("allpages", [])][:50]
        for st in subs:
            try:
                t = ws_page(st)
                if len(t) >= 800:
                    texts.append(t)
            except Exception:
                pass
    except Exception:
        return []
    return [trim(t, 6000) for t in texts if mostly_ru(t)][:45]

# ---------------- 3. Код проекта ----------------

def code_docs():
    docs = []
    import glob
    patterns = ["server.js", "src/**/*.js", "public/app.js", "public/local-server.js",
                "public/miniapp-sdk.js", "public/icons.js", "scripts/*.mjs",
                "scripts/llm/*.py", "app/desktop/main.js", "app/build-www.mjs"]
    files = []
    for pat in patterns:
        files += glob.glob(os.path.join(REPO, pat), recursive=True)
    files = sorted(set(files))
    for f in files:
        try:
            src = open(f, encoding="utf-8").read()
        except Exception:
            continue
        avg = len(src) / max(src.count("\n"), 1)
        if avg > 220:  # минифицированное пропускаем
            continue
        ext = os.path.splitext(f)[1]
        lang = {"js": "JavaScript", "py": "Python", "mjs": "JavaScript"}.get(ext[1:], ext[1:])
        body = trim(src, 9000)
        docs.append(f"Код на {lang} (файл {os.path.basename(f)}):\n{body}")
    return docs

# ---------------- сборка ----------------

def main():
    os.makedirs(DATA, exist_ok=True)
    dialogues_path = os.path.join(DATA, "dialogues.txt")   # чистые диалоги из corpus.py
    knowledge_path = os.path.join(DATA, "knowledge.txt")

    docs = []

    print("[1/3] Википедия: статьи по ~100 наукам...")
    titles = wiki_titles()
    print(f"  уникальных статей: {len(titles)}")
    wiki = wiki_extract(titles)
    print(f"  получено текстов: {len(wiki)}")
    for t, text in sorted(wiki.items()):
        docs.append(f"Научная статья «{t}».\n{text}")

    print("[2/3] Викитека: книги от старых к современным...")
    got_books = 0
    for w in WORKS:
        w = w.strip()
        if "?" in w:
            continue
        parts = ws_extract_work(w)
        if parts:
            got_books += 1
            docs.append(f"Книга (Викитека): «{w}».\n" + "\n".join(parts))
    print(f"  книг получено: {got_books}")

    print("[3/3] Код проекта...")
    code = code_docs()
    print(f"  файлов кода: {len(code)}")
    docs += code

    random.shuffle(docs)
    with open(knowledge_path, "w", encoding="utf-8") as f:
        for d in docs:
            f.write("<doc>\n" + d.strip() + "\n\n")

    total = sum(len(d) for d in docs)
    print(f"knowledge.txt: {len(docs)} документов, {total/1e6:.1f} МБ")

    # финальный корпус: диалоги x2 + знания, перемешано по документам
    if not os.path.exists(dialogues_path):
        print("ВАЖНО: data/corpus.txt (диалоги) нет — сначала запусти corpus.py")
        sys.exit(1)
    raw = open(dialogues_path, encoding="utf-8").read()
    blocks = [b.strip() for b in raw.split("<doc>") if b.strip()]
    print(f"диалоговых блоков: {len(blocks)}")
    merged = blocks * 2 + docs
    random.shuffle(merged)
    with open(os.path.join(DATA, "corpus.txt"), "w", encoding="utf-8") as f:
        for b in merged:
            f.write("<doc>\n" + b + "\n\n")
    print(f"итоговый corpus.txt: {len(merged)} документов, "
          f"{sum(len(b) for b in merged)/1e6:.1f} МБ")

if __name__ == "__main__":
    main()
