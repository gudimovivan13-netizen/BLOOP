// Слой доступа к данным BLOOP. Использует встроенный в Node.js SQLite
// (node:sqlite), поэтому никаких нативных зависимостей не требуется.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.BLOOP_DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'bloop.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chats (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  name       TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_members (
  chat_id              INTEGER NOT NULL REFERENCES chats(id),
  user_id              INTEGER NOT NULL REFERENCES users(id),
  role                 TEXT NOT NULL DEFAULT 'member',
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL REFERENCES chats(id),
  sender_id  INTEGER NOT NULL REFERENCES users(id),
  text       TEXT NOT NULL DEFAULT '',
  image      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
`);

// Миграции для баз, созданных до появления соцсети (v2) и телефона/голоса (v4).
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
if (!userCols.includes('bio')) db.exec("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''");
if (!userCols.includes('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');

db.exec(`
CREATE TABLE IF NOT EXISTS phone_codes (
  phone     TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires   INTEGER NOT NULL,
  attempts  INTEGER NOT NULL DEFAULT 0
);
`);

const msgCols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
if (!msgCols.includes('media_kind')) db.exec("ALTER TABLE messages ADD COLUMN media_kind TEXT DEFAULT 'image'");

export function createUser({ username, displayName, passwordHash, phone = null }) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, phone) VALUES (?, ?, ?, ?)'
  ).run(username, displayName, passwordHash, phone);
  return getUserById(Number(lastInsertRowid));
}

export function getUserById(id) {
  return db.prepare('SELECT id, username, display_name, avatar, bio, created_at FROM users WHERE id = ?').get(id) || null;
}

export function getUserWithPassword(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

export function findUserByPhone(phone) {
  return db.prepare('SELECT * FROM users WHERE phone = ?').get(phone) || null;
}

export function savePhoneCode(phone, codeHash, expires) {
  db.prepare(`
    INSERT INTO phone_codes (phone, code_hash, expires, attempts) VALUES (?, ?, ?, 0)
    ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires, attempts = 0
  `).run(phone, codeHash, expires);
}

export function getPhoneCode(phone) {
  return db.prepare('SELECT * FROM phone_codes WHERE phone = ?').get(phone) || null;
}

export function bumpPhoneAttempts(phone) {
  db.prepare('UPDATE phone_codes SET attempts = attempts + 1 WHERE phone = ?').run(phone);
}

export function deletePhoneCode(phone) {
  db.prepare('DELETE FROM phone_codes WHERE phone = ?').run(phone);
}

export function listUsers() {
  return db.prepare('SELECT id, username, display_name, avatar FROM users ORDER BY username COLLATE NOCASE').all();
}

export function createChat({ type, name = null, createdBy, memberIds }) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO chats (type, name, created_by) VALUES (?, ?, ?)'
  ).run(type, name, createdBy);
  const chatId = Number(lastInsertRowid);
  const ins = db.prepare(
    "INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'member')"
  );
  for (const uid of memberIds) ins.run(chatId, uid);
  return chatId;
}

export function findDirectChat(userA, userB) {
  return db.prepare(`
    SELECT c.id FROM chats c
    JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
    JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
    WHERE c.type = 'direct'
  `).get(userA, userB) || null;
}

export function isMember(chatId, userId) {
  return !!db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
}

export function chatMemberIds(chatId) {
  return db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId).map(r => r.user_id);
}

export function insertMessage(chatId, senderId, text, image, mediaKind = 'image') {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO messages (chat_id, sender_id, text, image, media_kind) VALUES (?, ?, ?, ?, ?)'
  ).run(chatId, senderId, text, image, mediaKind);
  return getMessageById(Number(lastInsertRowid));
}

const MSG_SELECT = `
  SELECT m.id, m.chat_id, m.sender_id, m.text, m.image, m.media_kind, m.created_at,
         u.username, u.display_name
  FROM messages m JOIN users u ON u.id = m.sender_id`;

export function getMessageById(id) {
  return db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(id) || null;
}

export function listMessages(chatId, { before = 0, limit = 50 } = {}) {
  const rows = db.prepare(`
    ${MSG_SELECT}
    WHERE m.chat_id = ? ${before ? 'AND m.id < ?' : ''}
    ORDER BY m.id DESC LIMIT ?
  `).all(...(before ? [chatId, before, limit] : [chatId, limit]));
  return rows.reverse(); // по возрастанию id — старые сверху
}

export function listChatsForUser(userId) {
  const chats = db.prepare(`
    SELECT c.id, c.type, c.name, c.created_at
    FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
    WHERE cm.user_id = ?
  `).all(userId);

  const lastMsg = db.prepare(`
    SELECT m.id, m.sender_id, m.text, m.image, m.media_kind, m.created_at, u.display_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT 1
  `);
  const lastRead = db.prepare(
    'SELECT last_read_message_id AS lr FROM chat_members WHERE chat_id = ? AND user_id = ?'
  );
  const unread = db.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND id > ? AND sender_id <> ?'
  );
  const peer = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar FROM chat_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.chat_id = ? AND cm.user_id <> ?
  `);
  const memberCount = db.prepare('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?');

  return chats.map(c => {
    const mark = lastMsg.get(c.id);
    const lr = lastRead.get(c.id, userId).lr;
    return {
      id: c.id,
      type: c.type,
      name: c.name,
      peer: c.type === 'direct' ? (peer.get(c.id, userId) || null) : null,
      members_count: memberCount.get(c.id).n,
      last_message: mark || null,
      unread: unread.get(c.id, lr, userId).n,
      updated_at: mark ? mark.created_at : c.created_at,
    };
  }).sort((a, b) => (b.last_message?.id ?? 0) - (a.last_message?.id ?? 0));
}

