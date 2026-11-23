#!/usr/bin/env python3
"""BPE-токенизатор для BLOOP AI: обучение мержей на корпусе, кодирование.
Выход: tokenizer.json (спецы + мержи в порядке ранга) и tokens.bin (uint16).
Тот же порядок мержей воспроизводится в JS-инференсе.
"""
import json
import os
import re
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS = os.path.join(HERE, "data", "corpus.txt")
TOK_OUT = os.path.join(HERE, "tokenizer.json")
BIN_OUT = os.path.join(HERE, "data", "tokens.bin")
MERGES = 4600
SAMPLE_CHARS = 4_000_000

# Токены слов ведут с собой пробел/перевод строки (как в GPT-2): иначе
# при декодировании слова слипнутся без пробелов.
WORD_RE = re.compile(r"[ \n]*[а-яёa-z0-9]+:[а-яёa-z0-9]*|[ \n]*[а-яёa-z0-9]+|[ \n]*[^\sа-яёa-z0-9]", re.I)
SPECIALS = ["<doc>", "<unk>"]

def words(text: str):
    return WORD_RE.findall(text.lower())

def learn(corpus_text: str):
    """BPE с инкрементальными парами: пересчитываем только слова,
    в которых применён мерж (иначе Python считает часы)."""
    from collections import defaultdict
    freq = Counter(words(corpus_text))
    word_list = list(freq.items())                 # [(word, count)]
    syms_list = [list(w) for w, _ in word_list]
    pair_counts = Counter()
    pair_words = defaultdict(set)
    for wi, (w, c) in enumerate(word_list):
        s = syms_list[wi]
        for i in range(len(s) - 1):
            pr = (s[i], s[i + 1])
            pair_counts[pr] += c
            pair_words[pr].add(wi)
    merges = []
    for _ in range(MERGES):
        if not pair_counts:
            break
        best, best_n = max(pair_counts.items(), key=lambda kv: (kv[1], kv[0]))
        if best_n < 2:
            break
        merges.append(best)
        a, b = best
        ab = a + b
        for wi in list(pair_words[best]):
            s = syms_list[wi]
            c = word_list[wi][1]
            for i in range(len(s) - 1):
                pr = (s[i], s[i + 1])
                pair_counts[pr] -= c
                pair_words[pr].discard(wi)
                if pair_counts[pr] <= 0:
                    del pair_counts[pr]
                    pair_words.pop(pr, None)
            out = []
            i = 0
            while i < len(s):
                if i + 1 < len(s) and s[i] == a and s[i + 1] == b:
                    out.append(ab)
                    i += 2
                else:
                    out.append(s[i])
                    i += 1
            syms_list[wi] = out
            for i in range(len(out) - 1):
                pr = (out[i], out[i + 1])
                pair_counts[pr] += c
                pair_words[pr].add(wi)
    return freq, merges

def build_vocab(merges, corpus_text=None):
    chars = set()
    for l, r in merges:
        chars.update(l)
        chars.update(r)
    if corpus_text:                       # все символы корпуса — чтобы не было <unk> на редких буквах
        chars.update(set(corpus_text.lower()) - set("\n "))
    vocab = SPECIALS + sorted(chars)
    for l, r in merges:
        if l + r not in vocab:
            vocab.append(l + r)
    return vocab

def encode_word_fn(vocab_ids, merges_ranks):
    """Возвращает функцию кодирования слова: слияние по рангам (как в JS)."""
    def encode_word(w):
        syms = list(w)
        while len(syms) > 1:
            best_i, best_rank = -1, None
            for i in range(len(syms) - 1):
                rank = merges_ranks.get((syms[i], syms[i + 1]))
                if rank is not None and (best_rank is None or rank < best_rank):
                    best_rank, best_i = rank, i
            if best_i < 0:
                break
            syms[best_i:best_i + 2] = [syms[best_i] + syms[best_i + 1]]
        return [vocab_ids.get(s, vocab_ids["<unk>"]) for s in syms]
    return encode_word

def main():
    text = open(CORPUS, encoding="utf-8").read()
    # <doc> представлен спец-токеном (id при кодировании), литералы убираем,
    # чтобы обучение и инференс видели одинаковые последовательности.
    text = text.replace("<doc>\n", "").replace("<doc>", "")
    print(f"корпус: {len(text)/1e6:.1f} МБ")
    sample = text[:SAMPLE_CHARS] + text[len(text)//2 : len(text)//2 + SAMPLE_CHARS//2]
    freq, merges = learn(sample)
    vocab = build_vocab(merges, text)
    vocab_ids = {s: i for i, s in enumerate(vocab)}
    print(f"мержей: {len(merges)}, итоговый словарь: {len(vocab)}")

    enc = encode_word_fn(vocab_ids, {m: i for i, m in enumerate(merges)})
    doc_id = vocab_ids["<doc>"]
    unk_id = vocab_ids["<unk>"]

    # Кодируем корпус: блоки разделены <doc>, слова — по мержам.
    import array
    ids = array.array("H")
    words_cache = {}
    n_unk = 0
    for block in text.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        ids.append(doc_id)
        for w in words(block.lower()):     # words() несёт в себе пробелы и \n
            wid = words_cache.get(w)
            if wid is None:
                wids = enc(w)
                if unk_id in wids:
                    n_unk += len(wids)
                wid = tuple(wids)
                words_cache[w] = wid
            ids.extend(wid)
    with open(BIN_OUT, "wb") as f:
        ids.tofile(f)
    total = len(ids)
    print(f"токенов: {total}, <unk>: {n_unk} ({100*n_unk/max(total,1):.2f}%)")
    json.dump({"vocab": vocab, "merges": [list(m) for m in merges]}, TOK_OUT and open(TOK_OUT, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"tokenizer.json: {os.path.getsize(TOK_OUT)/1e6:.2f} МБ")

if __name__ == "__main__":
    main()
