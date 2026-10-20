@echo off
chcp 65001 >nul
title = TickGold 股票盯盘系统 - Tauri 开发模式
cd /d "%~dp0"

color 0A
cls

echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║           TickGold 股票盯盘系统 · 开发模式启动              ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.

echo [1/4] 检查 Node.js...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo   [X] 未找到 Node.js，请先安装 Node.js 18+
    echo   下载: https://nodejs.org/
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%i in ('node --version') do echo   [√] Node.js %%i

echo.
echo [2/4] 检查 pnpm...
where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo   [!] 未找到 pnpm，正在安装...
    npm install -g pnpm
)
for /f "delims=" %%i in ('pnpm --version') do echo   [√] pnpm %%i

echo.
echo [3/4] 检查 Rust...
where rustc >nul 2>nul
if %errorlevel% neq 0 (
    echo   [X] 未找到 Rust，请先安装 Rust
    echo   下载: https://rustup.rs/
    echo   或运行: winget install Rustlang.Rustup
    echo.
    pause
    exit /b 1
)
for /f "delims=" %%i in ('rustc --version') do echo   [√] %%i

echo.
echo [4/4] 检查 MSVC 编译工具...
where cl >nul 2>nul
if %errorlevel% neq 0 (
    echo   [!] 警告: 未找到 cl.exe (MSVC 编译工具)
    echo   [!] 如果编译报错，请先安装 Visual Studio Build Tools
    echo   [!] 安装命令: winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive"
) else (
    echo   [√] MSVC 编译工具已就绪
)

echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║  正在启动 Tauri 开发模式                                     ║
echo ║  首次启动需要 5-15 分钟编译，请耐心等待...                  ║
echo ║  应用窗口会在编译完成后自动弹出                              ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.

pnpm run app:dev

echo.
echo 程序已退出，按任意键关闭...
pause >nul
