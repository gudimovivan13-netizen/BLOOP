// BLOOP — сервер мессенджера: Express (REST API + статика) + Socket.IO
// (realtime: сообщения, присутствие, индикатор набора текста).
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  db, getUserById, getUserWithPassword, listUsers,
  createChat, findDirectChat, isMember, chatMemberIds,
  insertMessage, listMessages, listChatsForUser, markRead,
  createPost, getPost, listFeed, listUserPosts, deletePost,
  toggleLike, incViews, addComment, listComments, updateProfile, setAvatar,
  listFeedByTag, searchPosts, listTrends, getUserStats,
  addNotification, listNotifications, unreadNotificationsCount, markNotificationsRead,
  extractTags, setPostTags,
  createUser, findUserByEmail, saveEmailCode, getEmailCode, bumpEmailAttempts, deleteEmailCode,
  reactPost, POST_EMOJIS, votePoll, reactMessage,
  createStory, listStories, getStory, deleteStory, viewStory, getUserBadges,
  createBot, getBotById, getBotByUserId, getBotByToken, getBotByUsername,
  listBotsByOwner, listPublicBots, botUsernameTaken, updateBot, deleteBot,
  bumpBotMsgs, getBotState, setBotState, publicBot,
} from './src/db.js';
import {
  runBotEvent, pushBotUpdate, waitUpdates, clearUpdates,
  newBotToken, normalizeKeyboard, BOT_TEMPLATES, MINIAPP_TEMPLATE,
  MAX_CODE_CHARS, MAX_MINIAPP_CHARS, BOT_DOC,
} from './src/bot-engine.js';
import { hashPassword, verifyPassword, signToken, verifyToken, hashEmailCode, verifyEmailCode } from './src/auth.js';
import { deliverEmailCode } from './src/email.js';
import { createBloopAI } from './src/ai/engine.js';
import { createBloopLLM } from './src/ai/llm.js';
import { upload, checkUploadSize, mediaKind, publicUrl, MAX_VIDEO_BYTES } from './src/media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.BLOOP_DATA_DIR || path.join(process.cwd(), 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const PORT = Number(process.env.PORT) || 3000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 МБ после декодирования

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { maxHttpBufferSize: 12 * 1024 * 1024 });

app.use(express.json({ limit: '16mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ---------- вспомогательное ----------

function fail(res, code, message) {
  return res.status(code).json({ error: message });
}

function publicUser(u) {
  return u ? {
    id: u.id, username: u.username, display_name: u.display_name,
    avatar: u.avatar ?? null, bio: u.bio ?? '',
    email_verified: !!u.email_verified,
  } : null;
}

// Новичков в чате уведомляем и сразу присоединяем их сокеты к комнате,
// чтобы realtime работал без переподключения.
function emitChatNew(chatId, memberIds) {
  for (const uid of memberIds) {
    io.in(`user:${uid}`).socketsJoin(`chat:${chatId}`);
    io.to(`user:${uid}`).emit('chat:new', { chat_id: chatId });
  }
}

// Сохранение dataURL-картинки, пришедшей в сообщении.
const ALLOWED_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
function saveImage(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('Изображение передано некорректно');
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('Поддерживаются только PNG, JPEG, GIF и WebP');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0) throw new Error('Пустое изображение');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Изображение больше 8 МБ');
  const name = `${crypto.randomBytes(8).toString('hex')}.${ALLOWED_MIME[match[1]]}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, name), bytes);
  return `/uploads/${name}`;
}

// Сохранение голосового сообщения (dataURL audio), лимит 10 МБ ≈ 5 минут.
const ALLOWED_AUDIO = { 'audio/webm': 'weba', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };
function saveVoice(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('Голосовое передано некорректно');
  const match = /^data:(audio\/(?:webm|mp4|ogg|mpeg|wav));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('Поддерживаются аудио WebM/MP4/OGG/MP3/WAV');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0) throw new Error('Пустая аудиозапись');
  if (bytes.length > 10 * 1024 * 1024) throw new Error('Голосовое больше 10 МБ');
  const name = `${crypto.randomBytes(8).toString('hex')}.${ALLOWED_AUDIO[match[1]]}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, name), bytes);
  return `/uploads/${name}`;
}

// ---------- авторизация REST ----------

function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const userId = verifyToken(token);
  if (!userId) return fail(res, 401, 'Требуется авторизация');
  req.user = getUserById(userId);
  if (!req.user) return fail(res, 401, 'Пользователь не найден');
  next();
}

// ---------- маршруты API ----------

// Регистрация и вход — без авторизации (поэтому до api.use(authMiddleware)).
app.post('/api/register', (req, res) => {
  const { username, display_name, password } = req.body || {};
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(String(username || ''))) {
    return fail(res, 400, 'Логин: 3–20 символов, латиница, цифры и _');
  }
  if (String(password || '').length < 6) {
    return fail(res, 400, 'Пароль должен быть не короче 6 символов');
  }
  const displayName = String(display_name || username).trim().slice(0, 40) || username;
  if (getUserWithPassword(String(username))) {
    return fail(res, 409, 'Этот логин уже занят');
  }
  const user = createUser({
    username: String(username),
    displayName,
    passwordHash: hashPassword(String(password)),
  });
  res.json({ token: signToken(user.id), user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = getUserWithPassword(String(username || ''));
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    return fail(res, 401, 'Неверный логин или пароль');
  }
  res.json({ token: signToken(user.id), user: publicUser(user) });
});

