/* Кампания проверки диалогов BLOOP AI: ~200 вопросов × 12 категорий.
   Грейдер ловит мусор: выдуманные слова, обрывки диалога, повторы,
   англ. вставки, фантазии вместо честного «не знаю». */
import fs from 'node:fs';
import { createBloopAI } from '../../src/ai/engine.js';
import { createBloopLLM } from '../../src/ai/llm.js';
import { stem } from '../../src/ai/text.js';

const ai = createBloopAI();
try { ai.attachKnowledge(JSON.parse(fs.readFileSync('public/vendor/bloop-knowledge.json', 'utf8'))); } catch (e) { console.warn('knowledge не загрузился:', e.message); }
let llm = null;
try { llm = createBloopLLM(JSON.parse(fs.readFileSync('public/vendor/bloop-llm.json', 'utf8'))); } catch (e) { console.warn('llm не загрузился:', e.message); }

// словарь настоящих слов (как в engine gate) — из знаний
const GATE = new Set();
try {
  const idx = JSON.parse(fs.readFileSync('public/vendor/bloop-knowledge.json', 'utf8'));
  const chunks = idx.chunks || idx.c || [];
  for (const c of chunks) {
    const s = c.s || c.text || '';
    for (const w of s.toLowerCase().split(/[^а-яё]+/)) {
      if (w.length >= 4 && w.length <= 24) GATE.add(w);
    }
  }
} catch { /* без словаря */ }
const GATE_STEMS = new Set([...GATE].map((w) => stem(w)));
const GATE_NORM = new Set([...GATE].map((w) => w.replace(/\u0301/g, '').replace(/ё/g, 'е')));

const CATEGORIES = {
  identity: ['как тебя зовут?', 'кто ты', 'ты нейросеть?', 'ты робот?', 'ты человек?', 'твоё имя', 'ты бот?', 'ты живой?', 'расскажи о себе', 'кто я говорю с'],
  smalltalk: ['привет', 'здорова', 'как дела?', 'как настроение?', 'что делаешь?', 'скучно', 'мне грустно', 'ты классный', 'люблю тебя', 'спасибо', 'пока', 'доброе утро', 'какой сегодня день?', 'чем займёмся?', 'а что ты умеешь'],
  apphelp: ['как позвонить другу', 'как сменить тему', 'как создать бота', 'как выложить пост', 'как удалить аккаунт', 'где мои сохранённые посты', 'как записать клип', 'как добавить друга', 'звонки работают?', 'как сделать группу'],
  knowledge: ['что такое физика?', 'что такое биология', 'что такое гравитация', 'что такое фотосинтез', 'что такое чёрная дыра', 'что такое квантовая физика', 'расскажи про ДНК', 'что такое водород', 'что такое кислород', 'что такое Солнце', 'что такое Луна', 'что такое Марс', 'кто такой Пушкин', 'кто такой Достоевский', 'кто такой Шекспир', 'что такое эволюция', 'что такое клетка', 'что такое ген', 'что такое атмосфера', 'что такое вулкан', 'что такое землетрясение', 'что такое алгоритм', 'что такое математика', 'что такое геометрия', 'что такое тригонометрия', 'что такое философия', 'что такое психология', 'что такое история', 'что такое импрессионизм', 'кто такой Бах', 'кто такой Чайковский', 'что такое теория относительности', 'что такое интернет', 'что такое компьютер', 'что такое Олимпиада', 'что такое демократия', 'что такое экономика', 'что такое инфляция', 'что такое язык программирования', 'что такое молния', 'что такое радуга', 'что такое океан', 'что такое климат', 'что такое бактерия', 'что такое вирус', 'что такое антибиотик', 'что такое телескоп'],
  tricky: ['зачем люди ссорятся', 'в чём смысл жизни', 'кто я такой', 'что будет после смерти', 'есть ли бог', 'кто выиграет чемпионат мира', 'почему я такой усталый', 'как стать знаменитым', 'стоит ли влюбляться', 'почему небо голубое', 'что делать если скучно', 'как забыть бывшую', 'почему коты мурлычут', 'зачем учиться', 'будет ли конец света'],
  generative: ['придумай пост', 'придумай пост про осень', 'подбери хэштеги для фото с моря', 'идея клипа', 'напиши в моем стиле', 'оцени пост: Сегодня купил новый телефон! #техно #фото', 'придумай описание профиля', 'ещё', 'что написать девушке', 'придумай заголовок для поста про спорт'],
  nonsense: ['абракадабра', 'skjfhs skdf', '12345', '???', '......', 'ыыыы', 'фывапролдж', 'qwerty', 'блаблабла блаблабла блаблабла', ')(*&^%'],
  short: ['что', 'как', 'почему', 'а?', 'да', 'ок', 'ну', 'эээ', 'хм', 'что?'],
  mixed: ['what is physics', 'hello how are you', 'привеt как дела', 'что такое love', 'tell me about space', 'как дела my friend', 'что такое python', 'hi', 'пока bye', 'что такое алгоритм algorithm'],
  code: ['напиши функцию сортировки', 'что такое переменная', 'что такое цикл for', 'что такое массив', 'что такое класс', 'что такое git', 'что такое API', 'что такое HTML', 'что такое база данных', 'что такое рекурсия'],
  typos: ['привт как дела?', 'чот такое физика', 'квиантовая физика что это', 'кто ткой пушкин', 'что ткое фотосинтез', 'расскаи про днк', 'как пазвонить другу', 'что такое граvитация', 'превет', 'чтото скучно что делать'],
};

