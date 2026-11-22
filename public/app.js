/* BLOOP — клиент соцсети: лента, клипы, видео, чаты, профиль */

const $ = (sel) => document.querySelector(sel);

const token = () => localStorage.getItem('bloop_token') || '';

/* Локальный режим (Android APK): «сервер» работает внутри приложения.
   Включается конфигом window.BLOOP_CONFIG.mode === 'local' или ?local=1 для отладки. */
const LOCAL_MODE = window.BLOOP_CONFIG?.mode === 'local' || location.search.includes('local=1');
const localServer = () => window.__BLOOP_LOCAL__;

let me = null;
let chats = [];
let usersCache = new Map();          // id -> {id, username, display_name, avatar, online}
let socket = null;

/* состояние мессенджера */
let currentChatId = null;
let messagesByChat = new Map();      // chat_id -> [messages]
const typingTimers = new Map();      // chat_id -> timeout id
let pendingImage = null;             // dataURL в чате

/* состояние соцсети */
let currentPage = 'feed';
let feedPosts = [], feedLoaded = false, feedExhausted = false;
let profileState = { userId: null, user: null, counts: null, tab: 'post', posts: [] };
let clipsPosts = [], clipsLoaded = false;
let videosPosts = [], videosLoaded = false;
let uploadMode = 'clip';             // 'clip' | 'video'
let pendingUploadFile = null;        // выбранный File в модалке загрузки
let commentsPostId = null;           // открытые комментарии
let videoModalPost = null;
const viewedPosts = new Set();       // просмотры за сессию
let feedMode = { kind: 'all', value: null }; // 'all' | 'tag' | 'search'
let notifUnread = 0;
let aiHistory = [];                  // диалог с Floop
let aiBusy = false;

/* ---------- API ---------- */

async function api(path, { method = 'GET', body, headers } = {}) {
  if (LOCAL_MODE) {
    const res = await localServer().request(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
      },
      body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)),
    });
    if (res.status >= 400) {
      const err = new Error(res.data?.error || `Ошибка ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.data;
  }
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(headers || {}),
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
    },
    body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function uploadFile(file) {
  if (LOCAL_MODE) return localServer().storeFile(file);
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` },
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
  return data;
}

/* ---------- утилиты ---------- */

function avatarColor(id) {
  return `hsl(${(Number(id) * 137.5) % 360}, 52%, 46%)`;
}