// ---------- вход по электронной почте (код подтверждения) ----------
// Код генерируется сервером и доставляется письмом через SMTP
// (src/email.js, nodemailer). Без SMTP-конфига код печатается в лог.
// BLOOP_EMAIL_DEBUG=1 дополнительно возвращает код в ответе (для тестов).

const CODE_TTL_MS = 5 * 60 * 1000;      // код живёт 5 минут
const CODE_MAX_ATTEMPTS = 5;            // попыток на один код
const emailLastSend = new Map();        // email -> ts, антиспам: 1 код в 30 сек

function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email)) return null;
  return email;
}

app.post('/api/auth/email/start', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) return fail(res, 400, 'Введите корректный адрес почты');
  const last = emailLastSend.get(email) || 0;
  if (Date.now() - last < 30 * 1000) return fail(res, 429, 'Код уже отправлен — подождите 30 секунд');
  emailLastSend.set(email, Date.now());
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  saveEmailCode(email, hashEmailCode(email, code), Date.now() + CODE_TTL_MS);
  const { channel } = await deliverEmailCode(email, code);
  const debug = process.env.BLOOP_EMAIL_DEBUG === '1';
  res.json({
    ok: true,
    ttl_sec: Math.floor(CODE_TTL_MS / 1000),
    delivery: channel, // 'smtp' — письмо реально ушло, 'console' — в логе сервера
    ...(debug ? { debug_code: code } : {}),
  });
});

app.post('/api/auth/email/verify', (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code = String(req.body?.code || '').trim();
  if (!email) return fail(res, 400, 'Некорректный адрес почты');
  const rec = getEmailCode(email);
  if (!rec) return fail(res, 400, 'Сначала запросите код');
  if (Date.now() > rec.expires) {
    deleteEmailCode(email);
    return fail(res, 400, 'Код истёк — запросите новый');
  }
  if (rec.attempts >= CODE_MAX_ATTEMPTS) {
    deleteEmailCode(email);
    return fail(res, 429, 'Слишком много попыток — запросите новый код');
  }
  if (!code || !verifyEmailCode(email, code, rec.code_hash)) {
    bumpEmailAttempts(email);
    return fail(res, 401, `Неверный код (осталось ${CODE_MAX_ATTEMPTS - rec.attempts - 1} попыток)`);
  }
  deleteEmailCode(email);

  let user = findUserByEmail(email);
  let created = false;
  if (!user) {
    // Новый аккаунт: логин из имени почты, почта сразу подтверждена.
    let username = String(email.split('@')[0]).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 17);
    if (username.length < 3) username = `user${crypto.randomInt(10000, 99999)}`;
    if (getUserWithPassword(username)) username = `${username.slice(0, 18)}${crypto.randomInt(10, 99)}`;
    const displayName = String(req.body?.display_name || '').trim().slice(0, 40) || `Гость ${crypto.randomInt(100, 999)}`;
    user = createUser({ username, displayName, passwordHash: '', email });
    created = true;
  }
  res.json({ token: signToken(user.id), user: publicUser(user), created });
});

const api = express.Router();
api.use(authMiddleware);

api.get('/me', (req, res) => res.json({ user: publicUser(req.user) }));

api.get('/users', (req, res) => {
  const onlineIds = new Set(presence.keys());
  res.json({ users: listUsers().map(u => ({ ...u, online: onlineIds.has(u.id) })) });
});

api.get('/chats', (req, res) => res.json({ chats: listChatsForUser(req.user.id) }));

api.post('/chats', async (req, res) => {
  const { type, user_id, name, member_ids } = req.body || {};
  if (type === 'direct') {
    const peer = getUserById(Number(user_id));
    if (!peer) return fail(res, 404, 'Пользователь не найден');
    if (peer.id === req.user.id) return fail(res, 400, 'Нельзя открыть чат с самим собой');
    const existing = findDirectChat(req.user.id, peer.id);
    if (existing) return res.json({ chat_id: existing.id, existed: true });
    const chatId = createChat({
      type: 'direct', createdBy: req.user.id,
      memberIds: [req.user.id, peer.id],
    });
    emitChatNew(chatId, [req.user.id, peer.id]); // создатель тоже — иначе его сокет не в комнате
    // первый заход в чат с ботом — событие start (как /start в Telegram)
    const startBot = peer.is_bot ? getBotByUserId(peer.id) : null;
    if (startBot) await runBotAwaited(startBot, chatId, req.user, { kind: 'start' }); // приветствие в базе до ответа
    return res.json({ chat_id: chatId, existed: false });
  }
  if (type === 'group') {
    const title = String(name || '').trim();
    if (!title || title.length > 60) return fail(res, 400, 'Название группы: 1–60 символов');
    const ids = [...new Set([...(member_ids || []).map(Number), req.user.id])];
    for (const id of ids) {
      if (!getUserById(id)) return fail(res, 404, `Пользователь ${id} не найден`);
    }
    const chatId = createChat({ type: 'group', name: title, createdBy: req.user.id, memberIds: ids });
    emitChatNew(chatId, ids); // включая создателя — его сокет должен слушать комнату
    return res.json({ chat_id: chatId, existed: false });
  }
  return fail(res, 400, 'Неизвестный тип чата');
});

api.get('/chats/:id/messages', (req, res) => {
  const chatId = Number(req.params.id);
  if (!isMember(chatId, req.user.id)) return fail(res, 403, 'Нет доступа к чату');
  const before = Math.max(0, Number(req.query.before) || 0);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  res.json({ messages: listMessages(chatId, { before, limit, viewerId: req.user.id }) });
});

