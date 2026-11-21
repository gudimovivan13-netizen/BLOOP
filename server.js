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
  db, createUser, getUserById, getUserWithPassword, listUsers,
  createChat, findDirectChat, isMember, chatMemberIds,
  insertMessage, listMessages, listChatsForUser, markRead,
} from './src/db.js';
import { hashPassword, verifyPassword, signToken, verifyToken } from './src/auth.js';

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
  return u ? { id: u.id, username: u.username, display_name: u.display_name } : null;
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
  const { text, image } = req.body || {};
  let imagePath = null;
  try {
    if (image) imagePath = saveImage(image);
  } catch (e) {
    return fail(res, 400, e.message);
  }
  const body = String(text || '').trim().slice(0, 4000);
  if (!body && !imagePath) return fail(res, 400, 'Пустое сообщение');
  const message = insertMessage(chatId, req.user.id, body, imagePath);
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

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
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
