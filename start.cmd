@echo off
rem Double-click to start Venus Phone. Uses npm.cmd so PowerShell's script policy doesn't matter.
cd /d "%~dp0"
if not exist node_modules call npm.cmd install --no-audit --no-fund
call npm.cmd start
pause
