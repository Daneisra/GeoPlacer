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

rem The one installation path, scripts\setup-windows.mjs. --check (Phase 1C.0): 0 up to date,
rem 1 installation needed (first run, interrupted, dependencies changed), 2 new build needed
rem (the sources changed, e.g. after git pull).
call node scripts\setup-windows.mjs --check
if errorlevel 2 (
  echo [setup] Sources modifiees : nouvelle compilation...
  call node scripts\setup-windows.mjs --skip-install
  if errorlevel 1 goto :setup_failed
) else if errorlevel 1 (
  echo [setup] Installation de GeoPlacer...
  call node scripts\setup-windows.mjs
  if errorlevel 1 goto :setup_failed
)

if "%GEOPLACER_SETUP_ONLY%"=="1" (
  echo [setup] GeoPlacer est installe.
  exit /b 0
)

echo [run] GeoPlacer demarre : ouvrez l'adresse "Server listening on" affichee ci-dessous ^(par defaut http://127.0.0.1:3000^). Ctrl+C pour arreter.
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
