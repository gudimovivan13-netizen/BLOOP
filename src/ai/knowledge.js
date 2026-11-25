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
  'быть', 'был', 'была', 'было', 'будет', 'также', 'когда', 'чтобы', 'что', 'такой',
  'сдела', 'сделать', 'сделал', 'сделали', 'работа', 'работает', 'нужно', 'нужен',
  'нужна', 'можно', 'нельзя', 'хочу', 'хотел', 'очень', 'просто', 'лучше', 'делать',
  'делает', 'делают', 'давай', 'кажется', 'наверное', 'возможно', 'есть', 'говорят']);

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
    const baseStems = new Set();
    for (const raw of key.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
      if (raw.length < 3 || STOP.has(raw) || QWORDS.has(raw)) continue;
      const st = stem(raw);
      if (st.length >= 2) {
        qStems.add(st);
        baseStems.add(st);
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
      .filter(([ci, rec]) => {
        if (!(rec.m >= 2 || rec.s >= SINGLE_MIN)) return false;
        // Покрытие: большинство стемов запроса должны быть во фрагменте —
        // иначе «привт как дела» находит математику через слово «делит».
        const covered = rec.m >= baseStems.size ? 1 : rec.m / baseStems.size;
        if (qStems.size >= 2 && covered < 0.75) return false;
        return true;
      })
      .sort((a, b) => b[1].s - a[1].s)
      .slice(0, 3)
      .map(([ci, rec]) => ({
        chunk: chunks[ci],
        norm: (rec.s / Math.max(2, qStems.size)) * (chunks[ci].ty === 'book' ? 0.7 : 1),
      }));
    queryCache.set(key, best);
    return best;
  }

  // Возвращает лучший ответ или null (нет уверенного совпадения).
  function answer(question, minNorm = 0.9) {
    // Одиночная тема («что такое физика», «расскажи про ДНК»): отвечаем
    // только фрагментом, где тема в заголовке или в первых словах текста —
    // иначе побеждают случайные биографии со словом «физик».
    const topicHit = answerTopic(question);
    if (topicHit && topicHit !== 'NO_TOPIC') return topicHit;
    // NO_TOPIC решается ниже: уверенно близкий фрагмент или честное «не знаю».
    let hits = scoreQuery(question);
    // На «почему/зачем» стихи из книг отвечают невпопад.
    if (/^(почему|зачем)\b/i.test(question)) hits = hits.filter((h) => h.chunk.ty !== 'book' && h.norm >= 2);
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
    // Тема не найдена уверенно («вирус», «гравитация» без своих статей):
    // уверенно близкий фрагмент с честной пометкой — иначе «не знаю».
    if (topicHit === 'NO_TOPIC') {
      // «Похожее» принимаем, только если тема названа в начале фрагмента
      // или в заголовке — иначе «расскажи про ДНК» получает Суперинфекцию.
      const QW0 = new Set(['что', 'кто', 'такое', 'так', 'это', 'почему', 'зачем', 'где',
        'как', 'какой', 'какая', 'какие', 'расскажи', 'про', 'об', 'о', 'объясни', 'напиши',
        'мне', 'мой', 'моя', 'придумай', 'подбери', 'оцени']);
      const qStems0 = [];
      for (const raw of question.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
        if (raw.length < 3 || STOP.has(raw) || QW0.has(raw)) continue;
        const st = stem(raw);
        if (st.length >= 2) qStems0.push(st);
      }
      const normW = (x) => x.toLowerCase().replace(/\u0301/g, '').replace(/ё/g, 'е');
      const good = hits.filter((h) => {
        // Только фрагменты, чей заголовок начинается с темы и короче 3 слов:
        // «Встроенная функция (программирование)» да, «Двойной квазар» нет.
        const titleStems = normW(h.chunk.t).split(/[^\p{L}\p{N}]+/u).map((w) => stem(w));
        const defines0 = /\s—\s/.test(normW(h.chunk.s.slice(0, 140)));
        return titleStems.length <= 2 && titleStems[0] === qStems0[0] && defines0;
      });
      if (good.length && good[0].norm >= 1.6) {
        const cc = good[0].chunk;
        const src0 = cc.ty === 'wiki' ? 'энциклопедия' : cc.ty === 'book' ? 'книга' : 'код BLOOP';
        return `🔎 Точной статьи про это у меня пока нет, но близкое из ${src0} («${cc.t}»):\n📖 ${cc.s}`;
      }
      return null;
    }
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

  // Точечный ответ по одной теме: стем темы ищем в заголовке фрагмента
  // или в начале текста (там энциклопедия определяет понятие).
  function answerTopic(question) {
    const key = 'topic:' + question.toLowerCase();
    if (queryCache.has(key)) return queryCache.get(key);
    const QW = new Set(['что', 'кто', 'такое', 'так', 'это', 'почему', 'зачем',
      'где', 'как', 'какой', 'какая', 'какие', 'расскажи', 'про', 'об',
      'о', 'объясни', 'напиши', 'мне', 'мой', 'моя', 'придумай', 'подбери',
      'оцени', 'сделай', 'сгенерируй', 'идея', 'заголовок', 'описание',
      'стиле', 'стиль']);
    const stems = [];
    for (const raw of key.slice(6).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
      if (raw.length < 3 || STOP.has(raw) || QW.has(raw)) continue;
      const st = stem(raw);
      if (st.length >= 2) stems.push(st);
    }
    let out = null;
    if (stems.length === 1 || stems.length === 2) {
      const t = stems[0];
      const t2 = stems.length === 2 ? stems[1] : null;
      const person = /^(кто такой|кто такая|кто такие)\b/.test(key.slice(6));
      // Вики-текст содержит ударения (Физи́ка) и ё — чистим перед сравнением.
      const norm = (s) => s.toLowerCase().replace(/\u0301/g, '').replace(/ё/g, 'е');
      let best = null;
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const titleStems = norm(c.t).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => stem(w));
        const textStems = norm(c.s.slice(0, 140)).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => stem(w));
        const defines = /\s—\s/.test(norm(c.s.slice(0, 140)));
        let score = 0;
        const titleWords = norm(c.t).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
        if (t2) {
          // Составная тема («теория относительности», «база данных») —
          // только соседством стемов в заголовке или начале текста.
          const biTitle = titleStems.some((w, idx) => w === t && titleStems[idx + 1] === t2);
          const biText = textStems.some((w, idx) => w === t && textStems[idx + 1] === t2);
          if (!biTitle && !biText) continue;
          if (biTitle) score += 3;
          if (biText) score += 1.5;
        } else if (person) {
          // «кто такой Пушкин»: статья про персону (заголовок) или
          // произведение, начинающееся с пояснения («— поэма Пушкина»).
          const personIntro = textStems.slice(0, 8).includes(t) && defines;
          if (!(titleStems.includes(t) || personIntro)) continue;
          score += 3;
        } else {
          // Строгий режим: общая тема отвечает только точной статьёй с
          // однословным заголовком («Физика», «Математика»). Подтемы
          // («Алгоритм Ленстры» на «что такое алгоритм») не проходят —
          // лучше честное «не знаю», чем случайный раздел науки.
          if (!(titleWords.length === 1 && titleStems[0] === t)) continue;
          if (textStems[0] === t) score += 1.5;
          score += 3;
        }
        if (defines) score += 0.4;
        if (c.ty === 'wiki') score += 0.25;
        if (!best || score > best.score) best = { chunk: c, score };
      }
      const threshold = t2 ? 3.5 : 3;
      if (best && best.score >= threshold) {
        const c = best.chunk;
        const src = c.ty === 'wiki' ? 'энциклопедия' : c.ty === 'book' ? 'книга' : 'код BLOOP';
        out = `📖 ${c.s}\n\n— источник: ${src} («${c.t}»), знания BLOOP AI`;
      } else {
        // Тема есть, но уверенного определения нет — не фантазируем.
        out = 'NO_TOPIC';
      }
    }
    queryCache.set(key, out);
    return out;
  }

  return { answer, scoreQuery, size: chunks.length, chunk: (i) => chunks[i] };
}
