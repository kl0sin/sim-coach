@echo off
rem Puts the built SimCoach plugin into SimHub (closes SimHub and starts it again) and adds
rem SimCoach shortcuts to the desktop and the Start menu.
rem The game must be closed. Build first: plugin\build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0plugin\install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0plugin\shortcuts.ps1"
echo.
pause
