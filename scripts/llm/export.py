#!/usr/bin/env python3
"""Экспорт обученной модели для BLOOP AI: веса (fp16→base64) + токенизатор
в один JSON, который одинаково читается Node-сервером и браузером (APK)."""
import base64
import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "public", "vendor", "bloop-llm.json")

def main():
    w = dict(np.load(os.path.join(HERE, "weights.npz")))
    cfg = json.load(open(os.path.join(HERE, "model_config.json")))
    tok = json.load(open(os.path.join(HERE, "tokenizer.json"), encoding="utf-8"))
    shapes = {k: list(v.shape) for k, v in w.items()}
    out = {
        "config": cfg,
        "tok": {"vocab": tok["vocab"], "merges": tok["merges"]},
        "shapes": shapes,
        "w": {k: base64.b64encode(v.astype(np.float16).tobytes()).decode() for k, v in w.items()},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    total = sum(int(np.prod(s)) for s in shapes.values())
    print(f"экспорт: {len(w)} тензоров, {total/1e6:.2f} млн параметров, файл {os.path.getsize(OUT)/1e6:.2f} МБ")

if __name__ == "__main__":
    main()