export function markRead(chatId, userId, messageId) {
  db.prepare(`
    UPDATE chat_members SET last_read_message_id = MAX(last_read_message_id, ?)
    WHERE chat_id = ? AND user_id = ?
  `).run(messageId, chatId, userId);
}

/* =====================================================================
   Соцсеть (v2): посты, клипы, видео, лайки, комментарии, просмотры
   ===================================================================== */

db.exec(`
CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id  INTEGER NOT NULL REFERENCES users(id),
  type       TEXT NOT NULL CHECK (type IN ('post', 'clip', 'video')),
  text       TEXT NOT NULL DEFAULT '',
  media      TEXT,
  duration   REAL,
  views      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS likes (
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id),
  author_id  INTEGER NOT NULL REFERENCES users(id),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, id);
`);

// Универсальная сборка карточки поста/клипа/видео с автором и счётчиками.
// Порядок плейсхолдеров в SQL: EXISTS-подзапрос лайков (viewerId), затем
// условия where, затем LIMIT.
const postSelect = (viewerId, where = '', params = [], limit = 20) => db.prepare(`
  SELECT p.id, p.author_id, p.type, p.text, p.media, p.duration, p.views, p.created_at,
         u.username, u.display_name, u.avatar AS author_avatar,
         (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
         (SELECT COUNT(*) FROM comments cm WHERE cm.post_id = p.id) AS comments_count,
         EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ${viewerId ? '?' : '0'}) AS liked_by_me
  FROM posts p JOIN users u ON u.id = p.author_id
  WHERE 1=1 ${where}
  ORDER BY p.id DESC
  LIMIT ?
`).all(...(viewerId ? [viewerId] : []), ...params, limit);

function toPost(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    text: row.text,
    media: row.media,
    duration: row.duration,
    views: row.views,
    created_at: row.created_at,
    likes: row.likes,
    liked_by_me: !!row.liked_by_me,
    comments_count: row.comments_count,
    author: {
      id: row.author_id,
      username: row.username,
      display_name: row.display_name,
      avatar: row.author_avatar,
    },
  };
}

export function createPost({ authorId, type, text = '', media = null, duration = null }) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO posts (author_id, type, text, media, duration) VALUES (?, ?, ?, ?, ?)'
  ).run(authorId, type, text, media, duration);
  return Number(lastInsertRowid);
}

export function getPost(id, viewerId) {
  return toPost(postSelect(viewerId, 'AND p.id = ?', [id], 1).at(0));
}

export function listFeed(viewerId, { type = null, before = 0, limit = 20 } = {}) {
  const where = [];
  const params = [];
  if (type) { where.push('AND p.type = ?'); params.push(type); }
  if (before) { where.push('AND p.id < ?'); params.push(before); }
  return postSelect(viewerId, where.join(' '), params, limit).map(toPost);
}

export function listUserPosts(authorId, viewerId, { type = null, before = 0, limit = 20 } = {}) {
  const where = ['AND p.author_id = ?'];
  const params = [authorId];
  if (type) { where.push('AND p.type = ?'); params.push(type); }
  if (before) { where.push('AND p.id < ?'); params.push(before); }
  return postSelect(viewerId, where.join(' '), params, limit).map(toPost);
}

export function listFeedByTag(viewerId, tag, { before = 0, limit = 20 } = {}) {
  const where = ['AND EXISTS (SELECT 1 FROM tags tg WHERE tg.post_id = p.id AND tg.tag = ?)'];
  const params = [String(tag).toLowerCase()];
  if (before) { where.push('AND p.id < ?'); params.push(before); }
  return postSelect(viewerId, where.join(' '), params, limit).map(toPost);
}

