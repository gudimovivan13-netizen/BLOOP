/* BLOOP — клиент мессенджера */

const $ = (sel) => document.querySelector(sel);

const token = () => localStorage.getItem('bloop_token') || '';
let me = null;
let chats = [];
let usersCache = new Map();          // id -> {id, username, display_name, online}
let currentChatId = null;
let messagesByChat = new Map();      // chat_id -> [messages]
let socket = null;
let pendingImage = null;             // dataURL
const typingTimers = new Map();      // chat_id -> timeout id

/* ---------- API ---------- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка ${res.status}`);
    err.status = res.status;
    throw err;
  }
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
  el.textContent = initials(user?.display_name || user?.username);
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

/* ---------- авторизация ---------- */

document.querySelectorAll('.auth-tabs .tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-tabs .tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $('#login-form').classList.toggle('hidden', btn.dataset.tab !== 'login');
    $('#register-form').classList.toggle('hidden', btn.dataset.tab !== 'register');
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

$('#btn-logout').addEventListener('click', () => {
  localStorage.removeItem('bloop_token');
  location.reload();
});

/* ---------- запуск приложения ---------- */

async function enterApp(user) {
  me = user;
  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#my-name').textContent = user.display_name;
  const av = avatarEl(user, true);
  av.querySelector('.dot').remove();
  av.id = 'my-avatar';
  $('#my-avatar').replaceWith(av);

  await refreshUsers();
  await refreshChats();
  connectSocket();
}

async function refreshUsers() {
  const { users } = await api('/api/users');
  usersCache = new Map(users.map(u => [u.id, u]));
}

async function refreshChats() {
  const { chats: list } = await api('/api/chats');
  chats = list;
  renderChatList();
  updateTitle();
}

function updateTitle() {
  const total = chats.reduce((s, c) => s + (c.unread || 0), 0);
  document.title = (total ? `(${total}) ` : '') + 'BLOOP — мессенджер';
}

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
  $('#app').classList.add('show-chat'); // на мобильных открываем чат

  const peer = chat.type === 'direct' ? chat.peer : null;
  const nameEl = $('#chat-name');
  nameEl.textContent = chatTitleOf(chat);

  const cav = avatarEl(peer || { id: id + 1000, display_name: chat.name });
  if (chat.type === 'group') cav.querySelector('.dot').remove();
  cav.id = 'chat-avatar';
  const old = $('#chat-avatar');
  old.replaceWith(cav);

  renderChatStatus(chat);
  updateTypingBar();

  chat.unread = 0;
  renderChatList();
  updateTitle();

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

  if (m.image) {
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

function appendMessage(m) {
  if (m.chat_id !== currentChatId) return;
  const box = $('#messages');
  if (box.querySelector(`.msg[data-id="${m.id}"]`)) return; // уже на экране
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;

  const last = [...box.querySelectorAll('.msg')].pop();
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
  if (!currentChatId || (!text && !pendingImage)) return;
  input.value = '';
  input.style.height = 'auto';
  const image = pendingImage;
  clearPendingImage();
  try {
    const { message } = await api(`/api/chats/${currentChatId}/messages`, {
      method: 'POST',
      body: { text, image },
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
  $('#app').classList.remove('show-chat');
  currentChatId = null;
  $('#chat-view').classList.add('hidden');
  $('#empty-state').classList.remove('hidden');
});

/* ---------- сокет ---------- */

function connectSocket() {
  socket = io({ auth: { token: token() } });

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
}

function updateTypingBar() {
  const bar = $('#typing-bar');
  if (currentChatId && typingTimers.has(currentChatId)) {
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

/* ---------- старт ---------- */

(async function init() {
  if (!token()) return; // остаёмся на экране входа
  try {
    const { user } = await api('/api/me');
    enterApp(user);
  } catch {
    localStorage.removeItem('bloop_token');
  }
})();
