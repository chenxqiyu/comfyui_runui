@echo off
setlocal
cd /d "%~dp0"

if not exist "dist\index.html" (
  echo [1/2] Building frontend ...
  call npm run build
  if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
  )
)

echo [2/2] Starting server at http://127.0.0.1:5199
node tools\serve.mjs 5199
pause
