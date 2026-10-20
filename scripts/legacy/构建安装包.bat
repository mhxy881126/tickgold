@echo off
chcp 65001 >nul
title TickGold 股票盯盘系统 - 构建安装包
cd /d "%~dp0"

echo ========================================
echo    TickGold 股票盯盘系统 · 构建安装包
echo ========================================
echo.

echo [1/4] 检查 Node.js 环境...
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo   ❌ 未找到 Node.js
    pause
    exit /b 1
)
echo   ✓ Node.js 已安装

echo.
echo [2/4] 检查 pnpm 环境...
where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo   ❌ 未找到 pnpm
    pause
    exit /b 1
)
echo   ✓ pnpm 已安装

echo.
echo [3/4] 检查 Rust 环境...
where rustc >nul 2>nul
if %errorlevel% neq 0 (
    echo   ❌ 未找到 Rust
    pause
    exit /b 1
)
echo   ✓ Rust 已安装

echo.
echo [4/4] 检查 NSIS（Windows 安装包）...
where makensis >nul 2>nul
if %errorlevel% neq 0 (
    echo   ⚠️  未找到 NSIS，将使用 Tauri 内置的 WiX 打包
    echo   如需 NSIS 安装包，请安装: https://nsis.sourceforge.io/
) else (
    echo   ✓ NSIS 已安装
)

echo.
echo ========================================
echo   正在构建生产版本安装包...
echo   （首次构建需要编译所有依赖，约 15-30 分钟）
echo ========================================
echo.

pnpm run app:build

if %errorlevel% equ 0 (
    echo.
    echo ========================================
    echo   ✓ 构建成功！
    echo   安装包位置: src-tauri\target\release\bundle\
    echo ========================================
    explorer "src-tauri\target\release\bundle\"
) else (
    echo.
    echo ❌ 构建失败，请查看上方错误信息
)

pause
