#!/usr/bin/env bash
# Сборка BLOOP-4.6.exe — десктоп-приложение Windows (Electron + встроенный сервер).
# Требуется: Node.js >= 22.5, npm, python3 с Pillow (для иконки).
# Запускать из корня репозитория: bash scripts/build_exe.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT=$(pwd)
DESK="$ROOT/app/desktop"

# 1. Бандл сервера: ESM + createRequire для динамических require зависимостей.
npx esbuild server.js --bundle --platform=node --format=esm \
  --external:z-ai-web-dev-sdk \
  --outfile="$DESK/server-bundle.mjs" --log-level=warning \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"

# 2. Веб-клиент рядом с бандлом (express.static ищет ./public).
rm -rf "$DESK/public"
cp -r public "$DESK/public"

# 3. Иконка .ico из android-ресурсов (если ещё не сгенерирована).
if [ ! -f "$DESK/icon.ico" ]; then
  python3 - <<'PY'
from PIL import Image
im = Image.open('app/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png').convert('RGBA')
im = im.resize((256, 256), Image.LANCZOS)
if im.mode == 'RGBA':
    bg = Image.new('RGB', im.size, (11, 18, 32))
    bg.paste(im, mask=im.split()[3])
    im = bg
im.save('app/desktop/icon.ico', sizes=[(256, 256), (64, 64), (48, 48), (32, 32), (16, 16)])
print('icon.ico создан')
PY
fi

# 4. Инструменты и сборка portable-exe (BLOOP-4.6.exe, окно Electron).
cd "$DESK"
if [ ! -d node_modules ]; then
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --no-audit --no-fund
fi
npx electron-builder --win portable

echo "Готово: $DESK/dist/BLOOP-4.6.exe"
