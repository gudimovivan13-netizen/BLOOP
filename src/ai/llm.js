/* BLOOP AI — языковая модель (декодер-трансформер), инференс на чистом JS.
   Веса экспортируются из scripts/llm/export.py (fp16 → base64) и грузятся
   одинаково на сервере (Node), в exe и в браузере (APK). Никаких внешних API.
   Арифметика повторяет scripts/llm/gpt_train.py: pre-norm, каузальное
   внимание с KV-кэшем, GELU, привязанная голова. */

function fp16ToFloat(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) return (s ? -1 : 1) * 6.103515625e-5 * (f / 1024);
  if (e === 0x1f) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

function b64ToF32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dv = new DataView(bytes.buffer);
  const n = bytes.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = fp16ToFloat(dv.getUint16(i * 2, true));
  return out;
}

const WORD_RE = /[ \n]*[а-яёa-z0-9]+:[а-яёa-z0-9]*|[ \n]*[а-яёa-z0-9]+|[ \n]*[^\sа-яёa-z0-9]/gi;

export function createBloopLLM(data) {
  const cfg = data.config;
  const d = cfg.d, L = cfg.L, heads = cfg.heads, T = cfg.ctx, V = cfg.vocab;
  const dh = d / heads;
  const invSqrtDh = 1 / Math.sqrt(dh);

  // Веса
  const W = {};
  for (const k of Object.keys(data.w)) W[k] = b64ToF32(data.w[k]);

  // Токенизатор
  const vocab = data.tok.vocab;
  const vocabIds = new Map(vocab.map((s, i) => [s, i]));
  const DOC = vocabIds.get('<doc>');
  const UNK = vocabIds.get('<unk>');
  const ranks = new Map();
  data.tok.merges.forEach(([l, r], i) => ranks.set(l + '\u0000' + r, i));

  const wordCache = new Map();
  function encodeWord(w) {
    let ids = wordCache.get(w);
    if (ids) return ids;
    let syms = [...w];
    while (syms.length > 1) {
      let bestRank = Infinity, bestI = -1;
      for (let i = 0; i + 1 < syms.length; i++) {
        const r = ranks.get(syms[i] + '\u0000' + syms[i + 1]);
        if (r !== undefined && r < bestRank) { bestRank = r; bestI = i; }
      }
      if (bestI < 0) break;
      syms.splice(bestI, 2, syms[bestI] + syms[bestI + 1]);
    }
    ids = syms.map((s) => vocabIds.get(s) ?? UNK);
    if (wordCache.size < 60000) wordCache.set(w, ids);
    return ids;
  }

  function encode(text) {
    const out = [];
    const words = String(text).toLowerCase().match(WORD_RE) || [];
    for (const w of words) out.push(...encodeWord(w));
    return out;
  }

  function decode(ids) {
    let s = '';
    for (const id of ids) s += vocab[id] ?? '';
    return s;
  }

  // ---------- трансформер с KV-кэшем ----------
  function newState() {
    const layers = [];
    for (let i = 0; i < L; i++) {
      layers.push({
        k: new Float32Array(T * heads * dh),
        v: new Float32Array(T * heads * dh),
      });
    }
    return { layers, pos: 0, tokens: [] };
  }

  function norm(g, b, x) {
    let mu = 0;
    for (let i = 0; i < d; i++) mu += x[i];
    mu /= d;
    let v = 0;
    for (let i = 0; i < d; i++) { const t = x[i] - mu; v += t * t; }
    const inv = 1 / Math.sqrt(v / d + 1e-5);
    const y = new Float32Array(d);
    for (let i = 0; i < d; i++) y[i] = (x[i] - mu) * inv * g[i] + b[i];
    return y;
  }

  function gelu(x) {
    return 0.5 * x * (1 + Math.tanh(0.7978845608 * (x + 0.044715 * x * x * x)));
  }

  // Один шаг: токен на позицию state.pos → обновить кэш → логиты.
  function step(st, tokenId, wantLogits) {
    const pos = st.pos;
    if (pos >= T) throw new Error('контекст переполнен');
    st.tokens.push(tokenId);
    let x = new Float32Array(d);
    const emb = W.tok_emb;
    const embBase = tokenId * d;
    for (let i = 0; i < d; i++) x[i] = emb[embBase + i] + W.pos_emb[pos * d + i];

    for (let li = 0; li < L; li++) {
      const pre = `l${li}_`;
      const stl = st.layers[li];
      const x0 = x;
      const h1 = norm(W[pre + 'ln1_g'], W[pre + 'ln1_b'], x0);
      const wqkv = W[pre + 'wqkv'], bqkv = W[pre + 'bqkv'];
      const qkv = new Float32Array(3 * d);
      for (let i = 0; i < d; i++) {
        const xi = h1[i], base = i * 3 * d;
        for (let j = 0; j < 3 * d; j++) qkv[j] += xi * wqkv[base + j];
      }
      for (let j = 0; j < 3 * d; j++) qkv[j] += bqkv[j];
      // k, v → кэш (раскладка как в обучении: c*(H*dh) + h*dh + t)
      const rowBase = pos * heads * dh;
      for (let i = 0; i < d; i++) {
        stl.k[rowBase + i] = qkv[d + i];
        stl.v[rowBase + i] = qkv[2 * d + i];
      }
      // внимание по головам
      const attn = new Float32Array(d);
      const scores = new Float32Array(pos + 1);
      for (let h = 0; h < heads; h++) {
        const q0 = h * dh;
        let maxs = -Infinity;
        for (let t2 = 0; t2 <= pos; t2++) {
          let s = 0;
          const kbase = t2 * heads * dh + h * dh;
          for (let t = 0; t < dh; t++) s += qkv[q0 + t] * stl.k[kbase + t];
          s *= invSqrtDh;
          scores[t2] = s;
          if (s > maxs) maxs = s;
        }
        let sum = 0;
        for (let t2 = 0; t2 <= pos; t2++) { scores[t2] = Math.exp(scores[t2] - maxs); sum += scores[t2]; }
        for (let t = 0; t < dh; t++) {
          let acc = 0;
          for (let t2 = 0; t2 <= pos; t2++) acc += scores[t2] * stl.v[t2 * heads * dh + h * dh + t];
          attn[q0 + t] = acc / sum;
        }
      }
      // выходной проект + остаток (wo — матрица (d,d): out[i] = Σ_j attn[j]*wo[j*d+i])
      const wo = W[pre + 'wo'], bo = W[pre + 'bo'];
      const x1 = new Float32Array(d);
      for (let i = 0; i < d; i++) {
        let acc = bo[i];
        for (let j = 0; j < d; j++) acc += attn[j] * wo[j * d + i];
        x1[i] = x0[i] + acc;
      }
      // MLP + остаток
      const h2 = norm(W[pre + 'ln2_g'], W[pre + 'ln2_b'], x1);
      const fc = W[pre + 'fc'], bfc = W[pre + 'bfc'];
      const fpre = new Float32Array(4 * d);
      for (let i = 0; i < d; i++) {
        const xi = h2[i], base = i * 4 * d;
        for (let j = 0; j < 4 * d; j++) fpre[j] += xi * fc[base + j];
      }
      for (let j = 0; j < 4 * d; j++) fpre[j] += bfc[j];
      const proj = W[pre + 'proj'], bproj = W[pre + 'bproj'];
      const x2 = new Float32Array(d);
      for (let i = 0; i < d; i++) x2[i] = x1[i] + bproj[i];
      for (let j = 0; j < 4 * d; j++) {
        const g = gelu(fpre[j]);
        if (g === 0) continue;
        const base = j * d;
        for (let i = 0; i < d; i++) x2[i] += g * proj[base + i];
      }
      x = x2;
    }
    st.pos++;
    if (!wantLogits) return null;
    const hf = norm(W.lnf_g, W.lnf_b, x);
    const logits = new Float32Array(V);
    for (let j = 0; j < V; j++) {
      let acc = 0;
      const base = j * d;
      for (let i = 0; i < d; i++) acc += hf[i] * emb[base + i];
      logits[j] = acc;
    }
    return logits;
  }

  // ---------- сэмплинг ----------
  function sampleToken(logits, st, opts) {
    const { temperature, topK, repWindow, repPenalty } = opts;
    for (let i = 0; i < V; i++) logits[i] /= temperature;
    const from = Math.max(0, st.tokens.length - repWindow);
    for (let i = from; i < st.tokens.length; i++) logits[st.tokens[i]] /= repPenalty;
    // top-k
    const idx = Array.from(logits.keys());
    idx.sort((a, b) => logits[b] - logits[a]);
    let sum = 0;
    const probs = new Float32Array(topK);
    for (let i = 0; i < topK; i++) { probs[i] = Math.exp(logits[idx[i]]); sum += probs[i]; }
    let r = Math.random() * sum;
    for (let i = 0; i < topK; i++) {
      r -= probs[i];
      if (r <= 0) return idx[i];
    }
    return idx[0];
  }

  // ---------- диалог ----------
  function chat(question, history = [], opts = {}) {
    const maxNew = Math.min(opts.maxTokens || 44, 60);
    const sOpts = {
      temperature: opts.temperature ?? 0.75,
      topK: opts.topK ?? 20,
      repWindow: 24,
      repPenalty: 1.18,
    };
    let prompt = '';
    for (const m of history.slice(-4)) {
      if (!m?.content) continue;
      prompt += (m.role === 'assistant' ? '\nb: ' : '\nп: ') + String(m.content).slice(0, 160);
    }
    prompt += '\nп: ' + String(question || '').slice(0, 240) + '\nb:';
    let ids = [DOC, ...encode(prompt)];
    if (ids.length + maxNew > T) ids = ids.slice(-(T - maxNew - 1));

    const st = newState();
    let logits = null;
    for (let i = 0; i < ids.length; i++) {
      // логиты нужны только после последнего токена промпта
      logits = step(st, ids[i], i === ids.length - 1);
    }
    const out = [];
    for (let n = 0; n < maxNew; n++) {
      // в начале ответа запрещаем конец документа и переводы строк,
      // иначе модель может «закрыть» реплику, не начав её
      if (n < 12) logits[DOC] = -1e9;
      if (n < 2) {
        for (let i = 0; i < V; i++) {
          if ((vocab[i] || '').startsWith('\n')) logits[i] = -1e9;
        }
      }
      const id = sampleToken(logits, st, sOpts);
      if (id === DOC || id === UNK) break;
      const piece = vocab[id] || '';
      const nl = piece.indexOf('\n');
      if (nl >= 0) {
        out.push(piece.slice(0, nl));
        break;
      }
      out.push(piece);
      logits = step(st, id, true);
    }
    let reply = out.join('').trim();
    if (!reply || reply.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return null;
    // аккуратные заглавные в начале предложений
    reply = reply.replace(/(^|[.!?…]\s+)([а-яёa-z])/g, (m0, p, ch) => p + ch.toUpperCase());
    return reply;
  }

  return { chat, encode, decode, config: cfg, _step: step, _newState: newState, _vocab: vocab, _sample: sampleToken };
}