api.post('/chats/:id/messages', async (req, res) => {
  const chatId = Number(req.params.id);
  if (!isMember(chatId, req.user.id)) return fail(res, 403, 'Нет доступа к чату');
  const { text, image, voice, reply_to } = req.body || {};
  let imagePath = null;
  let mediaKind = 'image';
  try {
    if (image) imagePath = saveImage(image);
    if (voice) {
      if (imagePath) return fail(res, 400, 'Нельзя отправить картинку и голосовое одновременно');
      imagePath = saveVoice(voice);
      mediaKind = 'voice';
    }
  } catch (e) {
    return fail(res, 400, e.message);
  }
  const body = String(text || '').trim().slice(0, 4000);
  if (!body && !imagePath) return fail(res, 400, 'Пустое сообщение');
  // Ответ на сообщение: проверяем, что оно из этого же чата
  let replyTo = Number(reply_to) || null;
  if (replyTo) {
    const orig = db.prepare('SELECT id FROM messages WHERE id = ? AND chat_id = ?').get(replyTo, chatId);
    if (!orig) replyTo = null;
  }
  const message = insertMessage(chatId, req.user.id, body, imagePath, mediaKind, replyTo);
  io.to(`chat:${chatId}`).emit('message', message);
  // если это чат с ботом — передаём сообщение движку и в очередь обновлений
  const msgBot = chatBot(chatId);
  let botMessages = [];
  if (msgBot) {
    pushBotUpdate(msgBot.id, {
      type: 'message', chat_id: chatId, text: body, message_id: message.id,
      from: { id: req.user.id, name: req.user.display_name, username: req.user.username },
    });
    botMessages = await runBotAwaited(msgBot, chatId, req.user, { kind: 'message', text: body, message_id: message.id });
  }
  res.json({ message, bot_messages: botMessages });
});

// Эмодзи-реакция на сообщении чата
api.post('/chats/:id/messages/:mid/react', (req, res) => {
  const chatId = Number(req.params.id);
  if (!isMember(chatId, req.user.id)) return fail(res, 403, 'Нет доступа к чату');
  const mid = Number(req.params.mid);
  const msg = db.prepare('SELECT id FROM messages WHERE id = ? AND chat_id = ?').get(mid, chatId);
  if (!msg) return fail(res, 404, 'Сообщение не найдено');
  const emoji = String(req.body?.emoji || '');
  if (!['❤️', '🔥', '😂', '😮', '😢', '👍'].includes(emoji)) return fail(res, 400, 'Неизвестная реакция');
  const out = reactMessage(mid, req.user.id, emoji);
  io.to(`chat:${chatId}`).emit('message:react', { chat_id: chatId, message_id: mid, ...out });
  res.json(out);
});

api.post('/chats/:id/read', (req, res) => {
  const chatId = Number(req.params.id);
  if (!isMember(chatId, req.user.id)) return fail(res, 403, 'Нет доступа к чату');
  markRead(chatId, req.user.id, Number(req.body?.message_id) || 0);
  res.json({ ok: true });
});

const botapi = express.Router();
botapi.use((req, res, next) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const bot = token ? getBotByToken(token) : null;
  if (!bot) return fail(res, 401, 'Неверный токен бота');
  req.bot = bot;
  next();
});

app.use('/api/botapi', botapi); // свой токен-доступ, до общего 404
app.use('/api', api);
app.use('/api', (req, res) => fail(res, 404, 'Неизвестный маршрут API'));

// ---------- соцсеть: загрузка медиа ----------

api.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return fail(res, 400, 'Файл не передан');
  if (!checkUploadSize(req.file)) {
    fs.unlinkSync(req.file.path);
    return fail(res, 413, 'Файл слишком большой (видео до 300 МБ, изображения до 10 МБ)');
  }
  res.json({
    url: publicUrl(req.file.filename),
    kind: mediaKind(req.file.mimetype),
    mime: req.file.mimetype,
    size: req.file.size,
    name: req.file.originalname,
  });
});

// ---------- соцсеть: посты, лента, клипы, видео ----------

const MEDIA_RE = /^\/uploads\/[a-f0-9]+\.(png|jpg|gif|webp|mp4|webm|mov)$/;
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov']);
const IMAGE_EXT = new Set(['png', 'jpg', 'gif', 'webp']);

