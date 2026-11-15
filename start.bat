@echo off
setlocal
cd /d "%~dp0"

rem GeoPlacer launcher (Phase 1B.10): the local simulation, compiled, in this window.
rem   start.bat           install if needed, then start GeoPlacer (http://127.0.0.1:3000)
rem   start.bat --demo    same, on the separate demonstration folder data\demo
rem Developers: "npm run dev" (backend and frontend with reload), see docs\fr\installation-windows.md.

where node >nul 2>&1
if errorlevel 1 (
  echo [error] Node.js est introuvable. Installez Node.js 22 LTS depuis https://nodejs.org puis relancez.
  pause
  exit /b 1
)

if exist "users.json" if not exist "data\users.json" (
  if not exist "data\" mkdir "data"
  move /Y "users.json" "data\users.json" >nul
)
if exist "templates.json" if not exist "data\templates.json" (
  if not exist "data\" mkdir "data"
  move /Y "templates.json" "data\templates.json" >nul
)

rem First run (or an incomplete installation): the one installation path, scripts\setup-windows.mjs.
set NEED_SETUP=0
if not exist "node_modules\" set NEED_SETUP=1
if not exist "frontend\node_modules\" set NEED_SETUP=1
if not exist "dist\server.js" set NEED_SETUP=1
if not exist "frontend\dist\index.html" set NEED_SETUP=1
if "%NEED_SETUP%"=="1" (
  echo [setup] Installation de GeoPlacer...
  call node scripts\setup-windows.mjs
  if errorlevel 1 goto :setup_failed
)

if "%GEOPLACER_SETUP_ONLY%"=="1" (
  echo [setup] GeoPlacer est installe.
  exit /b 0
)

echo [run] GeoPlacer demarre : ouvrez http://127.0.0.1:3000 ^(Ctrl+C pour arreter^)
if /i "%~1"=="--demo" (
  call npm run demo
) else (
  call npm start
)
exit /b %errorlevel%

:setup_failed
echo [error] L'installation a echoue. Le detail est dans test-logs ; voir docs\fr\installation-windows.md
pause
exit /b 1
