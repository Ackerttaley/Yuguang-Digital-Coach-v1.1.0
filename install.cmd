@echo off
setlocal
title Yuguang Digital Coach - Install
cd /d "%~dp0"
if errorlevel 1 goto path_error
if not exist "platform\setup.ps1" goto extract_error

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CD%\platform\setup.ps1"
set "INSTALL_EXIT=%ERRORLEVEL%"
if not "%INSTALL_EXIT%"=="0" goto install_error

echo.
echo Installation completed. Run start.cmd next.
echo.
pause
exit /b 0

:path_error
echo.
echo ERROR: Cannot open the current folder.
echo Extract the ZIP to a normal local folder, then run install.cmd again.
echo.
pause
exit /b 1

:extract_error
echo.
echo ERROR: platform\setup.ps1 was not found.
echo Right-click the ZIP, choose Extract All, then run install.cmd
echo from the extracted folder. Do not run it inside the ZIP preview.
echo.
pause
exit /b 1

:install_error
echo.
echo Installation failed. Review the error shown above and try again.
echo.
pause
exit /b %INSTALL_EXIT%
