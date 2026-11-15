@echo off
setlocal enabledelayedexpansion
title Inkyscib
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
    set "PY=python"
) else (
    where py >nul 2>nul
    if %errorlevel%==0 (
        set "PY=py -3"
    ) else (
        echo Python was not found on this machine.
        echo Install it from https://www.python.org/downloads/ ^(check "Add python.exe to PATH" during setup^), then run this again.
        echo.
        pause
        exit /b 1
    )
)

echo Checking dependencies...
%PY% -m pip install -q -r requirements.txt
if errorlevel 1 (
    echo.
    echo Could not install dependencies. See the error above.
    echo.
    pause
    exit /b 1
)

if not defined PORT set "PORT=10000"

REM Other devices on this Wi-Fi can always reach it. This used to ask, and the
REM answer was always yes: the tablet is what this is for.
set "HOST=0.0.0.0"
for /f "delims=" %%i in ('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.InterfaceAlias -notmatch 'Loopback' } | Select-Object -First 1 -ExpandProperty IPAddress)"') do set "LANIP=%%i"

echo.
echo Starting Inkyscib...
echo   On this PC:       http://127.0.0.1:%PORT%
if defined LANIP (
    echo   On other devices: http://!LANIP!:%PORT%
    echo   Open that address in your tablet's or phone's browser, on the same Wi-Fi.
    echo.
    echo   Windows may ask to let Python through the firewall the first time --
    echo   choose "Private networks" so devices on your home Wi-Fi can reach it.
) else (
    echo   Could not detect your network address automatically.
    echo   Run "ipconfig" in another window and look for "IPv4 Address" to find it.
)

echo.
echo Your browser will open automatically in a couple of seconds.
echo Press Ctrl+C in this window to stop the server.
echo.

start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%'"

%PY% app.py

echo.
echo Inkyscib server stopped.
pause
