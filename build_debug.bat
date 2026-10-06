@echo off
chcp 65001 >nul
echo === 设置 MSVC 环境 ===
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

echo.
echo === 设置 Rust 环境 ===
set PATH=C:\Users\Administrator\.cargo\bin;%PATH%

echo.
echo === 开始编译 ===
cd /d "D:\Doubao-pek\股票盯盘系统·灵动岛版\src-tauri"
cargo build 2>&1

echo.
echo === 编译完成，退出码: %ERRORLEVEL% ===
pause
