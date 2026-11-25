/* Тест «два телефона»: два человека на разных устройствах подключаются
   к одному серверу и полностью видят друг друга. */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { io } from 'socket.io-client';

const PORT = 3781;
const base = `http://127.0.0.1:${PORT}`;
const srv = spawn('node', ['server.js'], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
srv.stdout.on('data', (d) => { serverLog += d; });
srv.stderr.on('data', (d) => { serverLog += d; });
await sleep(2200);

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
  return j;
};

console.log('=== 1. Сервер доступен ===');
const health = await jfetch('/api/health');
ok('health: ok=true, версия 4.6', health.ok === true && health.version === '4.6', JSON.stringify(health));

console.log('=== 2. Друзья регистрируются с двух телефонов ===');
const auth = async (username, display) => {
  let j = await jfetch('/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, display_name: display, password: 'friend123' }) });
  if (!j.token) j = await jfetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'friend123' }) });
  return j;
};
const A = await auth('aleksa_phone', 'Алёса (телефон 1)');
const B = await auth('boris_phone', 'Борис (телефон 2)');
ok('Алёса (телефон 1) в системе', !!A.token, JSON.stringify(A).slice(0, 100));
ok('Борис (телефон 2) в системе', !!B.token, JSON.stringify(B).slice(0, 100));
const HA = { 'content-type': 'application/json', authorization: `Bearer ${A.token}` };
const HB = { 'content-type': 'application/json', authorization: `Bearer ${B.token}` };

console.log('=== 3. Видимость в «Люди» ===');
const usersOf = async (H) => (await jfetch('/api/users', { headers: H })).users || [];
const usersA = await usersOf(HA);
const usersB = await usersOf(HB);
ok('Алёса видит Бориса в списке людей', usersA.some((u) => u.username === 'boris_phone'));
ok('Борис видит Алёсу в списке людей', usersB.some((u) => u.username === 'aleksa_phone'));
ok('Оба видят демо-пользователей', usersA.some((u) => u.display_name === 'Катя Астрова') && usersB.some((u) => u.display_name === 'Катя Астрова'));

console.log('=== 4. Онлайн-статус через сокеты ===');
const ioA = io(base, { auth: { token: A.token } });
const ioB = io(base, { auth: { token: B.token } });
const conns = await Promise.all([race(event(ioA, 'connect')), race(event(ioB, 'connect'))]);
await sleep(600);
ok('оба подключились к сокетам', ioA.connected && ioB.connected, `A:${ioA.connected} B:${ioB.connected} ev:${conns}`);
await sleep(400);
const usersA2 = await usersOf(HA);
ok('Борис «в сети» для Алёсы', usersA2.find((u) => u.username === 'boris_phone')?.online === true);

console.log('=== 5. Личные сообщения ===');
const chat = await jfetch('/api/chats', { method: 'POST', headers: HB, body: JSON.stringify({ type: 'direct', user_id: A.user.id }) });
ok('Борис создал чат с Алёсой', !!chat.chat_id, JSON.stringify(chat).slice(0, 120));
const chatId = chat.chat_id;
await jfetch(`/api/chats/${chatId}/messages`, { method: 'POST', headers: HB, body: JSON.stringify({ text: 'Привет с телефона 2!' }) });
const msgsA = (await jfetch(`/api/chats/${chatId}/messages`, { headers: HA })).messages || [];
ok('Алёса видит сообщение Бориса', msgsA.some((m) => (m.text || '').includes('Привет с телефона')));
await jfetch(`/api/chats/${chatId}/messages`, { method: 'POST', headers: HA, body: JSON.stringify({ text: 'Отвечаю с телефона 1!' }) });
const msgsB = (await jfetch(`/api/chats/${chatId}/messages`, { headers: HB })).messages || [];
ok('Борис видит ответ Алёсы', msgsB.some((m) => (m.text || '').includes('с телефона 1')));

console.log('=== 6. Общая лента ===');
const postRes = await jfetch('/api/posts', { method: 'POST', headers: HB, body: JSON.stringify({ type: 'post', text: 'Пост с телефона 2 — привет, Алёса!' }) });
ok('пост Бориса создан', !!postRes?.post?.id || !!postRes?.id, JSON.stringify(postRes).slice(0, 160));
const feedA = await jfetch('/api/feed', { headers: HA });
const feedText = JSON.stringify(feedA);
ok('Алёса видит пост Бориса в ленте', feedText.includes('Пост с телефона 2'));

console.log('=== 7. Звонки: сигналинг между телефонами ===');
const incP = event(ioB, 'call:incoming');
ioA.emit('call:invite', { to: B.user.id, call_id: 'c_test1', mode: 'audio' });
const inc = await race(incP);
ok('Борис получает «входящий звонок»', !!inc && inc.call_id === 'c_test1' && inc.from?.username === 'aleksa_phone', JSON.stringify(inc || {}).slice(0, 140));
const decP = event(ioA, 'call:declined');
ioB.emit('call:decline', { to: A.user.id, call_id: 'c_test1', busy: false });
const dec = await race(decP);
ok('Алёса получает «отказ/отмену»', !!dec && dec.call_id === 'c_test1', JSON.stringify(dec || {}).slice(0, 120));
const sigP = event(ioB, 'call:signal');
ioA.emit('call:signal', { to: B.user.id, call_id: 'c_test1', data: { type: 'ice', candidate: { candidate: 'candidate:1 1 UDP 1 1.1.1.1 1111 typ host' } } });
const sig = await race(sigP);
ok('ICE-кандидат доходит до Бориса', !!sig && sig.data?.type === 'ice', JSON.stringify(sig || {}).slice(0, 120));
const accP = event(ioA, 'call:accepted');
ioB.emit('call:accept', { to: A.user.id, call_id: 'c_test1' });
const acc = await race(accP);
ok('Алёса получает «принято»', !!acc && acc.call_id === 'c_test1');
const endP = event(ioB, 'call:ended');
ioA.emit('call:end', { to: B.user.id, call_id: 'c_test1' });
const ended = await race(endP);
ok('«Звонок завершён» доходит до Бориса', !!ended);

console.log('=== 8. Лог сервера (адреса для друзей) ===');
const hasIps = /Друзья в той же Wi-Fi сети|Wi-Fi адрес не найден/.test(serverLog);
ok('сервер печатает адрес для друга', hasIps, serverLog.slice(-200));

console.log(`\nИТОГ ДВУХ ТЕЛЕФОНОВ: ✓ ${pass}, ✗ ${fail}`);
ioA.disconnect(); ioB.disconnect();
srv.kill();
process.exit(fail ? 1 : 0);