api.post('/posts', (req, res) => {
  const { type, text, media, duration, poll } = req.body || {};
  if (!['post', 'clip', 'video'].includes(type)) return fail(res, 400, 'Неизвестный тип публикации');
  const body = String(text || '').trim().slice(0, 4000);
  // Опрос: 2–4 непустых варианта, без медиа
  let pollOptions = null;
  if (poll !== undefined && poll !== null) {
    if (!Array.isArray(poll) || poll.length < 2 || poll.length > 4) {
      return fail(res, 400, 'Опрос: от 2 до 4 вариантов');
    }
    const opts = poll.map(o => String(o || '').trim().slice(0, 60)).filter(Boolean);
    if (opts.length !== poll.length) return fail(res, 400, 'Варианты опроса не могут быть пустыми');
    pollOptions = opts;
  }
  let mediaOk = null;
  if (media != null) {
    if (pollOptions) return fail(res, 400, 'В опросе не может быть медиафайла');
    const match = MEDIA_RE.exec(String(media));
    if (!match) return fail(res, 400, 'Некорректная ссылка на медиафайл');
    const isVideo = VIDEO_EXT.has(match[1]);
    if (type === 'post' && isVideo) return fail(res, 400, 'В посте допустимо только изображение');
    if ((type === 'clip' || type === 'video') && !isVideo) {
      return fail(res, 400, 'Клипы и видео — только видеофайлы (MP4, WebM, MOV)');
    }
    mediaOk = String(media);
  }
  if (type === 'clip' || type === 'video') {
    if (!mediaOk) return fail(res, 400, 'Для клипа/видео нужно приложить видеофайл');
    if (pollOptions) return fail(res, 400, 'Опрос возможен только в обычном посте');
  }
  if (!body && !mediaOk && !pollOptions) return fail(res, 400, 'Пустая публикация');
  const dur = Number(duration);
  const id = createPost({
    authorId: req.user.id,
    type,
    text: body,
    media: mediaOk,
    duration: Number.isFinite(dur) && dur > 0 && dur < 36000 ? dur : null,
    pollOptions,
  });
  setPostTags(id, extractTags(body));
  const post = getPost(id, req.user.id);
  io.emit('post:new', { post }); // клиент дедуплицирует по id: свой пост уже в ленте
  res.json({ post });
});

api.get('/feed', (req, res) => {
  const type = ['post', 'clip', 'video'].includes(req.query.type) ? req.query.type : null;
  const tag = String(req.query.tag || '').trim().toLowerCase().slice(0, 30);
  const opts = {
    before: Math.max(0, Number(req.query.before) || 0),
    limit: Math.min(50, Math.max(1, Number(req.query.limit) || 20)),
  };
  const posts = tag ? listFeedByTag(req.user.id, tag, opts) : listFeed(req.user.id, { type, ...opts });
  res.json({ posts });
});

api.get('/posts/:id', (req, res) => {
  const post = getPost(Number(req.params.id), req.user.id);
  if (!post) return fail(res, 404, 'Публикация не найдена');
  res.json({ post });
});

api.delete('/posts/:id', (req, res) => {
  const ok = deletePost(Number(req.params.id), req.user.id);
  if (!ok) return fail(res, 403, 'Можно удалять только свои публикации');
  res.json({ ok: true });
});

api.post('/posts/:id/like', (req, res) => {
  const id = Number(req.params.id);
  const post = getPost(id, req.user.id);
  if (!post) return fail(res, 404, 'Публикация не найдена');
  const r = toggleLike(id, req.user.id); // теперь это реакция ❤️
  const after = getPost(id, req.user.id);
  io.emit('post:stats', { post_id: id, likes: r.likes, liked_by_me: r.liked, reactions: after.reactions });
  if (r.liked && post.author.id !== req.user.id) {
    const n = addNotification({ userId: post.author.id, actorId: req.user.id, type: 'like', postId: id });
    if (n) {
      io.to(`user:${post.author.id}`).emit('notification', {
        notification: n,
        unread: unreadNotificationsCount(post.author.id),
      });
    }
  }
  res.json(r);
});

// Эмодзи-реакция на посте (❤️🔥😂😮😢👍🤯💚)
api.post('/posts/:id/react', (req, res) => {
  const id = Number(req.params.id);
  const post = getPost(id, req.user.id);
  if (!post) return fail(res, 404, 'Публикация не найдена');
  const emoji = String(req.body?.emoji || '');
  if (!POST_EMOJIS.includes(emoji)) return fail(res, 400, 'Неизвестная реакция');
  const r = reactPost(id, req.user.id, emoji);
  io.emit('post:stats', { post_id: id, likes: r.likes, liked_by_me: r.liked, reactions: r.reactions });
  if (r.liked && emoji === '❤️' && post.author.id !== req.user.id) {
    const n = addNotification({ userId: post.author.id, actorId: req.user.id, type: 'like', postId: id });
    if (n) {
      io.to(`user:${post.author.id}`).emit('notification', {
        notification: n,
        unread: unreadNotificationsCount(post.author.id),
      });
    }
  }
  res.json(r);
});

// Голосование в опросе поста
api.post('/posts/:id/poll', (req, res) => {
  const id = Number(req.params.id);
  try {
    const poll = votePoll(id, req.user.id, req.body?.option_idx);
    io.emit('post:poll', { post_id: id, poll });
    res.json({ poll });
  } catch (e) {
    fail(res, 400, e.message);
  }
});

// ---------- истории «Мгновения» (живут 24 часа) ----------

api.post('/stories', (req, res) => {
  const kind = req.body?.kind === 'image' ? 'image' : 'text';
  let media = null;
  try {
    if (kind === 'image') media = saveImage(req.body?.image); // dataURL ≤ 8 МБ
  } catch (e) {
    return fail(res, 400, e.message);
  }
  const text = String(req.body?.text || '').trim().slice(0, 500);
  if (kind === 'image' && !media) return fail(res, 400, 'Приложите фото или используйте текстовое мгновение');
  if (kind === 'text' && !text) return fail(res, 400, 'Текст мгновения пуст');
  if (kind === 'text') media = null;
  const bg = kind === 'text' ? String(req.body?.bg || 'aurora').slice(0, 24) : null;
  const id = createStory({ userId: req.user.id, kind, media, text: text || null, bg });
  io.emit('stories:update'); // подписчики перезагрузят ленту мгновений
  res.json({ ok: true, id });
});

api.get('/stories', (req, res) => {
  res.json({ users: listStories(req.user.id) });
});