function initials(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function avatarEl(user, small = false) {
  const el = document.createElement('span');
  el.className = 'avatar' + (small ? ' small' : '');
  el.style.background = avatarColor(user?.id ?? 0);
  if (user?.avatar) {
    const img = document.createElement('img');
    img.src = user.avatar;
    img.alt = '';
    el.appendChild(img);
  } else {
    el.textContent = initials(user?.display_name || user?.username);
  }
  const dot = document.createElement('span');
  dot.className = 'dot' + (user?.online ? ' on' : '');
  el.appendChild(dot);
  return el;
}

function hhmm(iso) {
  const d = new Date(iso + 'Z');
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(iso) {
  const d = new Date(iso + 'Z');
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Сегодня';
  if (same(d, yest)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function timeAgo(iso) {
  const sec = Math.max(1, Math.floor((Date.now() - new Date(iso + 'Z').getTime()) / 1000));
  if (sec < 60) return 'только что';
  if (sec < 3600) return Math.floor(sec / 60) + ' мин';
  if (sec < 86400) return Math.floor(sec / 3600) + ' ч';
  if (sec < 172800) return 'вчера';
  return new Date(iso + 'Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function formatCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.0', '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'K';
  return String(n);
}

function formatDuration(s) {
  if (!Number.isFinite(s)) return '';
  const sec = Math.round(s);
  const m = Math.floor(sec / 60), r = sec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${m}:${String(r).padStart(2, '0')}`;
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { resolve(v.duration); URL.revokeObjectURL(v.src); };
    v.onerror = () => resolve(null);
    v.src = URL.createObjectURL(file);
  });
}

const SVG_HEART = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 20s-7.5-4.7-9.3-9A5.2 5.2 0 0 1 12 6.4 5.2 5.2 0 0 1 21.3 11c-1.8 4.3-9.3 9-9.3 9z"/></svg>';
const SVG_COMMENT = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 4c4.7 0 8.5 3.2 8.5 7.2S16.7 18.4 12 18.4c-.9 0-1.8-.1-2.6-.3L5 20l1.3-3.3C4.9 15.4 3.5 13.5 3.5 11.2 3.5 7.2 7.3 4 12 4z"/></svg>';
const SVG_EYE = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 5c5 0 9 4.5 9 7s-4 7-9 7-9-4.5-9-7 4-7 9-7zm0 3.4A3.6 3.6 0 1 0 12 15.6 3.6 3.6 0 0 0 12 8.4z"/></svg>';
const SVG_TRASH = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 7h12l-1 13H7L6 7zm3-3h6l1 2h4v2H4V6h4l1-2z"/></svg>';

/* ---------- авторизация ---------- */

document.querySelectorAll('.auth-tabs .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-tabs .tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $('#login-form').classList.toggle('hidden', btn.dataset.tab !== 'login');
    $('#register-form').classList.toggle('hidden', btn.dataset.tab !== 'register');
    $('#phone-form').classList.toggle('hidden', btn.dataset.tab !== 'phone');
    $('#auth-error').textContent = '';
  });
});

function authFail(msg) {
  $('#auth-error').textContent = msg;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: { username: $('#login-username').value.trim(), password: $('#login-password').value },
    });
    localStorage.setItem('bloop_token', data.token);
    enterApp(data.user);
  } catch (err) {
    authFail(err.message);
  }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: {
        username: $('#reg-username').value.trim(),
        display_name: $('#reg-display').value.trim(),
        password: $('#reg-password').value,
      },
    });
    localStorage.setItem('bloop_token', data.token);
    enterApp(data.user);
  } catch (err) {
    authFail(err.message);
  }
});

/* ---------- вход по номеру телефона (6-значный код без внешних API) ---------- */

const phoneState = { phone: null, timer: null, left: 0 };

function phoneShow(step) {
  $('#phone-step-1').classList.toggle('hidden', step !== 1);
  $('#phone-step-2').classList.toggle('hidden', step !== 2);
}

function phoneTickTimer() {
  if (phoneState.left <= 0) {
    $('#phone-timer').textContent = '';
    clearInterval(phoneState.timer);
    phoneState.timer = null;
    return;
  }
  phoneState.left -= 1;
  $('#phone-timer').textContent = `Код действует ${Math.floor(phoneState.left / 60)}:${String(phoneState.left % 60).padStart(2, '0')}`;
}

async function phoneStart() {
  const phone = $('#phone-number').value.trim();
  if (!phone) { authFail('Введите номер телефона'); return; }
  const btn = $('#phone-send-code');
  btn.disabled = true;
  try {
    const data = await api('/api/auth/phone/start', { method: 'POST', body: { phone } });
    phoneState.phone = phone;
    phoneState.left = data.ttl_sec || 300;
    phoneShow(2);
    $('#phone-code').value = '';
    $('#phone-code').focus();
    clearInterval(phoneState.timer);
    phoneTickTimer();
    phoneState.timer = setInterval(phoneTickTimer, 1000);
    // Локальная доставка: в офлайн-приложении SMS-шлюза нет — код показываем сразу
    if (data.local_code) {
      toast(`📡 SMS от BLOOP: код ${data.local_code}`, 15000);
    } else {
      toast('📱 Код отправлен — он виден в консоли сервера (без внешних SMS API)', 6000);
    }
  } catch (err) {
    authFail(err.message);
  } finally {
    btn.disabled = false;
  }
}

$('#phone-send-code').addEventListener('click', phoneStart);
$('#phone-resend').addEventListener('click', phoneStart);

$('#phone-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#phone-code').value.trim();
  if (!/^\d{6}$/.test(code)) { authFail('Код состоит из 6 цифр'); return; }
  try {
    const data = await api('/api/auth/phone/verify', {
      method: 'POST',
      body: { phone: phoneState.phone, code, display_name: $('#phone-display').value.trim() },
    });
    localStorage.setItem('bloop_token', data.token);
    clearInterval(phoneState.timer);
    toast(data.created ? '🎉 Аккаунт создан по номеру телефона!' : '👋 С возвращением!');
    enterApp(data.user);
  } catch (err) {
    authFail(err.message);
  }
});

$('#btn-logout').addEventListener('click', () => {
  localStorage.removeItem('bloop_token');
  location.reload();
});

/* ---------- запуск приложения ---------- */

async function enterApp(user) {
  me = user;
  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderMyIdentity();
  await refreshUsers();
  await refreshChats();
  loadNotifCount();
  connectSocket();
  showPage('feed');
}

function renderMyIdentity() {
  $('#my-name').textContent = me.display_name;
  const av = avatarEl(me, true);
  av.querySelector('.dot').remove();
  av.id = 'my-avatar';
  $('#my-avatar').replaceWith(av);

  const cav = avatarEl(me, true);
  cav.querySelector('.dot').remove();
  cav.id = 'composer-avatar';
  $('#composer-avatar').replaceWith(cav);
}

async function refreshUsers() {
  const { users } = await api('/api/users');
  usersCache = new Map(users.map(u => [u.id, u]));
}

async function refreshChats() {
  const { chats: list } = await api('/api/chats');
  chats = list;
  renderChatList();
  updateUnreadUi();
}

function totalUnread() {
  return chats.reduce((s, c) => s + (c.unread || 0), 0);
}

function updateUnreadUi() {
  const total = totalUnread();
  document.title = (total ? `(${total}) ` : '') + 'BLOOP — соцсеть';
  for (const id of ['#nav-unread', '#nav-unread-m']) {
    const b = $(id);
    b.classList.toggle('hidden', !total);
    b.textContent = total || '';
  }
}

/* ---------- навигация по страницам ---------- */

const pageEnter = {
  feed: () => { if (!feedLoaded || feedMode.kind !== 'all') loadFeed({ reset: true }); loadFeedSide(); },
  clips: () => { if (!clipsLoaded) loadClips(); },
  videos: () => { if (!videosLoaded) loadVideos(); },
  messages: () => refreshChats(),
  profile: () => openProfile(me.id),
};

function showPage(name) {
  currentPage = name;
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  document.querySelectorAll('.nav-item, .bnav-item').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  pauseAllClips();
  pageEnter[name]?.();
}

document.querySelectorAll('.nav-item, .bnav-item').forEach(btn =>
  btn.addEventListener('click', () => { if (btn.dataset.page) showPage(btn.dataset.page); })
);

/* ---------- список чатов ---------- */

function chatTitleOf(chat) {
  if (chat.type === 'group') return chat.name;
  const peer = chat.peer;
  return peer ? peer.display_name : 'Удалённый пользователь';
}

function renderChatList() {
  const box = $('#chat-list');
  box.replaceChildren();
  for (const chat of chats) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (chat.id === currentChatId ? ' active' : '');
    item.dataset.chatId = chat.id;

    const peer = chat.type === 'direct' ? chat.peer : null;
    const av = avatarEl(peer || { id: chat.id + 1000, display_name: chat.name });
    if (chat.type === 'group') av.querySelector('.dot').remove();

    const meta = document.createElement('div');
    meta.className = 'meta';

    const row1 = document.createElement('div');
    row1.className = 'row1';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = chatTitleOf(chat);
    const time = document.createElement('div');
    time.className = 'time';
    time.textContent = chat.last_message ? hhmm(chat.last_message.created_at) : '';
    row1.append(name, time);

    const row2 = document.createElement('div');
    row2.className = 'row2';
    const preview = document.createElement('div');
    preview.className = 'preview';
    const lm = chat.last_message;
    if (!lm) {
      preview.textContent = 'Нет сообщений';
    } else {
      const prefix = lm.sender_id === me.id ? 'Вы: ' : '';
      preview.textContent = prefix + (lm.image && !lm.text ? '[изображение]' : lm.text);
    }
    if (chat.type === 'group') {
      const label = document.createElement('span');
      label.className = 'grouplabel';
      label.textContent = `группа · ${chat.members_count}`;
      preview.prepend(label);
    }
    const unread = document.createElement('span');
    unread.className = 'unread';
    unread.classList.toggle('hidden', !chat.unread);
    unread.textContent = chat.unread || '';
    row2.append(preview, unread);

    meta.append(row1, row2);
    item.append(av, meta);
    item.addEventListener('click', () => openChat(chat.id));
    box.appendChild(item);
  }
}

/* ---------- открытие чата ---------- */

function chatById(id) {
  return chats.find(c => c.id === id);
}

async function openChat(id) {
  currentChatId = id;
  const chat = chatById(id);
  if (!chat) return;

  $('#empty-state').classList.add('hidden');
  $('#chat-view').classList.remove('hidden');
  $('#page-messages').classList.add('show-chat'); // на мобильных открываем чат

  const peer = chat.type === 'direct' ? chat.peer : null;
  $('#chat-name').textContent = chatTitleOf(chat);

  const cav = avatarEl(peer || { id: id + 1000, display_name: chat.name });
  if (chat.type === 'group') cav.querySelector('.dot').remove();
  cav.id = 'chat-avatar';
  $('#chat-avatar').replaceWith(cav);

  renderChatStatus(chat);
  updateTypingBar();

  chat.unread = 0;
  renderChatList();
  updateUnreadUi();

  await loadMessages(id);
  if (currentChatId === id) markRead(id);
}

function renderChatStatus(chat) {
  const st = $('#chat-status');
  st.classList.remove('online');
  if (chat.type === 'group') {
    st.textContent = `группа · ${chat.members_count} участников`;
    return;
  }
  const peer = usersCache.get(chat.peer?.id);
  if (peer?.online) {
    st.classList.add('online');
    st.textContent = 'в сети';
  } else {
    st.textContent = 'не в сети';
  }
}

async function loadMessages(id) {
  const { messages } = await api(`/api/chats/${id}/messages`);
  messagesByChat.set(id, messages);
  if (currentChatId === id) renderMessages(messages);
}

function renderMessages(messages) {
  const box = $('#messages');
  box.replaceChildren();
  let lastDay = '';
  for (const m of messages) {
    const day = dayLabel(m.created_at);
    if (day !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      sep.textContent = day;
      box.appendChild(sep);
      lastDay = day;
    }
    box.appendChild(msgEl(m));
  }
  scrollBottom();
}

function msgEl(m) {
  const el = document.createElement('div');
  el.className = 'msg' + (m.sender_id === me.id ? ' mine' : '');
  el.dataset.id = m.id;

  const chat = chatById(m.chat_id);
  if (chat?.type === 'group' && m.sender_id !== me.id) {
    const sender = document.createElement('div');
    sender.className = 'sender';
    sender.textContent = m.display_name;
    el.appendChild(sender);
  }

  if (m.image && m.media_kind === 'voice') {
    el.appendChild(voiceBubble(m));
  } else if (m.image) {
    const img = document.createElement('img');
    img.className = 'img';
    img.src = m.image;
    img.alt = 'изображение';
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(m.image, '_blank'));
    el.appendChild(img);
  }

  if (m.text) {
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = m.text;
    el.appendChild(body);
  }

  const foot = document.createElement('div');
  foot.className = 'foot';
  foot.textContent = hhmm(m.created_at);
  el.appendChild(foot);
  return el;
}

/* Голосовое сообщение: плеер с прогрессом и волной */
function voiceBubble(m) {
  const wrap = document.createElement('div');
  wrap.className = 'voice-bubble';
  const play = document.createElement('button');
  play.className = 'vb-play';
  play.textContent = '▶';
  const wave = document.createElement('div');
  wave.className = 'vb-wave';
  for (let i = 0; i < 22; i++) {
    const bar = document.createElement('span');
    bar.style.height = `${8 + Math.round(14 * Math.abs(Math.sin(i * 1.7 + (m.id || 0))))}px`;
    wave.appendChild(bar);
  }
  const time = document.createElement('span');
  time.className = 'vb-time';
  time.textContent = '…';

  const audio = new Audio(m.image); // голосовое хранится в поле image
  let playing = false;
  audio.onloadedmetadata = () => { time.textContent = formatDuration(audio.duration); };
  play.addEventListener('click', () => {
    if (playing) { audio.pause(); return; }
    document.querySelectorAll('.voice-bubble audio').forEach(a => a.pause());
    audio.play();
  });
  audio.onplay = () => { playing = true; play.textContent = '⏸'; };
  audio.onpause = () => { playing = false; play.textContent = '▶'; audio.currentTime = 0; };
  audio.ontimeupdate = () => {
    const p = audio.duration ? audio.currentTime / audio.duration : 0;
    wave.style.setProperty('--vb-progress', `${Math.round(p * 100)}%`);
  };
  audio.onended = () => { audio.onpause?.(); };

  wrap.appendChild(play);
  wrap.appendChild(wave);
  wrap.appendChild(time);
  return wrap;
}

function appendMessage(m) {
  if (m.chat_id !== currentChatId) return;
  const box = $('#messages');
  if (box.querySelector(`.msg[data-id="${m.id}"]`)) return; // уже на экране
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;

  const day = dayLabel(m.created_at);
  const seps = box.querySelectorAll('.day-sep');
  const lastSep = seps[seps.length - 1];
  if (!lastSep || lastSep.textContent !== day) {
    const sep = document.createElement('div');
    sep.className = 'day-sep';
    sep.textContent = day;
    box.appendChild(sep);
  }
  box.appendChild(msgEl(m));
  if (nearBottom) scrollBottom();
}

function scrollBottom() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

function markRead(id) {
  const msgs = messagesByChat.get(id) || [];
  const last = msgs[msgs.length - 1];
  if (!last) return;
  api(`/api/chats/${id}/read`, { method: 'POST', body: { message_id: last.id } }).catch(() => {});
}

/* ---------- отправка ---------- */

const input = $('#msg-input');

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 130) + 'px';
  if (currentChatId) sendTyping(true);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

$('#btn-send').addEventListener('click', sendMessage);

let typingSentAt = 0;
function sendTyping(state) {
  const now = Date.now();
  if (state && now - typingSentAt < 1500) return;
  typingSentAt = now;
  socket?.emit('typing', { chat_id: currentChatId, typing: state });
}

$('#file-input').addEventListener('change', () => {
  const file = $('#file-input').files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    alert('Изображение должно быть не больше 8 МБ');
    $('#file-input').value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingImage = reader.result;
    showImageChip(file.name);
  };
  reader.readAsDataURL(file);
});

function showImageChip(name) {
  removeImageChip();
  const chip = document.createElement('div');
  chip.id = 'img-chip';
  chip.className = 'ghost-btn';
  chip.textContent = `Изображение: ${name} ✕`;
  chip.title = 'Нажмите, чтобы убрать';
  chip.addEventListener('click', clearPendingImage);
  document.querySelector('.composer').prepend(chip);
  input.placeholder = 'Подпись к изображению…';
}

function removeImageChip() {
  $('#img-chip')?.remove();
  input.placeholder = 'Сообщение…';
}

function clearPendingImage() {
  pendingImage = null;
  $('#file-input').value = '';
  removeImageChip();
}

async function sendMessage() {
  const text = input.value.trim();
  if (!currentChatId || (!text && !pendingImage && !pendingVoice)) return;
  input.value = '';
  input.style.height = 'auto';
  const image = pendingImage;
  const voice = pendingVoice;
  pendingVoice = null;
  clearPendingImage();
  try {
    const { message } = await api(`/api/chats/${currentChatId}/messages`, {
      method: 'POST',
      body: { text, image, voice: voice?.dataUrl || null },
    });
    const list = messagesByChat.get(currentChatId) || [];
    if (!list.some(x => x.id === message.id)) { // событие из сокета могло прийти раньше ответа
      list.push(message);
      messagesByChat.set(currentChatId, list);
      appendMessage(message);
    }
    refreshChats();
  } catch (err) {
    alert('Не отправлено: ' + err.message);
  }
}

/* ---------- голосовые сообщения ---------- */

let pendingVoice = null; // { dataUrl }
let voiceRecorder = null;
let voiceChunks = [];
let voiceStream = null;
let voiceStartedAt = 0;
let voiceTimer = null;

$('#btn-voice').addEventListener('click', async () => {
  if (!currentChatId) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    alert('Микрофон недоступен в этом браузере');
    return;
  }
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    alert('Доступ к микрофону запрещён — разрешите его в настройках');
    return;
  }
  clearPendingImage();
  voiceChunks = [];
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find(t => MediaRecorder.isTypeSupported?.(t)) || '';
  voiceRecorder = new MediaRecorder(voiceStream, mime ? { mimeType: mime } : undefined);
  voiceRecorder.ondataavailable = (e) => { if (e.data.size) voiceChunks.push(e.data); };
  voiceRecorder.onstop = () => {
    voiceStream.getTracks().forEach(t => t.stop());
    clearInterval(voiceTimer);
    $('#voice-rec').classList.add('hidden');
    const duration = (Date.now() - voiceStartedAt) / 1000;
    if (duration < 1) { toast('Запись слишком короткая'); return; }
    const blob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || 'audio/webm' });
    const reader = new FileReader();
    reader.onload = () => {
      pendingVoice = { dataUrl: reader.result };
      sendMessage();
    };
    reader.readAsDataURL(blob);
  };
  voiceRecorder.start();
  voiceStartedAt = Date.now();
  $('#voice-time').textContent = '0:00';
  $('#voice-rec').classList.remove('hidden');
  voiceTimer = setInterval(() => {
    $('#voice-time').textContent = formatDuration((Date.now() - voiceStartedAt) / 1000);
  }, 250);
});

$('#voice-stop').addEventListener('click', () => {
  if (voiceRecorder?.state === 'recording') voiceRecorder.stop();
});

$('#voice-cancel').addEventListener('click', () => {
  if (voiceRecorder) voiceRecorder.onstop = null; // остановка без отправки
  if (voiceRecorder?.state === 'recording') voiceRecorder.stop();
  voiceStream?.getTracks().forEach(t => t.stop());
  clearInterval(voiceTimer);
  $('#voice-rec').classList.add('hidden');
  toast('Запись отменена');
});

/* ---------- поиск людей и чаты ---------- */

$('#search').addEventListener('input', async () => {
  const q = $('#search').value.trim().toLowerCase();
  const results = $('#search-results');
  if (!q) {
    results.classList.add('hidden');
    results.replaceChildren();
    return;
  }
  results.classList.remove('hidden');
  await refreshUsers(); // список мог устареть — подтягиваем свежий с сервера
  results.replaceChildren();
  const label = document.createElement('div');
  label.className = 'search-label';
  label.textContent = 'Люди';
  results.appendChild(label);

  const matches = [...usersCache.values()].filter(u =>
    u.id !== me.id &&
    (u.username.toLowerCase().includes(q) || u.display_name.toLowerCase().includes(q))
  );
  if (matches.length === 0) {
    const none = document.createElement('div');
    none.className = 'search-label';
    none.textContent = 'Никого не найдено';
    results.appendChild(none);
  }
  for (const u of matches) {
    const row = document.createElement('div');
    row.className = 'user-row';
    row.appendChild(avatarEl(u, true));
    const name = document.createElement('span');
    name.textContent = `${u.display_name} (@${u.username})`;
    row.appendChild(name);
    row.addEventListener('click', () => startDirectChat(u));
    results.appendChild(row);
  }
});

async function startDirectChat(user) {
  try {
    const { chat_id } = await api('/api/chats', { method: 'POST', body: { type: 'direct', user_id: user.id } });
    $('#search').value = '';
    $('#search').dispatchEvent(new Event('input'));
    await refreshChats();
    showPage('messages');
    openChat(chat_id);
  } catch (err) {
    alert(err.message);
  }
}

/* ---------- создание группы ---------- */

$('#btn-group').addEventListener('click', async () => {
  await refreshUsers();
  const box = $('#group-users');
  box.replaceChildren();
  for (const u of usersCache.values()) {
    if (u.id === me.id) continue;
    const row = document.createElement('label');
    row.className = 'group-user';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = u.id;
    row.append(cb, avatarEl(u, true), Object.assign(document.createElement('span'), { textContent: `${u.display_name} (@${u.username})` }));
    box.appendChild(row);
  }
  $('#group-modal').classList.remove('hidden');
});

$('#group-cancel').addEventListener('click', () => $('#group-modal').classList.add('hidden'));

$('#group-create').addEventListener('click', async () => {
  const name = $('#group-name').value.trim();
  const ids = [...$('#group-users').querySelectorAll('input:checked')].map(i => Number(i.value));
  if (!name) { alert('Введите название группы'); return; }
  if (ids.length === 0) { alert('Выберите хотя бы одного участника'); return; }
  try {
    const { chat_id } = await api('/api/chats', { method: 'POST', body: { type: 'group', name, member_ids: ids } });
    $('#group-modal').classList.add('hidden');
    $('#group-name').value = '';
    await refreshChats();
    openChat(chat_id);
  } catch (err) {
    alert(err.message);
  }
});

/* ---------- «назад» на мобильных ---------- */

$('#btn-back').addEventListener('click', () => {
  $('#page-messages').classList.remove('show-chat');
  currentChatId = null;
  $('#chat-view').classList.add('hidden');
  $('#empty-state').classList.remove('hidden');
});

/* ---------- сокет ---------- */

async function connectSocket() {
  if (LOCAL_MODE) {
    socket = new localServer().LocalSocket(); // локальная шина событий
  } else {
    // socket.io грузим динамически: в автономной сборке его нет
    if (typeof io === 'undefined') {
      await new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = '/socket.io/socket.io.js';
        s.onload = resolve;
        s.onerror = resolve;
        document.head.appendChild(s);
      });
    }
    socket = io({ auth: { token: token() } });
  }

  socket.on('connect', () => {
    // после переподключения могли быть пропущены сообщения
    refreshChats();
    if (currentChatId) loadMessages(currentChatId);
  });

  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') {
      localStorage.removeItem('bloop_token');
      location.reload();
    }
  });

  socket.on('presence:list', ({ online_ids }) => {
    for (const id of online_ids) {
      const u = usersCache.get(id);
      if (u) u.online = true;
    }
    renderChatList();
    if (currentChatId) renderChatStatus(chatById(currentChatId));
  });

  socket.on('presence', ({ user_id, online }) => {
    const u = usersCache.get(user_id);
    if (u) u.online = online;
    renderChatList();
    if (currentChatId) renderChatStatus(chatById(currentChatId));
  });

  socket.on('message', (m) => {
    const list = messagesByChat.get(m.chat_id);
    if (list && !list.some(x => x.id === m.id)) {
      list.push(m);
      messagesByChat.set(m.chat_id, list);
    }
    if (m.chat_id === currentChatId) {
      appendMessage(m);
      markRead(m.chat_id);
    } else {
      const chat = chatById(m.chat_id);
      if (chat && m.sender_id !== me.id) chat.unread = (chat.unread || 0) + 1;
      refreshChats();
    }
    const t = typingTimers.get(m.chat_id);
    if (t) { clearTimeout(t); typingTimers.delete(m.chat_id); }
    if (m.chat_id === currentChatId) updateTypingBar();
  });

  socket.on('typing', ({ chat_id, user_id, typing }) => {
    if (user_id === me.id) return;
    const key = chat_id;
    const prev = typingTimers.get(key);
    if (prev) clearTimeout(prev);
    if (typing) {
      typingTimers.set(key, setTimeout(() => { typingTimers.delete(key); updateTypingBar(); }, 3000));
    }
    if (chat_id === currentChatId) updateTypingBar();
  });

  socket.on('chat:new', () => refreshChats());

  /* --- realtime соцсети (v3) --- */

  socket.on('post:new', ({ post }) => {
    if (!post || feedPosts.some(p => p.id === post.id)) return;
    if (feedLoaded && feedMode.kind === 'all') {
      feedPosts.unshift(post);
      renderFeed();
    }
    if (clipsLoaded && post.type === 'clip' && !clipsPosts.some(p => p.id === post.id)) {
      clipsPosts.unshift(post);
      renderClips();
    }
    if (videosLoaded && post.type === 'video' && !videosPosts.some(p => p.id === post.id)) {
      videosPosts.unshift(post);
      renderVideos();
    }
    const what = post.type === 'clip' ? 'новый клип 🎬' : post.type === 'video' ? 'новое видео 📹' : 'новый пост ✍️';
    toast(`${post.author.display_name}: ${what}`, () => showPage('feed'));
  });

  socket.on('post:stats', ({ post_id, likes, comments_count }) => {
    for (const list of [feedPosts, profileState.posts, clipsPosts, videosPosts]) {
      const p = list.find(x => x.id === post_id);
      if (!p) continue;
      if (likes !== undefined) p.likes = likes;
      if (comments_count !== undefined) p.comments_count = comments_count;
    }
    updatePostCounters(post_id);
  });

  socket.on('comment:new', ({ post_id, comment }) => {
    document.querySelectorAll(`.post-card[data-post-id="${post_id}"] .post-comments:not(.hidden)`).forEach(block => {
      if (block.querySelector(`.comment-row[data-comment-id="${comment.id}"]`)) return;
      block.querySelector('.comment-input-row')?.before(commentRow(comment));
    });
    if (Number($('#comments-count').dataset.postId) === post_id && !$('#comments-modal').classList.contains('hidden')) {
      const list = $('#comments-list');
      if (!list.querySelector(`.comment-row[data-comment-id="${comment.id}"]`)) {
        list.querySelector('.empty-note')?.remove();
        list.appendChild(commentRow(comment));
      }
    }
  });

  socket.on('notification', ({ notification, unread }) => {
    if (notification.user_id !== me.id) return; // адресность (важно в локальном режиме)
    setNotifBadge(unread);
    const text = notification.type === 'like'
      ? `❤️ ${notification.actor_name} лайкнул(а) вашу публикацию`
      : `💬 ${notification.actor_name} прокомментировал(а)`;
    toast(text, () => openNotifications());
  });
}

function updateTypingBar() {
  const bar = $('#typing-bar');
  if (currentChatId && typingTimers.has(currentChatId)) {
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

/* =====================================================================
   Соцсеть: лента
   ===================================================================== */

async function loadFeed({ reset = false } = {}) {
  const before = reset ? 0 : feedPosts.at(-1)?.id || 0;
  let url;
  if (feedMode.kind === 'tag') {
    url = `/api/feed?tag=${encodeURIComponent(feedMode.value)}&limit=20${before ? `&before=${before}` : ''}`;
  } else if (feedMode.kind === 'search') {
    url = `/api/search?q=${encodeURIComponent(feedMode.value)}&limit=30`;
  } else {
    url = `/api/feed?limit=20${before ? `&before=${before}` : ''}`;
  }
  const { posts } = await api(url);
  if (reset) feedPosts = [];
  for (const p of posts) { // страховка от дублей при гонке сокета и REST-ответа
    if (!feedPosts.some(x => x.id === p.id)) feedPosts.push(p);
  }
  feedLoaded = true;
  feedExhausted = posts.length < 20 && feedMode.kind !== 'search';
  renderFeed();
}

function renderFeed() {
  const box = $('#feed');
  box.replaceChildren();
  for (const p of feedPosts) box.appendChild(postCardEl(p));
  $('#feed-more').classList.toggle('hidden', feedExhausted || feedPosts.length === 0);
  $('#feed-empty').classList.toggle('hidden', feedPosts.length !== 0);
  $('#feed-empty').textContent = feedMode.kind === 'tag'
    ? 'Постов с этим хэштегом пока нет'
    : feedMode.kind === 'search' ? 'Ничего не найдено' : 'Пока пусто — будь первым, кто напишет пост!';
  const special = feedMode.kind !== 'all';
  $('#feed-head').classList.toggle('hidden', !special);
  $('#composer-card').classList.toggle('hidden', special);
  if (special) {
    $('#feed-title').textContent = feedMode.kind === 'tag' ? `#${feedMode.value}` : `Поиск: «${feedMode.value}»`;
  }
  observePostViews(box);
}

function clearFeedMode() {
  feedMode = { kind: 'all', value: null };
  $('#feed-search').value = '';
  loadFeed({ reset: true });
}

/* боковая панель ленты: тренды, кто онлайн */
let feedSideLoaded = false;

async function loadFeedSide() {
  try {
    const [{ trends }, { users }] = await Promise.all([api('/api/trends'), api('/api/users')]);
    for (const u of users) {
      const cached = usersCache.get(u.id);
      if (cached) cached.online = u.online;
    }
    renderTrends(trends);
    renderOnline(users.filter(u => u.online && u.id !== me.id));
    feedSideLoaded = true;
  } catch { /* панель не критична */ }
}

function renderTrends(trends) {
  const box = $('#trends-list');
  box.replaceChildren();
  if (!trends.length) {
    const hint = document.createElement('div');
    hint.className = 'side-hint';
    hint.textContent = 'Добавь #хэштег в пост — и он появится здесь';
    box.appendChild(hint);
    return;
  }
  for (const t of trends) {
    const row = document.createElement('div');
    row.className = 'trend-row';
    const tag = document.createElement('span');
    tag.className = 'trend-tag';
    tag.textContent = '#' + t.tag;
    const cnt = document.createElement('span');
    cnt.className = 'trend-cnt';
    cnt.textContent = formatCount(t.count);
    row.append(tag, cnt);
    row.addEventListener('click', () => {
      feedMode = { kind: 'tag', value: t.tag };
      loadFeed({ reset: true });
    });
    box.appendChild(row);
  }
}

function renderOnline(users) {
  const box = $('#online-list');
  box.replaceChildren();
  if (!users.length) {
    const hint = document.createElement('div');
    hint.className = 'side-hint';
    hint.textContent = 'Сейчас все офлайн';
    box.appendChild(hint);
    return;
  }
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'online-row';
    const av = avatarEl(u, true);
    const nm = document.createElement('span');
    nm.textContent = u.display_name;
    row.append(av, nm);
    row.addEventListener('click', () => openProfile(u.id));
    box.appendChild(row);
  }
}

$('#feed-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const q = $('#feed-search').value.trim();
  if (!q) return;
  feedMode = { kind: 'search', value: q };
  loadFeed({ reset: true });
});

$('#feed-clear').addEventListener('click', clearFeedMode);

/* композер поста */
let pendingPostMedia = null; // {url, kind}

$('#post-file').addEventListener('change', async () => {
  const file = $('#post-file').files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { alert('Картинка должна быть не больше 10 МБ'); $('#post-file').value = ''; return; }
  const box = $('#composer-media');
  box.classList.remove('hidden');
  box.replaceChildren('Загрузка…');
  try {
    const up = await uploadFile(file);
    pendingPostMedia = { url: up.url, kind: up.kind };
    renderViralMeter();
    box.replaceChildren();
    const img = document.createElement('img');
    img.src = up.url;
    img.alt = '';
    box.appendChild(img);
    const rm = document.createElement('button');
    rm.className = 'ghost-btn media-remove';
    rm.textContent = 'Убрать изображение';
    rm.addEventListener('click', () => {
      pendingPostMedia = null;
      $('#post-file').value = '';
      box.classList.add('hidden');
      box.replaceChildren();
    });
    box.appendChild(rm);
  } catch (err) {
    box.classList.add('hidden');
    $('#post-file').value = '';
    alert(err.message);
  }
});

$('#post-submit').addEventListener('click', async () => {
  const text = $('#post-text').value.trim();
  if (!text && !pendingPostMedia) { alert('Напишите текст или добавьте изображение'); return; }
  const btn = $('#post-submit');
  btn.disabled = true;
  try {
    const { post } = await api('/api/posts', {
      method: 'POST',
      body: { type: 'post', text, media: pendingPostMedia?.url || null },
    });
    $('#post-text').value = '';
    pendingPostMedia = null;
    $('#post-file').value = '';
    $('#composer-media').classList.add('hidden');
    $('#composer-media').replaceChildren();
    $('#viral-meter').classList.add('hidden');
    // сокет-событие post:new могло прийти раньше ответа — не дублируем
    if (!feedPosts.some(p => p.id === post.id)) feedPosts.unshift(post);
    renderFeed();
    loadFeedSide(); // тренды могли пополниться новым хэштегом
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

$('#btn-feed-more').addEventListener('click', () => loadFeed());

/* =====================================================================
   🔥 Вирусометр Floop — уникальная фишка BLOOP
   Оценивает пост ДО публикации (по правилам, без нейросети) и показывает
   «пульс» публикации ПОСЛЕ — как быстро она набирает лайки и просмотры.
   ===================================================================== */

function viralityScore({ text, mediaKind }) {
  const t = String(text || '');
  const len = t.length;
  const tagCount = (t.match(/#([\p{L}\p{N}_]{2,30})/gu) || []).length;
  let score = 25;
  const good = [], tips = [], bad = [];

  if (len >= 60 && len <= 220) { score += 18; good.push('Длина 60–220 символов — пост дочитывают до конца'); }
  else if (len > 0 && len < 60) tips.push('Добавь ещё 1–2 предложения: совсем короткие посты пролетают мимо');
  else if (len > 400) { score -= 8; bad.push('Слишком длинно — сократи до сути'); }

  if (/\?/.test(t)) { score += 12; good.push('Вопрос в тексте провоцирует комментарии'); }
  else tips.push('Задай вопрос читателям — так пост собирает обсуждение');

  if (tagCount >= 1 && tagCount <= 3) { score += 15; good.push('1–3 хэштега — оптимально для трендов'); }
  else if (tagCount > 5) { score -= 10; bad.push('Больше 5 хэштегов выглядит как спам'); }
  else if (len) tips.push('Добавь 1–3 хэштега — попадёшь в тренды недели');

  if (mediaKind === 'video') { score += 16; good.push('Видео удерживает внимание дольше всего'); }
  else if (mediaKind === 'image') { score += 10; good.push('Картинка ускоряет чтение поста'); }

  const emoji = (t.match(/\p{Extended_Pictographic}/gu) || []).length;
  if (emoji >= 1 && emoji <= 3) { score += 8; good.push('Пара эмодзи оживляет текст'); }
  else if (emoji > 6) { score -= 6; bad.push('Много эмодзи снижает доверие'); }

  const letters = t.replace(/[^A-Za-zА-Яа-яЁё]/g, '');
  if (letters.length > 12 && letters === letters.toUpperCase()) { score -= 15; bad.push('КАПС читается как крик — снизь тон'); }

  const h = new Date().getHours();
  if ((h >= 11 && h < 14) || (h >= 18 && h < 23)) { score += 10; good.push('Сейчас пиковая активность в ленте'); }
  else tips.push('Пик ленты: 11:00–13:00 и 18:00–22:00 — публикуй в это время');

  return {
    score: Math.max(5, Math.min(100, Math.round(score))),
    advice: [...bad, ...tips.slice(0, 1), ...good.slice(0, 2)].slice(0, 3),
  };
}

function renderViralMeter() {
  const text = $('#post-text').value.trim();
  const meter = $('#viral-meter');
  if (!text && !pendingPostMedia) { meter.classList.add('hidden'); return; }
  meter.classList.remove('hidden');
  const { score, advice } = viralityScore({ text, mediaKind: pendingPostMedia?.kind || null });
  $('#vm-score').textContent = `${score}/100`;
  $('#vm-score').dataset.level = score >= 70 ? 'hot' : score >= 45 ? 'warm' : 'cold';
  const fill = $('#vm-fill');
  fill.style.width = `${score}%`;
  fill.dataset.level = score >= 70 ? 'hot' : score >= 45 ? 'warm' : 'cold';
  const tips = $('#vm-tips');
  tips.replaceChildren();
  for (const a of advice) {
    const row = document.createElement('div');
    row.className = 'vm-tip';
    row.textContent = (a === advice[0] && (advice[0].startsWith('Добавь') || advice[0].startsWith('Задай') || advice[0].startsWith('Слишком') || advice[0].startsWith('Больше') || advice[0].startsWith('КАПС') || advice[0].startsWith('Много')) ? '💡 ' : '✅ ') + a;
    tips.appendChild(row);
  }
}

$('#post-text').addEventListener('input', renderViralMeter);

/* Пульс публикации: динамика лайков и просмотров в первые 48 часов */
function pulseBadge(p) {
  const ageH = (Date.now() - new Date(p.created_at + 'Z').getTime()) / 3600000;
  if (ageH > 48 || !p.views) return null;
  const engagement = (p.likes || 0) + 2 * (p.comments_count || 0);
  const perHour = engagement / Math.max(ageH, 0.5);
  if (perHour >= 1.5 && p.views >= 5) return { cls: 'hot', label: '🔥 Горит' };
  if (perHour >= 0.5) return { cls: 'warm', label: '📈 Набирает обороты' };
  if (perHour >= 0.2 && p.views >= 3) return { cls: 'fresh', label: '🌱 Растёт' };
  return null;
}

/* просмотры ленты */
const viewObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const id = Number(e.target.dataset.postId);
    if (!id || viewedPosts.has(id)) continue;
    viewedPosts.add(id);
    api(`/api/posts/${id}/view`, { method: 'POST' })
      .then(({ views }) => {
        const label = e.target.querySelector('.post-views .n');
        if (label) label.textContent = formatCount(views);
        const inFeed = feedPosts.find(p => p.id === id);
        if (inFeed) inFeed.views = views;
      }).catch(() => {});
  }
}, { threshold: 0.5 });

function observePostViews(scope) {
  scope.querySelectorAll('.post-card[data-post-id]').forEach(el => viewObserver.observe(el));
}

/* ---------- карточка публикации (лента, профиль) ---------- */

function postCardEl(p) {
  const card = document.createElement('article');
  card.className = 'post-card';
  card.dataset.postId = p.id;

  const head = document.createElement('div');
  head.className = 'post-head';
  const av = avatarEl(p.author);
  av.querySelector('.dot').remove();
  const who = document.createElement('div');
  who.className = 'post-who';
  const nameEl = document.createElement('div');
  nameEl.className = 'p-name';
  nameEl.textContent = p.author.display_name;
  const timeEl = document.createElement('div');
  timeEl.className = 'p-time';
  timeEl.textContent = timeAgo(p.created_at);
  who.append(nameEl, timeEl);
  who.addEventListener('click', () => openProfile(p.author.id));
  head.append(av, who);
  const pulse = pulseBadge(p);
  if (pulse) {
    const badge = document.createElement('span');
    badge.className = `pulse-badge ${pulse.cls}`;
    badge.title = 'Пульс публикации по Вирусометру Floop';
    badge.textContent = pulse.label;
    head.appendChild(badge);
  }

  if (p.author.id === me.id) {
    const del = document.createElement('button');
    del.className = 'icon-btn post-del';
    del.title = 'Удалить публикацию';
    del.innerHTML = SVG_TRASH;
    del.addEventListener('click', async () => {
      if (!confirm('Удалить публикацию?')) return;
      try {
        await api(`/api/posts/${p.id}`, { method: 'DELETE' });
        feedPosts = feedPosts.filter(x => x.id !== p.id);
        profileState.posts = profileState.posts.filter(x => x.id !== p.id);
        if (currentPage === 'feed') renderFeed();
        if (currentPage === 'profile' && profileState.userId === me.id) renderProfileContent();
      } catch (err) { alert(err.message); }
    });
    head.appendChild(del);
  }
  card.appendChild(head);

  if (p.text) {
    const text = document.createElement('div');
    text.className = 'post-text';
    text.textContent = p.text;
    card.appendChild(text);
  }

  if (p.media && p.type === 'post') {
    const media = document.createElement('div');
    media.className = 'post-media';
    const img = document.createElement('img');
    img.src = p.media;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(p.media, '_blank'));
    media.appendChild(img);
    card.appendChild(media);
  }

  if (p.media && p.type === 'video') {
    const media = document.createElement('div');
    media.className = 'post-media';
    const v = document.createElement('video');
    v.src = p.media;
    v.controls = true;
    v.preload = 'metadata';
    v.playsInline = true;
    media.appendChild(v);
    card.appendChild(media);
  }

  const foot = document.createElement('div');
  foot.className = 'post-foot';

  const like = document.createElement('button');
  like.className = 'pbtn like-btn' + (p.liked_by_me ? ' liked' : '');
  like.innerHTML = `${SVG_HEART}<span class="n">${formatCount(p.likes)}</span>`;
  like.addEventListener('click', async () => {
    try {
      const r = await api(`/api/posts/${p.id}/like`, { method: 'POST' });
      p.liked_by_me = r.liked;
      p.likes = r.likes;
      like.classList.toggle('liked', r.liked);
      like.querySelector('.n').textContent = formatCount(r.likes);
    } catch (err) { alert(err.message); }
  });
  foot.appendChild(like);

  const cbtn = document.createElement('button');
  cbtn.className = 'pbtn comments-btn';
  cbtn.innerHTML = `${SVG_COMMENT}<span class="n">${formatCount(p.comments_count)}</span>`;
  const cblock = document.createElement('div');
  cblock.className = 'post-comments hidden';
  let commentsOpened = false;
  cbtn.addEventListener('click', async () => {
    commentsOpened = !commentsOpened;
    cblock.classList.toggle('hidden', !commentsOpened);
    if (commentsOpened && !cblock.dataset.loaded) {
      cblock.dataset.loaded = '1';
      await renderCommentsInto(cblock, p.id, p);
      observePostViews(card); // переслеживаем после DOM-изменений
    }
  });
  foot.appendChild(cbtn);

  const views = document.createElement('span');
  views.className = 'post-views';
  views.innerHTML = `${SVG_EYE}<span class="n">${formatCount(p.views)}</span>`;
  foot.appendChild(views);

  card.append(foot, cblock);
  return card;
}

/* комментарии (в карточках и модалках) */
async function renderCommentsInto(container, postId, postRef) {
  container.replaceChildren('Загрузка…');
  try {
    const { comments } = await api(`/api/posts/${postId}/comments`);
    container.replaceChildren();
    if (comments.length === 0) {
      const none = document.createElement('div');
      none.className = 'empty-note';
      none.textContent = 'Комментариев пока нет';
      container.appendChild(none);
    }
    for (const c of comments) container.appendChild(commentRow(c));

    const row = document.createElement('div');
    row.className = 'comment-input-row';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'Ваш комментарий…';
    inp.maxLength = 1000;
    const send = document.createElement('button');
    send.className = 'send-btn';
    send.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M2.7 11.2 20.9 3.4c.8-.3 1.6.4 1.3 1.3l-6 18.2c-.3.9-1.5.9-1.9.1l-3.4-7-7.3-3.1c-.9-.4-.9-1.5.1-1.7z"/></svg>';
    const submit = async () => {
      const text = inp.value.trim();
      if (!text) return;
      inp.value = '';
      try {
        const { comment } = await api(`/api/posts/${postId}/comments`, { method: 'POST', body: { text } });
        container.querySelector('.empty-note')?.remove();
        row.before(commentRow(comment));
        bumpCommentsCount(postId);
        const card = container.closest('.post-card');
        const n = card?.querySelector('.comments-btn .n');
        if (n && postRef) n.textContent = formatCount(postRef.comments_count);
      } catch (err) { alert(err.message); }
    };
    send.addEventListener('click', submit);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    row.append(inp, send);
    container.appendChild(row);
  } catch (err) {
    container.replaceChildren(err.message);
  }
}

function commentRow(c) {
  const row = document.createElement('div');
  row.className = 'comment-row';
  row.dataset.commentId = c.id;
  const av = avatarEl(c, true);
  av.querySelector('.dot').remove();
  const body = document.createElement('div');
  body.className = 'comment-body';
  const nameEl = document.createElement('span');
  nameEl.className = 'c-name';
  nameEl.textContent = c.display_name;
  nameEl.addEventListener('click', () => openProfile(c.author_id));
  const timeEl = document.createElement('span');
  timeEl.className = 'c-time';
  timeEl.textContent = timeAgo(c.created_at);
  const textEl = document.createElement('div');
  textEl.textContent = c.text;
  body.append(nameEl, timeEl, textEl);
  row.append(av, body);
  return row;
}

function bumpCommentsCount(postId) {
  const lists = [feedPosts, profileState.posts, clipsPosts, videosPosts];
  for (const list of lists) {
    const p = list.find(x => x.id === postId);
    if (p) p.comments_count = (p.comments_count || 0) + 1;
  }
  const modalN = $('#comments-count');
  if (Number(modalN.dataset.postId) === postId) {
    modalN.textContent = formatCount((Number(modalN.textContent.replace(/\D/g, '')) || 0) + 1);
  }
}

/* =====================================================================
   Соцсеть: клипы
   ===================================================================== */

const clipObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const v = e.target.querySelector('video');
    if (!v) continue;
    if (e.isIntersecting && e.intersectionRatio >= 0.6) {
      if (v.paused) v.play().catch(() => {});
      const id = Number(e.target.dataset.postId);
      if (id && !viewedPosts.has(id)) {
        viewedPosts.add(id);
        api(`/api/posts/${id}/view`, { method: 'POST' }).then(({ views }) => {
          const p = clipsPosts.find(x => x.id === id);
          if (p) p.views = views;
          const n = e.target.querySelector('[data-views]');
          if (n) n.textContent = formatCount(views);
        }).catch(() => {});
      }
    } else {
      v.pause();
    }
  }
}, { threshold: [0, 0.6] });