const HONEST_RE = /я пока не знаю|Честно: не знаю|в моих знаниях нет/i;

function detectGarbage(reply) {
  if (!reply || !reply.trim()) return true;
  const r = reply.trim();
  if (r.length < 8 || r.length > 700) return true;
  if (/^[—\-–]/.test(r)) return true;
  const words = r.toLowerCase().replace(/\u0301/g, '').replace(/ё/g, 'е').split(/[\s,.!?…:;«»()\-—]+/).filter((w) => w.length > 2);
  const freq = Object.create(null);
  const dupLimit = r.length > 260 ? 6 : 3;
  for (const w of words) { freq[w] = (freq[w] || 0) + 1; if (freq[w] >= dupLimit) return true; }
  if (words.length < 1) return true;
  // выдуманные слова: длинные кириллические, которых нет в словаре
  const cyr = r.toLowerCase().replace(/\u0301/g, '').replace(/ё/g, 'е').split(/[^а-я]+/).filter((w) => w.length >= 4);
  if (cyr.length >= 2) {
    let known = 0;
    for (const w of cyr) if (GATE.has(w) || GATE_NORM.has(w) || GATE_STEMS.has(stem(w))) known++;
    if (known / cyr.length < 0.6) return true;
  }
  return false;
}

const ctx = {
  name: 'Тест', tags: ['спорт', 'музыка'], trends: ['закат', 'клипы'],
  texts: ['Сегодня гулял с друзьями, было классно.', 'Завтра на пробежку.'],
};

let total = 0, okCount = 0, honestCount = 0, garbageCount = 0;
const perCat = {};
const fails = [];

for (const [cat, questions] of Object.entries(CATEGORIES)) {
  perCat[cat] = { total: 0, ok: 0, honest: 0, garbage: 0 };
  for (const q of questions) {
    total++;
    perCat[cat].total++;
    let reply = '', intent = '';
    try {
      const r = ai.answer(q, ctx, { llm: llm ? (qq) => llm.chat(qq, []) : null });
      reply = r.reply; intent = r.intent;
    } catch (e) {
      reply = ''; intent = 'ERROR: ' + e.message;
    }
    const isHelp = /^(help|app_help|honest)$/.test(intent);
    const honest = HONEST_RE.test(reply);
    const garbage = !honest && !isHelp && detectGarbage(reply);
    let verdict;
    if (garbage) { verdict = 'garbage'; garbageCount++; perCat[cat].garbage++; }
    else if (honest) {
      verdict = 'honest'; honestCount++; perCat[cat].honest++;
      // «не знаю» на точный вопрос из энциклопедии — промах знаний
      if ((cat === 'knowledge' || cat === 'code') && intent !== 'honest') verdict = 'miss';
    } else { verdict = 'ok'; okCount++; perCat[cat].ok++; }
    if (verdict === 'garbage' || verdict === 'miss') {
      fails.push({ cat, q, intent, verdict, reply: reply.slice(0, 130) });
    }
  }
}

console.log('GATE:', GATE.size, 'слов');
console.log('=== КАТЕГОРИИ (ok/honest/miss+garbage из total) ===');
for (const [cat, s] of Object.entries(perCat)) {
  const bad = s.garbage + (cat === 'knowledge' || cat === 'code' ? s.honest : 0);
  console.log(`${cat.padEnd(12)} ok:${String(s.ok).padStart(2)} honest:${String(s.honest).padStart(2)} bad:${String(bad).padStart(2)} из ${s.total}`);
}
console.log(`\nВСЕГО: ${total} | чисто: ${okCount} | честное «не знаю»: ${honestCount} | МУСОР: ${garbageCount}`);
console.log(`Доля мусора: ${(garbageCount / total * 100).toFixed(1)}%`);
if (fails.length) {
  console.log('\n=== ПРОВАЛЫ (нужно исправить) ===');
  for (const f of fails) console.log(`[${f.cat}/${f.verdict}] «${f.q}» (${f.intent}) → ${f.reply}`);
}
