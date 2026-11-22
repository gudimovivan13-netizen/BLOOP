/* =====================================================================
   BLOOP Mini App SDK — подключается к странице мини-аппа.
   Даёт приложению пользователя, состояние бота, отправку данных боту,
   главную кнопку и закрытие. Работает и на сервере, и в локальном
   режиме (через мост в родительское окно).
   ===================================================================== */
(() => {
  'use strict';

  // конфиг бота подмешивается сервером/локальным режимом в страницу
  const bootReady = new Promise((resolve) => {
    let tries = 0;
    const tick = () => {
      if (window.__BMA_BOOT__ && window.__BMA_BOOT__.username) return resolve(window.__BMA_BOOT__);
      if (++tries > 60) return resolve({ username: null }); // 3 секунды и сдаются
      setTimeout(tick, 50);
    };
    tick();
  });

  const token = () => {
    try { return localStorage.getItem('bloop_token') || ''; } catch { return ''; }
  };

  // локальный режим: сервера нет — шлём запросы через родительское окно
  async function localBridge() {
    try {
      if (window.parent && window.parent !== window) {
        const ls = window.parent.__BLOOP_LOCAL__ || (await window.parent.__BLOOP_LOCAL_READY__);
        if (ls) return ls;
      }
    } catch { /* чужой origin — моста нет */ }
    return null;
  }

  async function apiCall(path, { method = 'GET', body } = {}) {
    const ls = await localBridge();
    if (ls) {
      const res = await ls.request(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status >= 400) throw new Error(res.data?.error || `Ошибка ${res.status}`);
      return res.data;
    }
    const res = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
    return data;
  }

  let stateObj = {};
  let userObj = null;

  const BMA = {
    username: null,
    user: null,
    theme: {
      dark: window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true,
      accent: '#7aa2ff',
    },
    state: {
      get(key, def = null) {
        const v = stateObj[String(key)];
        return v === undefined ? def : v;
      },
      keys: () => Object.keys(stateObj),
    },
    async ready(cb) {
      const boot = await bootReady;
      BMA.username = boot.username || null;
      try {
        const me = await apiCall('/api/me');
        // серверное поле display_name -> удобное name (как в ctx бота)
        userObj = me.user ? { ...me.user, name: me.user.display_name } : null;
        BMA.user = userObj;
      } catch { userObj = null; }
      if (BMA.username) {
        try {
          const st = await apiCall(`/api/miniapp/${BMA.username}/state`);
          stateObj = st.state || {};
        } catch { /* бот мог исчезнуть */ }
      }
      if (typeof cb === 'function') cb(BMA);
      return BMA;
    },
    async sendData(data) {
      if (!BMA.username) throw new Error('Мини-апп открыт вне бота');
      const out = await apiCall(`/api/miniapp/${BMA.username}/data`, { method: 'POST', body: { data } });
      stateObj = out.state || stateObj;
      return out;
    },
    async refreshState() {
      if (!BMA.username) return stateObj;
      const st = await apiCall(`/api/miniapp/${BMA.username}/state`);
      stateObj = st.state || stateObj;
      return stateObj;
    },
    close() {
      try { window.parent.postMessage({ type: 'bma:close' }, '*'); } catch { /* noop */ }
    },
  };

  /* главная кнопка — как в Telegram: прилипает к низу мини-аппа */
  let mainBtn = null;
  BMA.setMainButton = (text, onClick) => {
    if (!mainBtn) {
      mainBtn = document.createElement('button');
      mainBtn.id = 'bma-main-btn';
      mainBtn.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;padding:14px;border:0;' +
        'border-radius:16px;font-size:16px;font-weight:700;color:#fff;cursor:pointer;z-index:9;' +
        'background:linear-gradient(135deg,#7aa2ff,#8f6cff);box-shadow:0 10px 24px rgba(0,0,0,.35);';
      document.body.appendChild(mainBtn);
    }
    mainBtn.textContent = String(text || 'Готово').slice(0, 40);
    mainBtn.onclick = onClick || null;
    mainBtn.style.display = 'block';
  };
  BMA.hideMainButton = () => { if (mainBtn) mainBtn.style.display = 'none'; };

  window.BMA = BMA;
})();
