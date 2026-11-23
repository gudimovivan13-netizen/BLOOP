#!/usr/bin/env python3
"""Обучение GPT-трансформера для BLOOP AI на numpy: ручной forward/backward
(pre-norm, каузальное внимание, GELU, привязанная голова), Adam, warmup+cosine,
градиентная проверка. Всё локально, без фреймворков.

  python3 gpt_train.py --gradcheck          # численная проверка градиентов
  python3 gpt_train.py --steps 3200         # обучение
"""
import argparse
import json
import math
import os
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = dict(d=128, L=2, heads=4, ctx=128, batch=12, vocab=None)


# ---------- базовые блоки ----------

def layernorm_forward(x, g, b, eps=1e-5):
    mu = x.mean(-1, keepdims=True)
    xc = x - mu
    var = (xc * xc).mean(-1, keepdims=True)
    inv = 1.0 / np.sqrt(var + eps)
    xhat = xc * inv
    return xhat * g + b, xhat, inv, xc

def layernorm_backward(dy, xhat, inv, g, xc):
    """dx для y = xhat*g + b (xhat = (x-mu)*inv)."""
    dg = (dy * xhat).sum(axis=(0, 1))
    db = dy.sum(axis=(0, 1))
    dx = (dy * g) * inv
    dx -= (dx.mean(-1, keepdims=True) + xhat * (dx * xhat).mean(-1, keepdims=True))
    return dx, dg, db

def gelu(x):
    return 0.5 * x * (1.0 + np.tanh(0.7978845608 * (x + 0.044715 * x * x * x)))

def gelu_grad(x):
    inner = 0.7978845608 * (x + 0.044715 * x * x * x)
    t = np.tanh(inner)
    return 0.5 * (1 + t) + 0.5 * x * (1 - t * t) * 0.7978845608 * (1 + 3 * 0.044715 * x * x)

def softmax(x, axis=-1):
    x = x - x.max(axis=axis, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=axis, keepdims=True)


# ---------- модель ----------

