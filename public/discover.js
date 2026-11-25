/* BLOOP 4.7 — автопоиск общего сервера.
   Один и тот же APK скачивают все пользователи; при каждом запуске приложение
   само проверяет справочник публичных серверов (servers.json в репозитории) и,
   если живой сервер нашёлся, подключается к нему: все пользователи одного
   сервера видят друг друга. Адрес руками вводить не нужно.
   Отключить автоподключение можно в настройках («Сервер для друзей»). */
(() => {
  'use strict';

  // Справочник серверов: читаем из репозитория (raw.githubusercontent)
  // и через CDN-зеркало — если одно из них недоступно, сработает другое.
  const REPO_RAW = 'https://raw.githubusercontent.com/gudimovivan13-netizen/BLOOP/main/servers.json';
  const REPO_CDN = 'https://cdn.jsdelivr.net/gh/gudimovivan13-netizen/BLOOP@main/servers.json';
  const LS_SERVER = 'bloop_remote_server'; // выбранный сервер (пишет и ручное подключение)
  const LS_AUTO = 'bloop_autoconnect';     // 'off' — не подключаться автоматически

  // Автономный режим — это APK/страница без сервера (config.mode = 'local').
  // На странице самого сервера mode = 'server' и искать нечего.
  const mode = window.BLOOP_CONFIG?.mode || 'server';
  if (mode === 'server') {
    window.__BLOOP_DISCOVERY__ = { status: 'server', server: null, checked: [] };
    return;
  }

  const autoOff = () => {
    try { return localStorage.getItem(LS_AUTO) === 'off'; } catch { return false; }
  };

  const state = { status: 'idle', server: null, checked: [] };
  window.__BLOOP_DISCOVERY__ = state;

  const withTimeout = (ms) => {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => ctrl && ctrl.abort(), ms);
    return { signal: ctrl && ctrl.signal, done: () => clearTimeout(t) };
  };

  /* Проверка, что по адресу живёт именно BLOOP-сервер (а не случайный сайт). */
  async function probe(url, ms = 5000) {
    const to = withTimeout(ms);
    try {
      const r = await fetch(url.replace(/\/+$/, '') + '/api/health?ts=' + Date.now(), { signal: to.signal });
      const j = await r.json();
      return j && j.ok && j.name === 'BLOOP' ? j : null;
    } catch { return null; } finally { to.done(); }
  }

  function connect(url) {
    state.status = 'found';
    state.server = url;
    try { localStorage.setItem(LS_SERVER, url); } catch { /* не критично */ }
    setTimeout(() => { location.href = url + '/'; }, 600);
  }

  /* Поиск сервера: сохранённый с прошлого запуска → справочник из репозитория. */
  async function discover() {
    state.status = 'searching';
    state.checked = [];

    let saved = '';
    try { saved = localStorage.getItem(LS_SERVER) || ''; } catch { /* нет localStorage */ }
    if (saved) {
      const h = await probe(saved);
      state.checked.push({ url: saved, live: !!h });
      if (h) return connect(saved);
      try { localStorage.removeItem(LS_SERVER); } catch { /* не критично */ }
    }
    if (autoOff()) { state.status = 'manual'; return null; }

    let servers = [];
    for (const src of [REPO_RAW, REPO_CDN]) {
      const to = withTimeout(6000);
      try {
        const r = await fetch(src + '?ts=' + Date.now(), { signal: to.signal });
        const j = await r.json();
        if (Array.isArray(j?.servers) && j.servers.length) { servers = j.servers; break; }
      } catch { /* пробуем следующее зеркало */ } finally { to.done(); }
    }

    const probes = await Promise.all(servers.map(async (s) => {
      if (!s?.url) return null;
      const h = await probe(s.url);
      state.checked.push({ url: s.url, name: s.name || '', live: !!h });
      return h ? s : null;
    }));
    const found = probes.find(Boolean);
    if (found) return connect(found.url);
    state.status = 'none';
    return null;
  }

  window.__BLOOP_FIND_SERVER__ = discover; // кнопка «Найти сервер» в настройках

  // Тихий автопоиск при каждом запуске автономного приложения.
  if (!autoOff()) discover();
})();
