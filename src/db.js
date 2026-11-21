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

export function createUser({ username, displayName, passwordHash }) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)'
  ).run(username, displayName, passwordHash);
  return getUserById(Number(lastInsertRowid));
}

export function getUserById(id) {
  return db.prepare('SELECT id, username, display_name, created_at FROM users WHERE id = ?').get(id) || null;
}

export function getUserWithPassword(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

export function listUsers() {
  return db.prepare('SELECT id, username, display_name FROM users ORDER BY username COLLATE NOCASE').all();
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

export function insertMessage(chatId, senderId, text, image) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO messages (chat_id, sender_id, text, image) VALUES (?, ?, ?, ?)'
  ).run(chatId, senderId, text, image);
  return getMessageById(Number(lastInsertRowid));
}

export function getMessageById(id) {
  return db.prepare(`
    SELECT m.id, m.chat_id, m.sender_id, m.text, m.image, m.created_at,
           u.username, u.display_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `).get(id) || null;
}

export function listMessages(chatId, { before = 0, limit = 50 } = {}) {
  const rows = db.prepare(`
    SELECT m.id, m.chat_id, m.sender_id, m.text, m.image, m.created_at,
           u.username, u.display_name
    FROM messages m JOIN users u ON u.id = m.sender_id
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
    SELECT m.id, m.sender_id, m.text, m.image, m.created_at, u.display_name
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
    SELECT u.id, u.username, u.display_name FROM chat_members cm
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
