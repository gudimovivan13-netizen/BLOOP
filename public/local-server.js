/* BLOOP — локальный режим (Android APK): «сервер» внутри приложения.
   Реализует все REST-маршруты поверх localStorage (данные) и IndexedDB
   (медиафайлы), realtime-события — через локальную шину событий.
   Включается только если window.BLOOP_CONFIG.mode === 'local'.
   В веб-версии файл подключён, но ничего не делает. */
(() => {
  'use strict';
  const LOCAL = window.BLOOP_CONFIG?.mode === 'local' || location.search.includes('local=1');
  if (!LOCAL) return;

  /* ---------- хранилище данных (localStorage) ---------- */

  const LS_KEY = 'bloop_local_db_v1';

  const blank = () => ({
    seq: { user: 0, chat: 0, msg: 0, post: 0, comment: 0, notif: 0, story: 0 },
    users: [], chats: [], members: [], messages: [],
    posts: [], likes: [], comments: [], notifs: [], tags: [],
    emailCodes: [], stories: [], storyViews: [], postReactions: [], pollVotes: [], msgReactions: [],
    bots: [], botStates: {},
  });

  let db;
  try { db = JSON.parse(localStorage.getItem(LS_KEY)) || blank(); } catch { db = blank(); }
  if (!db || !db.seq) db = blank();
  // миграции для хранилищ старых версий
  for (const k of ['emailCodes', 'stories', 'storyViews', 'postReactions', 'pollVotes', 'msgReactions']) {
    if (!Array.isArray(db[k])) db[k] = [];
  }
  if (!Array.isArray(db.bots)) db.bots = [];
  if (!db.botStates || typeof db.botStates !== 'object') db.botStates = {};
  if (!db.seq.story) db.seq.story = 0;

  const save = () => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(db)); }
    catch (e) { console.warn('BLOOP local: локальное хранилище переполнено', e); }
  };
  const next = (k) => ++db.seq[k];
  const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

  /* ---------- медиа (IndexedDB, blob: URL) ---------- */

  let idb = null;
  const idbReady = new Promise((resolve) => {
    try {
      const req = indexedDB.open('bloop_media', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('media');
      req.onsuccess = () => { idb = req.result; resolve(); };
      req.onerror = () => resolve();
    } catch { resolve(); }
  });

  const idbPut = (key, blob) => new Promise((res, rej) => {
    if (!idb) return res();
    const tx = idb.transaction('media', 'readwrite');
    tx.objectStore('media').put(blob, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });

  const idbGet = (key) => new Promise((res) => {
    if (!idb) return res(null);
    const rq = idb.transaction('media', 'readonly').objectStore('media').get(key);
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => res(null);
  });

  const mediaUrls = new Map(); // '/uploads/x.png' -> 'blob:…'

  async function hydrateMedia() {
    if (!idb) return;
    const keys = await new Promise((res) => {
      const rq = idb.transaction('media', 'readonly').objectStore('media').getAllKeys();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => res([]);
    });
    for (const key of keys) {
      const blob = await idbGet(key);
      if (blob) mediaUrls.set(key, URL.createObjectURL(blob));
    }
  }

  const EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'audio/webm': 'weba', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
  };

  function uuid() {
    return crypto.randomUUID
      ? crypto.randomUUID().replaceAll('-', '')
      : Math.random().toString(16).slice(2) + Date.now().toString(16);
  }

  /* dataURL (картинки и голосовые из чата) -> File для IndexedDB */
  async function dataUrlToFile(dataUrl) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl));
    if (!m || !/^(image|audio)\//.test(m[1])) return null;
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], m[1].startsWith('audio/') ? 'voice' : 'image', { type: m[1] });
  }

  async function storeFile(file) {
    await idbReady;
    if (!file || typeof file.size !== 'number') throw fail(400, 'Файл не передан');
    const ext = EXT[file.type] || 'bin';
    const path = `/uploads/${uuid()}.${ext}`;
    await idbPut(path, file);
    mediaUrls.set(path, URL.createObjectURL(file));
    return {
      url: path,
      kind: file.type.startsWith('video/') ? 'video' : (file.type.startsWith('audio/') ? 'voice' : 'image'),
      mime: file.type || 'application/octet-stream',
      size: file.size,
      name: file.name || 'file',
    };
  }

  /* подмена путей /uploads/... на живые blob: URL во всех ответах */
  function rewrite(v) {
    if (typeof v === 'string') return /^\/uploads\//.test(v) ? (mediaUrls.get(v) || v) : v;
    if (Array.isArray(v)) return v.map(rewrite);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = rewrite(val);
      return out;
    }
    return v;
  }

  /* ---------- авторизация и утилиты ---------- */

  const hash = (s) => {
    let h = 5381;
    for (const c of 'bloop·' + String(s)) h = (((h << 5) + h) + c.charCodeAt(0)) >>> 0;
    return 'h' + h.toString(16);
  };

  const publicUser = (u) => u && {
    id: u.id, username: u.username, display_name: u.display_name,
    avatar: u.avatar ?? null, bio: u.bio ?? '',
    email_verified: !!u.email_verified,
  };

  const authUser = (headers) => {
    // plain-объект headers не нормализует регистр — читаем оба варианта
    const raw = String(headers?.authorization ?? headers?.Authorization ?? '');
    const uid = Number(raw.replace(/^Bearer\s+/i, '').replace(/^local\./, ''));
    return db.users.find(u => u.id === uid) || null;
  };

  function fail(status, message) {
    const e = new Error(message);
    e.__status = status;
    throw e;
  }

  function requireUser(me) {
    if (!me) fail(401, 'Требуется авторизация');
    return me;
  }

  function isMember(chatId, uid) {
    return db.members.some(m => m.chat_id === chatId && m.user_id === uid);
  }

  const TAG_RE = /#([\p{L}\p{N}_]{2,30})/gu;
  const extractTags = (text) => {
    const set = new Set();
    for (const m of String(text || '').matchAll(TAG_RE)) set.add(m[1].toLowerCase());
    return [...set].slice(0, 10);
  };

  function notify(userId, actorId, type, postId) {
    if (userId === actorId) return;
    const post = db.posts.find(p => p.id === postId);
    const actor = db.users.find(u => u.id === actorId);
    if (!post || !actor) return;
    db.notifs.push({
      id: next('notif'), user_id: userId, actor_id: actorId, type, post_id: postId,
      is_read: 0, created_at: now(),
      actor_name: actor.display_name, actor_username: actor.username, actor_avatar: actor.avatar,
      post_type: post.type, post_text: post.text,
    });
    emit('notification', { notification: rewrite(notifOut(db.notifs[db.notifs.length - 1])), unread: unreadCount(userId) });
  }

  function notifOut(n) { return { ...n }; }

  function unreadCount(userId) {
    return db.notifs.filter(n => n.user_id === userId && !n.is_read).length;
  }

  function msgReactionsOf(messageId, uid) {
    const out = { reactions: {}, mine: [] };
    for (const r of db.msgReactions.filter(x => x.message_id === messageId)) {
      out.reactions[r.emoji] = (out.reactions[r.emoji] || 0) + 1;
      if (r.user_id === uid) out.mine.push(r.emoji);
    }
    return out;
  }

  function msgOut(m, uid) {
    const u = db.users.find(x => x.id === m.sender_id);
    const out = {
      id: m.id, chat_id: m.chat_id, sender_id: m.sender_id, text: m.text,
      image: m.image, media_kind: m.media_kind || 'image', created_at: m.created_at,
      username: u?.username || '', display_name: u?.display_name || '',
      kb: m.kb || null,
      ...msgReactionsOf(m.id, uid),
    };
    if (m.reply_to) {
      const r = db.messages.find(x => x.id === m.reply_to);
      if (r) {
        out.reply = {
          id: r.id,
          author: db.users.find(x => x.id === r.sender_id)?.display_name || '',
          text: r.text || '',
          image: r.image || null,
          kind: r.media_kind || 'image',
          mine: r.sender_id === uid,
        };
      }
    }
    return out;
  }

  function reactionsOf(postId, uid, legacyLikes, legacyLiked) {
    const reactions = {};
    const mine = [];
    let hearts = 0;
    let iHeart = false;
    for (const r of db.postReactions.filter(x => x.post_id === postId)) {
      reactions[r.emoji] = (reactions[r.emoji] || 0) + 1;
      if (r.emoji === '❤️') { hearts = reactions['❤️']; if (r.user_id === uid) iHeart = true; }
      if (r.user_id === uid) mine.push(r.emoji);
    }
    return { reactions, mine, likes: legacyLikes + hearts, liked: legacyLiked || iHeart };
  }

  function pollOf(postId, uid) {
    const p = db.posts.find(x => x.id === postId);
    if (!p?.poll_options) return null;
    const counts = p.poll_options.map(() => 0);
    for (const v of db.pollVotes.filter(x => x.post_id === postId)) {
      if (counts[v.option_idx] !== undefined) counts[v.option_idx] += 1;
    }
    const my = db.pollVotes.find(x => x.post_id === postId && x.user_id === uid);
    return {
      options: p.poll_options,
      votes: counts,
      total: counts.reduce((s, n) => s + n, 0),
      my_vote: my ? my.option_idx : null,
    };
  }

  function postOut(p, uid) {
    const a = db.users.find(u => u.id === p.author_id);
    const legacyLikes = db.likes.filter(l => l.post_id === p.id).length;
    const legacyLiked = db.likes.some(l => l.post_id === p.id && l.user_id === uid);
    const rx = reactionsOf(p.id, uid, legacyLikes, legacyLiked);
    return {
      id: p.id, type: p.type, text: p.text, media: p.media, duration: p.duration,
      created_at: p.created_at, views: p.views,
      poll: pollOf(p.id, uid),
      reactions: rx.reactions,
      my_reactions: rx.mine,
      likes: rx.likes,
      liked_by_me: rx.liked,
      comments_count: db.comments.filter(c => c.post_id === p.id).length,
      author: a ? { id: a.id, username: a.username, display_name: a.display_name, avatar: a.avatar, email_verified: !!a.email_verified } : null,
    };
  }

  function commentOut(c) {
    const a = db.users.find(u => u.id === c.author_id);
    return {
      id: c.id, post_id: c.post_id, author_id: c.author_id, text: c.text,
      created_at: c.created_at,
      username: a?.username || '', display_name: a?.display_name || '', avatar: a?.avatar || null,
    };
  }

  function feedQuery(uid, { type, tag, before, limit = 20 }) {
    let list = db.posts.filter(p =>
      (!type || p.type === type) && (!before || p.id < before));
    if (tag) {
      const ids = new Set(db.tags.filter(t => t.tag === String(tag).toLowerCase()).map(t => t.post_id));
      list = list.filter(p => ids.has(p.id));
    }
    list.sort((a, b) => b.id - a.id);
    return list.slice(0, Number(limit)).map(p => postOut(p, uid));
  }

  function chatsFor(uid) {
    const out = [];
    for (const mem of db.members.filter(x => x.user_id === uid)) {
      const chat = db.chats.find(c => c.id === mem.chat_id);
      if (!chat) continue;
      const msgs = db.messages.filter(x => x.chat_id === chat.id).sort((a, b) => a.id - b.id);
      const last = msgs[msgs.length - 1] || null;
      let peer = null;
      if (chat.type === 'direct') {
        const peerMem = db.members.find(x => x.chat_id === chat.id && x.user_id !== uid);
        const pu = db.users.find(u => u.id === peerMem?.user_id);
        if (pu) peer = { id: pu.id, username: pu.username, display_name: pu.display_name, avatar: pu.avatar, is_bot: !!pu.is_bot, has_miniapp: pu.is_bot ? botHasMiniapp(pu.id) : false };
      }
      const lastRead = mem.last_read_message_id || 0;
      const unread = msgs.filter(x => x.id > lastRead && x.sender_id !== uid).length;
      const lastOut = last ? {
        id: last.id, sender_id: last.sender_id, text: last.text, image: last.image,
        media_kind: last.media_kind || 'image',
        created_at: last.created_at,
        display_name: db.users.find(u => u.id === last.sender_id)?.display_name || '',
      } : null;
      out.push({
        id: chat.id, type: chat.type, name: chat.name || null, peer,
        members_count: db.members.filter(x => x.chat_id === chat.id).length,
        last_message: lastOut,
        unread,
        updated_at: last ? last.created_at : chat.created_at,
      });
    }
    out.sort((a, b) => (b.last_message?.id ?? 0) - (a.last_message?.id ?? 0) || b.id - a.id);
    return out;
  }

  /* ---------- шина realtime-событий ---------- */

  const bus = new Map();
  const emit = (ev, payload) => {
    const set = bus.get(ev);
    if (set) for (const fn of [...set]) fn(payload);
  };

  class LocalSocket {
    on(ev, fn) {
      if (!bus.has(ev)) bus.set(ev, new Set());
      bus.get(ev).add(fn);
      if (ev === 'connect') setTimeout(fn, 0); // в локальном режиме «онлайн» всегда
    }
    emit() { /* typing и прочее в локальном режиме не нужно */ }
  }

  /* ---------- маршруты (полное зеркало server.js) ---------- */

  const routes = [];
  const route = (method, re, fn) => routes.push({ method, re, fn });

  route('POST', /^\/api\/register$/, ({ body }) => {
    const username = String(body?.username || '');
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) fail(400, 'Логин: 3–20 символов, латиница, цифры и _');
    if (String(body?.password || '').length < 6) fail(400, 'Пароль должен быть не короче 6 символов');
    if (db.users.some(u => u.username === username)) fail(409, 'Этот логин уже занят');
    const displayName = String(body?.display_name || username).trim().slice(0, 40) || username;
    const user = {
      id: next('user'), username, display_name: displayName,
      password_hash: hash(body.password), avatar: null, bio: '', created_at: now(),
    };
    db.users.push(user);
    save();
    return { token: `local.${user.id}`, user: publicUser(user) };
  });

  route('POST', /^\/api\/login$/, ({ body }) => {
    const user = db.users.find(u => u.username === String(body?.username || ''));
    if (!user || user.password_hash !== hash(body?.password || '')) {
      fail(401, 'Неверный логин или пароль');
    }
    return { token: `local.${user.id}`, user: publicUser(user) };
  });

  /* ---------- вход по почте (локальная доставка кода) ---------- */

  const normalizeEmail = (raw) => {
    const email = String(raw || '').trim().toLowerCase();
    if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) return null;
    return email;
  };
  const emailLastSend = new Map();

  route('POST', /^\/api\/auth\/email\/start$/, ({ body }) => {
    const email = normalizeEmail(body?.email);
    if (!email) fail(400, 'Введите корректный адрес почты');
    const last = emailLastSend.get(email) || 0;
    if (Date.now() - last < 30 * 1000) fail(429, 'Код уже отправлен — подождите 30 секунд');
    emailLastSend.set(email, Date.now());
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    const idx = db.emailCodes.findIndex(c => c.email === email);
    const rec = { email, code, expires: Date.now() + 5 * 60 * 1000, attempts: 0 };
    if (idx >= 0) db.emailCodes[idx] = rec; else db.emailCodes.push(rec);
    save();
    // Локальная доставка без сети: код возвращается клиенту и показывается
    // как «Почта BLOOP» (в офлайн-приложении SMTP физически нет).
    return { ok: true, ttl_sec: 300, delivery: 'local-sim', local_code: code };
  });

  route('POST', /^\/api\/auth\/email\/verify$/, ({ body }) => {
    const email = normalizeEmail(body?.email);
    const code = String(body?.code || '').trim();
    if (!email) fail(400, 'Некорректный адрес почты');
    const rec = db.emailCodes.find(c => c.email === email);
    if (!rec) fail(400, 'Сначала запросите код');
    if (Date.now() > rec.expires) {
      db.emailCodes = db.emailCodes.filter(c => c.email !== email);
      save();
      fail(400, 'Код истёк — запросите новый');
    }
    if (rec.attempts >= 5) {
      db.emailCodes = db.emailCodes.filter(c => c.email !== email);
      save();
      fail(429, 'Слишком много попыток — запросите новый код');
    }
    if (!code || code !== rec.code) {
      rec.attempts += 1;
      save();
      fail(401, `Неверный код (осталось ${5 - rec.attempts} попыток)`);
    }
    db.emailCodes = db.emailCodes.filter(c => c.email !== email);
    let user = db.users.find(u => u.email === email);
    let created = false;
    if (!user) {
      let username = String(email.split('@')[0]).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 17);
      if (username.length < 3) username = `user${Math.floor(Math.random() * 90000 + 10000)}`;
      if (db.users.some(u => u.username === username)) username += Math.floor(Math.random() * 90 + 10);
      const displayName = String(body?.display_name || '').trim().slice(0, 40) || `Гость ${Math.floor(Math.random() * 900 + 100)}`;
      user = {
        id: next('user'), username, display_name: displayName,
        password_hash: '', avatar: null, bio: '', email,
        email_verified: 1, created_at: now(),
      };
      db.users.push(user);
      created = true;
    }
    save();
    return { token: `local.${user.id}`, user: publicUser(user), created };
  });

  route('GET', /^\/api\/me$/, ({ me }) => ({ user: publicUser(requireUser(me)) }));

  route('GET', /^\/api\/users$/, ({ me }) => {
    requireUser(me);
    // локальный мир: считаем всех «онлайн» — это одна локальная копия BLOOP
    return { users: db.users.filter(u => !u.is_bot).map(u => ({ ...publicUser(u), online: true })) };
  });

  route('POST', /^\/api\/chats$/, async ({ me, body }) => {
    me = requireUser(me);
    if (body?.type === 'direct') {
      const peer = db.users.find(u => u.id === Number(body.user_id));
      if (!peer) fail(404, 'Пользователь не найден');
      if (peer.id === me.id) fail(400, 'Нельзя открыть чат с самим собой');
      const existing = db.chats.find(c =>
        c.type === 'direct' &&
        db.members.filter(m => m.chat_id === c.id).map(m => m.user_id).sort().join(',') ===
        [me.id, peer.id].sort().join(','));
      if (existing) return { chat_id: existing.id, existed: true };
      const chatId = next('chat');
      db.chats.push({ id: chatId, type: 'direct', name: null, created_by: me.id, created_at: now() });
      db.members.push({ chat_id: chatId, user_id: me.id, last_read_message_id: 0 });
      db.members.push({ chat_id: chatId, user_id: peer.id, last_read_message_id: 0 });
      save();
      emit('chat:new', { chat_id: chatId });
      // первый заход в чат с ботом — событие start
      if (peer.is_bot) {
        const startBot = db.bots.find(b => b.user_id === peer.id && !b.deleted);
        if (startBot) await runBotEventLocal(startBot, chatId, me, { kind: 'start' });
      }
      return { chat_id: chatId, existed: false };
    }
    if (body?.type === 'group') {
      const title = String(body?.name || '').trim();
      if (!title || title.length > 60) fail(400, 'Название группы: 1–60 символов');
      const ids = [...new Set([...(body.member_ids || []).map(Number), me.id])];
      if (ids.some(id => !db.users.some(u => u.id === id))) fail(404, 'Пользователь не найден');
      const chatId = next('chat');
      db.chats.push({ id: chatId, type: 'group', name: title, created_by: me.id, created_at: now() });
      for (const id of ids) db.members.push({ chat_id: chatId, user_id: id, last_read_message_id: 0 });
      save();
      emit('chat:new', { chat_id: chatId });
      return { chat_id: chatId, existed: false };
    }
    fail(400, 'Неизвестный тип чата');
  });

  route('GET', /^\/api\/chats$/, ({ me }) => ({ chats: chatsFor(requireUser(me).id) }));

  route('GET', /^\/api\/chats\/(\d+)\/messages$/, ({ me, params, query }) => {
    const chatId = Number(params[0]);
    if (!isMember(chatId, requireUser(me).id)) fail(403, 'Нет доступа к чату');
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const before = Math.max(0, Number(query.before) || 0);
    let msgs = db.messages.filter(x => x.chat_id === chatId && (!before || x.id < before));
    msgs.sort((a, b) => a.id - b.id);
    return { messages: msgs.slice(-limit).map(m => msgOut(m, requireUser(me).id)) };
  });

  route('POST', /^\/api\/chats\/(\d+)\/messages$/, async ({ me, params, body, file }) => {
    me = requireUser(me);
    const chatId = Number(params[0]);
    if (!isMember(chatId, me.id)) fail(403, 'Нет доступа к чату');
    let imageFile = file;
    if (!imageFile && body?.image) imageFile = await dataUrlToFile(body.image); // чат шлёт dataURL
    if (!imageFile && body?.voice) imageFile = await dataUrlToFile(body.voice); // голосовое
    let imagePath = null;
    let mediaKind = 'image';
    if (imageFile) {
      const up = await storeFile(imageFile);
      if (up.kind !== 'image' && up.kind !== 'voice') fail(400, 'Поддерживаются изображения и голосовые');
      imagePath = up.url;
      mediaKind = up.kind;
    }
    const text = String(body?.text || '').trim().slice(0, 4000);
    if (!text && !imagePath) fail(400, 'Пустое сообщение');
    let replyTo = Number(body?.reply_to) || null;
    if (replyTo && !db.messages.some(x => x.id === replyTo && x.chat_id === chatId)) replyTo = null;
    const message = {
      id: next('msg'), chat_id: chatId, sender_id: me.id,
      text, image: imagePath, media_kind: mediaKind, reply_to: replyTo, created_at: now(),
    };
    db.messages.push(message);
    save();
    const out = msgOut(message, me.id);
    emit('message', rewrite(out));
    // чат с ботом: передаём сообщение движку, ответы отдаём клиенту
    const msgBot = findChatBot(chatId);
    let botMessages = [];
    if (msgBot) {
      const beforeId = message.id;
      try { await runBotEventLocal(msgBot, chatId, me, { kind: 'message', text, message_id: message.id }); }
      catch (e) { console.error('BLOOP local, ошибка бота:', e); }
      botMessages = db.messages
        .filter(x => x.chat_id === chatId && x.id > beforeId)
        .map(m => msgOut(m, me.id));
    }
    return { message: rewrite(out), bot_messages: rewrite(botMessages) };
  });

  // эмодзи-реакция на сообщении
  route('POST', /^\/api\/chats\/(\d+)\/messages\/(\d+)\/react$/, ({ me, params, body }) => {
    me = requireUser(me);
    const chatId = Number(params[0]);
    const mid = Number(params[1]);
    if (!isMember(chatId, me.id)) fail(403, 'Нет доступа к чату');
    if (!db.messages.some(x => x.id === mid && x.chat_id === chatId)) fail(404, 'Сообщение не найдено');
    const emoji = String(body?.emoji || '');
    if (!['❤️', '🔥', '😂', '😮', '😢', '👍'].includes(emoji)) fail(400, 'Неизвестная реакция');
    const mine = db.msgReactions.filter(x => x.message_id === mid && x.user_id === me.id);
    const had = mine.some(x => x.emoji === emoji);
    db.msgReactions = db.msgReactions.filter(x => !(x.message_id === mid && x.user_id === me.id));
    if (!had) db.msgReactions.push({ message_id: mid, user_id: me.id, emoji });
    save();
    const out = msgReactionsOf(mid, me.id);
    emit('message:react', { chat_id: chatId, message_id: mid, ...out });
    return out;
  });

  route('POST', /^\/api\/chats\/(\d+)\/read$/, ({ me, params }) => {
    const chatId = Number(params[0]);
    if (!isMember(chatId, requireUser(me).id)) fail(403, 'Нет доступа к чату');
    const mem = db.members.find(m => m.chat_id === chatId && m.user_id === me.id);
    const maxId = Math.max(0, ...db.messages.filter(x => x.chat_id === chatId).map(x => x.id));
    if (mem) mem.last_read_message_id = maxId;
    save();
    return { ok: true };
  });

  route('POST', /^\/api\/upload$/, async ({ file }) => {
    if (!file) fail(400, 'Файл не передан');
    const up = await storeFile(file);
    return up;
  });

  route('POST', /^\/api\/posts$/, async ({ me, body, file }) => {
    me = requireUser(me);
    const type = body?.type;
    if (!['post', 'clip', 'video'].includes(type)) fail(400, 'Неизвестный тип публикации');
    const text = String(body?.text || '').trim().slice(0, 4000);
    let pollOptions = null;
    if (body?.poll !== undefined && body?.poll !== null) {
      if (!Array.isArray(body.poll) || body.poll.length < 2 || body.poll.length > 4) {
        fail(400, 'Опрос: от 2 до 4 вариантов');
      }
      pollOptions = body.poll.map(o => String(o || '').trim().slice(0, 60)).filter(Boolean);
      if (pollOptions.length !== body.poll.length) fail(400, 'Варианты опроса не могут быть пустыми');
    }
    let media = null;
    if (file) media = (await storeFile(file)).url;
    else if (body?.media) media = String(body.media);
    const videoExt = /\.(mp4|webm|mov)$/;
    if (media && !/^\/uploads\/[a-z0-9]+\.[a-z]+$/.test(media)) fail(400, 'Некорректная ссылка на медиафайл');
    if (media && pollOptions) fail(400, 'В опросе не может быть медиафайла');
    if (type === 'post' && media && videoExt.test(media)) fail(400, 'В посте допустимо только изображение');
    if ((type === 'clip' || type === 'video') && media && !videoExt.test(media)) {
      fail(400, 'Клипы и видео — только видеофайлы (MP4, WebM, MOV)');
    }
    if ((type === 'clip' || type === 'video') && !media) fail(400, 'Для клипа/видео нужно приложить видеофайл');
    if (!text && !media && !pollOptions) fail(400, 'Пустая публикация');
    const dur = Number(body?.duration);
    const post = {
      id: next('post'), author_id: me.id, type, text,
      media, duration: Number.isFinite(dur) && dur > 0 && dur < 36000 ? dur : null,
      poll_options: pollOptions,
      views: 0, created_at: now(),
    };
    db.posts.push(post);
    for (const tag of extractTags(text)) db.tags.push({ post_id: post.id, tag });
    save();
    const out = postOut(post, me.id);
    emit('post:new', { post: rewrite(out) });
    return { post: rewrite(out) };
  });

  route('GET', /^\/api\/feed$/, ({ me, query }) => {
    const type = ['post', 'clip', 'video'].includes(query.type) ? query.type : null;
    return { posts: feedQuery(requireUser(me).id, { type, tag: query.tag, before: Number(query.before) || 0, limit: Math.min(50, Math.max(1, Number(query.limit) || 20)) }) };
  });

  route('GET', /^\/api\/posts\/(\d+)$/, ({ me, params }) => {
    const p = db.posts.find(x => x.id === Number(params[0]));
    if (!p) fail(404, 'Публикация не найдена');
    return { post: postOut(p, requireUser(me).id) };
  });

  route('DELETE', /^\/api\/posts\/(\d+)$/, ({ me, params }) => {
    me = requireUser(me);
    const id = Number(params[0]);
    const p = db.posts.find(x => x.id === id);
    if (!p || p.author_id !== me.id) fail(403, 'Можно удалять только свои публикации');
    db.posts = db.posts.filter(x => x.id !== id);
    db.likes = db.likes.filter(l => l.post_id !== id);
    db.comments = db.comments.filter(c => c.post_id !== id);
    db.tags = db.tags.filter(t => t.post_id !== id);
    db.notifs = db.notifs.filter(n => n.post_id !== id);
    db.postReactions = db.postReactions.filter(r => r.post_id !== id);
    db.pollVotes = db.pollVotes.filter(v => v.post_id !== id);
    save();
    return { ok: true };
  });

  route('POST', /^\/api\/posts\/(\d+)\/like$/, ({ me, params }) => {
    me = requireUser(me);
    const id = Number(params[0]);
    const p = db.posts.find(x => x.id === id);
    if (!p) fail(404, 'Публикация не найдена');
    // лайк = реакция ❤️ (старые записи likes остаются в счётчике)
    const had = db.postReactions.some(r => r.post_id === id && r.user_id === me.id && r.emoji === '❤️');
    if (had) db.postReactions = db.postReactions.filter(r => !(r.post_id === id && r.user_id === me.id && r.emoji === '❤️'));
    else db.postReactions.push({ post_id: id, user_id: me.id, emoji: '❤️' });
    save();
    const out = postOut(p, me.id);
    emit('post:stats', { post_id: id, likes: out.likes, liked_by_me: out.liked_by_me, reactions: out.reactions });
    if (!had) notify(p.author_id, me.id, 'like', id);
    return { liked: out.liked_by_me, likes: out.likes, reactions: out.reactions, mine: out.my_reactions };
  });

  // эмодзи-реакция на посте
  route('POST', /^\/api\/posts\/(\d+)\/react$/, ({ me, params, body }) => {
    me = requireUser(me);
    const id = Number(params[0]);
    const p = db.posts.find(x => x.id === id);
    if (!p) fail(404, 'Публикация не найдена');
    const emoji = String(body?.emoji || '');
    if (!['❤️', '🔥', '😂', '😮', '😢', '👍', '🤯', '💚'].includes(emoji)) fail(400, 'Неизвестная реакция');
    const existing = db.postReactions.filter(r => r.post_id === id && r.user_id === me.id);
    if (existing.some(r => r.emoji === emoji)) {
      db.postReactions = db.postReactions.filter(r => !(r.post_id === id && r.user_id === me.id));
    } else {
      db.postReactions = db.postReactions.filter(r => !(r.post_id === id && r.user_id === me.id));
      db.postReactions.push({ post_id: id, user_id: me.id, emoji });
    }
    save();
    const out = postOut(p, me.id);
    emit('post:stats', { post_id: id, likes: out.likes, liked_by_me: out.liked_by_me, reactions: out.reactions });
    if (out.liked_by_me && emoji === '❤️') notify(p.author_id, me.id, 'like', id);
    return { liked: out.liked_by_me, likes: out.likes, reactions: out.reactions, mine: out.my_reactions };
  });

  // голосование в опросе
  route('POST', /^\/api\/posts\/(\d+)\/poll$/, ({ me, params, body }) => {
    me = requireUser(me);
    const id = Number(params[0]);
    const p = db.posts.find(x => x.id === id);
    if (!p?.poll_options) fail(400, 'У поста нет опроса');
    const idx = Number(body?.option_idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= p.poll_options.length) fail(400, 'Неверный вариант ответа');
    const existing = db.pollVotes.find(v => v.post_id === id && v.user_id === me.id);
    if (existing) existing.option_idx = idx;
    else db.pollVotes.push({ post_id: id, user_id: me.id, option_idx: idx });
    save();
    const poll = pollOf(id, me.id);
    emit('post:poll', { post_id: id, poll });
    return { poll };
  });

  /* ---------- мгновения (истории на 24 часа) ---------- */

  route('POST', /^\/api\/stories$/, async ({ me, body }) => {
    me = requireUser(me);
    const kind = body?.kind === 'image' ? 'image' : 'text';
    let media = null;
    if (kind === 'image') {
      const f = await dataUrlToFile(body?.image);
      if (!f) fail(400, 'Приложите фото или используйте текстовое мгновение');
      const up = await storeFile(f);
      media = up.url;
    }
    const text = String(body?.text || '').trim().slice(0, 500);
    if (kind === 'text' && !text) fail(400, 'Текст мгновения пуст');
    if (kind === 'text') media = null;
    const bg = kind === 'text' ? String(body?.bg || 'aurora').slice(0, 24) : null;
    const story = {
      id: next('story'), user_id: me.id, kind,
      media, text: text || null, bg,
      views: 0, created_at: now(), expires_at: Date.now() + 24 * 3600 * 1000,
    };
    db.stories.push(story);
    db.stories = db.stories.filter(s => s.expires_at > Date.now()); // подчистим просроченные
    save();
    emit('stories:update');
    return { ok: true, id: story.id };
  });

  route('GET', /^\/api\/stories$/, ({ me }) => {
    me = requireUser(me);
    const groups = new Map();
    for (const s of db.stories.filter(x => x.expires_at > Date.now()).sort((a, b) => a.id - b.id)) {
      const u = db.users.find(x => x.id === s.user_id);
      if (!u) continue;
      if (!groups.has(s.user_id)) {
        groups.set(s.user_id, {
          user: { id: u.id, username: u.username, display_name: u.display_name, avatar: u.avatar },
          stories: [],
        });
      }
      groups.get(s.user_id).stories.push({
        id: s.id, kind: s.kind, media: s.media, text: s.text, bg: s.bg, views: s.views,
        created_at: s.created_at, expires_at: s.expires_at,
        viewed_by_me: db.storyViews.some(v => v.story_id === s.id && v.user_id === me.id),
      });
    }
    const list = [...groups.values()].sort((a, b) => {
      const own = (x) => x.user.id === me.id ? 1 : 0;
      if (own(a) !== own(b)) return own(b) - own(a);
      const unseen = (x) => x.stories.some(s => !s.viewed_by_me) ? 1 : 0;
      if (unseen(a) !== unseen(b)) return unseen(b) - unseen(a);
      return Math.max(...b.stories.map(s => s.id)) - Math.max(...a.stories.map(s => s.id));
    });
    return { users: list };
  });

  route('POST', /^\/api\/stories\/(\d+)\/view$/, ({ me, params }) => {
    me = requireUser(me);
    const id = Number(params[0]);
    const s = db.stories.find(x => x.id === id && x.expires_at > Date.now());
    if (!s) fail(404, 'Мгновение не найдено или истекло');
    if (!db.storyViews.some(v => v.story_id === id && v.user_id === me.id)) {
      db.storyViews.push({ story_id: id, user_id: me.id, seen_at: now() });
      s.views += 1;
      save();
    }
    return { views: s.views };
  });

  route('DELETE', /^\/api\/stories\/(\d+)$/, ({ me, params }) => {
    me = requireUser(me);
    const id = Number(params[0]);
    const s = db.stories.find(x => x.id === id);
    if (!s || s.user_id !== me.id) fail(403, 'Можно удалять только свои мгновения');
    db.stories = db.stories.filter(x => x.id !== id);
    db.storyViews = db.storyViews.filter(v => v.story_id !== id);
    save();
    emit('stories:update');
    return { ok: true };
  });

  /* ---------- бейджи-заслуги ---------- */

  route('GET', /^\/api\/users\/(\d+)\/badges$/, ({ params }) => {
    const uid = Number(params[0]);
    const u = db.users.find(x => x.id === uid);
    if (!u) fail(404, 'Пользователь не найден');
    const posts = db.posts.filter(p => p.author_id === uid);
    const postIds = new Set(posts.map(p => p.id));
    const b = (key, icon, title, desc, cur, goal) => ({ key, icon, title, desc, unlocked: cur >= goal, progress: [cur, goal] });
    return { badges: [
      b('first_post', '🌱', 'Первые слова', 'Опубликовать первый пост', posts.length, 1),
      b('writer_10', '✍️', 'Блогер', '10 публикаций в ленте', posts.length, 10),
      b('clipper', '🎬', 'Клипмейкер', 'Снять первый клип', posts.filter(p => p.type === 'clip').length, 1),
      b('director', '🎥', 'Режиссёр', 'Загрузить своё видео', posts.filter(p => p.type === 'video').length, 1),
      b('voice', '🎙', 'Голос BLOOP', 'Отправить голосовое в чате', db.messages.filter(m => m.sender_id === uid && (m.media_kind || 'image') === 'voice').length, 1),
      b('loved_50', '❤️', 'Народный любимец', 'Собрать 50 лайков на своих публикациях', db.likes.filter(l => postIds.has(l.post_id)).length + db.postReactions.filter(r => postIds.has(r.post_id) && r.emoji === '❤️').length, 50),
      b('viral_1000', '🔥', 'Вирусный', 'Набрать 1000 просмотров на одной публикации', Math.max(0, ...posts.map(p => p.views || 0)), 1000),
      b('chatty', '💬', 'Трибуна', 'Поучаствовать в 5 чатах', new Set(db.members.filter(m => m.user_id === uid).map(m => m.chat_id)).size, 5),
      b('moment', '✨', 'Мгновение', 'Выложить первую историю', db.stories.filter(s => s.user_id === uid).length, 1),
      b('verified', '✉️', 'Проверенный', 'Подтвердить почту при входе', u.email_verified ? 1 : 0, 1),
    ] };
  });

  route('POST', /^\/api\/posts\/(\d+)\/view$/, ({ params }) => {
    const p = db.posts.find(x => x.id === Number(params[0]));
    if (!p) fail(404, 'Публикация не найдена');
    p.views += 1;
    save();
    return { views: p.views };
  });

  route('GET', /^\/api\/posts\/(\d+)\/comments$/, ({ params }) => ({
    comments: db.comments.filter(c => c.post_id === Number(params[0])).map(commentOut),
  }));

  route('POST', /^\/api\/posts\/(\d+)\/comments$/, ({ me, params, body }) => {
    me = requireUser(me);
    const id = Number(params[0]);
    const p = db.posts.find(x => x.id === id);
    if (!p) fail(404, 'Публикация не найдена');
    const text = String(body?.text || '').trim().slice(0, 1000);
    if (!text) fail(400, 'Пустой комментарий');
    const comment = { id: next('comment'), post_id: id, author_id: me.id, text, created_at: now() };
    db.comments.push(comment);
    save();
    const out = commentOut(comment);
    emit('comment:new', { post_id: id, comment: rewrite(out) });
    emit('post:stats', { post_id: id, comments_count: db.comments.filter(c => c.post_id === id).length });
    notify(p.author_id, me.id, 'comment', id);
    return { comment: rewrite(out) };
  });

  route('GET', /^\/api\/users\/(\d+)$/, ({ params }) => {
    const u = db.users.find(x => x.id === Number(params[0]));
    if (!u) fail(404, 'Пользователь не найден');
    const posts = db.posts.filter(p => p.author_id === u.id);
    return {
      user: publicUser(u),
      counts: {
        posts: posts.length,
        clips: posts.filter(p => p.type === 'clip').length,
        videos: posts.filter(p => p.type === 'video').length,
      },
      stats: {
        views: posts.reduce((s, p) => s + (p.views || 0), 0),
        likes_received: db.likes.filter(l => posts.some(p => p.id === l.post_id)).length,
      },
    };
  });

  route('GET', /^\/api\/users\/(\d+)\/posts$/, ({ me, params, query }) => {
    const type = ['post', 'clip', 'video'].includes(query.type) ? query.type : null;
    const uid = Number(params[0]);
    let list = db.posts.filter(p => p.author_id === uid && (!type || p.type === type));
    const before = Math.max(0, Number(query.before) || 0);
    if (before) list = list.filter(p => p.id < before);
    list.sort((a, b) => b.id - a.id);
    return { posts: list.slice(0, Math.min(50, Math.max(1, Number(query.limit) || 20))).map(p => postOut(p, requireUser(me).id)) };
  });

  route('PATCH', /^\/api\/me$/, ({ me, body }) => {
    me = requireUser(me);
    if (body?.display_name !== undefined) me.display_name = String(body.display_name).trim().slice(0, 40) || me.display_name;
    if (body?.bio !== undefined) me.bio = String(body.bio).trim().slice(0, 300);
    save();
    return { user: publicUser(me) };
  });

  route('POST', /^\/api\/me\/avatar$/, async ({ me, file }) => {
    me = requireUser(me);
    if (!file) fail(400, 'Файл не передан');
    const up = await storeFile(file);
    if (up.kind !== 'image') fail(400, 'Нужна картинка до 10 МБ');
    me.avatar = up.url;
    save();
    return { user: publicUser(me) };
  });

  route('GET', /^\/api\/notifications$/, ({ me }) => {
    me = requireUser(me);
    const list = db.notifs.filter(n => n.user_id === me.id).sort((a, b) => b.id - a.id).slice(0, 50);
    return { notifications: list.map(notifOut), unread: unreadCount(me.id) };
  });

  route('POST', /^\/api\/notifications\/read$/, ({ me, body }) => {
    me = requireUser(me);
    if (Array.isArray(body?.ids) && body.ids.length > 0) {
      for (const n of db.notifs) if (n.user_id === me.id && body.ids.includes(n.id)) n.is_read = 1;
    } else {
      for (const n of db.notifs) if (n.user_id === me.id) n.is_read = 1;
    }
    save();
    return { unread: unreadCount(me.id) };
  });

  route('GET', /^\/api\/search$/, ({ me, query }) => {
    const q = String(query.q || '').trim().slice(0, 100).toLowerCase();
    if (!q) return { posts: [] };
    const list = db.posts.filter(p => (p.text || '').toLowerCase().includes(q)).sort((a, b) => b.id - a.id).slice(0, 30);
    return { posts: list.map(p => postOut(p, requireUser(me).id)) };
  });

  route('GET', /^\/api\/trends$/, ({ query }) => {
    const limit = Math.min(20, Math.max(1, Number(query?.limit) || 8));
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    const counts = new Map();
    for (const t of db.tags) {
      const p = db.posts.find(x => x.id === t.post_id);
      if (p && p.created_at >= cutoff) counts.set(t.tag, (counts.get(t.tag) || 0) + 1);
    }
    return { trends: [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, limit) };
  });

  /* Floop в офлайне: честные заготовки без нейросети */
  function assistantFallback(question) {
    const q = String(question || '').toLowerCase();
    if (/привет|здравств|хай|hello/.test(q)) {
      return 'Привет! Я Floop — помощник BLOOP. Сейчас я в офлайн-режиме (без нейросети), но идеями постов, хэштегами и советами для Вирусометра помогу. Спрашивай!';
    }
    if (/что (ты )?умеешь|помощь|help|умеешь/.test(q)) {
      return 'В офлайн-режиме я умею: подсказывать идеи постов, подписи к фото и хэштеги, объяснять Вирусометр и помогать с клипами и голосовыми.';
    }
    if (/пост|идея|подпись|хэштег|хештег|клип/.test(q)) {
      const ideas = [
        'Идея поста: расскажи, что тебя сегодня удивило, и задай вопрос читателям #bloop #интересное',
        'Подпись к клипу: «Поймал момент» — коротко и цепляюще. Или: «Когда день удался».',
        'Хэштеги: #bloop #интересное #клипы #мысли — не больше 5 на пост.',
      ];
      return ideas[Math.floor(Math.random() * ideas.length)];
    }
    if (/голосов|микрофон|запис/.test(q)) {
      return 'Голосовые в чате: нажми значок микрофона у поля ввода, запиши и отправь — волну и длительность увидят все!';
    }
    if (/вирус|пульс|популярн|рейтинг/.test(q)) {
      return 'Вирусометр — фишка BLOOP: оцениваю твой пост до публикации (0–100) и показываю «пульс» после — как быстро он набирает лайки и просмотры';
    }
    return 'Я в офлайн-режиме этого устройства. Спроси про идеи постов, подписи, хэштеги или Вирусометр — с этим помогу и без сети.';
  }

  route('POST', /^\/api\/assistant$/, ({ body }) => {
    const history = Array.isArray(body?.messages) ? body.messages.slice(-20) : [];
    const last = [...history].reverse().find(m => m?.role === 'user');
    return { reply: assistantFallback(last?.content), source: 'fallback' };
  });


  /* ---------- платформа ботов (v6): движок в браузере ---------- */

  const ECHO_TEMPLATE = `// Эхо-бот: повторяет всё, что ему написали.
// Доступно: ctx.reply(текст, { keyboard }), ctx.state, ctx.message, ctx.user
if (ctx.event === 'start') {
  ctx.reply('Привет, ' + ctx.user.name + '! Я эхо-бот. Напиши мне что-нибудь.');
} else if (ctx.event === 'message') {
  ctx.reply('Ты написал: ' + ctx.message.text);
}`;

  function botHasMiniapp(botUserId) {
    const b = db.bots.find(x => x.user_id === botUserId && x.enabled && !x.deleted);
    return !!(b?.miniapp_enabled && (b.miniapp_code || '').trim());
  }

  function findChatBot(chatId) {
    for (const m of db.members.filter(x => x.chat_id === chatId)) {
      const u = db.users.find(x => x.id === m.user_id);
      if (u?.is_bot) return db.bots.find(b => b.user_id === u.id && !b.deleted) || null;
    }
    return null;
  }

  function publicBotLocal(b, withToken) {
    const out = {
      id: b.id, user_id: b.user_id, username: b.username,
      display_name: b.display_name, description: b.description || '',
      enabled: !!b.enabled, msg_count: b.msg_count || 0,
      has_miniapp: !!(b.miniapp_enabled && (b.miniapp_code || '').trim()),
      created_at: b.created_at,
    };
    if (withToken) {
      out.token = b.token;
      out.code = b.code || '';
      out.miniapp = { enabled: !!b.miniapp_enabled, title: b.miniapp_title || '', code: b.miniapp_code || '' };
      out.logs = b.logs || [];
    }
    return out;
  }

  function normalizeKbLocal(kb) {
    if (!Array.isArray(kb) || kb.length === 0) return null;
    const normBtn = (b) => {
      if (typeof b === 'string') return { t: b.slice(0, 64), d: b.slice(0, 64) };
      if (b && typeof b === 'object') {
        const t = String(b.t ?? b.text ?? '').trim().slice(0, 64);
        const d = String(b.d ?? b.data ?? t).trim().slice(0, 64);
        return t ? { t, d } : null;
      }
      return null;
    };
    const rows = kb.slice(0, 6).map(row => {
      const arr = Array.isArray(row) ? row : [row];
      return arr.slice(0, 4).map(normBtn).filter(Boolean);
    }).filter(r => r.length);
    return rows.length ? rows : null;
  }

  function botReplyLocal(bot, chatId, text, kb) {
    const t = String(text ?? '').trim().slice(0, 4000);
    if (!t) throw new Error('ctx.reply: текст пуст');
    const msg = {
      id: next('msg'), chat_id: chatId, sender_id: bot.user_id,
      text: t, image: null, media_kind: 'image', reply_to: null,
      kb: kb || null, created_at: now(),
    };
    db.messages.push(msg);
    bot.msg_count = (bot.msg_count || 0) + 1;
    save();
    emit('message', rewrite(msgOut(msg, 0)));
    return msg;
  }

  const cloneVal = (v) => {
    try { return JSON.parse(JSON.stringify(v ?? null)); } catch { return String(v); }
  };

  // тот же контракт ctx, что и на сервере; песочница — new Function + таймаут
  async function runBotEventLocal(bot, chatId, user, event) {
    if (!bot.enabled || bot.deleted) return { skipped: true };
    const logs = Array.isArray(bot.logs) ? bot.logs.slice(-25) : [];
    const pushLog = (level, parts) => {
      logs.push({
        t: Date.now(), level, event: event.kind,
        text: parts.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ').slice(0, 300),
      });
      if (logs.length > 30) logs.shift();
    };
    const con = {
      log: (...a) => pushLog('log', a), info: (...a) => pushLog('log', a),
      warn: (...a) => pushLog('warn', a), error: (...a) => pushLog('error', a),
    };
    if (!db.botStates[bot.id] || typeof db.botStates[bot.id] !== 'object') db.botStates[bot.id] = {};
    const stateData = db.botStates[bot.id];
    const state = {
      get(key, def = null) {
        const v = stateData[String(key).slice(0, 64)];
        return v === undefined ? def : v;
      },
      set(key, val) {
        stateData[String(key).slice(0, 64)] = cloneVal(val);
        const keys = Object.keys(stateData);
        if (keys.length > 100) for (const k of keys.slice(0, keys.length - 100)) delete stateData[k];
      },
      keys: () => Object.keys(stateData),
    };
    const reply = (text, opts = {}) =>
      botReplyLocal(bot, chatId, text, opts?.keyboard ? normalizeKbLocal(opts.keyboard) : null);

    const raw = String(event.text || '').trim();
    const mCmd = /^\/([a-zA-Z0-9_]{1,24})(?:\s+([\s\S]*))?$/.exec(raw);
    const cmd = mCmd ? {
      command: mCmd[1].toLowerCase(),
      args: (mCmd[2] || '').trim() ? (mCmd[2] || '').trim().split(/\s+/) : [],
      argsText: (mCmd[2] || '').trim(),
    } : null;

    const ctx = {
      event: event.kind,
      message: event.kind === 'message' ? {
        text: raw.slice(0, 4000), command: cmd?.command ?? null,
        args: cmd?.args ?? [], argsText: cmd?.argsText ?? '',
        message_id: Number(event.message_id) || null,
      } : null,
      callback: event.kind === 'callback' ? {
        data: String(event.data || '').slice(0, 64),
        message_id: Number(event.message_id) || null,
      } : null,
      miniapp: event.kind === 'miniapp' ? { data: cloneVal(event.data) } : null,
      user: { id: user.id, name: user.display_name, username: user.username },
      chat: { id: chatId },
      reply, state,
    };

    let error = null;
    const code = String(bot.code || '').trim();
    if (!code) {
      if (event.kind === 'start') {
        try { reply('Бот подключён, но у него пока нет программы. Владелец может написать код в разделе «Мои боты».'); } catch { /* noop */ }
      }
    } else {
      try {
        const fn = new Function('ctx', '(async () => {\n' + code + '\n})()');
        await Promise.race([Promise.resolve(fn(ctx)), new Promise((r) => setTimeout(r, 3000))]);
      } catch (e) {
        error = String(e?.message || e).slice(0, 300);
        pushLog('error', [error]);
      }
    }
    bot.logs = logs;
    save();
    return { logs, error };
  }

  /* ---------- маршруты ботов ---------- */

  route('GET', /^\/api\/bots\/mine$/, ({ me }) => {
    requireUser(me);
    return { bots: db.bots.filter(b => b.owner_id === me.id && !b.deleted).sort((a, b) => b.id - a.id).map(b => publicBotLocal(b, true)) };
  });

  route('POST', /^\/api\/bots$/, ({ me, body }) => {
    me = requireUser(me);
    let username = String(body?.username || '').trim().toLowerCase();
    if (username && !username.startsWith('bot_')) username = 'bot_' + username;
    if (!/^bot_[a-z0-9_]{3,24}$/.test(username)) fail(400, 'Юзернейм бота: bot_имя, 3–24 символа — латиница, цифры, _');
    if (db.users.some(u => u.username === username)) fail(409, 'Такой юзернейм уже занят');
    const displayName = String(body?.display_name || '').trim().slice(0, 40) || username.replace(/^bot_/, 'Бот ');
    const description = String(body?.description || '').trim().slice(0, 300);
    const user = {
      id: next('user'), username, display_name: displayName,
      password_hash: '', avatar: null, bio: '', is_bot: 1, created_at: now(),
    };
    db.users.push(user);
    const bot = {
      id: next('bot'), owner_id: me.id, user_id: user.id,
      username, display_name: displayName, description,
      token: 'bta_' + uuid().replaceAll('-', ''),
      code: ECHO_TEMPLATE, enabled: 1, deleted: 0, msg_count: 0, logs: [],
      miniapp_enabled: 0, miniapp_title: '', miniapp_code: '',
      created_at: now(),
    };
    db.bots.push(bot);
    save();
    return { bot: publicBotLocal(bot, true) };
  });

  route('PUT', /^\/api\/bots\/(\d+)$/, ({ me, params, body }) => {
    me = requireUser(me);
    const bot = db.bots.find(b => b.id === params[0] && !b.deleted);
    if (!bot) fail(404, 'Бот не найден');
    if (bot.owner_id !== me.id) fail(403, 'Это не ваш бот');
    const b = body || {};
    if (b.display_name !== undefined) {
      bot.display_name = String(b.display_name).trim().slice(0, 40) || bot.display_name;
      const u = db.users.find(x => x.id === bot.user_id);
      if (u) u.display_name = bot.display_name;
    }
    if (b.description !== undefined) bot.description = String(b.description).trim().slice(0, 300);
    if (b.code !== undefined) {
      const code = String(b.code);
      if (code.length > 20000) fail(400, 'Код больше 20000 символов');
      bot.code = code;
    }
    if (b.enabled !== undefined) bot.enabled = b.enabled ? 1 : 0;
    if (b.miniapp_enabled !== undefined) bot.miniapp_enabled = b.miniapp_enabled ? 1 : 0;
    if (b.miniapp_title !== undefined) bot.miniapp_title = String(b.miniapp_title).trim().slice(0, 60);
    if (b.miniapp_code !== undefined) {
      const mc = String(b.miniapp_code);
      if (mc.length > 60000) fail(400, 'Код мини-аппа больше 60000 символов');
      bot.miniapp_code = mc;
    }
    save();
    return { bot: publicBotLocal(bot, true) };
  });

  route('POST', /^\/api\/bots\/(\d+)\/retoken$/, ({ me, params }) => {
    me = requireUser(me);
    const bot = db.bots.find(b => b.id === params[0] && !b.deleted);
    if (!bot) fail(404, 'Бот не найден');
    if (bot.owner_id !== me.id) fail(403, 'Это не ваш бот');
    bot.token = 'bta_' + uuid().replaceAll('-', '');
    save();
    return { token: bot.token };
  });

  route('DELETE', /^\/api\/bots\/(\d+)$/, ({ me, params }) => {
    me = requireUser(me);
    const bot = db.bots.find(b => b.id === params[0] && !b.deleted);
    if (!bot) fail(404, 'Бот не найден');
    if (bot.owner_id !== me.id) fail(403, 'Это не ваш бот');
    bot.deleted = 1;
    bot.enabled = 0;
    const u = db.users.find(x => x.id === bot.user_id);
    if (u) u.display_name = 'Удалённый бот';
    save();
    return { ok: true };
  });

  route('GET', /^\/api\/bots\/public$/, () => ({
    bots: db.bots.filter(b => b.enabled && !b.deleted)
      .sort((a, b) => (b.msg_count || 0) - (a.msg_count || 0) || b.id - a.id)
      .map(b => publicBotLocal(b, false)),
  }));

  route('POST', /^\/api\/chats\/(\d+)\/callback$/, async ({ me, params, body }) => {
    me = requireUser(me);
    const chatId = params[0];
    if (!isMember(chatId, me.id)) fail(403, 'Нет доступа к чату');
    const bot = findChatBot(chatId);
    if (!bot) fail(404, 'В этом чате нет бота');
    const data = String(body?.data || '').slice(0, 64);
    const messageId = Number(body?.message_id) || null;
    const beforeId = db.messages.length ? db.messages[db.messages.length - 1].id : 0;
    try {
      await runBotEventLocal(bot, chatId, me, { kind: 'callback', data, message_id: messageId });
    } catch (e) {
      console.error('BLOOP local, ошибка бота:', e);
    }
    const botMessages = db.messages
      .filter(x => x.chat_id === chatId && x.id > beforeId)
      .map(m => msgOut(m, me.id));
    return { ok: true, bot_messages: rewrite(botMessages) };
  });

  route('GET', /^\/api\/miniapp\/([a-z0-9_]+)\/state$/, ({ me, params }) => {
    requireUser(me);
    const bot = db.bots.find(b => b.username === params[0] && b.enabled && !b.deleted);
    if (!bot || !bot.miniapp_enabled) fail(404, 'Мини-апп не найден');
    return { state: db.botStates[bot.id] || {} };
  });

  route('POST', /^\/api\/miniapp\/([a-z0-9_]+)\/data$/, async ({ me, params, body }) => {
    me = requireUser(me);
    const bot = db.bots.find(b => b.username === params[0] && b.enabled && !b.deleted);
    if (!bot || !bot.miniapp_enabled) fail(404, 'Мини-апп не найден');
    // чат с ботом — создадим при первом касании мини-аппа
    const existing = db.chats.find(c => c.type === 'direct' &&
      db.members.some(m => m.chat_id === c.id && m.user_id === me.id) &&
      db.members.some(m => m.chat_id === c.id && m.user_id === bot.user_id));
    let chatId;
    if (existing) {
      chatId = existing.id;
    } else {
      chatId = next('chat');
      db.chats.push({ id: chatId, type: 'direct', name: null, created_by: me.id, created_at: now() });
      db.members.push({ chat_id: chatId, user_id: me.id, last_read_message_id: 0 });
      db.members.push({ chat_id: chatId, user_id: bot.user_id, last_read_message_id: 0 });
      save();
      emit('chat:new', { chat_id: chatId });
      await runBotEventLocal(bot, chatId, me, { kind: 'start' });
    }
    const data = body?.data;
    try {
      await runBotEventLocal(bot, chatId, me, { kind: 'miniapp', data });
    } catch (e) {
      console.error('BLOOP local, ошибка бота:', e);
    }
    return { ok: true, state: db.botStates[bot.id] || {} };
  });

  // страница мини-аппа для blob-просмотрщика локального режима
  route('GET', /^\/api\/miniapp\/([a-z0-9_]+)\/html$/, ({ me, params }) => {
    requireUser(me);
    const bot = db.bots.find(b => b.username === params[0] && b.enabled && !b.deleted);
    if (!bot || !bot.miniapp_enabled || !(bot.miniapp_code || '').trim()) fail(404, 'Мини-апп не найден');
    const code = bot.miniapp_code;
    const hasSdk = code.includes('/miniapp-sdk.js');
    const inject = '<script>window.__BMA_BOOT__=' + JSON.stringify({ username: bot.username }) + ';</script>' +
      (hasSdk ? '' : '\n<script src="/miniapp-sdk.js"></script>');
    const html = code.includes('</body>') ? code.replace('</body>', inject + '\n</body>') : code + inject;
    return { html, username: bot.username, title: bot.miniapp_title || bot.display_name };
  });

  /* ---------- точка входа ---------- */

  async function request(path, { method = 'GET', headers = {}, body } = {}) {
    await idbReady;
    const url = new URL(path, 'http://local');
    const query = Object.fromEntries(url.searchParams.entries());
    let payload = body;
    let file = null;
    if (payload instanceof FormData) {
      file = payload.get('file');
      payload = {};
    } else if (typeof payload === 'string' && payload) {
      try { payload = JSON.parse(payload); } catch { payload = {}; }
    } else if (payload && typeof payload === 'object') {
      // уже объект (например, из api() при body-объекте)
    } else {
      payload = {};
    }
    const me = authUser(headers);
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      try {
        const data = await r.fn({ params: m.slice(1).map(v => (/^\d+$/.test(v) ? Number(v) : v)), query, body: payload, me, file });
        return { status: 200, data: rewrite(data) };
      } catch (err) {
        if (err && err.__status) return { status: err.__status, data: { error: err.message } };
        console.error('BLOOP local:', err);
        return { status: 500, data: { error: 'Ошибка локального сервера' } };
      }
    }
    return { status: 404, data: { error: 'Неизвестный маршрут API' } };
  }

  window.__BLOOP_LOCAL_READY__ = (async () => {
    await idbReady;
    await hydrateMedia();
    save();
    const api = { request, storeFile, LocalSocket };
    window.__BLOOP_LOCAL__ = api;
    return api;
  })();
})();
