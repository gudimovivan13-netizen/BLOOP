/* BLOOP — шаблоны кода ботов для редактора «Мои боты».
   Тот же набор, что предустанавливается движком (src/bot-engine.js). */
window.BLOOP_BOT_TEMPLATES = [
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
// keyboard: ряды кнопок — [{ t: 'Надпись', d: 'данные' }] или просто 'Надпись'
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

window.BLOOP_MINIAPP_TEMPLATE = `<!doctype html>
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
    // шлём событие боту: его код увидит ctx.event === 'miniapp'
    await BMA.sendData({ action: 'increment' });
    document.getElementById('count').textContent = BMA.state.get('n', 0);
  };
</script>
</body>
</html>`;

window.BLOOP_BOT_DOC = [
  'ctx.reply(текст, { keyboard: [[{ t: «Надпись», d: «данные» }], …] }) — ответ с кнопками',
  'ctx.state.get(key, def) / ctx.state.set(key, val) — постоянное состояние',
  'ctx.event — start | message | callback | miniapp',
  'ctx.message — { text, command, args, argsText } (сообщение)',
  'ctx.callback — { data, message_id } (нажатие кнопки)',
  'ctx.miniapp — { data } (событие из мини-аппа)',
  'ctx.user — { id, name, username } отправитель',
  'console.log(...) — попадает в «Логи» редактора',
].join('\n');