api.post('/stories/:id/view', (req, res) => {
  const story = getStory(Number(req.params.id));
  if (!story || story.expires_at <= Date.now()) return fail(res, 404, 'Мгновение не найдено или истекло');
  res.json({ views: viewStory(story.id, req.user.id) });
});

api.delete('/stories/:id', (req, res) => {
  const ok = deleteStory(Number(req.params.id), req.user.id);
  if (!ok) return fail(res, 403, 'Можно удалять только свои мгновения');
  io.emit('stories:update');
  res.json({ ok: true });
});

// ---------- бейджи-достижения ----------

api.get('/users/:id/badges', (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return fail(res, 404, 'Пользователь не найден');
  res.json({ badges: getUserBadges(user.id) });
});

api.post('/posts/:id/view', (req, res) => {
  res.json({ views: incViews(Number(req.params.id)) });
});

api.get('/posts/:id/comments', (req, res) => {
  res.json({ comments: listComments(Number(req.params.id)) });
});

api.post('/posts/:id/comments', (req, res) => {
  const id = Number(req.params.id);
  const post = getPost(id, req.user.id);
  if (!post) return fail(res, 404, 'Публикация не найдена');
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!text) return fail(res, 400, 'Пустой комментарий');
  const comment = addComment(id, req.user.id, text);
  io.emit('comment:new', { post_id: id, comment });
  const commentsCount = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE post_id = ?').get(id).n;
  io.emit('post:stats', { post_id: id, comments_count: commentsCount });
  if (post.author.id !== req.user.id) {
    const n = addNotification({ userId: post.author.id, actorId: req.user.id, type: 'comment', postId: id });
    if (n) {
      io.to(`user:${post.author.id}`).emit('notification', {
        notification: n,
        unread: unreadNotificationsCount(post.author.id),
      });
    }
  }
  res.json({ comment });
});

// ---------- соцсеть: уведомления, поиск, тренды ----------

api.get('/notifications', (req, res) => {
  res.json({
    notifications: listNotifications(req.user.id),
    unread: unreadNotificationsCount(req.user.id),
  });
});

api.post('/notifications/read', (req, res) => {
  markNotificationsRead(req.user.id, Array.isArray(req.body?.ids) ? req.body.ids : null);
  res.json({ unread: unreadNotificationsCount(req.user.id) });
});

api.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (!q) return res.json({ posts: [] });
  res.json({ posts: searchPosts(req.user.id, q, { limit: 30 }) });
});

api.get('/trends', (req, res) => {
  res.json({ trends: listTrends({ days: 7, limit: 8 }) });
});

// ---------- соцсеть: профили ----------

