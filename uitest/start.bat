@echo off
setlocal
cd /d "%~dp0"

if not exist "dist\index.html" (
  echo [1/3] Building frontend ...
  call npm run build
  if errorlevel 1 (
    echo Build failed.
    pause
    exit /b 1
  )
)

rem Prefer the ComfyUI bundled python (it has torch / transformers installed)
set "PY=F:\ai\fastai\python\python.exe"
if not exist "%PY%" set "PY=python"

echo [2/3] Starting server on http://127.0.0.1:5199
echo [3/3] CLIP text tower loads in background, wait about 10-30s
echo.
"%PY%" server.py 5199
pause