class GPT:
    def __init__(self, vocab, d=128, L=2, heads=4, ctx=128, dtype=np.float32):
        self.V, self.d, self.L, self.H, self.T = vocab, d, L, heads, ctx
        self.dh = d // heads
        self.dtype = dtype
        rng = np.random.default_rng(42)
        p = {}
        p["tok_emb"] = (rng.standard_normal((vocab, d)) * 0.02)
        p["pos_emb"] = (rng.standard_normal((ctx, d)) * 0.02)
        for i in range(L):
            pre = f"l{i}_"
            p[pre + "ln1_g"] = np.ones(d); p[pre + "ln1_b"] = np.zeros(d)
            p[pre + "wqkv"] = rng.standard_normal((d, 3 * d)) / math.sqrt(d)
            p[pre + "bqkv"] = np.zeros(3 * d)
            p[pre + "wo"] = rng.standard_normal((d, d)) / math.sqrt(d)
            p[pre + "bo"] = np.zeros(d)
            p[pre + "ln2_g"] = np.ones(d); p[pre + "ln2_b"] = np.zeros(d)
            p[pre + "fc"] = rng.standard_normal((d, 4 * d)) / math.sqrt(d)
            p[pre + "bfc"] = np.zeros(4 * d)
            p[pre + "proj"] = rng.standard_normal((4 * d, d)) / math.sqrt(4 * d)
            p[pre + "bproj"] = np.zeros(d)
        p["lnf_g"] = np.ones(d); p["lnf_b"] = np.zeros(d)
        self.p = {k: v.astype(dtype) for k, v in p.items()}

    def params(self):
        return list(self.p.values())

    def forward(self, idx, targets=None):
        """idx (B,T). Возвращает loss и кэш для backward."""
        B, T = idx.shape
        d, H, dh, p, dt = self.d, self.H, self.dh, self.p, self.dtype
        x = p["tok_emb"][idx] + p["pos_emb"][:T]
        cache = {"idx": idx, "layers": []}
        mask = np.triu(np.full((T, T), -1e10, dtype=dt), k=1)
        for i in range(self.L):
            pre = f"l{i}_"
            lc = {}
            h1, xhat1, inv1, xc1 = layernorm_forward(x, p[pre + "ln1_g"], p[pre + "ln1_b"])
            qkv = h1 @ p[pre + "wqkv"] + p[pre + "bqkv"]
            qkv = qkv.reshape(B, T, 3, H, dh).transpose(2, 0, 3, 1, 4)  # 3,B,H,T,dh
            q, k, v = qkv[0], qkv[1], qkv[2]
            att = (q @ k.transpose(0, 1, 3, 2)) / math.sqrt(dh) + mask
            att = softmax(att, axis=-1)
            o_h = att @ v                                 # B,H,T,dh
            o = o_h.transpose(0, 2, 1, 3).reshape(B, T, d)  # B,T,d
            a = o @ p[pre + "wo"] + p[pre + "bo"]
            x = x + a
            h2, xhat2, inv2, xc2 = layernorm_forward(x, p[pre + "ln2_g"], p[pre + "ln2_b"])
            fpre = h2 @ p[pre + "fc"] + p[pre + "bfc"]
            fg = gelu(fpre)
            f = fg @ p[pre + "proj"] + p[pre + "bproj"]
            x = x + f
            cache["layers"].append(dict(xhat1=xhat1, inv1=inv1, xc1=xc1, h1=h1,
                                        qkv=qkv, q=q, k=k, v=v, att=att, o=o_h,
                                        xhat2=xhat2, inv2=inv2, xc2=xc2, h2=h2,
                                        fpre=fpre, fg=fg))
        hf, xhatf, invf, xcf = layernorm_forward(x, p["lnf_g"], p["lnf_b"])
        cache.update(x=x, xhatf=xhatf, invf=invf, xcf=xcf, hf=hf)
        loss, probs = None, None
        if targets is not None:
            logits = hf @ p["tok_emb"].T                  # B,T,V
            probs = softmax(logits, axis=-1)
            N = logits.shape[0] * logits.shape[1]
            flat = probs.reshape(-1, self.V)
            loss = -np.log(np.maximum(flat[np.arange(N), targets.reshape(-1)], 1e-12)).mean()
            cache["probs"] = probs
        return loss, cache

    def backward(self, cache, targets):
        B, T = targets.shape
        d, H, dh, p = self.d, self.H, self.dh, self.p
        g = {k: np.zeros_like(v) for k, v in p.items()}
        probs = cache["probs"]
        N = B * T
        dlog = probs.reshape(N, self.V).copy()
        dlog[np.arange(N), targets.reshape(-1)] -= 1.0
        dlog /= N
        dlog = dlog.reshape(B, T, self.V)
        dhf = dlog @ p["tok_emb"]                        # B,T,d
        g["tok_emb"] += np.einsum("btv,btd->vd", dlog, cache["hf"])
        dx, dg, db = layernorm_backward(dhf, cache["xhatf"], cache["invf"], p["lnf_g"], cache["xcf"])
        g["lnf_g"] += dg; g["lnf_b"] += db
        for i in reversed(range(self.L)):
            pre = f"l{i}_"
            lc = cache["layers"][i]
            # --- MLP: x = x + gelu(h2@fc+bfc)@proj+bproj
            dfg = dx @ p[pre + "proj"].T
            g[pre + "proj"] += cache["layers"][i]["fg"].reshape(-1, 4 * d).T @ dx.reshape(-1, d)
            g[pre + "bproj"] += dx.reshape(-1, d).sum(0)
            dfpre = dfg * gelu_grad(lc["fpre"])
            dh2 = dfpre @ p[pre + "fc"].T
            g[pre + "fc"] += lc["h2"].reshape(-1, d).T @ dfpre.reshape(-1, 4 * d)
            g[pre + "bfc"] += dfpre.reshape(-1, 4 * d).sum(0)
            dx2, dg2, db2 = layernorm_backward(dh2, lc["xhat2"], lc["inv2"], p[pre + "ln2_g"], lc["xc2"])
            g[pre + "ln2_g"] += dg2; g[pre + "ln2_b"] += db2
            dx = dx + dx2                                 # остаток
            # --- attention: x = x + o@wo+bo
            do = dx
            g[pre + "wo"] += lc["o"].transpose(0, 2, 1, 3).reshape(-1, d).T @ do.reshape(-1, d)
            g[pre + "bo"] += do.reshape(-1, d).sum(0)
            dconc = do @ p[pre + "wo"].T                  # B,T,d
            do_h = dconc.reshape(B, T, H, dh).transpose(0, 2, 1, 3)  # B,H,T,dh
            att = lc["att"]
            dv = att.transpose(0, 1, 3, 2) @ do_h         # B,H,T,dh
            datt = do_h @ lc["v"].transpose(0, 1, 3, 2)   # B,H,T,T
            datt = att * (datt - (datt * att).sum(-1, keepdims=True))
            dq = (datt @ lc["k"]) / math.sqrt(dh)         # B,H,T,dh
            dk = (datt.transpose(0, 1, 3, 2) @ lc["q"]) / math.sqrt(dh)
            # (B,H,T,dh) × 3 --stack(axis=2)--> (B,H,3,T,dh)
            # --transpose(0,3,2,1,4)--> (B,T,3,H,dh) — как в forward
            dqkv = np.stack([dq, dk, dv], axis=2).transpose(0, 3, 2, 1, 4).reshape(B, T, 3 * d)
            dh1 = dqkv @ p[pre + "wqkv"].T
            g[pre + "wqkv"] += lc["h1"].reshape(-1, d).T @ dqkv.reshape(-1, 3 * d)
            g[pre + "bqkv"] += dqkv.reshape(-1, 3 * d).sum(0)
            dx1, dg1, db1 = layernorm_backward(dh1, lc["xhat1"], lc["inv1"], p[pre + "ln1_g"], lc["xc1"])
            g[pre + "ln1_g"] += dg1; g[pre + "ln1_b"] += db1
            dx = dx + dx1
        # входные эмбеддинги
        idx = cache["idx"]
        np.add.at(g["tok_emb"], idx.reshape(-1), dx.reshape(-1, d))
        g["pos_emb"] += dx.sum(0)
        return g

    def loss_only(self, idx, targets):
        loss, _ = self.forward(idx, targets)
        return float(loss)


