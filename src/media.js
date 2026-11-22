// Загрузка медиафайлов через multer: картинки, клипы и длинные видео.
// Файлы пишутся прямо в uploads/ (diskStorage), память не переполняется.
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.BLOOP_DATA_DIR || path.join(process.cwd(), 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  // голосовые сообщения
  'audio/webm': 'weba',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

export const MAX_VIDEO_BYTES = 300 * 1024 * 1024; // 300 МБ
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;  // 10 МБ
export const MAX_VOICE_BYTES = 25 * 1024 * 1024;  // 25 МБ (голосовое до ~5 минут)

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = EXT_BY_MIME[file.mimetype] || 'bin';
    cb(null, `${crypto.randomBytes(10).toString('hex')}.${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (EXT_BY_MIME[file.mimetype]) cb(null, true);
  else cb(new Error('UNSUPPORTED_TYPE'));
};

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: Math.max(MAX_VIDEO_BYTES, MAX_IMAGE_BYTES), files: 1 },
});

// После multer проверяем лимит размера для конкретного типа.
export function checkUploadSize(file) {
  const max = maxBytesFor(file.mimetype);
  return file.size <= max;
}

export function maxBytesFor(mimetype) {
  if (mimetype.startsWith('video/')) return MAX_VIDEO_BYTES;
  if (mimetype.startsWith('audio/')) return MAX_VOICE_BYTES;
  return MAX_IMAGE_BYTES;
}

export function mediaKind(mimetype) {
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'voice';
  return 'image';
}

export function publicUrl(filename) {
  return `/uploads/${path.basename(filename)}`;
}
