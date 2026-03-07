@echo off
echo Starting Nerdy AI Tutor...
echo.
echo [1/2] Starting server on http://localhost:3001
start "AI Tutor Server" cmd /k "cd /d %~dp0server && npm run dev"
timeout /t 2 /nobreak >nul
echo [2/2] Starting client on http://localhost:5173
start "AI Tutor Client" cmd /k "cd /d %~dp0client && npm run dev"
echo.
echo Both processes started. Open http://localhost:5173 in your browser.
echo Close both terminal windows to stop the app.
