@echo off
setlocal
title Yuguang Digital Coach - Start
cd /d "%~dp0"
if errorlevel 1 goto path_error
if not exist "platform\start.ps1" goto extract_error
if not exist "platform\.venv\Scripts\python.exe" goto install_required
if not exist "platform\node_modules\vinext\dist\cli.js" goto install_required

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CD%\platform\start.ps1"
set "START_EXIT=%ERRORLEVEL%"
if not "%START_EXIT%"=="0" goto start_error
exit /b 0

:path_error
echo.
echo ERROR: Cannot open the current folder.
echo Extract the ZIP to a normal local folder, then run start.cmd again.
echo.
pause
exit /b 1

:extract_error
echo.
echo ERROR: The project is incomplete.
echo Right-click the ZIP, choose Extract All, then run start.cmd
echo from the extracted folder.
echo.
pause
exit /b 1

:install_required
echo.
echo ERROR: Installation is not complete.
echo Run install.cmd first and wait for "Installation completed".
echo.
pause
exit /b 1

:start_error
echo.
echo Startup failed. See platform\logs for details.
echo.
pause
exit /b %START_EXIT%
