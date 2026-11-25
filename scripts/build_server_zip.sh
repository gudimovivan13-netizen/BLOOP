#!/usr/bin/env bash
# Сборка BLOOP-server-4.7.zip — архив «сервер для друзей»: Node.js-сервер
# + веб-клиент + run-server.bat. Запускать из корня репозитория:
#   bash scripts/build_server_zip.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT=$(pwd)
OUT="BLOOP-server-4.7.zip"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/BLOOP-server"
# package-lock обязателен: run-server.bat ставит зависимости через npm ci
cp server.js package.json package-lock.json КРАТКО.txt scripts/run-server.bat "$STAGE/BLOOP-server/"
cp -r src "$STAGE/BLOOP-server/src"
cp -r public "$STAGE/BLOOP-server/public"
# публичный справочник серверов едет в архиве тоже — клиент на сервере
# сможет показывать тот же список адресов
cp servers.json "$STAGE/BLOOP-server/servers.json" 2>/dev/null || true

( cd "$STAGE" && zip -r -q "$ROOT/$OUT" BLOOP-server )
echo "Готово: $ROOT/$OUT ($(du -h "$OUT" | cut -f1))"
