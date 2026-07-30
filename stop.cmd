@echo off
setlocal
title Yuguang Digital Coach - Stop
cd /d "%~dp0"
if errorlevel 1 goto path_error
if not exist "platform\stop.ps1" goto extract_error

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CD%\platform\stop.ps1"
set "STOP_EXIT=%ERRORLEVEL%"
if not "%STOP_EXIT%"=="0" pause
exit /b %STOP_EXIT%

:path_error
echo ERROR: Cannot open the current folder.
pause
exit /b 1

:extract_error
echo ERROR: The project is incomplete. Extract the ZIP first.
pause
exit /b 1