# ---------- обучение ----------

def gradcheck():
    m = GPT(vocab=23, d=8, L=1, heads=2, ctx=8, dtype=np.float64)
    rng = np.random.default_rng(0)
    idx = rng.integers(0, 23, size=(2, 8))
    tgt = rng.integers(0, 23, size=(2, 8))
    loss, cache = m.forward(idx, tgt)
    g = m.backward(cache, tgt)
    names = ["l0_wqkv", "l0_fc", "l0_proj", "l0_wo", "lnf_g", "tok_emb", "pos_emb", "l0_bqkv", "l0_ln1_b"]
    worst = 0.0
    for name in names:
        arr = m.p[name]
        gr = g[name]
        flat = rng.choice(arr.size, size=min(12, arr.size), replace=False)
        for fi in flat:
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
            rel = abs(num - ana) / denom
            worst = max(worst, rel)
            if rel > 2e-4:
                print(f"ПРОВАЛ: {name}[{fi}] числ={num:.8f} аналит={ana:.8f} rel={rel:.2e}")
                return False
    print(f"градиентная проверка ПРОЙДЕНА (макс. относительная ошибка {worst:.2e})")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gradcheck", action="store_true")
    ap.add_argument("--steps", type=int, default=3200)
    ap.add_argument("--max-minutes", type=float, default=46.0)
    ap.add_argument("--init", default=None, help="weights.npz для продолжения обучения")
    ap.add_argument("--peak-lr", type=float, default=3e-3)
    ap.add_argument("--final-lr", type=float, default=2.5e-4)
    args = ap.parse_args()
    if args.gradcheck:
        ok = gradcheck()
        raise SystemExit(0 if ok else 1)

    toks = np.fromfile(os.path.join(HERE, "data", "tokens.bin"), dtype=np.uint16)
    toks = toks.astype(np.int32)
    tok = json.load(open(os.path.join(HERE, "tokenizer.json"), encoding="utf-8"))
    V = len(tok["vocab"])
    cut = int(len(toks) * 0.985)
    m = GPT(vocab=V, d=CFG["d"], L=CFG["L"], heads=CFG["heads"], ctx=CFG["ctx"])
    if args.init:
        loaded = dict(np.load(args.init))
        m.p = {k: v.astype(np.float32) for k, v in loaded.items() if k in m.p}
        print(f"веса загружены из {args.init}", flush=True)
    peak, final_lr, warm = args.peak_lr, args.final_lr, 150
    rng = np.random.default_rng(7)
    T, B, ctx = CFG["ctx"], CFG["batch"], CFG["ctx"]
    n_train = cut - T - 1
    log_path = os.path.join(HERE, "train_log.jsonl")
    logf = open(log_path, "a")

    def sample(n):
        i = rng.integers(0, n_train, size=n)
        x = np.stack([toks[j:j + T] for j in i])
        y = np.stack([toks[j + 1:j + T + 1] for j in i])
        return x, y

    valx, valy = sample(24)
    # валидация фиксированная
    vrng = np.random.default_rng(123)
    vi = vrng.integers(0, cut - T - 1, size=24)
    valx = np.stack([toks[j:j + T] for j in vi])
    valy = np.stack([toks[j + 1:j + T + 1] for j in vi])

    adam = {k: [np.zeros_like(v), np.zeros_like(v)] for k, v in m.p.items()}
    beta1, beta2, eps = 0.9, 0.95, 1e-8
    t0 = time.time()
    step_times = []
    print(f"параметров: {sum(v.size for v in m.p.values())/1e6:.2f} млн, токенов: {len(toks)/1e6:.1f} млн", flush=True)
    for step in range(1, args.steps + 1):
        if (time.time() - t0) / 60 > args.max_minutes:
            print("лимит времени — сохраняюсь и выхожу", flush=True)
            break
        x, y = sample(B)
        loss, cache = m.forward(x, y)
        g = m.backward(cache, y)
        # clip
        norm = math.sqrt(sum(float((gr * gr).sum()) for gr in g.values()))
        if norm > 1.0:
            s = 1.0 / norm
            for gr in g.values():
                gr *= s
        lr = peak * (step / warm) if step < warm else final_lr + (peak - final_lr) * 0.5 * (1 + math.cos(math.pi * (step - warm) / max(1, args.steps - warm)))
        for k in m.p:
            mk, vk = adam[k]
            gr = g[k]
            mk *= beta1; mk += (1 - beta1) * gr
            vk *= beta2; vk += (1 - beta2) * (gr * gr)
            mh = mk / (1 - beta1 ** step)
            vh = vk / (1 - beta2 ** step)
            m.p[k] -= lr * mh / (np.sqrt(vh) + eps)
        if step % 20 == 0 or step == 1:
            dt_step = (time.time() - t0) / step
            entry = dict(step=step, loss=round(float(loss), 4), lr=round(lr, 6), sec_per_step=round(dt_step, 3))
            print(json.dumps(entry, ensure_ascii=False), flush=True)
            logf.write(json.dumps(entry) + "\n"); logf.flush()
        if step % 400 == 0:
            vl = np.mean([m.loss_only(valx[j:j+1], valy[j:j+1]) for j in range(24)])
            print(json.dumps(dict(step=step, val_loss=round(float(vl), 4))), flush=True)
            logf.write(json.dumps(dict(step=step, val_loss=round(float(vl), 4))) + "\n"); logf.flush()
            np.savez(os.path.join(HERE, "weights.npz"), **m.p)
        if step == args.steps:
            vl = np.mean([m.loss_only(valx[j:j+1], valy[j:j+1]) for j in range(24)])
            print(json.dumps(dict(step=step, val_loss=round(float(vl), 4), final=True)), flush=True)
            logf.write(json.dumps(dict(step=step, val_loss=round(float(vl), 4), final=True)) + "\n")
    np.savez(os.path.join(HERE, "weights.npz"), **m.p)
    json.dump(dict(d=CFG["d"], L=CFG["L"], heads=CFG["heads"], ctx=CFG["ctx"], vocab=V), open(os.path.join(HERE, "model_config.json"), "w"))
    logf.close()
    print("обучение завершено", flush=True)

if __name__ == "__main__":
    main()