async function loadClips({ reset = false } = {}) {
  const before = reset ? 0 : clipsPosts.at(-1)?.id || 0;
  const { posts } = await api(`/api/feed?type=clip&limit=20${before ? `&before=${before}` : ''}`);
  if (reset) clipsPosts = [];
  clipsPosts.push(...posts);
  clipsLoaded = true;
  renderClips();
}

function renderClips() {
  const box = $('#clips-feed');
  box.replaceChildren();
  for (const p of clipsPosts) box.appendChild(clipSlideEl(p));
  $('#clips-empty').classList.toggle('hidden', clipsPosts.length !== 0);
  box.querySelectorAll('.clip-slide').forEach(el => clipObserver.observe(el));
}

function pauseAllClips() {
  document.querySelectorAll('.clip-slide video').forEach(v => v.pause());
}

function clipSlideEl(p) {
  const slide = document.createElement('div');
  slide.className = 'clip-slide';
  slide.dataset.postId = p.id;

  const v = document.createElement('video');
  v.src = p.media;
  v.loop = true;
  v.muted = true;
  v.playsInline = true;
  v.addEventListener('click', () => {
    if (v.paused) v.play().catch(() => {}); else v.pause();
  });
  slide.appendChild(v);

  const overlay = document.createElement('div');
  overlay.className = 'clip-overlay';

  const author = document.createElement('div');
  author.className = 'clip-author';
  const av = avatarEl(p.author, true);
  av.querySelector('.dot').remove();
  const aname = document.createElement('span');
  aname.textContent = p.author.display_name;
  author.append(av, aname);
  author.addEventListener('click', () => openProfile(p.author.id));
  overlay.appendChild(author);

  if (p.text) {
    const cap = document.createElement('div');
    cap.className = 'clip-caption';
    cap.textContent = p.text;
    overlay.appendChild(cap);
  }

  slide.appendChild(overlay);

  const actions = document.createElement('div');
  actions.className = 'clip-actions';

  const like = document.createElement('button');
  like.className = 'clip-action' + (p.liked_by_me ? ' liked' : '');
  like.innerHTML = SVG_HEART;
  like.title = 'Нравится';
  like.addEventListener('click', async () => {
    try {
      const r = await api(`/api/posts/${p.id}/like`, { method: 'POST' });
      p.liked_by_me = r.liked;
      p.likes = r.likes;
      like.classList.toggle('liked', r.liked);
      likeN.textContent = formatCount(r.likes);
    } catch (err) { alert(err.message); }
  });
  const likeN = document.createElement('div');
  likeN.className = 'clip-count';
  likeN.textContent = formatCount(p.likes);
  actions.append(like, likeN);

  const cm = document.createElement('button');
  cm.className = 'clip-action';
  cm.innerHTML = SVG_COMMENT;
  cm.title = 'Комментарии';
  cm.addEventListener('click', () => openCommentsModal(p.id));
  const cmN = document.createElement('div');
  cmN.className = 'clip-count';
  cmN.textContent = formatCount(p.comments_count);
  actions.append(cm, cmN);

  const eye = document.createElement('button');
  eye.className = 'clip-action';
  eye.innerHTML = SVG_EYE;
  eye.title = 'Просмотры';
  const eyeN = document.createElement('div');
  eyeN.className = 'clip-count';
  eyeN.dataset.views = '1';
  eyeN.textContent = formatCount(p.views);
  actions.append(eye, eyeN);

  const sound = document.createElement('button');
  sound.className = 'clip-action';
  sound.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';
  sound.title = 'Включить звук';
  sound.addEventListener('click', () => {
    v.muted = !v.muted;
    sound.style.color = v.muted ? '' : 'var(--accent)';
  });
  actions.append(sound);

  slide.appendChild(actions);
  return slide;
}

