/* BLOOP AI — маленькая нейросеть (MLP: вход → скрытый ReLU → softmax)
   с обратным распространением ошибки. Чистый JS, без зависимостей:
   один и тот же код учится и на сервере (Node), и в браузере (APK).
   Вход разреженный — обновляются только веса активных признаков. */

function makeRng(seed) {
  let s = (seed >>> 0) || 42;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function createNet({ dim, hidden, classes, seed = 42 } = {}) {
  const rng = makeRng(seed);
  const W1 = new Float32Array(hidden * dim);
  const b1 = new Float32Array(hidden);
  const W2 = new Float32Array(classes * hidden);
  const b2 = new Float32Array(classes);

  // Инициализация: равномерный шум, масштаб под разреженный вход (~10 активных).
  const s1 = Math.sqrt(2 / 10);
  for (let i = 0; i < W1.length; i++) W1[i] = (rng() * 2 - 1) * s1;
  const s2 = Math.sqrt(2 / hidden);
  for (let i = 0; i < W2.length; i++) W2[i] = (rng() * 2 - 1) * s2;

  // Прямой проход: x — [{i, v}], возвращает { h, z1, probs }.
  function forward(x) {
    const z1 = b1.slice();
    for (const { i, v } of x) {
      if (i < 0 || i >= dim) continue;
      const base = i;
      for (let j = 0; j < hidden; j++) z1[j] += W1[j * dim + base] * v;
    }
    const h = new Float32Array(hidden);
    for (let j = 0; j < hidden; j++) h[j] = z1[j] > 0 ? z1[j] : 0;
    const z2 = b2.slice();
    for (let k = 0; k < classes; k++) {
      const row = k * hidden;
      let acc = 0;
      for (let j = 0; j < hidden; j++) acc += W2[row + j] * h[j];
      z2[k] = acc;
    }
    const max = Math.max(...z2);
    let sum = 0;
    const probs = new Float32Array(classes);
    for (let k = 0; k < classes; k++) {
      probs[k] = Math.exp(z2[k] - max);
      sum += probs[k];
    }
    for (let k = 0; k < classes; k++) probs[k] /= sum;
    return { z1, h, probs };
  }

  // Один шаг обучения (SGD, кросс-энтропия). Возвращает loss по примеру.
  function trainStep(x, y, lr, l2) {
    const { z1, h, probs } = forward(x);
    const loss = -Math.log(Math.max(probs[y], 1e-9));
    const dz2 = new Float32Array(classes);
    for (let k = 0; k < classes; k++) dz2[k] = probs[k] - (k === y ? 1 : 0);
    const dh = new Float32Array(hidden);
    for (let k = 0; k < classes; k++) {
      const row = k * hidden;
      const g = dz2[k];
      b2[k] -= lr * g;
      for (let j = 0; j < hidden; j++) {
        dh[j] += W2[row + j] * g;
        W2[row + j] -= lr * (g * h[j] + l2 * W2[row + j]);
      }
    }
    for (let j = 0; j < hidden; j++) {
      if (z1[j] <= 0) continue; // ReLU: градиент не течёт
      const g = dh[j];
      b1[j] -= lr * g;
      for (const { i, v } of x) {
        if (i < 0 || i >= dim) continue;
        const idx = j * dim + i;
        W1[idx] -= lr * (g * v + l2 * W1[idx]);
      }
    }
    return loss;
  }

  // Обучение: data — [{ x: [{i,v}], y }].
  function train(data, { epochs = 60, lr = 0.12, l2 = 1e-6, seed = 7 } = {}) {
    const shuffleRng = makeRng(seed);
    const order = data.map((_, i) => i);
    let lastLoss = 0;
    for (let e = 0; e < epochs; e++) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(shuffleRng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const stepLr = lr * (1 - e / (epochs * 1.6)); // лёгкий decay
      let sum = 0;
      for (const idx of order) {
        const { x, y } = data[idx];
        sum += trainStep(x, y, stepLr, l2);
      }
      lastLoss = sum / data.length;
    }
    return lastLoss;
  }

  // Предсказание: возвращает { probs, best, confidence }.
  function predict(x) {
    const { probs } = forward(x);
    let best = 0;
    for (let k = 1; k < classes; k++) if (probs[k] > probs[best]) best = k;
    return { probs, best, confidence: probs[best] };
  }

  return { dim, hidden, classes, forward, train, predict, trainStep };
}
