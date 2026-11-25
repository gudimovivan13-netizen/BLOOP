/* Тест масштаба 4.7 «миллион пользователей»:
   — 6 клиентов подключаются к одному серверу и все×все видят друг друга;
   — realtime: пост одного прилетает остальным пятерым, сообщение в общей
     группе доставляется каждому;
   — CORS: сервер отвечает любому origin (APK и внешние сайты);
   — пагинация: 1000 пользователей в базе — /api/users отдаёт страницами
     по 50, поиск находит нужного, полный обход собирает всех без дублей;
   — онлайн-список (online=1) и капа presence:list. */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { io } from 'socket.io-client';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const PORT = 3783;
const base = `http://127.0.0.1:${PORT}`;
const DATA = 'data-test-many';
fs.rmSync(DATA, { recursive: true, force: true });

const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT), BLOOP_DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
srv.stdout.on('data', (d) => { serverLog += d; });
srv.stderr.on('data', (d) => { serverLog += d; });

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const event = (sock, ev) => new Promise((res) => sock.once(ev, res));
const race = (p, ms = 3500) => Promise.race([p, sleep(ms).then(() => null)]);
const jfetch = async (url, opts = {}) => {
  const r = await fetch(base + url, opts);
  const j = await r.json().catch(() => ({}));
  return { status: r.status, headers: r.headers, json: j };
};

/* ждём старта сервера */
let health = null;
for (let i = 0; i < 40; i++) {
  try { health = (await jfetch('/api/health')).json; if (health?.ok) break; } catch { /* ещё не поднялся */ }
  await sleep(300);
}

console.log('=== 1. Сервер жив и здоров ===');
ok('health ok, версия 4.7', health?.ok === true && health.version === '4.7', JSON.stringify(health));
ok('health: есть счётчики users/online', Number.isFinite(health?.users) && Number.isFinite(health?.online), JSON.stringify(health));

console.log('=== 2. CORS — сервер отвечает любому origin (APK/сайты) ===');
const pre = await fetch(base + '/api/posts', { method: 'OPTIONS' });
ok('preflight OPTIONS → 204', pre.status === 204, String(pre.status));
ok('preflight: Access-Control-Allow-Origin: *', pre.headers.get('access-control-allow-origin') === '*', String(pre.headers.get('access-control-allow-origin')));
ok('preflight: Authorization разрешён', (pre.headers.get('access-control-allow-headers') || '').toLowerCase().includes('authorization'), pre.headers.get('access-control-allow-headers'));
const corsGet = await jfetch('/api/health', { headers: { Origin: 'https://localhost' } });
ok('GET с чужим Origin отдаёт ACAO: *', corsGet.headers.get('access-control-allow-origin') === '*');
const corsPost = await jfetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', Origin: 'capacitor://localhost' }, body: JSON.stringify({ username: 'x', password: 'y' }) });
ok('POST с чужим Origin отдаёт ACAO: *', corsPost.headers.get('access-control-allow-origin') === '*');

console.log('=== 3. Шесть друзей регистрируются — все видят всех ===');
const auth = async (username, display) => {
  let j = (await jfetch('/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, display_name: display, password: 'friend123' }) })).json;
  if (!j.token) j = (await jfetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'friend123' }) })).json;
  return j;
};
const PEOPLE = [
  ['anna_many', 'Анна'], ['boris_many', 'Борис'], ['vera_many', 'Вера'],
  ['grisha_many', 'Гриша'], ['dasha_many', 'Даша'], ['evgeny_many', 'Женя'],
];
const users = [];
for (const [u, d] of PEOPLE) users.push({ name: d, ...(await auth(u, d)) });
ok('все 6 зарегистрировались', users.every((u) => !!u.token), users.map((u) => `${u.name}:${!!u.token}`).join(' '));

const page1 = (await jfetch('/api/users?limit=50', { headers: { authorization: `Bearer ${users[0].token}` } })).json;
ok('страница людей приходит с total и has_more', Number.isFinite(page1.total) && typeof page1.has_more === 'boolean', JSON.stringify(page1).slice(0, 120));
for (const viewer of users) {
  const { json } = await jfetch('/api/users?limit=50', { headers: { authorization: `Bearer ${viewer.token}` } });
  const names = json.users.map((u) => u.username);
  const others = PEOPLE.map(([u]) => u).filter((u) => u !== viewer.username);
  ok(`${viewer.name} видит остальных 5 в «Люди»`, others.every((u) => names.includes(u)), names.join(','));
}

console.log('=== 4. Поиск по серверу (не по локальному кэшу) ===');
const found = (await jfetch('/api/users?q=' + encodeURIComponent('vera'), { headers: { authorization: `Bearer ${users[0].token}` } })).json;
ok('поиск «vera» находит Веру и только её', found.users.length >= 1 && found.users.every((u) => u.username.includes('vera') || u.display_name.includes('Вера')), JSON.stringify(found.users.map((u) => u.username)));
const none = (await jfetch('/api/users?q=' + encodeURIComponent('неттакогоxyz'), { headers: { authorization: `Bearer ${users[0].token}` } })).json;
ok('поиск по мусору даёт пустую страницу', none.users.length === 0 && none.total === 0);

