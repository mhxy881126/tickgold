@echo off
chcp 65001 >nul
title TickGold 股票盯盘系统 - 开发模式
cd /d "%~dp0"

echo ========================================
echo    TickGold 股票盯盘系统 · 开发模式
echo ========================================
echo.

echo [1/3] 检查 Node.js 环境...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo   ❌ 未找到 Node.js，请先安装 Node.js 18+
    echo   下载地址: https://nodejs.org/
    pause
    exit /b 1
)
echo   ✓ Node.js 已安装
node --version

echo.
echo [2/3] 检查 pnpm 环境...
where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo   ⚠️  未找到 pnpm，尝试使用 npm 安装...
    npm install -g pnpm
    if %errorlevel% neq 0 (
        echo   ❌ pnpm 安装失败，请手动安装: npm install -g pnpm
        pause
        exit /b 1
    )
)
echo   ✓ pnpm 已安装
pnpm --version

echo.
echo [3/3] 检查 Rust 环境...
where rustc >nul 2>nul
if %errorlevel% neq 0 (
    echo   ❌ 未找到 Rust，请先安装 Rust
    echo   下载地址: https://rustup.rs/
    echo   或运行: winget install Rustlang.Rustup
    pause
    exit /b 1
)
echo   ✓ Rust 已安装
rustc --version

echo.
echo ========================================
echo   正在启动 Tauri 开发模式...
echo   （首次启动需要编译 Rust，约 5-15 分钟）
echo ========================================
echo.

pnpm run app:dev

if %errorlevel% neq 0 (
    echo.
    echo ❌ 启动失败，请查看上方错误信息
    echo 常见问题:
    echo   1. 缺少 WebView2 - 安装: https://developer.microsoft.com/microsoft-edge/webview2/
    echo   2. 缺少 C++ 构建工具 - 安装 Visual Studio Build Tools
    echo   3. 依赖未安装 - 先运行: pnpm install
)

pause
