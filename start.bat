@echo off
:: ============================================================
:: System Monitor — Windows Startskript
:: Standard: Bindet auf 127.0.0.1:10800 (nur lokal).
:: Für LAN-Zugriff:  set SYSMON_HOST=0.0.0.0   vor dem Aufruf.
:: ============================================================
setlocal EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
if "%SYSMON_PORT%"==""  set "SYSMON_PORT=10800"
if "%SYSMON_HOST%"==""  set "SYSMON_HOST=0.0.0.0"
set "PORT=%SYSMON_PORT%"
set "LOG_FILE=%SCRIPT_DIR%sysmon.log"

set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=start"

if /i "%ACTION%"=="start"   goto :start
if /i "%ACTION%"=="stop"    goto :stop
if /i "%ACTION%"=="restart" goto :restart
if /i "%ACTION%"=="status"  goto :status
if /i "%ACTION%"=="logs"    goto :logs

echo Verwendung: %~nx0 {start^|stop^|restart^|status^|logs}
exit /b 1

:: ─── START ──────────────────────────────────────────────────
:start
echo [INFO] Pruefe Python-Installation...
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python nicht gefunden.
    echo         Bitte Python 3.9+ von https://www.python.org installieren.
    echo         Wichtig: "Add Python to PATH" anhaken!
    pause
    exit /b 1
)

echo [INFO] Pruefe und installiere Abhaengigkeiten (still)...
python -m pip install --quiet psutil fastapi uvicorn 2>nul
:: Optional — fehlschlag tolerieren
python -m pip install --quiet liquidctl 2>nul
python -m pip install --quiet wmi 2>nul

echo.
echo [INFO] Starte System Monitor Backend auf %SYSMON_HOST%:%PORT% ...

:: Alte Log-Datei leeren
echo. > "%LOG_FILE%"

:: Backend als separaten Prozess starten (minimiertes Fenster)
start "SysMonitor" /min cmd /c "python ""%SCRIPT_DIR%api_server.py"" >> ""%LOG_FILE%"" 2>&1"

echo [INFO] Warte auf Server (max. 30s)...
set /a TRIES=0
:wait_loop
    timeout /t 1 /nobreak >nul
    set /a TRIES+=1
    :: Robuster Healthcheck: HTTP-Anfrage statt netstat (Locale-unabhaengig)
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Uri 'http://127.0.0.1:%PORT%/api/stats'; if ($r.StatusCode -lt 500) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 goto :server_ready
    :: Fallback: netstat (ohne trailing space, locale-tolerant)
    netstat -an 2>nul | findstr /R ":%PORT%[^0-9]" | findstr /I "LISTENING" >nul 2>&1
    if not errorlevel 1 goto :server_ready
    if %TRIES% geq 30 goto :server_timeout
goto :wait_loop

:server_timeout
echo [ERROR] Server hat nach 20 Sekunden nicht geantwortet.
echo         Logs: %LOG_FILE%
if exist "%LOG_FILE%" type "%LOG_FILE%"
pause
exit /b 1

:server_ready
echo [OK] Server laeuft auf http://%SYSMON_HOST%:%PORT%
echo.
if /i "%SYSMON_HOST%"=="127.0.0.1" set "OPEN_URL=http://localhost:%PORT%"
if not defined OPEN_URL set "OPEN_URL=http://%SYSMON_HOST%:%PORT%"
echo      Oeffne Browser: %OPEN_URL%
start "" "%OPEN_URL%"
echo.
echo [INFO] Zum Stoppen: %~nx0 stop
goto :eof

:: ─── STOP ───────────────────────────────────────────────────
:stop
echo [INFO] Stoppe System Monitor...
taskkill /fi "windowtitle eq SysMonitor*" /f >nul 2>&1
for /f "tokens=2" %%i in ('tasklist /fi "imagename eq python.exe" /fo csv /nh 2^>nul') do (
    set "PID=%%~i"
    wmic process where "ProcessId=!PID!" get CommandLine 2>nul | findstr /i "api_server" >nul 2>&1
    if not errorlevel 1 (
        echo [INFO] Beende Prozess !PID!
        taskkill /pid !PID! /f >nul 2>&1
    )
)
echo [OK] Gestoppt.
goto :eof

:: ─── STATUS ─────────────────────────────────────────────────
:status
netstat -an 2>nul | findstr /R ":%PORT%[^0-9]" | findstr /I "LISTENING" >nul 2>&1
if errorlevel 1 (
    echo [INFO] System Monitor laeuft NICHT ^(Port %PORT% nicht aktiv^).
) else (
    echo [OK] System Monitor laeuft auf http://%SYSMON_HOST%:%PORT%
)
goto :eof

:: ─── RESTART ────────────────────────────────────────────────
:restart
call :stop
timeout /t 2 /nobreak >nul
goto :start

:: ─── LOGS ───────────────────────────────────────────────────
:logs
if exist "%LOG_FILE%" (
    type "%LOG_FILE%"
) else (
    echo [INFO] Keine Logdatei gefunden.
)
goto :eof
