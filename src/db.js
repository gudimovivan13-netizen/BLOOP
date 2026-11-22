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

// Миграции для баз, созданных до появления соцсети (v2), телефона/голоса (v4)
// и почты/историй/опросов/реакций (v5).
// v6: правка/удаление/пересылка сообщений, закреплённые чаты и сообщения, звонки.
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
if (!userCols.includes('bio')) db.exec("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''");

// v6: мета-колонки сообщений
const msgCols6 = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
if (!msgCols6.includes('edited_at')) db.exec('ALTER TABLE messages ADD COLUMN edited_at TEXT');
if (!msgCols6.includes('deleted')) db.exec('ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0');
if (!msgCols6.includes('forwarded_from')) db.exec('ALTER TABLE messages ADD COLUMN forwarded_from TEXT');
// v6: закреплённое сообщение чата и закреплённый чат в списке
const chatCols6 = db.prepare('PRAGMA table_info(chats)').all().map(c => c.name);
if (!chatCols6.includes('pinned_message_id')) db.exec('ALTER TABLE chats ADD COLUMN pinned_message_id INTEGER');
const memberCols6 = db.prepare('PRAGMA table_info(chat_members)').all().map(c => c.name);
if (!memberCols6.includes('pinned')) db.exec('ALTER TABLE chat_members ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');