/* =====================================================================
   Соцсеть: видео
   ===================================================================== */

async function loadVideos({ reset = false } = {}) {
  const before = reset ? 0 : videosPosts.at(-1)?.id || 0;
  const { posts } = await api(`/api/feed?type=video&limit=30${before ? `&before=${before}` : ''}`);
  if (reset) videosPosts = [];
  videosPosts.push(...posts);
  videosLoaded = true;
  renderVideos();
}

function renderVideos() {
  const box = $('#videos-grid');
  box.replaceChildren();
  for (const p of videosPosts) box.appendChild(videoCardItem(p));
  $('#videos-empty').classList.toggle('hidden', videosPosts.length !== 0);
}

function videoCardItem(p) {
  const item = document.createElement('div');
  item.className = 'video-card-item';
  const thumb = document.createElement('div');
  thumb.className = 'video-thumb';
  const v = document.createElement('video');
  v.src = p.media;
  v.muted = true;
  v.preload = 'metadata';
  v.playsInline = true;
  thumb.appendChild(v);
  const dur = document.createElement('span');
  dur.className = 'video-duration';
  dur.textContent = formatDuration(p.duration);
  thumb.appendChild(dur);
  item.appendChild(thumb);

  const title = document.createElement('div');
  title.className = 'vi-title';
  title.textContent = p.text || 'Без описания';
  const meta = document.createElement('div');
  meta.className = 'vi-meta';
  meta.textContent = `${p.author.display_name} · ${formatCount(p.views)} просмотров`;
  item.append(title, meta);
  item.addEventListener('click', () => openVideoModal(p));
  return item;
}

