@echo off
rem Starts the SimCoach lap viewer and opens it in the browser.
rem Close this window to stop it.
title SimCoach
cd /d "%~dp0"
node app\server.js --open
if errorlevel 1 pause