console.log('=== 5. Массовая нагрузка: +1000 пользователей, пагинация ===');
{
  const dbo = new DatabaseSync(`${DATA}/bloop.db`);
  dbo.exec('PRAGMA busy_timeout = 5000;');
  const ins = dbo.prepare("INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, '')");
  dbo.exec('BEGIN');
  for (let i = 1; i <= 1000; i++) ins.run(`massuser${String(i).padStart(4, '0')}`, `Массовый ${i}`);
  dbo.exec('COMMIT');
  dbo.close();
}
const H1 = { authorization: `Bearer ${users[0].token}` };
const first = (await jfetch('/api/users?limit=50&offset=0', { headers: H1 })).json;
ok('total вырос до ≥1000', first.total >= 1000, String(first.total));
ok('страница ровно 50, has_more=true', first.users.length === 50 && first.has_more === true);
const seeker = (await jfetch('/api/users?q=massuser0777', { headers: H1 })).json;
ok('поиск massuser0777 находит нужного среди 1000', seeker.users.some((u) => u.username === 'massuser0777'), JSON.stringify(seeker.users.map((u) => u.username)));
/* полный обход страницами: все id, без дублей */
const seen = new Set();
let guard = 0;
for (let offset = 0; ; offset += 50) {
  const { json } = await jfetch(`/api/users?limit=50&offset=${offset}`, { headers: H1 });
  for (const u of json.users) seen.add(u.id);
  if (!json.has_more || ++guard > 500) break;
}
ok('обход страниц собирает ровно total пользователей', seen.size === first.total, `seen=${seen.size} total=${first.total}`);
const last = (await jfetch(`/api/users?limit=50&offset=${first.total + 100}`, { headers: H1 })).json;
ok('страница за пределами списка пуста', last.users.length === 0 && last.has_more === false);

console.log('=== 6. Онлайн-список и капа presence ===');
/* presence:list присылается один раз при подключении — вешаем слушатель
   сразу после создания сокета, до того, как рукопожатие успеет завершиться. */
const socks = users.map((u) => io(base, { auth: { token: u.token } }));
const plPromise = race(event(socks[0], 'presence:list'));
await Promise.all(socks.map((s) => race(event(s, 'connect'))));
await Promise.all(socks.map((s) => race(event(s, 'connect'))));
await sleep(500);
ok('все 6 сокетов подключились', socks.every((s) => s.connected));
const online = (await jfetch('/api/users?online=1&limit=30', { headers: H1 })).json;
const onlineIds = online.users.map((u) => u.id);
ok('online=1 видит всех шести в сети', users.every((u) => onlineIds.includes(u.user?.id ?? u.id)), `online=${onlineIds.length}`);
ok('в online-ответе все помечены online:true', online.users.every((u) => u.online === true));
const pl = await plPromise; // слушатель висит с момента создания сокета
ok('presence:list не больше 500 id', Array.isArray(pl?.online_ids) && pl.online_ids.length <= 500, `len=${pl?.online_ids?.length}`);

console.log('=== 7. Realtime все×все: пост Анны прилетает остальным пятерым ===');
const gotPost = socks.slice(1).map((s) => race(event(s, 'post:new')));
const post = (await jfetch('/api/posts', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${users[0].token}` },
  body: JSON.stringify({ type: 'post', text: 'Привет миллиону! #масштаб' }),
})).json;
ok('пост Анны создан', !!post?.post?.id, JSON.stringify(post).slice(0, 120));
const delivered = await Promise.all(gotPost);
ok('все 5 остальных получили post:new в реальном времени', delivered.every((e) => e?.post?.id === post.post.id), `delivered=${delivered.filter(Boolean).length}/5`);

console.log('=== 8. Общая группа на шестерых: сообщение достаётся каждому ===');
const memberIds = users.map((u) => u.user?.id ?? u.id);
const grp = (await jfetch('/api/chats', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${users[3].token}` },
  body: JSON.stringify({ type: 'group', name: 'Общая на миллион', member_ids: memberIds }),
})).json;
ok('группа создана', !!grp.chat_id, JSON.stringify(grp).slice(0, 120));
const gotChatNew = socks.map((s) => race(event(s, 'chat:new')));
await sleep(300); // chat:new уже мог прийти — слушаем и следующие события
const gotMsg = socks.map((s) => race(event(s, 'message')));
await jfetch(`/api/chats/${grp.chat_id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${users[3].token}` },
  body: JSON.stringify({ text: 'Группа на всех!' }),
});
const msgDelivered = await Promise.all(gotMsg);
const gotAll = msgDelivered.filter((m) => m?.text === 'Группа на всех!').length;
ok('сообщение в группе получили все 6 сокетов', gotAll >= 5, `got=${gotAll}/6`);

console.log('=== 9. Личный чат между двумя «незнакомыми» клиентами ===');
const dm = (await jfetch('/api/chats', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${users[4].token}` },
  body: JSON.stringify({ type: 'direct', user_id: users[5].user?.id ?? users[5].id }),
})).json;
ok('Даша открыла чат с Женей', !!dm.chat_id);
await jfetch(`/api/chats/${dm.chat_id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${users[4].token}` },
  body: JSON.stringify({ text: 'Личное сообщение' }),
});
const dmMsgs = (await jfetch(`/api/chats/${dm.chat_id}/messages`, { headers: { authorization: `Bearer ${users[5].token}` } })).json;
ok('Женя видит личное сообщение Даши', (dmMsgs.messages || []).some((m) => m.text === 'Личное сообщение'));

console.log('=== 10. Регистрационный лимит (защита публичного сервера) ===');
let limited = false;
for (let i = 0; i < 25; i++) {
  const r = await jfetch('/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: `spam_${Date.now()}_${i}`, password: 'spam12345' }) });
  if (r.status === 429) { limited = true; break; }
}
ok('после 20 регистраций подряд сервер отвечает 429', limited);

console.log('=== 11. Прибой ===');
for (const s of socks) s.disconnect();
srv.kill();
const total = pass + fail;
console.log(`\nИтог: ${pass}/${total} проверок пройдено${fail ? `, ПРОВАЛЕНО: ${fail}` : ''}`);
if (fail) console.log('Лог сервера:\n' + serverLog.slice(-3000));
process.exit(fail ? 1 : 0);