function openVideoModal(p) {
  videoModalPost = p;
  const player = $('#video-player');
  player.src = p.media;
  const info = $('#video-info');
  info.replaceChildren();

  const title = document.createElement('div');
  title.textContent = p.text || 'Без описания';
  title.style.fontWeight = '700';
  info.appendChild(title);

  const author = document.createElement('div');
  author.className = 'vi-author';
  const av = avatarEl(p.author, true);
  av.querySelector('.dot').remove();
  const an = document.createElement('span');
  an.textContent = p.author.display_name;
  author.append(av, an);
  author.addEventListener('click', () => {
    closeVideoModal();
    openProfile(p.author.id);
  });
  info.appendChild(author);

  const row = document.createElement('div');
  row.className = 'vi-row';
  const like = document.createElement('button');
  like.className = 'pbtn' + (p.liked_by_me ? ' liked' : '');
  like.innerHTML = `${SVG_HEART}<span class="n">${formatCount(p.likes)}</span>`;
  like.addEventListener('click', async () => {
    const r = await api(`/api/posts/${p.id}/like`, { method: 'POST' }).catch(err => { alert(err.message); return null; });
    if (!r) return;
    p.liked_by_me = r.liked;
    p.likes = r.likes;
    like.classList.toggle('liked', r.liked);
    like.querySelector('.n').textContent = formatCount(r.likes);
  });
  const cm = document.createElement('button');
  cm.className = 'pbtn';
  cm.innerHTML = `${SVG_COMMENT}<span class="n">${formatCount(p.comments_count)}</span>`;
  cm.addEventListener('click', () => openCommentsModal(p.id));
  const views = document.createElement('span');
  views.className = 'post-views';
  views.innerHTML = `${SVG_EYE}<span class="n">${formatCount(p.views)}</span>`;
  row.append(like, cm, views);
  info.appendChild(row);

  $('#video-modal').classList.remove('hidden');
  api(`/api/posts/${p.id}/view`, { method: 'POST' }).then(({ views: n }) => {
    p.views = n;
    views.querySelector('.n').textContent = formatCount(n);
  }).catch(() => {});
  player.play().catch(() => {});
}

