@echo off
title X Tracker - 1-Click Setup Helper

:: Switch to script directory
cd /d "%~dp0"
set "EXT_DIR=%cd%"

echo ======================================================================
echo   X TRACKER (UNFOLLOW MONITOR) - 1-CLICK INSTALLATION HELPER
echo ======================================================================
echo.

rem 1. Verify manifest.json exists
if not exist "manifest.json" (
    echo [ERROR] manifest.json was not found in:
    echo         %EXT_DIR%
    echo.
    echo Please make sure install.bat is inside the extracted X Tracker folder.
    echo.
    pause
    exit /b 1
)

echo  [1/3] Extension folder verified:
echo        %EXT_DIR%
echo.

rem 2. Copy path to clipboard
where powershell >nul 2>&1
if %ERRORLEVEL% equ 0 (
    powershell -NoProfile -Command "Set-Clipboard -Value '%EXT_DIR%'" >nul 2>&1
) else (
    <nul set /p="%EXT_DIR%" | clip
)

echo  [2/3] Extension folder path has been COPIED to your clipboard!
echo.

rem 3. Detect browser and open extensions page
set "BROWSER_NAME="
set "BROWSER_PATH="
set "EXT_URL=chrome://extensions"

rem Check Google Chrome
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_NAME=Google Chrome"
    set "BROWSER_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    set "EXT_URL=chrome://extensions"
    goto :LaunchBrowser
)
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_NAME=Google Chrome"
    set "BROWSER_PATH=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    set "EXT_URL=chrome://extensions"
    goto :LaunchBrowser
)
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
    set "BROWSER_NAME=Google Chrome"
    set "BROWSER_PATH=%LocalAppData%\Google\Chrome\Application\chrome.exe"
    set "EXT_URL=chrome://extensions"
    goto :LaunchBrowser
)

rem Check Brave Browser
if exist "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" (
    set "BROWSER_NAME=Brave Browser"
    set "BROWSER_PATH=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
    set "EXT_URL=brave://extensions"
    goto :LaunchBrowser
)
if exist "%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe" (
    set "BROWSER_NAME=Brave Browser"
    set "BROWSER_PATH=%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe"
    set "EXT_URL=brave://extensions"
    goto :LaunchBrowser
)

rem Check Microsoft Edge
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    set "BROWSER_NAME=Microsoft Edge"
    set "BROWSER_PATH=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    set "EXT_URL=edge://extensions"
    goto :LaunchBrowser
)
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    set "BROWSER_NAME=Microsoft Edge"
    set "BROWSER_PATH=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
    set "EXT_URL=edge://extensions"
    goto :LaunchBrowser
)

:LaunchBrowser
if defined BROWSER_PATH (
    echo  [3/3] Opening %BROWSER_NAME% at %EXT_URL%...
    start "" "%BROWSER_PATH%" "%EXT_URL%"
) else (
    echo  [3/3] Launching default browser extensions page...
    start "" "chrome://extensions"
)

echo.
echo ======================================================================
echo   JUST 3 EASY STEPS TO FINISH (Takes less than 15 seconds):
echo ======================================================================
echo.
echo   1. In your browser, turn ON "Developer mode" (toggle in top-right).
echo.
echo   2. Click the "Load unpacked" button (top-left).
echo.
echo   3. In the folder prompt, press Ctrl + V (path is ALREADY copied!)
echo      and click "Select Folder".
echo.
echo ======================================================================
echo   All done! Click the puzzle icon in your toolbar to pin X Tracker.
echo ======================================================================
echo.
echo Press any key to close this installer window...
pause >nul
