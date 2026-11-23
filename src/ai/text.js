/* BLOOP AI — текстовые признаки: нормализация русского текста, стемминг,
   хэш-признаки (bag-of-words + символьные триграммы). Без зависимостей. */

const STOPWORDS = new Set([
  'и', 'в', 'во', 'не', 'на', 'я', 'с', 'со', 'как', 'а', 'то', 'все', 'но',
  'да', 'ты', 'к', 'у', 'же', 'вы', 'за', 'бы', 'по', 'или', 'если', 'уже',
  'мне', 'меня', 'тебя', 'он', 'она', 'они', 'оно', 'это', 'эти', 'тут',
  'там', 'твой', 'мой', 'его', 'ее', 'их', 'для', 'от', 'до', 'из', 'при',
  'о', 'об', 'быть', 'был', 'была', 'было', 'будет',
]);

const SUFFIXES = [
  'ами', 'ями', 'ому', 'ему', 'ого', 'его', 'ыми', 'ими', 'ах', 'ях', 'ам',
  'ям', 'ая', 'яя', 'ое', 'ее', 'ый', 'ий', 'ой', 'ей', 'ым', 'им', 'ом',
  'ем', 'ий', 'ешь', 'ишь', 'ет', 'ют', 'ут', 'ат', 'ят', 'ит', 'ал', 'ял',
  'ел', 'ил', 'ла', 'ли', 'ло', 'ся', 'ть', 'ы', 'и', 'а', 'я', 'о', 'е',
  'у', 'ю', 'ь', 'й',
];

// Нормализация: нижний регистр, ё→е, без пунктуации, одиночные пробелы.
export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s#]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Синонимизация стемов: одно понятие — один вектор признака.
const STEMS_ALIAS = {
  вирусн: 'вирус', вирусност: 'вирус', вируметр: 'вирус',
  нейросет: 'нейро', нейрон: 'нейро', нейронка: 'нейро',
  бот: 'бот', ботов: 'бот',
  клип: 'клип', клипов: 'клип', клипы: 'клип',
  пост: 'пост', поста: 'пост', постов: 'пост',
  хэштег: 'хэштег', хештег: 'хэштег', тег: 'хэштег', теги: 'хэштег',
  поиск: 'поиск', ищ: 'поиск',
  звон: 'звонок', звонок: 'звонок', звонк: 'звонок',
};

// Простой стеммер: отрезаем наиболее вероятное окончание.
export function stem(word) {
  let w = word;
  for (const suf of SUFFIXES) {
    if (w.length - suf.length >= 3 && w.endsWith(suf)) {
      w = w.slice(0, w.length - suf.length);
      break;
    }
  }
  return STEMS_ALIAS[w] || w;
}

// Значимые токены (стемы без стоп-слов и без одиночных букв).
export function tokens(s) {
  const out = [];
  for (const raw of normalize(s).split(' ')) {
    if (!raw || raw.length < 2 || STOPWORDS.has(raw)) continue;
    if (raw.startsWith('#')) { out.push(raw.slice(0, 24)); continue; }
    const st = stem(raw);
    if (st.length >= 2) out.push(st);
  }
  return out;
}

// FNV-1a 32-bit — быстрый детерминированный хэш.
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const WORD_SPACE = 2048;   // слоты под слова (с запасом на коллизии)
const BIGRAM_SPACE = 1024; // слоты под пары соседних слов
const GRAM_SPACE = 512;    // слоты под символьные триграммы
export const DIM = WORD_SPACE + BIGRAM_SPACE + GRAM_SPACE;

// Разреженный признаковый вектор: [{i, v}] — слова весом 1, биграммы 0.8,
// символьные триграммы 0.5. Биграммы разделяют близкие намерения
// («что делать» vs «что умеешь»).
export function features(s) {
  const norm = normalize(s);
  const map = new Map();
  const add = (i, v) => map.set(i, (map.get(i) || 0) + v);
  const toks = tokens(norm);
  toks.forEach((t, i) => {
    add(hash32(t) % WORD_SPACE, 1);
    if (i + 1 < toks.length) add(WORD_SPACE + (hash32(`${t}_${toks[i + 1]}`) % BIGRAM_SPACE), 0.8);
  });
  const padded = `_${norm.replace(/\s+/g, '_')}_`;
  for (let i = 0; i + 3 <= padded.length; i++) {
    add(WORD_SPACE + BIGRAM_SPACE + (hash32(padded.slice(i, i + 3)) % GRAM_SPACE), 0.5);
  }
  return [...map].map(([i, v]) => ({ i, v }));
}
