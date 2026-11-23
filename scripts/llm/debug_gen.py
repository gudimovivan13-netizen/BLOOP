#!/usr/bin/env python3
"""Отладка генерации: что реально выдаёт модель после промпта (numpy)."""
import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
w = dict(np.load(os.path.join(HERE, "weights.npz")))
tok = json.load(open(os.path.join(HERE, "tokenizer.json"), encoding="utf-8"))
cfg = json.load(open(os.path.join(HERE, "model_config.json")))
V = len(tok["vocab"]); d = cfg["d"]; L = cfg["L"]; H = cfg["heads"]; dh = d // H; T = cfg["ctx"]
DOC = tok["vocab"].index("<doc>")
ranks = {tuple(m): i for i, m in enumerate(tok["merges"])}
import re
WORD_RE = re.compile(r"[ \n]*[а-яёa-z0-9]+:[а-яёa-z0-9]*|[ \n]*[а-яёa-z0-9]+|[ \n]*[^\sа-яёa-z0-9]", re.I)

def encode_word(w):
    syms = list(w)
    while len(syms) > 1:
        best, bi = None, -1
        for i in range(len(syms) - 1):
            r = ranks.get((syms[i], syms[i + 1]))
            if r is not None and (best is None or r < best):
                best, bi = r, i
        if bi < 0:
            break
        syms[bi:bi + 2] = [syms[bi] + syms[bi + 1]]
    return [tok["vocab"].index(s) for s in syms]

def encode(text):
    out = []
    for w in WORD_RE.findall(text.lower()):
        out.extend(encode_word(w))
    return out

def ln(g, b, x):
    mu = x.mean(-1, keepdims=True)
    inv = 1 / np.sqrt(((x - mu) ** 2).mean(-1, keepdims=True) + 1e-5)
    return (x - mu) * inv * g + b

def gelu(x):
    return 0.5 * x * (1 + np.tanh(0.7978845608 * (x + 0.044715 * x ** 3)))

def forward_tokens(ids):
    """Полный forward без кэша (numpy): возвращает логиты последней позиции."""
    B, Tn = 1, len(ids)
    idx = np.array([ids])
    x = w["tok_emb"][idx] + w["pos_emb"][:Tn]
    mask = np.triu(np.full((Tn, Tn), -1e10), k=1)
    for i in range(L):
        p = f"l{i}_"
        h1 = ln(w[p + "ln1_g"], w[p + "ln1_b"], x)
        qkv = h1 @ w[p + "wqkv"] + w[p + "bqkv"]
        qkv = qkv.reshape(B, Tn, 3, H, dh).transpose(2, 0, 3, 1, 4)
        q, k, v = qkv[0], qkv[1], qkv[2]
        att = softmax(q @ k.transpose(0, 1, 3, 2) / np.sqrt(dh) + mask)
        o = (att @ v).transpose(0, 2, 1, 3).reshape(B, Tn, d)
        x = x + o @ w[p + "wo"] + w[p + "bo"]
        h2 = ln(w[p + "ln2_g"], w[p + "ln2_b"], x)
        fpre = h2 @ w[p + "fc"] + w[p + "bfc"]
        x = x + gelu(fpre) @ w[p + "proj"] + w[p + "bproj"]
    hf = ln(w["lnf_g"], w["lnf_b"], x)
    return hf[:, -1] @ w["tok_emb"].T

def softmax(x):
    e = np.exp(x - x.max(-1, keepdims=True))
    return e / e.sum(-1, keepdims=True)

def sample(logits, temp=0.85, topk=30):
    lg = logits[0] / temp
    idx = np.argsort(-lg)[:topk]
    pr = np.exp(lg[idx]); pr /= pr.sum()
    return int(np.random.choice(idx, p=pr))

def gen(prompt, n=40):
    ids = [DOC] + encode(prompt)
    print("промпт-токены:", len(ids))
    top = np.argsort(-forward_tokens(ids)[0])[:5]
    print("топ-5 после промпта:", [tok["vocab"][i] for i in top])
    out = []
    for _ in range(n):
        lg = forward_tokens(ids)
        nid = sample(lg)
        out.append(nid)
        s = tok["vocab"][nid]
        if nid == DOC or "\n" in s:
            print("стоп-токен:", repr(s))
            break
        ids.append(nid)
    return tok["vocab"][DOC] + "".join(tok["vocab"][i] for i in out)

prompt = "п: привет\nb:"
print("=== python генерация ===")
print(repr(gen(prompt)))