export function searchPosts(viewerId, query, { before = 0, limit = 30 } = {}) {
  const like = `%${String(query).replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
  const where = ['AND p.text LIKE ? ESCAPE \'\\\''];
  const params = [like];
  if (before) { where.push('AND p.id < ?'); params.push(before); }
  return postSelect(viewerId, where.join(' '), params, limit).map(toPost);
}

export function deletePost(id, authorId) {
  const info = db.prepare('DELETE FROM posts WHERE id = ? AND author_id = ?').run(id, authorId);
  if (info.changes === 0) return false;
  db.prepare('DELETE FROM likes WHERE post_id = ?').run(id);
  db.prepare('DELETE FROM comments WHERE post_id = ?').run(id);
  return true;
}

export function toggleLike(postId, userId) {
  const existing = db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(postId, userId);
  if (existing) {
    db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').run(postId, userId);
  } else {
    db.prepare('INSERT INTO likes (post_id, user_id) VALUES (?, ?)').run(postId, userId);
  }
  const likes = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(postId).n;
  return { liked: !existing, likes };
}

export function incViews(postId) {
  db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(postId);
  return db.prepare('SELECT views FROM posts WHERE id = ?').get(postId)?.views ?? 0;
}

export function addComment(postId, authorId, text) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO comments (post_id, author_id, text) VALUES (?, ?, ?)'
  ).run(postId, authorId, text);
  return getCommentById(Number(lastInsertRowid));
}

export function getCommentById(id) {
  return db.prepare(`
    SELECT cm.id, cm.post_id, cm.author_id, cm.text, cm.created_at,
           u.username, u.display_name, u.avatar
    FROM comments cm JOIN users u ON u.id = cm.author_id
    WHERE cm.id = ?
  `).get(id) || null;
}

export function listComments(postId, { before = 0, limit = 100 } = {}) {
  return db.prepare(`
    SELECT cm.id, cm.post_id, cm.author_id, cm.text, cm.created_at,
           u.username, u.display_name, u.avatar
    FROM comments cm JOIN users u ON u.id = cm.author_id
    WHERE cm.post_id = ? ${before ? 'AND cm.id < ?' : ''}
    ORDER BY cm.id ASC LIMIT ?
  `).all(...(before ? [postId, before, limit] : [postId, limit]));
}

export function updateProfile(userId, { displayName, bio }) {
  db.prepare(`
    UPDATE users SET display_name = COALESCE(?, display_name), bio = COALESCE(?, bio)
    WHERE id = ?
  `).run(displayName ?? null, bio ?? null, userId);
  return getUserById(userId);
}

export function setAvatar(userId, url) {
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, userId);
  return getUserById(userId);
}

/* =====================================================================
   Уведомления и хэштеги (v3)
   ===================================================================== */

db.exec(`
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  actor_id   INTEGER NOT NULL REFERENCES users(id),
  type       TEXT NOT NULL CHECK (type IN ('like', 'comment')),
  post_id    INTEGER NOT NULL REFERENCES posts(id),
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);

CREATE TABLE IF NOT EXISTS tags (
  post_id INTEGER NOT NULL REFERENCES posts(id),
  tag     TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (post_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
`);

export function addNotification({ userId, actorId, type, postId }) {
  if (userId === actorId) return null; // свои действия не уведомляем
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, ?, ?)'
  ).run(userId, actorId, type, postId);
  return getNotificationById(Number(lastInsertRowid));
}

export function getNotificationById(id) {
  return db.prepare(`
    SELECT n.id, n.user_id, n.actor_id, n.type, n.post_id, n.is_read, n.created_at,
           a.display_name AS actor_name, a.username AS actor_username, a.avatar AS actor_avatar,
           p.type AS post_type, p.text AS post_text
    FROM notifications n
    JOIN users a ON a.id = n.actor_id
    JOIN posts p ON p.id = n.post_id
    WHERE n.id = ?
  `).get(id) || null;
}

export function listNotifications(userId, { limit = 50 } = {}) {
  return db.prepare(`
    SELECT n.id, n.user_id, n.actor_id, n.type, n.post_id, n.is_read, n.created_at,
           a.display_name AS actor_name, a.username AS actor_username, a.avatar AS actor_avatar,
           p.type AS post_type, p.text AS post_text
    FROM notifications n
    JOIN users a ON a.id = n.actor_id
    JOIN posts p ON p.id = n.post_id
    WHERE n.user_id = ?
    ORDER BY n.id DESC LIMIT ?
  `).all(userId, limit);
}

export function unreadNotificationsCount(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).n;
}

export function markNotificationsRead(userId, ids = null) {
  if (ids && Array.isArray(ids) && ids.length > 0) {
    const stmt = db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id = ?');
    for (const id of ids) stmt.run(userId, Number(id));
    return;
  }
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(userId);
}

const TAG_RE = /#([\p{L}\p{N}_]{2,30})/gu;

export function extractTags(text) {
  const set = new Set();
  for (const m of String(text || '').matchAll(TAG_RE)) set.add(m[1].toLowerCase());
  return [...set].slice(0, 10);
}

export function setPostTags(postId, tags) {
  db.prepare('DELETE FROM tags WHERE post_id = ?').run(postId);
  const ins = db.prepare('INSERT OR IGNORE INTO tags (post_id, tag) VALUES (?, ?)');
  for (const tag of tags) ins.run(postId, tag);
}

export function listTrends({ days = 7, limit = 8 } = {}) {
  return db.prepare(`
    SELECT t.tag, COUNT(*) AS count
    FROM tags t JOIN posts p ON p.id = t.post_id
    WHERE p.created_at >= datetime('now', ?)
    GROUP BY t.tag
    ORDER BY count DESC, t.tag ASC
    LIMIT ?
  `).all(`-${Number(days)} days`, limit);
}

export function getUserStats(userId) {
  return db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(views), 0) FROM posts WHERE author_id = ?) AS views,
      (SELECT COUNT(*) FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.author_id = ?) AS likes_received
  `).get(userId, userId);
}
