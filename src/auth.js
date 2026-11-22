// Аутентификация BLOOP: пароли хэшируются scrypt, сессии — подписанный
// HMAC-SHA256 токен «userId.срок.подпись». Внешних зависимостей нет.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.BLOOP_DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Секрет держим в файле, чтобы токены переживали перезапуск сервера.
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
let SECRET = process.env.BLOOP_SECRET || null;
if (!SECRET) {
  if (fs.existsSync(SECRET_FILE)) {
    SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } else {
    SECRET = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
  }
}

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 дней

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return test.length === real.length && crypto.timingSafeEqual(test, real);
}

// Коды входа (почта) хэшируем HMAC'ом с тем же секретом — утечка БД
// не раскрывает ни один код.
export function hashEmailCode(email, code) {
  return crypto.createHmac('sha256', SECRET).update(`${String(email).toLowerCase()}:${code}`).digest('base64url');
}

export function verifyEmailCode(email, code, storedHash) {
  const expected = Buffer.from(hashEmailCode(email, code));
  const given = Buffer.from(String(storedHash || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function signToken(userId) {
  const payload = `${userId}.${Date.now() + TOKEN_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  const payload = `${userId}.${exp}`;
  const good = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(payload)));
  if (!good) return null;
  if (!Number.isInteger(Number(userId)) || Number(exp) < Date.now()) return null;
  return Number(userId);
}
