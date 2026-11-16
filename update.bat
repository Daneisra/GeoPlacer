@echo off
setlocal enabledelayedexpansion

echo Verifying Git Installation...
git --version >nul 2>&1
if %errorlevel% equ 0 (
    echo Git found!
    echo.
    goto :git_pull
)

echo Git est introuvable : la mise a jour a besoin de Git.
echo.
rem GeoPlacer 1C.0: no automatic system installation (the inherited script ran winget here).
echo GeoPlacer n'installe rien sur Windows de lui-meme. Pour installer Git :
echo   - telechargez l'installateur officiel sur https://git-scm.com/download/win
echo   - ou, si vous le souhaitez, dans un terminal : winget install --id Git.Git -e --source winget
echo Rouvrez ensuite le terminal et relancez update.bat.
echo.
pause
exit /b 1

:git_pull

echo Repository:
git remote get-url origin 2>nul
if %errorlevel% neq 0 (
    echo Could not determine the remote repository.
    echo Make sure you are in a folder with an initialized Git repository.
    echo.
    goto :end
)

echo.
echo Current branch:
git branch --show-current 2>nul
if %errorlevel% neq 0 (
    echo Could not determine current branch.
)
echo.

echo Checking for local changes...
git status --porcelain 2>nul | findstr /r "." >nul
if %errorlevel% equ 0 (
    echo.
    echo WARNING: You have local changes in your repository!
    echo.
    git status --short 2>nul
    echo.
    set /p "discard=Do you want to discard all local changes? (y/N - default is No): "
    if /i "!discard!" equ "Y" (
        echo.
        echo Discarding local changes...
        git checkout . 2>&1
        if %errorlevel% equ 0 (
            echo Local changes discarded successfully!
        ) else (
            echo Error discarding local changes.
            echo You may need to resolve this manually.
            echo.
            goto :end
        )
    ) else (
        echo.
        echo Keeping local changes. Update cancelled.
        echo Please commit, stash, or manually resolve your changes before updating.
        echo.
        goto :end
    )
    echo.
)

echo Checking for remote changes...
git fetch origin 2>&1
if %errorlevel% neq 0 (
    echo Warning: Could not fetch from remote repository.
    echo Note: Without a successful fetch, 'git pull' will likely fail. Please check your internet connection and remote repository configuration.
    echo.
)

echo Updating repository...
git pull

if %errorlevel% equ 0 (
    echo.
    echo Repository updated successfully!
    echo Installing dependencies and building ^(scripts\setup-windows.mjs^)...
    call node scripts\setup-windows.mjs
    echo.
) else (
    echo.
    echo Error updating the repository.
    echo Possible causes:
    echo - No internet connection
    echo - Authentication required
    echo - Merge conflicts
    echo - No remote repository configured
    echo.
    echo You may need to resolve conflicts manually or check your credentials.
)

:end
echo.
echo All done!
pause
