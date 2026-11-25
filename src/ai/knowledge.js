/* BLOOP AI — слой знаний: поиск по энциклопедии (статьи ~100 наук),
   книгам и коду проекта. Индекс: public/vendor/bloop-knowledge.json,
   поиск — IDF-взвешенное пересечение стемов. Работает офлайн. */

const SUFFIXES = [
  'ами', 'ями', 'ому', 'ему', 'ого', 'его', 'ыми', 'ими', 'ах', 'ях', 'ам',
  'ям', 'ая', 'яя', 'ое', 'ее', 'ый', 'ий', 'ой', 'ей', 'ым', 'им', 'ом',
  'ем', 'ий', 'ешь', 'ишь', 'ет', 'ют', 'ут', 'ат', 'ят', 'ит', 'ал', 'ял',
  'ел', 'ил', 'ла', 'ли', 'ло', 'ся', 'ть', 'ы', 'и', 'а', 'я', 'о', 'е',
  'у', 'ю', 'ь', 'й',
];
const STOP = new Set(['и', 'в', 'во', 'не', 'на', 'я', 'с', 'со', 'как', 'а', 'то',
  'все', 'но', 'да', 'ты', 'к', 'у', 'же', 'вы', 'за', 'бы', 'по', 'или', 'если',
  'уже', 'мне', 'меня', 'тебя', 'он', 'она', 'они', 'оно', 'это', 'эти', 'тут',
  'там', 'твой', 'мой', 'его', 'ее', 'их', 'для', 'от', 'до', 'из', 'при', 'об',
  'быть', 'был', 'была', 'было', 'будет', 'также', 'когда', 'чтобы', 'что', 'такой']);

function stem(w) {
  for (const suf of SUFFIXES) {
    if (w.length - suf.length >= 3 && w.endsWith(suf)) {
      w = w.slice(0, w.length - suf.length);
      break;
    }
  }
  return w;
}

export function createKnowledge(index) {
  const chunks = index.chunks;
  const post = index.post;
  const N = chunks.length;
  // IDF терма по числу фрагментов в постингах (аппроксимация).
  const idf = new Map();
  for (const t in post) idf.set(t, Math.log(N / (1 + post[t].length)));

  const queryCache = new Map();

  function scoreQuery(q) {
    const key = q.toLowerCase();
    if (queryCache.has(key)) return queryCache.get(key);
    // Служебные слова вопросов смысла не несут — в скоринг не идут.
    const QWORDS = new Set(['что', 'кто', 'как', 'такое', 'так', 'такой', 'это',
      'почему', 'зачем', 'где', 'какой', 'какая', 'какие', 'расскажи', 'объясни',
      'напиши', 'определи', 'опиши', 'суть', 'мой', 'моя', 'мне', 'про']);
    // Русско-английские синонимы: в коде проекта идентификаторы английские,
    // а спрашивают по-русски («функция» → function, «сортировка» → sort).
    const SYN = { функци: 'function', функц: 'function', сорт: 'sort', массив: 'array',
      класс: 'class', перемен: 'variable', сервер: 'server', запрос: 'request',
      строк: 'string', цикл: 'loop', список: 'list', файл: 'file', браузер: 'browser',
      польз: 'user', сообщ: 'message', чат: 'chat', пост: 'post', кнопк: 'button',
      сокет: 'socket', токен: 'token' };
    const qStems = new Set();
    for (const raw of key.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
      if (raw.length < 3 || STOP.has(raw) || QWORDS.has(raw)) continue;
      const st = stem(raw);
      if (st.length >= 2) {
        qStems.add(st);
        if (SYN[st]) qStems.add(SYN[st]);   // двойной счёт за концепт — сознательно
      }
    }
    // Считаем совпадения по каждому фрагменту: вес + сколько разных стемов.
    const scores = new Map(); // ci -> { s, m: Set }
    for (const st of qStems) {
      const plist = post[st];
      if (!plist) continue;
      const w = idf.get(st) || 1;
      for (const ci of plist) {
        const rec = scores.get(ci) || { s: 0, m: 0 };
        rec.s += w;
        rec.m += 1;
        scores.set(ci, rec);
      }
    }
    // Нужны ≥2 разных смысловых стема фрагменту ИЛИ один очень информативный
    // (idf высокий) — иначе частые слова открывают энциклопедию зря.
    const SINGLE_MIN = 2.2;
    const best = [...scores.entries()]
      .filter(([, rec]) => rec.m >= 2 || rec.s >= SINGLE_MIN)
      .sort((a, b) => b[1].s - a[1].s)
      .slice(0, 3)
      .map(([ci, rec]) => ({ chunk: chunks[ci], norm: rec.s / Math.max(2, qStems.size) }));
    queryCache.set(key, best);
    return best;
  }

  // Возвращает лучший ответ или null (нет уверенного совпадения).
  function answer(question, minNorm = 0.8) {
    const hits = scoreQuery(question);
    if (!hits.length || hits[0].norm < minNorm) return null;
    // Бонус за совпадение стемов запроса с заголовком: статья «Гравитация»
    // должна бить экзотические фрагменты со словом «гравитационный».
    const qStems = new Set();
    for (const raw of question.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
      if (raw.length >= 3 && !STOP.has(raw)) qStems.add(stem(raw));
    }
    for (const h of hits) {
      const titleStems = [...h.chunk.t.toLowerCase().split(/[\s«»,.—:()]+/)]
        .filter((w) => w.length >= 3 && !STOP.has(w)).map(stem);
      const overlap = titleStems.filter((st) => qStems.has(st)).length;
      h.norm += (overlap * 2.5) / Math.max(1, qStems.size);
      h.norm += (h.chunk.ty === 'wiki' ? 0.15 : 0); // энциклопедия чуть точнее отвечает на «что такое»
    }
    hits.sort((a, b) => b.norm - a.norm);
    if (hits[0].norm < minNorm) return null;
    // Кодовые запросы — к файлам кода: «напиши функцию» не должно
    // выдавать художественную прозу со случайным совпадением стема.
    const codeWant = /\b(код|функци|скрипт|программ|алгоритм|класс|массив|переменн|javascript|js|python|api|сервер|компонент|рефакторинг)\b/i.test(question);
    const codeHit = hits.find((h) => h.chunk.ty === 'code');
    if (codeWant && codeHit) {
      const { chunk } = codeHit;
      return `📖 ${chunk.s}\n\n— источник: код BLOOP (файл «${chunk.t}»), знания BLOOP AI`;
    }
    const { chunk } = hits[0];
    const src = chunk.ty === 'wiki' ? 'энциклопедия' : chunk.ty === 'book' ? 'книга' : 'код BLOOP';
    return `📖 ${chunk.s}\n\n— источник: ${src} («${chunk.t}»), знания BLOOP AI`;
  }

  return { answer, scoreQuery, size: chunks.length };
}
