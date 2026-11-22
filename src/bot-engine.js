/* =====================================================================
   Движок ботов BLOOP: изолированное исполнение кода бота (node:vm),
   клавиатуры, постоянное состояние, очередь обновлений (long polling).
   Один и тот же контракт ctx работает и на сервере, и в локальном
   режиме (браузерная копия движка в public/local-server.js).
   ===================================================================== */
import vm from 'node:vm';
import crypto from 'node:crypto';
import {
  insertMessage, bumpBotMsgs, appendBotLogs, getBotState, setBotState,
} from './db.js';

export const MAX_CODE_CHARS = 20000;   // лимит кода бота
export const MAX_MINIAPP_CHARS = 60000; // лимит кода мини-аппа
const RUN_TIMEOUT_MS = 3000;           // на одно событие

export function newBotToken() {
  return 'bta_' + crypto.randomBytes(24).toString('hex');
}

/* ---------- инлайн-клавиатуры: [[{t,d}]] ---------- */

function normBtn(b) {
  if (typeof b === 'string') return { t: b.slice(0, 64), d: b.slice(0, 64) };
  if (b && typeof b === 'object') {
    const t = String(b.t ?? b.text ?? '').trim().slice(0, 64);
    const d = String(b.d ?? b.data ?? t).trim().slice(0, 64);
    if (!t) return null;
    return { t, d };
  }
  return null;
}

export function normalizeKeyboard(kb) {
  if (!Array.isArray(kb) || kb.length === 0) return null;
  const rows = kb.slice(0, 6).map(row => {
    const arr = Array.isArray(row) ? row : [row];
    return arr.slice(0, 4).map(normBtn).filter(Boolean);
  }).filter(r => r.length);
  return rows.length ? rows : null;
}

/* ---------- очередь обновлений (getUpdates, long polling) ---------- */

const updateQueues = new Map(); // botId -> { items, resolvers, seq }

function getQueue(botId) {
  let q = updateQueues.get(botId);
  if (!q) {
    q = { items: [], resolvers: [], seq: 0 };
    updateQueues.set(botId, q);
  }
  return q;
}

export function pushBotUpdate(botId, update) {
  const q = getQueue(botId);
  update.seq = ++q.seq;
  update.ts = Date.now();
  q.items.push(update);
  if (q.items.length > 200) q.items.splice(0, q.items.length - 200);
  const resolvers = q.resolvers.splice(0);
  for (const r of resolvers) r();
}

export function takeUpdates(botId) {
  return getQueue(botId).items.splice(0);
}

export async function waitUpdates(botId, timeoutMs = 25000) {
  const q = getQueue(botId);
  const got = q.items.splice(0);
  if (got.length) return got;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = q.resolvers.indexOf(resolve);
      if (i >= 0) q.resolvers.splice(i, 1);
      resolve();
    }, Math.max(1000, Math.min(timeoutMs, 30000)));
    q.resolvers.push(() => { clearTimeout(timer); resolve(); });
  });
  return q.items.splice(0);
}

export function clearUpdates(botId) {
  updateQueues.delete(botId);
}

/* ---------- исполнение события ботом ---------- */

