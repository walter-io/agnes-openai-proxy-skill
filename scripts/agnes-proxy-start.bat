@echo off
rem Agnes OpenAI proxy - portable start (with watchdog)
rem Usage: double-click or run in background; log = agnes-proxy.log next to this file
rem Stop:  agnes-proxy-stop.bat
cd /d "%~dp0"

set "NODE_EXE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

:loop
echo [%date% %time%] proxy starting >> "%~dp0agnes-proxy.log"
"%NODE_EXE%" "%~dp0agnes-openai-proxy.mjs" >> "%~dp0agnes-proxy.log" 2>&1
echo [%date% %time%] proxy exited, restarting in 5s >> "%~dp0agnes-proxy.log"
timeout /t 5 /nobreak >nul
goto loop
