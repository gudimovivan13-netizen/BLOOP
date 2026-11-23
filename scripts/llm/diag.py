#!/usr/bin/env python3
"""Диагностика градиентов: rel-ошибка по каждой группе параметров."""
import numpy as np
from gpt_train import GPT

m = GPT(vocab=23, d=8, L=1, heads=2, ctx=8, dtype=np.float64)
rng = np.random.default_rng(0)
idx = rng.integers(0, 23, size=(2, 8))
tgt = rng.integers(0, 23, size=(2, 8))
loss, cache = m.forward(idx, tgt)
g = m.backward(cache, tgt)

for name in m.p:
    arr = m.p[name]
    gr = g[name]
    flats = rng.choice(arr.size, size=min(6, arr.size), replace=False)
    errs = []
    for fi in flats:
        eps = 1e-6
        orig = arr.ravel()[fi]
        arr.ravel()[fi] = orig + eps
        lp = m.loss_only(idx, tgt)
        arr.ravel()[fi] = orig - eps
        lm = m.loss_only(idx, tgt)
        arr.ravel()[fi] = orig
        num = (lp - lm) / (2 * eps)
        ana = gr.ravel()[fi]
        denom = max(1e-8, abs(num) + abs(ana))
        errs.append((abs(num - ana) / denom, float(num), float(ana)))
    worst = max(errs)
    status = "OK " if worst[0] < 2e-4 else "ПРОВАЛ"
    print(f"{status} {name:14s} worst_rel={worst[0]:.2e}  num={worst[1]:+.6f} ana={worst[2]:+.6f}")
