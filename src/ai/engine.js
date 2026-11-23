/* BLOOP AI — движок: обучение классификатора намерений, генерация ответов.
   Работает одинаково в Node (сервер) и в браузере (APK): никаких
   импортов Node-модулей и никаких внешних API. */

import { DIM, features, normalize, tokens } from './text.js';
import { createNet } from './net.js';
import * as D from './data.js';

const HIDDEN = 64;
const CONFIDENT = 0.42; // ниже — честный fallback вместо угадывания

// Гибридный слой: однозначные доменные слова уточняют решение нейросети.
// Проверка по стемам-токенам (а не подстрокам): «работает» не должна
// ловить «бот», «вируметр» — это «вирус» после синонимизации.
function domainIntent(q) {
  const ts = tokens(q);
  const has = (...set) => ts.some((t) => set.includes(t));
  if (has('вирус') || /залет|просмотр/.test(q)) return 'virus_score';
  if (has('хэштег')) return 'hashtag_idea';
  if (has('подпис')) return 'caption_idea';
  if (has('клип', 'ролик', 'рилс')) return 'clip_idea';
  if (has('стил')) return 'style_post';
  if (has('бот', 'миниапп', 'микрофон', 'звонок', 'поиск')) return 'app_help';
  if (has('групп', 'канал', 'участник') && has('как', 'где', 'созда', 'добав', 'чат', 'чата')) return 'app_help';
  return null;
}

// Итоговое намерение: нейросеть + подстраховка ключевыми словами.
function resolveIntent(q, names, prediction) {
  let intent = names[prediction.best];
  const domain = domainIntent(q);
  if (domain) intent = domain;
  return intent;
}

// Подтема «помощи по приложению» по ключевым словам вопроса.
function helpSubtopic(q) {
  const n = normalize(q);
  if (/(поиск|найти|искать)/.test(n)) return 'help_search';
  if (/(звон|голосов|микрофон|камер)/.test(n)) return 'help_calls';
  if (/(бот|миниапп)/.test(n)) return 'help_bots';
  return 'help_groups';
}

function pick(list, rng) {
  return list[Math.floor(rng() * list.length)];
}

function fill(template, ctx) {
  return template.replaceAll('{name}', ctx.name || 'друг');
}

// Марковская цепь 2-го порядка: генерирует текст в стиле примеров.
function makeMarkov(texts, rng) {
  const sentences = texts
    .flatMap((t) => String(t).split(/[.!?;\n]+/))
    .map((s) => s.trim().split(/\s+/).filter((w) => w.length > 1 && w.length < 24))
    .filter((w) => w.length >= 4);
  if (sentences.length < 6) return null;
  const starts = [];
  const chain = new Map();
  for (const words of sentences) {
    starts.push(`${words[0]} ${words[1]}`);
    for (let i = 0; i + 2 < words.length; i++) {
      const key = `${words[i]} ${words[i + 1]}`;
      if (!chain.has(key)) chain.set(key, []);
      chain.get(key).push(words[i + 2]);
    }
  }
  return function generate() {
    let key = pick(starts, rng);
    const out = key.split(' ');
    for (let step = 0; step < 26; step++) {
      const next = chain.get(key);
      if (!next) break;
      const w = pick(next, rng);
      out.push(w);
      key = `${out[out.length - 2]} ${out[out.length - 1]}`;
    }
    let text = out.join(' ');
    if (text.length > 220) text = text.slice(0, 220);
    text = text.charAt(0).toUpperCase() + text.slice(1);
    return `${text.trim()}.`;
  };
}