function fmtVal(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function parseCommand(raw) {
  const text = String(raw || '').trim();
  const m = /^\/([a-zA-Z0-9_]{1,24})(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return null;
  const argsText = (m[2] || '').trim();
  return {
    command: m[1].toLowerCase(),
    args: argsText ? argsText.split(/\s+/).slice(0, 20) : [],
    argsText,
  };
}

function cloneVal(v) {
  try { return JSON.parse(JSON.stringify(v ?? null)); }
  catch { return String(v); }
}

/* Событие бота. event = { kind: 'start'|'message'|'callback'|'miniapp',
   text?, data?, message_id? }. emitMessage — доставка сообщения бота в чат. */
export async function runBotEvent({ bot, chatId, user, event, emitMessage }) {
  if (!bot.enabled || bot.deleted) return { skipped: true };

  const logs = [];
  const pushLog = (level, parts) => {
    logs.push({ t: Date.now(), level, event: event.kind, text: parts.map(fmtVal).join(' ').slice(0, 300) });
    if (logs.length > 30) logs.splice(0, logs.length - 30);
  };
  const fakeConsole = {
    log: (...a) => pushLog('log', a),
    info: (...a) => pushLog('log', a),
    warn: (...a) => pushLog('warn', a),
    error: (...a) => pushLog('error', a),
  };

  // постоянное состояние бота (между всеми чатами и событиями)
  const stateData = getBotState(bot.id);
  let dirty = false;
  const state = {
    get(key, def = null) {
      const v = stateData[String(key).slice(0, 64)];
      return v === undefined ? def : v;
    },
    set(key, val) {
      stateData[String(key).slice(0, 64)] = cloneVal(val);
      const keys = Object.keys(stateData);
      if (keys.length > 100) for (const k of keys.slice(0, keys.length - 100)) delete stateData[k];
      dirty = true;
    },
    keys: () => Object.keys(stateData),
  };

  const replies = []; // реплики бота — сервер вернёт их в HTTP-ответе
  const reply = (text, opts = {}) => {
    const t = String(text ?? '').trim().slice(0, 4000);
    if (!t) throw new Error('ctx.reply: текст пуст');
    const kb = opts?.keyboard ? normalizeKeyboard(opts.keyboard) : null;
    const msg = insertMessage(chatId, bot.user_id, t, null, 'image', null, kb);
    bumpBotMsgs(bot.id);
    replies.push(msg);
    if (typeof emitMessage === 'function') emitMessage(msg);
    return msg;
  };

  const cmd = parseCommand(event.text);
  const ctx = {
    event: event.kind,
    message: event.kind === 'message' ? {
      text: String(event.text || '').slice(0, 4000),
      command: cmd?.command ?? null,
      args: cmd?.args ?? [],
      argsText: cmd?.argsText ?? '',
      message_id: Number(event.message_id) || null,
    } : null,
    callback: event.kind === 'callback' ? {
      data: String(event.data || '').slice(0, 64),
      message_id: Number(event.message_id) || null,
    } : null,
    miniapp: event.kind === 'miniapp' ? { data: cloneVal(event.data) } : null,
    user: { id: user.id, name: user.display_name, username: user.username },
    chat: { id: chatId },
    reply,
    state,
  };

  let error = null;
  const code = String(bot.code || '').trim();
  if (!code) {
    if (event.kind === 'start') {
      try {
        reply('Бот подключён, но у него пока нет программы. Владелец может написать код в разделе «Мои боты».');
      } catch { /* не критично */ }
    }
  } else {
    // песочница: свой realm, из хоста пробрасываются только console и ctx
    const sandbox = vm.createContext({ console: fakeConsole, ctx });
    try {
      const script = new vm.Script('(async () => {\n' + code + '\n})()');
      const p = script.runInContext(sandbox, { timeout: RUN_TIMEOUT_MS });
      await Promise.race([
        Promise.resolve(p),
        new Promise((r) => setTimeout(r, RUN_TIMEOUT_MS)),
      ]);
    } catch (e) {
      error = String(e?.message || e).slice(0, 300);
      pushLog('error', [error]);
    }
  }

  if (dirty) setBotState(bot.id, stateData);
  if (logs.length) appendBotLogs(bot.id, logs);
  return { logs, error, replies };
}

/* ---------- шаблоны кода для редактора ---------- */

export const BOT_TEMPLATES = [
  {
    id: 'echo',
    name: 'Эхо-бот',
    code: `// Эхо-бот: повторяет всё, что ему написали.
// Доступно: ctx.reply(текст, { keyboard }), ctx.state, ctx.message, ctx.user
if (ctx.event === 'start') {
  ctx.reply('Привет, ' + ctx.user.name + '! Я эхо-бот. Напиши мне что-нибудь.');
} else if (ctx.event === 'message') {
  ctx.reply('Ты написал: ' + ctx.message.text);
}`,
  },
  {
    id: 'commands',
    name: 'Команды и клавиатура',
    code: `// Бот с командами и инлайн-клавиатурой.
// keyboard: строки кнопок [['Надпись', 'данные_колбэка'], ...]
if (ctx.event === 'start') {
  ctx.reply('Привет! Команды: /help /about /ping', {
    keyboard: [[{ t: 'Справка', d: 'help' }], [{ t: 'Пинг', d: 'ping' }]],
  });
} else if (ctx.event === 'message') {
  const c = ctx.message.command;
  if (c === 'help') ctx.reply('Команды:\\n/start — приветствие\\n/help — эта справка\\n/about — о платформе\\n/ping — проверка связи');
  else if (c === 'about') ctx.reply('Платформа ботов BLOOP: код бота исполняется в песочнице сервера, состояние хранится в ctx.state.');
  else if (c === 'ping') ctx.reply('Понг! Связь стабильна.');
  else if (!c) ctx.reply('Напиши команду или нажми кнопку ниже.', {
    keyboard: [[{ t: 'Справка', d: 'help' }], [{ t: 'Пинг', d: 'ping' }]],
  });
} else if (ctx.event === 'callback') {
  if (ctx.callback.data === 'help') ctx.reply('Команды:\\n/start /help /about /ping');
  if (ctx.callback.data === 'ping') ctx.reply('Понг!');
}`,
  },
  {
    id: 'counter',
    name: 'Счётчик (состояние)',
    code: `// Счётчик на ctx.state — данные живут между сообщениями.
if (ctx.event === 'start') {
  ctx.state.set('n', ctx.state.get('n', 0));
  ctx.reply('Счётчик: ' + ctx.state.get('n', 0) + '\\nЖми кнопку или /plus', {
    keyboard: [[{ t: '+1', d: 'plus' }], [{ t: 'Сброс', d: 'reset' }]],
  });
} else if (ctx.event === 'callback' || ctx.event === 'message') {
  const act = ctx.event === 'callback' ? ctx.callback.data : ctx.message.command;
  if (act === 'plus') {
    ctx.state.set('n', Number(ctx.state.get('n', 0)) + 1);
    ctx.reply('Счётчик: ' + ctx.state.get('n', 0), {
      keyboard: [[{ t: '+1', d: 'plus' }], [{ t: 'Сброс', d: 'reset' }]],
    });
  }
  if (act === 'reset') {
    ctx.state.set('n', 0);
    ctx.reply('Обнулён. Счётчик: 0', { keyboard: [[{ t: '+1', d: 'plus' }], [{ t: 'Сброс', d: 'reset' }]] });
  }
}`,
  },
  {
    id: 'quiz',
    name: 'Мини-викторина',
    code: `// Викторина: вопрос по команде, проверка ответа, счёт в ctx.state.
const Q = {
  'столица': ['Столица Франции?', 'париж'],
  'язык': ['На каком языке пишут серверы BLOOP?', 'javascript'],
};
if (ctx.event === 'start') {
  ctx.reply('Викторина! Команды: /вопрос /ответ <слово> /счёт');
} else if (ctx.event === 'message') {
  const c = ctx.message.command;
  if (c === 'вопрос') {
    const keys = Object.keys(Q);
    const k = keys[Math.floor(Math.random() * keys.length)];
    ctx.state.set('q', k);
    ctx.reply(Q[k][0]);
  } else if (c === 'ответ') {
    const k = ctx.state.get('q');
    if (!k) return ctx.reply('Сначала задай вопрос: /вопрос');
    const ok = String(ctx.message.argsText || '').toLowerCase().trim() === Q[k][1];
    ctx.reply(ok ? 'Верно! Плюс очко.' : 'Мимо. Правильно: ' + Q[k][1]);
    if (ok) ctx.state.set('score', Number(ctx.state.get('score', 0)) + 1);
    ctx.state.set('q', null);
  } else if (c === 'счёт') {
    ctx.reply('Твой счёт: ' + ctx.state.get('score', 0));
  }
}`,
  },
];

export const MINIAPP_TEMPLATE = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Мини-апп</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #10131f; color: #eef2ff;
         min-height: 100vh; display: flex; flex-direction: column; align-items: center;
         justify-content: center; gap: 18px; padding: 24px; box-sizing: border-box; }
  h1 { font-size: 22px; margin: 0; }
  #who { opacity: .7; font-size: 14px; }
  #count { font-size: 64px; font-weight: 700; }
  button { border: 0; border-radius: 14px; padding: 14px 28px; font-size: 16px; font-weight: 600;
           color: #fff; background: linear-gradient(135deg, #7aa2ff, #8f6cff); cursor: pointer; }
</style>
</head>
<body>
<h1>Мой счётчик</h1>
<div id="who">…</div>
<div id="count">0</div>
<button id="plus">Прибавить</button>
<script src="/miniapp-sdk.js"></script>
<script>
  BMA.ready(() => {
    document.getElementById('who').textContent = 'Привет, ' + BMA.user.name + '!';
    document.getElementById('count').textContent = BMA.state.get('n', 0);
  });
  document.getElementById('plus').onclick = async () => {
    const n = Number(BMA.state.get('n', 0)) + 1;
    // state мини-аппа — это ctx.state бота: боту уйдёт событие miniapp
    await BMA.sendData({ action: 'increment' });
    document.getElementById('count').textContent = BMA.state.get('n', 0);
  };
</script>
</body>
</html>`;

export const BOT_DOC = [
  'ctx.reply(текст, { keyboard: [[{ t: «Надпись», d: «данные» }], …] }) — ответ с кнопками',
  'ctx.state.get(key, def) / ctx.state.set(key, val) — постоянное состояние бота',
  'ctx.event — start | message | callback | miniapp',
  'ctx.message — { text, command, args, argsText } (для сообщений)',
  'ctx.callback — { data, message_id } (нажатие кнопки)',
  'ctx.miniapp — { data } (событие из мини-аппа)',
  'ctx.user — { id, name, username } отправитель',
  'console.log(...) — попадает в «Логи» редактора бота',
].join('\n');
