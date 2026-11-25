@echo off
chcp 65001 >nul
title BLOOP Server
cd /d "%~dp0"
echo ==============================================
echo   BLOOP сервер для друзей
echo ==============================================
if not exist node_modules (
  echo Первый запуск: устанавливаю зависимости ^(нужен Node.js с nodejs.org^)...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo Не удалось установить зависимости. Проверь, что установлен Node.js.
    pause
    exit /b 1
  )
)
node -e "const os=require('os');let ips=[];for(const l of Object.values(os.networkInterfaces()))for(const n of l||[])if(n.family==='IPv4'&&!n.internal)ips.push(n.address);const port=process.env.PORT||3000;console.log('Друг открывает BLOOP -> Настройки -> «Сервер для друзей» и вводит адрес:');ips.forEach(ip=>console.log('  http://'+ip+':'+port));"
echo.
echo Сервер запущен. Не закрывай это окно, пока играешь с другом.
node server.js
pause
