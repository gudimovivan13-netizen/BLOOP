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
  createUser, findUserByPhone, savePhoneCode, getPhoneCode, bumpPhoneAttempts, deletePhoneCode,
} from './src/db.js';
import { hashPassword, verifyPassword, signToken, verifyToken, hashPhoneCode, verifyPhoneCode } from './src/auth.js';
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

// ---------- вход по номеру телефона (без внешних SMS API) ----------
// Код генерируется сервером и «доставляется» в лог сервера — внешние
// сервисы не используются. BLOOP_SMS_DEBUG=1 дополнительно возвращает
// код в ответе (только для разработки/тестов).

const CODE_TTL_MS = 5 * 60 * 1000;      // код живёт 5 минут
const CODE_MAX_ATTEMPTS = 5;            // попыток на один код
const phoneLastSend = new Map();        // phone -> ts, антиспам: 1 код в 30 сек

function normalizePhone(raw) {
  const s = String(raw || '').replace(/[\s()\u2013\u2014-]/g, '').trim();
  if (!/^\+?\d{7,15}$/.test(s)) return null;
  const digits = s.replace(/^\+/, '');
  return `+${digits}`;
}

app.post('/api/auth/phone/start', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return fail(res, 400, 'Введите номер в формате +79991234567 (7–15 цифр)');
  const last = phoneLastSend.get(phone) || 0;
  if (Date.now() - last < 30 * 1000) return fail(res, 429, 'Код уже отправлен — подождите 30 секунд');
  phoneLastSend.set(phone, Date.now());
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  savePhoneCode(phone, hashPhoneCode(phone, code), Date.now() + CODE_TTL_MS);
  const smsDebug = process.env.BLOOP_SMS_DEBUG === '1';
  console.log(`📱 SMS (локальная доставка, без внешних API): код для ${phone}: ${code}`);
  res.json({
    ok: true,
    ttl_sec: Math.floor(CODE_TTL_MS / 1000),
    delivery: 'console', // без внешнего SMS-шлюза код виден в логе сервера
    ...(smsDebug ? { debug_code: code } : {}),
  });
});

app.post('/api/auth/phone/verify', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code || '').trim();
  if (!phone) return fail(res, 400, 'Неверный номер телефона');
  const rec = getPhoneCode(phone);
  if (!rec) return fail(res, 400, 'Сначала запросите код');
  if (Date.now() > rec.expires) {
    deletePhoneCode(phone);
    return fail(res, 400, 'Код истёк — запросите новый');
  }
  if (rec.attempts >= CODE_MAX_ATTEMPTS) {
    deletePhoneCode(phone);
    return fail(res, 429, 'Слишком много попыток — запросите новый код');
  }
  if (!code || !verifyPhoneCode(phone, code, rec.code_hash)) {
    bumpPhoneAttempts(phone);
    return fail(res, 401, `Неверный код (осталось ${CODE_MAX_ATTEMPTS - rec.attempts - 1} попыток)`);
  }
  deletePhoneCode(phone);

  let user = findUserByPhone(phone);
  let created = false;
  if (!user) {
    // Новый аккаунт: логин из хвоста номера, имя можно указать в форме.
    let username = `user${phone.replace(/\D/g, '').slice(-9)}`;
    if (getUserWithPassword(username)) username = `${username}${crypto.randomInt(10, 99)}`;
    const displayName = String(req.body?.display_name || '').trim().slice(0, 40) || `Гость ${phone.slice(-4)}`;
    user = createUser({ username, displayName, passwordHash: '', phone });
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
    emitChatNew(chatId, [peer.id]);
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
    emitChatNew(chatId, ids.filter(id => id !== req.user.id));
    return res.json({ chat_id: chatId, existed: false });
  }
  return fail(res, 400, 'Неизвестный тип чата');
});

api.get('/chats/:id/messages', (req, res) => {
  const chatId = Number(req.params.id);
  if (!isMember(chatId, req.user.id)) return fail(res, 403, 'Нет доступа к чату');
  const before = Math.max(0, Number(req.query.before) || 0);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  res.json({ messages: listMessages(chatId, { before, limit }) });
});

api.post('/chats/:id/messages', (req, res) => {
  const chatId = Number(req.params.id);
  if (!isMember(chatId, req.user.id)) return fail(res, 403, 'Нет доступа к чату');
  const { text, image, voice } = req.body || {};
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
  const message = insertMessage(chatId, req.user.id, body, imagePath, mediaKind);
  io.to(`chat:${chatId}`).emit('message', message);
  res.json({ message });
});