function closeVideoModal() {
  const player = $('#video-player');
  player.pause();
  player.removeAttribute('src');
  player.load();
  $('#video-modal').classList.add('hidden');
}

$('#video-close').addEventListener('click', closeVideoModal);
$('#video-modal').addEventListener('click', (e) => {
  if (e.target === $('#video-modal')) closeVideoModal();
});

/* =====================================================================
   Модалка загрузки клипа/видео
   ===================================================================== */

function openUploadModal(mode) {
  uploadMode = mode;
  pendingUploadFile = null;
  $('#upload-title').textContent = mode === 'clip' ? 'Новый клип' : 'Новое видео';
  $('#upload-file-label').textContent = 'Выберите видеофайл (MP4, WebM, MOV, до 300 МБ)';
  $('#upload-caption').value = '';
  $('#upload-status').textContent = '';
  $('#upload-file').value = '';
  $('#upload-submit').disabled = false;
  $('#upload-modal').classList.remove('hidden');
}

$('#clips-add').addEventListener('click', () => openUploadModal('clip'));
$('#video-add').addEventListener('click', () => openUploadModal('video'));
$('#upload-cancel').addEventListener('click', () => $('#upload-modal').classList.add('hidden'));

$('#upload-file').addEventListener('change', () => {
  const f = $('#upload-file').files[0];
  pendingUploadFile = f || null;
  $('#upload-file-label').textContent = f ? `Выбрано: ${f.name}` : 'Выберите видеофайл (MP4, WebM, MOV, до 300 МБ)';
});

$('#upload-submit').addEventListener('click', async () => {
  if (!pendingUploadFile) { $('#upload-status').textContent = 'Сначала выберите файл'; return; }
  const btn = $('#upload-submit');
  btn.disabled = true;
  $('#upload-status').textContent = 'Загрузка файла…';
  try {
    const up = await uploadFile(pendingUploadFile);
    $('#upload-status').textContent = 'Публикуем…';
    const duration = await probeDuration(pendingUploadFile);
    const { post } = await api('/api/posts', {
      method: 'POST',
      body: { type: uploadMode, text: $('#upload-caption').value.trim(), media: up.url, duration },
    });
    $('#upload-modal').classList.add('hidden');
    if (uploadMode === 'clip') await loadClips({ reset: true });
    else await loadVideos({ reset: true });
    viewedPosts.add(post.id);
  } catch (err) {
    $('#upload-status').textContent = err.message;
    btn.disabled = false;
  }
});

/* =====================================================================
   Съёмка рилса прямо в приложении (камера + MediaRecorder)
   ===================================================================== */

const camState = {
  stream: null, recorder: null, chunks: [], startedAt: 0,
  timer: null, facing: 'user', blob: null, url: null,
};

async function camStartStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    $('#cam-hint').textContent = 'Камера недоступна в этом браузере';
    return false;
  }
  camState.stream?.getTracks().forEach(t => t.stop());
  try {
    camState.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: camState.facing, width: { ideal: 720 }, height: { ideal: 1280 } },
      audio: true,
    });
  } catch {
    $('#cam-hint').textContent = 'Разрешите доступ к камере и микрофону в настройках';
    return false;
  }
  $('#cam-preview').srcObject = camState.stream;
  $('#cam-hint').classList.add('hidden');
  return true;
}

