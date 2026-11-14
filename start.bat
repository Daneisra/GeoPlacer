@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist "data\" mkdir "data"

rem Local configuration: .env is not tracked by Git. Create it from the
rem template on first run; an existing .env is never overwritten.
if not exist ".env" if exist ".env.example" (
  copy /Y ".env.example" ".env" >nul
  echo [setup] Created .env from .env.example
)

if exist "users.json" move /Y "users.json" "data\users.json"
if exist "templates.json" move /Y "templates.json" "data\templates.json"

set NEED_INSTALL=0
if not exist "node_modules\" (
  set NEED_INSTALL=1
) else (
  call npm ls --depth=1 >nul 2>&1
  if errorlevel 1 set NEED_INSTALL=1
)

rem Tested installation path (see docs\fr\installation-windows.md):
rem lockfile install with install scripts disabled, then only the official
rem prebuilt canvas binary. node-gyp (compiler toolchain) is never invoked.
if %NEED_INSTALL%==1 (
  echo [setup] Installing backend dependencies ^(npm ci, install scripts disabled^)...
  call npm ci --ignore-scripts
  if errorlevel 1 goto :install_failed
  echo [setup] Installing the prebuilt canvas binary...
  pushd node_modules\canvas
  call node ..\prebuild-install\bin.js -r napi
  set PREBUILD_ERR=!errorlevel!
  popd
  if not "!PREBUILD_ERR!"=="0" goto :install_failed
)

if not exist "frontend\node_modules\" (
  echo [setup] Installing frontend dependencies ^(npm ci, install scripts disabled^)...
  pushd frontend
  call npm ci --ignore-scripts
  set FRONT_ERR=!errorlevel!
  popd
  if not "!FRONT_ERR!"=="0" goto :install_failed
)

if "%GEOPLACER_SETUP_ONLY%"=="1" (
  echo [setup] Dependencies ready.
  exit /b 0
)

call cls
echo [run] Starting backend and frontend in separate windows...
start "Backend" cmd /k "npx tsx watch --env-file-if-exists=.env src/server.ts"
start "Frontend" cmd /k "cd frontend && npm run dev"
exit /b 0

:install_failed
echo [error] Dependency installation failed. See docs\fr\installation-windows.md
pause
exit /b 1
