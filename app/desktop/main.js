/* BLOOP Desktop — обёртка Electron: настоящее окно приложения вместо вкладки
   браузера. Внутри запускается тот же сервер (server-bundle.mjs) на свободном
   порту, данные лежат рядом с exe (или в %APPDATA%/BLOOP при portable). */
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { fork } = require('child_process');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

// Ресурсы сборки: в упакованном приложении — resources/, в dev-режиме — рядом.
const RES = fs.existsSync(path.join(process.resourcesPath || '', 'server-bundle.mjs'))
  ? process.resourcesPath
  : __dirname;

// Портативная сборка задаёт PORTABLE_EXECUTABLE_DIR — папку рядом с exe.
// Старый exe (SEA) создавал data в той же папке, поэтому старые данные
// (аккаунты, чаты) подхватятся автоматически.
function resolveDataRoot() {
  const portable = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portable) {
    try {
      fs.accessSync(portable, fs.constants.W_OK);
      return portable;
    } catch { /* папка только для чтения — fallback ниже */ }
  }
  return app.getPath('userData');
}

const DATA_ROOT = path.join(resolveDataRoot(), 'data');

if (!app.requestSingleInstanceLock()) {
  // Второй экземпляр: BLOOP уже запущен.
  app.quit();
} else {
  let server = null;
  let win = null;
  let port = 0;
  let booted = false;

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  function freePort(preferred) {
    return new Promise((resolve, reject) => {
      const probe = (p) => {
        const srv = net.createServer();
        srv.once('error', () => (p === preferred ? probe(0) : reject(new Error('Нет свободного порта'))));
        srv.once('listening', () => srv.close(() => resolve(p)));
        srv.listen(p, '127.0.0.1');
      };
      probe(preferred);
    });
  }

  function startServer(useSqliteFlag) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const child = fork(path.join(RES, 'server-bundle.mjs'), [], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          PORT: String(port),
          BLOOP_DATA_DIR: DATA_ROOT,
          NODE_ENV: 'production',
        },
        execArgv: useSqliteFlag ? ['--experimental-sqlite'] : [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.once('exit', (code, signal) => {
        if (settled) { // сервер упал уже после запуска окна
          dialog.showErrorBox('BLOOP', `Встроенный сервер остановился (код ${code}).\nПриложение закроется.`);
          if (win) win.destroy();
          app.quit();
          return;
        }
        settled = true;
        reject(new Error(`Сервер завершился (код ${code}, ${signal}).\n${stderr.slice(-2000)}`));
      });
      const started = Date.now();
      const poll = () => {
        if (settled) return;
        const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
          res.resume();
          settled = true;
          resolve(child);
        });
        req.on('error', () => {
          if (Date.now() - started > 20000) {
            settled = true;
            reject(new Error(`Сервер не ответил за 20 с.\n${stderr.slice(-2000)}`));
          } else setTimeout(poll, 250);
        });
        req.on('timeout', () => req.destroy());
      };
      setTimeout(poll, 300);
    });
  }

  async function boot() {
    port = await freePort(3000);
    try {
      server = await startServer(false);
    } catch (e) {
      // Старые Electron/Node без node:sqlite — повтор с флагом.
      if (/node:sqlite|experimental-sqlite|Bad option|ERR_UNKNOWN_BUILTIN_MODULE/.test(e.message)) {
        server = await startServer(true);
      } else {
        throw e;
      }
    }
    booted = true;
    server.on('exit', () => { server = null; });
  }

  function createWindow() {
    win = new BrowserWindow({
      width: 1180,
      height: 800,
      minWidth: 460,
      minHeight: 560,
      title: 'BLOOP',
      backgroundColor: '#0b1220',
      icon: path.join(RES, 'icon.ico'),
      autoHideMenuBar: true,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    win.once('ready-to-show', () => win.show());
    Menu.setApplicationMenu(null);
    win.loadURL(`http://127.0.0.1:${port}/`);
    // Ссылки из сообщений — в системном браузере, медиа приложения — в окне.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(`http://127.0.0.1:${port}/`)) return { action: 'allow' };
      shell.openExternal(url);
      return { action: 'deny' };
    });
    win.on('closed', () => { win = null; });
  }

  app.whenReady().then(async () => {
    try {
      await boot();
    } catch (err) {
      dialog.showErrorBox('BLOOP: не удалось запустить встроенный сервер', String(err.message || err));
      app.quit();
      return;
    }
    createWindow();
    app.on('activate', () => { if (!win) createWindow(); });
  });

  app.on('window-all-closed', () => {
    if (server) server.kill();
    app.quit();
  });

  app.on('before-quit', () => { if (server) server.kill(); });

  process.on('uncaughtException', (err) => {
    dialog.showErrorBox('BLOOP: ошибка', String((err && err.stack) || err));
  });
}
