@echo off
rem Puts the built SimCoach plugin into SimHub (closes SimHub and starts it again).
rem The game must be closed. Build the plugin first: plugin\build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0plugin\install.ps1"
echo.
pause