api.get('/users/:id', (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return fail(res, 404, 'Пользователь не найден');
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM posts WHERE author_id = ?) AS posts,
      (SELECT COUNT(*) FROM posts WHERE author_id = ? AND type = 'clip') AS clips,
      (SELECT COUNT(*) FROM posts WHERE author_id = ? AND type = 'video') AS videos
  `).get(user.id, user.id, user.id);
  res.json({ user: publicUser(user), counts, stats: getUserStats(user.id) });
});

api.get('/users/:id/posts', (req, res) => {
  const type = ['post', 'clip', 'video'].includes(req.query.type) ? req.query.type : null;
  res.json({
    posts: listUserPosts(Number(req.params.id), req.user.id, {
      type,
      before: Math.max(0, Number(req.query.before) || 0),
      limit: Math.min(50, Math.max(1, Number(req.query.limit) || 20)),
    }),
  });
});

api.patch('/me', (req, res) => {
  const displayName = String(req.body?.display_name || '').trim().slice(0, 40);
  const bio = String(req.body?.bio ?? '').trim().slice(0, 300);
  const user = updateProfile(req.user.id, {
    displayName: displayName || null,
    bio: req.body?.bio === undefined ? null : bio,
  });
  res.json({ user: publicUser(user) });
});

api.post('/me/avatar', upload.single('file'), (req, res) => {
  if (!req.file) return fail(res, 400, 'Файл не передан');
  if (mediaKind(req.file.mimetype) !== 'image' || !checkUploadSize(req.file)) {
    fs.unlinkSync(req.file.path);
    return fail(res, 400, 'Нужна картинка до 10 МБ');
  }
  const user = setAvatar(req.user.id, publicUrl(req.file.filename));
  res.json({ user: publicUser(user) });
});

// ---------- BLOOP AI — встроенная нейросеть, полностью локальная ----------
// Классификатор намерений (MLP) обучается при старте за ~0.3 с и живёт
// в памяти процесса; генераторы используют данные самой соцсети
// (посты, теги, тренды). Никаких внешних API — ни один байт не уходит наружу.

const bloopAI = createBloopAI();

// Слой знаний (статьи ~100 наук, книги, код): индекс подключается к движку
// при старте, если public/vendor/bloop-knowledge.json на месте.
(function attachKnowledgeIndex() {
  const candidates = [
    path.join(__dirname, 'public', 'vendor', 'bloop-knowledge.json'),
    path.join(__dirname, '..', 'public', 'vendor', 'bloop-knowledge.json'),
    path.join(__dirname, '..', '..', 'public', 'vendor', 'bloop-knowledge.json'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const n = bloopAI.attachKnowledge(JSON.parse(fs.readFileSync(file, 'utf8')));
      console.log(`BLOOP AI: индекс знаний подключён (${n} фрагментов)`);
      break;
    } catch { /* работаем без знаний */ }
  }
})();

// Языковая модель (GPT, ~1 млн параметров): веса читаются из public/vendor
// один раз при первом запросе. Если файла нет (например, лёгкая сборка) —
// работаем на классификаторе намерений.
let _llm = null;
let _llmTried = false;
function getBloopLLM() {
  if (_llmTried) return _llm;
  _llmTried = true;
  // пути: корень репо (server.js), копия ресурсов exe (server-bundle рядом с public)
  const candidates = [
    path.join(__dirname, 'public', 'vendor', 'bloop-llm.json'),
    path.join(__dirname, '..', 'public', 'vendor', 'bloop-llm.json'),
    path.join(__dirname, '..', '..', 'public', 'vendor', 'bloop-llm.json'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      _llm = createBloopLLM(JSON.parse(fs.readFileSync(file, 'utf8')));
      console.log('BLOOP AI: языковая модель загружена (' + path.basename(path.dirname(path.dirname(file))) + ')');
      break;
    } catch (err) {
      _llm = null;
    }
  }
  if (!_llm) console.log('BLOOP AI: веса LLM не найдены, только классификатор');
  return _llm;
}

function aiContext(userId) {
  try {
    const posts = listUserPosts(userId, userId, { limit: 40 });
    const texts = posts.map((p) => String(p.text || '')).filter((t) => t.trim().length > 12);
    const tagCount = {};
    for (const p of posts) {
      for (const t of extractTags(String(p.text || ''))) tagCount[t] = (tagCount[t] || 0) + 1;
    }
    const tags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
    const trends = listTrends({ limit: 6 }).map((t) => t.tag);
    const me = getUserById(userId);
    return { name: me?.display_name || '', tags, trends, texts };
  } catch {
    return {};
  }
}

api.post('/assistant', (req, res) => {
  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (incoming.length === 0) return fail(res, 400, 'Нет сообщений');
  const history = incoming.slice(-20).map(m => ({
    role: m?.role === 'assistant' ? 'assistant' : 'user',
    content: String(m?.content || '').slice(0, 2000),
  })).filter(m => m.content);
  if (history.length === 0) return fail(res, 400, 'Нет сообщений');
  const lastUser = [...history].reverse().find(m => m.role === 'user');
  // 1) языковая модель (настоящий трансформер) — если веса на месте;
  const llm = getBloopLLM();
  if (llm) {
    const reply = llm.chat(lastUser?.content || '', history.slice(-6));
    if (reply) {
      return res.json({ reply, source: 'ai-neural', intent: 'llm', model: 'bloop-gpt-1' });
    }
  }
  // 2) классификатор намерений + генераторы — запасной путь
  const { reply, intent, confidence } = bloopAI.answer(lastUser?.content || '', aiContext(req.user.id));
  res.json({ reply, source: 'ai', intent, confidence: Math.round(confidence * 100) / 100 });
});


/* =====================================================================
   Боты и мини-аппы (v6): платформа вроде Telegram Bot API, но целиком
   своя. Бот — пользователь is_bot=1 с кодом, исполняемым в песочнице.
   ===================================================================== */

function chatBot(chatId) {
  return db.prepare(`
    SELECT b.* FROM bots b
    JOIN chat_members cm ON cm.chat_id = ? AND cm.user_id = b.user_id
    WHERE b.deleted = 0
  `).get(chatId) || null;
}

function botTyping(chatId, botUserId, on) {
  io.to(`chat:${chatId}`).emit('typing', { chat_id: chatId, user_id: botUserId, typing: !!on });
}

// то же, но с ожиданием: реплики бота возвращаются в HTTP-ответе
async function runBotAwaited(bot, chatId, user, event) {
  botTyping(chatId, bot.user_id, true);
  try {
    const r = await runBotEvent({ bot, chatId, user, event, emitMessage: (m) => io.to(`chat:${chatId}`).emit('message', m) });
    return r?.replies || [];
  } catch (e) {
    console.error(`бот ${bot.username} упал:`, e);
    return [];
  } finally {
    botTyping(chatId, bot.user_id, false);
  }
}

// исполнение события с индикатором «печатает…» и логированием ошибок
function runBotSafe(bot, chatId, user, event) {
  botTyping(chatId, bot.user_id, true);
  runBotEvent({ bot, chatId, user, event, emitMessage: (m) => io.to(`chat:${chatId}`).emit('message', m) })
    .then((r) => { if (r?.error) console.error(`бот ${bot.username}:`, r.error); })
    .catch((e) => console.error(`бот ${bot.username} упал:`, e))
    .finally(() => botTyping(chatId, bot.user_id, false));
}

const BOT_USERNAME_RE = /^bot_[a-z0-9_]{3,24}$/;


/* ---------- управление своими ботами (BotFather внутри BLOOP) ---------- */

api.get('/bots/mine', (req, res) => {
  res.json({ bots: listBotsByOwner(req.user.id).map(b => publicBot(b, { withToken: true })) });
});

api.post('/bots', (req, res) => {
  let username = String(req.body?.username || '').trim().toLowerCase();
  if (username && !username.startsWith('bot_')) username = 'bot_' + username;
  if (!BOT_USERNAME_RE.test(username)) {
    return fail(res, 400, 'Юзернейм бота: bot_имя, 3–24 символа — латиница, цифры, _');
  }
  if (botUsernameTaken(username)) return fail(res, 409, 'Такой юзернейм уже занят');
  const displayName = String(req.body?.display_name || '').trim().slice(0, 40)
    || username.replace(/^bot_/, 'Бот ');
  const description = String(req.body?.description || '').trim().slice(0, 300);
  // новый бот сразу работает: шаблон «Эхо-бот» предустановлен
  const bot = createBot({
    ownerId: req.user.id,
    username,
    displayName,
    description,
    token: newBotToken(),
    code: BOT_TEMPLATES[0].code,
  });
  res.json({ bot: publicBot(bot, { withToken: true }) });
});

api.put('/bots/:id', (req, res) => {
  const bot = getBotById(Number(req.params.id));
  if (!bot) return fail(res, 404, 'Бот не найден');
  if (bot.owner_id !== req.user.id) return fail(res, 403, 'Это не ваш бот');
  const b = req.body || {};
  const fields = {};
  if (b.display_name !== undefined) {
    fields.display_name = String(b.display_name).trim().slice(0, 40) || bot.display_name;
  }
  if (b.description !== undefined) fields.description = String(b.description).trim().slice(0, 300);
  if (b.code !== undefined) {
    const code = String(b.code);
    if (code.length > MAX_CODE_CHARS) return fail(res, 400, `Код больше ${MAX_CODE_CHARS} символов`);
    fields.code = code;
  }
  if (b.enabled !== undefined) fields.enabled = b.enabled ? 1 : 0;
  if (b.miniapp_enabled !== undefined) fields.miniapp_enabled = b.miniapp_enabled ? 1 : 0;
  if (b.miniapp_title !== undefined) fields.miniapp_title = String(b.miniapp_title).trim().slice(0, 60);
  if (b.miniapp_code !== undefined) {
    const mc = String(b.miniapp_code);
    if (mc.length > MAX_MINIAPP_CHARS) return fail(res, 400, `Код мини-аппа больше ${MAX_MINIAPP_CHARS} символов`);
    fields.miniapp_code = mc;
  }
  const updated = updateBot(bot.id, fields);
  res.json({ bot: publicBot(updated, { withToken: true }) });
});

api.post('/bots/:id/retoken', (req, res) => {
  const bot = getBotById(Number(req.params.id));
  if (!bot) return fail(res, 404, 'Бот не найден');
  if (bot.owner_id !== req.user.id) return fail(res, 403, 'Это не ваш бот');
  const token = newBotToken();
  updateBot(bot.id, { token });
  res.json({ token });
});

api.delete('/bots/:id', (req, res) => {
  const bot = getBotById(Number(req.params.id));
  if (!bot) return fail(res, 404, 'Бот не найден');
  if (bot.owner_id !== req.user.id) return fail(res, 403, 'Это не ваш бот');
  deleteBot(bot.id, req.user.id);
  clearUpdates(bot.id);
  res.json({ ok: true });
});

api.get('/bots/public', (req, res) => {
  res.json({ bots: listPublicBots().map(b => publicBot(b)) });
});

api.get('/bots/doc', (req, res) => {
  res.json({
    doc: BOT_DOC,
    templates: BOT_TEMPLATES.map(t => ({ id: t.id, name: t.name })),
    miniapp_template: MINIAPP_TEMPLATE,
  });
});

/* ---------- колбэк инлайн-клавиатуры ---------- */

api.post('/chats/:id/callback', async (req, res) => {
  const chatId = Number(req.params.id);
  if (!isMember(chatId, req.user.id)) return fail(res, 403, 'Нет доступа к чату');
  const bot = chatBot(chatId);
  if (!bot) return fail(res, 404, 'В этом чате нет бота');
  const data = String(req.body?.data || '').slice(0, 64);
  const messageId = Number(req.body?.message_id) || null;
  pushBotUpdate(bot.id, {
    type: 'callback', chat_id: chatId, data, message_id: messageId,
    from: { id: req.user.id, name: req.user.display_name, username: req.user.username },
  });
  const botMessages = await runBotAwaited(bot, chatId, req.user, { kind: 'callback', data, message_id: messageId });
  res.json({ ok: true, bot_messages: botMessages });
});

/* ---------- события из мини-аппа ---------- */

function openBotChatFor(userId, bot) {
  const existing = findDirectChat(userId, bot.user_id);
  if (existing) return { chatId: existing.id, existed: true };
  const chatId = createChat({ type: 'direct', createdBy: userId, memberIds: [userId, bot.user_id] });
  emitChatNew(chatId, [userId, bot.user_id]);
  runBotSafe(bot, chatId, getUserById(userId), { kind: 'start' });
  return { chatId, existed: false };
}

api.get('/miniapp/:username/state', (req, res) => {
  const bot = getBotByUsername(req.params.username);
  if (!bot || !bot.enabled || !bot.miniapp_enabled) return fail(res, 404, 'Мини-апп не найден');
  res.json({ state: getBotState(bot.id) });
});

api.post('/miniapp/:username/data', async (req, res) => {
  const bot = getBotByUsername(req.params.username);
  if (!bot || !bot.enabled || !bot.miniapp_enabled) return fail(res, 404, 'Мини-апп не найден');
  const { chatId } = openBotChatFor(req.user.id, bot);
  const data = req.body?.data;
  pushBotUpdate(bot.id, {
    type: 'miniapp', chat_id: chatId, data: data ?? null,
    from: { id: req.user.id, name: req.user.display_name, username: req.user.username },
  });
  // исполнение синхронно ждём: мини-апп хочет свежее состояние в ответе
  const botMessages = await runBotAwaited(bot, chatId, req.user, { kind: 'miniapp', data });
  res.json({ ok: true, state: getBotState(bot.id), bot_messages: botMessages });
});

/* ---------- Bot HTTP API: доступ по токену бота (getUpdates long polling) ---------- */

botapi.get('/getMe', (req, res) => {
  res.json({ bot: publicBot(req.bot) });
});

botapi.post('/sendMessage', (req, res) => {
  const chatId = Number(req.body?.chat_id);
  const text = String(req.body?.text || '').trim().slice(0, 4000);
  if (!chatId) return fail(res, 400, 'Нужен chat_id');
  if (!text) return fail(res, 400, 'Пустой текст');
  const ok = db.prepare(`
    SELECT 1 FROM chats c JOIN chat_members m ON m.chat_id = c.id
    WHERE c.id = ? AND c.type = 'direct' AND m.user_id = ?
  `).get(chatId, req.bot.user_id);
  if (!ok) return fail(res, 403, 'Бот не участник этого чата');
  let kb = null;
  if (req.body?.keyboard) {
    try { kb = normalizeKeyboard(req.body.keyboard); } catch { kb = null; }
  }
  const message = insertMessage(chatId, req.bot.user_id, text, null, 'image', null, kb);
  bumpBotMsgs(req.bot.id);
  io.to(`chat:${chatId}`).emit('message', message);
  res.json({ message });
});

botapi.get('/getUpdates', async (req, res) => {
  const timeout = Math.max(0, Math.min(Number(req.query.timeout) || 0, 30000));
  const updates = await waitUpdates(req.bot.id, timeout);
  res.json({ updates });
});

/* ---------- раздача мини-аппов ---------- */

app.get('/miniapp/:username', (req, res) => {
  const bot = getBotByUsername(req.params.username);
  if (!bot || !bot.enabled || !bot.miniapp_enabled || !(bot.miniapp_code || '').trim()) {
    return res.status(404).send('<!doctype html><meta charset="utf-8"><p>Мини-апп не найден</p>');
  }
  const code = bot.miniapp_code;
  const hasSdk = code.includes('/miniapp-sdk.js');
  const inject = `<script>window.__BMA_BOOT__=${JSON.stringify({ username: bot.username })};</script>` +
    (hasSdk ? '' : '\n<script src="/miniapp-sdk.js"></script>');
  const html = code.includes('</body>') ? code.replace('</body>', inject + '\n</body>') : code + inject;
  res.type('html').send(html);
});

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  if (err.message === 'UNSUPPORTED_TYPE') {
    return fail(res, 400, 'Формат не поддерживается: картинки (PNG, JPEG, GIF, WebP) и видео (MP4, WebM, MOV)');
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return fail(res, 413, `Файл больше лимита (${Math.round(MAX_VIDEO_BYTES / 1048576)} МБ для видео)`);
  }
  fail(res, err.type === 'entity.too.large' ? 413 : 500, 'Ошибка сервера');
});

// ---------- Socket.IO: realtime ----------

const presence = new Map(); // userId -> Set(socketId)

function joinUserRooms(socket) {
  const ids = db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(socket.userId);
  for (const row of ids) socket.join(`chat:${row.chat_id}`);
  socket.join(`user:${socket.userId}`);
}

io.use((socket, next) => {
  const userId = verifyToken(socket.handshake.auth?.token);
  if (!userId || !getUserById(userId)) return next(new Error('unauthorized'));
  socket.userId = userId;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  joinUserRooms(socket);

  if (!presence.has(userId)) presence.set(userId, new Set());
  const sockets = presence.get(userId);
  sockets.add(socket.id);
  if (sockets.size === 1) io.emit('presence', { user_id: userId, online: true });

  socket.emit('presence:list', { online_ids: [...presence.keys()] });

  socket.on('typing', ({ chat_id, typing } = {}) => {
    const chatId = Number(chat_id);
    if (!isMember(chatId, userId)) return;
    socket.to(`chat:${chatId}`).emit('typing', { chat_id: chatId, user_id: userId, typing: !!typing });
  });

  // ---------- Звонки 1-на-1: сигналинг WebRTC ----------
  // Адресат получает событие в своей личной комнате user:<id>.
  socket.on('call:invite', ({ to, call_id, mode } = {}) => {
    const toId = Number(to);
    if (!toId || toId === userId || !getUserById(toId)) return;
    if (!['audio', 'video'].includes(mode)) return;
    io.to(`user:${toId}`).emit('call:incoming', {
      call_id: String(call_id || ''), mode,
      from: publicUser(getUserById(userId)),
    });
  });
  socket.on('call:accept', ({ to, call_id } = {}) => {
    io.to(`user:${Number(to)}`).emit('call:accepted', { call_id: String(call_id || '') });
  });
  socket.on('call:decline', ({ to, call_id, busy } = {}) => {
    io.to(`user:${Number(to)}`).emit('call:declined', { call_id: String(call_id || ''), busy: !!busy });
  });
  socket.on('call:end', ({ to, call_id } = {}) => {
    io.to(`user:${Number(to)}`).emit('call:ended', { call_id: String(call_id || '') });
  });
  socket.on('call:signal', ({ to, call_id, data } = {}) => {
    if (!data || typeof data !== 'object') return;
    io.to(`user:${Number(to)}`).emit('call:signal', { call_id: String(call_id || ''), data });
  });

  socket.on('disconnect', () => {
    sockets.delete(socket.id);
    if (sockets.size === 0) {
      presence.delete(userId);
      io.emit('presence', { user_id: userId, online: false });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`BLOOP запущен: http://localhost:${PORT}`);
});
