@echo off
chcp 65001 >nul
cd /d "%~dp0"

@REM echo 正在启动 dev 开发服务器...
@REM start "pnpm-dev" cmd /k "pnpm run dev"
@REM ping 127.0.0.1 -n 1 >nul
echo 正在启动 serve 预览服务器...
start "pnpm-serve" cmd /k "pnpm run serve"

echo 两个服务已在独立窗口中启动
