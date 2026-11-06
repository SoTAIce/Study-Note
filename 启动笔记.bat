@echo off
chcp 65001 >nul
setlocal
rem One-click launcher. Keep this file pure ASCII for cmd.exe compatibility.
rem Keep this file pure ASCII: cmd.exe mangles non-ASCII bytes inside .bat files.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\start.ps1" %*
if errorlevel 1 pause
endlocal
