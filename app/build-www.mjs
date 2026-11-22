// Сборка www для Android: копия public/ + переключение config.js в локальный режим.
import { cpSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const www = path.join(here, 'www');

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
cpSync(path.join(here, '..', 'public'), www, { recursive: true });
writeFileSync(
  path.join(www, 'config.js'),
  '// Автосборка для Android: весь «сервер» работает на устройстве.\nwindow.BLOOP_CONFIG = { mode: \'local\' };\n',
);
console.log('www готов:', readdirSync(www).join(', '));
