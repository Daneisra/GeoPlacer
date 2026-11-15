@echo off
rem GeoPlacer: installation in one command (Phase 1B.10). See docsr\installation-windows.md.
cd /d "%~dp0"
node scripts\setup-windows.mjs %*
set SETUP_EXIT=%errorlevel%
pause
exit /b %SETUP_EXIT%
