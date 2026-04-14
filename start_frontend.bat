@echo off
chcp 65001 >nul
title Messenger — Frontend

echo.
echo  =========================================
echo   Messenger Frontend
echo   http://localhost:5500/register.html
echo  =========================================
echo.

cd /d "%~dp0frontend"

echo  Запуск HTTP-сервера на порту 5500...
echo  Нажмите Ctrl+C для остановки.
echo.

python -m http.server 5500
