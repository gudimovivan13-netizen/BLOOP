// Интеграционный smoke-тест BLOOP: поднимает сервер, проверяет
// регистрацию, чаты, доставку по WebSocket, присутствие и картинки.
// Запуск: npm run smoke
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { io } from 'socket.io-client';

const PORT = 3107;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = path.join(process.cwd(), 'data-test');

let failures = 0;

function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name} ${extra}`);
  }
}

async function api(path, { method = 'GET', body, token: t } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function upload(path, bytes, mime, token) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), 'test.bin');
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: { token } });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
    setTimeout(() => reject(new Error('socket timeout')), 5000);
  });
}

function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} in ${timeoutMs}ms`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT), BLOOP_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  try {
    // ждём готовности сервера
    for (let i = 0; i < 40; i++) {
      try { await fetch(BASE); break; } catch { await sleep(150); }
    }

    const suffix = Date.now().toString(36);
    const aliceName = `alice_${suffix}`;
    const bobName = `bob_${suffix}`;

    console.log('\n— Регистрация и вход');
    const regBad = await api('/api/register', { method: 'POST', body: { username: 'x', password: '123' } });
    check('короткий логин отклоняется', regBad.status === 400);

    const regA = await api('/api/register', { method: 'POST', body: { username: aliceName, password: 'secret1', display_name: 'Алиса' } });
    check('регистрация Алисы', regA.status === 200 && regA.data.token);
    const regB = await api('/api/register', { method: 'POST', body: { username: bobName, password: 'secret2', display_name: 'Боб' } });
    check('регистрация Боба', regB.status === 200 && regB.data.token);

    const dup = await api('/api/register', { method: 'POST', body: { username: aliceName, password: 'secret1' } });
    check('дубликат логина отклоняется', dup.status === 409);

    const badLogin = await api('/api/login', { method: 'POST', body: { username: aliceName, password: 'wrong' } });
    check('неверный пароль отклоняется', badLogin.status === 401);

    const tokA = regA.data.token, tokB = regB.data.token;
    const meA = await api('/api/me', { token: tokA });
    check('/api/me возвращает Алису', meA.data.user?.display_name === 'Алиса');

    console.log('\n— Пользователи и чаты');
    const users = await api('/api/users', { token: tokA });
    const bob = users.data.users.find(u => u.username === bobName);
    check('Боб виден в списке пользователей', !!bob);

    const chat1 = await api('/api/chats', { method: 'POST', token: tokA, body: { type: 'direct', user_id: bob.id } });
    check('личный чат создан', chat1.status === 200 && chat1.data.chat_id);
    const chat2 = await api('/api/chats', { method: 'POST', token: tokB, body: { type: 'direct', user_id: meA.data.user.id } });
    check('повторное открытие того же чата дедуплицируется', chat2.data.chat_id === chat1.data.chat_id && chat2.data.existed === true);

    console.log('\n— WebSocket и доставка');
    const sockA = await connectSocket(tokA);
    // вешаем слушатели ДО подключения Боба, иначе пропустим события
    const presPromise = waitForEvent(sockA, 'presence');
    const sockB = await connectSocket(tokB);
    check('оба сокета подключились', sockA.connected && sockB.connected);

    const presB = await presPromise.catch(() => null);
    check('Алиса видит онлайн-статус Боба', presB?.user_id === bob.id && presB?.online === true);

    const msgPromise = waitForEvent(sockB, 'message');
    const send = await api(`/api/chats/${chat1.data.chat_id}/messages`, { method: 'POST', token: tokA, body: { text: 'Привет, Боб!' } });
    check('сообщение отправлено по REST', send.status === 200 && send.data.message?.text === 'Привет, Боб!');
    const received = await msgPromise.catch(() => null);
    check('Боб получил сообщение через WebSocket', received?.text === 'Привет, Боб!');

    const chatListB = await api('/api/chats', { token: tokB });
    const chatB = chatListB.data.chats.find(c => c.id === chat1.data.chat_id);
    check('у Боба непрочитанное = 1', chatB?.unread === 1);
    check('последнее сообщение виднеется в списке', chatB?.last_message?.text === 'Привет, Боб!');

    await api(`/api/chats/${chat1.data.chat_id}/read`, { method: 'POST', token: tokB, body: { message_id: received.id } });
    const chatListB2 = await api('/api/chats', { token: tokB });
    check('после прочтения непрочитанное = 0',
      chatListB2.data.chats.find(c => c.id === chat1.data.chat_id)?.unread === 0);

    const typing = waitForEvent(sockB, 'typing');
    sockA.emit('typing', { chat_id: chat1.data.chat_id, typing: true });
    const typed = await typing.catch(() => null);
    check('индикатор набора доставляется', typed?.typing === true);

    console.log('\n— Групповой чат');
    const chatNewPromise = waitForEvent(sockB, 'chat:new'); // слушаем до создания
    const group = await api('/api/chats', { method: 'POST', token: tokA, body: { type: 'group', name: 'BLOOP team', member_ids: [bob.id] } });
    check('группа создана', group.status === 200 && group.data.chat_id);
    const chatNew = await chatNewPromise.catch(() => null);
    check('Боб получил событие о новом чате', chatNew?.chat_id === group.data.chat_id);
    const gmsg = waitForEvent(sockB, 'message');
    await api(`/api/chats/${group.data.chat_id}/messages`, { method: 'POST', token: tokA, body: { text: 'Всем привет в группе!' } });
    const grec = await gmsg.catch(() => null);
    check('сообщение из группы доставлено', grec?.text === 'Всем привет в группе!' && grec?.display_name === 'Алиса');

    console.log('\n— Изображения');
    const tinyPng = 'data:image/png;base64,' + Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcc3000003060170ebc39a0000000049454e44ae426082',
      'hex'
    ).toString('base64');
    const imgMsg = await api(`/api/chats/${chat1.data.chat_id}/messages`, { method: 'POST', token: tokB, body: { text: '', image: tinyPng } });
    check('картинка принята и сохранена', imgMsg.status === 200 && !!imgMsg.data.message?.image);
    const imgRes = await fetch(BASE + imgMsg.data.message.image);
    check('картинка отдаётся по HTTP', imgRes.status === 200);
    const badImg = await api(`/api/chats/${chat1.data.chat_id}/messages`, { method: 'POST', token: tokB, body: { text: '', image: 'data:text/html;base64,PGI+' } });
    check('не-картинка отклоняется', badImg.status === 400);

    console.log('\n— Доступ');
    const chatsB = await api('/api/chats', { token: tokB });
    const otherChat = chatsB.data.chats[0]?.id;
    // создаём третьего пользователя, который не участник чата Алисы и Боба
    const regC = await api('/api/register', { method: 'POST', body: { username: `carol_${suffix}`, password: 'secret3' } });
    const foreign = await api(`/api/chats/${chat1.data.chat_id}/messages`, { token: regC.data.token });
    check('чужой не может читать чужой чат', foreign.status === 403);

    console.log('\n— Оффлайн');
    const offPromise = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 5000);
      sockA.on('presence', function handler(p) {
        if (p.user_id === bob.id && p.online === false) {
          clearTimeout(t);
          sockA.off('presence', handler);
          resolve(p);
        }
      });
    });
    sockB.disconnect();
    const presOff = await offPromise;
    check('Алиса получает оффлайн-статус Боба', presOff !== null);

    sockA.disconnect();

    console.log('\n— Соцсеть: загрузка медиа');
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcc3000003060170ebc39a0000000049454e44ae426082',
      'hex'
    );
    const imgUp = await upload('/api/upload', pngBytes, 'image/png', tokA);
    check('загрузка картинки возвращает URL', imgUp.status === 200 && imgUp.data.url?.startsWith('/uploads/') && imgUp.data.kind === 'image');
    const imgPub = await fetch(BASE + imgUp.data.url);
    check('загруженная картинка доступна', imgPub.status === 200);

    const mp4Bytes = Buffer.from('000000186674797069736f6d00000200', 'hex');
    const vidUp = await upload('/api/upload', mp4Bytes, 'video/mp4', tokA);
    check('загрузка видео возвращает URL', vidUp.status === 200 && vidUp.data.kind === 'video');

    const badUp = await upload('/api/upload', Buffer.from('hello'), 'text/plain', tokA);
    check('не-медиа файл отклоняется', badUp.status === 400);

    console.log('\n— Соцсеть: посты и лента');
    const post1 = await api('/api/posts', { method: 'POST', token: tokA, body: { type: 'post', text: 'Первый пост в BLOOP!' } });
    check('текстовый пост создан', post1.status === 200 && post1.data.post?.type === 'post');
    const post2 = await api('/api/posts', { method: 'POST', token: tokB, body: { type: 'post', text: 'Пост с картинкой', media: imgUp.data.url } });
    check('пост с изображением создан', post2.status === 200 && post2.data.post?.media === imgUp.data.url);
    const clip1 = await api('/api/posts', { method: 'POST', token: tokA, body: { type: 'clip', text: 'Мой клип', media: vidUp.data.url, duration: 15.5 } });
    check('клип создан', clip1.status === 200 && clip1.data.post?.type === 'clip' && clip1.data.post?.duration === 15.5);

    const postWithVideo = await api('/api/posts', { method: 'POST', token: tokA, body: { type: 'post', text: 'пост с видео', media: vidUp.data.url } });
    check('видео в обычном посте отклоняется', postWithVideo.status === 400);
    const clipNoMedia = await api('/api/posts', { method: 'POST', token: tokA, body: { type: 'clip', text: 'без файла' } });
    check('клип без видео отклоняется', clipNoMedia.status === 400);
    const emptyPost = await api('/api/posts', { method: 'POST', token: tokA, body: { type: 'post', text: '' } });
    check('пустой пост отклоняется', emptyPost.status === 400);

    const feedA = await api('/api/feed', { token: tokA });
    check('лента содержит все публикации', feedA.data.posts?.length === 3);
    const inFeed = feedA.data.posts.find(p => p.id === post2.data.post.id);
    check('в ленте есть автор и счётчики', inFeed?.author?.display_name === 'Боб' && inFeed?.likes === 0 && inFeed?.liked_by_me === false);
    const feedClips = await api('/api/feed?type=clip', { token: tokA });
    check('фильтр ленты по клипам работает', feedClips.data.posts?.length === 1 && feedClips.data.posts[0].type === 'clip');

    console.log('\n— Соцсеть: лайки, комментарии, просмотры');
    const pid = post2.data.post.id;
    const like1 = await api(`/api/posts/${pid}/like`, { method: 'POST', token: tokA });
    check('лайк ставится', like1.data.liked === true && like1.data.likes === 1);
    const like2 = await api(`/api/posts/${pid}/like`, { method: 'POST', token: tokB });
    check('второй лайк считается', like2.data.likes === 2);
    const like3 = await api(`/api/posts/${pid}/like`, { method: 'POST', token: tokA });
    check('повторный лайк снимается', like3.data.liked === false && like3.data.likes === 1);

    const feedLiked = await api('/api/feed', { token: tokB });
    check('liked_by_me обновился в ленте', feedLiked.data.posts.find(p => p.id === pid)?.liked_by_me === true);

    const cm1 = await api(`/api/posts/${pid}/comments`, { method: 'POST', token: tokB, body: { text: 'Отличный пост!' } });
    check('комментарий добавлен', cm1.status === 200 && cm1.data.comment?.display_name === 'Боб');
    const cmEmpty = await api(`/api/posts/${pid}/comments`, { method: 'POST', token: tokB, body: { text: '  ' } });
    check('пустой комментарий отклоняется', cmEmpty.status === 400);
    const cmList = await api(`/api/posts/${pid}/comments`, { token: tokA });
    check('список комментариев отдаётся', cmList.data.comments?.length === 1);
    const feedAfterCm = await api('/api/feed', { token: tokA });
    check('счётчик комментариев в ленте = 1', feedAfterCm.data.posts.find(p => p.id === pid)?.comments_count === 1);

    const v1r = await api(`/api/posts/${pid}/view`, { method: 'POST', token: tokA });
    check('просмотр считается', v1r.data.views === 1);

    console.log('\n— Соцсеть: профили');
    const profB = await api(`/api/users/${bob.id}`, { token: tokA });
    check('профиль Боба открывается', profB.status === 200 && profB.data.user?.display_name === 'Боб' && profB.data.counts?.posts === 1);
    const profPosts = await api(`/api/users/${bob.id}/posts`, { token: tokA });
    check('посты Боба в его профиле', profPosts.data.posts?.length === 1);

    const avatarUp = await upload('/api/me/avatar', pngBytes, 'image/png', tokB);
    check('аватар загружается', avatarUp.status === 200 && avatarUp.data.user?.avatar?.startsWith('/uploads/'));
    const profB2 = await api(`/api/users/${bob.id}`, { token: tokA });
    check('аватар виден в профиле', profB2.data.user?.avatar === avatarUp.data.user.avatar);

    const patchMe = await api('/api/me', { method: 'PATCH', token: tokB, body: { display_name: 'Боб-Строитель', bio: 'Люблю BLOOP' } });
    check('профиль обновляется', patchMe.data.user?.display_name === 'Боб-Строитель' && patchMe.data.user?.bio === 'Люблю BLOOP');

    console.log('\n— Соцсеть: удаление и доступ');
    const delForeign = await api(`/api/posts/${pid}`, { method: 'DELETE', token: tokA });
    check('чужой пост удалить нельзя', delForeign.status === 403);
    const post3 = await api('/api/posts', { method: 'POST', token: tokA, body: { type: 'post', text: 'Скоро удалю' } });
    const delOwn = await api(`/api/posts/${post3.data.post.id}`, { method: 'DELETE', token: tokA });
    check('свой пост удаляется', delOwn.status === 200);
    const feedAfterDel = await api('/api/feed', { token: tokA });
    check('удалённого поста нет в ленте', !feedAfterDel.data.posts.some(p => p.id === post3.data.post.id));

    console.log('\n— v3: realtime, уведомления, тренды, поиск, ассистент');
    const alice = users.data.users.find(u => u.username === aliceName);
    const sockB2 = await connectSocket(tokB); // Боб слушает события

    const postNewP = waitForEvent(sockB2, 'post:new');
    const livePost = await api('/api/posts', { method: 'POST', token: tokA, body: { type: 'post', text: 'Живая лента #realtime' } });
    const pn = await postNewP;
    check('post:new приходит другим пользователям', pn.post?.id === livePost.data.post.id);

    const sockA2 = await connectSocket(tokA);
    const notifP = waitForEvent(sockA2, 'notification');
    await api(`/api/posts/${livePost.data.post.id}/like`, { method: 'POST', token: tokB });
    const nf = await notifP;
    check('уведомление о лайке приходит автору', nf.notification?.type === 'like' && nf.notification?.actor_id === bob.id && nf.unread >= 1);

    const commentNewP = waitForEvent(sockA2, 'comment:new');
    const statsP = waitForEvent(sockA2, 'post:stats');
    const liveCm = await api(`/api/posts/${livePost.data.post.id}/comments`, { method: 'POST', token: tokB, body: { text: 'Реалтайм-коммент' } });
    const cn = await commentNewP;
    check('comment:new броадкастится всем', cn.post_id === livePost.data.post.id && cn.comment?.id === liveCm.data.comment.id);
    const st = await statsP;
    check('post:stats несёт счётчик комментариев', st.post_id === livePost.data.post.id && st.comments_count === 1);

    const notifList = await api('/api/notifications', { token: tokA });
    check('список уведомлений с непрочитанными', notifList.data.notifications?.some(n => n.id === nf.notification.id && n.is_read === 0));
    const marked = await api('/api/notifications/read', { method: 'POST', token: tokA, body: {} });
    check('«прочитать всё» обнуляет счётчик', marked.data.unread === 0);

    const tagFeed = await api('/api/feed?tag=realtime', { token: tokA });
    check('лента по хэштегу работает', tagFeed.data.posts?.some(p => p.id === livePost.data.post.id));
    const trends = await api('/api/trends', { token: tokA });
    check('тренды содержат #realtime', trends.data.trends?.some(t => t.tag === 'realtime' && t.count >= 1));

    const found = await api('/api/search?q=Живая', { token: tokA });
    check('поиск по постам находит', found.data.posts?.some(p => p.id === livePost.data.post.id));

    const profStats = await api(`/api/users/${alice.id}`, { token: tokB });
    check('статистика профиля считается', (profStats.data.stats?.likes_received || 0) >= 1);

    const ai = await api('/api/assistant', { method: 'POST', token: tokA, body: { messages: [{ role: 'user', content: 'Привет, что ты умеешь?' }] } });
    check('ассистент отвечает содержательно', ai.status === 200 && typeof ai.data.reply === 'string' && ai.data.reply.length > 5);
    const aiBad = await api('/api/assistant', { method: 'POST', token: tokA, body: { messages: [] } });
    check('ассистент без сообщений отклоняется', aiBad.status === 400);

    sockB2.disconnect();
    sockA2.disconnect();

  } finally {
    server.kill();
    await sleep(200);
  }

  console.log(failures === 0 ? '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ' : `\nПРОВАЛОВ: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