// Вирусометр: признаковая оценка текста 0–100 + советы.
function virusScore(text) {
  const raw = String(text || '');
  const words = raw.split(/\s+/).filter(Boolean);
  const unique = new Set(words.map((w) => w.toLowerCase().replace(/[^а-яёa-z0-9]/gi, ''))).size;
  const emoji = (raw.match(/\p{Extended_Pictographic}/gu) || []).length;
  const tags = (raw.match(/#[\wа-яё]+/gi) || []).length;
  const capsWords = (raw.match(/\b[А-ЯЁA-Z]{3,}\b/g) || []).length;
  const len = words.length;

  const feats = [];
  feats.push(['base', 0.0]);
  feats.push([len >= 8 && len <= 70, 0.55]);          // комфортная длина
  feats.push([len < 8, -0.5]);
  feats.push([len > 120, -0.35]);
  feats.push([raw.includes('?'), 0.45]);              // вопрос вовлекает
  feats.push([tags >= 3 && tags <= 5, 0.4]);
  feats.push([tags === 0, -0.25]);
  feats.push([tags > 5, -0.3]);
  feats.push([emoji >= 1 && emoji <= 3, 0.25]);
  feats.push([emoji > 6, -0.3]);
  feats.push([capsWords > 1, -0.35]);
  feats.push([len > 15 && unique / Math.max(len, 1) > 0.85, 0.3]); // уникальность
  feats.push([/(моя|мой|я |мне|у меня)/i.test(raw), 0.2]);         // личная история

  let z = 0.35;
  for (const [on, w] of feats) if (on) z += w;
  const score = Math.max(5, Math.min(98, Math.round(100 / (1 + Math.exp(-z)))));

  // Советы: только по реально слабым местам, максимум 2.
  const active = new Set(feats.filter(([on]) => on).map(([name]) => name));
  const failed = [];
  for (const t of D.VIRUS_TIPS) {
    const bad =
      (t.check === 'short' && len < 8) ||
      (t.check === 'long' && len > 120) ||
      (t.check === 'question' && !raw.includes('?')) ||
      (t.check === 'tags' && tags === 0) ||
      (t.check === 'many_tags' && tags > 5) ||
      (t.check === 'emoji' && emoji === 0) ||
      (t.check === 'many_emoji' && emoji > 6) ||
      (t.check === 'caps' && capsWords > 1) ||
      (t.check === 'unique' && len > 15 && unique / Math.max(len, 1) <= 0.85);
    if (bad) failed.push(t.tip);
  }
  return { score, tips: failed.slice(0, 2), emoji, tags, len };
}

export function createBloopAI({ seed = 42 } = {}) {
  const rng = makeLocalRng(seed);
  const names = D.INTENTS.map((i) => i.name);
  const classOf = new Map(names.map((n, i) => [n, i]));

  function buildDataset(examples) {
    return examples.map(({ text, intent }) => ({
      x: features(text),
      y: classOf.get(intent),
    }));
  }

  const all = [];
  D.INTENTS.forEach((intent) => {
    intent.examples.forEach((text) => all.push({ text, intent: intent.name }));
  });
  const net = createNet({ dim: DIM, hidden: HIDDEN, classes: names.length, seed });
  const finalLoss = net.train(buildDataset(all), { epochs: 90, lr: 0.14, seed });

  const memory = { intent: null, lastTopic: null };

  // ---------- генераторы ----------
  function topicFor(ctx) {
    const pool = [...(ctx.trends || []), ...(ctx.tags || [])].filter(Boolean);
    if (pool.length && rng() < 0.55) return `что-нибудь про ${pick(pool, rng).replace('#', '')}`;
    let topic = pick(D.TOPICS, rng);
    if (topic === memory.lastTopic) topic = pick(D.TOPICS, rng);
    memory.lastTopic = topic;
    return topic;
  }

  function genPostIdea(ctx) {
    const topic = topicFor(ctx);
    const angle = pick(D.ANGLES, rng);
    const hash = (t) => (String(t).startsWith('#') ? String(t) : `#${t}`);
    const tagPool = ['#bloop', ...(ctx.tags || []).map(hash), ...(ctx.trends || []).map(hash), ...D.HASHTAG_BASE];
    const tags = [...new Set(tagPool)].slice(0, 4).join(' ');
    return `Идея поста: «${topic}» ✍️\n${angle}\nХэштеги: ${tags}`;
  }

  function genCaption() {
    return `Подпись: ${pick(D.CAPTION_FORMULAS, rng)} ✨`;
  }

  function genClip() {
    return `Идея клипа 🎬: ${pick(D.CLIP_SCENARIOS, rng)}\nСнимать прямо в BLOOP — камера встроена.`;
  }

  function genHashtags(question, ctx) {
    // Фильтруем служебные слова уже в виде стемов (как они приходят из tokens()).
    const serviceStems = new Set(tokens('подбери хэштеги хештег теги тег какие поставить нужны тренд тренды для моих'));
    const topicWords = tokens(question).filter((w) => w.length > 3 && !serviceStems.has(w)).slice(0, 3);
    const hash = (t) => (String(t).startsWith('#') ? String(t) : `#${t}`);
    const pool = [...topicWords.map(hash), ...(ctx.tags || []).map(hash), ...(ctx.trends || []).map(hash), ...D.HASHTAG_BASE];
    const tags = [...new Set(pool)].slice(0, 6);
    const trendLine = (ctx.trends && ctx.trends.length)
      ? `\nСейчас в трендах BLOOP: ${ctx.trends.slice(0, 5).map((t) => `#${t}`).join(' ')}`
      : '';
    return `Хэштеги: ${tags.join(' ')}${trendLine}\nНе больше 5 на пост — так алгоритм лучше поймёт тему.`;
  }

  function genStylePost(ctx) {
    const gen = makeMarkov(ctx.texts || [], rng);
    if (!gen) {
      return `Чтобы поймать твой стиль, мне нужно больше текстов 📝 Опубликуй пару постов — и я начну писать «как ты». А пока держи идею:\n${genPostIdea(ctx)}`;
    }
    return `Вот пост в твоём стиле ✍️\n\n«${gen()}»\n\nСобрано из твоих публикаций — локально, ни один байт не улетел.`;
  }

  function genVirus(question) {
    const draft = (() => {
      const m = /(?:оцени|проверь|вируметр)[^:]*:?\s*(.+)/i.exec(question);
      const candidate = m ? m[1] : question;
      return candidate.replace(/^(мой\s+)?(пост|текст)\s*:?\s*/i, '').trim() || question;
    })();
    const { score, tips } = virusScore(draft);
    const face = score >= 75 ? '🔥 отличная вирусность' : score >= 55 ? '👍 неплохо' : '🌱 есть куда расти';
    return `Вирусометр BLOOP AI: ${score}/100 — ${face}\n${tips.length ? 'Советы:\n• ' + tips.join('\n• ') : 'Слабых мест не нашёл — публиковать можно смело!'}`;
  }

  function genHelpApp(kind) {
    const pools = { help_search: D.HELP_SEARCH, help_calls: D.HELP_CALLS, help_bots: D.HELP_BOTS, help_groups: D.HELP_GROUPS };
    return pick(pools[kind] || D.HELP_SEARCH, rng);
  }

  // ---------- публичный интерфейс ----------
  function classify(question) {
    return net.predict(features(question));
  }

  function answer(question, ctx = {}) {
    const q = String(question || '').trim();
    const { best, confidence } = classify(q);
    const intent = resolveIntent(q, names, { best, confidence });
    let reply;

    if (confidence < CONFIDENT) {
      reply = fill(pick(D.FALLBACK_REPLIES, rng), ctx);
      memory.intent = null;
    } else if (intent === 'more' && memory.intent) {
      reply = retryLast(ctx);
    } else {
      const generators = {
        greet: () => fill(pick(D.GREET_REPLIES, rng), ctx),
        help: () => pick(D.HELP_REPLY, rng),
        about: () => pick(D.ABOUT_REPLIES, rng),
        post_idea: () => genPostIdea(ctx),
        caption_idea: () => genCaption(),
        hashtag_idea: () => genHashtags(q, ctx),
        clip_idea: () => genClip(),
        virus_score: () => genVirus(q),
        style_post: () => genStylePost(ctx),
        more: () => genPostIdea(ctx),
        smalltalk: () => fill(pick(D.SMALLTALK_REPLIES, rng), ctx),
        thanks: () => pick(D.THANKS_REPLIES, rng),
        bye: () => fill(pick(D.BYE_REPLIES, rng), ctx),
        app_help: () => genHelpApp(helpSubtopic(q)),
      };
      reply = (generators[intent] || generators.post_idea)();
      memory.intent = intent;
    }
    return { reply, intent, confidence };
  }

  function retryLast(ctx) {
    const again = {
      post_idea: () => genPostIdea(ctx),
      caption_idea: () => genCaption(),
      clip_idea: () => genClip(),
      hashtag_idea: () => genHashtags('', ctx),
      style_post: () => genStylePost(ctx),
      virus_score: () => 'Напиши текст поста после слова «оцени:» — и я прогоню его через Вирусометр 🔥',
      app_help: () => 'Уточни, о чём речь: поиск 🔍, звонки 📞, боты 🤖 или группы 👥 — и я подскажу по шагам.',
    }[memory.intent];
    return again ? again() : genPostIdea(ctx);
  }

  return {
    answer,
    classify,
    names,
    finalLoss,
    examplesCount: all.length,
  };
}

// Самопроверка: обучаем на 85% примеров, меряем точность на 15%.
export function selfTest({ seed = 42 } = {}) {
  const rng = makeLocalRng(seed);
  const names = D.INTENTS.map((i) => i.name);
  const classOf = new Map(names.map((n, i) => [n, i]));
  const all = [];
  D.INTENTS.forEach((intent) => intent.examples.forEach((text) => all.push({ text, intent: intent.name })));
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const cut = Math.floor(all.length * 0.85);
  const trainSet = all.slice(0, cut);
  const testSet = all.slice(cut);
  const net = createNet({ dim: DIM, hidden: HIDDEN, classes: names.length, seed });
  net.train(trainSet.map(({ text, intent }) => ({ x: features(text), y: classOf.get(intent) })), { epochs: 90, lr: 0.14, seed });
  let ok = 0;
  const errors = [];
  for (const { text, intent } of testSet) {
    const resolved = resolveIntent(text, names, net.predict(features(text)));
    if (resolved === intent) ok++;
    else errors.push(`«${text}» → ${resolved} (ожидалось ${intent})`);
  }
  return { accuracy: ok / testSet.length, tested: testSet.length, errors };
}

function makeLocalRng(seed) {
  let s = (seed >>> 0) || 42;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