api.post('/chats/:id/read', (req, res) => {
  const chatId = Number(req.params.id);
  if (!isMember(chatId, req.user.id)) return fail(res, 403, 'Нет доступа к чату');
  markRead(chatId, req.user.id, Number(req.body?.message_id) || 0);
  res.json({ ok: true });
});

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
  const { type, text, media, duration } = req.body || {};
  if (!['post', 'clip', 'video'].includes(type)) return fail(res, 400, 'Неизвестный тип публикации');
  const body = String(text || '').trim().slice(0, 4000);
  let mediaOk = null;
  if (media != null) {
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
  }
  if (!body && !mediaOk) return fail(res, 400, 'Пустая публикация');
  const dur = Number(duration);
  const id = createPost({
    authorId: req.user.id,
    type,
    text: body,
    media: mediaOk,
    duration: Number.isFinite(dur) && dur > 0 && dur < 36000 ? dur : null,
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
  const r = toggleLike(id, req.user.id);
  io.emit('post:stats', { post_id: id, likes: r.likes });
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

// ---------- нейропомощник «Floop» ----------

const AI_SYSTEM_PROMPT = [
  'Ты Floop — дружелюбный и умный встроенный помощник соцсети BLOOP.',
  'В BLOOP есть лента постов, клипы (можно снимать прямо в приложении), раздел видео, профили, чаты с голосовыми сообщениями и Вирусометр.',
  'Отвечай на русском языке, кратко (1–6 предложений), живо и по делу.',
  'Помогай придумывать идеи постов, подписи к фото и клипам, хэштеги, отвечай на общие вопросы.',
  'Используй эмодзи умеренно. Не выдумывай функции BLOOP, которых нет.',
].join(' ');

let _zai = null;
async function getZai() {
  if (_zai) return _zai;
  const mod = await import('z-ai-web-dev-sdk'); // SDK опционален: без него работает fallback
  _zai = await mod.default.create();
  return _zai;
}

function assistantFallback(question) {
  const q = String(question || '').toLowerCase();
  if (/привет|здравств|хай|hello/.test(q)) {
    return 'Привет! 👋 Я Floop — помощник BLOOP. Могу придумать идею поста, подпись к клипу, подобрать хэштеги или просто поболтать. Спрашивай!';
  }
  if (/что (ты )?умеешь|помощь|help|умеешь/.test(q)) {
    return 'Я умею: придумывать идеи постов и подписи к фото 📝, подбирать хэштеги, оценивать пост через Вирусометр и подсказывать идеи для клипов. Просто напиши вопрос!';
  }
  if (/пост|идея|подпись|хэштег|хештег|клип/.test(q)) {
    const ideas = [
      'Идея поста: расскажи, что тебя сегодня удивило, и задай вопрос читателям — так больше комментариев 😉 #bloop #интересное',
      'Подпись к клипу: «Поймал момент» — коротко и цепляюще. Или: «Когда день удался 🔥».',
      'Хэштеги для ленты: #bloop #интересное #клипы #мысли — не больше 5 на пост.',
    ];
    return ideas[Math.floor(Math.random() * ideas.length)];
  }
  if (/голосов|микрофон|запис/.test(q)) {
    return 'Голосовые записываются прямо в чате: нажми 🎤 у поля ввода, говори, потом ⏹ для отправки. Длительность и волну увидят все участники чата!';
  }
  return 'Сейчас нейросеть недоступна в этом окружении, но я всё равно здесь 🙂 Попробуй спросить про идеи постов, подписи или хэштеги — с этим я справлюсь и без сети.';
}

api.post('/assistant', async (req, res) => {
  const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (incoming.length === 0) return fail(res, 400, 'Нет сообщений');
  const history = incoming.slice(-20).map(m => ({
    role: m?.role === 'assistant' ? 'assistant' : 'user',
    content: String(m?.content || '').slice(0, 2000),
  })).filter(m => m.content);
  if (history.length === 0) return fail(res, 400, 'Нет сообщений');
  const lastUser = [...history].reverse().find(m => m.role === 'user');
  try {
    const zai = await getZai();
    const completion = await zai.chat.completions.create({
      messages: [{ role: 'assistant', content: AI_SYSTEM_PROMPT }, ...history],
      thinking: { type: 'disabled' },
    });
    const reply = String(completion.choices[0]?.message?.content || '').trim();
    if (!reply) throw new Error('пустой ответ модели');
    res.json({ reply, source: 'ai' });
  } catch (err) {
    console.error('assistant fallback:', err.message);
    res.json({ reply: assistantFallback(lastUser?.content), source: 'fallback' });
  }
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
