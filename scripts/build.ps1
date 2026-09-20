# 打包发布：输出 NSIS 安装包到 src-tauri/target/release/bundle/nsis/
# 用法： .\scripts\build.ps1
$ErrorActionPreference = "Stop"

$vc = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
$root = Split-Path -Parent $PSScriptRoot

Set-Location $root
cmd /c "`"$vc`" >nul 2>&1 && set PATH=%USERPROFILE%\.cargo\bin;%PATH% && pnpm tauri build"
Write-Host ""
Write-Host "安装包位于: src-tauri\target\release\bundle\nsis\" -ForegroundColor Green
