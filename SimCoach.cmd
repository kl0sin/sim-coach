@echo off
rem Starts SimCoach. With the launcher built (plugin\build.ps1) the app opens in a window of its
rem own and nothing else stays on screen. Without it, the server runs in this console window and
rem the app opens in the browser: close this window to stop it.
cd /d "%~dp0"
if exist "plugin\build\SimCoach.exe" (
    start "" "plugin\build\SimCoach.exe"
    exit /b 0
)
title SimCoach
node app\server.js --open
if errorlevel 1 pause
