@echo off
title Console llama.cpp
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   Node.js est introuvable. Installe-le depuis https://nodejs.org
    echo.
    pause
    exit /b 1
)

REM Le port vient de config.json ; 3939 si on n'arrive pas a le lire.
set PORT=3939
for /f "usebackq delims=" %%p in (`powershell -nop -c "try{(Get-Content -Raw config.json | ConvertFrom-Json).port}catch{3939}"`) do set PORT=%%p

REM Le navigateur s'ouvre quand le serveur ecoute VRAIMENT, pas avant : une page
REM chargee trop tot rate son premier appel et reste vide.
start "" /b powershell -nop -w hidden -c "for($i=0;$i -lt 120;$i++){ try{ $c=New-Object Net.Sockets.TcpClient('127.0.0.1',%PORT%); $c.Close(); Start-Process ('http://localhost:%PORT%'); break }catch{ Start-Sleep -Milliseconds 250 } }"

node server.js

echo.
echo   La console s'est arretee.
pause
