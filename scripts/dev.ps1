# 一键启动开发模式（自动加载 MSVC 环境）
# 双击或在 PowerShell 中运行： .\dev.ps1
$ErrorActionPreference = "Stop"

$vc = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
$root = Split-Path -Parent $PSScriptRoot

Set-Location $root
cmd /c "`"$vc`" >nul 2>&1 && set PATH=%USERPROFILE%\.cargo\bin;%PATH% && pnpm tauri dev"
