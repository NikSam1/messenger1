@echo off
chcp 65001 >nul
title Messenger — Backend API

echo.
echo  ╔══════════════════════════════════════╗
echo  ║      Messenger — Backend (FastAPI)   ║
echo  ╚══════════════════════════════════════╝
echo.

cd /d "%~dp0backend"

echo  [*] Запуск сервера на http://localhost:8000
echo  [*] Документация: http://localhost:8000/api/docs
echo  [*] Для остановки нажмите Ctrl+C
echo.

python main.py

pause
