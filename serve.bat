@echo off
REM ---------------------------------------------------------------------------
REM  Binaural Lab - double-click launcher for Windows
REM  Serves this folder at http://0.0.0.0:7899 and opens your browser.
REM  Any arguments are passed straight through, e.g.:
REM      serve.bat --port 8000
REM      serve.bat --no-browser
REM ---------------------------------------------------------------------------
setlocal
title Binaural Lab server
cd /d "%~dp0"

where py >nul 2>nul
if not errorlevel 1 goto usepy

where python >nul 2>nul
if not errorlevel 1 goto usepython

echo.
echo   Python 3 was not found on this machine.
echo.
echo   Install it from https://www.python.org/downloads/
echo   and tick "Add python.exe to PATH" during setup,
echo   then run this file again.
echo.
pause
exit /b 1

:usepy
py -3 "%~dp0serve.py" %*
if errorlevel 1 pause
exit /b 0

:usepython
python "%~dp0serve.py" %*
if errorlevel 1 pause
exit /b 0