if (!userCols.includes('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
if (!userCols.includes('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
if (!userCols.includes('email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
if (!userCols.includes('is_bot')) db.exec('ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0');

db.exec(`
CREATE TABLE IF NOT EXISTS email_codes (
  email     TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires   INTEGER NOT NULL,
  attempts  INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS stories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('image', 'text')),
  media      TEXT,
  text       TEXT,
  bg         TEXT,
  views      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_user ON stories(user_id, id);

CREATE TABLE IF NOT EXISTS story_views (
  story_id INTEGER NOT NULL REFERENCES stories(id),
  user_id  INTEGER NOT NULL REFERENCES users(id),
  seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (story_id, user_id)
);
`);

const msgCols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
if (!msgCols6.includes('media_kind')) db.exec("ALTER TABLE messages ADD COLUMN media_kind TEXT DEFAULT 'image'");
if (!msgCols6.includes('reply_to')) db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER');
if (!msgCols6.includes('kb')) db.exec('ALTER TABLE messages ADD COLUMN kb TEXT'); // инлайн-клавиатура ботов

db.exec(`
CREATE TABLE IF NOT EXISTS post_reactions (
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  emoji   TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS poll_votes (
  post_id    INTEGER NOT NULL REFERENCES posts(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  option_idx INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS msg_reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  emoji      TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
`);


function parseKb(raw) {
  if (!raw) return null;
  try {
    const kb = JSON.parse(raw);
    return Array.isArray(kb) && kb.length ? kb : null;
  } catch { return null; }
}

export function createUser({ username, displayName, passwordHash, phone = null, email = null }) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, phone, email, email_verified) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(username, displayName, passwordHash, phone, email, email ? 1 : 0);
  return getUserById(Number(lastInsertRowid));
}

export function getUserById(id) {
  return db.prepare(`
    SELECT id, username, display_name, avatar, bio, created_at, phone, email, email_verified, is_bot
    FROM users WHERE id = ?
  `).get(id) || null;
}

export function getUserWithPassword(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

export function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase()) || null;
}

export function saveEmailCode(email, codeHash, expires) {
  db.prepare(`
    INSERT INTO email_codes (email, code_hash, expires, attempts) VALUES (?, ?, ?, 0)
    ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires = excluded.expires, attempts = 0
  `).run(String(email).toLowerCase(), codeHash, expires);
}

export function getEmailCode(email) {
  return db.prepare('SELECT * FROM email_codes WHERE email = ?').get(String(email).toLowerCase()) || null;
}

export function bumpEmailAttempts(email) {
  db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?').run(String(email).toLowerCase());
}

export function deleteEmailCode(email) {
  db.prepare('DELETE FROM email_codes WHERE email = ?').run(String(email).toLowerCase());
}

export function listUsers() {
  return db.prepare('SELECT id, username, display_name, avatar, email_verified FROM users WHERE is_bot = 0 ORDER BY username COLLATE NOCASE').all();
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

export function insertMessage(chatId, senderId, text, image, mediaKind = 'image', replyTo = null, kb = null, forwardedFrom = null) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO messages (chat_id, sender_id, text, image, media_kind, reply_to, kb, forwarded_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(chatId, senderId, text, image, mediaKind, replyTo, kb == null ? null : JSON.stringify(kb), forwardedFrom);
  return getMessageById(Number(lastInsertRowid));
}

const MSG_SELECT = `
  SELECT m.id, m.chat_id, m.sender_id, m.text, m.image, m.media_kind, m.created_at, m.reply_to, m.kb,
         m.edited_at, m.deleted, m.forwarded_from,
         u.username, u.display_name,
         r.id AS r_id, r.text AS r_text, r.image AS r_image, r.media_kind AS r_kind, r.sender_id AS r_sender,
         ru.display_name AS r_author
  FROM messages m
  JOIN users u ON u.id = m.sender_id
  LEFT JOIN messages r ON r.id = m.reply_to
  LEFT JOIN users ru ON ru.id = r.sender_id`;

/* Реакции на сообщении: { reactions: {emoji: count}, mine: [emoji] } */
function messageReactions(messageId, viewerId) {
  const rows = db.prepare(`
    SELECT emoji, COUNT(*) AS n,
           MAX(CASE WHEN user_id = ${viewerId ? '?' : '0'} THEN 1 ELSE 0 END) AS mine
    FROM msg_reactions WHERE message_id = ? GROUP BY emoji
  `).all(...(viewerId ? [viewerId] : []), messageId);
  const out = { reactions: {}, mine: [] };
  for (const r of rows) {
    out.reactions[r.emoji] = r.n;
    if (r.mine) out.mine.push(r.emoji);
  }
  return out;
}

function msgRowOut(row, viewerId) {
  if (!row) return null;
  const out = {
    id: row.id,
    chat_id: row.chat_id,
    sender_id: row.sender_id,
    text: row.text,
    image: row.image,
    media_kind: row.media_kind || 'image',
    created_at: row.created_at,
    username: row.username,
    display_name: row.display_name,
    kb: parseKb(row.kb),
    edited_at: row.edited_at || null,
    forwarded_from: row.forwarded_from || null,
    ...messageReactions(row.id, viewerId),
  };
  if (row.deleted) {
    // надгробие: содержимое стёрто, осталась метка «сообщение удалено»
    out.deleted = true;
    out.text = '';
    out.image = null;
    out.kb = null;
    return out;
  }
  if (row.r_id) {
    out.reply = {
      id: row.r_id,
      author: row.r_author || '',
      text: row.r_text || '',
      image: row.r_image || null,
      kind: row.r_kind || 'image',
      mine: viewerId ? row.r_sender === viewerId : false,
    };
  }
  return out;
}

export function getMessageById(id, viewerId = null) {
  return msgRowOut(db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(id), viewerId);
}

export function listMessages(chatId, { before = 0, limit = 50, viewerId = null } = {}) {
  const rows = db.prepare(`
    ${MSG_SELECT}
    WHERE m.chat_id = ? ${before ? 'AND m.id < ?' : ''}
    ORDER BY m.id DESC LIMIT ?
  `).all(...(before ? [chatId, before, limit] : [chatId, limit]));
  return rows.reverse().map(r => msgRowOut(r, viewerId)); // по возрастанию id — старые сверху
}

/* Переключить эмодзи-реакцию на сообщении: тот же эмодзи — снять, другой — заменить. */
export function reactMessage(messageId, userId, emoji) {
  const mine = db.prepare('SELECT emoji FROM msg_reactions WHERE message_id = ? AND user_id = ?').all(messageId, userId);
  const had = mine.some(r => r.emoji === emoji);
  db.prepare('DELETE FROM msg_reactions WHERE message_id = ? AND user_id = ?').run(messageId, userId);
  if (!had) db.prepare('INSERT INTO msg_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(messageId, userId, emoji);
  return messageReactions(messageId, userId);
}

export function listChatsForUser(userId) {
  const chats = db.prepare(`
    SELECT c.id, c.type, c.name, c.created_at, c.pinned_message_id, cm.pinned
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
    SELECT u.id, u.username, u.display_name, u.avatar, u.is_bot,
           (SELECT COUNT(*) FROM bots b WHERE b.user_id = u.id AND b.enabled = 1 AND b.deleted = 0 AND b.miniapp_enabled = 1) AS has_miniapp
    FROM chat_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.chat_id = ? AND cm.user_id <> ?
  `);
  const memberCount = db.prepare('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?');

  const pinnedMsg = db.prepare('SELECT pinned_message_id AS mid FROM chats WHERE id = ?');
  return chats.map(c => {
    const mark = lastMsg.get(c.id);
    const lr = lastRead.get(c.id, userId).lr;
    const pmid = pinnedMsg.get(c.id)?.mid || null;
    return {
      id: c.id,
      type: c.type,
      name: c.name,
      peer: c.type === 'direct' ? (peer.get(c.id, userId) || null) : null,
      members_count: memberCount.get(c.id).n,
      last_message: mark || null,
      unread: unread.get(c.id, lr, userId).n,
      updated_at: mark ? mark.created_at : c.created_at,
      pinned: !!c.pinned,
      pinned_message_id: pmid,
      pinned_message: pmid ? (getMessageById(pmid) || null) : null,
    };
  }).sort((a, b) => (b.pinned - a.pinned) || ((b.last_message?.id ?? 0) - (a.last_message?.id ?? 0)));
}

/* ---------- v6: правка, удаление, пересылка, поиск, закрепы, группы, звонки ---------- */

export function editMessage(messageId, userId, text) {
  const clean = String(text || '').trim().slice(0, 4000);
  if (!clean) throw new Error('Текст пуст');
  const r = db.prepare(
    "UPDATE messages SET text = ?, edited_at = datetime('now') WHERE id = ? AND sender_id = ? AND deleted = 0"
  ).run(clean, messageId, userId);
  return r.changes > 0 ? getMessageById(messageId) : null;
}

export function deleteMessageRow(messageId, userId) {
  const r = db.prepare(
    "UPDATE messages SET deleted = 1, text = '', image = NULL, kb = NULL, media_kind = 'image' WHERE id = ? AND sender_id = ?"
  ).run(messageId, userId);
  return r.changes > 0 ? getMessageById(messageId) : null;
}

export function forwardMessage(sourceId, toChatId, userId) {
  const src = getMessageById(sourceId);
  if (!src || src.deleted) return null;
  // голосовое пересылается как есть, звонок — без содержимого
  const kind = src.media_kind === 'call' ? 'image' : (src.media_kind || 'image');
  return insertMessage(toChatId, userId, src.text || '', src.image, kind, null, null, src.display_name);
}

// поиск без учёта регистра: INSTR чувствителен к регистру, поэтому три варианта
function searchConds(t) {
  const vars = [...new Set([t, t.toLowerCase(), t.toUpperCase()])];
  return { conds: vars.map(() => 'INSTR(m.text, ?) > 0').join(' OR '), vars };
}

export function searchMessages(chatId, q, limit = 30) {
  const t = String(q || '').trim().slice(0, 120);
  if (!t) return [];
  const { conds, vars } = searchConds(t);
  const rows = db.prepare(`
    ${MSG_SELECT}
    WHERE m.chat_id = ? AND m.deleted = 0 AND m.text <> '' AND (${conds})
    ORDER BY m.id DESC LIMIT ?
  `).all(chatId, ...vars, limit);
  return rows.map(r => msgRowOut(r, null));
}

export function searchMessagesAll(userId, q, limit = 40) {
  const t = String(q || '').trim().slice(0, 120);
  if (!t) return [];
  const { conds, vars } = searchConds(t);
  const rows = db.prepare(`
    ${MSG_SELECT}
    JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
    WHERE m.deleted = 0 AND m.text <> '' AND (${conds})
    ORDER BY m.id DESC LIMIT ?
  `).all(userId, ...vars, limit);
  return rows.map(r => msgRowOut(r, null));
}

export function setPinnedMessage(chatId, messageId) {
  const mid = Number(messageId) || null;
  if (mid) {
    const m = db.prepare('SELECT id FROM messages WHERE id = ? AND chat_id = ? AND deleted = 0').get(mid, chatId);
    if (!m) return null;
  }
  db.prepare('UPDATE chats SET pinned_message_id = ? WHERE id = ?').run(mid, chatId);
  return mid ? getMessageById(mid) : null;
}

export function setChatPinned(chatId, userId, pinned) {
  db.prepare('UPDATE chat_members SET pinned = ? WHERE chat_id = ? AND user_id = ?')
    .run(pinned ? 1 : 0, chatId, userId);
}

export function getChatRow(chatId) {
  return db.prepare('SELECT id, type, name, created_by, pinned_message_id FROM chats WHERE id = ?').get(chatId) || null;
}

export function listChatMembers(chatId) {
  // роль берём из chats.created_by — колонка chat_members.role исторически всегда 'member'
  return db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar, u.is_bot,
           (CASE WHEN c.created_by = u.id THEN 'owner' ELSE 'member' END) AS role
    FROM chat_members cm
    JOIN users u ON u.id = cm.user_id
    JOIN chats c ON c.id = cm.chat_id
    WHERE cm.chat_id = ?
    ORDER BY (c.created_by = u.id) DESC, u.display_name
  `).all(chatId);
}

export function renameChat(chatId, name) {
  const title = String(name || '').trim().slice(0, 60);
  if (!title) throw new Error('Название пустое');
  db.prepare('UPDATE chats SET name = ? WHERE id = ?').run(title, chatId);
  return title;
}

export function addChatMembers(chatId, ids) {
  let added = 0;
  for (const id of ids) {
    const r = db.prepare('INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(chatId, id);
    added += r.changes;
  }
  return added;
}

export function leaveChat(chatId, userId) {
  const r = db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
  return r.changes > 0;
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

// Миграция опросов для баз, созданных до v5.
const postCols = db.prepare('PRAGMA table_info(posts)').all().map(c => c.name);
if (!postCols.includes('poll_options')) db.exec('ALTER TABLE posts ADD COLUMN poll_options TEXT');

// Универсальная сборка карточки поста/клипа/видео с автором, счётчиками,
// реакциями-эмодзи и данными опроса.
const postSelect = (viewerId, where = '', params = [], limit = 20) => db.prepare(`
  SELECT p.id, p.author_id, p.type, p.text, p.media, p.duration, p.views, p.created_at, p.poll_options,
         u.username, u.display_name, u.avatar AS author_avatar, u.email_verified AS author_verified,
         (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS legacy_likes,
         (SELECT COUNT(*) FROM comments cm WHERE cm.post_id = p.id) AS comments_count,
         EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.user_id = ${viewerId ? '?' : '0'}) AS legacy_liked
  FROM posts p JOIN users u ON u.id = p.author_id
  WHERE 1=1 ${where}
  ORDER BY p.id DESC
  LIMIT ?
`).all(...(viewerId ? [viewerId] : []), ...params, limit);

/* Реакции поста: сердечко ❤️ (совместимо со старыми лайками) + любые эмодзи. */
export const POST_EMOJIS = ['❤️', '🔥', '😂', '😮', '😢', '👍', '🤯', '💚'];

function postReactions(postId, viewerId, legacyLikes, legacyLiked) {
  const rows = db.prepare(`
    SELECT emoji, COUNT(*) AS n,
           MAX(CASE WHEN user_id = ${viewerId ? '?' : '0'} THEN 1 ELSE 0 END) AS mine
    FROM post_reactions WHERE post_id = ? GROUP BY emoji
  `).all(...(viewerId ? [viewerId] : []), postId);
  const reactions = {};
  let mine = [];
  let hearts = 0;
  let iHeart = false;
  for (const r of rows) {
    reactions[r.emoji] = r.n;
    if (r.emoji === '❤️') { hearts = r.n; if (r.mine) iHeart = true; }
    if (r.mine) mine.push(r.emoji);
  }
  // объединяем со старыми лайками (до перехода на реакции)
  db.prepare("DELETE FROM likes WHERE post_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM post_reactions pr WHERE pr.post_id = ? AND pr.user_id = ? AND pr.emoji = '❤️')").run(postId, viewerId ?? -1, postId, viewerId ?? -1);
  return {
    reactions,
    mine,
    likes: legacyLikes + hearts,
    liked: !!legacyLiked || iHeart,
  };
}

function pollOf(row, viewerId) {
  if (!row.poll_options) return null;
  let options = [];
  try { options = JSON.parse(row.poll_options); } catch { return null; }
  const votes = db.prepare('SELECT option_idx, COUNT(*) AS n FROM poll_votes WHERE post_id = ? GROUP BY option_idx').all(row.id);
  const counts = options.map((_, i) => votes.find(v => v.option_idx === i)?.n || 0);
  const my = viewerId
    ? db.prepare('SELECT option_idx FROM poll_votes WHERE post_id = ? AND user_id = ?').get(row.id, viewerId)
    : null;
  return {
    options,
    votes: counts,
    total: counts.reduce((s, n) => s + n, 0),
    my_vote: my ? my.option_idx : null,
  };
}

function toPost(row, viewerId = null) {
  if (!row) return null;
  const rx = postReactions(row.id, viewerId, row.legacy_likes, row.legacy_liked);
  return {
    id: row.id,
    type: row.type,
    text: row.text,
    media: row.media,
    duration: row.duration,
    views: row.views,
    created_at: row.created_at,
    poll: pollOf(row, viewerId),
    reactions: rx.reactions,
    my_reactions: rx.mine,
    likes: rx.likes,
    liked_by_me: rx.liked,
    comments_count: row.comments_count,
    author: {
      id: row.author_id,
      username: row.username,
      display_name: row.display_name,
      avatar: row.author_avatar,
      email_verified: !!row.author_verified,
    },
  };
}

export function createPost({ authorId, type, text = '', media = null, duration = null, pollOptions = null }) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO posts (author_id, type, text, media, duration, poll_options) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(authorId, type, text, media, duration, pollOptions ? JSON.stringify(pollOptions) : null);
  return Number(lastInsertRowid);
}

export function getPost(id, viewerId) {
  return toPost(postSelect(viewerId, 'AND p.id = ?', [id], 1).at(0), viewerId);
}

export function listFeed(viewerId, { type = null, before = 0, limit = 20 } = {}) {
  const where = [];
  const params = [];
  if (type) { where.push('AND p.type = ?'); params.push(type); }
  if (before) { where.push('AND p.id < ?'); params.push(before); }
  return postSelect(viewerId, where.join(' '), params, limit).map(r => toPost(r, viewerId));
}

export function listUserPosts(authorId, viewerId, { type = null, before = 0, limit = 20 } = {}) {
  const where = ['AND p.author_id = ?'];
  const params = [authorId];
  if (type) { where.push('AND p.type = ?'); params.push(type); }
  if (before) { where.push('AND p.id < ?'); params.push(before); }
  return postSelect(viewerId, where.join(' '), params, limit).map(r => toPost(r, viewerId));
}

export function listFeedByTag(viewerId, tag, { before = 0, limit = 20 } = {}) {
  const where = ['AND EXISTS (SELECT 1 FROM tags tg WHERE tg.post_id = p.id AND tg.tag = ?)'];
  const params = [String(tag).toLowerCase()];
  if (before) { where.push('AND p.id < ?'); params.push(before); }
  return postSelect(viewerId, where.join(' '), params, limit).map(r => toPost(r, viewerId));
}

export function searchPosts(viewerId, query, { before = 0, limit = 30 } = {}) {
  const like = `%${String(query).replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
  const where = ['AND p.text LIKE ? ESCAPE \'\\\''];
  const params = [like];
  if (before) { where.push('AND p.id < ?'); params.push(before); }
  return postSelect(viewerId, where.join(' '), params, limit).map(r => toPost(r, viewerId));
}

export function deletePost(id, authorId) {
  const info = db.prepare('DELETE FROM posts WHERE id = ? AND author_id = ?').run(id, authorId);
  if (info.changes === 0) return false;
  db.prepare('DELETE FROM likes WHERE post_id = ?').run(id);
  db.prepare('DELETE FROM comments WHERE post_id = ?').run(id);
  db.prepare('DELETE FROM post_reactions WHERE post_id = ?').run(id);
  db.prepare('DELETE FROM poll_votes WHERE post_id = ?').run(id);
  db.prepare('DELETE FROM tags WHERE post_id = ?').run(id);
  return true;
}

/*
 * Реакции-эмодзи на посте. ❤️ — это «лайк»: старые строки таблицы likes
 * мигрируются в реакции автоматически при первом касании, чтобы счётчик
 * не задваивался.
 */
export function reactPost(postId, userId, emoji) {
  if (!POST_EMOJIS.includes(emoji)) throw new Error('Неизвестная реакция');
  const existing = db.prepare('SELECT emoji FROM post_reactions WHERE post_id = ? AND user_id = ?').get(postId, userId);
  if (existing?.emoji === emoji) {
    db.prepare('DELETE FROM post_reactions WHERE post_id = ? AND user_id = ?').run(postId, userId);
  } else {
    db.prepare('DELETE FROM post_reactions WHERE post_id = ? AND user_id = ?').run(postId, userId);
    db.prepare("DELETE FROM likes WHERE post_id = ? AND user_id = ?").run(postId, userId); // миграция старого лайка
    db.prepare('INSERT INTO post_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)').run(postId, userId, emoji);
  }
  const post = getPost(postId, userId);
  return { liked: post.liked_by_me, likes: post.likes, reactions: post.reactions, mine: post.my_reactions };
}

/* Лайка (кнопка ♥ в клипах/видео) теперь эквивалентна реакции ❤️. */
export function toggleLike(postId, userId) {
  const r = reactPost(postId, userId, '❤️');
  return { liked: r.liked, likes: r.likes };
}

/* Голосование в опросе поста: переголосование перезаписывает выбор. */
export function votePoll(postId, userId, optionIdx) {
  const row = db.prepare('SELECT poll_options FROM posts WHERE id = ?').get(postId);
  const options = row?.poll_options ? JSON.parse(row.poll_options) : null;
  if (!options) throw new Error('У поста нет опроса');
  const idx = Number(optionIdx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) throw new Error('Неверный вариант ответа');
  db.prepare(`
    INSERT INTO poll_votes (post_id, user_id, option_idx) VALUES (?, ?, ?)
    ON CONFLICT(post_id, user_id) DO UPDATE SET option_idx = excluded.option_idx
  `).run(postId, userId, idx);
  const votes = db.prepare('SELECT option_idx, COUNT(*) AS n FROM poll_votes WHERE post_id = ? GROUP BY option_idx').all(postId);
  const counts = options.map((_, i) => votes.find(v => v.option_idx === i)?.n || 0);
  return { options, votes: counts, total: counts.reduce((s, n) => s + n, 0), my_vote: idx };
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
      (SELECT COUNT(*) FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.author_id = ?)
        + (SELECT COUNT(*) FROM post_reactions pr JOIN posts p2 ON p2.id = pr.post_id WHERE p2.author_id = ? AND pr.emoji = '❤️') AS likes_received
  `).get(userId, userId, userId);
}

/* =====================================================================
   Истории «Мгновения» (v5): фото/текст живут 24 часа
   ===================================================================== */

const STORY_TTL_MS = 24 * 3600 * 1000;

export function createStory({ userId, kind, media = null, text = null, bg = null, ttlMs = STORY_TTL_MS }) {
  db.prepare('DELETE FROM stories WHERE expires_at <= ?').run(Date.now()); // подчистим просроченные
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO stories (user_id, kind, media, text, bg, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, kind, media, text, bg, Date.now() + ttlMs);
  return Number(lastInsertRowid);
}

export function listStories(viewerId) {
  const rows = db.prepare(`
    SELECT s.id, s.user_id, s.kind, s.media, s.text, s.bg, s.views, s.created_at, s.expires_at,
           u.username, u.display_name, u.avatar,
           EXISTS(SELECT 1 FROM story_views sv WHERE sv.story_id = s.id AND sv.user_id = ?) AS viewed_by_me
    FROM stories s JOIN users u ON u.id = s.user_id
    WHERE s.expires_at > ?
    ORDER BY s.id ASC
  `).all(viewerId, Date.now());

  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) {
      byUser.set(r.user_id, {
        user: { id: r.user_id, username: r.username, display_name: r.display_name, avatar: r.avatar },
        stories: [],
      });
    }
    byUser.get(r.user_id).stories.push({
      id: r.id,
      kind: r.kind,
      media: r.media,
      text: r.text,
      bg: r.bg,
      views: r.views,
      created_at: r.created_at,
      expires_at: r.expires_at,
      viewed_by_me: !!r.viewed_by_me,
    });
  }
  // свой блок первым, затем непросмотренные, затем по свежести
  return [...byUser.values()].sort((a, b) => {
    const own = (x) => x.user.id === viewerId ? 1 : 0;
    if (own(a) !== own(b)) return own(b) - own(a);
    const unseen = (x) => x.stories.some(s => !s.viewed_by_me) ? 1 : 0;
    if (unseen(a) !== unseen(b)) return unseen(b) - unseen(a);
    return Math.max(...b.stories.map(s => s.id)) - Math.max(...a.stories.map(s => s.id));
  });
}

export function getStory(id) {
  return db.prepare('SELECT * FROM stories WHERE id = ?').get(id) || null;
}

export function deleteStory(id, userId) {
  db.prepare('DELETE FROM story_views WHERE story_id = ?').run(id); // сначала просмотры (FK)
  const info = db.prepare('DELETE FROM stories WHERE id = ? AND user_id = ?').run(id, userId);
  return info.changes > 0;
}

/* Отметить просмотр (один раз на пользователя), вернуть актуальный счётчик. */
export function viewStory(storyId, userId) {
  const info = db.prepare('INSERT OR IGNORE INTO story_views (story_id, user_id) VALUES (?, ?)').run(storyId, userId);
  if (info.changes > 0) db.prepare('UPDATE stories SET views = views + 1 WHERE id = ?').run(storyId);
  return db.prepare('SELECT views FROM stories WHERE id = ?').get(storyId)?.views ?? 0;
}

/* =====================================================================
   Заслуги (v5): вычисляемые достижения профиля
   ===================================================================== */

export function getUserBadges(userId) {
  const u = db.prepare('SELECT id, email_verified FROM users WHERE id = ?').get(userId);
  if (!u) return [];
  const posts = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE author_id = ?").get(userId).n;
  const clips = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE author_id = ? AND type = 'clip'").get(userId).n;
  const videos = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE author_id = ? AND type = 'video'").get(userId).n;
  const voices = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND media_kind = 'voice'").get(userId).n;
  const likesReceived = db.prepare('SELECT COUNT(*) AS n FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.author_id = ?').get(userId).n
    + db.prepare("SELECT COUNT(*) AS n FROM post_reactions pr JOIN posts p ON p.id = pr.post_id WHERE p.author_id = ? AND pr.emoji = '❤️'").get(userId).n;
  const maxViews = db.prepare('SELECT COALESCE(MAX(views), 0) AS n FROM posts WHERE author_id = ?').get(userId).n;
  const chats = db.prepare('SELECT COUNT(DISTINCT chat_id) AS n FROM chat_members WHERE user_id = ?').get(userId).n;
  const stories = db.prepare('SELECT COUNT(*) AS n FROM stories WHERE user_id = ?').get(userId).n;

  const b = (key, icon, title, desc, cur, goal) => ({
    key, icon, title, desc, unlocked: cur >= goal, progress: [cur, goal],
  });
  return [
    b('first_post', '🌱', 'Первые слова', 'Опубликовать первый пост', posts, 1),
    b('writer_10', '✍️', 'Блогер', '10 публикаций в ленте', posts, 10),
    b('clipper', '🎬', 'Клипмейкер', 'Снять первый клип', clips, 1),
    b('director', '🎥', 'Режиссёр', 'Загрузить своё видео', videos, 1),
    b('voice', '🎙', 'Голос BLOOP', 'Отправить голосовое в чате', voices, 1),
    b('loved_50', '❤️', 'Народный любимец', 'Собрать 50 лайков на своих публикациях', likesReceived, 50),
    b('viral_1000', '🔥', 'Вирусный', 'Набрать 1000 просмотров на одной публикации', maxViews, 1000),
    b('chatty', '💬', 'Трибуна', 'Поучаствовать в 5 чатах', chats, 5),
    b('moment', '✨', 'Мгновение', 'Выложить первую историю', stories, 1),
    b('verified', '✉️', 'Проверенный', 'Подтвердить почту при входе', u.email_verified ? 1 : 0, 1),
  ];
}

/* =====================================================================
   Боты и мини-аппы (v6): боты — специальные пользователи (is_bot = 1),
   поэтому чаты, сообщения и сокеты работают без изменений схемы.
   ===================================================================== */

db.exec(`
CREATE TABLE IF NOT EXISTS bots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id        INTEGER NOT NULL REFERENCES users(id),
  user_id         INTEGER NOT NULL UNIQUE REFERENCES users(id),
  username        TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  token           TEXT NOT NULL UNIQUE,
  code            TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  deleted         INTEGER NOT NULL DEFAULT 0,
  msg_count       INTEGER NOT NULL DEFAULT 0,
  logs            TEXT NOT NULL DEFAULT '[]',
  miniapp_enabled INTEGER NOT NULL DEFAULT 0,
  miniapp_title   TEXT NOT NULL DEFAULT '',
  miniapp_code    TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bot_states (
  bot_id INTEGER PRIMARY KEY REFERENCES bots(id),
  data   TEXT NOT NULL DEFAULT '{}'
);
`);

export function createBot({ ownerId, username, displayName, description, token, code }) {
  // бот — это пользователь без пароля (войти им нельзя), помечен is_bot = 1
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO users (username, display_name, password_hash, is_bot) VALUES (?, ?, '', 1)"
  ).run(username, displayName);
  const userId = Number(lastInsertRowid);
  const info = db.prepare(`
    INSERT INTO bots (owner_id, user_id, username, display_name, description, token, code)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(ownerId, userId, username, displayName, description, token, code);
  return getBotById(Number(info.lastInsertRowid));
}

const BOT_SELECT = `
  SELECT b.*, u.avatar AS user_avatar FROM bots b JOIN users u ON u.id = b.user_id
  WHERE b.deleted = 0`;

export function getBotById(id) {
  return db.prepare(BOT_SELECT + ' AND b.id = ?').get(id) || null;
}
export function getBotByUserId(userId) {
  return db.prepare(BOT_SELECT + ' AND b.user_id = ?').get(userId) || null;
}
export function getBotByToken(token) {
  return db.prepare(BOT_SELECT + " AND b.token = ? AND b.enabled = 1").get(token) || null;
}
export function getBotByUsername(username) {
  return db.prepare(BOT_SELECT + ' AND b.username = ?').get(String(username).toLowerCase()) || null;
}
export function listBotsByOwner(ownerId) {
  return db.prepare(BOT_SELECT + ' AND b.owner_id = ? ORDER BY b.id DESC').all(ownerId);
}
export function listPublicBots() {
  return db.prepare(BOT_SELECT + ' AND b.enabled = 1 ORDER BY b.msg_count DESC, b.id DESC').all();
}
export function botUsernameTaken(username) {
  return !!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
}
export function updateBot(id, fields = {}) {
  const map = {
    display_name: 'display_name', description: 'description', code: 'code',
    enabled: 'enabled', logs: 'logs', token: 'token',
    miniapp_enabled: 'miniapp_enabled', miniapp_title: 'miniapp_title', miniapp_code: 'miniapp_code',
  };
  for (const [key, col] of Object.entries(map)) {
    if (fields[key] !== undefined) {
      db.prepare('UPDATE bots SET ' + col + ' = ? WHERE id = ?').run(fields[key], id);
    }
  }
  const bot = getBotById(id);
  if (bot && fields.display_name !== undefined) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(fields.display_name, bot.user_id);
  }
  return bot;
}
export function bumpBotMsgs(id) {
  db.prepare('UPDATE bots SET msg_count = msg_count + 1 WHERE id = ?').run(id);
}
export function appendBotLogs(id, entries) {
  const row = db.prepare('SELECT logs FROM bots WHERE id = ?').get(id);
  let logs = [];
  try { logs = JSON.parse(row?.logs || '[]'); } catch { logs = []; }
  logs = [...logs, ...entries].slice(-40);
  db.prepare('UPDATE bots SET logs = ? WHERE id = ?').run(JSON.stringify(logs), id);
}
export function deleteBot(id, ownerId) {
  const info = db.prepare('UPDATE bots SET deleted = 1, enabled = 0 WHERE id = ? AND owner_id = ?').run(id, ownerId);
  if (info.changes === 0) return false;
  const raw = db.prepare('SELECT user_id FROM bots WHERE id = ?').get(id);
  if (raw) db.prepare("UPDATE users SET display_name = 'Удалённый бот' WHERE id = ?").run(raw.user_id);
  return true;
}
export function getBotState(botId) {
  const row = db.prepare('SELECT data FROM bot_states WHERE bot_id = ?').get(botId);
  if (!row) return {};
  try { return JSON.parse(row.data) || {}; } catch { return {}; }
}
export function setBotState(botId, data) {
  db.prepare(`
    INSERT INTO bot_states (bot_id, data) VALUES (?, ?)
    ON CONFLICT(bot_id) DO UPDATE SET data = excluded.data
  `).run(botId, JSON.stringify(data ?? {}));
}
export function publicBot(b, { withToken = false } = {}) {
  if (!b) return null;
  let logs = [];
  try { logs = JSON.parse(b.logs || '[]'); } catch { logs = []; }
  return {
    id: b.id,
    user_id: b.user_id,
    username: b.username,
    display_name: b.display_name,
    description: b.description,
    enabled: !!b.enabled,
    msg_count: b.msg_count,
    has_miniapp: !!b.miniapp_enabled && !!(b.miniapp_code || '').trim(),
    created_at: b.created_at,
    ...(withToken ? {
      token: b.token,
      code: b.code,
      miniapp: { enabled: !!b.miniapp_enabled, title: b.miniapp_title, code: b.miniapp_code },
      logs,
    } : {}),
  };
}

// v6: индексы для частых выборок (таблицы к этому моменту созданы)
db.exec(`
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);
CREATE INDEX IF NOT EXISTS idx_posts_id ON posts(id);
`);