function camResetResult() {
  if (camState.url) URL.revokeObjectURL(camState.url);
  camState.blob = null;
  camState.url = null;
  $('#cam-result').classList.add('hidden');
  $('#cam-preview').classList.remove('hidden');
  $('#cam-publish').classList.add('hidden');
  $('#cam-record').classList.remove('hidden');
}

async function openCamera() {
  $('#camera-modal').classList.remove('hidden');
  camResetResult();
  await camStartStream();
}

function closeCamera() {
  clearInterval(camState.timer);
  camState.recorder?.state === 'recording' && camState.recorder.stop();
  camState.stream?.getTracks().forEach(t => t.stop());
  $('#camera-modal').classList.add('hidden');
}

$('#upload-record').addEventListener('click', openCamera);
$('#camera-close').addEventListener('click', closeCamera);

$('#cam-flip').addEventListener('click', async () => {
  camState.facing = camState.facing === 'user' ? 'environment' : 'user';
  await camStartStream();
  if (camState.blob) camResetResult();
});

$('#cam-record').addEventListener('click', () => {
  if (!camState.stream) return;
  if (camState.recorder?.state === 'recording') { camState.recorder.stop(); return; }
  camState.chunks = [];
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
    .find(t => MediaRecorder.isTypeSupported?.(t)) || '';
  camState.recorder = new MediaRecorder(camState.stream, mime ? { mimeType: mime } : undefined);
  camState.recorder.ondataavailable = (e) => { if (e.data.size) camState.chunks.push(e.data); };
  camState.recorder.onstop = () => {
    clearInterval(camState.timer);
    camState.blob = new Blob(camState.chunks, { type: camState.recorder.mimeType || 'video/webm' });
    camState.url = URL.createObjectURL(camState.blob);
    $('#cam-preview').classList.add('hidden');
    const res = $('#cam-result');
    res.src = camState.url;
    res.classList.remove('hidden');
    $('#cam-publish').classList.remove('hidden');
    $('#cam-record').classList.add('hidden');
    $('#cam-timer').classList.add('hidden');
  };
  camState.recorder.start();
  camState.startedAt = Date.now();
  $('#cam-timer').classList.remove('hidden');
  camState.timer = setInterval(() => {
    const sec = Math.floor((Date.now() - camState.startedAt) / 1000);
    $('#cam-timer').textContent = `${formatDuration(sec)} / 1:00`;
    if (sec >= 60 && camState.recorder.state === 'recording') camState.recorder.stop(); // максимум 1 минута
  }, 250);
});

$('#cam-publish').addEventListener('click', () => {
  if (!camState.blob) return;
  pendingUploadFile = camState.blob;
  $('#upload-file-label').textContent = `Снято в приложении: ${formatDuration((Date.now() - camState.startedAt) / 1000)} — можно писать описание`;
  $('#upload-file').value = '';
  closeCamera();
  $('#upload-modal').classList.remove('hidden');
  toast('🎬 Рилс снят! Добавь описание и публикуй');
});

/* =====================================================================
   Модалка комментариев
   ===================================================================== */

function openCommentsModal(postId) {
  commentsPostId = postId;
  $('#comments-count').textContent = '';
  $('#comments-count').dataset.postId = postId;
  $('#comment-text').value = '';
  $('#comments-modal').classList.remove('hidden');
  renderCommentsInto($('#comments-list'), postId, null).then(() => {
    const p = [...feedPosts, ...profileState.posts, ...clipsPosts, ...videosPosts].find(x => x.id === postId);
    $('#comments-count').textContent = p ? formatCount(p.comments_count) : '';
  });
}

$('#comments-close').addEventListener('click', () => $('#comments-modal').classList.add('hidden'));
$('#comments-modal').addEventListener('click', (e) => {
  if (e.target === $('#comments-modal')) $('#comments-modal').classList.add('hidden');
});

$('#comment-send').addEventListener('click', () => {
  const text = $('#comment-text').value.trim();
  if (!text || !commentsPostId) return;
  $('#comment-text').value = '';
  api(`/api/posts/${commentsPostId}/comments`, { method: 'POST', body: { text } })
    .then(({ comment }) => {
      const list = $('#comments-list');
      list.querySelector('.empty-note')?.remove();
      list.appendChild(commentRow(comment));
      bumpCommentsCount(commentsPostId);
      const p = [...feedPosts, ...profileState.posts, ...clipsPosts, ...videosPosts].find(x => x.id === commentsPostId);
      $('#comments-count').textContent = p ? formatCount(p.comments_count) : '';
    })
    .catch(err => alert(err.message));
});

/* =====================================================================
   Профиль
   ===================================================================== */

async function openProfile(userId) {
  showPage('profile');
  if (profileState.userId !== userId) {
    profileState = { userId, user: null, counts: null, tab: 'post', posts: [] };
  }
  try {
    const { user, counts, stats } = await api(`/api/users/${userId}`);
    profileState.user = user;
    profileState.counts = counts;
    profileState.stats = stats || { views: 0, likes_received: 0 };
    usersCache.set(user.id, { ...usersCache.get(user.id), ...user });
    renderProfile();
    await switchProfileTab(profileState.tab); // подгружаем контент вкладки сразу
  } catch (err) {
    $('#profile-view').replaceChildren(err.message);
  }
}

function renderProfile() {
  const { user, counts } = profileState;
  const box = $('#profile-view');
  box.replaceChildren();

  const head = document.createElement('div');
  head.className = 'profile-head';
  const av = avatarEl(user);
  av.classList.add('big');
  av.querySelector('.dot').remove();
  const info = document.createElement('div');
  info.className = 'profile-info';
  const nm = document.createElement('div');
  nm.className = 'pr-name';
  nm.textContent = user.display_name;
  const un = document.createElement('div');
  un.className = 'pr-username';
  un.textContent = `@${user.username}`;
  info.append(nm, un);
  if (user.bio) {
    const bio = document.createElement('div');
    bio.className = 'pr-bio';
    bio.textContent = user.bio;
    info.appendChild(bio);
  }
  head.append(av, info);

  const actions = document.createElement('div');
  actions.className = 'profile-actions';
  if (user.id === me.id) {
    const ai = document.createElement('button');
    ai.className = 'ai-open-btn';
    ai.textContent = '🤖 Floop — нейропомощник';
    ai.title = 'Задать вопрос умному помощнику';
    ai.addEventListener('click', openAiModal);
    actions.appendChild(ai);

    const edit = document.createElement('button');
    edit.className = 'primary';
    edit.textContent = 'Редактировать';
    edit.addEventListener('click', openEditModal);
    actions.appendChild(edit);

    const theme = document.createElement('button');
    theme.className = 'ghost-btn';
    theme.textContent = 'Тема';
    theme.addEventListener('click', toggleTheme);
    actions.appendChild(theme);
  } else {
    const write = document.createElement('button');
    write.className = 'primary';
    write.textContent = 'Написать';
    write.addEventListener('click', () => startDirectChat(user));
    actions.appendChild(write);
  }
  head.appendChild(actions);
  box.appendChild(head);

  const countsRow = document.createElement('div');
  countsRow.className = 'profile-counts';
  for (const [key, label] of [['posts', 'публикаций'], ['clips', 'клипов'], ['videos', 'видео']]) {
    const c = document.createElement('div');
    c.className = 'pcount';
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = formatCount(counts[key]);
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = label;
    c.append(n, t);
    c.addEventListener('click', () => switchProfileTab(key));
    countsRow.appendChild(c);
  }
  // статистика (лайки и просмотры всех публикаций)
  for (const [key, label] of [['likes_received', 'лайков'], ['views', 'просмотров']]) {
    const c = document.createElement('div');
    c.className = 'pcount static';
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = formatCount(profileState.stats?.[key] || 0);
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = label;
    c.append(n, t);
    countsRow.appendChild(c);
  }
  box.appendChild(countsRow);

  const tabs = document.createElement('div');
  tabs.className = 'profile-tabs';
  for (const [key, label] of [['post', 'Публикации'], ['clip', 'Клипы'], ['video', 'Видео']]) {
    const b = document.createElement('button');
    b.className = 'ptab' + (profileState.tab === key ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => switchProfileTab(key));
    tabs.appendChild(b);
  }
  box.appendChild(tabs);

  const content = document.createElement('div');
  content.id = 'profile-content';
  box.appendChild(content);
  renderProfileContent();
}

async function switchProfileTab(tab) {
  profileState.tab = tab;
  profileState.posts = [];
  document.querySelectorAll('#profile-view .ptab').forEach(b =>
    b.classList.toggle('active', b.textContent === ({ post: 'Публикации', clip: 'Клипы', video: 'Видео' })[tab])
  );
  const { posts } = await api(`/api/users/${profileState.userId}/posts?limit=30${tab !== 'post' ? `&type=${tab}` : ''}`);
  profileState.posts = posts;
  renderProfileContent();
}

function renderProfileContent() {
  const content = $('#profile-content');
  if (!content) return;
  content.replaceChildren();
  const { posts, tab } = profileState;
  if (posts.length === 0) {
    const none = document.createElement('div');
    none.className = 'empty-note';
    none.textContent = 'Здесь пока ничего нет';
    content.appendChild(none);
    return;
  }
  if (tab === 'video') {
    const grid = document.createElement('div');
    grid.className = 'videos-grid';
    grid.style.padding = '0';
    for (const p of posts) grid.appendChild(videoCardItem(p));
    content.appendChild(grid);
  } else {
    const list = document.createElement('div');
    list.className = 'feed';
    for (const p of posts) list.appendChild(postCardEl(p));
    content.appendChild(list);
    observePostViews(content);
  }
}

/* редактирование профиля */
function openEditModal() {
  $('#edit-name').value = me.display_name;
  $('#edit-bio').value = me.bio || '';
  $('#edit-file').value = '';
  const av = avatarEl(me);
  av.classList.add('big');
  av.querySelector('.dot').remove();
  av.id = 'edit-avatar';
  $('#edit-avatar').replaceWith(av);
  $('#edit-modal').classList.remove('hidden');
}

$('#edit-cancel').addEventListener('click', () => $('#edit-modal').classList.add('hidden'));

$('#edit-file').addEventListener('change', async () => {
  const file = $('#edit-file').files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { alert('Картинка должна быть не больше 10 МБ'); $('#edit-file').value = ''; return; }
  try {
    const fd = new FormData();
    fd.append('file', file);
    const data = await api('/api/me/avatar', { method: 'POST', body: fd });
    me = { ...me, ...data.user };
    const av = avatarEl(me);
    av.classList.add('big');
    av.querySelector('.dot').remove();
    av.id = 'edit-avatar';
    $('#edit-avatar').replaceWith(av);
    renderMyIdentity();
  } catch (err) {
    alert(err.message);
  }
});

$('#edit-save').addEventListener('click', async () => {
  const display_name = $('#edit-name').value.trim();
  const bio = $('#edit-bio').value.trim();
  try {
    const { user } = await api('/api/me', { method: 'PATCH', body: { display_name, bio } });
    me = { ...me, ...user };
    renderMyIdentity();
    $('#edit-modal').classList.add('hidden');
    openProfile(me.id);
  } catch (err) {
    alert(err.message);
  }
});

/* =====================================================================
   Уведомления
   ===================================================================== */

function setNotifBadge(n) {
  notifUnread = n;
  for (const id of ['#nav-notif', '#nav-notif-m']) {
    const b = $(id);
    if (!b) continue;
    b.classList.toggle('hidden', !n);
    b.textContent = n > 99 ? '99+' : (n || '');
  }
}

async function loadNotifCount() {
  try {
    setNotifBadge((await api('/api/notifications')).unread);
  } catch { /* не критично */ }
}

function toast(text, onClick) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  el.addEventListener('click', () => { el.remove(); onClick?.(); });
  box.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function notifRow(n) {
  const row = document.createElement('div');
  row.className = 'notif-row' + (n.is_read ? '' : ' unread');
  const av = avatarEl({ id: n.actor_id, display_name: n.actor_name, avatar: n.actor_avatar }, true);
  av.querySelector('.dot').remove();
  const body = document.createElement('div');
  body.className = 'comment-body';
  const line = document.createElement('div');
  const strong = document.createElement('b');
  strong.textContent = n.actor_name;
  const what = n.type === 'like'
    ? ` лайкнул(а) вашу ${n.post_type === 'clip' ? 'клип' : n.post_type === 'video' ? 'видео' : 'запись'}`
    : ` прокомментировал(а): «${(n.post_text || '').slice(0, 60)}»`;
  line.append(strong, document.createTextNode(what));
  const time = document.createElement('span');
  time.className = 'c-time';
  time.textContent = timeAgo(n.created_at);
  body.append(line, time);
  row.append(av, body);
  row.addEventListener('click', () => {
    $('#notif-modal').classList.add('hidden');
    openProfile(n.actor_id);
  });
  return row;
}

async function openNotifications() {
  $('#notif-modal').classList.remove('hidden');
  const box = $('#notif-list');
  const loading = document.createElement('div');
  loading.className = 'empty-note';
  loading.textContent = 'Загрузка…';
  box.replaceChildren(loading);
  try {
    const { notifications, unread } = await api('/api/notifications');
    setNotifBadge(unread);
    box.replaceChildren();
    if (notifications.length === 0) {
      const none = document.createElement('div');
      none.className = 'empty-note';
      none.textContent = 'Пока нет уведомлений';
      box.appendChild(none);
    }
    for (const n of notifications) box.appendChild(notifRow(n));
  } catch (err) {
    const errEl = document.createElement('div');
    errEl.className = 'empty-note';
    errEl.textContent = err.message;
    box.replaceChildren(errEl);
  }
}

$('#btn-bell').addEventListener('click', openNotifications);
$('#btn-bell-m').addEventListener('click', openNotifications);
$('#notif-close').addEventListener('click', () => $('#notif-modal').classList.add('hidden'));
$('#notif-modal').addEventListener('click', (e) => {
  if (e.target === $('#notif-modal')) $('#notif-modal').classList.add('hidden');
});

$('#notif-read-all').addEventListener('click', async () => {
  try {
    setNotifBadge((await api('/api/notifications/read', { method: 'POST', body: {} })).unread);
    openNotifications();
  } catch { /* ignore */ }
});

/* живые счётчики публикаций (post:stats) */
function updatePostCounters(postId) {
  const p = [...feedPosts, ...profileState.posts, ...clipsPosts, ...videosPosts].find(x => x.id === postId);
  if (!p) return;

  const card = document.querySelector(`.post-card[data-post-id="${postId}"]`);
  if (card) {
    const likeN = card.querySelector('.like-btn .n');
    if (likeN) likeN.textContent = formatCount(p.likes);
    const cN = card.querySelector('.comments-btn .n');
    if (cN) cN.textContent = formatCount(p.comments_count);
  }

  const slide = document.querySelector(`.clip-slide[data-post-id="${postId}"]`);
  if (slide) {
    const likeBtn = [...slide.querySelectorAll('.clip-action')].find(b => b.title === 'Нравится');
    if (likeBtn) likeBtn.classList.toggle('liked', p.liked_by_me);
    const counts = slide.querySelectorAll('.clip-count');
    if (counts.length >= 2) {
      counts[0].textContent = formatCount(p.likes);
      counts[1].textContent = formatCount(p.comments_count);
    }
  }

  if (videoModalPost?.id === postId && !$('#video-modal').classList.contains('hidden')) {
    const ns = document.querySelectorAll('#video-info .vi-row .pbtn .n');
    if (ns[0]) ns[0].textContent = formatCount(p.likes);
    if (ns[1]) ns[1].textContent = formatCount(p.comments_count);
  }
}

/* =====================================================================
   Нейропомощник «Floop»
   ===================================================================== */

const AI_SUGGESTIONS = ['Что ты умеешь?', 'Идея для поста', 'Подпись к фото с дня рождения', 'Хэштеги для клипа'];
try { aiHistory = JSON.parse(localStorage.getItem('bloop_ai_chat') || '[]'); } catch { aiHistory = []; }
if (!Array.isArray(aiHistory)) aiHistory = [];

function aiBubble(role, text) {
  const row = document.createElement('div');
  row.className = 'ai-msg ' + (role === 'user' ? 'mine' : 'ai');
  if (role === 'user') {
    const av = avatarEl(me, true);
    av.querySelector('.dot').remove();
    row.appendChild(av);
  } else {
    const av = document.createElement('span');
    av.className = 'avatar small ai-avatar';
    av.textContent = '🤖';
    row.appendChild(av);
  }
  const bubble = document.createElement('div');
  bubble.className = 'ai-bubble';
  bubble.textContent = text;
  row.appendChild(bubble);
  return row;
}

function renderAiList() {
  const list = $('#ai-list');
  list.replaceChildren();
  if (aiHistory.length === 0) {
    list.appendChild(aiBubble('assistant',
      'Привет! Я Floop — умный помощник BLOOP 🤖\nСпроси что угодно: придумать пост, подпись к клипу, подобрать хэштеги или просто поболтать.'));
    return;
  }
  for (const m of aiHistory) list.appendChild(aiBubble(m.role, m.content));
  list.scrollTop = list.scrollHeight;
}

function renderAiChips() {
  const box = $('#ai-chips');
  box.replaceChildren();
  for (const s of AI_SUGGESTIONS) {
    const chip = document.createElement('button');
    chip.className = 'ai-chip';
    chip.textContent = s;
    chip.addEventListener('click', () => {
      $('#ai-input').value = s;
      sendAiMessage();
    });
    box.appendChild(chip);
  }
}

function openAiModal() {
  $('#ai-modal').classList.remove('hidden');
  renderAiChips();
  renderAiList();
  $('#ai-input').focus();
}

async function sendAiMessage() {
  const text = $('#ai-input').value.trim();
  if (!text || aiBusy) return;
  $('#ai-input').value = '';
  aiHistory.push({ role: 'user', content: text });
  const list = $('#ai-list');
  list.appendChild(aiBubble('user', text));

  aiBusy = true;
  const typing = aiBubble('assistant', '…думаю');
  typing.classList.add('ai-typing');
  list.appendChild(typing);
  list.scrollTop = list.scrollHeight;

  try {
    const { reply } = await api('/api/assistant', { method: 'POST', body: { messages: aiHistory.slice(-20) } });
    typing.remove();
    aiHistory.push({ role: 'assistant', content: reply });
    list.appendChild(aiBubble('assistant', reply));
    list.scrollTop = list.scrollHeight;
  } catch (err) {
    typing.remove();
    list.appendChild(aiBubble('assistant', 'Ой, не получилось ответить: ' + err.message));
  } finally {
    aiBusy = false;
    try { localStorage.setItem('bloop_ai_chat', JSON.stringify(aiHistory.slice(-40))); } catch { /* ignore */ }
  }
}

$('#ai-send').addEventListener('click', sendAiMessage);
$('#ai-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAiMessage(); });
$('#ai-close').addEventListener('click', () => $('#ai-modal').classList.add('hidden'));
$('#ai-modal').addEventListener('click', (e) => {
  if (e.target === $('#ai-modal')) $('#ai-modal').classList.add('hidden');
});

$('#ai-clear').addEventListener('click', () => {
  aiHistory = [];
  try { localStorage.removeItem('bloop_ai_chat'); } catch { /* ignore */ }
  renderAiList();
});

/* =====================================================================
   Тема оформления
   ===================================================================== */

function applyTheme() {
  document.documentElement.classList.toggle('light', localStorage.getItem('bloop_theme') === 'light');
}

function toggleTheme() {
  localStorage.setItem('bloop_theme', localStorage.getItem('bloop_theme') === 'light' ? 'dark' : 'light');
  applyTheme();
}

$('#btn-theme').addEventListener('click', toggleTheme);
applyTheme();

/* ---------- старт ---------- */

(async function init() {
  if (LOCAL_MODE) await window.__BLOOP_LOCAL_READY__; // гидрация медиа из IndexedDB
  if (!token()) return; // остаёмся на экране входа
  try {
    const { user } = await api('/api/me');
    enterApp(user);
  } catch {
    localStorage.removeItem('bloop_token');
  }
})();

